public class GridPaths {
    // How many ways can a robot walk from the top-left corner of a grid to the bottom-right,
    // moving only right or down? Each cell adds up the ways in from above and from the left.
    public static void main(String[] args) {
        int rows = 3, cols = 4;
        int[][] ways = new int[rows][cols];
        for (int i = 0; i < rows; i++) {
            for (int j = 0; j < cols; j++) {
                if (i == 0 || j == 0) {
                    ways[i][j] = 1;
                } else {
                    ways[i][j] = ways[i - 1][j] + ways[i][j - 1];
                }
            }
        }
        System.out.println(ways[rows - 1][cols - 1] + " paths");
    }
}
