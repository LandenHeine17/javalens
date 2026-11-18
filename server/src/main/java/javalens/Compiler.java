package javalens;

import com.sun.source.tree.*;
import com.sun.source.util.*;

import javax.lang.model.element.Modifier;
import javax.tools.*;
import java.io.IOException;
import java.net.URLClassLoader;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/** Compiles student code to a temp directory using the JDK's built-in compiler (no external javac process). */
public final class Compiler {
    /** A compile message. file: the source's path for errors in another file of the project, null for the main file. */
    public record Diag(long line, long col, long endCol, String message, String severity, String file) {
        public Diag(long line, long col, long endCol, String message, String severity) {
            this(line, col, endCol, message, severity, null);
        }
    }

    /** Another source file of the program, e.g. "edu/unl/raikes/memory/models/Year.java". */
    public record Source(String path, String code) {}

    /**
     * finalLocals: "SimpleClass.method.var" for every local/parameter declared final (javac drops
     * that from the class file, so we read it from the source). stringLiterals: every "..." literal.
     * mainSource: the main file's path relative to the source root (what JDI reports as its source path).
     */
    public record Result(boolean ok, Path dir, String mainClass, Set<String> userClasses, List<Diag> diags,
                         Set<String> finalLocals, Set<String> stringLiterals, String mainSource) {}

    private static final Pattern PUBLIC_CLASS =
            Pattern.compile("public\\s+(?:(?:final|abstract)\\s+)*(?:class|interface|enum|record)\\s+(\\w+)");
    private static final Pattern PACKAGE = Pattern.compile("^\\s*package\\s+([\\w.]+)\\s*;", Pattern.MULTILINE);
    private static final int MAX_SOURCES = 300;

    /** The file name must match the public class name (or anything, for a class with no "public"). */
    public static String fileNameFor(String code) {
        Matcher m = PUBLIC_CLASS.matcher(code);
        return (m.find() ? m.group(1) : "Main") + ".java";
    }

    /** One file on its own (the web page). */
    public static Result compile(String code) throws IOException {
        return compile(code, null, List.of());
    }

    /**
     * The main file plus the rest of its project (the VS Code extension sends every .java file under
     * the source root, so imports between files and packages work). Paths are relative to that root.
     */
    public static Result compile(String code, String mainPath, List<Source> others) throws IOException {
        String mainRel = mainPath != null && !mainPath.isBlank() ? mainPath : fileNameFor(code);
        Path dir = Files.createTempDirectory("javalens");
        Path srcRoot = dir.resolve("src");
        Path mainSrc = place(srcRoot, mainRel);
        Files.writeString(mainSrc, code);
        List<Path> sources = new ArrayList<>(List.of(mainSrc));
        for (Source s : others) {
            if (sources.size() >= MAX_SOURCES) break;
            Path p = place(srcRoot, s.path());
            if (p.equals(mainSrc) || !p.toString().endsWith(".java")) continue;
            Files.writeString(p, s.code());
            sources.add(p);
        }

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> collector = new DiagnosticCollector<>();
        boolean ok;
        Set<String> finalLocals = new HashSet<>();
        Set<String> literals = new LinkedHashSet<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(collector, null, null)) {
            // Compile only the main file; javac pulls in the other files it actually uses from the
            // source path. Unrelated files sitting in the same folder (even broken ones) never matter.
            List<String> options = List.of("-g", "-d", dir.toString(), "-sourcepath", srcRoot.toString(),
                    "-implicit:class", "-Xlint:none", "-proc:none");
            JavacTask task = (JavacTask) javac.getTask(null, fm, collector, options, null, fm.getJavaFileObjectsFromPaths(List.of(mainSrc)));
            task.addTaskListener(new TaskListener() {
                @Override public void finished(TaskEvent e) {
                    if (e.getKind() == TaskEvent.Kind.PARSE) scanSource(e.getCompilationUnit(), finalLocals, literals);
                }
            });
            ok = task.call();
        }

        List<Diag> diags = new ArrayList<>();
        for (Diagnostic<? extends JavaFileObject> d : collector.getDiagnostics()) {
            if (d.getKind() == Diagnostic.Kind.NOTE) continue;
            long len = Math.max(1, d.getEndPosition() - d.getStartPosition());
            long col = Math.max(1, d.getColumnNumber());
            String sev = d.getKind() == Diagnostic.Kind.ERROR ? "error" : "warning";
            String file = null;
            if (d.getSource() != null) {
                Path p = Path.of(d.getSource().toUri());
                if (!p.equals(mainSrc) && p.startsWith(srcRoot)) file = srcRoot.relativize(p).toString().replace('\\', '/');
            }
            diags.add(new Diag(d.getLineNumber(), col, col + len, d.getMessage(Locale.ENGLISH), sev, file));
        }
        String mainSource = mainRel.replace('\\', '/');
        if (!ok) return new Result(false, dir, null, Set.of(), diags, finalLocals, literals, mainSource);

        // Every compiled class by its full name (edu.unl.raikes.memory.Application), packages included.
        Set<String> classes = new LinkedHashSet<>();
        try (Stream<Path> files = Files.walk(dir)) {
            files.filter(p -> p.toString().endsWith(".class"))
                 .map(p -> dir.relativize(p).toString().replace('\\', '/'))
                 .sorted()
                 .forEach(n -> classes.add(n.substring(0, n.length() - ".class".length()).replace('/', '.')));
        }

        Matcher pkg = PACKAGE.matcher(code);
        String simple = Path.of(mainRel).getFileName().toString().replace(".java", "");
        String preferred = (pkg.find() ? pkg.group(1) + "." : "") + simple;
        String mainClass = findMainClass(dir, classes, preferred);
        if (mainClass == null) {
            diags.add(new Diag(1, 1, 2, "No main method found. Add: public static void main(String[] args)", "error"));
            return new Result(false, dir, null, classes, diags, finalLocals, literals, mainSource);
        }
        return new Result(true, dir, mainClass, classes, diags, finalLocals, literals, mainSource);
    }

    /** Where a source file goes under the temp source root; refuses paths that would escape it. */
    private static Path place(Path srcRoot, String rel) throws IOException {
        Path p = srcRoot.resolve(rel.replace('\\', '/')).normalize();
        if (!p.startsWith(srcRoot) || rel.startsWith("/")) throw new IOException("Bad source path: " + rel);
        Files.createDirectories(p.getParent());
        return p;
    }

    /** Collects final locals/parameters (keyed by enclosing class + method) and string literals. */
    private static void scanSource(CompilationUnitTree unit, Set<String> finalLocals, Set<String> literals) {
        if (unit == null) return;
        new TreeScanner<Void, Void>() {
            private final Deque<String> classes = new ArrayDeque<>();
            private String method = null;

            @Override public Void visitClass(ClassTree t, Void v) {
                String savedMethod = method;
                classes.push(t.getSimpleName().toString());
                method = null;
                try { return super.visitClass(t, v); } finally { classes.pop(); method = savedMethod; }
            }

            @Override public Void visitMethod(MethodTree t, Void v) {
                String saved = method;
                method = t.getName().contentEquals("<init>") ? "<init>" : t.getName().toString();
                try { return super.visitMethod(t, v); } finally { method = saved; }
            }

            @Override public Void visitVariable(VariableTree t, Void v) {
                if (method != null && !classes.isEmpty() && t.getModifiers().getFlags().contains(Modifier.FINAL)) {
                    finalLocals.add(classes.peek() + "." + method + "." + t.getName());
                }
                return super.visitVariable(t, v);
            }

            @Override public Void visitLiteral(LiteralTree t, Void v) {
                if (t.getKind() == Tree.Kind.STRING_LITERAL && t.getValue() instanceof String s && literals.size() < 500) literals.add(s);
                return super.visitLiteral(t, v);
            }
        }.scan(unit, null);
    }

    /** Load classes WITHOUT initializing them (so no student code runs here) and look for a main method. */
    private static String findMainClass(Path dir, Set<String> classes, String preferred) {
        try (URLClassLoader loader = new URLClassLoader(new java.net.URL[]{dir.toUri().toURL()}, null)) {
            List<String> order = new ArrayList<>();
            order.add(preferred);
            order.addAll(classes);
            for (String name : order) {
                if (!classes.contains(name)) continue;
                try {
                    Class<?> c = Class.forName(name, false, loader);
                    for (var method : c.getDeclaredMethods()) {
                        if (method.getName().equals("main")) return name;
                    }
                } catch (Throwable ignored) { }
            }
        } catch (IOException ignored) { }
        return null;
    }

    public static void deleteQuietly(Path dir) {
        if (dir == null) return;
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (IOException ignored) { }
    }
}
