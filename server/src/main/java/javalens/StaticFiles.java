package javalens;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;

/**
 * Serves the built web page (web/dist), which the Gradle build packs into the jar under /web.
 * In development the page comes from the Vite dev server instead, so this finds nothing and says so.
 */
public final class StaticFiles implements HttpHandler {
    private static final Map<String, String> TYPES = Map.ofEntries(
            Map.entry("html", "text/html; charset=utf-8"),
            Map.entry("js", "text/javascript; charset=utf-8"),
            Map.entry("css", "text/css; charset=utf-8"),
            Map.entry("json", "application/json"),
            Map.entry("svg", "image/svg+xml"),
            Map.entry("png", "image/png"),
            Map.entry("ico", "image/x-icon"),
            Map.entry("woff2", "font/woff2"),
            Map.entry("woff", "font/woff"),
            Map.entry("ttf", "font/ttf"));

    /** True when the jar contains the web page (i.e. this is a real build, not a dev run). */
    public static boolean available() {
        return StaticFiles.class.getResource("/web/index.html") != null;
    }

    @Override
    public void handle(HttpExchange ex) throws IOException {
        String path = ex.getRequestURI().getPath();
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        // Never allow escaping the /web folder.
        if (path.contains("..")) {
            reply(ex, 400, "text/plain", "bad path".getBytes());
            return;
        }
        try (InputStream in = StaticFiles.class.getResourceAsStream("/web" + path)) {
            if (in == null) {
                String msg = available() ? "Not found" :
                        "This is a development run: open the Vite dev server (http://localhost:5173) instead.";
                reply(ex, 404, "text/plain; charset=utf-8", msg.getBytes());
                return;
            }
            byte[] body = in.readAllBytes();
            String ext = path.substring(path.lastIndexOf('.') + 1);
            // Vite gives built files hashed names under /assets, so they can be cached forever.
            ex.getResponseHeaders().set("Cache-Control",
                    path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
            reply(ex, 200, TYPES.getOrDefault(ext, "application/octet-stream"), body);
        }
    }

    private static void reply(HttpExchange ex, int status, String type, byte[] body) throws IOException {
        ex.getResponseHeaders().set("Content-Type", type);
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(body); }
    }
}
