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

    public record Result(boolean ok, Path dir, String mainClass, Set<String> userClasses, List<Diag> diags) {}

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
        try (StandardJavaFileManager fm = javac.getStandardFileManager(collector, null, null)) {
            List<String> options = List.of("-g", "-d", dir.toString(), "-Xlint:none", "-proc:none");
            ok = javac.getTask(null, fm, collector, options, null, fm.getJavaFileObjects(src)).call();
        }

        List<Diag> diags = new ArrayList<>();
        for (Diagnostic<? extends JavaFileObject> d : collector.getDiagnostics()) {
            if (d.getKind() == Diagnostic.Kind.NOTE) continue;
            long len = Math.max(1, d.getEndPosition() - d.getStartPosition());
            long col = Math.max(1, d.getColumnNumber());
            String sev = d.getKind() == Diagnostic.Kind.ERROR ? "error" : "warning";
            diags.add(new Diag(d.getLineNumber(), col, col + len, d.getMessage(Locale.ENGLISH), sev));
        }
        if (!ok) return new Result(false, dir, null, Set.of(), diags);

        Set<String> classes = new LinkedHashSet<>();
        try (Stream<Path> files = Files.list(dir)) {
            files.map(p -> p.getFileName().toString())
                 .filter(n -> n.endsWith(".class"))
                 .forEach(n -> classes.add(n.substring(0, n.length() - ".class".length())));
        }

        String mainClass = findMainClass(dir, classes, fileName.replace(".java", ""));
        if (mainClass == null) {
            diags.add(new Diag(1, 1, 2, "No main method found. Add: public static void main(String[] args)", "error"));
            return new Result(false, dir, null, classes, diags);
        }
        return new Result(true, dir, mainClass, classes, diags);
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
