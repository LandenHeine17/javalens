# JavaLens for VS Code

See your Java program run, step by step, right beside your code.

Open a `.java` file and click the **eye** button in the editor's title bar (or run **JavaLens: Visualize** from the Command Palette). A panel opens beside the editor with:

- **Memory**: the call stack and the objects on the heap, with arrows for references.
- **Memory map**: every variable, field and object with its (simulated) address, size and type; `static`, `final` and the string pool.
- **Memory layout**: the whole memory drawn as one rectangle: code, static data and the heap at the top, the stack at the bottom, growing toward each other.
- **Call tree** and **Growth (Big-O)**.

The line being shown is highlighted in your editor, and the visualization re-runs as you type. Compile errors are underlined.

## Requirements

A **JDK 25** or newer (a JRE is not enough). JavaLens looks for it in this order:

1. the `javalens.javaHome` setting
2. `JAVA_HOME`
3. the Java extension's `java.jdt.ls.java.home` setting
4. `java` on your PATH

No JDK? Get one from [Adoptium](https://adoptium.net/temurin/releases/?version=25).

## Settings

| Setting | What it does |
|---|---|
| `javalens.javaHome` | Folder of the JDK to use, e.g. `/usr/lib/jvm/java-25-openjdk` |
| `javalens.showCompileErrors` | Underline compile errors JavaLens finds (default: on) |

If something goes wrong, the **JavaLens** output channel (View → Output) shows what happened.
