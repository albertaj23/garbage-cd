public class Cycle {
    private static final class Node {
        Node next;
    }

    public static void main(String[] args) {
        Node left = new Node();
        Node right = new Node();
        left.next = right;
        right.next = left;
        left = null;
        right = null;
        System.gc();
        System.out.println("cycle created");
    }
}
