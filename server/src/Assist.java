import com.sun.source.tree.*;
import com.sun.source.util.*;

import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.*;
import java.net.URI;
import java.util.*;

/**
 * Editor help (autocomplete, hover, parameter hints) powered by the JDK's own compiler.
 *
 * The trick: replace the word under the cursor with a placeholder identifier ("hole"), let javac
 * parse and type-check the whole file (it recovers from the resulting errors), then ask javac
 * what it knows at the hole: e.g. for `name.__jl` "what is the type of `name`?", for a bare
 * `__jl` "which variables, methods and classes are in scope here?".
 */
public final class Assist {
    private static final String HOLE = "__jl";
    private static final int MAX_ITEMS = 400;
    private static final JavaCompiler JAVAC = ToolProvider.getSystemJavaCompiler();
    // Reusing one file manager makes repeat requests much faster. It isn't thread-safe, hence the lock.
    private static final StandardJavaFileManager FILES = JAVAC.getStandardFileManager(null, null, null);
    private static final Object LOCK = new Object();

    /** Common classes outside java.lang that we offer even when not imported (and add the import). */
    private static final List<String> AUTO_IMPORT = List.of(
            "java.util.Scanner", "java.util.ArrayList", "java.util.List", "java.util.HashMap", "java.util.Map",
            "java.util.HashSet", "java.util.Set", "java.util.Arrays", "java.util.Collections", "java.util.Random",
            "java.util.LinkedList", "java.util.Queue", "java.util.Deque", "java.util.ArrayDeque", "java.util.Stack",
            "java.util.Iterator", "java.util.TreeMap", "java.util.TreeSet", "java.util.PriorityQueue",
            "java.util.Objects", "java.util.Optional", "java.util.LinkedHashMap", "java.util.Comparator");

    /** java.lang classes students actually use (the full package is huge and mostly noise). */
    private static final List<String> JAVA_LANG = List.of(
            "String", "Math", "Integer", "Double", "Character", "Boolean", "Long", "Float", "Short", "Byte",
            "System", "Object", "StringBuilder", "Exception", "RuntimeException", "IllegalArgumentException",
            "IllegalStateException", "ArithmeticException", "NullPointerException", "IndexOutOfBoundsException",
            "ArrayIndexOutOfBoundsException", "Comparable", "Iterable", "Thread", "Record", "Enum", "IO");

    /** Object methods that only matter for threads; they just clutter a beginner's list. */
    private static final Set<String> HIDDEN = Set.of("wait", "notify", "notifyAll");

    private record Analysis(CompilationUnitTree unit, Trees trees, Elements elements, Types types) {}

    /** One thing we could suggest, before it's turned into JSON. */
    private record Candidate(String name, String kind, String detail, String insert, String sort,
                             String importName, Element element, ExecutableType execType) {}

    // ================================================================= public entry points

    /** Completion items for the cursor at (line, col), both 1-based like Monaco. */
    public static String complete(String code, int line, int col) {
        int offset = offsetOf(code, line, col);
        if (inCommentOrString(code, offset)) return "{\"items\":[]}";
        int start = offset;
        while (start > 0 && Character.isJavaIdentifierPart(code.charAt(start - 1))) start--;
        int end = offset;
        while (end < code.length() && Character.isJavaIdentifierPart(code.charAt(end))) end++;

        List<Candidate> items;
        synchronized (LOCK) {
            items = candidatesAt(code, start, end);
        }
        // Collapse overloads into one entry: "max(int, int)  +3 overloads".
        Map<String, List<Candidate>> byKey = new LinkedHashMap<>();
        for (Candidate c : items) byKey.computeIfAbsent(c.kind() + ":" + c.name(), k -> new ArrayList<>()).add(c);

        StringBuilder sb = new StringBuilder("{\"items\":[");
        int n = 0;
        for (List<Candidate> group : byKey.values()) {
            if (n >= MAX_ITEMS) break;
            Candidate c = group.get(0);
            String detail = c.detail() + (group.size() > 1 ? "  +" + (group.size() - 1) + " overload" + (group.size() > 2 ? "s" : "") : "");
            boolean anyParams = group.stream().anyMatch(g -> g.element() instanceof ExecutableElement ee && !ee.getParameters().isEmpty());
            String insert = c.insert();
            if (c.kind().equals("method") || c.kind().equals("constructor")) insert = c.name() + (anyParams ? "($0)" : "()");
            if (n++ > 0) sb.append(',');
            sb.append("{\"label\":").append(Json.str(c.name()))
              .append(",\"kind\":").append(Json.str(c.kind()))
              .append(",\"detail\":").append(Json.str(detail))
              .append(",\"insert\":").append(Json.str(insert))
              .append(",\"sort\":").append(Json.str(c.sort()));
            if (c.importName() != null) sb.append(",\"import\":").append(Json.str(c.importName()));
            sb.append('}');
        }
        return sb.append("]}").toString();
    }

    /** Hover text (Markdown) for the symbol at (line, col). */
    public static String hover(String code, int line, int col) {
        int offset = offsetOf(code, line, col);
        synchronized (LOCK) {
            Analysis a = analyze(code);
            TreePath path = deepestNameAt(a, offset);
            if (path == null) return "{\"text\":null}";
            Element el = a.trees().getElement(path);
            if (el == null) return "{\"text\":null}";
            StringBuilder md = new StringBuilder("```java\n").append(describe(el, a, path)).append("\n```");
            String where = whereText(el);
            if (where != null) md.append("\n\n").append(where);
            String doc = a.elements().getDocComment(el);
            if (doc != null && !doc.isBlank()) md.append("\n\n").append(doc.strip());
            return "{\"text\":" + Json.str(md.toString()) + "}";
        }
    }

    /** Parameter hints for the method call the cursor is inside of. */
    public static String signature(String code, int line, int col) {
        int offset = offsetOf(code, line, col);
        // Walk backwards to the unmatched '(' of the call we're in, counting top-level commas.
        int depth = 0, commas = 0, open = -1;
        for (int i = offset - 1; i >= 0; i--) {
            char ch = code.charAt(i);
            if (ch == ')' || ch == ']') depth++;
            else if (ch == '(' || ch == '[') {
                if (depth == 0) { open = i; break; }
                depth--;
            } else if (ch == ',' && depth == 0) commas++;
            else if ((ch == ';' || ch == '{' || ch == '}') && depth == 0) break;
        }
        if (open < 0 || code.charAt(open) != '(') return "{\"signatures\":[]}";
        int ne = open;
        while (ne > 0 && Character.isWhitespace(code.charAt(ne - 1))) ne--;
        int ns = ne;
        while (ns > 0 && Character.isJavaIdentifierPart(code.charAt(ns - 1))) ns--;
        if (ns == ne) return "{\"signatures\":[]}";
        String name = code.substring(ns, ne);
        boolean isNew = code.substring(0, ns).stripTrailing().endsWith("new");

        List<Candidate> cands;
        synchronized (LOCK) {
            cands = candidatesAt(code, ns, ne);
        }
        List<ExecutableElement> methods = new ArrayList<>();
        List<ExecutableType> execTypes = new ArrayList<>();
        for (Candidate c : cands) {
            if (!c.name().equals(name)) continue;
            if (isNew && c.element() instanceof TypeElement te) {
                for (Element m : te.getEnclosedElements()) {
                    if (m.getKind() == ElementKind.CONSTRUCTOR && !m.getModifiers().contains(Modifier.PRIVATE)) {
                        methods.add((ExecutableElement) m);
                        execTypes.add(null);
                    }
                }
            } else if (!isNew && c.element() instanceof ExecutableElement ee) {
                methods.add(ee);
                execTypes.add(c.execType());
            }
        }
        StringBuilder sb = new StringBuilder("{\"activeParameter\":").append(commas).append(",\"signatures\":[");
        // Which overload to highlight: with empty parens prefer the no-argument one,
        // otherwise the first one with enough parameters for the commas typed so far.
        boolean noArgsYet = code.substring(open + 1, offset).isBlank();
        int active = -1;
        for (int i = 0; i < methods.size() && active < 0; i++)
            if (noArgsYet && methods.get(i).getParameters().isEmpty()) active = i;
        for (int i = 0; i < methods.size() && active < 0; i++)
            if (methods.get(i).getParameters().size() > commas || methods.get(i).isVarArgs()) active = i;
        if (active < 0) active = 0;
        for (int i = 0; i < methods.size(); i++) {
            ExecutableElement m = methods.get(i);
            List<String> params = paramStrings(m, execTypes.get(i));
            String ret = m.getKind() == ElementKind.CONSTRUCTOR ? ""
                    : shorten(execTypes.get(i) != null ? execTypes.get(i).getReturnType().toString() : m.getReturnType().toString()) + " ";
            String label = ret + (isNew ? "new " : "") + name + "(" + String.join(", ", params) + ")";
            if (i > 0) sb.append(',');
            sb.append("{\"label\":").append(Json.str(label)).append(",\"params\":[");
            for (int p = 0; p < params.size(); p++) {
                if (p > 0) sb.append(',');
                sb.append(Json.str(params.get(p)));
            }
            sb.append("]}");
        }
        return sb.append("],\"activeSignature\":").append(active).append('}').toString();
    }

    // ================================================================= analysis

    private static Analysis analyze(String code) {
        JavaFileObject src = new SimpleJavaFileObject(URI.create("string:///" + Compiler.fileNameFor(code)), JavaFileObject.Kind.SOURCE) {
            @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return code; }
        };
        // should-stop: keep type-checking even though the code has errors (it always will: it contains the hole).
        List<String> options = List.of("-proc:none", "-Xlint:none", "-XDshould-stop.ifError=FLOW", "-XDshould-stop.ifNoError=FLOW");
        JavacTask task = (JavacTask) JAVAC.getTask(null, FILES, d -> { }, options, null, List.of(src));
        CompilationUnitTree unit;
        try {
            unit = task.parse().iterator().next();
            task.analyze();
        } catch (Exception | Error e) {
            // javac can throw on very broken input; completion just gets fewer results.
            throw new RuntimeException("analysis failed", e);
        }
        return new Analysis(unit, Trees.instance(task), task.getElements(), task.getTypes());
    }

    /** Puts the hole in place of code[start, end) and lists what fits there. */
    private static List<Candidate> candidatesAt(String code, int start, int end) {
        // If nothing follows on this line, end the statement here. Otherwise `msg.__jl` followed by a
        // next line `System.out.println(...)` reads as a declaration: type `msg.__jl`, variable `System`.
        int eol = code.indexOf('\n', end);
        boolean restBlank = code.substring(end, eol < 0 ? code.length() : eol).isBlank();
        String holed = code.substring(0, start) + HOLE + (restBlank ? ";" : "") + code.substring(end);
        Analysis a;
        try {
            a = analyze(holed);
        } catch (RuntimeException e) {
            return List.of();
        }
        TreePath hole = findHole(a);
        if (hole == null) return List.of();
        if (hole.getLeaf() instanceof MemberSelectTree ms) return memberCandidates(a, hole, ms);
        return scopeCandidates(a, hole, code);
    }

    private static TreePath findHole(Analysis a) {
        TreePath[] found = {null};
        new TreePathScanner<Void, Void>() {
            @Override public Void visitMemberSelect(MemberSelectTree t, Void v) {
                if (t.getIdentifier().contentEquals(HOLE)) found[0] = getCurrentPath();
                return super.visitMemberSelect(t, v);
            }
            @Override public Void visitIdentifier(IdentifierTree t, Void v) {
                if (t.getName().contentEquals(HOLE)) found[0] = getCurrentPath();
                return null;
            }
            @Override public Void visitErroneous(ErroneousTree t, Void v) {
                return scan(t.getErrorTrees(), v); // the hole often lives inside an error-recovery node
            }
        }.scan(a.unit(), null);
        return found[0];
    }

    // ----------------------------------------------------------------- `something.|`

    private static List<Candidate> memberCandidates(Analysis a, TreePath hole, MemberSelectTree ms) {
        TreePath exprPath = new TreePath(hole, ms.getExpression());
        Element exprEl = a.trees().getElement(exprPath);
        TypeMirror type = a.trees().getTypeMirror(exprPath);
        Scope scope = a.trees().getScope(hole);
        List<Candidate> out = new ArrayList<>();

        if (exprEl instanceof PackageElement pkg) { // e.g. `java.util.`
            for (Element e : pkg.getEnclosedElements()) {
                if (e.getModifiers().contains(Modifier.PUBLIC)) out.add(typeCandidate((TypeElement) e, "4", null));
            }
            return out;
        }
        if (type == null) return out;
        if (type.getKind() == TypeKind.TYPEVAR) type = ((TypeVariable) type).getUpperBound();
        if (type instanceof ArrayType) {
            out.add(new Candidate("length", "field", "int", "length", "0", null, null, null));
            type = a.elements().getTypeElement("java.lang.Object").asType();
        }
        if (!(type instanceof DeclaredType dt)) return out;

        // `Math.` or `Integer.` names a class -> static members; `name.` names a value -> instance members.
        boolean staticAccess = exprEl != null && (exprEl.getKind().isClass() || exprEl.getKind().isInterface());
        TypeElement te = (TypeElement) dt.asElement();
        if (staticAccess) out.add(new Candidate("class", "keyword", "Class<" + te.getSimpleName() + ">", "class", "9", null, null, null));

        for (Element m : a.elements().getAllMembers(te)) {
            ElementKind k = m.getKind();
            boolean isStatic = m.getModifiers().contains(Modifier.STATIC);
            if (k == ElementKind.CONSTRUCTOR || k == ElementKind.STATIC_INIT || k == ElementKind.INSTANCE_INIT) continue;
            if (staticAccess != isStatic && !(staticAccess && k == ElementKind.ENUM_CONSTANT)) continue;
            if (!staticAccess && (k.isClass() || k.isInterface())) continue;
            if (!a.trees().isAccessible(scope, m, dt)) continue;
            if (HIDDEN.contains(m.getSimpleName().toString())) continue;
            String owner = ((TypeElement) m.getEnclosingElement()).getQualifiedName().toString();
            String sort = owner.equals(te.getQualifiedName().toString()) ? "1" : owner.equals("java.lang.Object") ? "3" : "2";
            out.add(memberCandidate(m, dt, a, sort));
        }
        return out;
    }

    // ----------------------------------------------------------------- bare `|`

    private static List<Candidate> scopeCandidates(Analysis a, TreePath hole, String originalCode) {
        List<Candidate> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        Scope scope = a.trees().getScope(hole);
        boolean staticContext = isStaticContext(hole);

        // 1. local variables and parameters, innermost first
        // Skip a variable whose own declaration we're typing in: `int y = y...` makes no sense.
        Set<String> declaring = new HashSet<>();
        for (TreePath p = hole.getParentPath(); p != null; p = p.getParentPath()) {
            if (p.getLeaf() instanceof VariableTree vt) declaring.add(vt.getName().toString());
            if (p.getLeaf() instanceof MethodTree || p.getLeaf() instanceof ClassTree) break;
        }
        for (Scope s = scope; s != null; s = s.getEnclosingScope()) {
            for (Element e : s.getLocalElements()) {
                if (e.getSimpleName().contentEquals(HOLE)) continue;
                if (e.getKind() == ElementKind.LOCAL_VARIABLE && declaring.contains(e.getSimpleName().toString())) continue;
                if ((e.getKind() == ElementKind.LOCAL_VARIABLE || e.getKind() == ElementKind.PARAMETER
                        || e.getKind() == ElementKind.EXCEPTION_PARAMETER || e.getKind() == ElementKind.RESOURCE_VARIABLE
                        || e.getKind() == ElementKind.BINDING_VARIABLE) && seen.add("v:" + e.getSimpleName())) {
                    out.add(new Candidate(e.getSimpleName().toString(), "variable", shorten(e.asType().toString()),
                            e.getSimpleName().toString(), "0", null, e, null));
                }
            }
        }

        // 2. fields and methods of the enclosing classes (only static ones from a static method)
        for (TypeElement cls = scope.getEnclosingClass(); cls != null; cls = enclosingType(cls)) {
            DeclaredType dt = (DeclaredType) cls.asType();
            for (Element m : a.elements().getAllMembers(cls)) {
                ElementKind k = m.getKind();
                if (!(k == ElementKind.FIELD || k == ElementKind.METHOD || k == ElementKind.ENUM_CONSTANT)) continue;
                if (staticContext && !m.getModifiers().contains(Modifier.STATIC)) continue;
                if (!a.trees().isAccessible(scope, m, dt)) continue;
                String owner = ((TypeElement) m.getEnclosingElement()).getQualifiedName().toString();
                if (owner.equals("java.lang.Object") && (staticContext || HIDDEN.contains(m.getSimpleName().toString()))) continue;
                if (!seen.add(k + ":" + m.getSimpleName() + m.asType())) continue;
                out.add(memberCandidate(m, dt, a, owner.equals("java.lang.Object") ? "3" : "1"));
            }
            if (cls.getModifiers().contains(Modifier.STATIC)) staticContext = true;
        }

        // 3. classes: the student's own, nested ones, imported ones, then common library ones
        Set<String> types = new HashSet<>();
        for (Tree t : a.unit().getTypeDecls()) {
            Element e = a.trees().getElement(TreePath.getPath(a.unit(), t));
            if (e instanceof TypeElement te) addTypeTree(te, out, types);
        }
        for (ImportTree imp : a.unit().getImports()) {
            if (imp.isStatic()) continue;
            String q = imp.getQualifiedIdentifier().toString();
            if (q.endsWith(".*")) {
                PackageElement pkg = a.elements().getPackageElement(q.substring(0, q.length() - 2));
                if (pkg != null) for (Element e : pkg.getEnclosedElements())
                    if (e.getModifiers().contains(Modifier.PUBLIC) && types.add(e.getSimpleName().toString()))
                        out.add(typeCandidate((TypeElement) e, AUTO_IMPORT.contains(((TypeElement) e).getQualifiedName().toString()) ? "4" : "7", null));
            } else {
                TypeElement te = a.elements().getTypeElement(q);
                if (te != null && types.add(te.getSimpleName().toString())) out.add(typeCandidate(te, "4", null));
            }
        }
        for (String name : JAVA_LANG) {
            TypeElement te = a.elements().getTypeElement("java.lang." + name);
            if (te != null && types.add(name)) out.add(typeCandidate(te, "4", null));
        }
        for (String q : AUTO_IMPORT) {
            String simple = q.substring(q.lastIndexOf('.') + 1);
            TypeElement te = a.elements().getTypeElement(q);
            if (te != null && types.add(simple)) out.add(typeCandidate(te, "6", importNeeded(originalCode, q) ? q : null));
        }
        return out;
    }

    private static void addTypeTree(TypeElement te, List<Candidate> out, Set<String> types) {
        if (types.add(te.getSimpleName().toString())) out.add(typeCandidate(te, "1", null));
        for (Element e : te.getEnclosedElements()) if (e instanceof TypeElement inner) addTypeTree(inner, out, types);
    }

    private static TypeElement enclosingType(TypeElement te) {
        Element e = te.getEnclosingElement();
        while (e != null && !(e instanceof TypeElement)) e = e.getEnclosingElement();
        return (TypeElement) e;
    }

    private static boolean isStaticContext(TreePath path) {
        for (TreePath p = path; p != null; p = p.getParentPath()) {
            Tree leaf = p.getLeaf();
            if (leaf instanceof MethodTree mt) return mt.getModifiers().getFlags().contains(Modifier.STATIC);
            if (leaf instanceof VariableTree vt && p.getParentPath() != null && p.getParentPath().getLeaf() instanceof ClassTree)
                return vt.getModifiers().getFlags().contains(Modifier.STATIC); // field initializer
            if (leaf instanceof BlockTree bt && bt.isStatic()) return true;
            if (leaf instanceof ClassTree) return false;
        }
        return false;
    }

    private static boolean importNeeded(String code, String qualified) {
        String pkg = qualified.substring(0, qualified.lastIndexOf('.'));
        return !(code.contains("import " + qualified + ";") || code.contains("import " + pkg + ".*;"));
    }

    // ----------------------------------------------------------------- candidates

    private static Candidate typeCandidate(TypeElement te, String sort, String importName) {
        String kind = switch (te.getKind()) {
            case INTERFACE, ANNOTATION_TYPE -> "interface";
            case ENUM -> "enum";
            case RECORD -> "record";
            default -> "class";
        };
        String pkg = te.getEnclosingElement() instanceof PackageElement p ? p.getQualifiedName().toString() : "";
        String detail = (importName != null ? "auto-import " : "") + (pkg.isEmpty() ? kind : pkg);
        return new Candidate(te.getSimpleName().toString(), kind, detail, te.getSimpleName().toString(), sort, importName, te, null);
    }

    private static Candidate memberCandidate(Element m, DeclaredType owner, Analysis a, String sort) {
        String name = m.getSimpleName().toString();
        if (m instanceof ExecutableElement ee) {
            ExecutableType et = null;
            try { et = (ExecutableType) a.types().asMemberOf(owner, ee); } catch (IllegalArgumentException ignored) { }
            String ret = shorten((et != null ? et.getReturnType() : ee.getReturnType()).toString());
            String detail = ret + " " + name + "(" + String.join(", ", paramStrings(ee, et)) + ")";
            return new Candidate(name, "method", detail, name, sort, null, ee, et);
        }
        TypeMirror t;
        try { t = a.types().asMemberOf(owner, m); } catch (IllegalArgumentException e) { t = m.asType(); }
        String kind = m.getKind() == ElementKind.ENUM_CONSTANT ? "enum-member"
                : m.getModifiers().contains(Modifier.STATIC) && m.getModifiers().contains(Modifier.FINAL) ? "constant" : "field";
        return new Candidate(name, kind, shorten(t.toString()), name, sort, null, m, null);
    }

    /** "int a, String b", or just "int, String" when the library was compiled without parameter names. */
    private static List<String> paramStrings(ExecutableElement ee, ExecutableType et) {
        List<String> out = new ArrayList<>();
        List<? extends VariableElement> ps = ee.getParameters();
        for (int i = 0; i < ps.size(); i++) {
            TypeMirror t = et != null ? et.getParameterTypes().get(i) : ps.get(i).asType();
            String type = shorten(t.toString());
            if (ee.isVarArgs() && i == ps.size() - 1) type = type.replaceFirst("\\[]$", "...");
            String pname = ps.get(i).getSimpleName().toString();
            out.add(pname.matches("arg\\d+") ? type : type + " " + pname);
        }
        return out;
    }

    // ================================================================= hover helpers

    /** The most specific name (identifier, member, declaration) covering the offset. */
    private static TreePath deepestNameAt(Analysis a, int offset) {
        SourcePositions pos = a.trees().getSourcePositions();
        TreePath[] best = {null};
        long[] bestSize = {Long.MAX_VALUE};
        new TreePathScanner<Void, Void>() {
            @Override public Void scan(Tree tree, Void v) {
                if (tree == null) return null;
                long s = pos.getStartPosition(a.unit(), tree), e = pos.getEndPosition(a.unit(), tree);
                if (s >= 0 && e >= 0 && (offset < s || offset > e)) return null; // cursor isn't inside: skip subtree
                if (s >= 0 && e >= 0 && e - s < bestSize[0] && isNamed(tree)) {
                    TreePath p = new TreePath(getCurrentPath() == null ? new TreePath(a.unit()) : getCurrentPath(), tree);
                    if (nameCovers(tree, s, offset, a)) {
                        best[0] = p;
                        bestSize[0] = e - s;
                    }
                }
                return super.scan(tree, v);
            }
            @Override public Void visitErroneous(ErroneousTree t, Void v) { return scan(t.getErrorTrees(), v); }
        }.scan(a.unit(), null);
        return best[0];
    }

    private static boolean isNamed(Tree t) {
        return t instanceof IdentifierTree || t instanceof MemberSelectTree || t instanceof VariableTree
                || t instanceof MethodTree || t instanceof ClassTree || t instanceof NewClassTree;
    }

    /** For a declaration, only the name itself should trigger hover (not the whole method body). */
    private static boolean nameCovers(Tree t, long start, int offset, Analysis a) {
        if (t instanceof MemberSelectTree ms) {
            long exprEnd = a.trees().getSourcePositions().getEndPosition(a.unit(), ms.getExpression());
            return offset > exprEnd; // hovering `out` in System.out, not `System`
        }
        if (t instanceof MethodTree || t instanceof ClassTree || t instanceof VariableTree) {
            String src;
            try { src = a.unit().getSourceFile().getCharContent(true).toString(); } catch (Exception e) { return false; }
            String name = t instanceof MethodTree mt ? mt.getName().toString()
                    : t instanceof ClassTree ct ? ct.getSimpleName().toString() : ((VariableTree) t).getName().toString();
            int idx = src.indexOf(name, (int) start);
            return idx >= 0 && offset >= idx && offset <= idx + name.length();
        }
        return true;
    }

    private static String describe(Element el, Analysis a, TreePath path) {
        String mods = el.getModifiers().contains(Modifier.STATIC) ? "static " : "";
        return switch (el.getKind()) {
            case LOCAL_VARIABLE, PARAMETER, EXCEPTION_PARAMETER, RESOURCE_VARIABLE, BINDING_VARIABLE ->
                    shorten(a.trees().getTypeMirror(path) != null && path.getLeaf() instanceof IdentifierTree
                            ? a.trees().getTypeMirror(path).toString() : el.asType().toString()) + " " + el.getSimpleName();
            case FIELD, ENUM_CONSTANT -> mods + shorten(el.asType().toString()) + " " + el.getSimpleName();
            case METHOD -> {
                ExecutableElement ee = (ExecutableElement) el;
                yield mods + shorten(ee.getReturnType().toString()) + " " + ee.getSimpleName()
                        + "(" + String.join(", ", paramStrings(ee, null)) + ")";
            }
            case CONSTRUCTOR -> {
                ExecutableElement ee = (ExecutableElement) el;
                yield "new " + ee.getEnclosingElement().getSimpleName() + "(" + String.join(", ", paramStrings(ee, null)) + ")";
            }
            case CLASS, INTERFACE, ENUM, RECORD, ANNOTATION_TYPE ->
                    el.getKind().toString().toLowerCase(Locale.ROOT).replace("annotation_type", "@interface")
                            + " " + ((TypeElement) el).getQualifiedName();
            default -> el.toString();
        };
    }

    private static String whereText(Element el) {
        return switch (el.getKind()) {
            case LOCAL_VARIABLE -> "local variable";
            case PARAMETER -> "parameter";
            case FIELD, METHOD, CONSTRUCTOR, ENUM_CONSTANT -> {
                Element owner = el.getEnclosingElement();
                String kind = el.getKind() == ElementKind.FIELD ? "field" : el.getKind() == ElementKind.ENUM_CONSTANT ? "enum constant" : "method";
                if (el.getKind() == ElementKind.CONSTRUCTOR) kind = "constructor";
                yield kind + " in `" + (owner instanceof TypeElement te ? te.getQualifiedName() : owner) + "`";
            }
            default -> null;
        };
    }

    // ================================================================= text helpers

    /** java.util.List<java.lang.String> -> List<String> */
    static String shorten(String type) {
        return type.replaceAll("\\b(?:[a-z_][\\w]*\\.)+([A-Z][\\w$]*)", "$1").replace('$', '.');
    }

    private static int offsetOf(String code, int line, int col) {
        int offset = 0;
        for (int l = 1; l < line && offset < code.length(); l++) {
            int nl = code.indexOf('\n', offset);
            if (nl < 0) return code.length();
            offset = nl + 1;
        }
        return Math.min(code.length(), offset + Math.max(0, col - 1));
    }

    /** Rough check (good enough for completion): is the cursor inside a // comment, block comment or string? */
    private static boolean inCommentOrString(String code, int offset) {
        boolean inStr = false, inChar = false, inLine = false, inBlock = false;
        for (int i = 0; i < offset; i++) {
            char c = code.charAt(i);
            char next = i + 1 < code.length() ? code.charAt(i + 1) : 0;
            if (inLine) { if (c == '\n') inLine = false; continue; }
            if (inBlock) { if (c == '*' && next == '/') { inBlock = false; i++; } continue; }
            if (inStr) { if (c == '\\') i++; else if (c == '"' || c == '\n') inStr = false; continue; }
            if (inChar) { if (c == '\\') i++; else if (c == '\'' || c == '\n') inChar = false; continue; }
            if (c == '/' && next == '/') { inLine = true; i++; }
            else if (c == '/' && next == '*') { inBlock = true; i++; }
            else if (c == '"') inStr = true;
            else if (c == '\'') inChar = true;
        }
        return inStr || inChar || inLine || inBlock;
    }
}
