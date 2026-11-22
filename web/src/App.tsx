import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from './Editor';
import MemoryView from './MemoryView';
import MemoryMap from './MemoryMap';
import AddressSpace from './AddressSpace';
import AlgoView from './AlgoView';
import { buildLayout } from './memoryLayout';
import CallTree from './CallTree';
import Growth from './Growth';
import Timeline from './Timeline';
import {
  AArrowDown, AArrowUp, ArrowDownUp, Binary, BookOpen, Bug, Check, ChevronDown, CircleAlert, CircleCheck, Hash, Keyboard, Layers, Lightbulb,
  LoaderCircle, Network, Moon, PanelLeftClose, PanelLeftOpen, Play, Presentation, RectangleVertical, Share2, Sparkles, Sun, Terminal, TrendingUp, TriangleAlert,
} from 'lucide-react';
import { exceptionName, firstSeen, handlerKind, indexVariableNames, lineCounts, stepChanges, unwoundFrames } from './analysis';
import { defaultSample, samples } from './samples';
import { decodeShare, encodeShare } from './share';
import { gridIndexVars } from './grid';
import type { CodeClass, Diagnostic, EndReason, Project, RunResult, Step } from './types';

const END_MESSAGES: Record<EndReason, string | null> = {
  finished: null,
  timeout: 'Stopped after 3 seconds. Is there an infinite loop?',
  step_limit: 'Stopped after the step limit. Showing the first steps only.',
  too_deep: 'Recursion went more than 150 calls deep. Is the base case missing?',
};

/**
 * VS Code mode (?host=vscode): the page runs inside the JavaLens VS Code extension's panel.
 * The program is edited in VS Code's own editor, so ours is hidden; the extension sends the code
 * in and we send the current line and compile errors back (see vscode/src/extension.ts).
 */
const params = new URLSearchParams(location.search);
const IN_VSCODE = params.get('host') === 'vscode';
const toHost = (msg: unknown) => {
  if (IN_VSCODE) window.parent.postMessage(msg, '*');
};

/** Request fields for the program's other files (the server's flat "file.N.path" / "file.N.code" format). */
export function projectFields(project: Project | null): Record<string, string> {
  if (!project) return {};
  const out: Record<string, string> = { mainPath: project.mainPath, fileCount: String(project.files.length) };
  project.files.forEach((f, i) => {
    out[`file.${i}.path`] = f.path;
    out[`file.${i}.code`] = f.code;
  });
  return out;
}
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Where an exception goes from here, in plain words (the banner under the tabs). */
function exceptionPath(step: Step, code: string): string {
  const name = exceptionName(step.exception);
  const ended = step.stack.filter((f) => unwoundFrames(step).has(f.id)).reverse().map((f) => f.method + '()');
  const endsEarly = ended.length ? ` ${ended.join(', ')} ${ended.length === 1 ? 'ends' : 'end'} early, without returning.` : '';
  if (!step.caught) return `Nothing catches this ${name}, so the program stops here.`;
  if (step.catchLine === undefined) return `Library code catches it.`;
  const where = `line ${step.catchLine}${step.catchFile ? ` of ${baseName(step.catchFile)}` : ''}`;
  const catcher = step.stack.find((f) => f.id === step.catchFrame)?.method;
  const inMethod = catcher ? ` in ${catcher}()` : '';
  if (!step.catchFile && handlerKind(code, step.catchLine) === 'finally')
    return `It jumps to the finally block at ${where}${inMethod}; after that block runs, the exception carries on.${endsEarly}`;
  return `Caught at ${where}${inMethod}.${endsEarly}`;
}

type Status = { kind: 'idle' | 'running' | 'ok' | 'compile' | 'error'; text: string };
type Tab = 'memory' | 'map' | 'space' | 'algo' | 'tree' | 'growth';
const TABS: Tab[] = ['memory', 'map', 'space', 'algo', 'tree', 'growth'];

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
    if (IN_VSCODE) return ''; // VS Code sends the file
    try {
      return localStorage.getItem('javalens.code') || defaultSample.code;
    } catch {
      return defaultSample.code;
    }
  });
  const [stdin, setStdin] = useState('');
  const [project, setProject] = useState<Project | null>(null); // other files of the program (VS Code)
  const [showStdin, setShowStdin] = useState(false);
  const [live, setLive] = useState(true);
  const [steps, setSteps] = useState<Step[]>([]);
  const [codeSeg, setCodeSeg] = useState<CodeClass[]>([]);
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
  const [showCode, setShowCode] = useState(!IN_VSCODE);
  const [presenting, setPresenting] = useState(false);
  // Light theme reads better on most projectors; first visit follows the computer's setting.
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    params.get('theme') === 'light' ? 'light' : params.get('theme') === 'dark' ? 'dark' : load('theme', window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
  );
  const [predict, setPredict] = useState(false);
  const [awaitingReveal, setAwaitingReveal] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [appVersion, setAppVersion] = useState<{ version: string; latest: string | null; url: string | null } | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null); // shown to copy by hand when the clipboard isn't available

  // Opened from a share link (#s=...), or one pasted into an open JavaLens tab: load its program,
  // input, tab and step, then tidy the address bar so a refresh keeps later edits.
  useEffect(() => {
    if (IN_VSCODE) return;
    const open = () =>
      decodeShare(location.hash).then((s) => {
        if (!s) return;
        setCode(s.code);
        setStdin(s.stdin ?? '');
        if (s.stdin) setShowStdin(true);
        if (s.tab && (TABS as string[]).includes(s.tab)) setTab(s.tab as Tab);
        setPlaying(false);
        setAwaitingReveal(false);
        setIndexRaw(s.step ?? 0); // the run that follows keeps this step (it only clamps it)
        history.replaceState(null, '', location.pathname + location.search);
      });
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);

  const share = async () => {
    const hash = await encodeShare({ code, stdin: stdin || undefined, tab, step: index || undefined });
    const url = location.origin + location.pathname + location.search + hash;
    // The clipboard can be refused, or wait forever on a permission prompt: give it a moment, then
    // show the link ready to copy by hand.
    const copied = await Promise.race([
      navigator.clipboard?.writeText(url).then(() => true, () => false) ?? Promise.resolve(false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
    ]);
    if (copied) {
      setShareNote('Link copied');
      setTimeout(() => setShareNote(null), 2500);
    } else {
      setShareUrl(url);
    }
  };

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

  const run = useCallback(async (source: string, input: string, proj: Project | null) => {
    if (!source.trim()) return; // nothing to run yet (VS Code mode before the file arrives)
    abortRef.current?.abort(); // cancel an older run that is still in flight
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus({ kind: 'running', text: 'running…' });
    try {
      const res = await fetch('/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: source, stdin: input, ...projectFields(proj) }),
        signal: ctrl.signal,
      });
      const data: RunResult = await res.json();
      if (data.ok) {
        setCodeSeg(data.code ?? []);
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
      setStatus({ kind: 'error', text: IN_VSCODE ? 'Cannot reach the JavaLens server. Close this panel and run JavaLens: Visualize again.' : 'Cannot reach the Java server. Is it running? (./gradlew run)' });
    }
  }, []);

  // Remember the code so a page refresh mid-lecture doesn't lose it.
  useEffect(() => {
    if (IN_VSCODE) return; // the file lives in VS Code
    try {
      localStorage.setItem('javalens.code', code);
    } catch {
      /* storage unavailable: fine */
    }
  }, [code]);

  // Live mode: re-run shortly after typing stops.
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => run(code, stdin, project), 500);
    return () => clearTimeout(t);
  }, [code, stdin, project, live, run]);

  const loadSample = (name: string) => {
    const s = samples.find((x) => x.name === name);
    if (!s) return;
    setCode(s.code);
    jumpTo(0);
    setPlaying(false);
    setProject(null);
    if (!live) run(s.code, stdin, null);
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

  // ---- VS Code mode: code and theme come in; the current line and compile errors go out.
  useEffect(() => {
    if (!IN_VSCODE) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const msg = e.data as { type?: string; code?: string; theme?: string; mainPath?: string; files?: Project['files'] };
      if (msg.type === 'code' && typeof msg.code === 'string') {
        setCode(msg.code);
        setProject(msg.mainPath ? { mainPath: msg.mainPath, files: msg.files ?? [] } : null);
      }
      if (msg.type === 'theme' && (msg.theme === 'dark' || msg.theme === 'light')) setTheme(msg.theme);
    };
    window.addEventListener('message', onMessage);
    toHost({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const currentLine = steps[index]?.line ?? null;
  const currentKind = steps[index]?.kind ?? null;
  const currentFile = steps[index]?.file ?? null;
  useEffect(
    () => toHost({ type: 'line', line: currentLine, kind: currentKind, file: currentFile }),
    [currentLine, currentKind, currentFile],
  );
  useEffect(() => toHost({ type: 'diagnostics', diagnostics }), [diagnostics]);

  const indexNames = useMemo(() => indexVariableNames(code), [code]);
  const gridVars = useMemo(() => gridIndexVars([code, ...(project?.files.map((f) => f.code) ?? [])].join('\n')), [code, project]);
  const layout = useMemo(() => buildLayout(steps, codeSeg), [steps, codeSeg]);
  const counts = useMemo(() => (showCounts ? lineCounts(steps, index) : null), [showCounts, steps, index]);
  const step = steps[index];
  const born = useMemo(() => firstSeen(steps), [steps]);
  const changes = useMemo(() => stepChanges(steps[index - 1], steps[index], (id) => born.get(id) === index), [steps, index, born]);
  const output = step ? stdout.slice(0, step.out) : '';
  const atEnd = index === steps.length - 1;

  const stdinPanel = (
    <div className="stdin">
      <div className="panel-title">
        <Keyboard size={13} /> Program input <span className="muted">(what the user would type)</span>
      </div>
      <textarea value={stdin} onChange={(e) => setStdin(e.target.value)} placeholder="e.g. 5" spellCheck={false} />
    </div>
  );

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

        {!IN_VSCODE && (
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
        )}

        <div className="group">
          <button className="btn primary" onClick={() => run(code, stdin, project)} title="Run the program now">
            <Play size={15} fill="currentColor" /> Run
          </button>
          <label className="switch" title="Re-run automatically as you type">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            <span className="switch-track" aria-hidden>
              <span className="switch-thumb" />
            </span>
            Live
          </label>
          {!IN_VSCODE && (
            <button
              onClick={share}
              className={shareNote ? 'on' : ''}
              title="Copy a link that reopens this program, its input, this tab and this step"
            >
              {shareNote ? <Check size={15} /> : <Share2 size={15} />} <span className="lbl">{shareNote ?? 'Share'}</span>
            </button>
          )}
          {shareUrl && (
            <input
              className="share-url"
              readOnly
              autoFocus
              value={shareUrl}
              aria-label="Share link: copy it with Ctrl+C"
              title="Copy this link (Ctrl+C / ⌘C). Click elsewhere to close."
              onFocus={(e) => e.target.select()}
              onBlur={() => setShareUrl(null)}
              onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
            />
          )}
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
          {!IN_VSCODE && (
            <button onClick={() => setShowCode(!showCode)} className={!showCode ? 'on' : ''} title={showCode ? 'Hide the code to give the diagram the whole screen' : 'Show the code'}>
              {showCode ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />} <span className="lbl">Code</span>
            </button>
          )}
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

        {!IN_VSCODE && appVersion?.latest && appVersion.url && (
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
            {showStdin && stdinPanel}
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
          {tab !== 'growth' && step && (
            <div className="changes" aria-live="polite" title="What the last step changed">
              <span className="changes-label">{index === 0 ? 'start' : 'changed'}</span>
              {index === 0 ? (
                <span className="muted">main() is about to run</span>
              ) : changes.length ? (
                changes.map((c, i) => (
                  <span className="change" key={i}>
                    {c}
                  </span>
                ))
              ) : (
                <span className="muted">nothing (a condition or jump)</span>
              )}
            </div>
          )}
          <nav className="tabs" role="tablist">
            {(
              [
                ['memory', 'Memory', Layers],
                ['map', 'Memory map', Binary],
                ['space', 'Memory layout', RectangleVertical],
                ['algo', 'Sort & Search', ArrowDownUp],
                ['tree', 'Call tree', Network],
                ['growth', 'Growth', TrendingUp],
              ] as [Tab, string, typeof Layers][]
            ).map(([t, label, Icon]) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
                <Icon size={15} /> {label}
                {t === 'space' && <span className="tab-beta">beta</span>}
              </button>
            ))}
            {!showCode && step && (
              <span className="tab-line">
                {step.file && <b>{baseName(step.file)} · </b>}line {step.line}
              </span>
            )}
          </nav>
          {tab !== 'growth' && step?.exception && (
            <div className={'banner ' + (step.caught ? 'catch' : 'error')}>
              <Bug size={16} />
              <span>
                <b>{step.exception}</b>
                <br />
                {exceptionPath(step, code)}
              </span>
            </div>
          )}
          {tab !== 'growth' && atEnd && END_MESSAGES[end] && (
            <div className="banner warn">
              <TriangleAlert size={16} /> {END_MESSAGES[end]}
            </div>
          )}

          <div className="view-scroll">
            {tab === 'memory' && <MemoryView step={step} prev={steps[index - 1]} indexNames={indexNames} steps={steps} index={index} gridVars={gridVars} />}
            {tab === 'map' && <MemoryMap step={step} prev={steps[index - 1]} layout={layout} />}
            {tab === 'algo' && <AlgoView steps={steps} index={index} code={code} project={project} stdin={stdin} samples={samples} />}
            {tab === 'space' && <AddressSpace steps={steps} step={step} prev={steps[index - 1]} index={index} layout={layout} />}
            {tab === 'tree' && <CallTree steps={steps} index={index} onPick={jumpTo} fontSize={fontSize} />}
            {tab === 'growth' && <Growth code={code} stdin={stdin} extra={projectFields(project)} />}
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
          {!showCode && showStdin && stdinPanel}
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
