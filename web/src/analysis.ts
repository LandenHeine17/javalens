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
