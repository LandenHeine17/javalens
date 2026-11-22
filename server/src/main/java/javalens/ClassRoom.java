package javalens;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.Base64;
import java.util.Deque;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * Class mode (java -jar javalens.jar --class): the teacher's laptop serves JavaLens to a class
 * through a tunnel. Who may use it and how much:
 * <ul>
 *   <li>The class link /join/CODE gives each student's browser its own random token (a cookie).
 *       Without one, every page and API call is refused.</li>
 *   <li>Runs (/run, /count) share a fixed number of slots, so the laptop never runs more programs
 *       at once than its memory budget allows (see {@link Sandbox}). Each student may have 2 runs
 *       going and 40 a minute; editor help is limited to 10 a second; requests to 256 KB.</li>
 * </ul>
 */
public final class ClassRoom {
    public enum Kind { RUN, HELP, OTHER, PAGE }

    static final int MAX_BODY = 256 * 1024;
    static final int RUNS_IN_FLIGHT = 2;
    static final int RUNS_PER_MINUTE = 40;
    static final int HELP_PER_SECOND = 10;
    static final int FAILED_JOINS_PER_MINUTE = 10;
    static final String COOKIE = "jl_class";
    static final String CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O: they look like 1 and 0

    private static final SecureRandom RANDOM = new SecureRandom();

    final String code;
    final int maxRuns;
    private final Semaphore slots;
    private final long slotWaitMs;
    private final Map<String, Student> students = new ConcurrentHashMap<>();
    private final Map<String, Deque<Long>> failedJoins = new ConcurrentHashMap<>();

    private static final class Student {
        int inFlight;
        final Deque<Long> runs = new ArrayDeque<>();
        final Deque<Long> help = new ArrayDeque<>();
    }

    public ClassRoom(String code, int maxRuns) {
        this(code, maxRuns, 10_000);
    }

    ClassRoom(String code, int maxRuns, long slotWaitMs) {
        if (!isValidCode(code)) throw new IllegalArgumentException("class code must be 4-12 letters");
        this.code = code.toUpperCase(Locale.ROOT);
        this.maxRuns = maxRuns;
        this.slots = new Semaphore(maxRuns, true);
        this.slotWaitMs = slotWaitMs;
    }

    public static boolean isValidCode(String code) {
        return code != null && code.matches("[A-Za-z]{4,12}");
    }

    public static String newCode() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 6; i++) sb.append(CODE_LETTERS.charAt(RANDOM.nextInt(CODE_LETTERS.length())));
        return sb.toString();
    }

    public int studentCount() {
        return students.size();
    }

    // ---------------------------------------------------------------- joining

    /** GET /join/CODE: a valid code gets this browser a token cookie, then the page. */
    public void join(HttpExchange ex) throws IOException {
        String ip = clientIp(ex);
        if (tooMany(failedJoins.computeIfAbsent(ip, k -> new ArrayDeque<>()), FAILED_JOINS_PER_MINUTE, 60_000, false)) {
            page(ex, 429, "Too many tries", "Too many wrong class links from this network. Wait a minute and try again.");
            return;
        }
        String given = ex.getRequestURI().getPath().substring("/join/".length()).toUpperCase(Locale.ROOT);
        if (!MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), code.getBytes(StandardCharsets.UTF_8))) {
            tooMany(failedJoins.get(ip), FAILED_JOINS_PER_MINUTE, 60_000, true);
            page(ex, 403, "Wrong class link", "That class link isn't right. Check it with your teacher.");
            return;
        }
        if (student(ex) == null) {
            byte[] raw = new byte[24];
            RANDOM.nextBytes(raw);
            String token = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
            students.put(token, new Student());
            ex.getResponseHeaders().add("Set-Cookie", COOKIE + "=" + token + "; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax");
            System.out.println("A student joined (" + students.size() + " so far)");
        }
        ex.getResponseHeaders().set("Location", "/"); // the browser keeps a #s=... share link across this
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.sendResponseHeaders(302, -1);
        ex.close();
    }

    // ---------------------------------------------------------------- every other request

    /** Wraps a handler with the token check and the limits for its kind of request. */
    public HttpHandler guard(Kind kind, HttpHandler handler) {
        return ex -> {
            try {
                String length = ex.getRequestHeaders().getFirst("Content-Length");
                if (length != null && parseLong(length) > MAX_BODY) {
                    refuse(ex, 413, "That program is too big to send.");
                    return;
                }
                ex.setStreams(new Limited(ex.getRequestBody(), MAX_BODY), null);

                Student s = student(ex);
                if (s == null) {
                    if (kind == Kind.PAGE) page(ex, 403, "JavaLens", "Ask your teacher for the class link, and open that first.");
                    else refuse(ex, 403, "Open the class link from your teacher first.");
                    return;
                }
                switch (kind) {
                    case RUN -> run(ex, s, handler);
                    case HELP -> {
                        boolean limited;
                        synchronized (s) { limited = tooMany(s.help, HELP_PER_SECOND, 1_000, true); }
                        if (limited) refuse(ex, 429, "Slow down a little.");
                        else handler.handle(ex);
                    }
                    default -> handler.handle(ex);
                }
            } finally {
                ex.close();
            }
        };
    }

    private void run(HttpExchange ex, Student s, HttpHandler handler) throws IOException {
        synchronized (s) {
            if (s.inFlight >= RUNS_IN_FLIGHT) {
                refuse(ex, 429, "Your last run is still going. Try again in a moment.");
                return;
            }
            if (tooMany(s.runs, RUNS_PER_MINUTE, 60_000, true)) {
                refuse(ex, 429, "That's a lot of runs in a minute. Wait a few seconds.");
                return;
            }
            s.inFlight++;
        }
        try {
            boolean got;
            try {
                got = slots.tryAcquire(slotWaitMs, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                got = false;
            }
            if (!got) {
                refuse(ex, 503, "The class server is busy. Try again in a moment.");
                return;
            }
            try {
                handler.handle(ex);
            } finally {
                slots.release();
            }
        } finally {
            synchronized (s) { s.inFlight--; }
        }
    }

    // ---------------------------------------------------------------- helpers

    private Student student(HttpExchange ex) {
        for (String header : ex.getRequestHeaders().getOrDefault("Cookie", java.util.List.of())) {
            for (String part : header.split(";")) {
                String p = part.trim();
                if (p.startsWith(COOKIE + "=")) {
                    Student s = students.get(p.substring(COOKIE.length() + 1));
                    if (s != null) return s;
                }
            }
        }
        return null;
    }

    /** Behind the tunnel every request comes from 127.0.0.1; Cloudflare says who it really is. */
    private static String clientIp(HttpExchange ex) {
        String cf = ex.getRequestHeaders().getFirst("CF-Connecting-IP");
        return cf != null ? cf : ex.getRemoteAddress().getAddress().getHostAddress();
    }

    /** Drops times older than the window; true if `limit` are left. Records now when `record`. */
    private static boolean tooMany(Deque<Long> times, int limit, long windowMs, boolean record) {
        synchronized (times) {
            long now = System.currentTimeMillis();
            while (!times.isEmpty() && now - times.peekFirst() > windowMs) times.pollFirst();
            if (times.size() >= limit) return true;
            if (record) times.addLast(now);
            return false;
        }
    }

    private static long parseLong(String s) {
        try { return Long.parseLong(s.trim()); } catch (NumberFormatException e) { return Long.MAX_VALUE; }
    }

    private static void refuse(HttpExchange ex, int status, String message) throws IOException {
        send(ex, status, "{\"ok\":false,\"error\":\"server\",\"message\":" + Json.str(message) + "}", "application/json; charset=utf-8");
    }

    private static void page(HttpExchange ex, int status, String title, String message) throws IOException {
        send(ex, status, """
                <!doctype html><html lang="en"><head><meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1"><title>%s</title>
                <style>body{font:18px system-ui,sans-serif;background:#0f1117;color:#e6e8ee;display:grid;place-items:center;
                min-height:100vh;margin:0;padding:16px;text-align:center}b{color:#8aa6ff}</style></head>
                <body><div><p><b>JavaLens</b></p><p>%s</p></div></body></html>
                """.formatted(title, message), "text/html; charset=utf-8");
    }

    private static void send(HttpExchange ex, int status, String body, String type) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", type);
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    /** A request body that stops after `max` bytes (for bodies sent without a length). */
    private static final class Limited extends FilterInputStream {
        private long left;
        Limited(InputStream in, long max) { super(in); left = max; }

        @Override public int read() throws IOException {
            if (left <= 0) return atLimit();
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override public int read(byte[] buf, int off, int len) throws IOException {
            if (left <= 0) return atLimit();
            int n = super.read(buf, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        /** At the limit: fine if the body ends here, else it's too big. */
        private int atLimit() throws IOException {
            if (super.read() < 0) return -1;
            throw new IOException("request too large");
        }
    }
}
