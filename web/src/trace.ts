// The server sends a trace as deltas (see Tracer.snapshot): each step carries only the stack frames
// and heap objects that changed since the previous step. This turns it back into full steps; parts
// that didn't change are shared between steps, so a long run stays small in memory too.
import type { Frame, HeapObj, RunResult, StaticClass, Step } from './types';

export type RawFrame = Frame | { id: number; same: 1 };

export interface RawStep extends Omit<Step, 'stack' | 'heap' | 'statics'> {
  stack: RawFrame[];
  heap: Record<string, HeapObj>; // new or changed objects
  gone?: number[]; // objects present on the previous step but not this one
  statics?: StaticClass[];
  staticsSame?: 1; // same static fields as the previous step
}

/** Full steps from the server's delta-encoded steps. */
export function expandTrace(raw: RawStep[]): Step[] {
  const out: Step[] = [];
  let frames = new Map<number, Frame>();
  let heap: Record<string, HeapObj> = {};
  let statics: StaticClass[] | undefined;
  for (const r of raw) {
    const { gone, staticsSame, stack: rawStack, heap: changed, statics: rawStatics, ...rest } = r;
    const stack = rawStack.map((f) => {
      if (!('same' in f)) return f;
      const before = frames.get(f.id);
      if (!before) throw new Error(`trace: frame ${f.id} marked unchanged but never sent`);
      return before;
    });
    frames = new Map(stack.map((f) => [f.id, f]));
    heap = { ...heap };
    for (const id of gone ?? []) delete heap[id];
    Object.assign(heap, changed);
    statics = staticsSame ? statics : rawStatics;
    const step: Step = { ...rest, stack, heap };
    if (statics) step.statics = statics;
    out.push(step);
  }
  return out;
}

/** POST /run and return the result with full steps. */
export async function fetchRun(body: Record<string, string>, signal?: AbortSignal): Promise<RunResult> {
  const res = await fetch('/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json();
  if (data.ok && data.delta) data.steps = expandTrace(data.steps);
  return data as RunResult;
}
