/** J3 mirrors W3: binary tree of depth 16; 20 rounds of replacing random subtrees, collecting each round. */
public class J3 {
    static final class Node { Node l; Node r; }
    static Node root;
    static long state = 0x2545F4914F6CDD1DL;

    static int next(int bound) {
        state ^= state << 13; state ^= state >>> 7; state ^= state << 17;
        return (int) ((state >>> 1) % bound);
    }

    static Node build(int levels) {
        Node node = new Node();
        if (levels > 1) { node.l = build(levels - 1); node.r = build(levels - 1); }
        return node;
    }

    public static void main(String[] args) {
        root = build(16);
        for (int round = 0; round < 20; round++) {
            for (int replacement = 0; replacement < 8; replacement++) {
                Node node = root;
                int walk = 3 + next(10);
                for (int step = 0; step < walk; step++) {
                    Node child = next(2) == 0 ? node.l : node.r;
                    if (child == null) break;
                    node = child;
                }
                if (next(2) == 0) node.l = build(8); else node.r = build(8);
            }
            System.gc();
        }
        System.out.println("J3 done");
    }
}
