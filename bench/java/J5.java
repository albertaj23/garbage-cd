/** J5 mirrors W7: one hub referenced by 100,000 objects that are unrooted ten percent at a time. */
public class J5 {
    static final class Node { Node hub; }
    static Node hub = new Node();
    static final Node[] referrers = new Node[100_000];

    public static void main(String[] args) {
        for (int i = 0; i < referrers.length; i++) {
            Node node = new Node();
            node.hub = hub;
            referrers[i] = node;
        }
        hub = null;
        System.gc();
        int step = referrers.length / 10;
        for (int start = 0; start < referrers.length; start += step) {
            for (int i = start; i < Math.min(referrers.length, start + step); i++) referrers[i] = null;
            System.gc();
        }
        System.out.println("J5 done");
    }
}
