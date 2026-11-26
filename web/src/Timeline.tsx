import { useEffect, type ReactNode } from 'react';
import type { Step } from './types';
import {
  ChevronFirst, ChevronLast, CornerLeftUp, Gauge, Pause, Play, Redo2, StepBack, StepForward, Undo2,
} from 'lucide-react';

interface Props {
  steps: Step[];
  index: number;
  setIndex: (i: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  speed: number; // steps per second
  setSpeed: (s: number) => void;
  /** One slim row: no depth chart or slider (the "collapse the top" mode). */
  compact?: boolean;
  /** Extra controls at the end of the buttons row (compact mode puts the tab picker there). */
  extra?: ReactNode;
}

/** Index of the next step whose stack depth is <= depth (used by "step over" / "step out"). */
function findForward(steps: Step[], from: number, maxDepth: number) {
  for (let i = from + 1; i < steps.length; i++) if (steps[i].stack.length <= maxDepth) return i;
  return steps.length - 1;
}
function findBackward(steps: Step[], from: number, maxDepth: number) {
  for (let i = from - 1; i >= 0; i--) if (steps[i].stack.length <= maxDepth) return i;
  return 0;
}

export default function Timeline({ steps, index, setIndex, playing, setPlaying, speed, setSpeed, compact, extra }: Props) {
  const last = steps.length - 1;
  const depth = steps[index]?.stack.length ?? 1;
  const go = (i: number) => setIndex(Math.max(0, Math.min(last, i)));

  // Auto-play.
  useEffect(() => {
    if (!playing) return;
    if (index >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIndex(index + 1), 1000 / speed);
    return () => clearTimeout(t);
  }, [playing, index, last, speed, setIndex, setPlaying]);

  // Keyboard: ← → step, Shift+← → step over, Home/End, Space play (only when not typing in the editor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target;
      if (el instanceof HTMLElement && (el.closest('.monaco-editor') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)))
        return;
      if (e.key === 'ArrowRight') go(e.shiftKey ? findForward(steps, index, depth) : index + 1);
      else if (e.key === 'ArrowLeft') go(e.shiftKey ? findBackward(steps, index, depth) : index - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(last);
      else if (e.key === ' ') setPlaying(!playing);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const cls = 'timeline' + (compact ? ' compact' : '');
  if (steps.length === 0) return <div className={cls}>{extra && <div className="buttons">{extra}</div>}</div>;

  return (
    <div className={cls}>
      <div className="buttons">
        <div className="segmented transport">
          <button onClick={() => go(0)} title="First step (Home)">
            <ChevronFirst size={17} />
          </button>
          <button onClick={() => go(findBackward(steps, index, depth))} title="Step back over calls (Shift+←)">
            <Undo2 size={16} />
          </button>
          <button onClick={() => go(index - 1)} title="Back one step (←)">
            <StepBack size={16} />
          </button>
        </div>
        <button className="play" onClick={() => setPlaying(!playing)} title="Play / pause (Space)">
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <div className="segmented transport">
          <button onClick={() => go(index + 1)} title="Forward one step (→)">
            <StepForward size={16} />
          </button>
          <button onClick={() => go(findForward(steps, index, depth))} title="Step over calls (Shift+→)">
            <Redo2 size={16} />
          </button>
          <button onClick={() => go(findForward(steps, index, depth - 1))} title="Step out: run until this call returns">
            <CornerLeftUp size={16} />
          </button>
          <button onClick={() => go(last)} title="Last step (End)">
            <ChevronLast size={17} />
          </button>
        </div>
        <label className="speed" title="Playback speed">
          <Gauge size={15} />
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {[1, 2, 4, 8, 16].map((s) => (
              <option key={s} value={s}>{s}×</option>
            ))}
          </select>
        </label>
        <span className="step-count">
          Step <b>{index + 1}</b> <span className="muted">of {steps.length}</span>
        </span>
        {extra}
      </div>
      {!compact && (
      <div className="scrubber">
        {/* A mini chart of stack depth over time: recursion shows up as mountains. */}
        <DepthStrip steps={steps} index={index} onPick={go} />
        <input
          className="slider"
          type="range"
          min={0}
          max={last}
          value={index}
          style={{ ['--pct' as string]: `${last ? (index / last) * 100 : 0}%` }}
          onChange={(e) => {
            setPlaying(false);
            go(Number(e.target.value));
          }}
          aria-label="Step"
        />
      </div>
      )}
    </div>
  );
}

function DepthStrip({ steps, index, onPick }: { steps: Step[]; index: number; onPick: (i: number) => void }) {
  const max = Math.max(...steps.map((s) => s.stack.length));
  const w = 1000;
  const h = 36;
  const pts = steps
    .map((s, i) => {
      const x = steps.length === 1 ? 0 : (i / (steps.length - 1)) * w;
      const y = h - (s.stack.length / max) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const cx = steps.length === 1 ? 0 : (index / (steps.length - 1)) * w;
  return (
    <svg
      className="depth-strip"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onPick(Math.round(((e.clientX - r.left) / r.width) * (steps.length - 1)));
      }}
    >
      <title>Stack depth over time (click to jump)</title>
      <defs>
        <linearGradient id="depthFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="depth-stop-top" />
          <stop offset="100%" className="depth-stop-bottom" />
        </linearGradient>
      </defs>
      <polyline points={`0,${h} ${pts} ${w},${h}`} className="depth-area" fill="url(#depthFill)" />
      <line x1={cx} x2={cx} y1={0} y2={h} className="depth-cursor" />
    </svg>
  );
}
