import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from './Editor';
import MemoryView from './MemoryView';
import CallTree from './CallTree';
import Growth from './Growth';
import Timeline from './Timeline';
import {
  AArrowDown, AArrowUp, BookOpen, Bug, ChevronDown, CircleAlert, CircleCheck, Hash, Keyboard, Layers, Lightbulb,
  LoaderCircle, Network, Moon, PanelLeftClose, PanelLeftOpen, Play, Presentation, Sparkles, Sun, Terminal, TrendingUp, TriangleAlert,
} from 'lucide-react';
import { indexVariableNames, lineCounts } from './analysis';
import { defaultSample, samples } from './samples';
import type { Diagnostic, EndReason, RunResult, Step } from './types';

const END_MESSAGES: Record<EndReason, string | null> = {
  finished: null,
  timeout: 'Stopped after 3 seconds. Is there an infinite loop?',
  step_limit: 'Stopped after the step limit. Showing the first steps only.',
  too_deep: 'Recursion went more than 150 calls deep. Is the base case missing?',
};

type Status = { kind: 'idle' | 'running' | 'ok' | 'compile' | 'error'; text: string };
type Tab = 'memory' | 'tree' | 'growth';

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem('javalens.' + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem('javalens.' + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: fine */
  }
}

export default function App() {
  const [code, setCode] = useState(() => {
    try {
      return localStorage.getItem('javalens.code') || defaultSample.code;
    } catch {
      return defaultSample.code;
    }
  });
  const [stdin, setStdin] = useState('');
  const [showStdin, setShowStdin] = useState(false);
  const [live, setLive] = useState(true);
  const [steps, setSteps] = useState<Step[]>([]);
  const [stdout, setStdout] = useState('');
  const [end, setEnd] = useState<EndReason>('finished');
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' });
  const [index, setIndexRaw] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [fontSize, setFontSize] = useState(() => load('fontSize', 16));
  const [tab, setTab] = useState<Tab>(() => load('tab', 'memory'));
  const [showCounts, setShowCounts] = useState(() => load('counts', false));
  const [showCode, setShowCode] = useState(true);
  const [presenting, setPresenting] = useState(false);
  // Light theme reads better on most projectors; first visit follows the computer's setting.
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    load('theme', window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
  );
  const [predict, setPredict] = useState(false);
  const [awaitingReveal, setAwaitingReveal] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [appVersion, setAppVersion] = useState<{ version: string; latest: string | null; url: string | null } | null>(null);

  // Version + "update available" (the server asks GitHub Releases; see AppInfo.java).
  useEffect(() => {
    fetch('/version')
      .then((r) => (r.ok ? r.json() : null))
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  useEffect(() => save('fontSize', fontSize), [fontSize]);
  useEffect(() => save('tab', tab), [tab]);
  useEffect(() => save('counts', showCounts), [showCounts]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    save('theme', theme);
  }, [theme]);

  /**
   * Predict mode: stepping forward first pauses with "what happens next?";
   * the next forward press reveals the step.
   */
  const setIndex = useCallback(
    (i: number) => {
      if (predict && i === index + 1 && !awaitingReveal) {
        setAwaitingReveal(true);
        return;
      }
      setAwaitingReveal(false);
      setIndexRaw(i);
    },
    [predict, index, awaitingReveal],
  );
  const jumpTo = useCallback((i: number) => {
    setAwaitingReveal(false);
    setIndexRaw(i);
  }, []);

  const run = useCallback(async (source: string, input: string) => {
    abortRef.current?.abort(); // cancel an older run that is still in flight
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus({ kind: 'running', text: 'running…' });
    try {
      const res = await fetch('/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: source, stdin: input }),
        signal: ctrl.signal,
      });
      const data: RunResult = await res.json();
      if (data.ok) {
        setSteps(data.steps);
        setStdout(data.stdout);
        setEnd(data.end);
        setDiagnostics(data.diagnostics);
        // Keep the current position when re-running after an edit, so the view doesn't jump around.
        setIndexRaw((i) => Math.min(i, Math.max(0, data.steps.length - 1)));
        setStatus({ kind: 'ok', text: `${data.steps.length} steps · ${data.ms} ms` });
      } else if (data.error === 'compile') {
        // Keep showing the last good trace; just mark the errors in the editor.
        setDiagnostics(data.diagnostics);
        const n = data.diagnostics.filter((d) => d.severity === 'error').length;
        setStatus({ kind: 'compile', text: `${n} compile error${n === 1 ? '' : 's'}` });
      } else {
        setStatus({ kind: 'error', text: data.message });
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setStatus({ kind: 'error', text: 'Cannot reach the Java server. Is it running? (./gradlew run)' });
    }
  }, []);

  // Remember the code so a page refresh mid-lecture doesn't lose it.
  useEffect(() => {
    try {
      localStorage.setItem('javalens.code', code);
    } catch {
      /* storage unavailable: fine */
    }
  }, [code]);

  // Live mode: re-run shortly after typing stops.
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => run(code, stdin), 500);
    return () => clearTimeout(t);
  }, [code, stdin, live, run]);

  const loadSample = (name: string) => {
    const s = samples.find((x) => x.name === name);
    if (!s) return;
    setCode(s.code);
    jumpTo(0);
    setPlaying(false);
    if (!live) run(s.code, stdin);
  };

  // Click a line number: jump to the next time that line runs (wrapping around to the start).
  const jumpToLine = (line: number) => {
    const find = (from: number, to: number) => {
      for (let i = from; i < to; i++) if (steps[i].line === line && steps[i].kind === 'line') return i;
      return -1;
    };
    let i = find(index + 1, steps.length);
    if (i < 0) i = find(0, index + 1);
    if (i >= 0) {
      setPlaying(false);
      jumpTo(i);
    }
  };

  const togglePresent = () => {
    setPresenting((p) => !p);
    setFontSize((f) => (presenting ? Math.max(12, f - 6) : Math.min(32, f + 6)));
  };

  const indexNames = useMemo(() => indexVariableNames(code), [code]);
  const counts = useMemo(() => (showCounts ? lineCounts(steps, index) : null), [showCounts, steps, index]);
  const step = steps[index];
  const output = step ? stdout.slice(0, step.out) : '';
  const atEnd = index === steps.length - 1;

  const StatusIcon = status.kind === 'running' ? LoaderCircle : status.kind === 'ok' ? CircleCheck : status.kind === 'idle' ? null : CircleAlert;

  return (
    <div className={'app' + (presenting ? ' presenting' : '')} style={{ ['--fs' as string]: `${fontSize}px` }}>
      <header>
        <div className="brand" title={appVersion ? `JavaLens ${appVersion.version}` : 'JavaLens'}>
          <span className="logo-mark" aria-hidden>
            <Layers size={16} strokeWidth={2.4} />
          </span>
          Java<span>Lens</span>
        </div>

        <label className="select-wrap" title="Load an example program">
          <BookOpen size={15} />
          <select onChange={(e) => loadSample(e.target.value)} value="">
            <option value="" disabled>
              Examples
            </option>
            {samples.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
          <ChevronDown size={14} className="select-caret" />
        </label>

        <div className="group">
          <button className="btn primary" onClick={() => run(code, stdin)} title="Run the program now">
            <Play size={15} fill="currentColor" /> Run
          </button>
          <label className="switch" title="Re-run automatically as you type">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            <span className="switch-track" aria-hidden>
              <span className="switch-thumb" />
            </span>
            Live
          </label>
        </div>

        <div className="spacer" />

        <div className="segmented" role="group" aria-label="Teaching tools">
          <button onClick={() => setShowStdin(!showStdin)} className={showStdin ? 'on' : ''} title="Input for Scanner">
            <Keyboard size={15} /> <span className="lbl">Input</span>
          </button>
          <button onClick={() => setShowCounts(!showCounts)} className={showCounts ? 'on' : ''} title="Show how many times each line has run">
            <Hash size={15} /> <span className="lbl">Counts</span>
          </button>
          <button
            onClick={() => {
              setPredict(!predict);
              setAwaitingReveal(false);
            }}
            className={predict ? 'on' : ''}
            title="Predict mode: pause before each step so the class can guess what happens"
          >
            <Lightbulb size={15} /> <span className="lbl">Predict</span>
          </button>
        </div>

        <div className="segmented" role="group" aria-label="Layout">
          <button onClick={() => setShowCode(!showCode)} className={!showCode ? 'on' : ''} title={showCode ? 'Hide the code to give the diagram the whole screen' : 'Show the code'}>
            {showCode ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />} <span className="lbl">Code</span>
          </button>
          <button onClick={togglePresent} className={presenting ? 'on' : ''} title="Bigger text for the projector">
            <Presentation size={15} /> <span className="lbl">Present</span>
          </button>
          <button onClick={() => setFontSize((f) => Math.max(12, f - 2))} title="Smaller text">
            <AArrowDown size={16} />
          </button>
          <button onClick={() => setFontSize((f) => Math.min(32, f + 2))} title="Bigger text">
            <AArrowUp size={16} />
          </button>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light theme (better on projectors)' : 'Switch to dark theme'}
            aria-label="Toggle light / dark theme"
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>

        {appVersion?.latest && appVersion.url && (
          <a className="update-chip" href={appVersion.url} target="_blank" rel="noreferrer" title="Download the new version">
            <Sparkles size={14} /> Update {appVersion.latest}
          </a>
        )}

        {status.kind !== 'idle' && (
          <div className={`status ${status.kind}`} title={status.text}>
            {StatusIcon && <StatusIcon size={14} className={status.kind === 'running' ? 'spin' : undefined} />}
            <span>{status.text}</span>
          </div>
        )}
      </header>

      <main className={showCode ? '' : 'no-code'}>
        {showCode && (
          <section className="left card">
            <div className="editor-wrap">
              <Editor
                code={code}
                onChange={setCode}
                step={step}
                diagnostics={diagnostics}
                fontSize={fontSize}
                counts={counts}
                onLineClick={jumpToLine}
                theme={theme}
              />
            </div>
            {showStdin && (
              <div className="stdin">
                <div className="panel-title">
                  <Keyboard size={13} /> Program input <span className="muted">(what the user would type)</span>
                </div>
                <textarea value={stdin} onChange={(e) => setStdin(e.target.value)} placeholder="e.g. 5" spellCheck={false} />
              </div>
            )}
          </section>
        )}

        <section className="right card">
          <Timeline
            steps={steps}
            index={index}
            setIndex={setIndex}
            playing={playing}
            setPlaying={setPlaying}
            speed={speed}
            setSpeed={setSpeed}
          />
          <nav className="tabs" role="tablist">
            {(
              [
                ['memory', 'Memory', Layers],
                ['tree', 'Call tree', Network],
                ['growth', 'Growth', TrendingUp],
              ] as [Tab, string, typeof Layers][]
            ).map(([t, label, Icon]) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
                <Icon size={15} /> {label}
              </button>
            ))}
            {!showCode && step && <span className="tab-line">line {step.line}</span>}
          </nav>
          {tab !== 'growth' && step?.exception && (
            <div className="banner error">
              <Bug size={16} /> {step.exception}
            </div>
          )}
          {tab !== 'growth' && atEnd && END_MESSAGES[end] && (
            <div className="banner warn">
              <TriangleAlert size={16} /> {END_MESSAGES[end]}
            </div>
          )}

          <div className="view-scroll">
            {tab === 'memory' && <MemoryView step={step} prev={steps[index - 1]} indexNames={indexNames} />}
            {tab === 'tree' && <CallTree steps={steps} index={index} onPick={jumpTo} fontSize={fontSize} />}
            {tab === 'growth' && <Growth code={code} stdin={stdin} />}
            {awaitingReveal && tab !== 'growth' && (
              <div className="predict-overlay">
                <div className="predict-card">
                  <div className="predict-title">
                    <Lightbulb size={20} /> Predict
                  </div>
                  <div>
                    Line <b>{step?.line}</b> is about to run. What will change?
                  </div>
                  {step && <code className="predict-code">{code.split('\n')[step.line - 1]?.trim()}</code>}
                  <div className="muted">
                    Press <kbd>→</kbd> to reveal
                  </div>
                </div>
              </div>
            )}
          </div>
          {tab !== 'growth' && (
            <div className="output">
              <div className="panel-title">
                <Terminal size={13} /> Output
              </div>
              <pre>{output || <span className="muted">nothing printed yet</span>}</pre>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
