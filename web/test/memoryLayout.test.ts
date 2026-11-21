import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARRAY_HEADER, CODE_BASE, STACK_TOP, buildLayout, hex, stackBottom, typeSize } from '../src/memoryLayout.ts';
import { frame, int, intArray, local, ref, step, str } from './fixtures.ts';

test('typeSize uses primitive sizes and 8 for references', () => {
  assert.equal(typeSize('int'), 4);
  assert.equal(typeSize('double'), 8);
  assert.equal(typeSize('boolean'), 1);
  assert.equal(typeSize('Node'), 8);
  assert.equal(typeSize(undefined), 8);
});

test('hex splits addresses into two groups', () => {
  assert.equal(hex(0x1000_0040), '0x1000_0040');
});

test('code segment sizes methods by their bytecode', () => {
  const layout = buildLayout([], [{ cls: 'Main', methods: [{ name: 'main', sig: '()', bytes: 10 }, { name: 'f', sig: '(I)', bytes: 3 }] }]);
  const [block] = layout.code;
  assert.equal(block.addr, CODE_BASE);
  assert.equal(block.methods[1].addr, CODE_BASE + 12); // 10 rounded up to 4
  assert.ok(layout.staticStart >= layout.codeEnd);
});

test('frames and objects keep their address while stepping', () => {
  const main = (x: number) => frame(1, 'main', [local('x', int(x)), local('a', ref(7), 'int[]')]);
  const steps = [
    step([main(1)], { 7: intArray(1, 2, 3) }),
    step([main(2), frame(2, 'f', [local('n', int(5))])], { 7: intArray(9, 2, 3) }),
    step([main(3)], { 7: intArray(9, 2, 3) }),
  ];
  const layout = buildLayout(steps);
  const arr = layout.objects.get(7)!;
  assert.equal(arr.size, 32); // 16 header + 3 * 4, aligned to 8
  assert.equal(arr.slots[1].addr, arr.addr + ARRAY_HEADER + 4);
  assert.equal(arr.born, 0);
  assert.equal((arr.last as { items: unknown[] }).items.length, 3);

  const mainFrame = layout.frames.get(1)!;
  const fFrame = layout.frames.get(2)!;
  assert.equal(mainFrame.base, STACK_TOP);
  assert.equal(fFrame.base, STACK_TOP - mainFrame.size); // the stack grows down
  assert.equal(stackBottom(layout, steps[1]), fFrame.base - fFrame.size);
  assert.equal(stackBottom(layout, steps[2]), STACK_TOP - mainFrame.size);
});

test('pooled strings sit at the start of the heap', () => {
  const steps = [step([frame(1, 'main', [local('s', str('hi', 3, true)), local('t', str('new', 4))])])];
  const layout = buildLayout(steps);
  assert.equal(layout.objects.get(3)!.addr, layout.heapStart);
  assert.ok(layout.objects.get(3)!.pooled);
  assert.ok(layout.objects.get(4)!.addr >= layout.poolEnd);
});
