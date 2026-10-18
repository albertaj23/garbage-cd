/** J4 mirrors W4: 10,000 cycles of length 2-5; unroot half, collect, unroot the rest, collect. */
public class J4 {
    static final class Node { Node next; }
    static final Node[] roots = new Node[10_000];
    static long state = 0x9E3779B97F4A7C15L;

    static int next(int bound) {
        state ^= state << 13; state ^= state >>> 7; state ^= state << 17;
        return (int) ((state >>> 1) % bound);
    }

    public static void main(String[] args) {
        for (int i = 0; i < roots.length; i++) {
            int length = 2 + next(4);
            Node first = new Node();
            Node previous = first;
            for (int k = 1; k < length; k++) { Node node = new Node(); previous.next = node; previous = node; }
            previous.next = first;
            roots[i] = first;
        }
        System.gc();
        for (int i = 0; i < roots.length; i += 2) roots[i] = null;
        System.gc();
        for (int i = 1; i < roots.length; i += 2) roots[i] = null;
        System.gc();
        System.out.println("J4 done");
    }
}
