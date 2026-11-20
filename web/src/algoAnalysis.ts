// Sorting & searching, worked out from a trace (no server help): which array is being sorted or
// searched, what each step compares, writes and swaps, the range each recursive call works on,
// and running counters. Used by the "Sort & Search" tab (AlgoView.tsx) and its Race mode.
import type { Frame, HeapObj, Step, Value } from './types';

export type Cell = number | string;

/** An array (or list) as plain values: numbers when they're numeric, otherwise their text. */
export function cellsOf(obj: HeapObj | undefined): Cell[] | null {
  if (!obj || !(obj.kind === 'array' || (obj.kind === 'list' && (obj.role ?? 'list') === 'list'))) return null;
  return obj.items.map((v) => {
    if (v.k === 'p') {
      const n = Number(v.v);
      return Number.isFinite(n) ? n : v.v;
    }
    if (v.k === 's') return v.v;
    if (v.k === 'null') return 'null';
    return '•';
  });
}

const isNumeric = (cells: Cell[]) => cells.every((c) => typeof c === 'number');

/** Arrays a frame can see by variable name: name -> heap id. */
function frameArrays(f: Frame, step: Step): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of f.locals) {
    if (l.v.k === 'r' && cellsOf(step.heap[l.v.id])) out.set(l.name, l.v.id);
  }
  return out;
}

/**
 * The arrays worth showing, by variable name, best first: arrays held by main (longest first),
 * then arrays held anywhere else. The first one is the default focus.
 */
export function candidateArrays(steps: Step[]): string[] {
  const score = new Map<string, number>();
  for (const step of steps) {
    step.stack.forEach((f, depth) => {
      for (const [name, id] of frameArrays(f, step)) {
        const cells = cellsOf(step.heap[id])!;
        if (name === 'args' && cells.length === 0) continue;
        // main's arrays first, numeric before text, then longer before shorter
        const s = (depth === 0 ? 1e6 : 0) + (isNumeric(cells) ? 1e5 : 0) + cells.length;
        score.set(name, Math.max(score.get(name) ?? 0, s));
      }
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

/** The heap id of the focus array at this step: main's variable of that name, else the nearest frame's. */
export function focusId(step: Step, name: string): number | null {
  const frames = [step.stack[0], ...[...step.stack].reverse()];
  for (const f of frames) {
    if (!f) continue;
    const id = frameArrays(f, step).get(name);
    if (id !== undefined) return id;
  }
  return null;
}

// ------------------------------------------------------------ reading source lines

/** A source line with comments and string/char literals blanked out. */
function codeOnly(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

const ACCESS = /([A-Za-z_]\w*)\s*\[([^\][]+)\]|([A-Za-z_]\w*)\s*\.\s*get\s*\(([^()]+)\)/g;

/** Does this line compare values read from an array or list? (a[j] > a[j+1], arr[mid] == target, ...) */
export function isComparisonLine(line: string): boolean {
  const code = codeOnly(line);
  if (/\.compareTo\s*\(/.test(code)) return true;
  if (!/\[[^\]]+\]|\.get\s*\(/.test(code)) return false;
  // a relational operator outside the brackets (not a generic like ArrayList<Integer>, not << >>)
  const outside = code.replace(/\[[^\]]*\]/g, '[]').replace(/<\s*[A-Z]\w*(\s*,\s*[A-Z]\w*)*\s*>/g, '');
  return /(<=|>=|==|!=|(?<![<>])<(?![<=])|(?<![<>-])>(?![>=]))/.test(outside);
}

/** Evaluates a small index expression like "j + 1", "mid", "hi - 1", "(lo + hi) / 2" with the given ints. */
export function evalIndex(expr: string, vars: Map<string, number>): number | null {
  const tokens = expr.match(/\d+|[A-Za-z_]\w*|[-+*/()]/g);
  if (!tokens || tokens.join('').length !== expr.replace(/\s+/g, '').length) return null;
  let pos = 0;
  const atom = (): number | null => {
    const t = tokens[pos++];
    if (t === undefined) return null;
    if (t === '(') {
      const v = sum();
      return tokens[pos++] === ')' ? v : null;
    }
    if (t === '-') {
      const v = atom();
      return v === null ? null : -v;
    }
    if (/^\d+$/.test(t)) return Number(t);
    return vars.has(t) ? vars.get(t)! : null;
  };
  const product = (): number | null => {
    let v = atom();
    while (v !== null && (tokens[pos] === '*' || tokens[pos] === '/')) {
      const op = tokens[pos++];
      const r = atom();
      if (r === null || (op === '/' && r === 0)) return null;
      v = op === '*' ? v * r : Math.trunc(v / r);
    }
    return v;
  };
  const sum = (): number | null => {
    let v = product();
    while (v !== null && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++];
      const r = product();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return pos === tokens.length ? v : null;
}

/** int variables of a frame (for evaluating indexes). */
export function intVars(f: Frame | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of f?.locals ?? []) {
    if (l.v.k === 'p' && /^-?\d+$/.test(l.v.v)) out.set(l.name, Number(l.v.v));
  }
  return out;
}

/** Cells a comparison line reads: array heap id -> indexes. */
function readsOnLine(line: string, f: Frame, step: Step): Map<number, number[]> {
  const arrays = frameArrays(f, step);
  const vars = intVars(f);
  const out = new Map<number, number[]>();
  for (const m of codeOnly(line).matchAll(ACCESS)) {
    const name = m[1] ?? m[3];
    const id = arrays.get(name);
    if (id === undefined) continue;
    const idx = evalIndex((m[2] ?? m[4]).trim(), vars);
    const len = cellsOf(step.heap[id])?.length ?? 0;
    if (idx === null || idx < 0 || idx >= len) continue;
    out.set(id, [...(out.get(id) ?? []), idx]);
  }
  return out;
}

// ------------------------------------------------------------ ranges (lo..hi of each call)

const RANGE_PAIRS: [string, string][] = [
  ['lo', 'hi'], ['low', 'high'], ['left', 'right'], ['start', 'end'], ['first', 'last'], ['l', 'r'], ['begin', 'end'],
];

export interface Range {
  frameId: number;
  method: string;
  lo: number;
  hi: number;
  mid?: number;
}

/** For every frame working on the array (it holds a reference to it), its lo..hi pair if it has one. */
export function ranges(step: Step, arrayId: number): Range[] {
  const out: Range[] = [];
  for (const f of step.stack) {
    if (![...frameArrays(f, step).values()].includes(arrayId)) continue;
    const vars = intVars(f);
    const pair = RANGE_PAIRS.find(([a, b]) => vars.has(a) && vars.has(b));
    if (!pair) continue;
    out.push({ frameId: f.id, method: f.method, lo: vars.get(pair[0])!, hi: vars.get(pair[1])!, mid: vars.get('mid') });
  }
  return out;
}

const TARGET_NAMES = ['target', 'key', 'value', 'val', 'x', 'needle', 'search', 'goal'];

/** The value being searched for, if the running call has one. Insertion sort's `key` doesn't count (no writes check here). */
export function searchTarget(step: Step): { name: string; value: string } | null {
  const top = step.stack[step.stack.length - 1];
  for (const name of TARGET_NAMES) {
    const l = top?.locals.find((x) => x.name === name);
    if (l && l.v.k === 'p') return { name, value: l.v.v };
    if (l && l.v.k === 's') return { name, value: `"${l.v.v}"` };
  }
  return null;
}

// ------------------------------------------------------------ the whole run

export interface RunAnalysis {
  focus: string | null; // variable name of the array being sorted / searched
  ids: (number | null)[]; // its heap id at each step
  cells: (Cell[] | null)[]; // its contents at each step
  comparisons: number[]; // cumulative, per step
  writes: number[];
  swaps: number[];
  compared: Map<number, number[]>[]; // per step: array id -> indexes read by this step's comparison
  written: number[][]; // per step: focus indexes written since the previous step
  swapped: ([number, number] | null)[]; // per step: the pair a swap just completed
  settledFrom: number[]; // per index: the step from which the cell holds its final value for good (Infinity = never)
  sorting: boolean; // did the run write to the array at all (a sort) or only read it (a search)?
  numeric: boolean;
  min: number;
  max: number;
}

/**
 * Walks the run once. `lineOf(step)` returns the source line that step is about to run
 * (taking multi-file programs into account).
 */
export function analyzeRun(steps: Step[], focus: string | null, lineOf: (step: Step) => string): RunAnalysis {
  const n = steps.length;
  const a: RunAnalysis = {
    focus, ids: [], cells: [], comparisons: [], writes: [], swaps: [], compared: [], written: [], swapped: [],
    settledFrom: [], sorting: false, numeric: true, min: Infinity, max: -Infinity,
  };
  let comparisons = 0, writes = 0, swaps = 0;
  let pending: { idx: number; from: Cell; to: Cell; step: number }[] = [];
  const lastWrite: number[] = [];

  for (let i = 0; i < n; i++) {
    const step = steps[i];
    const id = focus ? focusId(step, focus) : null;
    const cells = id !== null ? cellsOf(step.heap[id]) : null;
    a.ids.push(id);
    a.cells.push(cells);
    if (cells) {
      if (!isNumeric(cells)) a.numeric = false;
      for (const c of cells) if (typeof c === 'number') (a.min = Math.min(a.min, c)), (a.max = Math.max(a.max, c));
    }

    // what this step's line compares
    const top = step.stack[step.stack.length - 1];
    let reads = new Map<number, number[]>();
    if (step.kind === 'line' && top) {
      const line = lineOf(step);
      if (isComparisonLine(line)) {
        comparisons++;
        reads = readsOnLine(line, top, step);
      }
    }
    a.compared.push(reads);

    // what changed in the array since the previous step
    const prevCells = i > 0 && a.ids[i - 1] === id ? a.cells[i - 1] : null;
    const written: number[] = [];
    let swapped: [number, number] | null = null;
    if (cells && prevCells && prevCells.length === cells.length) {
      for (let k = 0; k < cells.length; k++) {
        if (cells[k] === prevCells[k]) continue;
        written.push(k);
        writes++;
        lastWrite[k] = i;
        // a swap: a[x] went p->q earlier and now a[k] goes q->p
        const match = pending.findIndex((w) => w.idx !== k && w.to === prevCells[k] && w.from === cells[k]);
        if (match >= 0) {
          swaps++;
          swapped = [pending[match].idx, k];
          pending.splice(match, 1);
        } else {
          pending.push({ idx: k, from: prevCells[k], to: cells[k], step: i });
        }
      }
      pending = pending.filter((w) => i - w.step <= 4);
    }
    if (written.length) a.sorting = true;
    a.written.push(written);
    a.swapped.push(swapped);
    a.comparisons.push(comparisons);
    a.writes.push(writes);
    a.swaps.push(swaps);
  }

  // A cell is settled once it holds its final value and is never written again.
  const final = [...a.cells].reverse().find((c) => c) ?? [];
  a.settledFrom = final.map((_, k) => lastWrite[k] ?? 0);
  if (!Number.isFinite(a.min)) (a.min = 0), (a.max = 1);
  return a;
}

/** Index-like int variables of the frame pointing into an array of this length: index -> names. */
export function pointersFor(f: Frame | undefined, len: number, names: Set<string>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [name, v] of intVars(f)) {
    if (!names.has(name) || v < 0 || v > len) continue;
    out.set(v, [...(out.get(v) ?? []), name]);
  }
  return out;
}

/**
 * Which variables index which array, from how the source uses them: `left[i]` makes i a pointer
 * into left, `arr[k]` makes k one into arr. Keyed by the array variable's name.
 */
export function indexVarsByArray(sources: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const src of sources) {
    for (const line of src.split('\n')) {
      for (const m of codeOnly(line).matchAll(ACCESS)) {
        const name = m[1] ?? m[3];
        const vars = (m[2] ?? m[4]).match(/[A-Za-z_]\w*/g) ?? [];
        if (!out.has(name)) out.set(name, new Set());
        vars.forEach((v) => out.get(name)!.add(v));
      }
    }
  }
  return out;
}

/** The pointer names for an array: variables used to index it under any of its names, else all index-like names. */
export function pointerNamesFor(arrayNames: string[], byArray: Map<string, Set<string>>, fallback: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const a of arrayNames) byArray.get(a)?.forEach((v) => names.add(v));
  return names.size ? names : fallback;
}

/** Names a frame uses for the array with this heap id (arr, nums, a...). */
export function namesOf(f: Frame | undefined, id: number): string[] {
  return (f?.locals ?? []).filter((l) => l.v.k === 'r' && l.v.id === id).map((l) => l.name);
}

/** Arrays the running call holds besides the focus (merge sort's left/right/temp...): name -> id. */
export function helperArrays(step: Step, focus: number | null): [string, number][] {
  const top = step.stack[step.stack.length - 1];
  if (!top) return [];
  return [...frameArrays(top, step).entries()].filter(([name, id]) => id !== focus && !(name === 'args' && top.method === 'main'));
}

/** The first array literal in a program, e.g. "{38, 27, 43}" of `int[] arr = {38, 27, 43};` */
export const ARRAY_LITERAL = /(\b(?:int|long|double|float|short|byte|Integer|Double)\s*\[\]\s*\w+\s*=\s*(?:new\s+\w+\s*\[\]\s*)?)\{([^{}]*)\}/;

/** Program B with its first array literal replaced by program A's, so a race uses the same input. */
export function withSameInput(a: string, b: string): string | null {
  const ma = ARRAY_LITERAL.exec(a);
  if (!ma || !ARRAY_LITERAL.test(b)) return null;
  return b.replace(ARRAY_LITERAL, (_, head: string) => `${head}{${ma[2]}}`);
}

/** Value of a Value as short text (for labels). */
export function valueText(v: Value | undefined): string {
  if (!v) return '';
  if (v.k === 'p') return v.v;
  if (v.k === 's') return `"${v.v}"`;
  return v.k === 'null' ? 'null' : '…';
}
