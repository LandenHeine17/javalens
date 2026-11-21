// Small hand-built traces for the unit tests (same shapes the server sends; see src/types.ts).
import type { Frame, HeapObj, Local, Step, Value } from '../src/types.ts';

export const int = (n: number | string): Value => ({ k: 'p', v: String(n) });
export const str = (s: string, id?: number, pool?: boolean): Value => ({ k: 's', v: s, id, pool });
export const ref = (id: number): Value => ({ k: 'r', id });
export const nul: Value = { k: 'null' };

export const local = (name: string, v: Value, type = v.k === 'p' ? 'int' : 'Object'): Local => ({ name, type, v });

export function frame(id: number, method: string, locals: Local[], extra: Partial<Frame> = {}): Frame {
  return { id, method, cls: 'Main', line: 1, locals, ...extra };
}

export const intArray = (...xs: number[]): HeapObj => ({ kind: 'array', type: 'int[]', len: xs.length, items: xs.map(int) });

export function step(stack: Frame[], heap: Record<string, HeapObj> = {}, extra: Partial<Step> = {}): Step {
  const top = stack[stack.length - 1];
  return { kind: 'line', line: top?.line ?? 1, out: 0, stack, heap, ...extra };
}
