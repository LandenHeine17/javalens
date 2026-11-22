import { useMemo } from 'react';
import { buildCallTree, shortValue, type CallNode } from './analysis';
import type { Step } from './types';

/**
 * Recursion tree: every method call is a box, children are the calls it made.
 * Positions are computed from the WHOLE run so boxes never jump around as you step;
 * only calls that have started by the current step are drawn.
 */
interface Props {
  steps: Step[];
  index: number;
  onPick: (stepIndex: number) => void;
  fontSize: number;
}

const MAX_NODES = 400;

export default function CallTree({ steps, index, onPick, fontSize }: Props) {
  const { nodes, root } = useMemo(() => buildCallTree(steps), [steps]);
  const layout = useMemo(() => layoutTree(nodes, root, fontSize), [nodes, root, fontSize]);

  if (root === null || !layout) return <div className="tree-empty">Run the program to see its calls.</div>;

  const step = steps[index];
  const onStack = new Set(step?.stack.map((f) => f.id));
  const topId = step?.stack[step.stack.length - 1]?.id;
  const visible = (n: CallNode) => n.firstStep <= index;
  const visibleCount = [...nodes.values()].filter(visible).length;
  const ended = [...nodes.values()].filter((n) => n.returnStep !== null && n.returnStep <= index);
  const threw = ended.filter((n) => n.threw).length;
  const finished = ended.length - threw;

  return (
    <div className="tree-wrap">
      <div className="tree-stats">
        {visibleCount} call{visibleCount === 1 ? '' : 's'} so far · {finished} returned{threw ? ` · ${threw} ended by an exception` : ''} · deepest {layout.maxDepth + 1}{' '}
        levels
        {nodes.size > MAX_NODES && <span className="warn"> · showing the first {MAX_NODES} calls</span>}
      </div>
      <svg width={layout.width} height={layout.height} className="tree-svg" style={{ fontSize }}>
        {layout.items.map(({ node, x, y }) => {
          if (!visible(node) || node.parent === null) return null;
          const p = layout.pos.get(node.parent);
          if (!p) return null;
          const live = onStack.has(node.id);
          return (
            <path
              key={'e' + node.id}
              className={'tree-edge' + (live ? ' live' : '')}
              d={`M${p.x},${p.y + layout.h} C${p.x},${p.y + layout.h + layout.vgap / 2} ${x},${y - layout.vgap / 2} ${x},${y}`}
            />
          );
        })}
        {layout.items.map(({ node, x, y }) => {
          if (!visible(node)) return null;
          const returned = node.returnStep !== null && node.returnStep <= index;
          const cls = node.id === topId ? 'current' : onStack.has(node.id) ? 'active' : node.threw && returned ? 'done threw' : 'done';
          const label = `${node.method}(${node.args})`;
          return (
            <g
              key={node.id}
              className={'tree-node ' + cls}
              transform={`translate(${x - layout.w / 2},${y})`}
              onClick={() => onPick(node.firstStep)}
            >
              <title>
                {label}
                {returned && node.threw ? ` ended by ${node.threw}` : ''}
                {returned && !node.threw && node.ret !== undefined ? ` returned ${shortValue(node.ret, steps[node.returnStep!].heap)}` : ''}
                {' — click to jump to this call'}
              </title>
              <rect width={layout.w} height={layout.h} rx={8} />
              <text x={layout.w / 2} y={layout.h * 0.42} textAnchor="middle" className="tree-label">
                {fit(label, layout.chars)}
              </text>
              <text x={layout.w / 2} y={layout.h * 0.82} textAnchor="middle" className="tree-ret">
                {returned && node.threw
                  ? '✕ ' + fit(node.threw, layout.chars - 2)
                  : returned
                  ? node.ret === undefined || node.ret === null
                    ? 'done'
                    : '→ ' + fit(shortValue(node.ret, steps[node.returnStep!].heap), layout.chars - 2)
                  : onStack.has(node.id)
                    ? node.id === topId
                      ? 'running…'
                      : 'waiting…'
                    : ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function fit(s: string, chars: number) {
  return s.length > chars ? s.slice(0, chars - 1) + '…' : s;
}

/** Simple tidy layout: leaves get consecutive x slots, parents sit centered over their children. */
function layoutTree(nodes: Map<number, CallNode>, root: number | null, fontSize: number) {
  if (root === null) return null;
  const charW = fontSize * 0.62;
  // Size boxes to the longest label (capped) so `fib(n=3)` style labels fit.
  let longest = 6;
  let count = 0;
  for (const n of nodes.values()) {
    if (++count > MAX_NODES) break;
    longest = Math.max(longest, `${n.method}(${n.args})`.length);
  }
  const chars = Math.min(longest, 22);
  const w = Math.max(80, chars * charW + 18);
  const h = fontSize * 2.9;
  const hgap = 14;
  const vgap = fontSize * 2.2;

  const items: { node: CallNode; x: number; y: number }[] = [];
  const pos = new Map<number, { x: number; y: number }>();
  let nextLeaf = 0;
  let placed = 0;
  let maxDepth = 0;

  const place = (id: number, depth: number): number => {
    const node = nodes.get(id)!;
    placed++;
    maxDepth = Math.max(maxDepth, depth);
    const kids = node.children.filter(() => placed < MAX_NODES);
    let x: number;
    if (kids.length === 0) {
      x = nextLeaf++ * (w + hgap) + w / 2;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    const y = depth * (h + vgap);
    pos.set(id, { x, y });
    items.push({ node, x, y });
    return x;
  };
  place(root, 0);

  const pad = 8;
  for (const it of items) {
    it.x += pad;
    it.y += pad;
    pos.set(it.node.id, { x: it.x, y: it.y });
  }
  return {
    items,
    pos,
    w,
    h,
    vgap,
    chars,
    maxDepth,
    width: Math.max(nextLeaf, 1) * (w + hgap) + pad * 2,
    height: (maxDepth + 1) * (h + vgap) + pad * 2,
  };
}
