import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeRun, candidateArrays, cellsOf, evalIndex, indexVarsByArray, isComparisonLine, ranges, withSameInput,
} from '../src/algoAnalysis.ts';
import { frame, int, intArray, local, ref, step } from './fixtures.ts';

test('cellsOf turns arrays into plain values', () => {
  assert.deepEqual(cellsOf(intArray(3, 1)), [3, 1]);
  assert.deepEqual(cellsOf({ kind: 'array', type: 'String[]', len: 2, items: [{ k: 's', v: 'a' }, { k: 'null' }] }), ['a', 'null']);
  assert.equal(cellsOf({ kind: 'object', type: 'Node', fields: [] }), null);
});

test('isComparisonLine spots comparisons between array reads', () => {
  assert.ok(isComparisonLine('if (a[j] > a[j + 1]) {'));
  assert.ok(isComparisonLine('while (arr[mid] != target)'));
  assert.ok(isComparisonLine('if (list.get(i).compareTo(x) < 0)'));
  assert.ok(!isComparisonLine('a[j] = a[j + 1];'));
  assert.ok(!isComparisonLine('List<Integer> xs = new ArrayList<Integer>(a[0]);'));
  assert.ok(!isComparisonLine('// if (a[0] > a[1])'));
});

test('evalIndex evaluates small index expressions', () => {
  const vars = new Map([['lo', 2], ['hi', 9], ['j', 4]]);
  assert.equal(evalIndex('j + 1', vars), 5);
  assert.equal(evalIndex('(lo + hi) / 2', vars), 5);
  assert.equal(evalIndex('hi - -1', vars), 10);
  assert.equal(evalIndex('j / 0', vars), null);
  assert.equal(evalIndex('unknown', vars), null);
  assert.equal(evalIndex('a.length', vars), null);
});

test('analyzeRun counts comparisons, writes and swaps', () => {
  const main = (arr: number[], j: number) => step([frame(1, 'main', [local('a', ref(5)), local('j', int(j))])], { 5: intArray(...arr) });
  const lines = ['if (a[j] > a[j + 1]) {', 'int t = a[j];', 'a[j] = a[j + 1];', 'a[j + 1] = t;', 'done'];
  const steps = [main([3, 1], 0), main([3, 1], 0), main([1, 1], 0), main([1, 3], 0), main([1, 3], 0)];
  const a = analyzeRun(steps, 'a', (s) => lines[steps.indexOf(s)]);
  assert.equal(a.comparisons.at(-1), 1);
  assert.deepEqual([...a.compared[0].entries()], [[5, [0, 1]]]);
  assert.equal(a.writes.at(-1), 2);
  assert.equal(a.swaps.at(-1), 1);
  assert.deepEqual(a.swapped[3], [0, 1]);
  assert.ok(a.sorting);
  assert.deepEqual([a.min, a.max], [1, 3]);
});

test('candidateArrays prefers main\'s arrays and skips empty args', () => {
  const steps = [
    step(
      [frame(1, 'main', [local('args', ref(1)), local('nums', ref(2))]), frame(2, 'helper', [local('tmp', ref(3))])],
      { 1: intArray(), 2: intArray(5, 4, 3), 3: intArray(1, 2, 3, 4, 5, 6) },
    ),
  ];
  assert.deepEqual(candidateArrays(steps), ['nums', 'tmp']);
});

test('ranges reads each call\'s lo..hi', () => {
  const s = step([frame(1, 'main', [local('a', ref(5))]), frame(2, 'sort', [local('a', ref(5)), local('lo', int(0)), local('hi', int(3))])], {
    5: intArray(4, 3, 2, 1),
  });
  assert.deepEqual(ranges(s, 5), [{ frameId: 2, method: 'sort', lo: 0, hi: 3, mid: undefined }]);
});

test('indexVarsByArray and withSameInput read the source', () => {
  const by = indexVarsByArray(['left[i] = arr[k + 1];']);
  assert.deepEqual([...by.get('left')!], ['i']);
  assert.deepEqual([...by.get('arr')!], ['k']);
  assert.equal(withSameInput('int[] a = {5, 2, 9};', 'int[] xs = {1};\nint[] ys = {2};'), 'int[] xs = {5, 2, 9};\nint[] ys = {2};');
  assert.equal(withSameInput('no array', 'int[] xs = {1};'), null);
});
