public class BigO {
    // Open the "Growth" tab: JavaLens re-runs this with n = 1..20
    // (the @vary comment below) and charts how many lines run.
    public static void main(String[] args) {
        int n = 8; // @vary 1..20
        int count = 0;
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) {
                count++;
            }
        }
        System.out.println(n + " -> " + count);
    }
}
