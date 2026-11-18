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
    public record Diag(long line, long col, long endCol, String message, String severity) {}

    /**
     * finalLocals: "SimpleClass.method.var" for every local/parameter declared final (javac drops
     * that from the class file, so we read it from the source). stringLiterals: every "..." literal.
     */
    public record Result(boolean ok, Path dir, String mainClass, Set<String> userClasses, List<Diag> diags,
                         Set<String> finalLocals, Set<String> stringLiterals) {}

    private static final Pattern PUBLIC_CLASS =
            Pattern.compile("public\\s+(?:(?:final|abstract)\\s+)*(?:class|interface|enum|record)\\s+(\\w+)");

    /** The file name must match the public class name (or anything, for a class with no "public"). */
    public static String fileNameFor(String code) {
        Matcher m = PUBLIC_CLASS.matcher(code);
        return (m.find() ? m.group(1) : "Main") + ".java";
    }

    public static Result compile(String code) throws IOException {
        String fileName = fileNameFor(code);
        Path dir = Files.createTempDirectory("javalens");
        Path src = dir.resolve(fileName);
        Files.writeString(src, code);

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> collector = new DiagnosticCollector<>();
        boolean ok;
        Set<String> finalLocals = new HashSet<>();
        Set<String> literals = new LinkedHashSet<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(collector, null, null)) {
            List<String> options = List.of("-g", "-d", dir.toString(), "-Xlint:none", "-proc:none");
            JavacTask task = (JavacTask) javac.getTask(null, fm, collector, options, null, fm.getJavaFileObjects(src));
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
            diags.add(new Diag(d.getLineNumber(), col, col + len, d.getMessage(Locale.ENGLISH), sev));
        }
        if (!ok) return new Result(false, dir, null, Set.of(), diags, finalLocals, literals);

        Set<String> classes = new LinkedHashSet<>();
        try (Stream<Path> files = Files.list(dir)) {
            files.map(p -> p.getFileName().toString())
                 .filter(n -> n.endsWith(".class"))
                 .forEach(n -> classes.add(n.substring(0, n.length() - ".class".length())));
        }

        String mainClass = findMainClass(dir, classes, fileName.replace(".java", ""));
        if (mainClass == null) {
            diags.add(new Diag(1, 1, 2, "No main method found. Add: public static void main(String[] args)", "error"));
            return new Result(false, dir, null, classes, diags, finalLocals, literals);
        }
        return new Result(true, dir, mainClass, classes, diags, finalLocals, literals);
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
