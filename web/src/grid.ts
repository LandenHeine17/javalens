// 2D arrays (int[][], char[][], String[][]...) drawn as a grid instead of an array of arrays:
// which heap objects are grids, and which variables point at a row or a column.
import type { Step, Value } from './types';

/**
 * The row arrays of a 2D array (heap ids, null for a null row), or null if `id` isn't a 2D array
 * of simple values whose rows are all on the heap. Rows may have different lengths (ragged).
 */
export function gridRows(heap: Step['heap'], id: number): (number | null)[] | null {
  const o = heap[id];
  if (!o || o.kind !== 'array' || !o.type.endsWith('[][]') || o.items.length === 0 || o.items.length < o.len) return null;
  const rows: (number | null)[] = [];
  for (const v of o.items) {
    if (v.k === 'null') {
      rows.push(null);
      continue;
    }
    if (v.k !== 'r') return null;
    const row = heap[v.id];
    if (!row || row.kind !== 'array' || row.items.some((x) => x.k === 'r')) return null;
    rows.push(v.id);
  }
  return rows.some((r) => r !== null) ? rows : null;
}

export interface GridVars {
  rows: Set<string>;
  cols: Set<string>;
}

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Which variables index each 2D array, from the source: `dp[i][j]` makes i a row variable and j a
 * column variable of dp. Only a variable used on its own as an index counts, so the sizes in
 * `dp[rows - 1][cols - 1]` aren't mistaken for positions. Keyed by the array's variable (or field) name.
 */
export function gridIndexVars(code: string): Map<string, GridVars> {
  const out = new Map<string, GridVars>();
  for (const m of stripComments(code).matchAll(/([A-Za-z_]\w*)\s*\[([^[\]]+)\]\s*\[([^[\]]+)\]/g)) {
    const [, name, r, c] = m;
    if (!out.has(name)) out.set(name, { rows: new Set(), cols: new Set() });
    const g = out.get(name)!;
    if (/^\s*[A-Za-z_]\w*\s*$/.test(r)) g.rows.add(r.trim());
    if (/^\s*[A-Za-z_]\w*\s*$/.test(c)) g.cols.add(c.trim());
  }
  return out;
}

const FALLBACK: GridVars = { rows: new Set(['i', 'r', 'row']), cols: new Set(['j', 'c', 'col']) };

export interface GridPointers {
  rows: Map<number, string[]>; // row index -> variable names
  cols: Map<number, string[]>; // column index -> variable names
}

/**
 * Row and column pointers for a grid, from the running method's int variables: the ones the source
 * uses to index this grid (under any name the method has for it), else i/r/row and j/c/col.
 */
export function gridPointers(step: Step, gridId: number, vars: Map<string, GridVars>): GridPointers {
  const result: GridPointers = { rows: new Map(), cols: new Map() };
  const top = step.stack[step.stack.length - 1];
  const rows = gridRows(step.heap, gridId);
  if (!top || !rows) return result;

  // Names the running method uses for this grid: its variables, and fields of `this`.
  const names = top.locals.filter((l) => l.v.k === 'r' && l.v.id === gridId).map((l) => l.name);
  const self = top.locals.find((l) => l.name === 'this');
  if (self?.v.k === 'r') {
    const o = step.heap[self.v.id];
    if (o?.kind === 'object') o.fields.forEach((f) => f.v.k === 'r' && f.v.id === gridId && names.push(f.name));
  }
  if (!names.length) return result; // another method's grid: its loop variables aren't in scope here

  const rowNames = new Set<string>(), colNames = new Set<string>();
  for (const n of names) {
    vars.get(n)?.rows.forEach((v) => rowNames.add(v));
    vars.get(n)?.cols.forEach((v) => colNames.add(v));
  }
  const use = rowNames.size || colNames.size ? { rows: rowNames, cols: colNames } : FALLBACK;

  const width = Math.max(...rows.map((id) => (id === null ? 0 : (step.heap[id] as { len: number }).len)));
  const add = (m: Map<number, string[]>, i: number, name: string) => m.set(i, [...(m.get(i) ?? []), name]);
  for (const l of top.locals) {
    if (l.v.k !== 'p' || !/^-?\d+$/.test(l.v.v)) continue;
    const i = Number(l.v.v);
    if (use.rows.has(l.name) && i >= 0 && i <= rows.length) add(result.rows, i, l.name);
    if (use.cols.has(l.name) && i >= 0 && i <= width) add(result.cols, i, l.name);
  }
  return result;
}

/** Text for one grid cell. */
export function cellText(v: Value): string {
  if (v.k === 'p') return v.v;
  if (v.k === 's') return `"${v.v}"`;
  return v.k === 'null' ? 'null' : '•';
}
