import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestFit, buildCallTree, indexVariableNames, lineCounts, firstSeen, parseVary, samplePoints, shortValue, stepChanges, valueHistory } from '../src/analysis.ts';
import { frame, int, intArray, local, nul, ref, step } from './fixtures.ts';
import type { Value } from '../src/types.ts';

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

test('stepChanges describes calls, variables and heap writes in plain words', () => {
  const main = (sum: number, extra: ReturnType<typeof local>[] = []) => frame(1, 'main', [local('a', ref(10)), local('sum', int(sum)), ...extra]);
  const node = (next: Value) => ({ kind: 'object' as const, type: 'Node', fields: [{ name: 'next', type: 'Node', v: next }] });

  assert.deepEqual(stepChanges(undefined, step([main(0)])), []);
  // a variable changes and an array cell is written
  assert.deepEqual(
    stepChanges(step([main(3)], { 10: intArray(1, 2) }), step([main(6)], { 10: intArray(1, 5) })),
    ['sum: 3 → 6', 'a[1] = 5'],
  );
  // a new variable, a new object, and a field pointing somewhere else
  assert.deepEqual(
    stepChanges(
      step([main(0, [local('n', ref(11))])], { 10: intArray(), 11: node(nul) }),
      step([main(0, [local('n', ref(11)), local('m', ref(12))])], { 10: intArray(), 11: node(ref(12)), 12: node(nul) }),
    ),
    ['m = Node', 'n.next: null → Node', 'new Node'],
  );
  // a call, then its return
  const callee = frame(2, 'fib', [local('n', int(4))]);
  assert.deepEqual(stepChanges(step([main(0)]), step([main(0), callee])), ['call fib(n=4)']);
  assert.deepEqual(stepChanges(step([main(0), { ...callee, ret: int(3) }], {}, { kind: 'return' }), step([main(0)])), ['fib() returned 3']);
  // an object that drops out of view and comes back isn't new again
  const back = [step([main(0, [local('n', ref(11))])], { 10: intArray(), 11: node(nul) }), step([main(0)], { 10: intArray() }), step([main(0, [local('n', ref(11))])], { 10: intArray(), 11: node(nul) })];
  const born = firstSeen(back);
  assert.deepEqual(stepChanges(back[1], back[2], (id) => born.get(id) === 2), ['n = Node']);
  // long lists are cut short
  const many = stepChanges(step([main(0)], { 10: intArray(0, 0, 0, 0, 0, 0, 0, 0) }), step([main(0)], { 10: intArray(1, 2, 3, 4, 5, 6, 7, 8) }));
  assert.equal(many.length, 6);
  assert.equal(many.at(-1), '+3 more');
});

test('valueHistory follows one call\'s variable and never looks ahead', () => {
  const steps = [0, 1, 1, 3, 6].map((v) => step([frame(1, 'main', [local('sum', int(v))])]));
  steps.splice(2, 0, step([frame(1, 'main', [])])); // a step where it's out of scope
  assert.deepEqual(valueHistory(steps, 1, 'sum', 3).map((p) => p.v), [0, 1, 1]);
  assert.deepEqual(valueHistory(steps, 1, 'sum', 99).map((p) => p.step), [0, 1, 3, 4, 5]);
  assert.deepEqual(valueHistory(steps, 2, 'sum', 99), []); // another call
  const bools = [step([frame(1, 'main', [local('ok', { k: 'p', v: 'true' })])])];
  assert.deepEqual(valueHistory(bools, 1, 'ok', 0), []);
});
