package javalens;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/** Autocomplete, hover and parameter hints. `|` marks the cursor in each snippet. */
class AssistTest {

    static final String PROGRAM = """
            import java.util.*;
            public class Main {
                static int square(int x) { return x * x; }
                public static void main(String[] args) {
                    String name = "Ada";
                    ArrayList<String> list = new ArrayList<>();
                    int[] nums = {1, 2, 3};
            %s
                    System.out.println(name);
                }
            }""";

    interface Call { String apply(String code, int line, int col); }

    static String at(Call fn, String body) {
        String code = PROGRAM.formatted(body);
        int i = code.indexOf('|');
        String src = code.substring(0, i) + code.substring(i + 1);
        String before = src.substring(0, i);
        int line = (int) before.chars().filter(c -> c == '\n').count() + 1;
        int col = i - (before.lastIndexOf('\n') + 1) + 1;
        return fn.apply(src, line, col);
    }

    @Test
    void membersOfAStringWhenTheNextLineIsAnotherStatement() {
        String json = at(Assist::complete, "        name.toU|");
        assertTrue(json.contains("\"label\":\"toUpperCase\""), json);
    }

    @Test
    void genericTypesAreFilledIn() {
        assertTrue(at(Assist::complete, "        list.|").contains("String get(int)"));
    }

    @Test
    void staticMembersAfterAClassName() {
        String json = at(Assist::complete, "        int m = Math.|");
        assertTrue(json.contains("\"label\":\"max\""));
        assertFalse(json.contains("\"label\":\"equals\"")); // instance methods don't belong here
    }

    @Test
    void scopeHasLocalsMethodsAndAutoImports() {
        String json = at(Assist::complete, "        |");
        assertTrue(json.contains("\"label\":\"nums\""));
        assertTrue(json.contains("\"label\":\"square\""));
        assertTrue(json.contains("\"label\":\"String\""));
    }

    @Test
    void nothingInsideStrings() {
        assertEquals("{\"items\":[]}", at(Assist::complete, "        String s = \"na|\";"));
    }

    @Test
    void parameterHintsForOverloads() {
        String json = at(Assist::signature, "        int m = Math.max(3, |");
        assertTrue(json.contains("int max(int, int)"));
        assertTrue(json.contains("\"activeParameter\":1"));
    }

    @Test
    void hoverShowsTheType() {
        assertTrue(at(Assist::hover, "        name.len|gth();").contains("int length()"));
    }
}
