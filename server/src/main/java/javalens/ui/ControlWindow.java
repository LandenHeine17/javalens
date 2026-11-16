package javalens.ui;

import com.formdev.flatlaf.FlatDarkLaf;
import com.formdev.flatlaf.FlatLaf;

import javax.swing.*;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.util.List;
import java.util.Map;

/**
 * The small window that appears when JavaLens is launched as an app. JavaLens itself runs in the
 * browser, so this is how people know it's running and how they quit it.
 * (A tray icon isn't used because many Linux desktops, including Fedora's GNOME, don't show one.)
 */
public final class ControlWindow {
    private ControlWindow() {}

    public static void show(String url, String version, Runnable openBrowser, Runnable quit) {
        SwingUtilities.invokeLater(() -> {
            setupLook();
            JFrame f = new JFrame("JavaLens");
            f.setIconImages(List.of(Logo.image(16), Logo.image(32), Logo.image(64), Logo.image(128)));
            if (Taskbar.isTaskbarSupported() && Taskbar.getTaskbar().isSupported(Taskbar.Feature.ICON_IMAGE)) {
                Taskbar.getTaskbar().setIconImage(Logo.image(256)); // macOS dock icon
            }
            JButton[] open = new JButton[1];
            f.setContentPane(content(url, version, openBrowser, quit, open));
            f.getRootPane().setDefaultButton(open[0]);
            f.setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);
            f.addWindowListener(new WindowAdapter() {
                @Override public void windowClosing(WindowEvent e) { quit.run(); }
            });
            f.pack();
            f.setResizable(false);
            f.setLocationRelativeTo(null);
            f.setVisible(true);
        });
    }

    /** FlatLaf's dark theme recolored to match the web app (same tokens as web/src/styles.css). */
    public static void setupLook() {
        FlatLaf.setGlobalExtraDefaults(Map.of(
                "@background", "#12151c",
                "@foreground", "#e7e9ef",
                "@accentColor", "#5b7cfa",
                "@disabledForeground", "#8a91a2",
                "Button.background", "#222734",
                "Button.borderColor", "#2e3445",
                "Button.default.background", "#5b7cfa",
                "Button.default.foreground", "#ffffff",
                "Hyperlink.linkColor", "#9db4ff"));
        FlatDarkLaf.setup();
        UIManager.put("Button.arc", 12);
        UIManager.put("Component.arc", 12);
    }

    /** The window's contents (separate so it can also be drawn to an image for checking). */
    public static JPanel content(String url, String version, Runnable openBrowser, Runnable quit, JButton[] openOut) {
            // Sizes are relative to the theme's font, which FlatLaf already scales for high-DPI screens.
            Font base = UIManager.getFont("Label.font");
            JLabel logo = new JLabel(new ImageIcon(Logo.image(Math.round(base.getSize2D() * 4.6f))));
            JLabel title = new JLabel("JavaLens is running");
            title.setFont(base.deriveFont(Font.BOLD, base.getSize2D() * 1.3f));

            JLabel link = new JLabel(url.replaceAll("/$", "")); // shown without the trailing slash
            link.setForeground(UIManager.getColor("Hyperlink.linkColor"));
            link.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            link.setToolTipText("Open in your browser");
            link.addMouseListener(new MouseAdapter() {
                @Override public void mouseClicked(MouseEvent e) { openBrowser.run(); }
            });

            JLabel note = new JLabel("Version " + version + "  ·  Closing this window quits JavaLens.");
            note.setForeground(UIManager.getColor("Label.disabledForeground"));
            note.setFont(base.deriveFont(base.getSize2D() * 0.88f));

            JPanel text = new JPanel();
            text.setOpaque(false);
            text.setBorder(BorderFactory.createEmptyBorder(0, 0, 0, 6)); // a little slack so nothing gets clipped
            text.setLayout(new BoxLayout(text, BoxLayout.Y_AXIS));
            text.add(title);
            text.add(Box.createVerticalStrut(4));
            text.add(link);
            text.add(Box.createVerticalStrut(10));
            text.add(note);

            JButton open = new JButton("Open JavaLens");
            open.setFont(open.getFont().deriveFont(Font.BOLD));
            open.addActionListener(e -> openBrowser.run());
            JButton quitBtn = new JButton("Quit");
            quitBtn.addActionListener(e -> quit.run());

            JPanel buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT, 8, 0));
            buttons.setOpaque(false);
            buttons.add(quitBtn);
            buttons.add(open);

            JPanel top = new JPanel(new BorderLayout(16, 0));
            top.setOpaque(false);
            top.add(logo, BorderLayout.WEST);
            top.add(text, BorderLayout.CENTER);

            JPanel root = new JPanel(new BorderLayout(0, 18));
            root.setBorder(BorderFactory.createEmptyBorder(22, 22, 18, 22));
            root.add(top, BorderLayout.CENTER);
            root.add(buttons, BorderLayout.SOUTH);
            openOut[0] = open;
            return root;
    }
}
