package gcd.analyzer;

import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LabeledStatementTree;
import com.sun.source.tree.BreakTree;
import com.sun.source.tree.ContinueTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.ModifiersTree;
import com.sun.source.tree.PrimitiveTypeTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TypeParameterTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreeScanner;
import com.sun.source.util.Trees;
import com.sun.source.util.JavacTask;
import com.sun.source.tree.LineMap;
import gcd.json.Json;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Converts a javac syntax tree into the D.5 AstNode JSON with a breadth-first node cap. */
final class AstBuilder {
    static final int NODE_CAP = 5_000;
    private static final int LABEL_LIMIT = 80;
    private static final long NOPOS = -1L;

    private static final class Node {
        final String kind;
        final String label;
        final long start;
        final long end;
        final List<Node> children = new ArrayList<>();
        boolean keep;
        int id;

        Node(String kind, String label, long start, long end) {
            this.kind = kind;
            this.label = label;
            this.start = start;
            this.end = end;
        }
    }

    static final class Result {
        final String json;
        final int nodeCount;
        final boolean truncated;

        Result(String json, int nodeCount, boolean truncated) {
            this.json = json;
            this.nodeCount = nodeCount;
            this.truncated = truncated;
        }
    }

    private final CompilationUnitTree unit;
    private final SourcePositions positions;
    private final LineMap lineMap;
    private final int sourceLength;
    private int total;

    private AstBuilder(CompilationUnitTree unit, SourcePositions positions, int sourceLength) {
        this.unit = unit;
        this.positions = positions;
        this.lineMap = unit.getLineMap();
        this.sourceLength = sourceLength;
    }

    static Result build(JavacTask task, CompilationUnitTree unit, int sourceLength) {
        SourcePositions positions = Trees.instance(task).getSourcePositions();
        AstBuilder builder = new AstBuilder(unit, positions, sourceLength);
        Node root = builder.scanTree();
        return builder.serialize(root);
    }

    private Node scanTree() {
        final Node[] holder = new Node[1];
        final ArrayDeque<Node> stack = new ArrayDeque<>();
        new TreeScanner<Void, Void>() {
            @Override
            public Void scan(Tree tree, Void unused) {
                if (tree == null) {
                    return null;
                }
                Node node = new Node(tree.getKind().name(), label(tree),
                        positions.getStartPosition(unit, tree), positions.getEndPosition(unit, tree));
                total++;
                if (stack.isEmpty()) {
                    holder[0] = node;
                } else {
                    stack.peek().children.add(node);
                }
                stack.push(node);
                try {
                    return super.scan(tree, unused);
                } finally {
                    stack.pop();
                }
            }
        }.scan(unit, null);
        return holder[0];
    }

    private Result serialize(Node root) {
        int kept = 0;
        ArrayDeque<Node> queue = new ArrayDeque<>();
        queue.add(root);
        while (!queue.isEmpty() && kept < NODE_CAP) {
            Node node = queue.poll();
            node.keep = true;
            kept++;
            queue.addAll(node.children);
        }
        StringBuilder json = new StringBuilder();
        int[] nextId = {0};
        write(root, json, nextId);
        return new Result(json.toString(), kept, total > kept);
    }

    private void write(Node node, StringBuilder out, int[] nextId) {
        node.id = nextId[0]++;
        out.append("{\"id\":").append(node.id).append(",\"kind\":").append(Json.quote(node.kind));
        if (node.label != null) {
            out.append(",\"label\":").append(Json.quote(node.label));
        }
        boolean hasSpan = node.start != NOPOS && node.end != NOPOS
                && node.start >= 0 && node.end >= node.start && node.end <= sourceLength;
        if (hasSpan) {
            out.append(",\"span\":{\"start\":").append(node.start)
                    .append(",\"end\":").append(node.end)
                    .append(",\"line\":").append(lineMap.getLineNumber(node.start))
                    .append(",\"column\":").append(lineMap.getColumnNumber(node.start))
                    .append(",\"endLine\":").append(lineMap.getLineNumber(node.end))
                    .append(",\"endColumn\":").append(lineMap.getColumnNumber(node.end))
                    .append(",\"provenance\":\"compiler\"}");
        } else {
            out.append(",\"synthetic\":true");
        }
        out.append(",\"children\":[");
        boolean first = true;
        for (Node child : node.children) {
            if (!child.keep) {
                continue;
            }
            if (!first) {
                out.append(',');
            }
            first = false;
            write(child, out, nextId);
        }
        out.append("]}");
    }

    private static String label(Tree tree) {
        String value = null;
        switch (tree.getKind()) {
            case IDENTIFIER:
                value = ((IdentifierTree) tree).getName().toString();
                break;
            case MEMBER_SELECT:
                value = ((MemberSelectTree) tree).getIdentifier().toString();
                break;
            case CLASS:
            case INTERFACE:
            case ENUM:
            case RECORD:
            case ANNOTATION_TYPE:
                value = ((ClassTree) tree).getSimpleName().toString();
                break;
            case METHOD:
                value = ((MethodTree) tree).getName().toString();
                break;
            case VARIABLE:
                value = ((VariableTree) tree).getName().toString();
                break;
            case TYPE_PARAMETER:
                value = ((TypeParameterTree) tree).getName().toString();
                break;
            case PRIMITIVE_TYPE:
                value = ((PrimitiveTypeTree) tree).getPrimitiveTypeKind().name().toLowerCase(Locale.ROOT);
                break;
            case MODIFIERS:
                value = ((ModifiersTree) tree).getFlags().toString();
                break;
            case LABELED_STATEMENT:
                value = ((LabeledStatementTree) tree).getLabel().toString();
                break;
            case BREAK:
                value = ((BreakTree) tree).getLabel() == null ? null : ((BreakTree) tree).getLabel().toString();
                break;
            case CONTINUE:
                value = ((ContinueTree) tree).getLabel() == null ? null : ((ContinueTree) tree).getLabel().toString();
                break;
            case INT_LITERAL:
            case LONG_LITERAL:
            case FLOAT_LITERAL:
            case DOUBLE_LITERAL:
            case BOOLEAN_LITERAL:
            case CHAR_LITERAL:
            case STRING_LITERAL:
            case NULL_LITERAL:
                value = String.valueOf(((LiteralTree) tree).getValue());
                break;
            default:
                break;
        }
        return value == null ? null : truncate(value);
    }

    private static String truncate(String value) {
        if (value.length() <= LABEL_LIMIT) {
            return value;
        }
        int end = LABEL_LIMIT;
        if (Character.isHighSurrogate(value.charAt(end - 1))) {
            end--;
        }
        return value.substring(0, end);
    }
}
