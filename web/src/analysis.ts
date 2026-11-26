// Things we work out from a trace (or the source code) on the browser side.
import type { HeapObj, Step, Value } from './types';

// ------------------------------------------------------------ call tree

export interface CallNode {
  id: number;
  method: string;
  args: string; // "n=4" style summary of the parameters
  parent: number | null;
  children: number[];
  firstStep: number; // step index where the call starts
  returnStep: number | null; // step index where it returns (if it does)
  ret: Value | null | undefined; // undefined = no value (void / not returned yet)
  threw?: string; // the exception that ended this call early (it then has no return value)
}

/** Builds the tree of every method call in the run: each frame id becomes a node. */
export function buildCallTree(steps: Step[]): { nodes: Map<number, CallNode>; root: number | null } {
  const nodes = new Map<number, CallNode>();
  let root: number | null = null;
  steps.forEach((step, i) => {
    step.stack.forEach((f, depth) => {
      let node = nodes.get(f.id);
      if (!node) {
        const parent = depth > 0 ? step.stack[depth - 1].id : null;
        node = {
          id: f.id,
          method: f.method,
          // On a call's first step only its parameters are in scope.
          args: f.locals
            .filter((l) => l.name !== 'this' && !(f.method === 'main' && l.name === 'args'))
            .map((l) => `${l.name}=${shortValue(l.v, step.heap)}`)
            .join(', '),
          parent,
          children: [],
          firstStep: i,
          returnStep: null,
          ret: undefined,
        };
        nodes.set(f.id, node);
        if (parent !== null) nodes.get(parent)?.children.push(f.id);
        else if (root === null) root = f.id;
      }
    });
    for (const id of unwoundFrames(step)) {
      const node = nodes.get(id)!;
      if (node.returnStep === null) {
        node.returnStep = i;
        node.threw = exceptionName(step.exception);
      }
    }
    const top = step.stack[step.stack.length - 1];
    if (step.kind === 'return' && top) {
      const node = nodes.get(top.id)!;
      if (node.returnStep === null) {
        node.returnStep = i;
        node.ret = top.ret;
      }
    }
  });
  return { nodes, root };
}

export function shortValue(v: Value | null | undefined, heap: Record<string, HeapObj>): string {
  if (!v) return 'void';
  switch (v.k) {
    case 'p':
      return v.v;
    case 's':
      return `"${v.v.length > 12 ? v.v.slice(0, 11) + '…' : v.v}"`;
    case 'null':
      return 'null';
    case 'r': {
      const o = heap[v.id];
      if (!o) return 'obj';
      if (o.kind === 'array' && o.items.length <= 6 && o.items.every((x) => x.k === 'p'))
        return `[${o.items.map((x) => (x as { v: string }).v).join(',')}]`;
      return o.type;
    }
  }
}

// ------------------------------------------------------------ exceptions

/** "java.lang.NumberFormatException: For input string" -> "NumberFormatException". */
export function exceptionName(exception: string | undefined): string {
  if (!exception) return 'exception';
  const type = exception.split(':')[0].trim();
  return type.slice(type.lastIndexOf('.') + 1);
}

/**
 * On an exception step, the calls the exception ends early: every call above the one that catches
 * it, or every call if nothing does (the program stops). Library code catching it: none we can show.
 */
export function unwoundFrames(step: Step | undefined): Set<number> {
  const out = new Set<number>();
  if (!step || step.kind !== 'exception') return out;
  if (step.caught && step.catchFrame === undefined) return out;
  let above = !step.caught;
  for (const f of step.stack) {
    if (above) out.add(f.id);
    if (f.id === step.catchFrame) above = true;
  }
  return out;
}

/**
 * What kind of handler starts at `line`: a catch block, or a finally block (javac compiles finally
 * as a handler that catches everything, runs the block, then throws the exception on).
 */
export function handlerKind(code: string, line: number): 'catch' | 'finally' {
  const lines = code.split('\n');
  for (let i = Math.min(line, lines.length) - 1; i >= 0 && i >= line - 30; i--) {
    const text = lines[i].replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const m = text.match(/.*\b(catch|finally)\b/); // the last one on the line
    if (m) return m[1] as 'catch' | 'finally';
  }
  return 'catch';
}

// ------------------------------------------------------------ line counts

/** How many times each line has run, up to and including step `upto`. */
export function lineCounts(steps: Step[], upto: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i <= upto && i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== 'line') continue;
    counts.set(s.line, (counts.get(s.line) ?? 0) + 1);
  }
  return counts;
}

// ------------------------------------------------------------ array index pointers

// Names that almost always mean "a position in an array" (binary search's lo/hi are never inside [ ]).
const COMMON_INDEX_NAMES = ['i', 'j', 'k', 'lo', 'hi', 'low', 'high', 'mid', 'left', 'right', 'idx', 'index'];

/** Variable names used as array indexes in the code, e.g. nums[j + 1] -> "j", plus for-loop counters. */
export function indexVariableNames(code: string): Set<string> {
  const names = new Set(COMMON_INDEX_NAMES);
  for (const m of code.matchAll(/\[\s*([A-Za-z_]\w*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/for\s*\(\s*int\s+([A-Za-z_]\w*)\s*=/g)) names.add(m[1]);
  return names;
}

// ------------------------------------------------------------ Big-O growth experiments

export interface Vary {
  line: number; // 1-based
  name: string;
  from: number;
  to: number;
  substitute: (n: number) => string; // the whole program with the value replaced
}

/** Finds a line like `int n = 8; // @vary 1..20`. */
export function parseVary(code: string): Vary | null {
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(.*?\b(\w+)\s*=\s*)(-?\d+)(\s*;.*\/\/\s*@vary\s+(-?\d+)\s*\.\.\s*(-?\d+).*)$/);
    if (!m) continue;
    const [, before, name, , after, from, to] = m;
    return {
      line: i + 1,
      name,
      from: Number(from),
      to: Number(to),
      substitute: (n) => lines.map((l, j) => (j === i ? `${before}${n}${after}` : l)).join('\n'),
    };
  }
  return null;
}

/** Evenly spaced integer sample points between from and to (inclusive), without duplicates. */
export function samplePoints(from: number, to: number, count: number): number[] {
  if (to <= from) return [from];
  const pts = new Set<number>();
  for (let i = 0; i < count; i++) pts.add(Math.round(from + ((to - from) * i) / (count - 1)));
  return [...pts];
}

export const GROWTH_MODELS: { name: string; f: (n: number) => number }[] = [
  { name: 'O(1)', f: () => 1 },
  { name: 'O(log n)', f: (n) => Math.log2(Math.max(n, 1) + 1) },
  { name: 'O(n)', f: (n) => n },
  { name: 'O(n log n)', f: (n) => n * Math.log2(Math.max(n, 1) + 1) },
  { name: 'O(n²)', f: (n) => n * n },
  { name: 'O(n³)', f: (n) => n * n * n },
  { name: 'O(2ⁿ)', f: (n) => Math.pow(2, n) },
];

/**
 * Which growth model fits best? Fit count ≈ a + c·f(n) by least squares and pick the model with the
 * smallest relative error. The constant `a` absorbs fixed setup lines (printing, declarations...).
 */
export function bestFit(points: { n: number; count: number }[]) {
  if (points.length < 3) return null;
  let best: { name: string; a: number; c: number; err: number; f: (n: number) => number } | null = null;
  for (const m of GROWTH_MODELS.slice(1)) {
    const xs = points.map((p) => m.f(p.n));
    const ys = points.map((p) => p.count);
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = ys.reduce((s, y) => s + y, 0) / ys.length;
    const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    if (sxx === 0 || !isFinite(sxx)) continue;
    const c = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx;
    if (c <= 0) continue;
    const a = my - c * mx;
    const err = ys.reduce((s, y, i) => s + ((a + c * xs[i] - y) / Math.max(y, 1)) ** 2, 0);
    if (!best || err < best.err) best = { name: m.name, a, c, err, f: m.f };
  }
  const spread = Math.max(...points.map((p) => p.count)) - Math.min(...points.map((p) => p.count));
  if (spread <= 1) return { name: 'O(1)', a: points[0].count, c: 0, err: 0, f: () => 0 };
  return best;
}

// ------------------------------------------------------------ what changed between two steps

const MAX_CHANGES = 6;

/** The name a step's code uses for a heap object: the nearest frame's variable that points at it. */
function nameFor(step: Step, id: number): string | null {
  for (let i = step.stack.length - 1; i >= 0; i--) {
    const l = step.stack[i].locals.find((x) => x.v.k === 'r' && x.v.id === id && x.name !== 'this');
    if (l) return l.name;
  }
  const self = step.stack[step.stack.length - 1]?.locals.find((x) => x.name === 'this' && x.v.k === 'r' && x.v.id === id);
  return self ? 'this' : null;
}

const sameValue = (a: Value | undefined, b: Value | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** "3 → 6", or for references "→ another Node" (ids mean nothing to students). */
function changeText(name: string, from: Value, to: Value, prevHeap: Step['heap'], heap: Step['heap']): string {
  if (from.k === 'r' && to.k === 'r') return `${name} → another ${shortValue(to, heap)}`;
  return `${name}: ${shortValue(from, prevHeap)} → ${shortValue(to, heap)}`;
}

/**
 * A short, plain-words list of what happened between `prev` and `step`: calls made and returned,
 * variables set or changed, objects created, array cells / fields / map entries written.
 */
export function stepChanges(prev: Step | undefined, step: Step | undefined, isNew?: (id: number) => boolean): string[] {
  if (!prev || !step) return [];
  const out: string[] = [];
  const prevFrames = new Map(prev.stack.map((f) => [f.id, f]));
  const nowFrames = new Set(step.stack.map((f) => f.id));

  if (step.kind === 'exception') out.push(`throws ${exceptionName(step.exception)}`);
  // calls that returned, or were ended by an exception
  const unwound = unwoundFrames(prev);
  for (const f of prev.stack) {
    if (nowFrames.has(f.id)) continue;
    if (unwound.has(f.id)) out.push(`${f.method}() ended by ${exceptionName(prev.exception)}`);
    else out.push(f.ret !== undefined && f.ret !== null ? `${f.method}() returned ${shortValue(f.ret, prev.heap)}` : `${f.method}() returned`);
  }
  for (const f of step.stack) {
    const before = prevFrames.get(f.id);
    if (!before) {
      const args = f.locals.filter((l) => l.name !== 'this').map((l) => `${l.name}=${shortValue(l.v, step.heap)}`);
      out.push(`call ${f.method}(${args.join(', ')})`);
      continue;
    }
    const old = new Map(before.locals.map((l) => [l.name, l.v]));
    for (const l of f.locals) {
      const was = old.get(l.name);
      if (!was) out.push(`${l.name} = ${shortValue(l.v, step.heap)}`);
      else if (!sameValue(was, l.v)) out.push(changeText(l.name, was, l.v, prev.heap, step.heap));
    }
  }

  // static fields
  const prevStatics = new Map((prev.statics ?? []).flatMap((c) => c.fields.map((f) => [`${c.cls}.${f.name}`, f.v] as [string, Value])));
  for (const c of step.statics ?? []) {
    for (const f of c.fields) {
      const key = `${c.cls}.${f.name}`;
      const was = prevStatics.get(key);
      if (was && !sameValue(was, f.v)) out.push(changeText(key, was, f.v, prev.heap, step.heap));
    }
  }

  // heap objects: new ones, and writes into existing ones. Without `isNew` (see firstSeen): the debugger
  // numbers objects in the order it first sees them, so an id above every earlier one is a new object.
  const newestBefore = Math.max(0, ...Object.keys(prev.heap).map(Number));
  const created = isNew ?? ((id: number) => id > newestBefore);
  for (const [key, obj] of Object.entries(step.heap)) {
    const id = Number(key);
    const before = prev.heap[key];
    const name = nameFor(step, id) ?? obj.type;
    if (!before) {
      if (created(id)) {
        out.push(obj.kind === 'array' ? `new ${obj.type.replace(/\[\]$/, '')}[${obj.len}]` : `new ${obj.type}`);
      }
      continue;
    }
    if ((obj.kind === 'array' || obj.kind === 'list') && (before.kind === 'array' || before.kind === 'list')) {
      if (obj.len !== before.len) out.push(`${name} size ${before.len} → ${obj.len}`);
      else obj.items.forEach((v, i) => !sameValue(before.items[i], v) && out.push(`${name}[${i}] = ${shortValue(v, step.heap)}`));
    } else if (obj.kind === 'object' && before.kind === 'object') {
      const old = new Map(before.fields.map((f) => [f.name, f.v]));
      for (const f of obj.fields) {
        const was = old.get(f.name);
        if (was && !sameValue(was, f.v)) out.push(changeText(`${name}.${f.name}`, was, f.v, prev.heap, step.heap));
      }
    } else if (obj.kind === 'map' && before.kind === 'map') {
      const old = new Map(before.entries.map((e) => [JSON.stringify(e.k), e.v]));
      for (const e of obj.entries) {
        const was = old.get(JSON.stringify(e.k));
        if (!was || !sameValue(was, e.v)) out.push(`${name}[${shortValue(e.k, step.heap)}] = ${shortValue(e.v, step.heap)}`);
      }
      if (obj.len < before.len) out.push(`${name} size ${before.len} → ${obj.len}`);
    }
  }

  if (out.length > MAX_CHANGES) return [...out.slice(0, MAX_CHANGES - 1), `+${out.length - MAX_CHANGES + 1} more`];
  return out;
}

/** The step where each heap object first appears (objects can drop out of view and come back). */
export function firstSeen(steps: Step[]): Map<number, number> {
  const out = new Map<number, number>();
  steps.forEach((s, i) => Object.keys(s.heap).forEach((k) => out.has(Number(k)) || out.set(Number(k), i)));
  return out;
}

// ------------------------------------------------------------ a variable's history

/**
 * The numeric values a frame's variable has held, from the call's start up to step `upto`
 * (never later than the current step). Empty if it isn't a number.
 */
export function valueHistory(steps: Step[], frameId: number, name: string, upto: number): { step: number; v: number }[] {
  const out: { step: number; v: number }[] = [];
  for (let i = 0; i <= upto && i < steps.length; i++) {
    const f = steps[i].stack.find((x) => x.id === frameId);
    const l = f?.locals.find((x) => x.name === name);
    if (!l) continue;
    if (l.v.k !== 'p') return [];
    const n = Number(l.v.v);
    if (!Number.isFinite(n)) return []; // booleans, chars
    out.push({ step: i, v: n });
  }
  return out;
}
