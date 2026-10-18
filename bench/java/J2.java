/** J2 mirrors W2: a 100,000-node linked list built, collected while live, dropped, collected; 20 rounds. */
public class J2 {
    static final class Node { Node next; }
    static Node head;

    public static void main(String[] args) {
        for (int round = 0; round < 20; round++) {
            Node previous = new Node();
            head = previous;
            for (int i = 1; i < 100_000; i++) {
                Node current = new Node();
                previous.next = current;
                previous = current;
            }
            System.gc();
            head = null;
            System.gc();
        }
        System.out.println("J2 done");
    }
}
