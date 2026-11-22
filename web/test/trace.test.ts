import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { expandTrace, type RawStep } from '../src/trace.ts';
import type { Step, Value } from '../src/types.ts';
import { frame, int, intArray, local, step } from './fixtures.ts';

// Real traces from the server (`POST /run` on samples/<name>.java). To refresh them, run the server
// (./gradlew run) and save each response's {"delta":true,"steps":[...]}.
const dir = new URL('./traces/', import.meta.url);
const recorded = readdirSync(dir).map((f) => ({ name: f, raw: JSON.parse(readFileSync(new URL(f, dir), 'utf8')).steps as RawStep[] }));

/** The server's delta encoding (Tracer.snapshot), redone in JS: expanding then re-encoding must give back the input. */
function encode(steps: Step[]): RawStep[] {
  let frames = new Map<number, string>();
  let heap = new Map<string, string>();
  let statics = '';
  return steps.map((s) => {
    const { stack, heap: h, statics: st, ...rest } = s;
    const raw: RawStep = { ...rest, stack: [], heap: {} };
    const nextFrames = new Map<number, string>();
    for (const f of stack) {
      const json = JSON.stringify(f);
      nextFrames.set(f.id, json);
      raw.stack.push(frames.get(f.id) === json ? { id: f.id, same: 1 } : f);
    }
    frames = nextFrames;
    const staticsJson = st ? JSON.stringify(st) : '';
    if (st && staticsJson === statics) raw.staticsSame = 1;
    else if (st) raw.statics = st;
    statics = staticsJson;
    const nextHeap = new Map(Object.entries(h).map(([id, o]) => [id, JSON.stringify(o)]));
    for (const [id, json] of nextHeap) if (heap.get(id) !== json) raw.heap[id] = h[id];
    const gone = [...heap.keys()].filter((id) => !nextHeap.has(id)).map(Number);
    if (gone.length) raw.gone = gone;
    heap = nextHeap;
    return raw;
  });
}

for (const { name, raw } of recorded) {
  test(`${name}: expanding the server's delta trace is exact`, () => {
    const steps = expandTrace(raw);
    assert.equal(steps.length, raw.length);
    assert.deepEqual(encode(steps), raw);

    // every reference points at an object that's there (the server caps the heap at 150 objects)
    for (const [i, s] of steps.entries()) {
      if (Object.keys(s.heap).length >= 150) continue;
      const check = (v: Value | null | undefined) => {
        if (v?.k === 'r') assert.ok(s.heap[v.id], `step ${i}: object ${v.id} is missing`);
      };
      s.stack.forEach((f) => (f.locals.forEach((l) => check(l.v)), check(f.ret)));
      s.statics?.forEach((c) => c.fields.forEach((f) => check(f.v)));
      Object.values(s.heap).forEach((o) => {
        if (o.kind === 'object') o.fields.forEach((f) => check(f.v));
        if (o.kind === 'array' || o.kind === 'list') o.items.forEach(check);
        if (o.kind === 'map') o.entries.forEach((e) => (check(e.k), check(e.v)));
      });
    }
  });
}

test('the recorded traces exercise every part of the encoding', () => {
  const all = recorded.flatMap((r) => r.raw);
  assert.ok(all.some((s) => s.stack.some((f) => 'same' in f)), 'unchanged frames');
  assert.ok(all.some((s) => s.gone?.length), 'objects that went away');
  assert.ok(all.some((s) => s.staticsSame), 'unchanged statics');
  assert.ok(all.some((s) => s.statics), 'changed statics');
});

test('expandTrace shares unchanged parts and applies removals', () => {
  const main = frame(1, 'main', [local('x', int(1))]);
  const raw: RawStep[] = [
    { ...step([main], { 5: intArray(1), 6: intArray(2) }), statics: [{ cls: 'A', fields: [] }] },
    { kind: 'line', line: 2, out: 0, stack: [{ id: 1, same: 1 }], heap: { 6: intArray(3) }, gone: [5], staticsSame: 1 },
  ];
  const [a, b] = expandTrace(raw);
  assert.equal(b.stack[0], a.stack[0]); // the same object, not a copy
  assert.deepEqual(Object.keys(b.heap), ['6']);
  assert.deepEqual(b.heap[6], intArray(3));
  assert.deepEqual(a.heap[6], intArray(2)); // earlier steps are untouched
  assert.equal(b.statics, a.statics);
  assert.throws(() => expandTrace([{ kind: 'line', line: 1, out: 0, stack: [{ id: 9, same: 1 }], heap: {} }]), /frame 9/);
});
