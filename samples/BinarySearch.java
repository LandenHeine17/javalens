import java.util.ArrayList;

public class BinarySearch {
    static int search(int[] arr, int target, int lo, int hi) {
        if (lo > hi) {
            return -1;
        }
        int mid = (lo + hi) / 2;
        if (arr[mid] == target) {
            return mid;
        } else if (arr[mid] < target) {
            return search(arr, target, mid + 1, hi);
        } else {
            return search(arr, target, lo, mid - 1);
        }
    }

    public static void main(String[] args) {
        int[] arr = {1, 3, 5, 7, 9, 11, 13};
        ArrayList<String> log = new ArrayList<>();
        int idx = search(arr, 11, 0, arr.length - 1);
        log.add("found at " + idx);
        System.out.println(log);
    }
}
