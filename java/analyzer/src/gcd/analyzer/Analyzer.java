package gcd.analyzer;

import com.sun.source.tree.ArrayTypeTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.ModifiersTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import gcd.json.Json;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import javax.lang.model.element.Modifier;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

public final class Analyzer {
    private Analyzer() {}

    private static final class SourceFile extends SimpleJavaFileObject {
        private final String source;

        SourceFile(String filename, String source) {
            super(URI.create("string:///" + filename), Kind.SOURCE);
            this.source = source;
        }

        @Override
        public CharSequence getCharContent(boolean ignoreEncodingErrors) {
            return source;
        }
    }

    private static final class Analysis {
        String mainClass;
        String publicTypeName;
        String packageName;
        AstBuilder.Result ast;
        CompilationUnitTree unit;
    }

    public static void main(String[] args) {
        final int[] exitCode = {0};
        // Deeply nested expressions recurse deeply in javac and the tree scanner.
        Thread worker = new Thread(null, () -> {
            try {
                exitCode[0] = run(args);
            } catch (Exception exception) {
                System.err.println("analyzer error: " + exception.getMessage());
                exitCode[0] = 4;
            }
        }, "analyzer", 256L * 1024 * 1024);
        worker.start();
        try {
            worker.join();
        } catch (InterruptedException exception) {
            exitCode[0] = 4;
        }
        if (exitCode[0] != 0) {
            System.exit(exitCode[0]);
        }
    }

    private static int run(String[] args) throws IOException {
        Path sourcePath = null;
        Path analysisPath = null;
        Path classesPath = null;
        boolean parseOnly = false;
        for (int i = 0; i < args.length; i++) {
            if ("--parse-only".equals(args[i])) {
                parseOnly = true;
            } else if (i + 1 < args.length && "--source".equals(args[i])) {
                sourcePath = Paths.get(args[++i]);
            } else if (i + 1 < args.length && "--analysis".equals(args[i])) {
                analysisPath = Paths.get(args[++i]);
            } else if (i + 1 < args.length && "--classes".equals(args[i])) {
                classesPath = Paths.get(args[++i]);
            } else {
                sourcePath = null;
                break;
            }
        }
        if (sourcePath == null || analysisPath == null || (classesPath == null && !parseOnly)) {
            System.err.println(
                    "usage: Analyzer --source <file> --analysis <file> (--classes <directory> | --parse-only)");
            return 3;
        }
        String source = Files.readString(sourcePath, StandardCharsets.UTF_8);
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            System.err.println("JDK compiler is unavailable");
            return 3;
        }

        long started = System.nanoTime();
        DiagnosticCollector<JavaFileObject> parseDiagnostics = new DiagnosticCollector<>();
        Analysis analysis = parse(compiler, source, parseDiagnostics);
        List<String> diagnostics = new ArrayList<>();
        boolean hasCompileError;
        boolean compiled = true;
        AstBuilder.Result ast = null;
        if (parseOnly) {
            for (Diagnostic<? extends JavaFileObject> diagnostic : parseDiagnostics.getDiagnostics()) {
                diagnostics.add(writeDiagnostic(diagnostic));
            }
            hasCompileError = parseDiagnostics.getDiagnostics().stream()
                    .anyMatch(diagnostic -> diagnostic.getKind() == Diagnostic.Kind.ERROR);
            ast = analysis.ast;
        } else {
            Files.createDirectories(classesPath);
            DiagnosticCollector<JavaFileObject> compileDiagnostics = new DiagnosticCollector<>();
            compiled = compile(compiler, source, analysis, classesPath, compileDiagnostics);
            for (Diagnostic<? extends JavaFileObject> diagnostic : compileDiagnostics.getDiagnostics()) {
                diagnostics.add(writeDiagnostic(diagnostic));
            }
            hasCompileError = compileDiagnostics.getDiagnostics().stream()
                    .anyMatch(diagnostic -> diagnostic.getKind() == Diagnostic.Kind.ERROR);
            ast = analysis.ast;
        }
        if (!hasCompileError && analysis.mainClass == null) {
            diagnostics.add("{\"severity\":\"error\",\"code\":\"NO_MAIN_METHOD\","
                    + "\"message\":\"no public static void main(String[] args) method found\"}");
        }
        if (ast != null && ast.truncated) {
            diagnostics.add("{\"severity\":\"note\",\"code\":\"AST_TRUNCATED\","
                    + "\"message\":\"AST truncated to " + AstBuilder.NODE_CAP + " nodes (breadth-first)\"}");
        }
        double compileMs = (System.nanoTime() - started) / 1_000_000.0;
        String status = hasCompileError || !compiled ? "compile_error"
                : analysis.mainClass == null ? "no_main" : "ok";
        writeResult(analysisPath, analysis, ast, diagnostics, compileMs, status);
        return 0;
    }

    private static Analysis parse(JavaCompiler compiler, String source,
                                  DiagnosticCollector<JavaFileObject> diagnostics) throws IOException {
        SourceFile sourceFile = new SourceFile("Submission.java", source);
        try (StandardJavaFileManager manager =
                     compiler.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(
                    null, manager, diagnostics, Arrays.asList("-proc:none", "-Xlint:all"),
                    null, Collections.singletonList(sourceFile));
            Analysis analysis = new Analysis();
            for (CompilationUnitTree unit : task.parse()) {
                analysis.unit = unit;
                analysis.ast = buildAst(task, unit, source.length());
                analysis.packageName =
                        unit.getPackageName() == null ? "" : unit.getPackageName().toString();
                for (Tree declaration : unit.getTypeDecls()) {
                    if (declaration instanceof ClassTree) {
                        ClassTree classTree = (ClassTree) declaration;
                        if (isPublic(classTree.getModifiers()) && analysis.publicTypeName == null) {
                            analysis.publicTypeName = classTree.getSimpleName().toString();
                        }
                        if (analysis.mainClass == null && hasMain(classTree)) {
                            String simpleName = classTree.getSimpleName().toString();
                            analysis.mainClass = analysis.packageName.isEmpty()
                                    ? simpleName : analysis.packageName + "." + simpleName;
                        }
                    }
                }
            }
            return analysis;
        }
    }

    private static boolean isPublic(ModifiersTree modifiers) {
        return modifiers.getFlags().contains(Modifier.PUBLIC);
    }

    private static boolean hasMain(ClassTree classTree) {
        for (Tree member : classTree.getMembers()) {
            if (!(member instanceof MethodTree)) {
                continue;
            }
            MethodTree method = (MethodTree) member;
            Set<Modifier> flags = method.getModifiers().getFlags();
            if (!"main".contentEquals(method.getName()) ||
                    !flags.containsAll(EnumSet.of(Modifier.PUBLIC, Modifier.STATIC)) ||
                    method.getReturnType() == null ||
                    !"void".equals(method.getReturnType().toString()) ||
                    method.getParameters().size() != 1) {
                continue;
            }
            VariableTree parameter = method.getParameters().get(0);
            if (parameter.getType() instanceof ArrayTypeTree) {
                String componentType =
                        ((ArrayTypeTree) parameter.getType()).getType().toString();
                if ("String".equals(componentType) || "java.lang.String".equals(componentType)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static AstBuilder.Result buildAst(JavacTask task, CompilationUnitTree unit, int length) {
        try {
            return AstBuilder.build(task, unit, length);
        } catch (StackOverflowError error) {
            return null;
        }
    }

    private static boolean compile(JavaCompiler compiler, String source, Analysis analysis,
                                   Path classesPath,
                                   DiagnosticCollector<JavaFileObject> diagnostics)
            throws IOException {
        String publicType = analysis.publicTypeName;
        String filename = publicType == null ? "Submission.java" : publicType + ".java";
        SourceFile sourceFile = new SourceFile(filename, source);
        try (StandardJavaFileManager manager =
                     compiler.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            manager.setLocationFromPaths(javax.tools.StandardLocation.CLASS_OUTPUT,
                                         Collections.singletonList(classesPath));
            JavacTask task = (JavacTask) compiler.getTask(
                    null, manager, diagnostics, Arrays.asList("-proc:none", "-Xlint:all"),
                    null, Collections.singletonList(sourceFile));
            try {
                Iterable<? extends CompilationUnitTree> units = task.parse();
                task.analyze();
                // Rebuild after attribution so synthetic members such as the implicit
                // default constructor are present; generate() may desugar the trees.
                for (CompilationUnitTree unit : units) {
                    AstBuilder.Result rebuilt = buildAst(task, unit, source.length());
                    if (rebuilt != null) {
                        analysis.ast = rebuilt;
                    }
                }
                task.generate();
            } catch (IOException exception) {
                throw exception;
            } catch (Exception exception) {
                if (diagnostics.getDiagnostics().stream()
                        .noneMatch(diagnostic -> diagnostic.getKind() == Diagnostic.Kind.ERROR)) {
                    throw new IOException("javac failed: " + exception.getMessage(), exception);
                }
            }
            return diagnostics.getDiagnostics().stream()
                    .noneMatch(diagnostic -> diagnostic.getKind() == Diagnostic.Kind.ERROR);
        }
    }

    private static String writeDiagnostic(Diagnostic<? extends JavaFileObject> diagnostic) {
        StringBuilder result = new StringBuilder("{\"severity\":");
        String severity = diagnostic.getKind() == Diagnostic.Kind.ERROR ? "error"
                : diagnostic.getKind() == Diagnostic.Kind.WARNING ||
                  diagnostic.getKind() == Diagnostic.Kind.MANDATORY_WARNING ? "warning" : "note";
        result.append(Json.quote(severity)).append(",\"code\":")
                .append(Json.quote(diagnostic.getCode())).append(",\"message\":")
                .append(Json.quote(diagnostic.getMessage(java.util.Locale.ROOT)));
        long line = diagnostic.getLineNumber();
        long column = diagnostic.getColumnNumber();
        if (line > 0 && column > 0) {
            result.append(",\"location\":{\"line\":").append(line)
                    .append(",\"column\":").append(column)
                    .append(",\"provenance\":\"compiler\"");
            if (diagnostic.getStartPosition() >= 0) {
                result.append(",\"startOffset\":").append(diagnostic.getStartPosition());
            }
            if (diagnostic.getEndPosition() >= 0) {
                result.append(",\"endOffset\":").append(diagnostic.getEndPosition());
            }
            result.append('}');
        }
        return result.append('}').toString();
    }

    private static void writeResult(Path path, Analysis analysis, AstBuilder.Result ast,
                                    List<String> diagnostics,
                                    double compileMs, String status) throws IOException {
        Files.createDirectories(path.getParent());
        Path temporary = path.resolveSibling(path.getFileName() + ".tmp");
        String mainClass = analysis.mainClass == null ? "null" : Json.quote(analysis.mainClass);
        String publicType = analysis.publicTypeName == null
                ? "null" : Json.quote(analysis.publicTypeName);
        String packageName = analysis.packageName == null || analysis.packageName.isEmpty()
                ? "null" : Json.quote(analysis.packageName);
        StringBuilder json = new StringBuilder();
        json.append("{\"status\":").append(Json.quote(status))
                .append(",\"mainClass\":").append(mainClass)
                .append(",\"publicTypeName\":").append(publicType)
                .append(",\"packageName\":").append(packageName)
                .append(",\"compileMs\":").append(compileMs)
                .append(",\"staticAnalysis\":{\"schema\":\"gcd.static-analysis/1\",")
                .append("\"language\":\"java\",\"ast\":")
                .append(ast == null ? "null" : ast.json)
                .append(",\"nodeCount\":").append(ast == null ? 0 : ast.nodeCount)
                .append(",\"truncated\":").append(ast != null && ast.truncated)
                .append(",\"diagnostics\":[")
                .append(String.join(",", diagnostics))
                .append("],\"java\":{\"mainClass\":").append(mainClass)
                .append(",\"publicTypeName\":").append(publicType)
                .append(",\"packageName\":").append(packageName)
                .append(",\"compileMs\":{\"value\":").append(compileMs)
                .append(",\"unit\":\"ms\",\"provenance\":\"measured\",")
                .append("\"source\":\"gcd-java-analyzer\"}}}}");
        Files.writeString(temporary, json.toString(), StandardCharsets.UTF_8);
        Files.move(temporary, path, java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                   java.nio.file.StandardCopyOption.ATOMIC_MOVE);
    }
}
