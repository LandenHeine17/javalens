import com.sun.jdi.*;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.connect.LaunchingConnector;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Runs a compiled program in a separate JVM under the Java Debug Interface (JDI) and records
 * a snapshot of the stack, heap and output after every line. The browser replays these snapshots.
 */
public final class Tracer {
    public static final int MAX_STEPS = 3000;
    public static final long TIMEOUT_MS = 3000;
    private static final int MAX_HEAP_OBJECTS = 150;
    private static final int MAX_ARRAY_ITEMS = 100;
    private static final int MAX_FRAMES = 60;
    private static final int MAX_DEPTH = 150;        // deeper than this = probably a missing base case
    private static final int MAX_OUTPUT = 100_000;   // characters of program output kept
    private static final String[] EXCLUDED = {"java.*", "javax.*", "sun.*", "com.sun.*", "jdk.*"};

    // "Count mode" (used by the Big-O growth chart): no snapshots, just count executed lines, fast.
    public static final int COUNT_MAX_STEPS = 2_000_000;
    public static final long COUNT_TIMEOUT_MS = 4000;

    private final Compiler.Result compiled;
    private final String stdin;
    private final boolean countOnly;
    private long counted = 0;

    private final List<String> steps = new ArrayList<>();
    private final StringBuilder stdout = new StringBuilder();
    private final ByteArrayCollector outBytes = new ByteArrayCollector();
    private String endReason = "finished";

    // Gives every call a stable id so the UI can animate frames being pushed/popped.
    private final List<Long> frameIds = new ArrayList<>();
    private final List<String> frameKeys = new ArrayList<>();
    private boolean topFramePopped = false;
    private long nextFrameId = 1;

    private Tracer(Compiler.Result compiled, String stdin, boolean countOnly) {
        this.compiled = compiled;
        this.stdin = stdin == null ? "" : stdin;
        this.countOnly = countOnly;
    }

    /** Returns the JSON body sent back to the browser. */
    public static String run(Compiler.Result compiled, String stdin) throws Exception {
        return new Tracer(compiled, stdin, false).trace();
    }

    /** Runs without recording snapshots and returns {"ok":true,"end":...,"count":lines executed}. */
    public static String count(Compiler.Result compiled, String stdin) throws Exception {
        return new Tracer(compiled, stdin, true).trace();
    }

    private String trace() throws Exception {
        LaunchingConnector conn = Bootstrap.virtualMachineManager().defaultConnector();
        Map<String, Connector.Argument> args = conn.defaultArguments();
        args.get("main").setValue(compiled.mainClass());
        args.get("options").setValue("-cp " + compiled.dir() + " -Xss2m -XX:TieredStopAtLevel=1 -Xshare:auto");
        VirtualMachine vm = conn.launch(args);
        Process proc = vm.process();

        try (OutputStream in = proc.getOutputStream()) {
            in.write(stdin.getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) { }

        InputStream out = proc.getInputStream();
        InputStream err = proc.getErrorStream();
        EventRequestManager erm = vm.eventRequestManager();

        // Wait until the student's main class is loaded, then break at the start of main().
        ClassPrepareRequest cpr = erm.createClassPrepareRequest();
        cpr.addClassFilter(compiled.mainClass());
        cpr.enable();

        long deadline = System.currentTimeMillis() + (countOnly ? COUNT_TIMEOUT_MS : TIMEOUT_MS);
        boolean tracing = false;
        try {
            loop:
            while (true) {
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) { endReason = "timeout"; break; }
                // Poll in short slices so we can keep draining output while the program runs.
                EventSet set = vm.eventQueue().remove(Math.min(remaining, 50));
                if (set == null) {
                    drainQuietly(out); drainQuietly(err);
                    continue;
                }

                for (Event e : set) {
                    if (e instanceof VMDeathEvent || e instanceof VMDisconnectEvent) break loop;

                    if (e instanceof ClassPrepareEvent cpe) {
                        for (Method m : cpe.referenceType().methodsByName("main")) {
                            if (m.location() != null) erm.createBreakpointRequest(m.location()).enable();
                        }
                    } else if (e instanceof BreakpointEvent be && !tracing) {
                        tracing = true;
                        ThreadReference t = be.thread();
                        erm.deleteEventRequests(erm.breakpointRequests());

                        StepRequest step = erm.createStepRequest(t, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
                        for (String ex : EXCLUDED) step.addClassExclusionFilter(ex);
                        step.enable();

                        if (countOnly) { counted++; continue; }

                        MethodExitRequest exit = erm.createMethodExitRequest();
                        exit.addThreadFilter(t);
                        for (String ex : EXCLUDED) exit.addClassExclusionFilter(ex);
                        exit.enable();

                        ExceptionRequest exc = erm.createExceptionRequest(null, false, true);
                        exc.addThreadFilter(t);
                        exc.enable();

                        snapshot(t, "line", null, null, out, err);
                    } else if (e instanceof StepEvent se && countOnly) {
                        if (++counted % 2000 == 0) { drainQuietly(out); drainQuietly(err); }
                    } else if (e instanceof StepEvent se) {
                        snapshot(se.thread(), "line", null, null, out, err);
                    } else if (e instanceof MethodExitEvent me) {
                        if (isUserCode(me.method().declaringType().name()) && !me.method().isSynthetic()) {
                            snapshot(me.thread(), "return", me.returnValue(), null, out, err);
                            topFramePopped = true;
                        }
                    } else if (e instanceof ExceptionEvent ee) {
                        snapshot(ee.thread(), "exception", null, ee.exception(), out, err);
                    }
                }
                if (steps.size() >= MAX_STEPS || counted >= COUNT_MAX_STEPS) { endReason = "step_limit"; break; }
                if (!endReason.equals("finished")) break; // e.g. set by snapshot() for deep recursion
                set.resume();
            }
        } catch (VMDisconnectedException ignored) {
            // program ended
        } finally {
            if (!endReason.equals("finished")) {
                try { vm.exit(1); } catch (Exception ignored) { }
            }
            proc.destroyForcibly();
        }

        // Collect whatever output is left.
        drainQuietly(out); drainQuietly(err);
        if (endReason.equals("finished")) {
            try { drainAll(out); } catch (IOException ignored) { }
            try { drainAll(err); } catch (IOException ignored) { }
        }
        appendOutput();

        if (countOnly) {
            return "{\"ok\":true,\"end\":" + Json.str(endReason) + ",\"count\":" + counted + "}";
        }
        StringBuilder json = new StringBuilder();
        json.append("{\"ok\":true,\"end\":").append(Json.str(endReason))
            .append(",\"maxSteps\":").append(MAX_STEPS)
            .append(",\"stdout\":").append(Json.str(stdout.toString()))
            .append(",\"steps\":[").append(String.join(",", steps)).append("]}");
        return json.toString();
    }

    private boolean isUserCode(String typeName) {
        String outer = typeName.contains("$") ? typeName.substring(0, typeName.indexOf('$')) : typeName;
        return compiled.userClasses().contains(outer) || compiled.userClasses().contains(typeName);
    }

    // ---------------------------------------------------------------- snapshots

    private void snapshot(ThreadReference t, String kind, Value returnValue, ObjectReference exception,
                          InputStream out, InputStream err) {
        drainQuietly(out); drainQuietly(err);
        appendOutput();

        List<StackFrame> all;
        try { all = t.frames(); } catch (IncompatibleThreadStateException ex) { return; }

        // Keep only frames in student code, ordered bottom (main) -> top.
        List<StackFrame> frames = new ArrayList<>();
        for (StackFrame f : all) {
            if (isUserCode(f.location().declaringType().name())) frames.add(f);
        }
        if (frames.isEmpty()) return;
        Collections.reverse(frames);
        if (frames.size() > MAX_DEPTH) {
            endReason = "too_deep";
            return;
        }
        int hidden = 0;
        if (frames.size() > MAX_FRAMES) { // e.g. runaway recursion: show main + the top frames
            hidden = frames.size() - MAX_FRAMES;
            List<StackFrame> kept = new ArrayList<>(frames.subList(0, 1));
            kept.addAll(frames.subList(frames.size() - (MAX_FRAMES - 1), frames.size()));
            frames = kept;
        }

        List<Long> ids = assignFrameIds(frames, hidden);
        Map<Long, ObjectReference> toVisit = new LinkedHashMap<>();
        StringBuilder sb = new StringBuilder();
        StackFrame top = frames.get(frames.size() - 1);
        sb.append("{\"kind\":").append(Json.str(kind))
          .append(",\"line\":").append(top.location().lineNumber())
          .append(",\"out\":").append(stdout.length());
        if (hidden > 0) sb.append(",\"hiddenFrames\":").append(hidden);

        sb.append(",\"stack\":[");
        for (int i = 0; i < frames.size(); i++) {
            StackFrame f = frames.get(i);
            if (i > 0) sb.append(',');
            Method m = f.location().method();
            sb.append("{\"id\":").append(ids.get(i))
              .append(",\"method\":").append(Json.str(m.name().equals("<init>") ? "new " + simpleName(m.declaringType().name()) : m.name()))
              .append(",\"cls\":").append(Json.str(m.declaringType().name()))
              .append(",\"line\":").append(f.location().lineNumber())
              .append(",\"locals\":[");
            boolean first = true;
            ObjectReference self = f.thisObject();
            if (self != null) {
                sb.append("{\"name\":\"this\",\"type\":").append(Json.str(simpleName(self.referenceType().name())))
                  .append(",\"v\":").append(value(self, toVisit)).append('}');
                first = false;
            }
            try {
                for (LocalVariable lv : f.visibleVariables()) {
                    if (!first) sb.append(',');
                    first = false;
                    sb.append("{\"name\":").append(Json.str(lv.name()))
                      .append(",\"type\":").append(Json.str(simpleName(lv.typeName())))
                      .append(",\"v\":").append(value(f.getValue(lv), toVisit)).append('}');
                }
            } catch (AbsentInformationException ignored) { }
            sb.append(']');
            if (i == frames.size() - 1 && kind.equals("return")) {
                sb.append(",\"ret\":").append(m.returnTypeName().equals("void") ? "null" : value(returnValue, toVisit));
            }
            sb.append('}');
        }
        sb.append(']');

        if (exception != null) {
            String msg = exception.referenceType().name();
            Value detail = fieldValue(exception, "detailMessage");
            if (detail instanceof StringReference s) msg += ": " + s.value();
            sb.append(",\"exception\":").append(Json.str(msg));
        }

        sb.append(",\"heap\":{").append(heap(toVisit)).append("}}");
        steps.add(sb.toString());
    }

    private List<Long> assignFrameIds(List<StackFrame> frames, int hidden) {
        List<Long> ids = new ArrayList<>();
        List<String> keys = new ArrayList<>();
        boolean samePrefix = true;
        for (int i = 0; i < frames.size(); i++) {
            Method m = frames.get(i).location().method();
            String key = m.declaringType().name() + "." + m.name() + m.signature() + "@" + (i == 0 ? 0 : i + hidden);
            boolean poppedHere = topFramePopped && i == frameIds.size() - 1;
            if (samePrefix && i < frameIds.size() && frameKeys.get(i).equals(key) && !poppedHere) {
                ids.add(frameIds.get(i));
            } else {
                samePrefix = false;
                ids.add(nextFrameId++);
            }
            keys.add(key);
        }
        frameIds.clear(); frameIds.addAll(ids);
        frameKeys.clear(); frameKeys.addAll(keys);
        topFramePopped = false;
        return ids;
    }

    /** Encodes a value; objects become references ("r") that are described in the heap section. */
    private String value(Value v, Map<Long, ObjectReference> toVisit) {
        if (v == null) return "{\"k\":\"null\"}";
        if (v instanceof StringReference s) return "{\"k\":\"s\",\"v\":" + Json.str(s.value()) + "}";
        if (v instanceof CharValue c) return "{\"k\":\"p\",\"v\":" + Json.str("'" + c.value() + "'") + "}";
        if (v instanceof PrimitiveValue p) return "{\"k\":\"p\",\"v\":" + Json.str(p.toString()) + "}";
        if (v instanceof ObjectReference o) {
            String boxed = unbox(o);
            if (boxed != null) return "{\"k\":\"p\",\"v\":" + Json.str(boxed) + "}";
            toVisit.putIfAbsent(o.uniqueID(), o);
            return "{\"k\":\"r\",\"id\":" + o.uniqueID() + "}";
        }
        return "{\"k\":\"p\",\"v\":" + Json.str(v.toString()) + "}";
    }

    private static final Set<String> BOXES = Set.of("java.lang.Integer", "java.lang.Long", "java.lang.Double",
            "java.lang.Float", "java.lang.Short", "java.lang.Byte", "java.lang.Boolean", "java.lang.Character");

    private String unbox(ObjectReference o) {
        if (!BOXES.contains(o.referenceType().name())) return null;
        Value inner = fieldValue(o, "value");
        if (inner instanceof CharValue c) return "'" + c.value() + "'";
        return inner == null ? null : inner.toString();
    }

    private String heap(Map<Long, ObjectReference> toVisit) {
        Deque<ObjectReference> queue = new ArrayDeque<>(toVisit.values());
        Set<Long> done = new HashSet<>();
        List<String> parts = new ArrayList<>();
        while (!queue.isEmpty() && done.size() < MAX_HEAP_OBJECTS) {
            ObjectReference o = queue.poll();
            if (!done.add(o.uniqueID())) continue;
            Map<Long, ObjectReference> next = new LinkedHashMap<>();
            parts.add("\"" + o.uniqueID() + "\":" + describe(o, next));
            for (ObjectReference n : next.values()) if (!done.contains(n.uniqueID())) queue.add(n);
        }
        return String.join(",", parts);
    }

    private String describe(ObjectReference o, Map<Long, ObjectReference> next) {
        String type = simpleName(o.referenceType().name());
        try {
            if (o instanceof ArrayReference arr) {
                int len = arr.length();
                List<Value> vals = arr.getValues(0, Math.min(len, MAX_ARRAY_ITEMS));
                return "{\"kind\":\"array\",\"type\":" + Json.str(type) + ",\"len\":" + len
                        + ",\"items\":[" + joinValues(vals, next) + "]}";
            }
            String full = o.referenceType().name();
            String collection = describeCollection(o, full, next);
            if (collection != null) return collection;
            if (!isUserCode(full)) {
                return "{\"kind\":\"opaque\",\"type\":" + Json.str(type) + "}";
            }
            StringBuilder sb = new StringBuilder("{\"kind\":\"object\",\"type\":").append(Json.str(type)).append(",\"fields\":[");
            boolean first = true;
            for (Field f : o.referenceType().allFields()) {
                if (f.isStatic() || f.isSynthetic()) continue;
                if (!first) sb.append(',');
                first = false;
                sb.append("{\"name\":").append(Json.str(f.name()))
                  .append(",\"type\":").append(Json.str(simpleName(f.typeName())))
                  .append(",\"v\":").append(value(o.getValue(f), next)).append('}');
            }
            return sb.append("]}").toString();
        } catch (ObjectCollectedException ex) {
            return "{\"kind\":\"opaque\",\"type\":" + Json.str(type) + "}";
        }
    }

    // ---------------------------------------------------------------- java.util collections
    // We read the collections' private fields directly so students see the CONTENTS of a
    // HashMap or Stack, not its internal machinery. Returns null for types we don't know.

    private String describeCollection(ObjectReference o, String full, Map<Long, ObjectReference> next) {
        List<Value> items = new ArrayList<>();
        String role; // how the UI should draw it: list | stack | queue | set
        int len;
        switch (full) {
            case "java.util.ArrayList" -> {
                len = intField(o, "size");
                arraySlice(fieldValue(o, "elementData"), 0, len, items);
                role = "list";
            }
            case "java.util.Arrays$ArrayList" -> { // Arrays.asList(...)
                Value a = fieldValue(o, "a");
                len = a instanceof ArrayReference ar ? ar.length() : 0;
                arraySlice(a, 0, len, items);
                role = "list";
            }
            case "java.util.ImmutableCollections$ListN", "java.util.ImmutableCollections$SetN" -> { // List.of / Set.of
                Value a = fieldValue(o, "elements");
                if (a instanceof ArrayReference ar) for (Value v : ar.getValues()) if (v != null && items.size() < MAX_ARRAY_ITEMS) items.add(v);
                len = items.size();
                role = full.endsWith("SetN") ? "set" : "list";
            }
            case "java.util.ImmutableCollections$List12", "java.util.ImmutableCollections$Set12" -> {
                for (String f : new String[]{"e0", "e1"}) {
                    Value v = fieldValue(o, f);
                    if (v != null && !(v instanceof ObjectReference r && r.referenceType().name().equals("java.lang.Object"))) items.add(v);
                }
                len = items.size();
                role = full.endsWith("Set12") ? "set" : "list";
            }
            case "java.util.Stack", "java.util.Vector" -> {
                len = intField(o, "elementCount");
                arraySlice(fieldValue(o, "elementData"), 0, len, items);
                role = full.equals("java.util.Stack") ? "stack" : "list";
            }
            case "java.util.LinkedList" -> {
                len = intField(o, "size");
                Value node = fieldValue(o, "first");
                while (node instanceof ObjectReference n && items.size() < MAX_ARRAY_ITEMS) {
                    items.add(fieldValue(n, "item"));
                    node = fieldValue(n, "next");
                }
                role = "queue";
            }
            case "java.util.ArrayDeque" -> {
                Value els = fieldValue(o, "elements");
                int head = intField(o, "head"), tail = intField(o, "tail");
                if (els instanceof ArrayReference ar && ar.length() > 0) {
                    int cap = ar.length();
                    for (int i = head; i != tail && items.size() < MAX_ARRAY_ITEMS; i = (i + 1) % cap) items.add(ar.getValue(i));
                }
                len = items.size();
                role = "queue";
            }
            case "java.util.PriorityQueue" -> {
                len = intField(o, "size");
                arraySlice(fieldValue(o, "queue"), 0, len, items);
                role = "queue";
            }
            case "java.util.HashSet", "java.util.LinkedHashSet" -> {
                Value map = fieldValue(o, "map");
                List<Value[]> entries = new ArrayList<>();
                if (map instanceof ObjectReference m) hashEntries(m, entries);
                for (Value[] e : entries) items.add(e[0]);
                len = map instanceof ObjectReference m ? intField(m, "size") : 0;
                role = "set";
            }
            case "java.util.TreeSet" -> {
                Value map = fieldValue(o, "m");
                List<Value[]> entries = new ArrayList<>();
                if (map instanceof ObjectReference m) treeEntries(fieldValue(m, "root"), entries, 0);
                for (Value[] e : entries) items.add(e[0]);
                len = map instanceof ObjectReference m ? intField(m, "size") : 0;
                role = "set";
            }
            case "java.util.HashMap", "java.util.LinkedHashMap", "java.util.TreeMap" -> {
                List<Value[]> entries = new ArrayList<>();
                if (full.equals("java.util.TreeMap")) treeEntries(fieldValue(o, "root"), entries, 0);
                else hashEntries(o, entries);
                StringBuilder sb = new StringBuilder("{\"kind\":\"map\",\"type\":").append(Json.str(simpleName(full)))
                        .append(",\"len\":").append(intField(o, "size")).append(",\"entries\":[");
                for (int i = 0; i < entries.size(); i++) {
                    if (i > 0) sb.append(',');
                    sb.append("{\"k\":").append(value(entries.get(i)[0], next))
                      .append(",\"v\":").append(value(entries.get(i)[1], next)).append('}');
                }
                return sb.append("]}").toString();
            }
            default -> { return null; }
        }
        return "{\"kind\":\"list\",\"role\":\"" + role + "\",\"type\":" + Json.str(simpleName(full)) + ",\"len\":" + len
                + ",\"items\":[" + joinValues(items, next) + "]}";
    }

    /** HashMap / LinkedHashMap entries as [key, value] pairs (insertion order for LinkedHashMap). */
    private void hashEntries(ObjectReference map, List<Value[]> out) {
        if (map.referenceType().name().equals("java.util.LinkedHashMap")) {
            Value e = fieldValue(map, "head");
            while (e instanceof ObjectReference n && out.size() < MAX_ARRAY_ITEMS) {
                out.add(new Value[]{fieldValue(n, "key"), fieldValue(n, "value")});
                e = fieldValue(n, "after");
            }
            return;
        }
        Value table = fieldValue(map, "table");
        if (!(table instanceof ArrayReference buckets)) return;
        for (Value bucket : buckets.getValues()) {
            Value e = bucket;
            while (e instanceof ObjectReference n && out.size() < MAX_ARRAY_ITEMS) {
                // Large buckets turn into TreeNodes, which still keep a "next" chain.
                out.add(new Value[]{fieldValue(n, "key"), fieldValue(n, "value")});
                e = fieldValue(n, "next");
            }
        }
    }

    /** TreeMap entries in sorted order (in-order walk of its red-black tree). */
    private void treeEntries(Value node, List<Value[]> out, int depth) {
        if (!(node instanceof ObjectReference n) || out.size() >= MAX_ARRAY_ITEMS || depth > 64) return;
        treeEntries(fieldValue(n, "left"), out, depth + 1);
        if (out.size() < MAX_ARRAY_ITEMS) out.add(new Value[]{fieldValue(n, "key"), fieldValue(n, "value")});
        treeEntries(fieldValue(n, "right"), out, depth + 1);
    }

    private static void arraySlice(Value array, int from, int to, List<Value> out) {
        if (!(array instanceof ArrayReference a)) return;
        int end = Math.min(Math.min(to, a.length()), from + MAX_ARRAY_ITEMS);
        if (end > from) out.addAll(a.getValues(from, end - from));
    }

    private static int intField(ObjectReference o, String name) {
        return fieldValue(o, name) instanceof IntegerValue iv ? iv.value() : 0;
    }

    private String joinValues(List<Value> vals, Map<Long, ObjectReference> next) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < vals.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(value(vals.get(i), next));
        }
        return sb.toString();
    }

    private static Value fieldValue(ObjectReference o, String name) {
        Field f = o.referenceType().fieldByName(name);
        return f == null ? null : o.getValue(f);
    }

    private static String simpleName(String name) {
        int cut = Math.max(name.lastIndexOf('.'), name.lastIndexOf('$'));
        return cut < 0 ? name : name.substring(cut + 1);
    }

    // ---------------------------------------------------------------- program output

    private void appendOutput() {
        String s = outBytes.takeString();
        int room = MAX_OUTPUT - stdout.length();
        if (room > 0) stdout.append(s.length() <= room ? s : s.substring(0, room));
    }

    private void drainQuietly(InputStream in) {
        try { drainAvailable(in); } catch (IOException ignored) { }
    }

    private void drainAvailable(InputStream in) throws IOException {
        int n;
        while ((n = in.available()) > 0) {
            byte[] buf = new byte[n];
            int read = in.read(buf);
            if (read <= 0) break;
            outBytes.write(buf, read);
        }
    }

    private void drainAll(InputStream in) throws IOException {
        byte[] buf = new byte[8192];
        int read;
        while ((read = in.read(buf)) > 0) outBytes.write(buf, read);
    }

    /** Buffers bytes so multi-byte UTF-8 characters split across reads decode correctly. */
    private static final class ByteArrayCollector {
        private final java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        void write(byte[] b, int n) { bytes.write(b, 0, n); }
        String takeString() {
            String s = bytes.toString(StandardCharsets.UTF_8);
            bytes.reset();
            return s;
        }
    }
}
