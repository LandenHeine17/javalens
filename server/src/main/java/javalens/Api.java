package javalens;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.zip.Deflater;
import java.util.zip.GZIPOutputStream;

/**
 * The HTTP endpoints the web page talks to:
 * <pre>
 * POST /run       {"code", "stdin"}        -> trace JSON (a snapshot per executed line)
 *                 optional, for a multi-file project (VS Code): "mainPath" and "fileCount" N plus
 *                 "file.0.path", "file.0.code" ... "file.N-1.code" (paths relative to the source root)
 * POST /count     same body                -> {"count": number of lines executed}   (Big-O chart)
 * POST /complete, /hover, /signature  {"code", "line", "col"}  -> editor help
 * GET  /version                            -> {"version", "latest", "url"}          (update badge)
 * GET  /ping                               -> "javalens"                            (single-instance check)
 * </pre>
 */
public final class Api {
    private Api() {}

    /** Class mode, when the server was started with --class (else null): runs are sandboxed and limited. */
    private static volatile ClassRoom room;

    public static void register(HttpServer server) {
        register(server, null);
    }

    public static void register(HttpServer server, ClassRoom classRoom) {
        room = classRoom;
        context(server, "/run", ClassRoom.Kind.RUN, ex -> handleRun(ex, false));
        context(server, "/count", ClassRoom.Kind.RUN, ex -> handleRun(ex, true));
        context(server, "/complete", ClassRoom.Kind.HELP, ex -> handleAssist(ex, Assist::complete));
        context(server, "/hover", ClassRoom.Kind.HELP, ex -> handleAssist(ex, Assist::hover));
        context(server, "/signature", ClassRoom.Kind.HELP, ex -> handleAssist(ex, Assist::signature));
        context(server, "/version", ClassRoom.Kind.OTHER, ex -> send(ex, 200, room != null
                ? "{\"version\":" + Json.str(AppInfo.VERSION) + ",\"latest\":null,\"url\":null,\"classMode\":true}"
                : AppInfo.versionJson(), "application/json; charset=utf-8"));
        context(server, "/ping", ClassRoom.Kind.OTHER, ex -> send(ex, 200, Instance.PING_REPLY, "text/plain; charset=utf-8"));
        if (room != null) server.createContext("/join/", room::join);
    }

    private static void context(HttpServer server, String path, ClassRoom.Kind kind, com.sun.net.httpserver.HttpHandler h) {
        server.createContext(path, room != null ? room.guard(kind, h) : h);
    }

    private static void handleRun(HttpExchange ex, boolean countOnly) throws IOException {
        if (!ex.getRequestMethod().equals("POST")) {
            sendJson(ex, 405, "{\"ok\":false,\"error\":\"POST only\"}");
            return;
        }
        Compiler.Result compiled = null;
        try {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Map<String, String> req = Json.parseFlatObject(body);
            long start = System.nanoTime();
            compiled = Compiler.compile(req.getOrDefault("code", ""), req.get("mainPath"), otherFiles(req));

            String diags = diagnosticsJson(compiled);
            if (!compiled.ok()) {
                sendJson(ex, 200, "{\"ok\":false,\"error\":\"compile\",\"diagnostics\":" + diags + "}");
                return;
            }
            String stdin = req.getOrDefault("stdin", "");
            String trace = room != null ? Sandbox.trace(compiled, stdin, countOnly) // class mode: never run student code unsandboxed
                    : countOnly ? Tracer.count(compiled, stdin) : Tracer.run(compiled, stdin);
            long totalMs = (System.nanoTime() - start) / 1_000_000;
            // Splice diagnostics (warnings) and timing into the trace object.
            sendJson(ex, 200, trace.substring(0, trace.length() - 1)
                    + ",\"diagnostics\":" + diags + ",\"ms\":" + totalMs + "}");
        } catch (Exception e) {
            e.printStackTrace();
            sendJson(ex, 500, "{\"ok\":false,\"error\":\"server\",\"message\":" + Json.str(String.valueOf(e)) + "}");
        } finally {
            if (compiled != null) Compiler.deleteQuietly(compiled.dir());
        }
    }

    /** The project's other source files, sent as flat "file.N.path" / "file.N.code" fields. */
    private static List<Compiler.Source> otherFiles(Map<String, String> req) {
        List<Compiler.Source> out = new ArrayList<>();
        int n;
        try { n = Integer.parseInt(req.getOrDefault("fileCount", "0")); } catch (NumberFormatException e) { n = 0; }
        for (int i = 0; i < n; i++) {
            String path = req.get("file." + i + ".path"), code = req.get("file." + i + ".code");
            if (path != null && code != null) out.add(new Compiler.Source(path, code));
        }
        return out;
    }

    interface AssistFn { String apply(String code, int line, int col); }

    private static void handleAssist(HttpExchange ex, AssistFn fn) throws IOException {
        try {
            Map<String, String> req = Json.parseFlatObject(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            String code = req.getOrDefault("code", "");
            int line = Integer.parseInt(req.getOrDefault("line", "1"));
            int col = Integer.parseInt(req.getOrDefault("col", "1"));
            sendJson(ex, 200, fn.apply(code, line, col));
        } catch (Exception e) {
            e.printStackTrace();
            sendJson(ex, 500, "{\"error\":" + Json.str(String.valueOf(e)) + "}");
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
              .append(",\"severity\":").append(Json.str(d.severity()));
            if (d.file() != null) sb.append(",\"file\":").append(Json.str(d.file()));
            sb.append('}');
        }
        return sb.append(']').toString();
    }

    private static void sendJson(HttpExchange ex, int status, String json) throws IOException {
        send(ex, status, json, "application/json; charset=utf-8");
    }

    private static void send(HttpExchange ex, int status, String body, String type) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", type);
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        // Traces are repetitive JSON: gzip shrinks them ~20x (it matters once the server isn't local).
        String accept = ex.getRequestHeaders().getFirst("Accept-Encoding");
        if (bytes.length > 8192 && accept != null && accept.contains("gzip")) {
            ByteArrayOutputStream packed = new ByteArrayOutputStream(bytes.length / 8);
            try (GZIPOutputStream gz = new GZIPOutputStream(packed) {{ def.setLevel(Deflater.BEST_SPEED); }}) {
                gz.write(bytes);
            }
            bytes = packed.toByteArray();
            ex.getResponseHeaders().set("Content-Encoding", "gzip");
            ex.getResponseHeaders().set("Vary", "Accept-Encoding");
        }
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }
}
