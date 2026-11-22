package javalens;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Class mode's door and limits, over real HTTP. The handlers behind it are stubs, so no program
 * (and no sandbox) is ever started here.
 */
class ClassRoomTest {
    HttpServer server;
    String base;
    final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
    final CountDownLatch release = new CountDownLatch(1); // holds stub runs open until released

    ClassRoom start(int maxRuns, long slotWaitMs) throws IOException {
        ClassRoom room = new ClassRoom("ABCDEF", maxRuns, slotWaitMs);
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/join/", room::join);
        server.createContext("/run", room.guard(ClassRoom.Kind.RUN, ex -> {
            ex.getRequestBody().readAllBytes();
            try { release.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            reply(ex, "{\"ok\":true}");
        }));
        server.createContext("/complete", room.guard(ClassRoom.Kind.HELP, ex -> reply(ex, "{}")));
        server.createContext("/", room.guard(ClassRoom.Kind.PAGE, ex -> reply(ex, "the page")));
        server.setExecutor(Executors.newFixedThreadPool(16));
        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort();
        return room;
    }

    static void reply(com.sun.net.httpserver.HttpExchange ex, String body) throws IOException {
        byte[] b = body.getBytes();
        ex.sendResponseHeaders(200, b.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(b); }
    }

    @AfterEach
    void stop() {
        release.countDown();
        if (server != null) server.stop(0);
    }

    HttpResponse<String> get(String path, String cookie) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path));
        if (cookie != null) b.header("Cookie", cookie);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    CompletableFuture<HttpResponse<String>> post(String path, String cookie, String body) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path)).POST(HttpRequest.BodyPublishers.ofString(body));
        if (cookie != null) b.header("Cookie", cookie);
        return http.sendAsync(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    /** Joins with the class link; returns the cookie to send back. */
    String join() throws Exception {
        HttpResponse<String> r = get("/join/abcdef", null); // codes aren't case-sensitive
        assertEquals(302, r.statusCode());
        assertEquals("/", r.headers().firstValue("Location").orElseThrow());
        String setCookie = r.headers().firstValue("Set-Cookie").orElseThrow();
        assertTrue(setCookie.contains("HttpOnly") && setCookie.contains("Secure") && setCookie.contains("SameSite=Lax"), setCookie);
        return setCookie.split(";")[0];
    }

    @Test
    void nothingWorksWithoutTheClassLink() throws Exception {
        start(4, 1000);
        HttpResponse<String> page = get("/", null);
        assertEquals(403, page.statusCode());
        assertTrue(page.body().contains("Ask your teacher for the class link"));
        assertEquals(403, post("/run", null, "{}").get().statusCode());
        assertEquals(403, post("/run", "jl_class=made-up", "{}").get().statusCode());
        assertEquals(403, get("/join/WRONGO", null).statusCode());
    }

    @Test
    void theClassLinkLetsAStudentIn() throws Exception {
        ClassRoom room = start(4, 1000);
        String cookie = join();
        release.countDown();
        assertEquals("the page", get("/", cookie).body());
        HttpResponse<String> run = post("/run", "other=1; " + cookie, "{\"code\":\"x\"}").get();
        assertEquals(200, run.statusCode(), run.body());
        assertEquals(1, room.studentCount());
        assertEquals(302, get("/join/ABCDEF", cookie).statusCode());
        assertEquals(1, room.studentCount(), "joining again doesn't make a second student");
    }

    @Test
    void wrongCodesAreLimited() throws Exception {
        start(4, 1000);
        for (int i = 0; i < ClassRoom.FAILED_JOINS_PER_MINUTE; i++) assertEquals(403, get("/join/WRONGO", null).statusCode());
        assertEquals(429, get("/join/ABCDEF", null).statusCode(), "even the right code waits after too many wrong ones");
    }

    @Test
    void bigRequestsAreRefused() throws Exception {
        start(4, 1000);
        String cookie = join();
        HttpResponse<String> r = post("/run", cookie, "x".repeat(ClassRoom.MAX_BODY + 1)).get();
        assertEquals(413, r.statusCode());
    }

    @Test
    void aStudentHasAtMostTwoRunsGoing() throws Exception {
        start(8, 1000);
        String cookie = join();
        var first = post("/run", cookie, "{}");
        var second = post("/run", cookie, "{}");
        Thread.sleep(300); // both are now held open by the stub
        HttpResponse<String> third = post("/run", cookie, "{}").get();
        assertEquals(429, third.statusCode());
        assertTrue(third.body().contains("still going"), third.body());
        release.countDown();
        assertEquals(200, first.get().statusCode());
        assertEquals(200, second.get().statusCode());
    }

    @Test
    void whenEverySlotIsTakenOthersAreToldItsBusy() throws Exception {
        start(1, 300);
        String a = join(), b = join2();
        var holding = post("/run", a, "{}");
        Thread.sleep(200);
        HttpResponse<String> waiting = post("/run", b, "{}").get();
        assertEquals(503, waiting.statusCode());
        assertTrue(waiting.body().contains("busy"), waiting.body());
        release.countDown();
        assertEquals(200, holding.get().statusCode());
    }

    @Test
    void editorHelpIsRateLimited() throws Exception {
        start(4, 1000);
        String cookie = join();
        List<Integer> codes = new java.util.ArrayList<>();
        for (int i = 0; i < ClassRoom.HELP_PER_SECOND + 3; i++) codes.add(post("/complete", cookie, "{}").get().statusCode());
        assertTrue(codes.contains(429), codes.toString());
        assertEquals(200, codes.get(0));
    }

    /** A second student (a fresh join without the first one's cookie). */
    String join2() throws Exception {
        return join();
    }
}
