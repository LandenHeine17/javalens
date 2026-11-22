package javalens;

import org.junit.jupiter.api.Test;

import static javalens.TracerTest.stdoutOf;
import static javalens.TracerTest.trace;
import static org.junit.jupiter.api.Assertions.*;

/** Newer Java features trace with the names a student would write, and without JVM-generated noise. */
class ModernJavaTest {

    static final String RECORDS = """
            public class Records {
                record Point(int x, int y) {
                    Point { if (x < 0) throw new IllegalArgumentException(); }
                    int sum() { return x + y; }
                }
                enum Color { RED, GREEN; Color next() { return values()[(ordinal() + 1) % 2]; } }
                sealed interface Shape permits Circle, Square {}
                record Circle(double r) implements Shape {}
                record Square(double side) implements Shape {}
                static double area(Shape s) {
                    return switch (s) {
                        case Circle c -> Math.PI * c.r() * c.r();
                        case Square q -> q.side() * q.side();
                    };
                }
                public static void main(String[] args) {
                    var p = new Point(1, 2);
                    int s = p.sum();
                    Color c = Color.RED;
                    Color d = c.next();
                    Shape sh = new Square(3);
                    double a = area(sh);
                    System.out.println(s + " " + d + " " + a);
                }
            }
            """;

    static final String LAMBDAS = """
            import java.util.*;
            import java.util.function.*;
            public class Lambdas {
                interface Greeter { String greet(String n); default String hi() { return greet("hi"); } }
                class Inner { int k = 5; int twice() { return k * 2; } }
                public static void main(String[] args) {
                    Function<Integer, Integer> sq = x -> x * x;
                    int nine = sq.apply(3);
                    List<Integer> xs = List.of(3, 1, 2);
                    int total = xs.stream().map(x -> x + 1).reduce(0, Integer::sum);
                    Runnable r = new Runnable() { public void run() { System.out.println("anon"); } };
                    r.run();
                    Greeter g = n -> n + "!";
                    String h = g.hi();
                    Inner in = new Lambdas().new Inner();
                    int t = in.twice();
                    String block = \"""
                        text
                        block\""";
                    System.out.println(nine + " " + total + " " + h + " " + t + " " + block.length());
                }
            }
            """;

    static final String ENUMS = """
            public class Enums {
                enum Planet {
                    MERCURY(3.3e23), EARTH(5.97e24);
                    final double mass;
                    Planet(double mass) { this.mass = mass; }
                }
                enum Op { ADD { int apply(int a, int b) { return a + b; } }; abstract int apply(int a, int b); }
                enum Day { MON, TUE }
                public static void main(String[] args) {
                    Planet p = Planet.EARTH;
                    Day d = Day.TUE;
                    String kind = switch (d) { case MON -> "start"; case TUE -> "second"; };
                    int s = Op.ADD.apply(2, 3);
                    class Helper { int twice(int x) { return 2 * x; } }
                    int t = new Helper().twice(s);
                    System.out.println(p + " " + kind + " " + s + " " + t);
                }
            }
            """;

    /** Classes and methods the JVM generates at run time, and code without line numbers, never show. */
    static void noGeneratedCode(String json) {
        assertFalse(json.contains("$$Lambda") || json.contains("Lambda/0x"), "lambda classes");
        assertFalse(json.contains("TypeSwitch"), "pattern-switch classes");
        assertFalse(json.contains("\"line\":-1"), "steps without a line");
        assertFalse(json.contains("<init>") || json.contains("<clinit>") || json.contains("lambda$"), "raw method names");
    }

    @Test
    void recordsSealedTypesAndPatternSwitches() throws Exception {
        String json = trace(RECORDS, "");
        assertTrue(json.contains("\"end\":\"finished\""));
        assertEquals("\"3 GREEN 9.0\\n\"", stdoutOf(json));
        assertTrue(json.contains("{\"kind\":\"object\",\"type\":\"Point\",\"fields\":[{\"name\":\"x\",\"type\":\"int\",\"final\":true"), "record components");
        assertTrue(json.contains("\"method\":\"area\""));
        noGeneratedCode(json);
    }

    @Test
    void enumConstantsReadLikeCode() throws Exception {
        String json = trace(ENUMS, "");
        assertEquals("\"EARTH second 5 10\\n\"", stdoutOf(json));
        assertTrue(json.contains("\"name\":\"d\",\"type\":\"Day\",\"v\":{\"k\":\"p\",\"v\":\"Day.TUE\"}"), "a plain enum is a value");
        assertTrue(json.contains("\"type\":\"Planet.EARTH\",\"fields\":[{\"name\":\"mass\""), "an enum with fields is an object named after its constant");
        assertFalse(json.contains("\"name\":\"ordinal\""), "java.lang.Enum's internals are hidden");
        assertTrue(json.contains("\"name\":\"this\",\"type\":\"Op\",\"v\":{\"k\":\"p\",\"v\":\"Op.ADD\"}"), "a constant with a body");
        assertTrue(json.contains("\"method\":\"static init\""));
        assertTrue(json.contains("\"method\":\"new Helper\""), "a class declared inside a method");
        assertFalse(json.contains("\"method\":\"values\""), "javac's values() isn't stepped into");
        noGeneratedCode(json);
    }

    @Test
    void lambdasStreamsAnonymousAndInnerClasses() throws Exception {
        String json = trace(LAMBDAS, "");
        assertEquals("\"anon\\n9 9 hi! 10 10\\n\"", stdoutOf(json));
        assertTrue(json.contains("\"method\":\"lambda in main\""), "a lambda's body is a frame");
        assertTrue(json.contains("\"ret\":{\"k\":\"p\",\"v\":\"4\"}"), "a lambda called by a stream returns its value");
        assertTrue(json.contains("{\"kind\":\"opaque\",\"type\":\"lambda\"}"), "a lambda object");
        assertTrue(json.contains("\"method\":\"new anonymous Runnable\""));
        assertTrue(json.contains("\"method\":\"hi\""), "a default method");
        assertTrue(json.contains("\"method\":\"twice\""), "an inner class's method");
        noGeneratedCode(json);
    }
}
