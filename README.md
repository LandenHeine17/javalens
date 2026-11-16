# JavaLens

A live Java environment for teaching. Type Java on the left. On the right you see the program run step by step: the call stack (recursion frames pushing and popping, with return values), objects on the heap with arrows for references, and the program's output.

## Run it

Requirements: JDK 21+ (25 recommended) and Node 18+.

```bash
./start.sh            # starts both servers and opens http://localhost:5173
```

Or start them separately:

```bash
java server/src/Main.java        # Java tracing server on 127.0.0.1:7070
cd web && npm install && npm run dev
```

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
- **Call tree:** every method call as a box, with its return value written in. The path to the running call is highlighted. Click a box to jump to that call. This is good for showing why naive `fib` is slow.
- **Growth (Big-O):** add `// @vary 1..20` after the line that sets the size variable, for example `int n = 8; // @vary 1..20`. JavaLens re-runs the program for several values of `n` and counts the lines executed each time. It charts the results and names the best-fitting growth rate, from O(1) through O(2ⁿ).

### Teaching modes (header buttons)

- **Counts** writes `×N` beside each line to show how many times it has run so far, and tints the hot lines.
- **Predict** makes every step forward pause first and show "line N is about to run, what will change?". Press → again to reveal what happened.
- **Hide code** gives the diagram the whole screen.
- **Present** enlarges the text and trims the header for the projector.
- **Sun/moon button** switches between the dark and light themes. Light is usually easier to read on a projector, and your choice is remembered.

## How it works

1. `server/src/Compiler.java` compiles the code in memory with the JDK's own compiler, which takes about 30ms.
2. `server/src/Tracer.java` launches the program in a separate JVM under the Java Debug Interface. It records the stack, variables, heap objects and output after every line, then returns the whole recording (a "trace") as JSON.
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

`server/src/Assist.java` answers `/complete`, `/hover` and `/signature` using the JDK's own compiler, so there is nothing extra to install. It replaces the word at the cursor with a placeholder, lets javac type-check the file, then asks javac what fits at the placeholder. A request takes about 20–90ms.

- **Type-aware completion:**
  - After `name.` it offers members of `name`'s type, with generic types filled in (`list.get` on an `ArrayList<String>` returns `String`).
  - After `Math.` it offers static members.
  - At the start of an expression it offers local variables, fields, methods, classes, keywords and snippets (`sout`, `fori`, `psvm`…).
- **Auto-import:** choosing `Scanner`, `ArrayList`, `HashMap` and other common `java.util` classes adds the `import` line.
- **Parameter hints:** the popup appears after `(` and `,` and covers all overloads.
- **Hover** shows the type of a variable or the signature of a method.

Not covered: refactoring, rename and quick fixes. Parameter names show only for your own methods, because the JDK's compiled classes don't store them, so library methods show types only (`max(int, int)`).

Still to come: GIF export, and student use through a sandboxed hosted server.
