public class LinkedList {
    private static final class Node {
        Node next;
    }

    public static void main(String[] args) {
        Node head = null;
        for (int i = 0; i < 20_000; i++) {
            Node node = new Node();
            node.next = head;
            head = node;
        }
        System.out.println(head == null ? "empty" : "list built");
    }
}
