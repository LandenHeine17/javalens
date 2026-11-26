import { useRef } from 'react';

/**
 * A draggable divider between two panels. Drag it, or focus it (Tab) and use the arrow keys;
 * double-click puts it back. The parent owns the value (a fraction, pixels...) and turns a
 * drag distance into a new value with `fromDrag`.
 */
interface Props {
  /** 'columns': panels side by side, drag left/right. 'rows': one above the other, drag up/down. */
  direction: 'columns' | 'rows';
  value: number;
  onChange: (value: number) => void;
  /** The value after dragging `deltaPx` pixels (right/down is positive) from `start`. */
  fromDrag: (start: number, deltaPx: number) => number;
  reset: number;
  label: string;
  className?: string;
}

const KEY_STEP_PX = 24;

export default function Splitter({ direction, value, onChange, fromDrag, reset, label, className }: Props) {
  const drag = useRef<{ start: number; pos: number } | null>(null);
  const along = (e: { clientX: number; clientY: number }) => (direction === 'columns' ? e.clientX : e.clientY);
  const [back, forward] = direction === 'columns' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];

  return (
    <div
      role="separator"
      aria-orientation={direction === 'columns' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value * 100) / 100}
      title={`${label}: drag to resize, double-click to reset`}
      tabIndex={0}
      className={`splitter ${direction}${className ? ' ' + className : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: value, pos: along(e) };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onChange(fromDrag(d.start, along(e) - d.pos));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onChange(reset)}
      onKeyDown={(e) => {
        if (e.key !== back && e.key !== forward) return;
        e.preventDefault();
        e.stopPropagation(); // the arrow keys step the program everywhere else
        onChange(fromDrag(value, (e.key === forward ? 1 : -1) * KEY_STEP_PX));
      }}
    />
  );
}
