import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Frame, HeapObj, Step, Value } from './types';
import { unwoundFrames, valueHistory } from './analysis';
import { cellText, gridPointers, gridRows, type GridVars } from './grid';

/**
 * Memory diagram: the call stack on the left (newest call on top), objects on the heap on the right,
 * and SVG arrows for every reference. Self-referencing classes get special layouts:
 *   one field of its own type  (Node next)        -> drawn as a left-to-right linked list
 *   two+ fields of its own type (Node left, right) -> drawn as a tree
 * and 2D arrays of simple values (int[][], char[][]) are drawn as one grid.
 */
interface Props {
  step: Step | undefined;
  prev: Step | undefined; // previous step, used to highlight what changed
  indexNames: Set<string>; // variables used as array indexes in the code (i, j, mid...)
  steps?: Step[]; // the whole run and the current position: for a variable's value history on hover
  index?: number;
  gridVars?: Map<string, GridVars>; // which variables index each 2D array's rows and columns (from the code)
}

type Hover = (id: number | null) => void;
const MAX_INDENT = 8; // deeper calls stop indenting so deep recursion doesn't run off the screen
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export default function MemoryView({ step, prev, indexNames, steps, index, gridVars }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState<{ d: string; to: number; key: string }[]>([]);
  const [hovered, setHovered] = useState<number | null>(null);

  // After every render, measure where each reference chip and object box ended up, then draw arrows.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const draw = () => {
      const base = wrap.getBoundingClientRect();
      const next: { d: string; to: number; key: string }[] = [];
      wrap.querySelectorAll<HTMLElement>('[data-ref]').forEach((chip, i) => {
        const id = Number(chip.dataset.ref);
        const target = wrap.querySelector<HTMLElement>(`[data-obj="${id}"]`);
        if (!target || target.contains(chip)) return;
        const a = chip.getBoundingClientRect();
        const b = target.getBoundingClientRect();
        const x1 = a.left + a.width / 2 - base.left;
        const y1 = a.top + a.height / 2 - base.top;
        let d: string;
        if (chip.dataset.down && b.top > a.bottom) {
          // tree edge: drop down into the top-center of the child
          const x2 = b.left + b.width / 2 - base.left;
          const y2 = b.top - base.top - 2;
          const dy = (y2 - y1) / 2;
          d = `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
        } else if (b.left > a.right - 4) {
          // target is to the right: smooth S-curve into its left edge
          const x2 = b.left - base.left - 2;
          const y2 = b.top + Math.min(14, b.height / 2) - base.top;
          const dx = Math.max(24, (x2 - x1) / 2);
          d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
        } else {
          // target is in the same column or to the left: loop around the right side
          const x2 = b.right - base.left + 2;
          const y2 = b.top + 14 - base.top;
          const out = Math.max(a.right, b.right) - base.left + 40;
          d = `M${x1},${y1} C${out},${y1} ${out},${y2} ${x2},${y2}`;
        }
        next.push({ d, to: id, key: `${i}-${id}` });
      });
      setArrows((old) => (same(old, next) ? old : next));
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [step]);

  // Deep recursion pushes the running call down the page: keep it visible.
  useLayoutEffect(() => {
    wrapRef.current?.querySelector('.frame.top')?.scrollIntoView({ block: 'nearest' });
  }, [step]);

  if (!step) return <div className="memory empty">Run the program to see memory.</div>;

  const frames = step.stack; // main first; every call is nested under the call that made it
  const prevFrames = new Map((prev?.stack ?? []).map((f) => [f.id, f]));
  const hiddenArgs = hiddenArgsId(step);
  const pointers = indexPointers(step, indexNames);
  const ctx: Ctx = { step, prev, hovered, onHover: setHovered, pointers, steps, index, gridVars: gridVars ?? new Map() };
  const unwound = unwoundFrames(step); // on an exception step: the calls it ends early

  return (
    <div className="memory" ref={wrapRef}>
      <div className="col stack-col">
        <div className="col-title">
          Call stack <span className="col-hint">newest call at the bottom</span>
        </div>
        {frames.map((f, i) => (
          <FrameCard
            key={f.id}
            frame={f}
            caller={frames[i - 1]}
            indent={Math.min(i, MAX_INDENT)}
            prevFrame={prevFrames.get(f.id)}
            isTop={i === frames.length - 1}
            exception={unwound.has(f.id) ? 'unwinding' : f.id === step.catchFrame ? 'catching' : undefined}
            ctx={ctx}
            hiddenArgs={hiddenArgs}
            hiddenAfter={i === 0 ? step.hiddenFrames : undefined}
          />
        ))}
      </div>

      <div className="col heap-col">
        <div className="col-title">Heap (objects)</div>
        {heapGroups(step, hiddenArgs).map((g) => (
          <HeapGroup key={g.key} group={g} ctx={ctx} />
        ))}
      </div>

      <svg className="arrows">
        <defs>
          <marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" className="arrowhead" />
          </marker>
        </defs>
        {arrows.map((a) => (
          <path key={a.key} d={a.d} className={'arrow' + (hovered === a.to ? ' hot' : '')} markerEnd="url(#arrowhead)" />
        ))}
      </svg>
    </div>
  );
}

interface Ctx {
  step: Step;
  prev: Step | undefined;
  hovered: number | null;
  onHover: Hover;
  pointers: Map<number, Map<number, string[]>>; // array id -> index -> variable names
  steps?: Step[];
  index?: number;
  gridVars: Map<string, GridVars>;
}

// ------------------------------------------------------------ grouping the heap

type Group =
  | { key: string; kind: 'box'; id: number }
  | { key: string; kind: 'chain'; ids: number[] }
  | { key: string; kind: 'tree'; id: number; selfFields: string[] };

/** Fields of an object whose declared type is the object's own class (next, left, right...). */
function selfFields(obj: HeapObj): string[] {
  if (obj.kind !== 'object') return [];
  return obj.fields.filter((f) => f.type === obj.type).map((f) => f.name);
}

function heapGroups(step: Step, hiddenArgs: number | null): Group[] {
  const heap = step.heap;
  // A 2D array's rows are drawn inside its grid, not as boxes of their own.
  const rowsOfGrids = new Set<number>();
  const all = heapOrder(step);
  for (const id of all) gridRows(heap, id)?.forEach((r) => r !== null && rowsOfGrids.add(r));
  const order = all.filter((id) => id !== hiddenArgs && !rowsOfGrids.has(id));

  // Objects pointed to by another object of the same type are not heads/roots.
  const pointedBySame = new Set<number>();
  for (const id of order) {
    const o = heap[id];
    if (o.kind !== 'object') continue;
    for (const name of selfFields(o)) {
      const v = o.fields.find((f) => f.name === name)!.v;
      if (v.k === 'r' && v.id !== id) pointedBySame.add(v.id);
    }
  }

  const placed = new Set<number>();
  const groups: Group[] = [];
  for (const id of order) {
    if (placed.has(id)) continue;
    const o = heap[id];
    const sf = selfFields(o);
    if (sf.length === 0 || pointedBySame.has(id)) {
      if (sf.length === 0) {
        placed.add(id);
        groups.push({ key: 'b' + id, kind: 'box', id });
      }
      continue; // a node in the middle of a list/tree: placed with its head/root
    }
    if (sf.length === 1) {
      const ids: number[] = [];
      let cur: number | null = id;
      while (cur !== null && !placed.has(cur) && heap[cur]) {
        ids.push(cur);
        placed.add(cur);
        const node: HeapObj = heap[cur];
        const v: Value | undefined = node.kind === 'object' ? node.fields.find((f) => f.name === sf[0])?.v : undefined;
        cur = v?.k === 'r' && heap[v.id]?.type === o.type ? v.id : null;
      }
      groups.push({ key: 'c' + id, kind: 'chain', ids });
    } else {
      markTree(heap, id, sf, placed);
      groups.push({ key: 't' + id, kind: 'tree', id, selfFields: sf });
    }
  }
  // Anything left (e.g. a circular list with no head) is drawn as plain boxes.
  for (const id of order) if (!placed.has(id)) groups.push({ key: 'b' + id, kind: 'box', id });
  return groups;
}

function markTree(heap: Step['heap'], id: number, sf: string[], placed: Set<number>) {
  if (placed.has(id) || !heap[id]) return;
  placed.add(id);
  const o = heap[id];
  if (o.kind !== 'object') return;
  for (const name of sf) {
    const v = o.fields.find((f) => f.name === name)?.v;
    if (v?.k === 'r' && heap[v.id]?.type === o.type) markTree(heap, v.id, sf, placed);
  }
}

/** Follow references depth-first from main's variables, so things appear in reading order. */
function heapOrder(step: Step): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (v: Value) => {
    if (v.k !== 'r' || seen.has(v.id) || !step.heap[v.id]) return;
    seen.add(v.id);
    order.push(v.id);
    const obj = step.heap[v.id];
    if (obj.kind === 'object') obj.fields.forEach((f) => visit(f.v));
    else if (obj.kind === 'array' || obj.kind === 'list') obj.items.forEach(visit);
    else if (obj.kind === 'map') obj.entries.forEach((e) => (visit(e.k), visit(e.v)));
  };
  step.stack.forEach((f) => f.locals.forEach((l) => visit(l.v)));
  step.stack.forEach((f) => f.ret && visit(f.ret));
  Object.keys(step.heap).forEach((id) => visit({ k: 'r', id: Number(id) }));
  return order;
}

/** main's empty `String[] args` is noise for students; hide it. */
function hiddenArgsId(step: Step): number | null {
  const main = step.stack[0];
  const args = main?.locals.find((l) => l.name === 'args' && l.type === 'String[]');
  if (args?.v.k !== 'r') return null;
  const obj = step.heap[args.v.id];
  return obj?.kind === 'array' && obj.len === 0 ? args.v.id : null;
}

/**
 * Index pointers: for each array/list the CURRENT method can see, mark the cells that its
 * index-like int variables (i, j, mid, ...) point at.
 */
function indexPointers(step: Step, names: Set<string>): Map<number, Map<number, string[]>> {
  const result = new Map<number, Map<number, string[]>>();
  const top = step.stack[step.stack.length - 1];
  if (!top) return result;
  const arrays = top.locals.filter((l) => l.v.k === 'r').map((l) => (l.v as { id: number }).id);
  const thisObj = top.locals.find((l) => l.name === 'this');
  if (thisObj?.v.k === 'r') {
    const o = step.heap[thisObj.v.id];
    if (o?.kind === 'object') o.fields.forEach((f) => f.v.k === 'r' && arrays.push(f.v.id));
  }
  const ints = top.locals.filter((l) => (l.type === 'int' || l.type === 'Integer') && names.has(l.name) && l.v.k === 'p');
  for (const id of arrays) {
    const o = step.heap[id];
    if (!o || !(o.kind === 'array' || (o.kind === 'list' && (o.role ?? 'list') === 'list'))) continue;
    const m = new Map<number, string[]>();
    for (const l of ints) {
      const idx = Number((l.v as { v: string }).v);
      if (Number.isInteger(idx) && idx >= 0 && idx <= o.len) m.set(idx, [...(m.get(idx) ?? []), l.name]);
    }
    if (m.size) result.set(id, m);
  }
  return result;
}

// ------------------------------------------------------------ stack frames

function FrameCard(props: {
  frame: Frame;
  caller?: Frame; // the call this one is nested under
  indent: number;
  prevFrame?: Frame;
  isTop: boolean;
  exception?: 'unwinding' | 'catching'; // on an exception step: this call ends early, or catches it
  ctx: Ctx;
  hiddenArgs: number | null;
  hiddenAfter?: number;
}) {
  const { frame, caller, indent, prevFrame, isTop, exception, ctx, hiddenArgs, hiddenAfter } = props;
  const [historyOf, setHistoryOf] = useState<string | null>(null); // hovered variable (history computed on demand)
  const prevLocals = new Map((prevFrame?.locals ?? []).map((l) => [l.name, l.v]));
  const locals = frame.locals.filter((l) => !(l.v.k === 'r' && l.v.id === hiddenArgs));
  const returning = isTop && ctx.step.kind === 'return';
  const cls = ['frame', isTop ? 'top' : '', !prevFrame ? 'pushed' : '', returning ? 'returning' : '', exception ?? ''].join(' ');
  const pill = exception === 'unwinding' ? (isTop ? 'throws' : 'unwinding') : exception === 'catching' ? 'catches it' : isTop ? (returning ? 'returning' : 'running') : null;
  const pillTitle =
    exception === 'unwinding'
      ? 'The exception ends this call early: it never returns a value'
      : exception === 'catching'
        ? 'This call catches the exception and carries on'
        : 'This call is on top of the stack';
  const rowCls = 'frame-row' + (caller ? ' nested' : '') + (isTop ? ' active' : '');

  return (
    <>
      <div className={rowCls} style={{ ['--indent' as string]: indent }}>
        <div className={cls}>
          <div className="frame-head">
            <span className="method">
              {frame.method}
              <span className="paren">()</span>
            </span>
            {pill && (
              <span className={'pill ' + (exception ?? (returning ? 'returning' : 'running'))} title={pillTitle}>
                {pill}
              </span>
            )}
            <span className="frame-line" title={frame.file}>
              {frame.file && frame.file.slice(frame.file.lastIndexOf('/') + 1) + ' · '}line {frame.line}
            </span>
          </div>
          {caller && (
            <div className="called-from">
              called from <b>{caller.method}</b> · line {caller.line}
            </div>
          )}
          {locals.length === 0 && <div className="no-locals">no variables yet</div>}
          {locals.map((l) => {
            const changed = prevFrame && !same(prevLocals.get(l.name), l.v);
            return (
              <div
                className={'local' + (changed ? ' changed' : '')}
                key={l.name}
                onMouseEnter={l.v.k === 'p' ? () => setHistoryOf(l.name) : undefined}
                onMouseLeave={() => setHistoryOf(null)}
              >
                <span className="var-type">
                  {l.final && <span className="badge final">final</span>}
                  {l.type}
                </span>
                <span className="var-name">{l.name}</span>
                <ValueView v={l.v} ctx={ctx} />
                {historyOf === l.name && ctx.steps && ctx.index !== undefined && (
                  <Sparkline points={valueHistory(ctx.steps, frame.id, l.name, ctx.index)} name={l.name} />
                )}
              </div>
            );
          })}
          {returning && frame.ret !== undefined && (
            <div className="ret">
              returns {frame.ret ? <ValueView v={frame.ret} ctx={ctx} /> : <span className="void">void</span>}
            </div>
          )}
        </div>
      </div>
      {!!hiddenAfter && (
        <div className="hidden-frames" style={{ ['--indent' as string]: 1 }}>
          … {hiddenAfter} more calls …
        </div>
      )}
    </>
  );
}

/** A variable's values so far in this call, as a tiny line chart (shown while hovering the variable). */
function Sparkline({ points, name }: { points: { step: number; v: number }[]; name: string }) {
  if (points.length < 2) return null;
  const changes = points.filter((p, i) => i > 0 && p.v !== points[i - 1].v).length;
  if (changes === 0) return null;
  const w = 140, h = 34, pad = 3;
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const x0 = points[0].step, x1 = points[points.length - 1].step;
  const x = (s: number) => pad + ((s - x0) / Math.max(1, x1 - x0)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - lo) / Math.max(1e-9, hi - lo)) * (h - 2 * pad);
  // a step chart: the value holds until the step that changes it
  const d = points.map((p, i) => (i === 0 ? `M${x(p.step)},${y(p.v)}` : `H${x(p.step)}V${y(p.v)}`)).join('');
  const last = points[points.length - 1];
  return (
    <div className="sparkline" role="img" aria-label={`${name} so far: ${vs.join(', ')}`}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <path d={d} />
        <circle cx={x(last.step)} cy={y(last.v)} r={2.5} />
      </svg>
      <span>
        {name} so far: {lo}…{hi} · changed {changes}×
      </span>
    </div>
  );
}

// ------------------------------------------------------------ heap objects

function HeapGroup({ group, ctx }: { group: Group; ctx: Ctx }) {
  if (group.kind === 'box') return <HeapBox id={group.id} ctx={ctx} />;
  if (group.kind === 'chain') {
    return (
      <div className="chain">
        {group.ids.map((id) => (
          <HeapBox key={id} id={id} ctx={ctx} />
        ))}
      </div>
    );
  }
  return (
    <div className="tree-struct">
      <TreeNodeView id={group.id} selfFields={group.selfFields} ctx={ctx} seen={new Set()} />
    </div>
  );
}

function TreeNodeView({ id, selfFields, ctx, seen }: { id: number; selfFields: string[]; ctx: Ctx; seen: Set<number> }) {
  seen.add(id);
  const o = ctx.step.heap[id];
  const kids =
    o.kind === 'object'
      ? selfFields.map((name) => {
          const v = o.fields.find((f) => f.name === name)?.v;
          return v?.k === 'r' && !seen.has(v.id) && ctx.step.heap[v.id]?.type === o.type ? v.id : null;
        })
      : [];
  const anyKid = kids.some((k) => k !== null);
  return (
    <div className="tnode">
      <HeapBox id={id} ctx={ctx} downFields={new Set(selfFields)} compact />
      {anyKid && (
        <div className="tchildren">
          {kids.map((k, i) =>
            k === null ? (
              <div key={i} className="tslot-empty" />
            ) : (
              <TreeNodeView key={k} id={k} selfFields={selfFields} ctx={ctx} seen={seen} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function HeapBox({ id, ctx, downFields, compact }: { id: number; ctx: Ctx; downFields?: Set<string>; compact?: boolean }) {
  const obj = ctx.step.heap[id];
  const prevObj = ctx.prev?.heap[id];
  const isNew = !prevObj;
  const box = 'heap-obj' + (ctx.hovered === id ? ' hot' : '') + (isNew ? ' pushed' : '') + (compact ? ' compact' : '');

  const rows = obj.kind === 'array' ? gridRows(ctx.step.heap, id) : null;
  if (rows) return <GridBox id={id} rows={rows} ctx={ctx} className={box} />;

  if (obj.kind === 'array' || obj.kind === 'list') {
    const prevItems = prevObj && 'items' in prevObj ? prevObj.items : [];
    const role = obj.kind === 'list' ? obj.role ?? 'list' : 'array';
    const ptrs = ctx.pointers.get(id);
    const cell = (v: Value, i: number, extra?: ReactNode) => (
      <div
        className={'cell' + (!isNew && !same(prevItems[i], v) ? ' changed' : '') + (ptrs?.has(i) ? ' pointed' : '')}
        key={i}
      >
        <ValueView v={v} ctx={ctx} compact />
        {extra}
      </div>
    );
    const meta = role === 'set' ? `${obj.len} item${obj.len === 1 ? '' : 's'}` : role === 'stack' || role === 'queue' ? `size ${obj.len}` : `length ${obj.len}`;

    let body: ReactNode;
    if (role === 'stack') {
      const items = obj.items.map((v, i) => ({ v, i })).reverse();
      body = (
        <div className="stack-cells">
          {items.length === 0 && <div className="cell empty-cell">empty</div>}
          {items.map(({ v, i }, k) => cell(v, i, k === 0 ? <span className="tag">top</span> : undefined))}
        </div>
      );
    } else if (role === 'queue') {
      body = (
        <div className="cells">
          {obj.items.length === 0 && <div className="cell empty-cell">empty</div>}
          {obj.items.map((v, i) =>
            cell(v, i, i === 0 ? <span className="idx">front</span> : i === obj.items.length - 1 ? <span className="idx">back</span> : undefined),
          )}
        </div>
      );
    } else if (role === 'set') {
      body = (
        <div className="cells set-cells">
          <span className="brace">{'{'}</span>
          {obj.items.map((v, i) => cell(v, i))}
          <span className="brace">{'}'}</span>
        </div>
      );
    } else {
      body = (
        <div className="cells">
          {obj.items.map((v, i) =>
            cell(
              v,
              i,
              <>
                <span className="idx">{i}</span>
                {ptrs?.get(i) && <span className="ptr">↑ {ptrs.get(i)!.join(', ')}</span>}
              </>,
            ),
          )}
          {obj.len > obj.items.length && <div className="cell more">…</div>}
          {ptrs?.get(obj.len) && (
            <div className="cell past-end">
              <span className="ptr">↑ {ptrs.get(obj.len)!.join(', ')}</span>
            </div>
          )}
        </div>
      );
    }
    return (
      <div className={box + (ptrs ? ' has-ptrs' : '')} data-obj={id}>
        <div className="obj-type">
          {obj.type} <span className="obj-meta">{meta}</span>
        </div>
        {body}
      </div>
    );
  }

  if (obj.kind === 'map') {
    const prevEntries = new Map(prevObj?.kind === 'map' ? prevObj.entries.map((e) => [JSON.stringify(e.k), e.v]) : []);
    return (
      <div className={box} data-obj={id}>
        <div className="obj-type">
          {obj.type} <span className="obj-meta">{obj.len} entr{obj.len === 1 ? 'y' : 'ies'}</span>
        </div>
        {obj.entries.length === 0 && <div className="no-locals">empty</div>}
        <div className="map-rows">
          {obj.entries.map((e) => {
            const k = JSON.stringify(e.k);
            const changed = !isNew && (!prevEntries.has(k) || !same(prevEntries.get(k), e.v));
            return (
              <div className={'map-row' + (changed ? ' changed' : '')} key={k}>
                <ValueView v={e.k} ctx={ctx} />
                <span className="map-arrow">→</span>
                <ValueView v={e.v} ctx={ctx} />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (obj.kind === 'object') {
    const prevFields = new Map(prevObj?.kind === 'object' ? prevObj.fields.map((f) => [f.name, f.v]) : []);
    return (
      <div className={box} data-obj={id}>
        <div className="obj-type">{obj.type}</div>
        <div className={compact ? 'fields-compact' : undefined}>
          {obj.fields.map((f) => (
            <div className={'local' + (!isNew && !same(prevFields.get(f.name), f.v) ? ' changed' : '')} key={f.name}>
              {!compact && (
                <span className="var-type">
                  {f.final && <span className="badge final">final</span>}
                  {f.type}
                </span>
              )}
              <span className="var-name">{f.name}</span>
              <ValueView v={f.v} ctx={ctx} down={downFields?.has(f.name)} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className={box} data-obj={id}>
      <div className="obj-type">{obj.type}</div>
      <div className="obj-meta">(library object)</div>
    </div>
  );
}

/**
 * A 2D array as a grid: rows down, columns across. The running method's row variable (i) points at a
 * row from the left, its column variable (j) at a column from above, and the cell where they cross
 * is highlighted. Each row carries its own heap id, so a reference to one row points at that row.
 */
function GridBox({ id, rows, ctx, className }: { id: number; rows: (number | null)[]; ctx: Ctx; className: string }) {
  const { step, prev } = ctx;
  const obj = step.heap[id] as Extract<HeapObj, { kind: 'array' }>;
  const isNew = !prev?.heap[id];
  const lens = rows.map((r) => (r === null ? 0 : (step.heap[r] as { len: number }).len));
  const width = Math.max(...lens);
  const ptr = gridPointers(step, id, ctx.gridVars);
  const colCount = width + (ptr.cols.has(width) ? 1 : 0); // a column variable one past the end (loop finished)
  const rowCount = rows.length + (ptr.rows.has(rows.length) ? 1 : 0);
  const ragged = lens.some((l) => l !== width);

  return (
    <div className={className + ' grid-obj'} data-obj={id}>
      <div className="obj-type">
        {obj.type} <span className="obj-meta">{rows.length} × {ragged ? `up to ${width}` : width}</span>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th className="grid-corner" />
            {Array.from({ length: colCount }, (_, c) => (
              <th key={c} className={'grid-col' + (ptr.cols.has(c) ? ' pointed' : '') + (c >= width ? ' past-end' : '')}>
                {ptr.cols.has(c) && <span className="grid-ptr">{ptr.cols.get(c)!.join(', ')} ↓</span>}
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }, (_, r) => {
            const rid = rows[r];
            const row = rid === null || rid === undefined ? undefined : (step.heap[rid] as Extract<HeapObj, { kind: 'array' }>);
            const prevRow = rid === null || rid === undefined || isNew ? undefined : prev?.heap[rid];
            const prevItems = prevRow && 'items' in prevRow ? prevRow.items : undefined;
            const rowPtr = ptr.rows.get(r);
            return (
              <tr key={r} data-obj={rid ?? undefined} className={rowPtr ? 'pointed' : undefined}>
                <th className={'grid-row' + (r >= rows.length ? ' past-end' : '')}>
                  {rowPtr && <span className="grid-ptr">{rowPtr.join(', ')} →</span>}
                  {r}
                </th>
                {r >= rows.length ? (
                  <td colSpan={colCount} className="grid-none" />
                ) : !row ? (
                  <td colSpan={colCount} className="grid-none">null</td>
                ) : (
                  Array.from({ length: colCount }, (_, c) => {
                    if (c >= row.items.length) return <td key={c} className="grid-none" />;
                    const v = row.items[c];
                    const cls = [
                      prevItems && !same(prevItems[c], v) ? 'changed' : '',
                      rowPtr && ptr.cols.has(c) ? 'current' : rowPtr || ptr.cols.has(c) ? 'cross' : '',
                    ].join(' ').trim();
                    return (
                      <td key={c} className={cls || undefined}>
                        {cellText(v)}
                      </td>
                    );
                  })
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ValueView({ v, ctx, compact, down }: { v: Value; ctx: Ctx; compact?: boolean; down?: boolean }) {
  switch (v.k) {
    case 'p':
      return <span className="val prim">{v.v}</span>;
    case 's':
      return <span className="val str">"{v.v}"</span>;
    case 'null':
      return <span className="val null">null</span>;
    case 'r': {
      const obj = ctx.step.heap[v.id];
      return (
        <span
          className={'val ref' + (compact || down ? ' compact' : '')}
          data-ref={v.id}
          data-down={down ? '1' : undefined}
          onMouseEnter={() => ctx.onHover(v.id)}
          onMouseLeave={() => ctx.onHover(null)}
          title={obj ? obj.type : 'object'}
        >
          {compact || down ? '' : obj?.type ?? 'obj'}
        </span>
      );
    }
  }
}
