package javalens;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Class mode runs every student program inside a sandbox (Linux only):
 * <ul>
 *   <li>systemd-run puts it in its own cgroup: memory, process count and CPU are capped;</li>
 *   <li>bubblewrap (bwrap) gives it its own empty network (just a loopback), its own process list,
 *       a read-only /usr and Java, an in-memory /tmp, and nothing from the home folder;</li>
 *   <li>inside, {@link TraceWorker} traces the program. The debugger has to run in there too: it talks
 *       to the student's JVM over a socket, which only works on the sandbox's own loopback.</li>
 * </ul>
 * The class files were compiled outside (javac never runs the code) and are mounted read-only.
 */
public final class Sandbox {
    private Sandbox() {}

    static final String MEMORY_MAX = "384M";   // one run: the tracer's JVM + the student's JVM (a typical run peaks near 100 MB)
    // Every run goes in this one systemd slice, whose MemoryMax is the budget for ALL runs together
    // (see setBudget), so a classful of programs can never take the laptop's memory.
    static final String SLICE = "javalens-class.slice";
    static final long MB_PER_RUN = 200;        // what we plan for per run when sizing the budget
    static final String WORK = "/work";        // the compiled program, inside the sandbox
    static final String APP = "/javalens-app";  // our own classes, inside the sandbox
    static final String JDK = "/javalens-jdk";  // Java, inside the sandbox, when it isn't already under /usr
    static final String TASKS_MAX = "96";      // threads + processes: stops fork bombs
    static final String CPU_QUOTA = "200%";    // two cores per run
    static final long WALL_LIMIT_MS = 12_000;  // the tracer stops at 3 s (4 s for counting); this is the backstop

    /** Trace (or count) a compiled program in the sandbox; returns the same JSON as Tracer.run/count. */
    public static String trace(Compiler.Result compiled, String stdin, boolean countOnly) throws IOException, InterruptedException {
        Process p = new ProcessBuilder(command(compiled.dir())).redirectError(ProcessBuilder.Redirect.DISCARD).start();
        // Inside, the program's folder is /work (so no path from the teacher's computer shows up in there).
        Compiler.Result inside = new Compiler.Result(compiled.ok(), Path.of(WORK), compiled.mainClass(), compiled.userClasses(),
                compiled.diags(), compiled.finalLocals(), compiled.stringLiterals(), compiled.mainSource());
        try (OutputStream in = p.getOutputStream()) {
            in.write(TraceWorker.request(inside, stdin, countOnly).getBytes(StandardCharsets.UTF_8));
        }
        CompletableFuture<byte[]> out = readAll(p.getInputStream());
        if (!p.waitFor(WALL_LIMIT_MS, TimeUnit.MILLISECONDS)) {
            p.destroyForcibly(); // takes the whole sandbox with it (--die-with-parent)
            return "{\"ok\":true,\"delta\":true,\"end\":\"timeout\",\"maxSteps\":" + Tracer.MAX_STEPS
                    + ",\"stdout\":\"\",\"code\":[],\"steps\":[]" + (countOnly ? ",\"count\":0" : "") + "}";
        }
        String json = new String(out.join(), StandardCharsets.UTF_8).trim();
        if (json.isEmpty() || !json.startsWith("{")) {
            // Most likely the sandbox's memory cap stopped the tracer itself.
            return "{\"ok\":false,\"error\":\"server\",\"message\":\"The program used too much memory and was stopped.\"}";
        }
        return json;
    }

    /** Can we sandbox on this computer? null if yes, else why not (class mode won't start without it). */
    public static String unavailable() {
        if (!System.getProperty("os.name", "").toLowerCase().contains("linux")) return "class mode needs Linux (it uses bubblewrap)";
        for (String tool : new String[]{"bwrap", "systemd-run"}) {
            if (find(tool) == null) return "'" + tool + "' is not installed";
        }
        try {
            Path probe = Files.createTempDirectory("javalens-probe");
            try {
                Process p = new ProcessBuilder(command(probe, true)).redirectErrorStream(true).start();
                String text = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                if (!p.waitFor(20, TimeUnit.SECONDS) || p.exitValue() != 0) return "the sandbox didn't start: " + text.strip();
            } finally {
                Compiler.deleteQuietly(probe);
            }
        } catch (Exception e) {
            return "the sandbox didn't start: " + e;
        }
        return null;
    }

    static List<String> command(Path compiledDir) {
        return command(compiledDir, false);
    }

    /** probe: run "java -version" instead of the worker (to check the sandbox starts). */
    private static List<String> command(Path compiledDir, boolean probe) {
        String javaHome = System.getProperty("java.home");
        String hostCode = codeSource();
        // Our jar (or classes folder) and the compiled program get neutral paths inside the sandbox.
        String code = hostCode.endsWith(".jar") ? APP + "/javalens.jar" : APP + "/classes";
        List<String> cmd = new ArrayList<>(List.of(
                "systemd-run", "--user", "--scope", "--quiet", "--collect", "--slice=" + SLICE,
                "-p", "MemoryMax=" + MEMORY_MAX, "-p", "MemorySwapMax=0",
                "-p", "TasksMax=" + TASKS_MAX, "-p", "CPUQuota=" + CPU_QUOTA,
                "--",
                "bwrap", "--unshare-all", "--die-with-parent", "--new-session",
                "--ro-bind", "/usr", "/usr",
                "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
                "--ro-bind-try", "/etc/java", "/etc/java",   // Fedora keeps the JDK's conf files here
                "--ro-bind-try", "/etc/crypto-policies", "/etc/crypto-policies", // ...and its java.security includes this
                "--ro-bind-try", "/etc/hosts", "/etc/hosts", // "localhost", for the debugger's socket
                "--proc", "/proc", "--dev", "/dev",
                "--tmpfs", "/tmp"));
        String java = javaHome;
        if (!javaHome.startsWith("/usr/")) { // e.g. a JDK in the home folder, or the app's bundled runtime
            cmd.addAll(List.of("--ro-bind", javaHome, JDK));
            java = JDK;
        }
        cmd.addAll(List.of(
                "--ro-bind", hostCode, code,
                "--ro-bind", compiledDir.toString(), WORK,
                "--chdir", "/tmp",
                "--setenv", "HOME", "/tmp", "--unsetenv", "DISPLAY", "--unsetenv", "WAYLAND_DISPLAY",
                "--unsetenv", "DBUS_SESSION_BUS_ADDRESS", "--unsetenv", "XDG_RUNTIME_DIR",
                Path.of(java, "bin", "java").toString()));
        if (probe) cmd.add("-version");
        else cmd.addAll(List.of("-Xmx96m", "-XX:TieredStopAtLevel=1", "-Xshare:auto", "-cp", code, TraceWorker.class.getName()));
        return cmd;
    }

    /** MemAvailable from /proc/meminfo, in MB (0 if it can't be read). */
    static long availableMb() {
        try {
            for (String line : Files.readAllLines(Path.of("/proc/meminfo"))) {
                if (line.startsWith("MemAvailable:")) return Long.parseLong(line.replaceAll("\\D+", "")) / 1024;
            }
        } catch (IOException | NumberFormatException ignored) { }
        return 0;
    }

    /**
     * The memory budget for all student programs together: 40% of what's free right now, at most
     * 2 GB, so the teacher's own apps keep working. 0 if there isn't enough free to run a class.
     */
    static long defaultBudgetMb() {
        long budget = Math.min(2048, availableMb() * 2 / 5);
        return budget < 2 * MB_PER_RUN ? 0 : budget;
    }

    /** Caps memory (and processes) for all runs together. Returns null, or why it failed. */
    static String setBudget(long mb, int maxRuns) {
        try {
            Process p = new ProcessBuilder("systemctl", "--user", "set-property", "--runtime", SLICE,
                    "MemoryMax=" + mb + "M", "MemorySwapMax=0", "TasksMax=" + (maxRuns * 128))
                    .redirectErrorStream(true).start();
            String text = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            return p.waitFor(10, TimeUnit.SECONDS) && p.exitValue() == 0 ? null : "couldn't set the memory budget: " + text.strip();
        } catch (Exception e) {
            return "couldn't set the memory budget: " + e;
        }
    }

    /** Where our own classes are: the jar, or the classes folder when run from Gradle. */
    private static String codeSource() {
        try {
            return Path.of(TraceWorker.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toString();
        } catch (Exception e) {
            throw new IllegalStateException("can't find JavaLens's own classes", e);
        }
    }

    private static Path find(String tool) {
        for (String dir : System.getenv().getOrDefault("PATH", "").split(":")) {
            Path p = Path.of(dir, tool);
            if (Files.isExecutable(p)) return p;
        }
        return null;
    }

    private static CompletableFuture<byte[]> readAll(InputStream in) {
        return CompletableFuture.supplyAsync(() -> {
            try (in) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                in.transferTo(buf);
                return buf.toByteArray();
            } catch (IOException e) {
                return new byte[0];
            }
        }, Thread::startVirtualThread);
    }
}
