/** J1 mirrors W1: churn with 1 % of allocations kept alive in a rooted ring; collect every 10,000 allocations. */
public class J1 {
    static final class Node { Node a; Node b; }
    static volatile Object sink;            // makes every allocation escape, so the JIT cannot remove it
    static final Node[] ring = new Node[1000];

    public static void main(String[] args) {
        int kept = 0;
        for (int i = 0; i < 1_000_000; i++) {
            Node node = new Node();
            sink = node;
            if (i % 100 == 0) ring[kept++ % 1000] = node;
            if ((i + 1) % 10_000 == 0) System.gc();
        }
        System.gc();
        System.out.println("J1 done " + ring.length);
    }
}
