import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Frame, HeapObj, Step, Value } from './types';
import {
  ARRAY_HEADER, FRAME_HEADER, OBJECT_HEADER, STACK_TOP, bytesLabel, heapValues, hex, stackBottom, targetId,
  type Block, type Layout,
} from './memoryLayout';

/**
 * Memory layout (visual): the whole address space as one rectangle, LOW addresses on top.
 *   code    the methods' bytecode, at the lowest addresses
 *   static  static fields, right before the heap
 *   heap    grows DOWN (string pool at its top; unreachable objects stay as faded garbage)
 *   free    shrinks as the heap and stack grow toward each other
 *   stack   grows UP from the bottom (the highest addresses)
 * Every block takes space roughly in proportion to its bytes. Click anything to see what's stored there.
 */
interface Props {
  steps: Step[];
  step: Step | undefined;
  prev: Step | undefined;
  index: number;
  layout: Layout;
}

const PX_PER_BYTE = 1.25;
const ROW_MIN = 18;
const ROW_MAX = 84; // big methods/arrays are capped so one block can't swallow the picture
const HEAD = 20;
const MIN_FREE = 56;
const MAX_ARRAY_ROWS = 12;
const RECT_WIDTH = 640; // the rectangle's natural width, including the address ruler and arrow room
const PANEL_MIN = 240; // the details panel beside it
const STACK_BELOW = 700; // narrower than this: the panel goes under the rectangle
const MIN_SCALE = 0.4; // "fit to screen" never shrinks text below this; it scrolls instead

const rowPx = (bytes: number) => Math.min(ROW_MAX, Math.max(ROW_MIN, bytes * PX_PER_BYTE));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One clickable thing in the picture. */
interface Item {
  key: string;
  region: 'stack' | 'heap' | 'static' | 'code';
  title: ReactNode;
  addr?: number;
  size?: number;
  type?: string;
  name?: string;
  value?: Value | null;
  isStatic?: boolean;
  isFinal?: boolean;
  note?: ReactNode;
  members?: Item[]; // fields / elements / locals / methods shown as a list in the panel
}

interface Ctx {
  step: Step;
  prev: Step | undefined;
  layout: Layout;
  selected: string | null;
  select: (key: string | null) => void;
  items: Map<string, Item>;
}

export default function AddressSpace({ steps, step, prev, index, layout }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState({ w: 1000, h: 640 });
  const [fit, setFit] = useState(() => {
    try {
      return localStorage.getItem('javalens.layoutFit') !== 'false';
    } catch {
      return true;
    }
  });
  const toggleFit = (on: boolean) => {
    setFit(on);
    try {
      localStorage.setItem('javalens.layoutFit', String(on));
    } catch {
      /* storage unavailable: fine */
    }
  };
  const [selected, setSelected] = useState<string | null>(null);
  const [arrow, setArrow] = useState<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false); // methods listed, or one row per class
  const stackMax = useMemo(() => maxStackPx(layout, steps), [layout, steps]);

  // The rectangle fills the view's height; the free gap gets whatever the other regions don't use.
  useLayoutEffect(() => {
    const el = wrapRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail({ w: el.clientWidth, h: el.clientHeight - 46 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!step]); // the wrapper only exists once there is a step to draw

  const items = new Map<string, Item>();
  const ctx: Ctx | null = step ? { step, prev, layout, selected, select: setSelected, items } : null;

  // Arrow from the selected reference to the block it points at (drawn after layout, like MemoryView).
  useLayoutEffect(() => {
    const rect = rectRef.current;
    if (!rect || !selected) return setArrow(null);
    const from = rect.querySelector<HTMLElement>(`[data-key="${CSS.escape(selected)}"]`);
    const id = from?.dataset.target;
    const to = id ? rect.querySelector<HTMLElement>(`[data-obj="${id}"]`) : null;
    if (!from || !to || to.contains(from)) return setArrow(null);
    const base = rect.getBoundingClientRect();
    const z = base.width / rect.offsetWidth || 1; // zoom applied by "fit to screen"
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x1 = (a.right - base.left) / z - 6;
    const y1 = (a.top + a.height / 2 - base.top) / z;
    const x2 = (b.right - base.left) / z + 2;
    const y2 = (b.top - base.top) / z + Math.min(11, b.height / z / 2);
    const out = (Math.max(a.right, b.right) - base.left) / z + 48 + Math.min(60, Math.abs(y2 - y1) / 12);
    setArrow(`M${x1},${y1} C${out},${y1} ${out},${y2} ${x2},${y2}`);
  });

  if (!step || !ctx) return <div className="memory empty">Run the program to see memory.</div>;

  // ---- build the regions; drawn top (low addresses) to bottom (high addresses)
  const stack = stackBands(ctx);
  const heap = heapBands(ctx, index);
  const statics = staticBands(ctx);
  const code = codeBands(ctx, codeOpen);
  // The rectangle keeps ONE height for the whole run (the biggest the content ever gets, plus room
  // for free space), so the free gap visibly shrinks as the stack and heap grow into it.
  const labels = 4 * 26;
  const used = [stack, heap, statics, code].reduce((n, r) => n + r.px, 0) + labels;
  const lastIndex = layout.heapTopAt.length - 1;
  const heapMax = lastIndex > index ? heapBands({ ...ctx, items: new Map() }, lastIndex).px : heap.px;
  const biggest = stackMax + heapMax + statics.px + code.px + labels; // everything at its largest in this run
  // Fit to screen: one zoom for the whole run (so blocks don't resize while stepping), chosen so the
  // run at its biggest still fits with some free space left; the free gap absorbs the rest.
  const stacked = avail.w < STACK_BELOW;
  const scale = !fit
    ? 1
    : Math.max(MIN_SCALE, Math.min(1, avail.h / (biggest + 90), (avail.w - (stacked ? 0 : PANEL_MIN + 20)) / RECT_WIDTH));
  const total = fit ? Math.max(avail.h / scale, biggest + MIN_FREE) : Math.max(640, avail.h, biggest + 200);
  const freePx = Math.max(MIN_FREE, total - used);
  const freeBytes = stackBottom(layout, step) - (layout.heapTopAt[index] ?? layout.heapStart);
  const sel = selected ? items.get(selected) : undefined; // items are filled in while building the regions

  return (
    <div className={'as-wrap' + (stacked ? ' stacked' : '') + (fit ? ' fit' : '')} ref={wrapRef}>
      <div className="as-rect" ref={rectRef} style={{ zoom: scale }} onClick={() => setSelected(null)}>
        <RegionLabel region="code" text="Code" hint={codeOpen ? 'methods (bytecode) · click to collapse' : 'click to list the methods'}
          onClick={() => setCodeOpen(!codeOpen)} open={codeOpen} />
        {code.nodes}
        <RegionLabel region="static" text="Static data" hint="one copy per class" />
        {statics.nodes}
        <RegionLabel region="heap" text="Heap" hint="objects, arrays, Strings" />
        {heap.nodes}
        <div className="as-free" style={{ height: freePx }}>
          <span className="as-grow down">↓ heap grows down</span>
          <span className="as-free-label">
            free space
            <small>{bytesLabel(freeBytes)} between the heap and the stack</small>
          </span>
          <span className="as-grow up">↑ stack grows up</span>
          <span className="as-ruler">{hex(layout.heapTopAt[index] ?? layout.heapStart)}</span>
        </div>
        <RegionLabel region="stack" text="Stack" hint="one frame per call · newest on top" />
        {stack.nodes}
        <span className="as-ruler bottom">{hex(STACK_TOP)}</span>
        {arrow && (
          <svg className="as-arrows">
            <defs>
              <marker id="as-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" className="arrowhead" />
              </marker>
            </defs>
            <path d={arrow} className="arrow hot" markerEnd="url(#as-head)" />
          </svg>
        )}
      </div>

      <aside className="as-panel">
        <label className="switch as-fit" title="Shrink the picture so all of memory fits without scrolling">
          <input type="checkbox" checked={fit} onChange={(e) => toggleFit(e.target.checked)} />
          <span className="switch-track" aria-hidden>
            <span className="switch-thumb" />
          </span>
          Fit to screen
          {fit && scale < 1 && <span className="as-note">{Math.round(scale * 100)}%</span>}
        </label>
        {sel ? <Details item={sel} ctx={ctx} /> : <Legend />}
      </aside>
    </div>
  );
}

// ------------------------------------------------------------ regions

interface Region {
  nodes: ReactNode[];
  px: number;
}

function RegionLabel(props: { region: string; text: string; hint: string; onClick?: () => void; open?: boolean }) {
  const { region, text, hint, onClick, open } = props;
  return (
    <div
      className={'as-region-label ' + region + (onClick ? ' toggle' : '')}
      onClick={onClick && ((e) => (e.stopPropagation(), onClick()))}
    >
      {onClick && <span className="as-caret">{open ? '▾' : '▸'}</span>}
      <b>{text}</b> <span>{hint}</span>
    </div>
  );
}

/** Height of a frame's band: its header, return address and every slot it reserves. */
const framePx = (fl: { slots: Map<string, { size: number }> }) =>
  HEAD + rowPx(FRAME_HEADER) + [...fl.slots.values()].reduce((n, s) => n + rowPx(s.size), 0);

/** The tallest the stack ever gets in this run, in px. */
function maxStackPx(layout: Layout, steps: Step[]): number {
  let max = 0;
  for (const st of steps) {
    let px = 0;
    for (const f of st.stack) {
      const fl = layout.frames.get(f.id);
      if (fl) px += framePx(fl);
    }
    max = Math.max(max, px);
  }
  return max;
}

function stackBands(ctx: Ctx): Region {
  const { step, prev, layout } = ctx;
  const prevFrames = new Map((prev?.stack ?? []).map((f) => [f.id, f]));
  const nodes: ReactNode[] = [];
  let px = 0;
  step.stack.forEach((f, depth) => {
    const fl = layout.frames.get(f.id);
    if (!fl) return;
    const prevFrame = prevFrames.get(f.id);
    const prevLocals = new Map((prevFrame?.locals ?? []).map((l) => [l.name, l.v]));
    const isTop = depth === step.stack.length - 1;
    const locals = new Map(f.locals.map((l) => [l.name, l]));
    const fkey = 'f:' + f.id;

    const members: Item[] = [];
    const rows: ReactNode[] = [];
    const slots = [...fl.slots.entries()].sort((a, b) => a[1].addr - b[1].addr); // low addresses on top
    for (const [name, slot] of slots) {
      const l = locals.get(name);
      const key = `l:${f.id}:${name}`;
      const item: Item = {
        key, region: 'stack', title: name, addr: slot.addr, size: slot.size, type: l?.type, name,
        value: l ? l.v : undefined, isFinal: l?.final,
        note: l ? undefined : 'Space reserved in this frame, but the variable is not in scope at this line.',
      };
      ctx.items.set(key, item);
      if (l) members.push(item);
      rows.push(
        <SlotRow key={name} k={key} ctx={ctx} px={rowPx(slot.size)} muted={!l}
          changed={!!prevFrame && !!l && !same(prevLocals.get(name), l.v)}
          label={<>{name}{l?.final && <span className="badge final">final</span>}</>}
          value={l ? <Short v={l.v} ctx={ctx} /> : <span className="as-note">not in scope</span>}
          target={l ? targetId(l.v) : null} />,
      );
    }
    rows.push( // the return address is at the frame's highest address: its bottom edge
      <SlotRow key="ret" k={`${fkey}:ret`} ctx={ctx} px={rowPx(FRAME_HEADER)} muted
        label="(return address)" value={<span className="as-note">back to {depth > 0 ? step.stack[depth - 1].method + '()' : 'the JVM'}</span>} />,
    );
    ctx.items.set(fkey, {
      key: fkey, region: 'stack', title: <>{f.method}() <span className="as-note">frame</span></>,
      addr: fl.base - fl.size, size: fl.size, members,
      note: frameNote(f, depth > 0 ? step.stack[depth - 1] : undefined, isTop, step),
    });
    const h = framePx(fl);
    px += h;
    nodes.push(
      <Band key={fkey} k={fkey} ctx={ctx} region="stack" px={h} addr={fl.base - fl.size}
        cls={(isTop ? ' top' : '') + (!prevFrame && prev ? ' new-up' : '')}
        head={<><b className="as-method">{f.method}()</b><span className="as-note">line {f.line}</span>{isTop && <span className={'pill ' + (step.kind === 'return' ? 'returning' : 'running')}>{step.kind === 'return' ? 'returning' : 'running'}</span>}<span className="as-bytes">{fl.size} B</span></>}>
        {rows}
      </Band>,
    );
  });
  return { nodes: nodes.reverse(), px }; // newest call on top: the stack grows up
}

function frameNote(f: Frame, caller: Frame | undefined, isTop: boolean, step: Step): ReactNode {
  return (
    <>
      {caller ? <>Called from <b>{caller.method}()</b> at line {caller.line}. </> : 'The first call: the JVM starts here. '}
      {isTop ? (step.kind === 'return' ? 'Returning now; its frame is about to be popped.' : 'Running now, at line ' + f.line + '.') : 'Waiting for the call above it (the newer one) to return.'}
    </>
  );
}

/** Objects and Strings that something can reach at this step. */
function reachable(step: Step): Set<number> {
  const ids = new Set<number>(Object.keys(step.heap).map(Number));
  const add = (v: Value | null | undefined) => {
    const id = targetId(v);
    if (id !== null) ids.add(id);
  };
  step.statics?.forEach((c) => c.fields.forEach((f) => add(f.v)));
  step.stack.forEach((f) => (f.locals.forEach((l) => add(l.v)), add(f.ret)));
  Object.values(step.heap).forEach((o) => heapValues(o).forEach(add));
  return ids;
}

function heapBands(ctx: Ctx, index: number): Region {
  const { step, prev, layout } = ctx;
  const live = reachable(step);
  const blocks = [...layout.objects.entries()]
    .filter(([, b]) => b.born <= index)
    .sort((a, b) => a[1].addr - b[1].addr); // low addresses on top: new objects appear at the bottom
  const nodes: ReactNode[] = [];
  let px = 0;
  let poolLabel = false;
  for (const [id, b] of blocks) {
    if (b.pooled && !poolLabel) {
      poolLabel = true;
      nodes.push(<div key="pool" className="as-sub-label">string pool <span>literals, shared</span></div>);
      px += 18;
    }
    const garbage = !live.has(id) && !b.pooled; // the pool keeps literals alive
    const obj = typeof b.last === 'string' ? null : (step.heap[id] ?? b.last);
    const { node, h } = obj ? objectBand(ctx, id, b, obj, garbage, prev?.heap[id]) : stringBand(ctx, id, b, garbage);
    px += h;
    nodes.push(<div key={id} className={b.born === index && index > 0 ? 'new-down' : undefined}>{node}</div>);
  }
  if (!blocks.length) {
    nodes.push(<div key="empty" className="as-empty">nothing allocated yet</div>);
    px += 24;
  }
  return { nodes, px };
}

const GARBAGE_NOTE = 'Nothing points to this object anymore. The garbage collector can reclaim its space; until then it still takes up room.';

function stringBand(ctx: Ctx, id: number, b: Block, garbage: boolean) {
  const key = 'o:' + id;
  const text = b.last as string;
  ctx.items.set(key, {
    key, region: 'heap', title: <>String <span className="val str">"{text}"</span></>, addr: b.addr, size: b.size, type: 'String',
    note: <>
      {b.pooled ? 'In the string pool: every "' + text + '" literal in the program is this same object, so == is true between them.' : 'Made at run time (new String, concatenation, input...), so it is a separate object even if another String has the same text.'}
      {garbage && <p>{GARBAGE_NOTE}</p>}
    </>,
  });
  const h = HEAD + rowPx(b.size - OBJECT_HEADER);
  return {
    h,
    node: (
      <Band k={key} ctx={ctx} region="heap" px={h} addr={b.addr} obj={id} cls={garbage ? ' garbage' : ''}
        head={<><b className="as-cls">String</b>{b.pooled && <span className="badge pool">pool</span>}{garbage && <span className="as-note">unreachable</span>}<span className="as-bytes">{b.size} B</span></>}>
        <SlotRow k={key + ':v'} ctx={ctx} px={rowPx(b.size - OBJECT_HEADER)} label="value" value={<span className="val str">"{text}"</span>} />
      </Band>
    ),
  };
}

function objectBand(ctx: Ctx, id: number, b: Block, obj: HeapObj, garbage: boolean, prevObj?: HeapObj) {
  const key = 'o:' + id;
  const rows: ReactNode[] = [];
  const members: Item[] = [];
  let h = HEAD;
  const headerBytes = obj.kind === 'array' ? ARRAY_HEADER : OBJECT_HEADER;

  if (obj.kind === 'object' || obj.kind === 'array') {
    rows.push(<SlotRow key="h" k={key + ':h'} ctx={ctx} px={rowPx(headerBytes)} muted label="(header)"
      value={<span className="as-note">{obj.kind === 'array' ? `length ${obj.len}` : 'class, hash, lock'}</span>} />);
    h += rowPx(headerBytes);
    const entries =
      obj.kind === 'object'
        ? obj.fields.map((f, i) => ({ name: '.' + f.name, type: f.type, v: f.v, final: f.final, slot: b.slots[i], prev: prevObj?.kind === 'object' ? prevObj.fields[i]?.v : undefined }))
        : obj.items.map((v, i) => ({ name: `[${i}]`, type: obj.type.replace(/\[\]$/, ''), v, final: false, slot: b.slots[i], prev: prevObj?.kind === 'array' ? prevObj.items[i] : undefined }));
    entries.forEach((e, i) => {
      const k = `${key}:${i}`;
      const item: Item = { key: k, region: 'heap', title: e.name, addr: e.slot?.addr, size: e.slot?.size, type: e.type, name: e.name, value: e.v, isFinal: e.final };
      ctx.items.set(k, item);
      members.push(item);
      if (i >= MAX_ARRAY_ROWS && obj.kind === 'array') return;
      const px = rowPx(e.slot?.size ?? 8);
      h += px;
      rows.push(
        <SlotRow key={i} k={k} ctx={ctx} px={px} changed={!garbage && prevObj !== undefined && !same(e.prev, e.v)}
          label={<>{e.name}{e.final && <span className="badge final">final</span>}</>}
          value={<Short v={e.v} ctx={ctx} />} target={targetId(e.v)} />,
      );
    });
    if (obj.kind === 'array' && obj.items.length > MAX_ARRAY_ROWS) {
      rows.push(<SlotRow key="more" k={key + ':more'} ctx={ctx} px={ROW_MIN} muted label="…" value={<span className="as-note">{obj.items.length - MAX_ARRAY_ROWS} more (click the array)</span>} />);
      h += ROW_MIN;
    }
  } else {
    const vals = heapValues(obj);
    rows.push(<SlotRow key="c" k={key + ':c'} ctx={ctx} px={rowPx(b.size - OBJECT_HEADER)} muted label="(contents)"
      value={<span className="as-note">{obj.kind === 'opaque' ? 'library object' : `${vals.length ? vals.length : 'no'} item${vals.length === 1 ? '' : 's'}, internals hidden`}</span>} />);
    h += rowPx(b.size - OBJECT_HEADER);
    vals.forEach((v, i) => members.push({ key: `${key}:${i}`, region: 'heap', title: `item ${i}`, name: obj.kind === 'map' ? (i % 2 ? 'value' : 'key') : `item ${i}`, value: v }));
  }

  ctx.items.set(key, {
    key, region: 'heap', title: <span className="as-cls">{obj.type}</span>, addr: b.addr, size: b.size, type: obj.type, members,
    note: garbage ? GARBAGE_NOTE : obj.kind === 'list' || obj.kind === 'map' ? 'A java.util collection: its internal arrays and nodes are hidden; these are its contents.' : undefined,
  });
  return {
    h,
    node: (
      <Band k={key} ctx={ctx} region="heap" px={h} addr={b.addr} obj={id} cls={garbage ? ' garbage' : ''}
        head={<><b className="as-cls">{obj.type}</b>{garbage && <span className="as-note">unreachable</span>}<span className="as-bytes">{b.size} B</span></>}>
        {rows}
      </Band>
    ),
  };
}

function staticBands(ctx: Ctx): Region {
  const { step, prev, layout } = ctx;
  const nodes: ReactNode[] = [];
  let px = 0;
  const current = new Map((step.statics ?? []).map((c) => [c.cls, c]));
  const before = new Map((prev?.statics ?? []).flatMap((c) => c.fields.map((f) => [`${c.cls}.${f.name}`, f.v] as const)));
  const classes = [...layout.statics.entries()]; // address order, low on top
  for (const [cls, slots] of classes) {
    const c = current.get(cls);
    const key = 's:' + cls;
    const members: Item[] = [];
    const rows: ReactNode[] = [];
    let h = HEAD;
    const fields = [...slots.entries()].sort((a, b) => a[1].addr - b[1].addr);
    for (const [name, slot] of fields) {
      const f = c?.fields.find((x) => x.name === name);
      const k = `sf:${cls}:${name}`;
      const item: Item = { key: k, region: 'static', title: name, addr: slot.addr, size: slot.size, type: f?.type, name, value: f?.v, isStatic: true, isFinal: f?.final,
        note: c ? 'Static: one copy for the whole class, shared by every object and every call.' : 'The class has not been initialized yet, so this field has no value yet.' };
      ctx.items.set(k, item);
      members.push(item);
      const px2 = rowPx(slot.size);
      h += px2;
      rows.push(
        <SlotRow key={name} k={k} ctx={ctx} px={px2} muted={!f}
          changed={!!f && before.has(`${cls}.${name}`) && !same(before.get(`${cls}.${name}`), f.v)}
          label={<>{name}{f?.final && <span className="badge final">final</span>}</>}
          value={f ? <Short v={f.v} ctx={ctx} /> : <span className="as-note">not initialized</span>} target={f ? targetId(f.v) : null} />,
      );
    }
    const lo = Math.min(...[...slots.values()].map((s) => s.addr));
    ctx.items.set(key, { key, region: 'static', title: <>class <span className="as-cls">{cls}</span></>, addr: lo, members });
    px += h;
    nodes.push(<Band key={key} k={key} ctx={ctx} region="static" px={h} addr={lo} head={<><span className="as-note">class</span> <b className="as-cls">{cls}</b></>}>{rows}</Band>);
  }
  if (!nodes.length) {
    nodes.push(<div key="none" className="as-empty">no static fields</div>);
    px += 24;
  }
  return { nodes, px };
}

/** The Code segment. Collapsed: one row per class (its methods are listed in the details panel). */
function codeBands(ctx: Ctx, open: boolean): Region {
  const nodes: ReactNode[] = [];
  let px = 0;
  for (const c of ctx.layout.code) {
    const key = 'c:' + c.cls;
    const members: Item[] = [];
    const rows: ReactNode[] = [];
    let h = HEAD;
    for (const [i, m] of c.methods.entries()) {
      const k = `cm:${c.cls}:${i}`;
      const item: Item = { key: k, region: 'code', title: m.sig, addr: m.addr, size: m.size, name: m.name,
        note: `The method's compiled bytecode: ${m.size} bytes of instructions. Every call to it runs this same code; only the stack frame is new.` };
      ctx.items.set(k, item);
      members.push(item);
      if (!open) continue;
      const px2 = rowPx(m.size);
      h += px2;
      rows.push(<SlotRow key={i} k={k} ctx={ctx} px={px2} label={m.name.includes(' ') ? m.name : m.name + '()'} value={<span className="as-note">{m.size} B</span>} />);
    }
    ctx.items.set(key, { key, region: 'code', title: <>class <span className="as-cls">{c.cls}</span> code</>, addr: c.addr, size: c.size, members });
    px += h;
    nodes.push(<Band key={key} k={key} ctx={ctx} region="code" px={h} addr={c.addr} head={<><span className="as-note">class</span> <b className="as-cls">{c.cls}</b>{!open && <span className="as-note">{c.methods.length} method{c.methods.length === 1 ? '' : 's'}</span>}<span className="as-bytes">{c.size} B</span></>}>{rows}</Band>);
  }
  if (!nodes.length) {
    nodes.push(<div key="none" className="as-empty">no code info</div>);
    px += 24;
  }
  return { nodes, px };
}

// ------------------------------------------------------------ pieces

function Band(props: { k: string; ctx: Ctx; region: string; px: number; addr: number; obj?: number; cls?: string; head: ReactNode; children: ReactNode }) {
  const { k, ctx, region, px, addr, obj, cls, head, children } = props;
  return (
    <div className={`as-band ${region}${cls ?? ''}${ctx.selected === k ? ' selected' : ''}`} style={{ height: px }} data-obj={obj} data-key={k}>
      <div className="as-band-head" onClick={(e) => (e.stopPropagation(), ctx.select(k))}>{head}</div>
      {children}
      <span className="as-ruler">{hex(addr)}</span>
    </div>
  );
}

function SlotRow(props: { k: string; ctx: Ctx; px: number; label: ReactNode; value: ReactNode; muted?: boolean; changed?: boolean; target?: number | null }) {
  const { k, ctx, px, label, value, muted, changed, target } = props;
  const selectable = ctx.items.has(k);
  return (
    <div
      className={'as-slot' + (muted ? ' muted' : '') + (changed ? ' changed' : '') + (ctx.selected === k ? ' selected' : '') + (selectable ? ' clickable' : '')}
      style={{ height: px }}
      data-key={k}
      data-target={target ?? undefined}
      onClick={(e) => {
        if (!selectable) return;
        e.stopPropagation();
        ctx.select(k);
      }}
    >
      <span className="as-slot-name">{label}</span>
      <span className="as-slot-val">{value}</span>
    </div>
  );
}

function Short({ v, ctx }: { v: Value; ctx: Ctx }) {
  if (v.k === 'p') return <span className="val prim">{v.v}</span>;
  if (v.k === 'null') return <span className="val null">null</span>;
  const id = targetId(v);
  const b = id !== null ? ctx.layout.objects.get(id) : undefined;
  return <span className="as-ptr">→ {b ? hex(b.addr) : '?'}</span>;
}

function Details({ item, ctx }: { item: Item; ctx: Ctx }) {
  const region = { stack: 'Stack', heap: 'Heap', static: 'Static data', code: 'Code' }[item.region];
  const v = item.value;
  const tid = targetId(v);
  const target = tid !== null ? ctx.layout.objects.get(tid) : undefined;
  return (
    <div className="as-details">
      <div className={'as-details-region ' + item.region}>{region}</div>
      <h3>
        {item.title}
        {item.isStatic && <span className="badge static">static</span>}
        {item.isFinal && <span className="badge final">final</span>}
      </h3>
      <dl>
        {item.addr !== undefined && (
          <>
            <dt>Address</dt>
            <dd className="mono">
              {hex(item.addr)}
              {item.size ? <> – {hex(item.addr + item.size - 1)}</> : null}
            </dd>
          </>
        )}
        {item.size !== undefined && (<><dt>Size</dt><dd>{item.size} bytes</dd></>)}
        {item.type && (<><dt>Type</dt><dd className="mono">{item.type}</dd></>)}
        {v !== undefined && v !== null && (
          <>
            <dt>Stored here</dt>
            <dd>
              {v.k === 'p' && <span className="val prim mono">{v.v}</span>}
              {v.k === 'null' && <span className="mono">0x0 <span className="val null">(null: points nowhere)</span></span>}
              {tid !== null && (
                <>
                  <button className="as-link mono" onClick={() => ctx.select('o:' + tid)}>
                    → {target ? hex(target.addr) : '?'}
                  </button>
                  <div className="as-note">
                    {v.k === 's' ? <>the address of the String <span className="val str">"{v.v}"</span>{v.pool ? ' (in the string pool)' : ''}</> : <>the address of a {ctx.step.heap[tid]?.type ?? 'object'} on the heap</>}
                    , not the object itself.
                  </div>
                </>
              )}
              {v.k === 'p' && <div className="as-note">A primitive: the value itself is stored right here.</div>}
            </dd>
          </>
        )}
      </dl>
      {item.note && <div className="as-details-note">{item.note}</div>}
      {item.members && item.members.length > 0 && (
        <div className="as-members">
          {item.members.map((m) => (
            <button key={m.key} className="as-member" onClick={() => ctx.select(ctx.items.has(m.key) ? m.key : item.key)}>
              <span className="mono as-member-addr">{m.addr !== undefined ? hex(m.addr) : ''}</span>
              <span className="as-member-name">{m.name ?? m.title}</span>
              <span className="mono">{m.value ? <Short v={m.value} ctx={ctx} /> : m.size !== undefined ? `${m.size} B` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="as-details">
      <h3>The program's memory</h3>
      <p className="as-note">One rectangle, low addresses at the top. Click any block or row to see what's stored there.</p>
      <ul className="as-legend">
        <li><i className="code" /> <b>Code</b>: the compiled methods. Every call runs this same code.</li>
        <li><i className="static" /> <b>Static data</b>: static fields, one copy per class, right before the heap.</li>
        <li><i className="heap" /> <b>Heap</b>: everything made with <code>new</code>, plus Strings. It grows <b>down</b>. Faded, hatched blocks are garbage: unreachable but not yet reclaimed.</li>
        <li><i className="free" /> <b>Free space</b>: the heap and the stack grow toward each other into it.</li>
        <li><i className="stack" /> <b>Stack</b>: one frame per method call. It grows <b>up</b> as calls are made and shrinks when they return.</li>
      </ul>
      <p className="as-note">
        Sizes are roughly to scale; the free space is not (it's far bigger). Addresses are a teaching model and match the Memory map tab.
      </p>
    </div>
  );
}
