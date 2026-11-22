package javalens;

import com.sun.net.httpserver.HttpServer;
import javalens.ui.ControlWindow;

import java.awt.Desktop;
import java.awt.GraphicsEnvironment;
import java.io.IOException;
import java.net.BindException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.Locale;
import java.util.concurrent.Executors;

/**
 * JavaLens entry point.
 *
 * As an app (the installer, or `java -jar javalens.jar`): picks a free port, serves the web page,
 * opens the browser and shows a small control window with Open / Quit.
 *
 * For development (`./gradlew run`, which passes --dev): fixed port 7070, no window, no browser;
 * the Vite dev server (http://localhost:5173) serves the page and forwards requests here.
 *
 * Options: --dev  --port N  --no-browser  --headless (no window)
 */
public final class Main {
    private static final int DEFAULT_PORT = 7070;

    public static void main(String[] args) throws IOException {
        boolean dev = false, embedded = false, browser = true, headless = GraphicsEnvironment.isHeadless();
        boolean classMode = false;
        String classCode = null;
        Integer maxRuns = null, budgetMb = null;
        Integer port = null;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--dev" -> dev = true;
                // Started by the VS Code extension: a private server on any free port, no window, no browser.
                case "--embedded" -> embedded = true;
                case "--no-browser" -> browser = false;
                case "--headless" -> headless = true;
                case "--port" -> port = Integer.parseInt(args[++i]);
                // Class mode: serve a class through a tunnel (see class.sh and ClassRoom).
                case "--class" -> classMode = true;
                case "--code" -> classCode = args[++i];
                case "--max-runs" -> maxRuns = Integer.parseInt(args[++i]);
                case "--budget" -> budgetMb = Integer.parseInt(args[++i]);
                default -> System.err.println("Unknown option: " + args[i]);
            }
        }
        if (classMode) {
            startClass(port == null ? 7171 : port, classCode, maxRuns, budgetMb);
            return;
        }
        if (embedded && port == null) port = 0; // any free port; the extension reads it from our output
        if (dev || embedded) {
            browser = false;
            headless = true;
        }

        // Already running? Then just bring it up in the browser instead of starting a second copy.
        if (!dev && !embedded) {
            int running = Instance.findRunning();
            if (running > 0) {
                if (browser) openBrowser("http://127.0.0.1:" + running + "/");
                else System.out.println("JavaLens is already running on port " + running);
                return;
            }
        }

        HttpServer server = bind(port, dev);
        int actualPort = server.getAddress().getPort();
        Api.register(server);
        server.createContext("/", new StaticFiles());
        // A few threads, so autocomplete stays snappy even while a slow program is being traced.
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();

        String url = "http://127.0.0.1:" + actualPort + "/";
        boolean registered = !dev && !embedded; // only the desktop app is "the" running JavaLens
        if (registered) Instance.register(actualPort);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            Tracer.stopAll(); // don't leave a student's infinite loop running after we quit
            if (registered) Instance.unregister(actualPort);
            server.stop(0);
        }));

        System.out.println("JavaLens " + AppInfo.VERSION + " listening on " + url
                + (dev ? "  (dev mode: open http://localhost:5173)" : ""));
        if (browser) openBrowser(url);
        if (!headless) ControlWindow.show(url, AppInfo.VERSION, () -> openBrowser(url), () -> System.exit(0));
    }

    /**
     * Dev mode needs the exact port Vite forwards to. The app tries 7070-7079 first: the browser keeps
     * saved code and settings per address, so a stable port keeps them. Only then any free port.
     */
    private static HttpServer bind(Integer port, boolean dev) throws IOException {
        if (dev || port != null) {
            int wanted = port != null ? port : DEFAULT_PORT;
            try {
                return listen(wanted);
            } catch (BindException e) {
                throw new IOException("Port " + wanted + " is already in use. Is JavaLens already running?", e);
            }
        }
        for (int p = DEFAULT_PORT; p < DEFAULT_PORT + 10; p++) {
            try {
                return listen(p);
            } catch (BindException ignored) { }
        }
        return listen(0);
    }

    /** Only listen on this machine: the server runs whatever code it is given. */
    /**
     * Class mode: only on this computer (127.0.0.1; students come in through the tunnel), every run
     * sandboxed, and all runs together kept inside a memory budget sized from what's free now.
     */
    private static void startClass(int port, String code, Integer maxRuns, Integer budgetMb) throws IOException {
        String why = Sandbox.unavailable();
        if (why != null) {
            System.err.println("Class mode can't start: " + why + ".");
            System.exit(1);
        }
        long free = Sandbox.availableMb();
        long budget = budgetMb != null ? budgetMb : Sandbox.defaultBudgetMb();
        if (budget < 2 * Sandbox.MB_PER_RUN || budget > free) {
            System.err.println("Not enough free memory for a class (" + free + " MB free; student programs need at least "
                    + 2 * Sandbox.MB_PER_RUN + " MB). Close some apps and try again.");
            System.exit(1);
        }
        int fits = (int) (budget / Sandbox.MB_PER_RUN);
        int runs = Math.max(1, Math.min(maxRuns != null ? maxRuns : Math.min(8, fits), fits));
        String problem = Sandbox.setBudget(budget, runs);
        if (problem != null) {
            System.err.println("Class mode can't start: " + problem);
            System.exit(1);
        }
        if (code != null && !ClassRoom.isValidCode(code)) {
            System.err.println("--code must be 4-12 letters");
            System.exit(1);
        }
        ClassRoom room = new ClassRoom(code != null ? code : ClassRoom.newCode(), runs);

        HttpServer server = listen(port);
        Api.register(server, room);
        server.createContext("/", room.guard(ClassRoom.Kind.PAGE, new StaticFiles()));
        // Plenty of threads: runs wait for a slot, and editor help must not wait behind them.
        server.setExecutor(Executors.newFixedThreadPool(64));
        server.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(0)));

        System.out.println("JavaLens " + AppInfo.VERSION + " class mode on http://127.0.0.1:" + port + "/");
        System.out.println("Class code: " + room.code + "   (students open <tunnel address>/join/" + room.code + ")");
        System.out.println("Student programs: up to " + runs + " at once, " + budget + " MB of memory between them ("
                + free + " MB free now). Ctrl+C to end class.");
    }

    private static HttpServer listen(int port) throws IOException {
        return HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
    }

    static void openBrowser(String url) {
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI.create(url));
                return;
            }
        } catch (Exception ignored) {
            // fall through to the OS command
        }
        String os = System.getProperty("os.name").toLowerCase(Locale.ROOT);
        String[] cmd = os.contains("win") ? new String[]{"rundll32", "url.dll,FileProtocolHandler", url}
                : os.contains("mac") ? new String[]{"open", url}
                : new String[]{"xdg-open", url};
        try {
            new ProcessBuilder(cmd).inheritIO().start();
        } catch (IOException e) {
            System.out.println("Open " + url + " in your browser.");
        }
    }
}
