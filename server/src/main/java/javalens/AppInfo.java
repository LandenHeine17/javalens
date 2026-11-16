package javalens;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Properties;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The app's version (written by the Gradle build into version.properties) and the
 * "update available" check against the project's GitHub Releases page.
 *
 * The check only runs when the build sets `updateRepo` (e.g. "yourname/javalens") in
 * gradle.properties. It sends nothing about the user: just "what is the latest release?".
 */
public final class AppInfo {
    private AppInfo() {}

    private static final Properties PROPS = load();
    public static final String VERSION = PROPS.getProperty("version", "dev");
    private static final String UPDATE_REPO = PROPS.getProperty("updateRepo", "").trim();
    private static final long CHECK_EVERY_MS = 6 * 60 * 60 * 1000L;

    private static volatile String latest;    // e.g. "1.2.0"
    private static volatile String latestUrl; // the release page
    private static volatile long checkedAt;

    private static Properties load() {
        Properties p = new Properties();
        try (InputStream in = AppInfo.class.getResourceAsStream("/javalens/version.properties")) {
            if (in != null) p.load(in);
        } catch (Exception ignored) { }
        return p;
    }

    /** {"version":"1.0.0","latest":"1.1.0","url":"https://..."} (latest/url are null when up to date or unknown). */
    public static String versionJson() {
        refreshIfStale();
        boolean newer = latest != null && compare(latest, VERSION) > 0;
        return "{\"version\":" + Json.str(VERSION)
                + ",\"latest\":" + (newer ? Json.str(latest) : "null")
                + ",\"url\":" + (newer ? Json.str(latestUrl) : "null") + "}";
    }

    private static synchronized void refreshIfStale() {
        if (UPDATE_REPO.isEmpty() || VERSION.equals("dev")) return;
        if (System.currentTimeMillis() - checkedAt < CHECK_EVERY_MS) return;
        checkedAt = System.currentTimeMillis();
        Thread.ofVirtual().start(AppInfo::checkGitHub); // never block the page on the network
    }

    private static void checkGitHub() {
        try {
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).build();
            HttpRequest req = HttpRequest.newBuilder(URI.create("https://api.github.com/repos/" + UPDATE_REPO + "/releases/latest"))
                    .header("Accept", "application/vnd.github+json")
                    .header("User-Agent", "JavaLens-update-check")
                    .timeout(Duration.ofSeconds(6))
                    .build();
            HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() != 200) return;
            Matcher tag = Pattern.compile("\"tag_name\"\\s*:\\s*\"v?([^\"]+)\"").matcher(res.body());
            Matcher url = Pattern.compile("\"html_url\"\\s*:\\s*\"([^\"]+/releases/tag/[^\"]+)\"").matcher(res.body());
            if (tag.find() && url.find()) {
                latest = tag.group(1);
                latestUrl = url.group(1);
            }
        } catch (Exception ignored) {
            // offline (e.g. in a lecture hall): just no badge
        }
    }

    /** Compares dotted versions numerically: 1.10.0 > 1.9.3. */
    static int compare(String a, String b) {
        String[] x = a.split("[.-]"), y = b.split("[.-]");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? parse(x[i]) : 0, q = i < y.length ? parse(y[i]) : 0;
            if (p != q) return Integer.compare(p, q);
        }
        return 0;
    }

    private static int parse(String s) {
        try { return Integer.parseInt(s); } catch (NumberFormatException e) { return 0; }
    }
}
