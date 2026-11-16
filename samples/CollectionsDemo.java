import java.util.*;

public class CollectionsDemo {
    public static void main(String[] args) {
        Stack<Integer> stack = new Stack<>();
        stack.push(1);
        stack.push(2);
        stack.push(3);
        int top = stack.pop();

        Queue<String> line = new ArrayDeque<>();
        line.add("Ana");
        line.add("Ben");
        line.add("Cy");
        String first = line.poll();

        Map<String, Integer> wordCounts = new HashMap<>();
        String[] words = {"to", "be", "or", "not", "to", "be"};
        for (String w : words) {
            wordCounts.put(w, wordCounts.getOrDefault(w, 0) + 1);
        }
        System.out.println(top + " " + first + " " + wordCounts);
    }
}
