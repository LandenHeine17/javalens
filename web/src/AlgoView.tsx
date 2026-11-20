import { useEffect, useMemo, useState } from 'react';
import { Flag, Pause, Play, RotateCcw, Swords } from 'lucide-react';
import type { Project, RunResult, Step } from './types';
import { indexVariableNames } from './analysis';
import {
  analyzeRun, candidateArrays, cellsOf, helperArrays, indexVarsByArray, intVars, namesOf, pointerNamesFor, pointersFor, ranges, searchTarget, withSameInput,
  type Cell, type RunAnalysis,
} from './algoAnalysis';

/**
 * Sort & Search: the array the program sorts or searches, as bars. Each step shows what's compared
 * (accent), written or swapped (amber), settled in its final place (green) and ruled out (faded),
 * with index pointers, the lo..hi range of every call working on it, helper arrays (merge sort's
 * left/right) and running counters. Race mode runs a second program on the same input beside it.
 */
interface Props {
  steps: Step[];
  index: number;
  code: string;
  project: Project | null;
  stdin: string;
  samples: { name: string; code: string }[];
}

const EXTRA_INDEX_NAMES = ['lo', 'hi', 'low', 'high', 'mid', 'start', 'end', 'first', 'last', 'l', 'r', 'i', 'j', 'k', 'min', 'p', 'pivotIndex', 'minIndex', 'maxIndex'];

/** Source line a step is about to run, from the main file or (multi-file projects) another file. */
function lineSource(code: string, project: Project | null) {
  const main = code.split('\n');
  const others = new Map((project?.files ?? []).map((f) => [f.path, f.code.split('\n')]));
  return (step: Step) => ((step.file ? others.get(step.file) : main) ?? [])[step.line - 1] ?? '';
}

export default function AlgoView({ steps, index, code, project, stdin, samples }: Props) {
  const candidates = useMemo(() => candidateArrays(steps), [steps]);
  const [picked, setPicked] = useState<string | null>(null);
  const focus = picked && candidates.includes(picked) ? picked : candidates[0] ?? null;
  const names = useMemo(() => new Set([...indexVariableNames(code), ...EXTRA_INDEX_NAMES]), [code]);
  const byArray = useMemo(() => indexVarsByArray([code, ...(project?.files ?? []).map((f) => f.code)]), [code, project]);
  const analysis = useMemo(() => analyzeRun(steps, focus, lineSource(code, project)), [steps, focus, code, project]);
  const [racing, setRacing] = useState(false);

  const step = steps[index];
  if (!step) return <div className="memory empty">Run the program to see its array.</div>;
  if (!focus) {
    return (
      <div className="memory empty">
        No array yet. This view shows a program that sorts or searches an array, like the <b>BubbleSort</b>, <b>MergeSort</b> or{' '}
        <b>BinarySearch</b> examples.
      </div>
    );
  }

  const target = searchTarget(step);
  const showTarget = target && !(analysis.sorting && target.name === 'key'); // insertion sort's key isn't a search

  return (
    <div className="algo">
      <div className="algo-head">
        {candidates.length > 1 ? (
          <label className="algo-pick" title="Which array to show">
            Array
            <select value={focus} onChange={(e) => setPicked(e.target.value)}>
              {candidates.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        ) : (
          <span className="algo-pick">
            Array <b>{focus}</b>
          </span>
        )}
        {showTarget && (
          <span className="algo-target">
            looking for <b>{target.value}</b>
          </span>
        )}
        <Counters a={analysis} index={index} />
        <button className={'algo-race-btn' + (racing ? ' on' : '')} onClick={() => setRacing(!racing)} title="Run another algorithm on the same input, side by side">
          <Swords size={14} /> Race
        </button>
      </div>

      {racing ? (
        <Race steps={steps} analysis={analysis} code={code} project={project} stdin={stdin} samples={samples} names={names} byArray={byArray} />
      ) : (
        <>
          <Bars steps={steps} a={analysis} index={index} names={names} byArray={byArray} />
          <Helpers steps={steps} a={analysis} index={index} names={names} byArray={byArray} />
          <Legend sorting={analysis.sorting} />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ counters

function Counters({ a, index, compact }: { a: RunAnalysis; index: number; compact?: boolean }) {
  const i = Math.min(index, a.comparisons.length - 1);
  return (
    <div className={'algo-counters' + (compact ? ' compact' : '')}>
      <span title="Times a line comparing array values ran">
        <b>{a.comparisons[i] ?? 0}</b> {plural(a.comparisons[i] ?? 0, 'comparison')}
      </span>
      {a.sorting && (
        <>
          <span title="Pairs of cells that traded places">
            <b>{a.swaps[i] ?? 0}</b> {plural(a.swaps[i] ?? 0, 'swap')}
          </span>
          <span title="Cells changed">
            <b>{a.writes[i] ?? 0}</b> {plural(a.writes[i] ?? 0, 'write')}
          </span>
        </>
      )}
      <span title="Lines executed">
        <b>{i + 1}</b> {plural(i + 1, 'step')}
      </span>
      {!compact && <Spark a={a} index={i} />}
    </div>
  );
}

const plural = (n: number, word: string) => (n === 1 ? word : word + 's');

/** Cumulative comparisons (accent) and writes (amber) over the whole run, with the current step marked. */
function Spark({ a, index }: { a: RunAnalysis; index: number }) {
  const n = a.comparisons.length;
  if (n < 2) return null;
  const W = 140, H = 28;
  const top = Math.max(1, a.comparisons[n - 1], a.writes[n - 1]);
  const line = (vals: number[]) => vals.map((v, i) => `${((i / (n - 1)) * W).toFixed(1)},${(H - (v / top) * (H - 2) - 1).toFixed(1)}`).join(' ');
  const x = (index / (n - 1)) * W;
  return (
    <svg className="algo-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label="Comparisons and writes over the run">
      <polyline points={line(a.comparisons)} className="spark-cmp" />
      {a.sorting && <polyline points={line(a.writes)} className="spark-wr" />}
      <line x1={x} x2={x} y1={0} y2={H} className="spark-now" />
    </svg>
  );
}

// ------------------------------------------------------------ the bars

interface BarsProps {
  steps: Step[];
  a: RunAnalysis;
  index: number;
  names: Set<string>;
  byArray: Map<string, Set<string>>;
  compact?: boolean;
}

function Bars({ steps, a, index: at, names, byArray, compact }: BarsProps) {
  // Before the array is created, preview its first contents (faded) instead of an empty space.
  const created = a.cells.findIndex((c) => c !== null);
  const pending = !a.cells[at] && created > at;
  const index = pending ? created : at;
  const step = steps[index];
  const id = a.ids[index];
  const cells = a.cells[index];
  if (!step || id === null || !cells) {
    return <div className="algo-empty">{a.focus} doesn't exist at this step.</div>;
  }
  const n = cells.length;
  const last = index === steps.length - 1;
  const compared = new Set(a.compared[index].get(id) ?? []);
  const written = new Set(a.written[index]);
  const swap = a.swapped[index];
  const rs = ranges(step, id);
  const active = rs[rs.length - 1]; // the deepest call's range: everything outside is ruled out
  const owner = [...step.stack].reverse().find((f) => f.locals.some((l) => l.v.k === 'r' && l.v.id === id));
  const ptrs = pointersFor(owner, n, pointerNamesFor(namesOf(owner, id), byArray, names));
  const lo = Math.min(0, a.min);
  const span = a.max - lo || 1;

  // Quick sort's pivot: a dashed line at its height, so "smaller goes left" is visible.
  const pivotVar = intVars(step.stack[step.stack.length - 1]).get('pivot');
  const pivotAt = a.numeric && pivotVar !== undefined ? ((pivotVar - lo) / span) * 100 : null;

  const settled = (k: number) =>
    a.sorting && (last || (index >= a.settledFrom[k] && a.settledFrom[k] > 0)) && !written.has(k);

  return (
    <div className={'algo-array' + (compact ? ' compact' : '') + (pending ? ' pending' : '')} style={{ ['--n' as string]: n }}>
      {pending && <div className="algo-pending">{a.focus} is created at step {created + 1}</div>}
      {!compact && rs.length > 0 && (
        <div className="algo-brackets">
          {rs.map((r) => (
            <div key={r.frameId} className={'algo-bracket-row' + (r === active ? ' active' : '')}>
              <div className="algo-bracket" style={{ gridColumn: `${Math.max(0, r.lo) + 1} / ${Math.min(n - 1, r.hi) + 2}` }}>
                <span>
                  {r.method}({r.lo}..{r.hi})
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="algo-bars">
        {cells.map((c, k) => {
          const h = typeof c === 'number' && a.numeric ? ((c - lo) / span) * 100 : 60;
          const out = active && (k < active.lo || k > active.hi);
          const cls = [
            'algo-bar',
            compared.has(k) ? 'compared' : '',
            written.has(k) ? 'written' : '',
            settled(k) ? 'settled' : '',
            out ? 'out' : '',
            active?.mid === k ? 'mid' : '',
          ].join(' ');
          return (
            <div className={cls} key={k} title={`${a.focus}[${k}] = ${c}`}>
              <div className="algo-bar-fill" style={{ height: `max(${h}%, 3px)` }}>
                <span className="algo-bar-val">{fmt(c)}</span>
              </div>
            </div>
          );
        })}
        {swap && <SwapArrow from={swap[0]} to={swap[1]} n={n} />}
        {pivotAt !== null && (
          <div className="algo-pivot" style={{ bottom: `${pivotAt}%` }}>
            <span>pivot {pivotVar}</span>
          </div>
        )}
      </div>

      <div className="algo-idx">
        {cells.map((_, k) => (
          <span key={k}>{k}</span>
        ))}
      </div>
      <div className="algo-ptrs">
        {Array.from({ length: n + 1 }, (_, k) => (
          <span key={k}>{ptrs.get(k) ? '↑ ' + ptrs.get(k)!.join(', ') : ''}</span>
        ))}
      </div>
    </div>
  );
}

const fmt = (c: Cell) => (typeof c === 'number' && !Number.isInteger(c) ? c.toFixed(2).replace(/0+$/, '') : String(c));

function SwapArrow({ from, to, n }: { from: number; to: number; n: number }) {
  const x1 = ((Math.min(from, to) + 0.5) / n) * 100;
  const x2 = ((Math.max(from, to) + 0.5) / n) * 100;
  return (
    <svg className="algo-swap" viewBox="0 0 100 20" preserveAspectRatio="none" aria-label={`swapped ${from} and ${to}`}>
      <path d={`M${x1},18 C${x1},2 ${x2},2 ${x2},18`} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Arrays the running call holds besides the main one (merge sort's left/right, a temp copy...). */
function Helpers({ steps, a, index, names, byArray }: { steps: Step[]; a: RunAnalysis; index: number; names: Set<string>; byArray: Map<string, Set<string>> }) {
  const step = steps[index];
  const prev = steps[index - 1];
  const helpers = helperArrays(step, a.ids[index]);
  if (!helpers.length) return null;
  const top = step.stack[step.stack.length - 1];
  return (
    <div className="algo-helpers">
      {helpers.map(([name, id]) => {
        const cells = cellsOf(step.heap[id]) ?? [];
        const before = prev ? cellsOf(prev.heap[id]) : null;
        const compared = new Set(a.compared[index].get(id) ?? []);
        const ptrs = pointersFor(top, cells.length, pointerNamesFor([name], byArray, names));
        const lo = Math.min(0, a.min);
        const span = a.max - lo || 1;
        return (
          <div className="algo-helper" key={name} style={{ ['--n' as string]: Math.max(cells.length, 1) }}>
            <div className="algo-helper-name">
              {top.method}(): <b>{name}</b>
            </div>
            <div className="algo-bars small">
              {cells.length === 0 && <span className="algo-empty">empty</span>}
              {cells.map((c, k) => {
                const h = typeof c === 'number' ? ((c - lo) / span) * 100 : 60;
                const cls = ['algo-bar', compared.has(k) ? 'compared' : '', before && before[k] !== c ? 'written' : ''].join(' ');
                return (
                  <div className={cls} key={k} title={`${name}[${k}] = ${c}`}>
                    <div className="algo-bar-fill" style={{ height: `max(${h}%, 3px)` }}>
                      <span className="algo-bar-val">{fmt(c)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="algo-ptrs small">
              {Array.from({ length: cells.length + 1 }, (_, k) => (
                <span key={k}>{ptrs.get(k) ? '↑ ' + ptrs.get(k)!.join(', ') : ''}</span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Legend({ sorting }: { sorting: boolean }) {
  return (
    <div className="algo-legend">
      <span><i className="compared" /> being compared</span>
      {sorting && <span><i className="written" /> written / swapped</span>}
      {sorting && <span><i className="settled" /> in its final place</span>}
      <span><i className="out" /> outside the current range</span>
    </div>
  );
}

// ------------------------------------------------------------ race

const SPEEDS = [4, 10, 25, 60]; // steps per second

function Race(props: {
  steps: Step[];
  analysis: RunAnalysis;
  code: string;
  project: Project | null;
  stdin: string;
  samples: { name: string; code: string }[];
  names: Set<string>;
  byArray: Map<string, Set<string>>;
}) {
  const { steps, analysis, code, stdin, samples, names, byArray } = props;
  const choices = samples.filter((s) => /Sort|Search/.test(s.name) && withSameInput(code, s.code) !== null);
  // Default opponent: another algorithm of the same kind (a search against a search, a sort against a sort).
  const [other, setOther] = useState(() => {
    const kind = /class\s+\w*Search/.test(code) ? 'Search' : 'Sort';
    const others = choices.filter((s) => !code.includes(`class ${s.name}`));
    return (others.find((s) => s.name.includes(kind)) ?? others[0] ?? choices[0])?.name ?? '';
  });
  const [b, setB] = useState<{ steps: Step[]; end: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const sample = choices.find((s) => s.name === other);
  const bCode = sample ? withSameInput(code, sample.code) : null;

  // Run program B whenever the choice or A's input changes.
  useEffect(() => {
    if (!bCode) return;
    const ctrl = new AbortController();
    setError(null);
    setPlaying(false);
    setT(0);
    fetch('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: bCode, stdin }), // samples are single files
      signal: ctrl.signal,
    })
      .then((r) => r.json() as Promise<RunResult>)
      .then((data) => {
        if (data.ok) setB({ steps: data.steps, end: data.end, name: other });
        else setError(data.error === 'compile' ? `${other} didn't compile with this input.` : data.message);
      })
      .catch((e) => (e as Error).name !== 'AbortError' && setError('Could not run ' + other));
    return () => ctrl.abort();
  }, [bCode, other, stdin]);

  const bFocus = useMemo(() => (b ? candidateArrays(b.steps)[0] ?? null : null), [b]);
  const bAnalysis = useMemo(
    () => (b ? analyzeRun(b.steps, bFocus, (s) => (bCode ?? '').split('\n')[s.line - 1] ?? '') : null),
    [b, bFocus, bCode],
  );
  const bByArray = useMemo(() => indexVarsByArray([bCode ?? '']), [bCode]);
  const longest = Math.max(steps.length, b?.steps.length ?? 0);
  const finished = t >= longest - 1 && longest > 1;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setT((x) => {
        if (x >= longest - 1) {
          setPlaying(false);
          return x;
        }
        return x + 1;
      });
    }, 1000 / SPEEDS[speed]);
    return () => clearInterval(timer);
  }, [playing, speed, longest]);

  if (!choices.length) {
    return <div className="algo-empty">Race needs the program to start with an array literal, like <code>int[] arr = {'{5, 2, 9}'};</code></div>;
  }

  const lane = (title: string, st: Step[], a: RunAnalysis, end: string, map: Map<string, Set<string>>) => {
    const i = Math.min(t, st.length - 1);
    const done = t >= st.length - 1;
    return (
      <div className={'algo-lane' + (done ? ' done' : '')}>
        <div className="algo-lane-head">
          <b>{title}</b>
          {done && (
            <span className="algo-finish">
              <Flag size={12} /> finished at step {st.length}
            </span>
          )}
          {end === 'step_limit' && <span className="algo-note">stopped at the step limit: try a shorter array</span>}
        </div>
        <Counters a={a} index={i} compact />
        <Bars steps={st} a={a} index={i} names={names} byArray={map} compact />
      </div>
    );
  };

  return (
    <div className="algo-race">
      <div className="algo-race-bar">
        <span>
          This program vs.{' '}
          <select value={other} onChange={(e) => setOther(e.target.value)}>
            {choices.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>{' '}
          on the same input
        </span>
        <div className="group">
          <button
            onClick={() => {
              if (finished) setT(0);
              setPlaying(finished || !playing);
            }}
            disabled={!bAnalysis}
            className="btn primary"
          >
            {playing ? <Pause size={14} /> : <Play size={14} fill="currentColor" />} {playing ? 'Pause' : finished ? 'Replay' : t > 0 ? 'Resume' : 'Start'}
          </button>
          <button onClick={() => (setPlaying(false), setT(0))} title="Back to the start">
            <RotateCcw size={14} />
          </button>
          <button onClick={() => setSpeed((speed + 1) % SPEEDS.length)} title="Race speed (steps per second)">
            {SPEEDS[speed]}/s
          </button>
        </div>
        <span className="algo-note">step {Math.min(t + 1, longest)} of {longest}</span>
      </div>
      {error && <div className="algo-empty">{error}</div>}
      <div className="algo-lanes">
        {lane('This program', steps, analysis, 'finished', byArray)}
        {b && bAnalysis ? lane(b.name, b.steps, bAnalysis, b.end, bByArray) : !error && <div className="algo-lane algo-empty">running {other}…</div>}
      </div>
      <p className="algo-note">Both programs run one line per tick, so the one that needs fewer steps finishes first. Keep the array to about 20 elements; longer runs hit the step limit.</p>
    </div>
  );
}

