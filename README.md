# JavaLens

A live Java environment for teaching. Type Java on the left. On the right you see the program run step by step: the call stack (recursion frames pushing and popping, with return values), objects on the heap with arrows for references, and the program's output.

## Install it

Download the installer for your computer from the project's **Releases** page. Java is included, so there's nothing else to install.

| OS | Installer | No-install version |
|---|---|---|
| Windows | `.msi` | `-windows-portable.zip` |
| macOS (Apple Silicon) | `.dmg` | `-macos-portable.zip` |
| Linux | `.deb` (`.rpm` when built on Fedora) | `-linux-portable.tar.gz` |

**VS Code:** search for **JavaLens** in the Extensions view (or install it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=JavaLens.javalens)); VS Code keeps it up to date. You can also download `javalens-x.y.z.vsix` from the Releases page and use *Extensions: Install from VSIX...*, but then it won't update itself. Open a `.java` file and click the eye button in the editor's title bar: the visualizer opens beside your code, highlights the line being run, and re-runs as you type. Multi-file projects with packages work too (for example a class lab with `src/edu/.../Application.java` importing its model classes): the extension sends the whole project, and stepping into another file opens it like a debugger. The extension needs a JDK 25 installed (it looks at the `javalens.javaHome` setting, then `JAVA_HOME`, then the `java` on your PATH).

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
| `./gradlew test` | Runs the test suite: every sample program, the edge cases, autocomplete, and the web page's unit tests. |
| `cd web && npm test` | Runs only the web page's unit tests (`web/test/`), with Node's built-in test runner. |
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
| `web/test/` | Unit tests for the trace analysis behind the views |
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
- **The line under the timeline** says in plain words what the last step changed: `sum: 3 → 6`, `a[2] = 5`, `new Node`, `call fib(n=4)`, `fib() returned 3`.
- **Hover a number variable** in the Memory tab to see a small chart of the values it has held so far in that call (never ahead of the current step, so Predict mode isn't spoiled).
- **The blue strip under the slider** charts stack depth over time. Each recursive call is a hill. Click the strip to jump to that point.
- **A− / A+** change the text size for projectors.
- **Input** opens a text box for what the program reads through `Scanner`.
- **Examples** lists every `.java` file in `samples/`. To add a lesson, drop in a new file; the page reloads to pick it up.
- **Click a line number** to jump to the next time that line runs.
- **Share** copies a link that reopens the program, its input, the open tab and the current step. Everything is packed into the link itself (after the `#`), so nothing is uploaded. If the browser won't allow copying, the link appears selected next to the button, ready for Ctrl+C. The link opens wherever JavaLens runs at the same address, for example `http://127.0.0.1:7070/` on another computer with JavaLens open.

### Newer Java

Records, enums, sealed interfaces with pattern-matching `switch`, lambdas and streams, anonymous and inner classes, and default methods all trace with the names you'd write: a lambda's body is a frame called `lambda in main`, `new Runnable() { ... }` is an `anonymous Runnable`, a plain enum value reads `Color.RED`, and an enum with fields is an object called `Planet.EARTH`. Classes the JVM generates behind the scenes (for lambdas and pattern switches) and the `values()` method javac adds to every enum are left out.

### Views (tabs on the right)

- **Memory:** the call stack beside the heap, with an arrow for every reference.
  - **Arrays:** the cells show `↑ i`, `↑ j` or `↑ mid` under the positions the current method's index variables point at.
  - **2D arrays** (`int[][]`, `char[][]`, `String[][]`) are drawn as one grid. The row variable (`i`) points at a row, the column variable (`j`) at a column, and the cell where they meet is outlined, so filling a DP table reads naturally. Try the **GridPaths** example.
  - **Linked lists:** a class with one field of its own type (`Node next`) is drawn left to right.
  - **Binary trees:** a class with two such fields (`Node left, right`) is drawn as a tree.
  - **Collections:** `Stack`, `ArrayDeque`, `LinkedList`, `ArrayList`, `HashMap`, `TreeMap`, `HashSet`, `List.of` and similar are shown as their contents. A Stack has its top marked, and a queue has its front and back marked.
- **Exceptions**, caught or not, stop on the line that throws. The banner says where the exception goes: *caught at line 27 in main()*, *it jumps to the finally block at line 17 first*, or *nothing catches it, so the program stops here*. The calls it ends early are marked **unwinding** in the Memory tab, the call that catches it says **catches it**, the editor marks the line it lands on, and the Call tree shows those calls with ✕ and the exception instead of a return value. Try the **Exceptions** example.
- **Memory map:** memory as rows of addresses in three tables: Static area, Stack and Heap. Each slot shows its address, size in bytes, type, name and value, and a reference shows the address it holds. Static fields get a `static` badge, final fields and variables a `final` badge, and String literals are shown in the string pool, so `==` versus `.equals` makes sense. The addresses are a teaching model (a 64-bit JVM with 8-byte references and 16-byte object headers), not the JVM's real ones.
- **Memory layout (beta):** the same memory drawn as one rectangle. From the top: code, static data, then the heap growing down; free space in the middle; the stack at the bottom growing up. Blocks take up space roughly in proportion to their size, objects that nothing points to stay as faded garbage, and clicking anything shows what's stored there. **Fit to screen** (on by default) shrinks the picture so all of memory fits without scrolling; click **Code** to list each class's methods. Try the **MemoryModel** example.
- **Sort & Search:** the array your program sorts or searches, drawn as bars. Cells being compared light up blue, writes and swaps amber (with an arrow for each swap), cells in their final place turn green, and cells outside the running call's range fade, so binary search visibly rules out half each time. Index variables (`i`, `j`, `mid`...) point at the cells they index, brackets show each recursive call's `lo..hi` range (merge sort and quick sort splitting the array), merge sort's `left`/`right` arrays appear underneath, and quick sort's `pivot` is a dashed line. Live counters show comparisons, swaps, writes and steps. **Race** runs a second sample on the same input side by side; the one needing fewer steps finishes first. Samples: BubbleSort, SelectionSort, InsertionSort, MergeSort, QuickSort, LinearSearch, BinarySearch.
- **Call tree:** every method call as a box, with its return value written in. The path to the running call is highlighted. Click a box to jump to that call. This is good for showing why naive `fib` is slow.
- **Growth (Big-O):** add `// @vary 1..20` after the line that sets the size variable, for example `int n = 8; // @vary 1..20`. JavaLens re-runs the program for several values of `n` and counts the lines executed each time. It charts the results and names the best-fitting growth rate, from O(1) through O(2ⁿ).

### Teaching modes (header buttons)

- **Counts** writes `×N` beside each line to show how many times it has run so far, and tints the hot lines.
- **Predict** makes every step forward pause first and show "line N is about to run, what will change?". Press → again to reveal what happened.
- **Hide code** gives the diagram the whole screen.
- **Present** enlarges the text and trims the header for the projector.
- **Sun/moon button** switches between the dark and light themes. Light is usually easier to read on a projector, and your choice is remembered.

## Using it with a class

Class mode lets students use JavaLens in their browser during class, with nothing to install. Everything runs on your laptop and it's free: a Cloudflare *quick tunnel* gives the laptop a temporary public `https://` address. Linux only (it relies on bubblewrap and systemd, which Fedora and Ubuntu have).

One-time setup, install `cloudflared` (Fedora/RHEL; for other systems see Cloudflare's downloads page):

```bash
sudo dnf install https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm
```

Each class:

```bash
./class.sh
```

It prints one link, like `https://some-random-words.trycloudflare.com/join/KDMXQT`. Give it to the students (and open it yourself). Share links work too once a student has opened the class link. Ctrl+C ends class; the link stops working and the next class gets a new one.

**Safety.** JavaLens runs whatever code it's given, so class mode never runs a student's program as you:
- Each run happens in a sandbox (bubblewrap): no network at all, no access to your home folder, read-only system files, a private `/tmp` that's thrown away.
- Each run has its own memory, process and CPU caps, and **all runs together** share one memory budget (a systemd slice), so a class can't use up the laptop's memory.
- Only browsers that opened the class link (it has a code) get in. Each student can have 2 runs going and 40 a minute.

**How many students.** The memory budget decides it. By default class mode takes 40% of the memory that's free when it starts (at most 2 GB) and plans ~200 MB per run, so with 4 GB free that's about 1.6 GB and up to 8 programs at once. A typical class program runs in well under a second, and Live mode sends a run when a student stops typing, so 8 at once comfortably serves a class of 30 to 40; when every slot is busy, students wait a moment (and are told the server is busy after 10 s). **Close big apps (dev servers, browsers with many tabs) before class** so there's memory to spare. Set it yourself with `./class.sh --budget 1500 --max-runs 6`.

Quick tunnels are a free Cloudflare service with no uptime promise; for a class that's usually fine.

The sandbox's own tests start many sandboxed JVMs, so they don't run with `./gradlew test`; run them on purpose with memory free: `./gradlew test --tests javalens.SandboxTest -PsandboxTests=true`.

## How it works

1. `server/src/main/java/javalens/Compiler.java` compiles the code in memory with the JDK's own compiler, which takes about 30ms.
2. `server/src/main/java/javalens/Tracer.java` launches the program in a separate JVM under the Java Debug Interface. It records the stack, variables, heap objects and output after every line, then returns the whole recording (a "trace") as JSON. Each step carries only what changed since the step before (`web/src/trace.ts` rebuilds the full steps), and objects of your own classes are only re-read after one of their fields is written, which the debugger reports without stopping the program.
3. The web UI in `web/src/` replays the trace. Stepping backwards is instant because nothing re-runs.

The tracer has these safety limits:

| Limit | Value |
| --- | --- |
| Maximum run time | 3 seconds |
| Maximum steps | 10,000 (the time limit usually comes first, at roughly 4,000 steps) |
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
