# JavaLens

A live Java environment for teaching. Type Java on the left. On the right you see the program run step by step: the call stack (recursion frames pushing and popping, with return values), objects on the heap with arrows for references, and the program's output.

## Install it

Download the installer for your computer from the project's **Releases** page. Java is included, so there's nothing else to install.

| OS | Installer | No-install version |
|---|---|---|
| Windows | `.msi` | `-windows-portable.zip` |
| macOS (Apple Silicon) | `.dmg` | `-macos-portable.zip` |
| Linux | `.deb` (`.rpm` when built on Fedora) | `-linux-portable.tar.gz` |

**VS Code:** download `javalens-x.y.z.vsix` from the same Releases page and install it with *Extensions: Install from VSIX...*. Open a `.java` file and click the eye button in the editor's title bar: the visualizer opens beside your code, highlights the line being run, and re-runs as you type. The extension needs a JDK 25 installed (it looks at the `javalens.javaHome` setting, then `JAVA_HOME`, then the `java` on your PATH).

When you launch it, JavaLens opens in your browser and shows a small window with **Open** and **Quit**. Closing that window quits JavaLens. Launching it a second time just reopens the browser.

The app isn't code-signed, so the first launch shows a warning:
- **Windows:** *More info* → *Run anyway*
- **macOS:** right-click → *Open*

## Develop it

Requirements: JDK 25 and Node 18+. Gradle downloads itself through `./gradlew`.

```bash
./start.sh     # Java server (./gradlew run, port 7070) + Vite dev server, opens http://localhost:5173
```

Edits to `web/src` reload instantly. After editing Java code, restart `./gradlew run`.

| Command | What it does |
|---|---|
| `./gradlew test` | Runs the test suite: every sample program, the edge cases, and autocomplete. |
| `./gradlew jar` | Builds `build/libs/javalens.jar`, one file with the web page inside. Run it with `java -jar` if a JDK is installed. |
| `./gradlew portable` | Builds the unzip-and-run app for this OS, with Java bundled, into `build/dist`. |
| `./gradlew vscodeExtension` | Builds the VS Code extension into `build/dist/javalens-<version>.vsix` (the server jar goes inside; the extension's code is in `vscode/`). |
| `./gradlew installer` | Builds the native installer for this OS (`.msi`, `.dmg`, `.deb` or `.rpm`) into `build/dist`. |

Packaging uses Eclipse Temurin 25, which Gradle downloads automatically if it isn't installed. Some Linux distributions' JDKs, Fedora's included, can't build the trimmed runtime with `jlink`.

### Releasing

Push a version tag. GitHub Actions then builds the Windows, macOS and Linux versions and publishes them on a Release page (see `.github/workflows/release.yml`):

```bash
git tag v1.1.0
git push origin v1.1.0
```

Release builds check that repo's Releases page and show an **Update available** badge in the header when there's a newer version. Local builds skip the check unless `updateRepo` is set in `gradle.properties`.

### Project layout

| Folder | Contents |
|---|---|
| `server/src/main/java/javalens/` | The Java side: HTTP API, compiler, tracer, autocomplete, app window |
| `server/src/test/java/javalens/` | Tests |
| `web/` | The page: React + Monaco editor, built with Vite |
| `vscode/` | The VS Code extension: starts the server with the user's JDK and shows the page in a panel |
| `samples/` | Lesson programs. They appear in the Examples menu and are also run by the tests. |

## Using it in lecture

- **Live** mode re-runs about half a second after you stop typing. Compile errors show as red squiggles, and the last good run stays on screen.
- **Keys** (when the editor isn't focused):
  - `←` / `→` step back or forward one step.
  - `Shift+←` / `Shift+→` step over method calls.
  - `Home` / `End` jump to the first or last step.
  - `Space` plays or pauses.
- **The blue strip under the slider** charts stack depth over time. Each recursive call is a hill. Click the strip to jump to that point.
- **A− / A+** change the text size for projectors.
- **Input** opens a text box for what the program reads through `Scanner`.
- **Examples** lists every `.java` file in `samples/`. To add a lesson, drop in a new file; the page reloads to pick it up.
- **Click a line number** to jump to the next time that line runs.

### Views (tabs on the right)

- **Memory:** the call stack beside the heap, with an arrow for every reference.
  - **Arrays:** the cells show `↑ i`, `↑ j` or `↑ mid` under the positions the current method's index variables point at.
  - **Linked lists:** a class with one field of its own type (`Node next`) is drawn left to right.
  - **Binary trees:** a class with two such fields (`Node left, right`) is drawn as a tree.
  - **Collections:** `Stack`, `ArrayDeque`, `LinkedList`, `ArrayList`, `HashMap`, `TreeMap`, `HashSet`, `List.of` and similar are shown as their contents. A Stack has its top marked, and a queue has its front and back marked.
- **Memory map:** memory as rows of addresses in three tables: Static area, Stack and Heap. Each slot shows its address, size in bytes, type, name and value, and a reference shows the address it holds. Static fields get a `static` badge, final fields and variables a `final` badge, and String literals are shown in the string pool, so `==` versus `.equals` makes sense. The addresses are a teaching model (a 64-bit JVM with 8-byte references and 16-byte object headers), not the JVM's real ones.
- **Memory layout (beta):** the same memory drawn as one rectangle. From the top: code, static data, then the heap growing down; free space in the middle; the stack at the bottom growing up. Blocks take up space roughly in proportion to their size, objects that nothing points to stay as faded garbage, and clicking anything shows what's stored there. Try the **MemoryModel** example.
- **Call tree:** every method call as a box, with its return value written in. The path to the running call is highlighted. Click a box to jump to that call. This is good for showing why naive `fib` is slow.
- **Growth (Big-O):** add `// @vary 1..20` after the line that sets the size variable, for example `int n = 8; // @vary 1..20`. JavaLens re-runs the program for several values of `n` and counts the lines executed each time. It charts the results and names the best-fitting growth rate, from O(1) through O(2ⁿ).

### Teaching modes (header buttons)

- **Counts** writes `×N` beside each line to show how many times it has run so far, and tints the hot lines.
- **Predict** makes every step forward pause first and show "line N is about to run, what will change?". Press → again to reveal what happened.
- **Hide code** gives the diagram the whole screen.
- **Present** enlarges the text and trims the header for the projector.
- **Sun/moon button** switches between the dark and light themes. Light is usually easier to read on a projector, and your choice is remembered.

## How it works

1. `server/src/main/java/javalens/Compiler.java` compiles the code in memory with the JDK's own compiler, which takes about 30ms.
2. `server/src/main/java/javalens/Tracer.java` launches the program in a separate JVM under the Java Debug Interface. It records the stack, variables, heap objects and output after every line, then returns the whole recording (a "trace") as JSON.
3. The web UI in `web/src/` replays the trace. Stepping backwards is instant because nothing re-runs.

The tracer has these safety limits:

| Limit | Value |
| --- | --- |
| Maximum run time | 3 seconds |
| Maximum steps | 3000 |
| Maximum recursion depth | 150 calls |
| Maximum output | 100k characters |

The server listens only on `127.0.0.1` because it runs whatever code it is given.

`POST /count` runs the program without snapshots and returns only the number of lines executed. The Growth chart uses it.

### Editor help (autocomplete, hover, parameter hints)

`server/src/main/java/javalens/Assist.java` answers `/complete`, `/hover` and `/signature` using the JDK's own compiler, so there is nothing extra to install. It replaces the word at the cursor with a placeholder, lets javac type-check the file, then asks javac what fits at the placeholder. A request takes about 20–90ms.

- **Type-aware completion:**
  - After `name.` it offers members of `name`'s type, with generic types filled in (`list.get` on an `ArrayList<String>` returns `String`).
  - After `Math.` it offers static members.
  - At the start of an expression it offers local variables, fields, methods, classes, keywords and snippets (`sout`, `fori`, `psvm`…).
- **Auto-import:** choosing `Scanner`, `ArrayList`, `HashMap` and other common `java.util` classes adds the `import` line.
- **Parameter hints:** the popup appears after `(` and `,` and covers all overloads.
- **Hover** shows the type of a variable or the signature of a method.

Not covered: refactoring, rename and quick fixes. Parameter names show only for your own methods, because the JDK's compiled classes don't store them, so library methods show types only (`max(int, int)`).

Still to come: GIF export, and student use through a sandboxed hosted server.
