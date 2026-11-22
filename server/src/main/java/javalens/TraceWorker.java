package javalens;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Traces one already-compiled program and prints the trace JSON, then exits. Class mode runs this
 * inside the sandbox (see {@link Sandbox}), so the debugger and the student's JVM share a private
 * network with nothing on it but each other.
 *
 * Input on stdin, one flat JSON object (see {@link #request}): the compile result, "stdin", "count".
 */
public final class TraceWorker {
    private TraceWorker() {}

    public static void main(String[] args) throws Exception {
        Map<String, String> req = Json.parseFlatObject(new String(System.in.readAllBytes(), StandardCharsets.UTF_8));
        Compiler.Result compiled = new Compiler.Result(true, Path.of(req.get("dir")), req.get("mainClass"),
                lines(req.get("userClasses")), List.of(), lines(req.get("finalLocals")), indexed(req, "lit"),
                req.get("mainSource"));
        // The student's program gets a memory cap of its own, well inside the sandbox's.
        Tracer.extraJvmOptions = "-Xmx128m -XX:MaxMetaspaceSize=96m";
        String stdin = req.getOrDefault("stdin", "");
        String json = "true".equals(req.get("count")) ? Tracer.count(compiled, stdin) : Tracer.run(compiled, stdin);
        System.out.write(json.getBytes(StandardCharsets.UTF_8));
        System.out.flush();
        System.exit(0); // don't wait on JDI's threads
    }

    /** The request {@link #main} reads, as JSON. */
    static String request(Compiler.Result c, String stdin, boolean countOnly) {
        StringBuilder sb = new StringBuilder("{");
        field(sb, "dir", c.dir().toString());
        field(sb, "mainClass", c.mainClass());
        field(sb, "mainSource", c.mainSource());
        field(sb, "userClasses", String.join("\n", c.userClasses()));
        field(sb, "finalLocals", String.join("\n", c.finalLocals()));
        List<String> lits = new ArrayList<>(c.stringLiterals());
        field(sb, "lit.count", String.valueOf(lits.size()));
        for (int i = 0; i < lits.size(); i++) field(sb, "lit." + i, lits.get(i)); // literals may contain newlines
        field(sb, "stdin", stdin == null ? "" : stdin);
        field(sb, "count", String.valueOf(countOnly));
        sb.setLength(sb.length() - 1);
        return sb.append('}').toString();
    }

    private static void field(StringBuilder sb, String key, String value) {
        sb.append(Json.str(key)).append(':').append(Json.str(value)).append(',');
    }

    private static Set<String> lines(String s) {
        Set<String> out = new LinkedHashSet<>();
        if (s != null) for (String line : s.split("\n")) if (!line.isEmpty()) out.add(line);
        return out;
    }

    private static Set<String> indexed(Map<String, String> req, String prefix) throws IOException {
        Set<String> out = new LinkedHashSet<>();
        int n = Integer.parseInt(req.getOrDefault(prefix + ".count", "0"));
        for (int i = 0; i < n; i++) out.add(req.get(prefix + "." + i));
        return out;
    }
}
