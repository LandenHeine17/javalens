// Simulated memory addresses for the Memory map and Memory layout tabs.
//
// The debugger can't see real addresses (and the garbage collector moves objects anyway), so we
// lay memory out with a simple teaching model: a 64-bit JVM without compressed pointers, fields in
// declaration order, objects aligned to 8 bytes. The layout is computed once for the whole run, so
// a variable or object keeps the same address while you step.
//
// The address space, low to high (the textbook picture):
//   code      the classes' methods (bytecode)
//   static    static fields, right before the heap
//   heap      string pool first, then objects; grows UP
//   ...free...
//   stack     grows DOWN from STACK_TOP
import type { CodeClass, HeapObj, Step, Value } from './types';

export const CODE_BASE = 0x0040_0000;
export const STACK_TOP = 0x7fff_f000; // the stack grows down from here

export const OBJECT_HEADER = 16; // mark word (hash, lock bits) + class pointer
export const ARRAY_HEADER = 16; // header + length, padded
export const STRING_SIZE = 24; // header + reference to its byte[] + hash (the byte[] isn't drawn)
export const HIDDEN_SIZE = 32; // java.util collections and library objects: internals not shown
export const FRAME_HEADER = 16; // return address + saved frame pointer

const PRIM_SIZES: Record<string, number> = {
  boolean: 1, byte: 1, char: 2, short: 2, int: 4, float: 4, long: 8, double: 8,
};

/** Bytes a variable/field/element of this declared type takes (references are 8). */
export function typeSize(type: string | undefined): number {
  return (type && PRIM_SIZES[type]) || 8;
}

const align = (n: number, to: number) => Math.ceil(n / to) * to;

export interface Slot {
  addr: number;
  size: number;
}

export interface Block {
  addr: number;
  size: number;
  slots: Slot[]; // fields / elements, in order (empty for strings and hidden objects)
  born: number; // index of the step where it first appeared
  last: HeapObj | string; // last known contents (a String's text), kept after it becomes garbage
  pooled?: boolean;
}

export interface CodeBlock {
  cls: string;
  addr: number;
  size: number;
  methods: { name: string; sig: string; addr: number; size: number }[];
}

export interface Layout {
  objects: Map<number, Block>; // heap object or String id -> block
  frames: Map<number, { base: number; size: number; slots: Map<string, Slot> }>; // frame id -> layout
  statics: Map<string, Map<string, Slot>>; // class -> field -> slot
  code: CodeBlock[];
  codeStart: number;
  codeEnd: number;
  staticStart: number;
  staticEnd: number;
  heapStart: number; // the string pool starts here
  poolEnd: number;
  heapTopAt: number[]; // per step: end of the highest object allocated so far
}

/** "0x1000_0040": 8 hex digits split in two so they're easy to read aloud. */
export function hex(addr: number): string {
  const h = addr.toString(16).toUpperCase().padStart(8, '0');
  return `0x${h.slice(0, 4)}_${h.slice(4)}`;
}

/** "1.8 GB", "640 bytes": a byte count for people. */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** Lays out an object's fields/elements starting at `addr`. */
function objectBlock(obj: HeapObj, addr: number, born: number): Block {
  if (obj.kind === 'object') {
    let off = OBJECT_HEADER;
    const slots = obj.fields.map((f) => {
      const size = typeSize(f.type);
      off = align(off, size);
      const slot = { addr: addr + off, size };
      off += size;
      return slot;
    });
    return { addr, size: align(off, 8), slots, born, last: obj };
  }
  if (obj.kind === 'array') {
    const elem = typeSize(obj.type.replace(/\[\]$/, ''));
    const slots = obj.items.map((_, i) => ({ addr: addr + ARRAY_HEADER + i * elem, size: elem }));
    return { addr, size: align(ARRAY_HEADER + obj.len * elem, 8), slots, born, last: obj };
  }
  return { addr, size: HIDDEN_SIZE, slots: [], born, last: obj };
}

/** Every value directly held by a heap object (fields, elements, map keys and values). */
export function heapValues(obj: HeapObj): Value[] {
  if (obj.kind === 'object') return obj.fields.map((f) => f.v);
  if (obj.kind === 'array' || obj.kind === 'list') return obj.items;
  if (obj.kind === 'map') return obj.entries.flatMap((e) => [e.k, e.v]);
  return [];
}

/** Id of the object a value points at (heap object or String), or null. */
export function targetId(v: Value | null | undefined): number | null {
  if (!v) return null;
  if (v.k === 'r') return v.id;
  if (v.k === 's' && v.id !== undefined) return v.id;
  return null;
}

/** Calls `fn` on every value a step can see: statics, then each frame's variables, then the heap. */
function forEachRoot(step: Step, fn: (v: Value) => void) {
  step.statics?.forEach((c) => c.fields.forEach((f) => fn(f.v)));
  step.stack.forEach((f) => {
    f.locals.forEach((l) => fn(l.v));
    if (f.ret) fn(f.ret);
  });
  Object.values(step.heap).forEach((o) => heapValues(o).forEach(fn));
}

export function buildLayout(steps: Step[], codeClasses: CodeClass[] = []): Layout {
  // ---- code: one block per class, one slot per method (sized by its real bytecode)
  const code: CodeBlock[] = [];
  let next = CODE_BASE;
  for (const c of codeClasses) {
    const start = next;
    const methods = c.methods.map((m) => {
      const size = Math.max(1, m.bytes);
      const slot = { name: m.name, sig: m.sig, addr: next, size };
      next = align(next + size, 4);
      return slot;
    });
    next = align(next, 16);
    code.push({ cls: c.cls, addr: start, size: next - start, methods });
  }
  const codeEnd = next;

  // ---- static data, right after the code. Pre-pass so we know where it ends before the heap starts.
  const statics = new Map<string, Map<string, Slot>>();
  const staticStart = align(codeEnd, 16);
  next = staticStart;
  const pooledOrder: { id: number; text: string }[] = [];
  const pooledSeen = new Set<number>();
  for (const step of steps) {
    for (const c of step.statics ?? []) {
      let cls = statics.get(c.cls);
      if (!cls) statics.set(c.cls, (cls = new Map()));
      for (const f of c.fields) {
        if (cls.has(f.name)) continue;
        const size = typeSize(f.type);
        next = align(next, size);
        cls.set(f.name, { addr: next, size });
        next += size;
      }
      next = align(next, 16);
    }
    forEachRoot(step, (v) => {
      if (v.k === 's' && v.pool && v.id !== undefined && !pooledSeen.has(v.id)) {
        pooledSeen.add(v.id);
        pooledOrder.push({ id: v.id, text: v.v });
      }
    });
  }
  const staticEnd = next;

  // ---- heap: the string pool first, then objects in the order they're first reachable
  const heapStart = align(staticEnd, 0x100);
  // Literals are interned before main runs, so pooled strings exist from step 0.
  const objects = new Map<number, Block>();
  pooledOrder.forEach(({ id, text }, i) => {
    objects.set(id, { addr: heapStart + i * STRING_SIZE, size: STRING_SIZE, slots: [], born: 0, last: text, pooled: true });
  });
  const poolEnd = heapStart + pooledOrder.length * STRING_SIZE;
  let heapNext = align(poolEnd, 16);

  // Every variable each frame ever has, so a frame's size is fixed for its whole life
  // (otherwise a new variable in main would shift every frame above it).
  const frameVars = new Map<number, Map<string, number>>(); // frame id -> name -> size
  for (const step of steps) {
    for (const f of step.stack) {
      let vars = frameVars.get(f.id);
      if (!vars) frameVars.set(f.id, (vars = new Map()));
      for (const l of f.locals) vars.set(l.name, Math.max(vars.get(l.name) ?? 0, typeSize(l.type)));
    }
  }
  const frames: Layout['frames'] = new Map();
  for (const [id, vars] of frameVars) {
    const slots = new Map<string, Slot>();
    let off = FRAME_HEADER;
    for (const [name, size] of vars) {
      off = align(off + size, size);
      slots.set(name, { addr: -off, size }); // offset below the frame base; made absolute below
    }
    frames.set(id, { base: 0, size: align(off, 16), slots });
  }

  // Walk the run in order, placing frames and objects the first time we see them.
  const placedFrames = new Set<number>();
  const heapTopAt: number[] = [];
  let heapTop = poolEnd;
  steps.forEach((step, index) => {
    let base = STACK_TOP;
    for (const f of step.stack) {
      const fl = frames.get(f.id)!;
      if (!placedFrames.has(f.id)) {
        placedFrames.add(f.id);
        fl.base = base;
        for (const s of fl.slots.values()) s.addr += base;
      }
      base = fl.base - fl.size;
    }

    const visit = (v: Value | null | undefined) => {
      const id = targetId(v);
      if (id === null) return;
      const known = objects.get(id);
      if (known) {
        // Keep the newest contents, so a garbage object shows what it held last.
        if (v!.k === 'r' && step.heap[id]) known.last = step.heap[id];
        return;
      }
      if (v!.k === 's') {
        objects.set(id, { addr: heapNext, size: STRING_SIZE, slots: [], born: index, last: v!.v });
        heapNext += STRING_SIZE;
        heapTop = Math.max(heapTop, heapNext);
        return;
      }
      const obj = step.heap[id];
      if (!obj) return;
      const block = objectBlock(obj, heapNext, index);
      objects.set(id, block);
      heapNext += block.size;
      heapTop = Math.max(heapTop, block.addr + block.size);
      heapValues(obj).forEach(visit);
    };
    forEachRoot(step, visit);
    Object.keys(step.heap).forEach((id) => visit({ k: 'r', id: Number(id) }));
    heapTopAt.push(heapTop);
  });

  return { objects, frames, statics, code, codeStart: CODE_BASE, codeEnd, staticStart, staticEnd, heapStart, poolEnd, heapTopAt };
}

/** The lowest address the stack reaches at this step (STACK_TOP when it's empty). */
export function stackBottom(layout: Layout, step: Step): number {
  const top = step.stack[step.stack.length - 1];
  const fl = top && layout.frames.get(top.id);
  return fl ? fl.base - fl.size : STACK_TOP;
}
