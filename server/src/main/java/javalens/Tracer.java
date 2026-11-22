package javalens;

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
    /** Extra options for the student's JVM (class mode caps its memory; see TraceWorker). */
    static volatile String extraJvmOptions = "";

    public static final int MAX_STEPS = 10_000; // in practice ~5000+ fit in TIMEOUT_MS (each step is a few debugger round trips)
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

    /** Every student program currently running, so quitting the app can stop them all. */
    private static final Set<Process> LIVE = java.util.concurrent.ConcurrentHashMap.newKeySet();

    public static void stopAll() {
        for (Process p : LIVE) p.destroyForcibly();
    }

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

    // Memory-map extras: the String objects that live in the string pool, and the user classes to read statics from.
    private final Set<Long> pooledIds = new HashSet<>();
    private final Map<String, ClassType> userTypes = new LinkedHashMap<>();
    private final List<String> codeJson = new ArrayList<>(); // one entry per loaded user class: its methods

    private VirtualMachine vm;

    // Speed: every debugger call is a round trip to the student's JVM, so read fields in batches and
    // remember what can't change. Strings and boxed numbers are immutable, so their text is cached by id.
    private final Map<Long, String> stringTexts = new HashMap<>();
    private final Map<Long, String> boxedTexts = new HashMap<>();
    private final Map<ReferenceType, List<Field>> instanceFields = new HashMap<>();
    private final Map<Long, Integer> arrayLengths = new HashMap<>(); // an array's length never changes
    private final Map<String, List<Field>> staticFields = new HashMap<>();
    private final Set<String> initializedClasses = new HashSet<>();

    // Objects of student classes are only re-read after one of their fields is written: the debugger
    // reports every write (a modification watchpoint per field) without stopping the program, so an
    // object that wasn't written keeps the description we read last time.
    private record Described(String json, List<ObjectReference> refs) {}
    private final Map<Long, Described> described = new HashMap<>();
    private final Set<Long> written = new HashSet<>();
    private final Set<ReferenceType> watched = new HashSet<>();
    private boolean watching = false;

    // What the previous step sent, for delta encoding.
    private Map<Long, String> prevFrameJson = Map.of();
    private Map<Long, String> prevHeapJson = Map.of();
    private String prevStatics = "";

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
        // Quoted: the temp folder can contain spaces (e.g. a Windows user name like "Jo Smith").
        args.get("options").setValue("-cp \"" + compiled.dir() + "\" -Xss2m -XX:TieredStopAtLevel=1 -Xshare:auto "
                + extraJvmOptions);
        VirtualMachine vm = conn.launch(args);
        this.vm = vm;
        Process proc = vm.process();
        LIVE.add(proc);

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

                    if (e instanceof ModificationWatchpointEvent mw) {
                        ObjectReference obj = mw.object();
                        if (obj != null) written.add(obj.uniqueID());
                    } else if (e instanceof ClassPrepareEvent cpe && tracing) {
                        if (watching && isUserCode(cpe.referenceType().name())) watch(cpe.referenceType());
                    } else if (e instanceof ClassPrepareEvent cpe) {
                        for (Method m : cpe.referenceType().methodsByName("main")) {
                            if (m.location() != null) erm.createBreakpointRequest(m.location()).enable();
                        }
                    } else if (e instanceof BreakpointEvent be && !tracing) {
                        tracing = true;
                        ThreadReference t = be.thread();
                        erm.deleteEventRequests(erm.breakpointRequests());
                        if (!countOnly) internLiterals(t); // before stepping starts, so no step events come from it

                        StepRequest step = erm.createStepRequest(t, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
                        for (String ex : EXCLUDED) step.addClassExclusionFilter(ex);
                        step.enable();

                        if (countOnly) { counted++; continue; }

                        MethodExitRequest exit = erm.createMethodExitRequest();
                        exit.addThreadFilter(t);
                        for (String ex : EXCLUDED) exit.addClassExclusionFilter(ex);
                        exit.enable();

                        // Caught exceptions too, so a try/catch can be watched; filtered below to the ones
                        // student code throws or catches (the JDK throws and catches plenty internally).
                        ExceptionRequest exc = erm.createExceptionRequest(null, true, true);
                        exc.addThreadFilter(t);
                        exc.enable();

                        if (vm.canWatchFieldModification()) {
                            watching = true;
                            for (String name : compiled.userClasses()) { // classes loaded later
                                for (String pattern : new String[]{name, name + "$*"}) {
                                    ClassPrepareRequest later = erm.createClassPrepareRequest();
                                    later.addClassFilter(pattern);
                                    later.enable();
                                }
                            }
                            for (ReferenceType rt : vm.allClasses()) { // classes already loaded
                                if (rt.isPrepared() && isUserCode(rt.name())) watch(rt);
                            }
                        }

                        snapshot(t, "line", null, null, null, out, err);
                    } else if (e instanceof StepEvent se && countOnly) {
                        if (++counted % 2000 == 0) { drainQuietly(out); drainQuietly(err); }
                    } else if (e instanceof StepEvent se) {
                        if (!hiddenStep(se.location())) snapshot(se.thread(), "line", null, null, null, out, err);
                    } else if (e instanceof MethodExitEvent me) {
                        if (!hiddenStep(me.location())) {
                            snapshot(me.thread(), "return", me.returnValue(), null, null, out, err);
                            topFramePopped = true;
                        }
                    } else if (e instanceof ExceptionEvent ee) {
                        Location caughtAt = ee.catchLocation(); // null: nothing catches it, the program stops
                        boolean thrownByUser = isUserCode(ee.location().declaringType().name());
                        boolean caughtByUser = caughtAt != null && isUserCode(caughtAt.declaringType().name());
                        if (caughtAt == null || thrownByUser || caughtByUser) {
                            snapshot(ee.thread(), "exception", null, ee.exception(), caughtAt, out, err);
                        }
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
            LIVE.remove(proc);
        }

        // Collect whatever output is left.
        drainQuietly(out); drainQuietly(err);
        if (endReason.equals("finished")) {
            try { drainAll(out); } catch (IOException ignored) { }
            try { drainAll(err); } catch (IOException ignored) { }
        }
        appendOutput();
        if (pendingCR) stdout.append('\r'); // a lone \r at the very end was real output

        if (countOnly) {
            return "{\"ok\":true,\"end\":" + Json.str(endReason) + ",\"count\":" + counted + "}";
        }
        StringBuilder json = new StringBuilder();
        json.append("{\"ok\":true,\"delta\":true,\"end\":").append(Json.str(endReason))
            .append(",\"maxSteps\":").append(MAX_STEPS)
            .append(",\"stdout\":").append(Json.str(stdout.toString()))
            .append(",\"code\":[").append(String.join(",", codeJson)).append(']')
            .append(",\"steps\":[").append(String.join(",", steps)).append("]}");
        return json.toString();
    }

    /**
     * Steps not worth showing: code without line numbers, and the methods javac writes for every enum
     * (values, valueOf), which would otherwise show up as a step into the enum's first line.
     */
    private boolean hiddenStep(Location loc) {
        if (loc.lineNumber() < 0 || !isUserCode(loc.declaringType().name())) return true;
        Method m = loc.method();
        return (m.isSynthetic() && !m.name().startsWith("lambda$")) || m.isBridge() // a lambda's body is synthetic too
                || (m.declaringType() instanceof ClassType ct && ct.isEnum() && (m.name().equals("values") || m.name().equals("valueOf")));
    }

    // ---------------------------------------------------------------- names students recognise

    private final Map<ReferenceType, String> typeLabels = new HashMap<>();
    private static final java.util.regex.Pattern LAMBDA_METHOD = java.util.regex.Pattern.compile("lambda\\$(.+)\\$\\d+");

    /** A class's name as a student would write it: Node, "anonymous Runnable", "lambda", Local. */
    private String typeLabel(ReferenceType rt) {
        String label = typeLabels.get(rt);
        if (label == null) typeLabels.put(rt, label = computeTypeLabel(rt)); // not computeIfAbsent: it can recurse
        return label;
    }

    private String computeTypeLabel(ReferenceType t) {
        String name = t.name();
        if (name.contains("$$Lambda")) return "lambda";
        String simple = simpleName(name);
        ClassType enumType = enumTypeOf(t);
        if (enumType != null && enumType != t) return typeLabel(enumType); // an enum constant with a body { ... }
        if (simple.matches("\\d+") && t instanceof ClassType ct) { // new Runnable() { ... }
            List<InterfaceType> ifaces = ct.interfaces();
            String base = !ifaces.isEmpty() ? ifaces.get(0).name() : ct.superclass() != null ? ct.superclass().name() : "Object";
            return "anonymous " + simpleName(base);
        }
        return simple.replaceFirst("^\\d+(?=\\D)", ""); // a class declared inside a method: Main$1Helper -> Helper
    }

    /** A method's name for a stack frame: "new Node", "static init", "lambda in main". */
    private String methodLabel(Method m) {
        String n = m.name();
        if (n.equals("<init>")) return "new " + typeLabel(m.declaringType());
        if (n.equals("<clinit>")) return "static init";
        java.util.regex.Matcher l = LAMBDA_METHOD.matcher(n);
        if (l.matches()) {
            String in = l.group(1);
            return "lambda in " + (in.equals("static") ? "static init" : in.equals("new") ? "constructor" : in);
        }
        return n;
    }

    /** "Color.RED" for a constant of an enum that has no fields of its own (else null: drawn as an object). */
    private final Map<Long, String> enumTexts = new HashMap<>();
    private String enumConstant(ObjectReference o) {
        String known = enumTexts.get(o.uniqueID());
        if (known != null) return known.isEmpty() ? null : known;
        String text = "";
        ClassType enumType = enumTypeOf(o.referenceType());
        if (enumType != null && isUserCode(enumType.name())) {
            boolean ownFields = o.referenceType().allFields().stream()
                    .anyMatch(f -> !f.isStatic() && !f.isSynthetic() && !f.declaringType().name().equals("java.lang.Enum"));
            if (!ownFields && fieldValue(o, "name") instanceof StringReference name) text = typeLabel(enumType) + "." + name.value();
        }
        enumTexts.put(o.uniqueID(), text); // a constant never changes
        return text.isEmpty() ? null : text;
    }

    /** The enum a constant belongs to (a constant with a body { ... } is a subclass of it), or null. */
    private static ClassType enumTypeOf(ReferenceType rt) {
        if (!(rt instanceof ClassType ct)) return null;
        if (ct.isEnum()) return ct;
        ClassType sup = ct.superclass();
        return sup != null && sup.isEnum() ? sup : null;
    }

    /** Ask to be told (without stopping) whenever a field of this student class is written. */
    private void watch(ReferenceType rt) {
        if (!watched.add(rt)) return;
        EventRequestManager erm = vm.eventRequestManager();
        for (Field f : rt.fields()) {
            if (f.isStatic()) continue;
            ModificationWatchpointRequest r = erm.createModificationWatchpointRequest(f);
            r.setSuspendPolicy(EventRequest.SUSPEND_NONE);
            r.enable();
        }
    }

    private boolean isUserCode(String typeName) {
        // Classes the JVM generates at run time (lambdas Main$$Lambda/0x..., pattern switches
        // Main$$TypeSwitch/0x...) carry the student's class name but aren't the student's code.
        if (typeName.contains("$$") || typeName.contains("/")) return false;
        String outer = typeName.contains("$") ? typeName.substring(0, typeName.indexOf('$')) : typeName;
        return compiled.userClasses().contains(outer) || compiled.userClasses().contains(typeName);
    }

    // ---------------------------------------------------------------- snapshots

    private void snapshot(ThreadReference t, String kind, Value returnValue, ObjectReference exception,
                          Location caughtAt, InputStream out, InputStream err) {
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
          .append(",\"line\":").append(top.location().lineNumber());
        String topFile = otherFile(top);
        if (topFile != null) sb.append(",\"file\":").append(Json.str(topFile));
        sb
          .append(",\"out\":").append(stdout.length());
        if (hidden > 0) sb.append(",\"hiddenFrames\":").append(hidden);

        // Delta encoding: a frame that is exactly as it was on the previous step is sent as
        // {"id":n,"same":1}; the page fills it in from that step (see web/src/trace.ts).
        Map<Long, String> frameJson = new HashMap<>();
        sb.append(",\"stack\":[");
        for (int i = 0; i < frames.size(); i++) {
            StackFrame f = frames.get(i);
            if (i > 0) sb.append(',');
            StringBuilder fs = new StringBuilder();
            Method m = f.location().method();
            fs.append("{\"id\":").append(ids.get(i))
              .append(",\"method\":").append(Json.str(methodLabel(m)))
              .append(",\"cls\":").append(Json.str(m.declaringType().name()))
              .append(",\"line\":").append(f.location().lineNumber());
            String file = otherFile(f);
            if (file != null) fs.append(",\"file\":").append(Json.str(file));
            fs.append(",\"locals\":[");
            boolean first = true;
            ObjectReference self = m.isStatic() || m.isNative() ? null : f.thisObject();
            if (self != null) {
                fs.append("{\"name\":\"this\",\"type\":").append(Json.str(typeLabel(self.referenceType())))
                  .append(",\"v\":").append(value(self, toVisit)).append('}');
                first = false;
            }
            try {
                List<LocalVariable> vars = f.visibleVariables();
                Map<LocalVariable, Value> vals = f.getValues(vars); // one round trip for all of them
                for (LocalVariable lv : vars) {
                    if (!first) fs.append(',');
                    first = false;
                    fs.append("{\"name\":").append(Json.str(lv.name()))
                      .append(",\"type\":").append(Json.str(simpleName(lv.typeName())));
                    if (compiled.finalLocals().contains(simpleName(m.declaringType().name()) + "." + m.name() + "." + lv.name())) {
                        fs.append(",\"final\":true");
                    }
                    fs.append(",\"v\":").append(value(vals.get(lv), toVisit)).append('}');
                }
            } catch (AbsentInformationException ignored) { }
            fs.append(']');
            if (i == frames.size() - 1 && kind.equals("return")) {
                fs.append(",\"ret\":").append(m.returnTypeName().equals("void") ? "null" : value(returnValue, toVisit));
            }
            fs.append('}');
            String json = fs.toString();
            frameJson.put(ids.get(i), json);
            if (json.equals(prevFrameJson.get(ids.get(i)))) sb.append("{\"id\":").append(ids.get(i)).append(",\"same\":1}");
            else sb.append(json);
        }
        prevFrameJson = frameJson;
        sb.append(']');

        if (exception != null) {
            String msg = exception.referenceType().name();
            Value detail = fieldValue(exception, "detailMessage");
            if (detail instanceof StringReference s) msg += ": " + s.value();
            sb.append(",\"exception\":").append(Json.str(msg));
            if (caughtAt != null) {
                sb.append(",\"caught\":true");
                if (isUserCode(caughtAt.declaringType().name())) { // else library code catches it
                    sb.append(",\"catchLine\":").append(caughtAt.lineNumber());
                    String file = otherFile(caughtAt);
                    if (file != null) sb.append(",\"catchFile\":").append(Json.str(file));
                    // the nearest call running the catching method: every call above it is unwound
                    for (int i = frames.size() - 1; i >= 0; i--) {
                        if (frames.get(i).location().method().equals(caughtAt.method())) {
                            sb.append(",\"catchFrame\":").append(ids.get(i));
                            break;
                        }
                    }
                }
            }
        }

        String statics = statics(toVisit);
        if (!statics.isEmpty() && statics.equals(prevStatics)) sb.append(",\"staticsSame\":1");
        else if (!statics.isEmpty()) sb.append(",\"statics\":[").append(statics).append(']');
        prevStatics = statics;

        // The heap, also as a delta: only objects that are new or changed since the previous step,
        // plus the ids of objects that are no longer there.
        Map<Long, String> heap = heap(toVisit);
        sb.append(",\"heap\":{");
        boolean firstObj = true;
        for (Map.Entry<Long, String> o : heap.entrySet()) {
            if (o.getValue().equals(prevHeapJson.get(o.getKey()))) continue;
            if (!firstObj) sb.append(',');
            firstObj = false;
            sb.append('"').append(o.getKey()).append("\":").append(o.getValue());
        }
        sb.append('}');
        StringBuilder gone = new StringBuilder();
        for (Long id : prevHeapJson.keySet()) {
            if (heap.containsKey(id)) continue;
            if (!gone.isEmpty()) gone.append(',');
            gone.append(id);
        }
        if (!gone.isEmpty()) sb.append(",\"gone\":[").append(gone).append(']');
        prevHeapJson = heap;
        sb.append('}');
        steps.add(sb.toString());
    }

    /** The frame's source file if it isn't the main file (e.g. "edu/unl/raikes/memory/models/Year.java"), else null. */
    private String otherFile(StackFrame f) {
        return otherFile(f.location());
    }

    private String otherFile(Location loc) {
        try {
            String path = loc.sourcePath().replace('\\', '/');
            return path.equals(compiled.mainSource()) ? null : path;
        } catch (AbsentInformationException e) {
            return null;
        }
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
        if (v instanceof StringReference s) {
            String text = stringTexts.get(s.uniqueID());
            if (text == null) stringTexts.put(s.uniqueID(), text = s.value());
            return "{\"k\":\"s\",\"v\":" + Json.str(text) + ",\"id\":" + s.uniqueID()
                    + (pooledIds.contains(s.uniqueID()) ? ",\"pool\":true" : "") + "}";
        }
        if (v instanceof CharValue c) return "{\"k\":\"p\",\"v\":" + Json.str("'" + c.value() + "'") + "}";
        if (v instanceof PrimitiveValue p) return "{\"k\":\"p\",\"v\":" + Json.str(p.toString()) + "}";
        if (v instanceof ObjectReference o) {
            String boxed = unbox(o);
            if (boxed != null) return "{\"k\":\"p\",\"v\":" + Json.str(boxed) + "}";
            String constant = enumConstant(o);
            if (constant != null) return "{\"k\":\"p\",\"v\":" + Json.str(constant) + "}";
            toVisit.putIfAbsent(o.uniqueID(), o);
            return "{\"k\":\"r\",\"id\":" + o.uniqueID() + "}";
        }
        return "{\"k\":\"p\",\"v\":" + Json.str(v.toString()) + "}";
    }

    private static final Set<String> BOXES = Set.of("java.lang.Integer", "java.lang.Long", "java.lang.Double",
            "java.lang.Float", "java.lang.Short", "java.lang.Byte", "java.lang.Boolean", "java.lang.Character");

    private String unbox(ObjectReference o) {
        String known = boxedTexts.get(o.uniqueID());
        if (known != null) return known;
        if (!BOXES.contains(o.referenceType().name())) return null;
        Value inner = fieldValue(o, "value");
        String text = inner instanceof CharValue c ? "'" + c.value() + "'" : inner == null ? null : inner.toString();
        if (text != null) boxedTexts.put(o.uniqueID(), text); // boxes never change
        return text;
    }

    /** Every object reachable from the stack and statics (up to the limit): id -> description. */
    private Map<Long, String> heap(Map<Long, ObjectReference> toVisit) {
        Deque<ObjectReference> queue = new ArrayDeque<>(toVisit.values());
        Map<Long, String> out = new LinkedHashMap<>();
        while (!queue.isEmpty() && out.size() < MAX_HEAP_OBJECTS) {
            ObjectReference o = queue.poll();
            if (out.containsKey(o.uniqueID())) continue;
            Map<Long, ObjectReference> next = new LinkedHashMap<>();
            out.put(o.uniqueID(), describe(o, next));
            for (ObjectReference n : next.values()) if (!out.containsKey(n.uniqueID())) queue.add(n);
        }
        return out;
    }

    private String describe(ObjectReference o, Map<Long, ObjectReference> next) {
        String type = typeLabel(o.referenceType());
        try {
            if (o instanceof ArrayReference arr) {
                Integer len = arrayLengths.get(o.uniqueID());
                if (len == null) arrayLengths.put(o.uniqueID(), len = arr.length());
                List<Value> vals = len == 0 ? List.of() : arr.getValues(0, Math.min(len, MAX_ARRAY_ITEMS));
                return "{\"kind\":\"array\",\"type\":" + Json.str(type) + ",\"len\":" + len
                        + ",\"items\":[" + joinValues(vals, next) + "]}";
            }
            String full = o.referenceType().name();
            String collection = describeCollection(o, full, next);
            if (collection != null) return collection;
            if (!isUserCode(full)) {
                return "{\"kind\":\"opaque\",\"type\":" + Json.str(type) + "}";
            }
            List<Field> fields = instanceFields.computeIfAbsent(o.referenceType(), rt -> rt.allFields().stream()
                    .filter(f -> !f.isStatic() && !f.isSynthetic() && !f.declaringType().name().equals("java.lang.Enum")).toList());
            ClassType enumType = enumTypeOf(o.referenceType());
            if (enumType != null && fieldValue(o, "name") instanceof StringReference constant) {
                type = typeLabel(enumType) + "." + constant.value(); // Planet.EARTH
            }
            // Unchanged since last time? Only if every one of its fields is watched (a field inherited
            // from a library class isn't).
            boolean cacheable = watching && fields.stream().allMatch(f -> watched.contains(f.declaringType()));
            if (cacheable && !written.contains(o.uniqueID())) {
                Described d = described.get(o.uniqueID());
                if (d != null) {
                    for (ObjectReference r : d.refs()) next.putIfAbsent(r.uniqueID(), r);
                    return d.json();
                }
            }
            StringBuilder sb = new StringBuilder("{\"kind\":\"object\",\"type\":").append(Json.str(type)).append(",\"fields\":[");
            boolean first = true;
            Map<Field, Value> vals = o.getValues(fields); // one round trip for every field
            for (Field f : fields) {
                if (!first) sb.append(',');
                first = false;
                sb.append("{\"name\":").append(Json.str(f.name()))
                  .append(",\"type\":").append(Json.str(simpleName(f.typeName())));
                if (f.isFinal()) sb.append(",\"final\":true");
                sb.append(",\"v\":").append(value(vals.get(f), next)).append('}');
            }
            String json = sb.append("]}").toString();
            if (cacheable) {
                described.put(o.uniqueID(), new Described(json, List.copyOf(next.values())));
                written.remove(o.uniqueID());
            }
            return json;
        } catch (ObjectCollectedException ex) {
            return "{\"kind\":\"opaque\",\"type\":" + Json.str(type) + "}";
        }
    }

    // ---------------------------------------------------------------- static fields + string pool

    /** Static fields of every user class that has been initialized so far, as a JSON array body. */
    private String statics(Map<Long, ObjectReference> toVisit) {
        List<String> parts = new ArrayList<>();
        for (String name : compiled.userClasses()) {
            ClassType ct = userTypes.get(name);
            if (ct == null) {
                for (ReferenceType rt : vm.classesByName(name)) if (rt instanceof ClassType c) ct = c;
                if (ct == null) continue;
                userTypes.put(name, ct);
                codeJson.add(describeCode(ct));
            }
            ClassType type = ct;
            List<Field> fields = staticFields.computeIfAbsent(name,
                    n -> type.fields().stream().filter(f -> f.isStatic() && !f.isSynthetic() && !f.name().startsWith("$")).toList());
            if (fields.isEmpty()) continue;
            if (!initializedClasses.contains(name)) { // once initialized, always initialized
                if (!ct.isInitialized()) continue;
                initializedClasses.add(name);
            }
            StringBuilder sb = new StringBuilder();
            Map<Field, Value> vals = fields.isEmpty() ? Map.of() : ct.getValues(fields);
            for (Field f : fields) {
                if (!sb.isEmpty()) sb.append(',');
                sb.append("{\"name\":").append(Json.str(f.name()))
                  .append(",\"type\":").append(Json.str(simpleName(f.typeName())));
                if (f.isFinal()) sb.append(",\"final\":true");
                sb.append(",\"v\":").append(value(vals.get(f), toVisit)).append('}');
            }
            if (sb.isEmpty()) continue;
            parts.add("{\"cls\":" + Json.str(simpleName(name)) + ",\"fields\":[" + sb + "]}");
        }
        return String.join(",", parts);
    }

    /** A class's methods with their bytecode size, for the "Code" segment of the memory layout. */
    private static String describeCode(ClassType ct) {
        StringBuilder sb = new StringBuilder();
        String cls = simpleName(ct.name());
        for (Method m : ct.methods()) {
            if (m.isSynthetic() || m.isBridge() || m.isAbstract() || m.isNative()) continue;
            int bytes = 0;
            try { bytes = m.bytecodes().length; } catch (Exception ignored) { }
            List<String> params = new ArrayList<>();
            for (String t : m.argumentTypeNames()) params.add(simpleName(t));
            String args = "(" + String.join(", ", params) + ")";
            String label;
            String name;
            if (m.isStaticInitializer()) { name = "static init"; label = "static { ... }"; }
            else if (m.isConstructor()) { name = "new " + cls; label = "new " + cls + args; }
            else { name = m.name(); label = simpleName(m.returnTypeName()) + " " + m.name() + args; }
            if (!sb.isEmpty()) sb.append(',');
            sb.append("{\"name\":").append(Json.str(name))
              .append(",\"sig\":").append(Json.str(label))
              .append(",\"bytes\":").append(bytes).append('}');
        }
        return "{\"cls\":" + Json.str(cls) + ",\"methods\":[" + sb + "]}";
    }

    /**
     * Finds the pooled String object for every literal in the source by interning its text now.
     * This doesn't change the program: a literal always evaluates to exactly this interned object.
     */
    private void internLiterals(ThreadReference t) {
        if (compiled.stringLiterals().isEmpty()) return;
        try {
            List<ReferenceType> types = vm.classesByName("java.lang.String");
            if (types.isEmpty() || !(types.get(0) instanceof ClassType stringType)) return;
            Method intern = stringType.concreteMethodByName("intern", "()Ljava/lang/String;");
            if (intern == null) return;
            for (String lit : compiled.stringLiterals()) {
                try {
                    StringReference mirror = vm.mirrorOf(lit);
                    mirror.disableCollection(); // keep it alive until intern() has run
                    Value canon = mirror.invokeMethod(t, intern, List.of(), ObjectReference.INVOKE_SINGLE_THREADED);
                    mirror.enableCollection();
                    if (canon instanceof ObjectReference o) pooledIds.add(o.uniqueID());
                } catch (ObjectCollectedException ignored) { }
            }
        } catch (Exception ignored) {
            // Memory map just won't mark pooled strings.
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

    private boolean pendingCR = false; // a '\r' at the end of the last read whose '\n' may come next

    private void appendOutput() {
        String s = outBytes.takeString();
        // Windows ends lines with \r\n; show the same \n everywhere. A \r\n can arrive split across reads.
        if (pendingCR) s = "\r" + s;
        pendingCR = s.endsWith("\r");
        if (pendingCR) s = s.substring(0, s.length() - 1);
        s = s.replace("\r\n", "\n");
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
