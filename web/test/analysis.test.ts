import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestFit, buildCallTree, indexVariableNames, lineCounts, parseVary, samplePoints, shortValue } from '../src/analysis.ts';
import { frame, int, intArray, local, ref, step } from './fixtures.ts';

test('indexVariableNames finds bracket indexes and for-loop counters', () => {
  const names = indexVariableNames('for (int q = 0; q < n; q++) { if (nums[pos + 1] > 0) {} }');
  assert.ok(names.has('q'));
  assert.ok(names.has('pos'));
  assert.ok(names.has('mid')); // the common names are always there
  assert.ok(!names.has('n'));
});

test('lineCounts counts line steps up to and including the index', () => {
  const steps = [
    step([frame(1, 'main', [], { line: 3 })]),
    step([frame(1, 'main', [], { line: 4 })]),
    step([frame(1, 'main', [], { line: 3 })]),
    step([frame(1, 'main', [], { line: 3 })], {}, { kind: 'return' }),
  ];
  assert.deepEqual([...lineCounts(steps, 1)], [[3, 1], [4, 1]]);
  assert.deepEqual([...lineCounts(steps, 99)], [[3, 2], [4, 1]]); // the return step isn't a line run
});

test('buildCallTree links calls and records return values', () => {
  const main = frame(1, 'main', [local('args', ref(9))]);
  const fib2 = frame(2, 'fib', [local('n', int(2))]);
  const fib1 = frame(3, 'fib', [local('n', int(1))]);
  const steps = [
    step([main], { 9: intArray() }),
    step([main, fib2]),
    step([main, fib2, fib1]),
    step([main, fib2, { ...fib1, ret: int(1) }], {}, { kind: 'return' }),
    step([main, { ...fib2, ret: int(1) }], {}, { kind: 'return' }),
  ];
  const { nodes, root } = buildCallTree(steps);
  assert.equal(root, 1);
  assert.equal(nodes.get(1)!.args, ''); // main's args are left out
  assert.deepEqual(nodes.get(1)!.children, [2]);
  assert.deepEqual(nodes.get(2)!.children, [3]);
  assert.equal(nodes.get(3)!.args, 'n=1');
  assert.equal(nodes.get(3)!.returnStep, 3);
  assert.deepEqual(nodes.get(2)!.ret, int(1));
});

test('shortValue abbreviates strings and small arrays', () => {
  assert.equal(shortValue({ k: 's', v: 'abcdefghijklmnop' }, {}), '"abcdefghijk…"');
  assert.equal(shortValue(ref(1), { 1: intArray(1, 2, 3) }), '[1,2,3]');
  assert.equal(shortValue(undefined, {}), 'void');
});

test('parseVary finds the @vary line and substitutes values', () => {
  const code = 'class A {\n  int n = 8; // @vary 1..20\n}';
  const v = parseVary(code)!;
  assert.equal(v.line, 2);
  assert.equal(v.name, 'n');
  assert.deepEqual([v.from, v.to], [1, 20]);
  assert.equal(v.substitute(5).split('\n')[1], '  int n = 5; // @vary 1..20');
  assert.equal(parseVary('int n = 8;'), null);
});

test('samplePoints spreads points evenly without duplicates', () => {
  assert.deepEqual(samplePoints(1, 5, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(samplePoints(1, 3, 5), [1, 2, 3]);
  assert.deepEqual(samplePoints(4, 4, 5), [4]);
});

test('bestFit names the growth rate', () => {
  const pts = (f: (n: number) => number) => [2, 4, 8, 12, 16, 20].map((n) => ({ n, count: f(n) }));
  assert.equal(bestFit(pts((n) => 3 * n * n + 5))!.name, 'O(n²)');
  assert.equal(bestFit(pts((n) => 4 * n + 2))!.name, 'O(n)');
  assert.equal(bestFit(pts(() => 7))!.name, 'O(1)');
  assert.equal(bestFit(pts((n) => 2 ** n))!.name, 'O(2ⁿ)');
  assert.equal(bestFit([{ n: 1, count: 1 }]), null);
});
