public class Exceptions {
    // Throws when the text isn't a valid age. Integer.parseInt throws for "abc";
    // we throw ourselves for a negative number.
    static int parseAge(String text) {
        int age = Integer.parseInt(text);
        if (age < 0) {
            throw new IllegalArgumentException("age can't be negative: " + age);
        }
        return age;
    }

    // finally runs whether parseAge returns or throws.
    static int checkedAge(String text) {
        try {
            return parseAge(text);
        } finally {
            System.out.println("checked " + text);
        }
    }

    public static void main(String[] args) {
        String[] inputs = {"42", "abc", "-5"};
        for (String text : inputs) {
            try {
                int age = checkedAge(text);
                System.out.println("age " + age);
            } catch (NumberFormatException e) {
                System.out.println("not a number: " + text);
            } catch (IllegalArgumentException e) {
                System.out.println(e.getMessage());
            }
        }
        int[] scores = new int[3];
        scores[3] = 100; // nothing catches this one: the program stops here
    }
}
