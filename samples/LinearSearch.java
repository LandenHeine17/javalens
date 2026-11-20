public class LinearSearch {
    static int search(int[] arr, int target) {
        for (int i = 0; i < arr.length; i++) {
            if (arr[i] == target) {
                return i;
            }
        }
        return -1;
    }

    public static void main(String[] args) {
        int[] arr = {38, 27, 43, 3, 9, 82, 10, 19};
        int target = 82;
        int idx = search(arr, target);
        System.out.println(target + " found at index " + idx);
    }
}
