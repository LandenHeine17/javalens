package javalens.tools;

import javalens.ui.Logo;

import javax.imageio.ImageIO;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Build-time tool (run by Gradle's `icons` task): draws the logo and writes the icon files
 * the installers need: icon.png (Linux), icon.ico (Windows) and icon.icns (macOS).
 * Both .ico and .icns can simply hold PNG images, so no image library is needed.
 */
public final class IconGen {
    public static void main(String[] args) throws IOException {
        Path out = Path.of(args.length > 0 ? args[0] : "build/icons");
        Files.createDirectories(out);
        Files.write(out.resolve("icon.png"), png(512));
        Files.write(out.resolve("icon.ico"), ico(16, 24, 32, 48, 64, 128, 256));
        Files.write(out.resolve("icon.icns"), icns());
        System.out.println("Icons written to " + out.toAbsolutePath());
    }

    private static byte[] png(int size) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ImageIO.write(Logo.image(size), "png", bytes);
        return bytes.toByteArray();
    }

    /** Windows .ico: a little directory followed by PNG images (little-endian numbers). */
    private static byte[] ico(int... sizes) throws IOException {
        List<byte[]> images = new ArrayList<>();
        for (int s : sizes) images.add(png(s));
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        writeLE16(bytes, 0);
        writeLE16(bytes, 1); // type: icon
        writeLE16(bytes, sizes.length);
        int offset = 6 + 16 * sizes.length;
        for (int i = 0; i < sizes.length; i++) {
            bytes.write(sizes[i] >= 256 ? 0 : sizes[i]); // width (0 means 256)
            bytes.write(sizes[i] >= 256 ? 0 : sizes[i]); // height
            bytes.write(0); // palette colors
            bytes.write(0); // reserved
            writeLE16(bytes, 1); // color planes
            writeLE16(bytes, 32); // bits per pixel
            writeLE32(bytes, images.get(i).length);
            writeLE32(bytes, offset);
            offset += images.get(i).length;
        }
        for (byte[] img : images) bytes.write(img);
        return bytes.toByteArray();
    }

    /** macOS .icns: "icns" + total length, then (type, length, PNG) entries (big-endian numbers). */
    private static byte[] icns() throws IOException {
        String[] types = {"ic07", "ic08", "ic09", "ic10"};
        int[] sizes = {128, 256, 512, 1024};
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(body);
        for (int i = 0; i < types.length; i++) {
            byte[] img = png(sizes[i]);
            d.writeBytes(types[i]);
            d.writeInt(8 + img.length);
            d.write(img);
        }
        ByteArrayOutputStream file = new ByteArrayOutputStream();
        DataOutputStream f = new DataOutputStream(file);
        f.writeBytes("icns");
        f.writeInt(8 + body.size());
        body.writeTo(f);
        return file.toByteArray();
    }

    private static void writeLE16(ByteArrayOutputStream o, int v) { o.write(v & 0xff); o.write((v >> 8) & 0xff); }

    private static void writeLE32(ByteArrayOutputStream o, int v) { writeLE16(o, v & 0xffff); writeLE16(o, (v >> 16) & 0xffff); }
}
