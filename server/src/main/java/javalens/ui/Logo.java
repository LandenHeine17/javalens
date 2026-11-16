package javalens.ui;

import java.awt.*;
import java.awt.geom.Path2D;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;

/**
 * The JavaLens logo, drawn in code so every size is crisp: a rounded square with the app's
 * blue-to-green gradient and a "stacked layers" mark (the same mark as the web page's header).
 * Used for the control window and, via IconGen, for the installer icons.
 */
public final class Logo {
    private Logo() {}

    public static BufferedImage image(int size) {
        BufferedImage img = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = img.createGraphics();
        paint(g, size);
        g.dispose();
        return img;
    }

    public static void paint(Graphics2D g, int size) {
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);

        float pad = size * 0.04f; // a little margin so OS icon masks don't clip the corners
        float s = size - 2 * pad;
        g.setPaint(new LinearGradientPaint(pad, pad, pad + s, pad + s,
                new float[]{0f, 0.55f, 1f},
                new Color[]{new Color(0x9db4ff), new Color(0x5b7cfa), new Color(0x4ade9b)}));
        g.fill(new RoundRectangle2D.Float(pad, pad, s, s, s * 0.45f, s * 0.45f));

        // The mark lives on a 24-unit grid (like the web icon) scaled into the middle 60%.
        float unit = s * 0.6f / 24f;
        float ox = pad + s * 0.2f, oy = pad + s * 0.2f;
        g.setColor(new Color(0x0a0f24));
        g.setStroke(new BasicStroke(Math.max(1.2f, 2.1f * unit), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        g.draw(poly(ox, oy, unit, true, 12, 2.5f, 2.5f, 7, 12, 11.5f, 21.5f, 7));
        g.draw(poly(ox, oy, unit, false, 2.5f, 12, 12, 16.5f, 21.5f, 12));
        g.draw(poly(ox, oy, unit, false, 2.5f, 17, 12, 21.5f, 21.5f, 17));
    }

    private static Shape poly(float ox, float oy, float unit, boolean closed, float... xy) {
        Path2D.Float p = new Path2D.Float();
        p.moveTo(ox + xy[0] * unit, oy + xy[1] * unit);
        for (int i = 2; i < xy.length; i += 2) p.lineTo(ox + xy[i] * unit, oy + xy[i + 1] * unit);
        if (closed) p.closePath();
        return p;
    }
}
