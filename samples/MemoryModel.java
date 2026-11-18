public class MemoryModel {
    // Static fields belong to the class, not to any object: there is exactly one copy.
    static int count = 0;
    static final double RATE = 1.5;

    static class Point {
        final int x; // final: set once in the constructor, never changed
        int y;

        Point(int x, int y) {
            this.x = x;
            this.y = y;
            count++;
        }
    }

    static int area(final int w, int h) {
        int result = w * h;
        return result;
    }

    public static void main(String[] args) {
        final int size = 3;
        int[] nums = new int[size];
        nums[0] = 7;

        Point p = new Point(2, 4);
        Point q = p; // copies the reference, not the object
        q.y = 10;
        Point r = new Point(5, 6);

        String a = "hi";             // literal: lives in the string pool
        String b = new String("hi"); // a brand-new object on the heap
        String c = "hi";             // same literal, same pooled object as a
        System.out.println((a == b) + " " + (a == c) + " " + a.equals(b));

        int total = area(p.y, r.x) + count;
        System.out.println(total);
    }
}
