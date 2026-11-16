import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * JavaLens server. Run with:  java server/src/Main.java
 * POST /run    {"code": "...", "stdin": "..."}  ->  trace JSON (a snapshot per executed line)
 * POST /count  same body                       ->  {"count": number of lines executed}
 * POST /complete, /hover, /signature  {"code", "line", "col"}  ->  editor help
 */
public class Main {
    public static void main(String[] args) throws IOException {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 7070;
        // Only listen on this machine: the server runs student code.
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/run", ex -> handle(ex, false));
        server.createContext("/count", ex -> handle(ex, true)); // line counts only, for the Big-O chart
        // Editor help: autocomplete, hover, parameter hints (see Assist.java)
        server.createContext("/complete", ex -> handleAssist(ex, Assist::complete));
        server.createContext("/hover", ex -> handleAssist(ex, Assist::hover));
        server.createContext("/signature", ex -> handleAssist(ex, Assist::signature));
        // A few threads, so autocomplete stays snappy even while a slow program is being traced.
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(4));
        server.start();
        System.out.println("JavaLens server listening on http://127.0.0.1:" + port);
    }

    private static void handle(HttpExchange ex, boolean countOnly) throws IOException {
        if (!ex.getRequestMethod().equals("POST")) {
            send(ex, 405, "{\"ok\":false,\"error\":\"POST only\"}");
            return;
        }
        Compiler.Result compiled = null;
        try {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Map<String, String> req = Json.parseFlatObject(body);
            long start = System.nanoTime();
            compiled = Compiler.compile(req.getOrDefault("code", ""));
            long compileMs = (System.nanoTime() - start) / 1_000_000;

            String diags = diagnosticsJson(compiled);
            if (!compiled.ok()) {
                send(ex, 200, "{\"ok\":false,\"error\":\"compile\",\"diagnostics\":" + diags + "}");
                return;
            }
            String stdin = req.getOrDefault("stdin", "");
            String trace = countOnly ? Tracer.count(compiled, stdin) : Tracer.run(compiled, stdin);
            long totalMs = (System.nanoTime() - start) / 1_000_000;
            System.out.printf((countOnly ? "count" : "run") + ": compile %d ms, total %d ms%n", compileMs, totalMs);
            // Splice diagnostics (warnings) and timing into the trace object.
            send(ex, 200, trace.substring(0, trace.length() - 1)
                    + ",\"diagnostics\":" + diags + ",\"ms\":" + totalMs + "}");
        } catch (Exception e) {
            e.printStackTrace();
            send(ex, 500, "{\"ok\":false,\"error\":\"server\",\"message\":" + Json.str(String.valueOf(e)) + "}");
        } finally {
            if (compiled != null) Compiler.deleteQuietly(compiled.dir());
        }
    }

    interface AssistFn { String apply(String code, int line, int col); }

    private static void handleAssist(HttpExchange ex, AssistFn fn) throws IOException {
        try {
            Map<String, String> req = Json.parseFlatObject(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            String code = req.getOrDefault("code", "");
            int line = Integer.parseInt(req.getOrDefault("line", "1"));
            int col = Integer.parseInt(req.getOrDefault("col", "1"));
            send(ex, 200, fn.apply(code, line, col));
        } catch (Exception e) {
            e.printStackTrace();
            send(ex, 500, "{\"error\":" + Json.str(String.valueOf(e)) + "}");
        }
    }

    private static String diagnosticsJson(Compiler.Result r) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < r.diags().size(); i++) {
            Compiler.Diag d = r.diags().get(i);
            if (i > 0) sb.append(',');
            sb.append("{\"line\":").append(d.line()).append(",\"col\":").append(d.col())
              .append(",\"endCol\":").append(d.endCol())
              .append(",\"message\":").append(Json.str(d.message()))
              .append(",\"severity\":").append(Json.str(d.severity())).append('}');
        }
        return sb.append(']').toString();
    }

    private static void send(HttpExchange ex, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }
}
