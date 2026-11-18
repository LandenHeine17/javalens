import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { bestFit, parseVary, samplePoints } from './analysis';
import type { CountResult } from './types';

/**
 * Big-O experiment: re-run the program for several values of one variable (marked with
 * `// @vary 1..20`), count how many lines execute each time, and chart count vs n.
 */
interface Point {
  n: number;
  count: number;
  end: string;
}

export default function Growth({ code, stdin, extra }: { code: string; stdin: string; extra?: Record<string, string> }) {
  const vary = useMemo(() => parseVary(code), [code]);
  const [samples, setSamples] = useState(8);
  const [points, setPoints] = useState<Point[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const ranFor = useRef<string>('');

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    if (!vary) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPoints([]);
    setError(null);
    const ns = samplePoints(vary.from, vary.to, samples);
    const out: Point[] = [];
    try {
      for (const [i, n] of ns.entries()) {
        setProgress(`running ${vary.name} = ${n}  (${i + 1}/${ns.length})`);
        const res = await fetch('/count', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: vary.substitute(n), stdin, ...extra }),
          signal: ctrl.signal,
        });
        const data: CountResult = await res.json();
        if (!data.ok) {
          setError(data.error === 'compile' ? 'The program has a compile error.' : data.message);
          break;
        }
        out.push({ n, count: data.count, end: data.end });
        setPoints([...out]);
        if (data.end !== 'finished') {
          setError(`${vary.name} = ${n} took too long to count, so the experiment stopped there. Try a smaller range.`);
          break;
        }
      }
      ranFor.current = code;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError('Cannot reach the Java server.');
    } finally {
      setProgress(null);
    }
  };

  if (!vary) {
    return (
      <div className="growth-help">
        <h3>Measure how a program grows</h3>
        <p>
          Put <code>// @vary FROM..TO</code> after the variable that controls the input size. JavaLens re-runs the
          program for several values, counts the lines that execute, and charts the result.
        </p>
        <pre>{'int n = 8; // @vary 1..20'}</pre>
        <p className="muted">Try the BigO example in the Examples menu.</p>
      </div>
    );
  }

  const fit = points.length >= 3 ? bestFit(points) : null;
  const stale = points.length > 0 && ranFor.current !== code && !progress;

  return (
    <div className="growth">
      <div className="growth-bar">
        <span>
          Varying <b>{vary.name}</b> from {vary.from} to {vary.to} (line {vary.line}) in
        </span>
        <select value={samples} onChange={(e) => setSamples(Number(e.target.value))}>
          {[4, 6, 8, 10, 12].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span>runs</span>
        <button className="run" onClick={run} disabled={!!progress}>
          {progress ? 'Running…' : 'Run experiment'}
        </button>
        {points.length > 0 && (
          <button onClick={() => setShowTable(!showTable)} className={showTable ? 'on' : ''}>
            Table
          </button>
        )}
      </div>
      {progress && <div className="muted growth-note">{progress}</div>}
      {stale && <div className="muted growth-note">The code changed since this run. Run it again to update.</div>}
      {error && <div className="banner warn">{error}</div>}
      {fit && (
        <div className="growth-verdict">
          Looks like <b>{fit.name}</b>
          <span className="muted"> · lines executed ≈ {fmtFit(fit.c, fit.a, fit.name)}</span>
        </div>
      )}
      {points.length > 0 && <Chart points={points} fit={fit} varName={vary.name} />}
      {showTable && points.length > 0 && (
        <table className="growth-table">
          <thead>
            <tr>
              <th>{vary.name}</th>
              <th>lines executed</th>
              {fit && <th>{fit.name} fit</th>}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.n}>
                <td>{p.n}</td>
                <td>{p.count.toLocaleString()}</td>
                {fit && <td>{Math.round(fit.a + fit.c * fit.f(p.n)).toLocaleString()}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function fmtFit(c: number, a: number, name: string) {
  const term = name.replace(/^O\((.*)\)$/, '$1');
  const cs = c >= 10 ? c.toFixed(0) : c.toFixed(1);
  if (term === '1') return Math.round(a).toString();
  return `${cs}·${term} ${a >= 0 ? '+' : '−'} ${Math.abs(Math.round(a))}`;
}

function Chart({
  points,
  fit,
  varName,
}: {
  points: Point[];
  fit: ReturnType<typeof bestFit>;
  varName: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const height = 280;
  const m = { top: 16, right: 24, bottom: 40, left: 64 };
  const pw = Math.max(100, width - m.left - m.right);
  const ph = height - m.top - m.bottom;
  const minN = Math.min(...points.map((p) => p.n));
  const maxN = Math.max(...points.map((p) => p.n), minN + 1);
  const maxY = niceMax(Math.max(...points.map((p) => p.count)));
  const x = (n: number) => m.left + ((n - minN) / (maxN - minN)) * pw;
  const y = (c: number) => m.top + ph - (Math.max(0, c) / maxY) * ph;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.n).toFixed(1)},${y(p.count).toFixed(1)}`).join(' ');
  let fitPath = '';
  if (fit) {
    const segs: string[] = [];
    for (let i = 0; i <= 60; i++) {
      const n = minN + ((maxN - minN) * i) / 60;
      const v = fit.a + fit.c * fit.f(n);
      if (v > maxY * 1.05) break;
      segs.push(`${segs.length ? 'L' : 'M'}${x(n).toFixed(1)},${y(v).toFixed(1)}`);
    }
    fitPath = segs.join(' ');
  }
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * maxY);
  const xTicks = points.length <= 12 ? points.map((p) => p.n) : [minN, maxN];
  const hp = hover !== null ? points[hover] : null;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Lines executed versus ${varName}`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const mx = e.clientX - r.left;
          let best = 0;
          points.forEach((p, i) => {
            if (Math.abs(x(p.n) - mx) < Math.abs(x(points[best].n) - mx)) best = i;
          });
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={m.left} x2={m.left + pw} y1={y(t)} y2={y(t)} className="grid" />
            <text x={m.left - 8} y={y(t)} className="axis-label" textAnchor="end" dominantBaseline="middle">
              {compact(t)}
            </text>
          </g>
        ))}
        {xTicks.map((n) => (
          <text key={n} x={x(n)} y={m.top + ph + 18} className="axis-label" textAnchor="middle">
            {n}
          </text>
        ))}
        <text x={m.left + pw / 2} y={height - 4} className="axis-title" textAnchor="middle">
          {varName}
        </text>
        <text x={14} y={m.top + ph / 2} className="axis-title" textAnchor="middle" transform={`rotate(-90 14 ${m.top + ph / 2})`}>
          lines executed
        </text>

        {fitPath && <path d={fitPath} className="fit-line" />}
        {fit && fitPath && (
          <text x={m.left + pw - 4} y={m.top + 12} className="fit-label" textAnchor="end">
            dashed: best fit {fit.name}
          </text>
        )}
        <path d={line} className="series-line" />
        {hp && <line x1={x(hp.n)} x2={x(hp.n)} y1={m.top} y2={m.top + ph} className="crosshair" />}
        {points.map((p, i) => (
          <circle key={p.n} cx={x(p.n)} cy={y(p.count)} r={hover === i ? 6 : 4.5} className="series-dot" />
        ))}
      </svg>
      {hp && (
        <div
          className="chart-tip"
          style={{ left: Math.min(x(hp.n) + 12, width - 170), top: Math.max(0, y(hp.count) - 52) }}
        >
          <div>
            {varName} = <b>{hp.n}</b>
          </div>
          <div>
            <b>{hp.count.toLocaleString()}</b> lines executed
          </div>
        </div>
      )}
    </div>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

function compact(v: number) {
  if (v >= 1e6) return (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v % 1e3 ? 1 : 0) + 'k';
  return Math.round(v).toString();
}
