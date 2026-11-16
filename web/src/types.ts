// Shapes of the JSON the Java server sends back (see server/src/Tracer.java).

export type Value =
  | { k: 'p'; v: string } // primitive (int, double, boolean, char...)
  | { k: 's'; v: string } // String
  | { k: 'null' }
  | { k: 'r'; id: number }; // reference to an object in `heap`

export interface Local {
  name: string;
  type: string;
  v: Value;
}

export interface Frame {
  id: number; // stable per call, so a frame keeps its identity across steps
  method: string;
  cls: string;
  line: number;
  locals: Local[];
  ret?: Value | null; // present on "return" steps for the top frame
}

export type HeapObj =
  | { kind: 'array'; type: string; len: number; items: Value[] }
  // java.util lists/stacks/queues/sets; `role` says how to draw it
  | { kind: 'list'; role?: 'list' | 'stack' | 'queue' | 'set'; type: string; len: number; items: Value[] }
  | { kind: 'map'; type: string; len: number; entries: { k: Value; v: Value }[] }
  | { kind: 'object'; type: string; fields: { name: string; type?: string; v: Value }[] }
  | { kind: 'opaque'; type: string };

export interface Step {
  kind: 'line' | 'return' | 'exception';
  line: number;
  out: number; // length of stdout at this step
  stack: Frame[]; // bottom (main) -> top
  heap: Record<string, HeapObj>;
  exception?: string;
  hiddenFrames?: number;
}

export interface Diagnostic {
  line: number;
  col: number;
  endCol: number;
  message: string;
  severity: 'error' | 'warning';
}

export type EndReason = 'finished' | 'timeout' | 'step_limit' | 'too_deep';

export type RunResult =
  | { ok: true; end: EndReason; maxSteps: number; stdout: string; steps: Step[]; diagnostics: Diagnostic[]; ms: number }
  | { ok: false; error: 'compile'; diagnostics: Diagnostic[] }
  | { ok: false; error: 'server'; message: string };

export type CountResult =
  | { ok: true; end: EndReason; count: number; ms: number }
  | { ok: false; error: 'compile'; diagnostics: Diagnostic[] }
  | { ok: false; error: 'server'; message: string };
