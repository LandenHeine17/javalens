package javalens;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

import static javalens.TracerTest.stdoutOf;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Class mode's sandbox: programs behave the same inside it, and can't reach the teacher's files,
 * the network or the laptop's other programs, or take the laptop down.
 *
 * Not part of a normal test run: these start many sandboxed JVMs, and some deliberately try to use
 * up memory and processes (inside the caps). Run them on purpose, with plenty of memory free:
 *   ./gradlew test --tests javalens.SandboxTest -PsandboxTests=true
 */
class SandboxTest {
    @BeforeAll
    static void sandboxWorksHere() {
        assumeTrue(Boolean.getBoolean("javalens.sandboxTests"), "sandbox tests are opt-in (-PsandboxTests=true)");
        String why = Sandbox.unavailable();
        assumeTrue(why == null, "no sandbox: " + why);
        assertNull(Sandbox.setBudget(1024, 4), "a small shared budget for these runs"); // one at a time anyway
    }

    static String sandboxed(String code, String stdin) throws Exception {
        Compiler.Result compiled = Compiler.compile(code);
        try {
            assertTrue(compiled.ok(), "compile: " + compiled.diags());
            return Sandbox.trace(compiled, stdin, false);
        } finally {
            Compiler.deleteQuietly(compiled.dir());
        }
    }

    static Stream<String> samples() throws Exception {
        try (Stream<Path> files = Files.list(Path.of("samples"))) {
            return files.map(p -> p.getFileName().toString().replace(".java", "")).sorted().toList().stream();
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("samples")
    void everySampleTracesTheSameInsideTheSandbox(String name) throws Exception {
        String code = TracerTest.sample(name);
        String outside = TracerTest.trace(code, "");
        String inside = sandboxed(code, "");
        assertEquals(stdoutOf(outside), stdoutOf(inside), name);
        assertEquals(outside.split("\"kind\":").length, inside.split("\"kind\":").length, name + ": same number of steps");
    }

    /** A program whose main runs `body` and prints what happened. */
    static String attempt(String body) {
        return """
                import java.io.*; import java.net.*; import java.nio.file.*; import java.util.*;
                public class Main {
                    static void attempt() throws Exception {
                %s
                    }
                    public static void main(String[] args) {
                        try { attempt(); System.out.println("ALLOWED"); }
                        catch (Throwable t) { System.out.println("BLOCKED " + t.getClass().getSimpleName()); }
                    }
                }
                """.formatted(body);
    }

    @Test
    void cannotReadTheTeachersFiles() throws Exception {
        Path secret = Path.of("build", "tmp", "sandbox-secret.txt").toAbsolutePath();
        Files.createDirectories(secret.getParent());
        Files.writeString(secret, "TOP-SECRET");
        String json = sandboxed(attempt("System.out.println(Files.readString(Path.of(\"" + secret + "\")));"), "");
        assertFalse(json.contains("TOP-SECRET"), json);
        assertTrue(stdoutOf(json).contains("BLOCKED"), stdoutOf(json));

        String home = sandboxed(attempt("System.out.println(Files.list(Path.of(\"" + System.getProperty("user.home") + "\")).count());"), "");
        assertTrue(stdoutOf(home).contains("BLOCKED"), "the home folder isn't there: " + stdoutOf(home));
    }

    @Test
    void cannotReachTheNetworkOrTheLaptopsOwnPrograms() throws Exception {
        try (ServerSocket laptop = new ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress())) {
            String json = sandboxed(attempt(
                    "try (Socket s = new Socket()) { s.connect(new InetSocketAddress(\"127.0.0.1\", " + laptop.getLocalPort() + "), 1000); }"), "");
            assertTrue(stdoutOf(json).contains("BLOCKED"), stdoutOf(json));
            laptop.setSoTimeout(200);
            assertThrows(SocketTimeoutException.class, () -> { try (Socket ignored = laptop.accept()) { } }, "nothing connected to the laptop");
        }
        String internet = sandboxed(attempt("try (Socket s = new Socket()) { s.connect(new InetSocketAddress(\"1.1.1.1\", 53), 1000); }"), "");
        assertTrue(stdoutOf(internet).contains("BLOCKED"), stdoutOf(internet));
    }

    @Test
    void cannotWriteOutsideItsOwnTemporaryFolder() throws Exception {
        assertTrue(stdoutOf(sandboxed(attempt("Files.writeString(Path.of(\"/usr/evil.txt\"), \"x\");"), "")).contains("BLOCKED"));
        assertTrue(stdoutOf(sandboxed(attempt("Files.writeString(Path.of(\"/tmp/ok.txt\"), \"x\");"), "")).contains("ALLOWED"),
                "its own /tmp is fine (and thrown away afterwards)");
    }

    @Test
    void forkBombsAndThreadBombsHitTheLimit() throws Exception {
        String procs = sandboxed(attempt("for (int i = 0; i < 1000; i++) new ProcessBuilder(\"sleep\", \"60\").start();"), "");
        assertTrue(stdoutOf(procs).contains("BLOCKED"), "process limit: " + stdoutOf(procs));
        String threads = sandboxed(attempt(
                "for (int i = 0; i < 100_000; i++) { Thread t = new Thread(() -> { try { Thread.sleep(60_000); } catch (InterruptedException e) { } }); t.setDaemon(true); t.start(); }"), "");
        assertTrue(stdoutOf(threads).contains("BLOCKED") || threads.contains("\"ok\":false") || threads.contains("timeout"), "thread limit: " + threads.substring(0, Math.min(300, threads.length())));
        // and nothing is left running afterwards
        Process ps = new ProcessBuilder("pgrep", "-f", "^sleep 60$").start();
        assertEquals("", new String(ps.getInputStream().readAllBytes()).strip(), "leftover processes");
    }

    @Test
    void hugeAllocationsAndEndlessLoopsAreStopped() throws Exception {
        String mem = sandboxed(attempt("long[] big = new long[400_000_000]; System.out.println(big.length);"), "");
        assertTrue(stdoutOf(mem).contains("BLOCKED OutOfMemoryError"), stdoutOf(mem));

        long start = System.nanoTime();
        String loop = sandboxed("public class Main { public static void main(String[] a) { long n = 0; while (true) n++; } }", "");
        assertTrue(loop.contains("\"end\":\"timeout\"") || loop.contains("\"end\":\"step_limit\""), loop.substring(0, 200));
        assertTrue((System.nanoTime() - start) / 1_000_000 < Sandbox.WALL_LIMIT_MS, "stopped in time");
    }
}
