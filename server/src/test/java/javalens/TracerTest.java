package javalens;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

/** Runs real programs through the compiler + tracer, exactly like the /run endpoint does. */
class TracerTest {

    /** Compiles and traces; returns the trace JSON (or the diagnostics if it didn't compile). */
    static String trace(String code, String stdin) throws Exception {
        Compiler.Result compiled = Compiler.compile(code);
        try {
            if (!compiled.ok()) return "COMPILE_ERROR " + compiled.diags();
            return Tracer.run(compiled, stdin);
        } finally {
            Compiler.deleteQuietly(compiled.dir());
        }
    }

    static String sample(String name) throws Exception {
        return Files.readString(Path.of("samples", name + ".java"));
    }

    static String stdoutOf(String json) {
        Matcher m = Pattern.compile("\"stdout\":(\"(?:[^\"\\\\]|\\\\.)*\")").matcher(json);
        assertTrue(m.find(), "no stdout in trace");
        return m.group(1);
    }

    @ParameterizedTest(name = "{0}")
    @CsvSource(delimiter = '|', textBlock = """
            Factorial       | 4! = 24\\n
            Fibonacci       | fib(4) = 3\\n
            BubbleSort      | 1 2 5 6 9 \\n
            SelectionSort   | [10, 13, 14, 29, 37]\\n
            LinkedList      | 1\\n2\\n3\\n
            BinarySearch    | [found at 5]\\n
            BinaryTree      | root is 50\\n
            CollectionsDemo | 3 Ana {not=1, be=2, or=1, to=2}\\n
            BigO            | 8 -> 64\\n
            MemoryModel     | false true true\\n52\\n
            """)
    void everySampleRunsToTheEnd(String name, String expectedStdout) throws Exception {
        String json = trace(sample(name), "");
        assertTrue(json.contains("\"end\":\"finished\""), name + " did not finish: " + json.substring(0, Math.min(300, json.length())));
        assertEquals("\"" + expectedStdout + "\"", stdoutOf(json));
    }

    @Test
    void recursionShowsEveryCallAndItsReturnValue() throws Exception {
        String json = trace(sample("Factorial"), "");
        // factorial(4) -> 3 -> 2 -> 1, each returning to its caller: 1, 2, 6, 24
        for (String v : new String[]{"1", "2", "6", "24"}) {
            assertTrue(json.contains("\"ret\":{\"k\":\"p\",\"v\":\"" + v + "\"}"), "missing return value " + v);
        }
        // the deepest step has main + 4 factorial frames
        assertTrue(json.contains("\"method\":\"factorial\",\"cls\":\"Factorial\",\"line\":4"));
    }

    @Test
    void staticFieldsAppearWithTheirValues() throws Exception {
        String json = trace(sample("MemoryModel"), "");
        assertTrue(json.contains("\"statics\":[{\"cls\":\"MemoryModel\",\"fields\":["), json.substring(0, 600));
        assertTrue(json.contains("{\"name\":\"count\",\"type\":\"int\",\"v\":{\"k\":\"p\",\"v\":\"2\"}}"));
        assertTrue(json.contains("{\"name\":\"RATE\",\"type\":\"double\",\"final\":true,\"v\":{\"k\":\"p\",\"v\":\"1.5\"}}"));
    }

    @Test
    void finalIsReportedForFieldsAndLocals() throws Exception {
        String json = trace(sample("MemoryModel"), "");
        assertTrue(json.contains("{\"name\":\"x\",\"type\":\"int\",\"final\":true,"), "final field");
        assertTrue(json.contains("{\"name\":\"y\",\"type\":\"int\",\"v\""), "non-final field");
        assertTrue(json.contains("{\"name\":\"size\",\"type\":\"int\",\"final\":true,"), "final local");
        assertTrue(json.contains("{\"name\":\"w\",\"type\":\"int\",\"final\":true,"), "final parameter");
        assertTrue(json.contains("{\"name\":\"h\",\"type\":\"int\",\"v\""), "non-final parameter");
    }

    @Test
    void stringLiteralsAreMarkedAsPooled() throws Exception {
        String json = trace(sample("MemoryModel"), "");
        Matcher a = Pattern.compile("\"name\":\"a\",\"type\":\"String\",\"v\":\\{\"k\":\"s\",\"v\":\"hi\",\"id\":(\\d+),\"pool\":true}").matcher(json);
        Matcher b = Pattern.compile("\"name\":\"b\",\"type\":\"String\",\"v\":\\{\"k\":\"s\",\"v\":\"hi\",\"id\":(\\d+)}").matcher(json);
        Matcher c = Pattern.compile("\"name\":\"c\",\"type\":\"String\",\"v\":\\{\"k\":\"s\",\"v\":\"hi\",\"id\":(\\d+),\"pool\":true}").matcher(json);
        assertTrue(a.find(), "a is pooled");
        assertTrue(b.find(), "b is a separate, unpooled object");
        assertTrue(c.find(), "c is pooled");
        assertEquals(a.group(1), c.group(1));
        assertNotEquals(a.group(1), b.group(1));
    }

    @Test
    void codeSegmentListsMethodsWithBytecodeSizes() throws Exception {
        String json = trace(sample("MemoryModel"), "");
        assertTrue(json.contains("\"code\":[{\"cls\":\"MemoryModel\",\"methods\":["), json.substring(0, 300));
        Matcher m = Pattern.compile("\\{\"name\":\"area\",\"sig\":\"int area\\(int, int\\)\",\"bytes\":(\\d+)}").matcher(json);
        assertTrue(m.find(), "area() in the code segment");
        assertTrue(Integer.parseInt(m.group(1)) > 0);
    }

    @Test
    void collectionsShowTheirContents() throws Exception {
        String json = trace(sample("CollectionsDemo"), "");
        assertTrue(json.contains("\"role\":\"stack\",\"type\":\"Stack\""));
        assertTrue(json.contains("\"role\":\"queue\",\"type\":\"ArrayDeque\""));
        assertTrue(json.contains("\"kind\":\"map\",\"type\":\"HashMap\""));
    }

    @Test
    void infiniteLoopIsStoppedByTheTimeout() throws Exception {
        String json = trace("""
                public class Loop {
                    public static void main(String[] args) {
                        int x = 0;
                        while (true) {
                            x++;
                        }
                    }
                }""", "");
        assertTrue(json.contains("\"end\":\"timeout\"") || json.contains("\"end\":\"step_limit\""), json);
    }

    @Test
    void missingBaseCaseIsStoppedBeforeItGetsHuge() throws Exception {
        String json = trace("""
                public class Deep {
                    static int f(int n) { return f(n + 1); }
                    public static void main(String[] args) { f(0); }
                }""", "");
        assertTrue(json.contains("\"end\":\"too_deep\""));
        assertTrue(json.length() < 3_000_000, "trace too big: " + json.length());
    }

    @Test
    void compileErrorsComeBackAsDiagnostics() throws Exception {
        assertTrue(trace("public class Bad { void f() { int x = \"hi\"; } public static void main(String[] a) {} }", "")
                .startsWith("COMPILE_ERROR"));
    }

    @Test
    void crashesAreReportedOnTheStep() throws Exception {
        String json = trace("public class Crash { public static void main(String[] a) { int[] b = new int[2]; b[5] = 1; } }", "");
        assertTrue(json.contains("ArrayIndexOutOfBoundsException"));
    }

    @Test
    void programInputReachesScanner() throws Exception {
        String json = trace("""
                import java.util.Scanner;
                public class Echo {
                    public static void main(String[] args) {
                        Scanner in = new Scanner(System.in);
                        System.out.println(in.nextInt() * 2);
                    }
                }""", "21");
        assertEquals("\"42\\n\"", stdoutOf(json));
    }

    @Test
    void windowsLineEndingsBecomePlainNewlines() throws Exception {
        // On Windows println writes \r\n; the page should see \n on every OS.
        String json = trace("public class Crlf { public static void main(String[] a) { System.out.print(\"a\\r\\nb\\r\\n\"); } }", "");
        assertEquals("\"a\\nb\\n\"", stdoutOf(json));
    }

    @Test
    void java25CompactMainWorks() throws Exception {
        assertEquals("\"hi\\n\"", stdoutOf(trace("void main() { IO.println(\"hi\"); }", "")));
    }

    @Test
    void countModeCountsLines() throws Exception {
        Compiler.Result c = Compiler.compile(sample("BigO").replace("int n = 8;", "int n = 10;"));
        try {
            String json = Tracer.count(c, "");
            Matcher m = Pattern.compile("\"count\":(\\d+)").matcher(json);
            assertTrue(m.find());
            assertTrue(Integer.parseInt(m.group(1)) > 100, json); // a 10x10 double loop
        } finally {
            Compiler.deleteQuietly(c.dir());
        }
    }
}
