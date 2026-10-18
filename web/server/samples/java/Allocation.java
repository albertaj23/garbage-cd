public class Allocation {
    public static void main(String[] args) {
        byte[][] values = new byte[2_000][];
        for (int i = 0; i < values.length; i++) {
            values[i] = new byte[1_024];
        }
        System.out.println("allocated " + values.length + " arrays");
    }
}
