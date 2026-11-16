public class LinkedList {
    static class Node {
        int value;
        Node next;

        Node(int value) {
            this.value = value;
        }
    }

    public static void main(String[] args) {
        Node head = null;
        for (int i = 3; i >= 1; i--) {
            Node n = new Node(i);
            n.next = head;
            head = n;
        }
        Node cur = head;
        while (cur != null) {
            System.out.println(cur.value);
            cur = cur.next;
        }
    }
}
