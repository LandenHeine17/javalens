# AGENTS.md

Guide for AI coding agents working on JavaLens. For what the app does and how people use it, read
[README.md](README.md); this file covers what you need to change it safely and ship it.

JavaLens is a live Java visualizer for teaching: a Java server compiles and traces a program, and a
React page (in a browser, or in a VS Code / VSCodium / Cursor panel) replays the trace step by step.

## Map

| Path | What's there |
|---|---|
| `server/src/main/java/javalens/` | `Main` (startup flags: `--dev`, `--embedded`, `--class`), `Api` (HTTP endpoints), `Compiler` (javac in-process), `Tracer` (JDI tracer, writes the trace JSON), `Assist` (autocomplete/hover), `StaticFiles`, `AppInfo` (version, update check), `Json` (tiny parser/escaper, no libraries) |
| ″ class mode | `ClassRoom` (join link, cookies, limits), `Sandbox` (bwrap + systemd command, memory budget), `TraceWorker` (traces inside the sandbox) |
| `server/src/test/java/javalens/` | `TracerTest` (every sample + edge cases), `ModernJavaTest`, `AssistTest`, `ClassRoomTest` (stub handlers, no sandbox), `SandboxTest` (opt-in) |
| `web/src/` | `App.tsx` (state, run, header), views (`MemoryView`, `MemoryMap`, `AddressSpace`, `AlgoView`, `CallTree`, `Growth`), `Timeline`, `Editor`; logic without React: `trace.ts`, `analysis.ts`, `algoAnalysis.ts`, `grid.ts`, `memoryLayout.ts`, `share.ts`; `types.ts` = the trace JSON's shape |
| `web/test/` | Node test runner tests for the logic files; `traces/*.json` are real recorded server traces |
| `vscode/` | The extension (`vscode/src/extension.ts`): starts the bundled server jar with the user's JDK 25 and shows the page with `?host=vscode` |
| `samples/` | Lesson programs: the Examples menu, and each one is run by `TracerTest` |
| `.github/workflows/` | `ci.yml` (tests on push), `release.yml` (tag → build 3 OSes → GitHub Release), `publish-extension.yml` (Marketplace + Open VSX) |
| `start.sh`, `class.sh` | Dev mode (server + Vite); class mode (server + Cloudflare tunnel, see [README → Using it with a class](README.md#using-it-with-a-class)) |

## How a run works

`POST /run` → `Compiler.compile` (javac in the server, writes classes to a temp folder; never runs
student code) → `Tracer.run` launches the program in a separate JVM under JDI and snapshots the
stack and heap after every line → JSON where each step carries only what changed since the previous
step (`delta: true`) → `web/src/trace.ts` `expandTrace` rebuilds full `Step`s → every view reads
plain `Step`s. In class mode the tracing happens in `TraceWorker`, inside the sandbox, so the
debugger and the student's JVM share a private loopback.

Tracing speed is the step limit's bottleneck (see [README → How it works](README.md#how-it-works)):
every JDI call in `Tracer.snapshot` is a round trip to the student's JVM, so batch reads and cache
what can't change rather than adding per-step calls. Measure before and after on a long program.

## Commands

The full list is in [README → Develop it](README.md#develop-it). The ones you'll use:

- `./gradlew test` — all Java tests plus the web tests (`webTest`). Run before committing.
- `cd web && npm test` / `npm run typecheck` — web tests only (seconds) / TypeScript check.
- `./gradlew run` — dev server on 127.0.0.1:7070 (`--dev`); pair with `cd web && npx vite` (5173, proxies the API).
- `./gradlew test --tests javalens.SandboxTest -PsandboxTests=true` — class-mode sandbox tests. **Only when the user asks** (see below).

## Rules

- **No new dependencies** without asking. The server uses only the JDK (plus FlatLaf for the
  window); web tests use Node's built-in `node --test` (Node 22.18+ strips TypeScript types).
  Modules tested that way may only use `import type` between `web/src/` files; tests import them with
  the `.ts` extension.
- **Trace format changes** touch three places together: `Tracer.snapshot` (server), `web/src/types.ts`
  and `web/src/trace.ts`. Then re-record `web/test/traces/*.json` (run the dev server, `POST /run`
  each of those samples, save `{"delta":true,"steps":[...]}`) and keep `web/test/trace.test.ts`
  passing; it re-encodes the expanded steps and must reproduce the server's JSON exactly.
- **What students see is in their words.** `Tracer.typeLabel` / `methodLabel` turn JVM names into
  `lambda in main`, `anonymous Runnable`, `static init`, `Color.RED`; classes the JVM generates
  (`$$Lambda`, `$$TypeSwitch`) and javac's enum `values()` stay hidden (`Tracer.isUserCode`,
  `hiddenStep`). New Java features: add a case to `ModernJavaTest`.
- **Adding a sample:** drop a `.java` file in `samples/` and add its expected output to the table in
  `TracerTest.everySampleRunsToTheEnd`. A program that ends with an uncaught exception may also
  print Java's stack trace (it does on Windows); that test allows it.
- **Class mode is a security boundary.** Never run student code outside `Sandbox` when `--class` is
  on; if the sandbox can't start, refuse to start (fail closed). Keep the per-run caps and the shared
  memory budget (`Sandbox.SLICE`, sized by `Sandbox.defaultBudgetMb`). Changes here need the
  sandbox tests and a security review before a release.
- **Tests run on Linux, macOS and Windows** in the release workflow. Avoid assumptions about line
  endings, timing and paths with spaces (the tests' temp folder has a space in it on purpose).
- **Writing:** UI text, comments and the README are plain, short and in the user's terms. New
  user-visible features get a line in the README.
- **Git:** one commit per feature; work on a branch and merge to `master` when it's ready. Don't
  push, tag or publish unless the user asks.

## Working on the maintainer's laptop

- **Memory is tight** (about 4 GB free with the user's usual apps open; an out-of-memory freeze has
  happened). Check `free -m` before anything heavy, never run load or stress tests, never run the
  opt-in `SandboxTest` unless asked, and run `./gradlew --stop` after Gradle work.
- **Don't touch processes you didn't start.** The user often has `./start.sh` running (Java on
  7070, Vite on 5173 or 5174) and other projects' Vite servers. Before stopping anything, confirm
  with `ps` that it's yours. Stopping a background `./gradlew run` can leave its Java child running
  (it keeps port 7070); stop that PID too.
- Put scratch files in the session's scratchpad directory, not in the repo.

## Releasing

Versions live in two places: `version=` in `gradle.properties` and `"version"` in
`vscode/package.json`. The release itself is described in [README → Releasing](README.md#releasing);
the steps an agent follows when the user asks for a release:

1. Bump both versions, commit, merge to `master`, push.
2. Optional but recommended: run the Release workflow by hand on `master` (Actions → Release → Run
   workflow, or `gh workflow run release.yml --ref master`). It builds and tests on all three OSes
   without publishing. Fix anything red first.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`. That builds everything, creates the GitHub Release,
   then `publish-extension.yml` publishes the `.vsix` to the VS Code Marketplace and to Open VSX as
   separate jobs. Publisher and namespace: `JavaLens` (extension id `JavaLens.javalens`).
4. If one store fails, fix the cause and re-run only that store: `gh workflow run
   publish-extension.yml -f tag=vX.Y.Z -f stores=marketplace` (or `openvsx`). A version can't be
   published to the same store twice.

Secrets: `VSCE_PAT` (Azure DevOps token, organization *All accessible organizations*, scope
*Marketplace → Manage*) and `OVSX_PAT` (open-vsx.org access token). They expire on dates the user
chose; an expired one shows up as "unauthorized" in that store's job, and the user renews it and
replaces the secret (remind them before it lapses).

## Maintenance

- **New Java every March and September:** run the tests on the new JDK; JDI and javac internals
  (`Tracer`, `Compiler`, `Assist`) are what break. Add samples/tests for new language features.
- **Editors:** raise `engines.vscode` in `vscode/package.json` now and then; check the extension in
  VS Code, VSCodium and Cursor before releases.
- **GitHub Actions:** keep action versions current (runs warn that Node 20 actions are deprecated).
- **Ideas not built yet:** follow-the-teacher mode (on top of class mode), `// @note` lesson
  annotations, quiz mode, GIF export, an IntelliJ plugin, accessibility (color-blind-safe Sort &
  Search colors).
