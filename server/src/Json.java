import java.util.HashMap;
import java.util.Map;

/** Tiny JSON helpers so the server needs no external libraries. */
public final class Json {
    private Json() {}

    /** Quote and escape a string as a JSON string literal. */
    public static String str(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.append('"').toString();
    }

    /** Parse a flat JSON object whose values are strings, e.g. {"code":"...","stdin":"..."}. */
    public static Map<String, String> parseFlatObject(String json) {
        Map<String, String> out = new HashMap<>();
        int[] pos = {0};
        skipWs(json, pos);
        expect(json, pos, '{');
        skipWs(json, pos);
        if (peek(json, pos) == '}') return out;
        while (true) {
            skipWs(json, pos);
            String key = readString(json, pos);
            skipWs(json, pos);
            expect(json, pos, ':');
            skipWs(json, pos);
            String value;
            if (peek(json, pos) == '"') {
                value = readString(json, pos);
            } else { // number / true / false / null -> keep raw text
                int start = pos[0];
                while (pos[0] < json.length() && ",} \n\r\t".indexOf(json.charAt(pos[0])) < 0) pos[0]++;
                value = json.substring(start, pos[0]);
            }
            out.put(key, value);
            skipWs(json, pos);
            char c = json.charAt(pos[0]++);
            if (c == '}') return out;
            if (c != ',') throw new IllegalArgumentException("Expected , or } at " + (pos[0] - 1));
        }
    }

    private static char peek(String s, int[] pos) { return s.charAt(pos[0]); }

    private static void skipWs(String s, int[] pos) {
        while (pos[0] < s.length() && Character.isWhitespace(s.charAt(pos[0]))) pos[0]++;
    }

    private static void expect(String s, int[] pos, char c) {
        if (s.charAt(pos[0]) != c) throw new IllegalArgumentException("Expected '" + c + "' at " + pos[0]);
        pos[0]++;
    }

    private static String readString(String s, int[] pos) {
        expect(s, pos, '"');
        StringBuilder sb = new StringBuilder();
        while (true) {
            char c = s.charAt(pos[0]++);
            if (c == '"') return sb.toString();
            if (c != '\\') { sb.append(c); continue; }
            char e = s.charAt(pos[0]++);
            switch (e) {
                case 'n' -> sb.append('\n');
                case 'r' -> sb.append('\r');
                case 't' -> sb.append('\t');
                case 'b' -> sb.append('\b');
                case 'f' -> sb.append('\f');
                case 'u' -> {
                    sb.append((char) Integer.parseInt(s.substring(pos[0], pos[0] + 4), 16));
                    pos[0] += 4;
                }
                default -> sb.append(e); // \" \\ \/
            }
        }
    }
}
