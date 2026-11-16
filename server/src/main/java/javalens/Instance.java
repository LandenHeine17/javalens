package javalens;

import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Makes sure only one JavaLens runs at a time. The running copy writes its port to
 * ~/.javalens/port; a second launch finds it, pings it, opens the browser to it, and exits.
 */
public final class Instance {
    private Instance() {}

    public static final String PING_REPLY = "javalens";
    private static final Path PORT_FILE = Path.of(System.getProperty("user.home"), ".javalens", "port");

    /** The port of an already-running JavaLens, or -1 if there isn't one. */
    public static int findRunning() {
        try {
            int port = Integer.parseInt(Files.readString(PORT_FILE).trim());
            HttpURLConnection c = (HttpURLConnection) URI.create("http://127.0.0.1:" + port + "/ping").toURL().openConnection();
            c.setConnectTimeout(400);
            c.setReadTimeout(800);
            try (var in = c.getInputStream()) {
                return new String(in.readAllBytes(), StandardCharsets.UTF_8).equals(PING_REPLY) ? port : -1;
            }
        } catch (Exception e) {
            return -1; // no file, stale port, or something else on that port
        }
    }

    public static void register(int port) {
        try {
            Files.createDirectories(PORT_FILE.getParent());
            Files.writeString(PORT_FILE, Integer.toString(port));
        } catch (Exception ignored) { }
    }

    public static void unregister(int port) {
        try {
            if (Files.readString(PORT_FILE).trim().equals(Integer.toString(port))) Files.delete(PORT_FILE);
        } catch (Exception ignored) { }
    }
}
