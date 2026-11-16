public class BubbleSort {
    public static void main(String[] args) {
        int[] nums = {5, 2, 9, 1, 6};
        for (int i = 0; i < nums.length - 1; i++) {
            for (int j = 0; j < nums.length - 1 - i; j++) {
                if (nums[j] > nums[j + 1]) {
                    int temp = nums[j];
                    nums[j] = nums[j + 1];
                    nums[j + 1] = temp;
                }
            }
        }
        for (int n : nums) {
            System.out.print(n + " ");
        }
        System.out.println();
    }
}
