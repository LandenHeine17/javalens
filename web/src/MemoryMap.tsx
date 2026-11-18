import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { HeapObj, Step, Value } from './types';
import {
  ARRAY_HEADER, FRAME_HEADER, HIDDEN_SIZE, OBJECT_HEADER, STRING_SIZE, heapValues, hex, targetId,
  type Layout,
} from './memoryLayout';

/**
 * Memory map: the program's memory as rows of addresses, in three regions.
 *   Static area: one copy of each static field, per class
 *   Stack: one frame per call, newest on top (addresses go DOWN as calls are pushed)
 *   Heap: objects, arrays and Strings; string literals live in the string pool
 * Addresses and sizes are a teaching model (see memoryLayout.ts), not the JVM's real ones.
 */
interface Props {
  step: Step | undefined;
  prev: Step | undefined;
  layout: Layout;
}

interface Ctx {
  step: Step;
  layout: Layout;
  hovered: number | null;
  setHovered: (id: number | null) => void;
  jump: (id: number) => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export default function MemoryMap({ step, prev, layout }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [flash, setFlash] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(t);
  }, [flash]);

  if (!step) return <div className="memory empty">Run the program to see memory.</div>;

  const jump = (id: number) => {
    wrapRef.current?.querySelector(`[data-block="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(id);
  };
  const ctx: Ctx = { step, layout, hovered: hovered ?? flash, setHovered, jump };

  // ---- static area
  const prevStatics = new Map((prev?.statics ?? []).flatMap((c) => c.fields.map((f) => [`${c.cls}.${f.name}`, f.v] as const)));
  const staticRows: ReactNode[] = [];
  for (const c of step.statics ?? []) {
    const slots = layout.statics.get(c.cls);
    staticRows.push(
      <tr className="mm-block-head" key={'c' + c.cls}>
        <td className="mm-addr">{slots && hex(Math.min(...[...slots.values()].map((s) => s.addr)))}</td>
        <td />
        <td colSpan={3}>
          <span className="mm-kind">class</span> <b className="mm-cls">{c.cls}</b>
        </td>
      </tr>,
    );
    for (const f of c.fields) {
      const slot = slots?.get(f.name);
      const changed = !!prev && prevStatics.has(`${c.cls}.${f.name}`) && !same(prevStatics.get(`${c.cls}.${f.name}`), f.v);
      staticRows.push(
        <Row key={`c${c.cls}.${f.name}`} addr={slot?.addr} size={slot?.size} type={f.type} changed={changed}
          name={<>{f.name}<Badge kind="static" />{f.final && <Badge kind="final" />}</>}
          value={<Val v={f.v} type={f.type} ctx={ctx} />} />,
      );
    }
  }

  // ---- stack (newest call first, so addresses read top-down like a real stack diagram)
  const prevFrames = new Map((prev?.stack ?? []).map((f) => [f.id, f]));
  const stackRows: ReactNode[] = [];
  const frames = [...step.stack].reverse();
  frames.forEach((f, i) => {
    const fl = layout.frames.get(f.id);
    const prevFrame = prevFrames.get(f.id);
    const prevLocals = new Map((prevFrame?.locals ?? []).map((l) => [l.name, l.v]));
    const isTop = i === 0;
    stackRows.push(
      <tr className={'mm-block-head' + (isTop ? ' top' : '') + (!prevFrame ? ' pushed' : '')} key={'f' + f.id}>
        <td className="mm-addr">{fl && hex(fl.base)}</td>
        <td className="mm-size">{fl?.size}</td>
        <td colSpan={3}>
          <span className="mm-kind">frame</span> <b className="mm-method">{f.method}()</b>
          <span className="mm-note"> line {f.line}</span>
          {isTop && <span className={'pill ' + (step.kind === 'return' ? 'returning' : 'running')}>{step.kind === 'return' ? 'returning' : 'running'}</span>}
        </td>
      </tr>,
    );
    if (fl) {
      stackRows.push(
        <Row key={'h' + f.id} addr={fl.base - FRAME_HEADER} size={FRAME_HEADER} type="" muted
          name="(return address)" value={<span className="mm-note">where to go back to when this call ends</span>} />,
      );
    }
    const locals = [...f.locals].sort((a, b) => (fl?.slots.get(b.name)?.addr ?? 0) - (fl?.slots.get(a.name)?.addr ?? 0));
    for (const l of locals) {
      const slot = fl?.slots.get(l.name);
      const changed = !!prevFrame && !same(prevLocals.get(l.name), l.v);
      stackRows.push(
        <Row key={`l${f.id}.${l.name}`} addr={slot?.addr} size={slot?.size} type={l.type} changed={changed}
          name={<>{l.name}{l.final && <Badge kind="final" />}</>}
          value={<Val v={l.v} type={l.type} ctx={ctx} />} />,
      );
    }
    if (isTop && step.kind === 'return' && f.ret !== undefined) {
      stackRows.push(
        <Row key={'r' + f.id} type="" name={<span className="mm-ret">returns</span>}
          value={f.ret ? <Val v={f.ret} ctx={ctx} /> : <span className="mm-note">void</span>} />,
      );
    }
  });

  // ---- heap: every object and String this step can see, in address order
  const strings = collectStrings(step);
  const prevIds = prev ? new Set([...Object.keys(prev.heap).map(Number), ...collectStrings(prev).keys()]) : null;
  const ids = [...Object.keys(step.heap).map(Number), ...strings.keys()]
    .filter((id) => layout.objects.has(id))
    .sort((a, b) => layout.objects.get(a)!.addr - layout.objects.get(b)!.addr);
  const pooled = ids.filter((id) => strings.get(id)?.pool);
  const regular = ids.filter((id) => !strings.get(id)?.pool);
  const heapBlock = (id: number) => {
    const isNew = !!prevIds && !prevIds.has(id);
    const s = strings.get(id);
    return s ? (
      <StringBlock key={id} id={id} text={s.v} pooled={!!s.pool} isNew={isNew} ctx={ctx} />
    ) : (
      <ObjectBlock key={id} id={id} obj={step.heap[id]} prevObj={prev?.heap[id]} isNew={isNew} ctx={ctx} />
    );
  };

  return (
    <div className="memmap" ref={wrapRef}>
      <Region title="Static area" hint="one copy per class, shared by every object">
        {staticRows.length ? staticRows : <EmptyRow text="no static fields" />}
      </Region>

      <Region title="Stack" hint="newest call on top · grows toward lower addresses">
        {stackRows}
      </Region>

      <Region title="Heap" hint="objects, arrays and Strings · created with new">
        {pooled.length > 0 && (
          <tr className="mm-subregion" key="pool">
            <td colSpan={5}>String pool <span className="mm-note">one shared object per literal, so "hi" == "hi"</span></td>
          </tr>
        )}
        {pooled.map(heapBlock)}
        {pooled.length > 0 && regular.length > 0 && (
          <tr className="mm-subregion" key="objs">
            <td colSpan={5}>Objects</td>
          </tr>
        )}
        {regular.map(heapBlock)}
        {ids.length === 0 && <EmptyRow text="nothing on the heap yet" />}
      </Region>

      <p className="mm-footnote">
        A teaching model of memory: a 64-bit JVM with 8-byte references, a 16-byte object header and objects aligned to 8 bytes.
        Real JVMs pick their own addresses, may reorder fields, and move objects during garbage collection.
      </p>
    </div>
  );
}

// ------------------------------------------------------------ pieces

function Region({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="mm-region">
      <div className="col-title">
        {title} <span className="col-hint">{hint}</span>
      </div>
      <table className="mm-table">
        <colgroup>
          <col className="c-addr" />
          <col className="c-size" />
          <col className="c-type" />
          <col className="c-name" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Address</th>
            <th>Bytes</th>
            <th>Type</th>
            <th>Name</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </section>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <tr>
      <td colSpan={5} className="mm-empty">{text}</td>
    </tr>
  );
}

function Badge({ kind }: { kind: 'static' | 'final' }) {
  return <span className={'badge ' + kind}>{kind}</span>;
}

function Row(props: {
  addr?: number;
  size?: number;
  type: string;
  name: ReactNode;
  value: ReactNode;
  changed?: boolean;
  muted?: boolean;
  hot?: boolean;
}) {
  const { addr, size, type, name, value, changed, muted, hot } = props;
  return (
    <tr className={'mm-row' + (changed ? ' changed' : '') + (muted ? ' muted' : '') + (hot ? ' hot' : '')}>
      <td className="mm-addr">{addr !== undefined ? hex(addr) : ''}</td>
      <td className="mm-size">{size ?? ''}</td>
      <td className="mm-type">{type}</td>
      <td className="mm-name">{name}</td>
      <td className="mm-val">{value}</td>
    </tr>
  );
}

/** A value as it's stored: primitives hold the value itself, references hold an address. */
function Val({ v, type, ctx }: { v: Value; type?: string; ctx: Ctx }) {
  if (v.k === 'p') return <span className="val prim">{v.v}</span>;
  if (v.k === 'null') {
    return (
      <span className="mm-null">
        <span className="mm-ptr">0x0</span> null
      </span>
    );
  }
  const id = targetId(v);
  const block = id !== null ? ctx.layout.objects.get(id) : undefined;
  const target = v.k === 'r' ? ctx.step.heap[v.id]?.type : 'String';
  return (
    <span
      className={'mm-ref' + (ctx.hovered === id ? ' hot' : '')}
      onMouseEnter={() => id !== null && ctx.setHovered(id)}
      onMouseLeave={() => ctx.setHovered(null)}
      onClick={() => id !== null && ctx.jump(id)}
      title="Click to jump to the object this address points at"
    >
      <span className="mm-ptr">→ {block ? hex(block.addr) : '?'}</span>
      {v.k === 's' ? <span className="val str">"{v.v}"</span> : <span className="mm-note">{target ?? type}</span>}
    </span>
  );
}

function StringBlock({ id, text, pooled, isNew, ctx }: { id: number; text: string; pooled: boolean; isNew: boolean; ctx: Ctx }) {
  const block = ctx.layout.objects.get(id)!;
  const hot = ctx.hovered === id;
  return (
    <>
      <BlockHead id={id} addr={block.addr} size={STRING_SIZE} type="String" isNew={isNew} hot={hot}
        extra={pooled ? <span className="badge pool">string pool</span> : <span className="mm-note">not pooled</span>} />
      <Row addr={block.addr} size={OBJECT_HEADER} type="" name="(header)" value={<span className="mm-note">class pointer, hash, lock</span>} muted hot={hot} />
      <Row addr={block.addr + OBJECT_HEADER} size={8} type="byte[]" name="value" value={<span className="val str">"{text}"</span>} hot={hot} />
    </>
  );
}

function BlockHead(props: { id: number; addr: number; size: number; type: string; isNew: boolean; hot: boolean; extra?: ReactNode }) {
  const { id, addr, size, type, isNew, hot, extra } = props;
  return (
    <tr className={'mm-block-head' + (isNew ? ' pushed' : '') + (hot ? ' hot' : '')} data-block={id}>
      <td className="mm-addr">{hex(addr)}</td>
      <td className="mm-size">{size}</td>
      <td colSpan={3}>
        <b className="mm-cls">{type}</b> {extra}
      </td>
    </tr>
  );
}

function ObjectBlock({ id, obj, prevObj, isNew, ctx }: { id: number; obj: HeapObj; prevObj?: HeapObj; isNew: boolean; ctx: Ctx }) {
  const block = ctx.layout.objects.get(id)!;
  const hot = ctx.hovered === id;
  const rows: ReactNode[] = [];

  if (obj.kind === 'object') {
    const prevFields = new Map(prevObj?.kind === 'object' ? prevObj.fields.map((f) => [f.name, f.v]) : []);
    rows.push(<Row key="h" addr={block.addr} size={OBJECT_HEADER} type="" name="(header)" value={<span className="mm-note">class pointer, hash, lock</span>} muted hot={hot} />);
    obj.fields.forEach((f, i) => {
      const slot = block.slots[i];
      rows.push(
        <Row key={f.name} addr={slot?.addr} size={slot?.size} type={f.type ?? ''} hot={hot}
          changed={!isNew && prevFields.has(f.name) && !same(prevFields.get(f.name), f.v)}
          name={<>.{f.name}{f.final && <Badge kind="final" />}</>} value={<Val v={f.v} type={f.type} ctx={ctx} />} />,
      );
    });
  } else if (obj.kind === 'array') {
    const prevItems = prevObj?.kind === 'array' ? prevObj.items : [];
    const elemType = obj.type.replace(/\[\]$/, '');
    rows.push(<Row key="h" addr={block.addr} size={ARRAY_HEADER} type="" name="(header)" value={<span className="mm-note">length = {obj.len}</span>} muted hot={hot} />);
    obj.items.forEach((v, i) => {
      const slot = block.slots[i];
      rows.push(
        <Row key={i} addr={slot?.addr} size={slot?.size} type={elemType} hot={hot}
          changed={!isNew && !same(prevItems[i], v)}
          name={`[${i}]`} value={<Val v={v} type={elemType} ctx={ctx} />} />,
      );
    });
    if (obj.len > obj.items.length) rows.push(<Row key="more" type="" name="…" value={<span className="mm-note">{obj.len - obj.items.length} more</span>} muted hot={hot} />);
  } else {
    // java.util collections and library objects: show what they hold, not how they hold it.
    const vals = heapValues(obj);
    rows.push(
      <Row key="c" type="" hot={hot} name="(contents)" muted={vals.length === 0}
        value={
          vals.length === 0 ? (
            <span className="mm-note">{obj.kind === 'opaque' ? 'library object, internals hidden' : 'empty'}</span>
          ) : (
            <span className="mm-contents">
              {obj.kind === 'map'
                ? obj.entries.map((e, i) => (
                    <span key={i} className="mm-entry">
                      <Val v={e.k} ctx={ctx} /> → <Val v={e.v} ctx={ctx} />
                    </span>
                  ))
                : vals.map((v, i) => (
                    <span key={i} className="mm-entry">
                      <Val v={v} ctx={ctx} />
                    </span>
                  ))}
            </span>
          )
        }
      />,
    );
  }

  const meta = obj.kind === 'array' ? `length ${obj.len}` : obj.kind === 'list' || obj.kind === 'map' ? `size ${obj.len} · internals hidden` : '';
  return (
    <>
      <BlockHead id={id} addr={block.addr} size={obj.kind === 'object' || obj.kind === 'array' ? block.size : HIDDEN_SIZE}
        type={obj.type} isNew={isNew} hot={hot} extra={meta && <span className="mm-note">{meta}</span>} />
      {rows}
    </>
  );
}

/** Every String this step can see (variables, statics, fields, elements), by object id. */
function collectStrings(step: Step): Map<number, Extract<Value, { k: 's' }>> {
  const out = new Map<number, Extract<Value, { k: 's' }>>();
  const add = (v: Value | null | undefined) => {
    if (v?.k === 's' && v.id !== undefined && !out.has(v.id)) out.set(v.id, v);
  };
  step.statics?.forEach((c) => c.fields.forEach((f) => add(f.v)));
  step.stack.forEach((f) => {
    f.locals.forEach((l) => add(l.v));
    add(f.ret);
  });
  Object.values(step.heap).forEach((o) => heapValues(o).forEach(add));
  return out;
}

