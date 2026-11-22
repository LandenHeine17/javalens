import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridIndexVars, gridPointers, gridRows } from '../src/grid.ts';
import { frame, int, intArray, local, nul, ref, step } from './fixtures.ts';
import type { HeapObj } from '../src/types.ts';

const grid = (...rows: (number | null)[]): HeapObj => ({
  kind: 'array', type: 'int[][]', len: rows.length, items: rows.map((r) => (r === null ? nul : ref(r))),
});

test('gridRows recognises 2D arrays of simple values, ragged and with null rows', () => {
  const heap = { 1: grid(2, 3, null), 2: intArray(1, 2), 3: intArray(4, 5, 6) };
  assert.deepEqual(gridRows(heap, 1), [2, 3, null]);
  assert.equal(gridRows(heap, 2), null); // a plain int[]
  assert.equal(gridRows({ 1: grid(2) }, 1), null); // a row isn't on the heap
  assert.equal(gridRows({ 1: grid(null) }, 1), null); // no rows at all
  // arrays of objects are drawn as before
  assert.equal(gridRows({ 1: { ...grid(2), type: 'Node[][]' }, 2: { kind: 'array', type: 'Node[]', len: 1, items: [ref(9)] } }, 1), null);
  // cut short by the tracer's item limit
  assert.equal(gridRows({ 1: { ...grid(2), len: 200 }, 2: intArray(1) }, 1), null);
});

test('gridIndexVars reads row and column variables from the source', () => {
  const vars = gridIndexVars('dp[i][j] = dp[i - 1][j] + dp[i][j - 1]; // board[x][y]\n/* m[a][b] */ grid[r][c] = 0; print(dp[n - 1][m - 1]);');
  assert.deepEqual([...vars.get('dp')!.rows], ['i']); // not n: only ever used as n - 1
  assert.deepEqual([...vars.get('dp')!.cols], ['j']);
  assert.deepEqual([...vars.get('grid')!.rows], ['r']);
  assert.ok(!vars.has('board') && !vars.has('m')); // comments are ignored
});

test('gridPointers marks the running method\'s row and column variables', () => {
  const heap = { 1: grid(2, 3), 2: intArray(0, 0, 0), 3: intArray(0, 0, 0) };
  const s = step([frame(1, 'main', [local('dp', ref(1), 'int[][]'), local('i', int(1)), local('j', int(3)), local('n', int(2))])], heap);
  const p = gridPointers(s, 1, gridIndexVars('dp[i][j] = 1;'));
  assert.deepEqual([...p.rows], [[1, ['i']]]);
  assert.deepEqual([...p.cols], [[3, ['j']]]); // one past the end is allowed (loop finished)

  // no source info: i/j by convention
  const q = gridPointers(s, 1, new Map());
  assert.deepEqual([...q.rows], [[1, ['i']]]);

  // a method that can't see the grid gets no pointers
  const other = step([...s.stack, frame(2, 'helper', [local('i', int(0))])], heap);
  assert.equal(gridPointers(other, 1, new Map()).rows.size, 0);
});
