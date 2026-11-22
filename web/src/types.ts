// Shapes of the JSON the Java server sends back (see server/src/Tracer.java).

export type Value =
  | { k: 'p'; v: string } // primitive (int, double, boolean, char...)
  | { k: 's'; v: string; id?: number; pool?: boolean } // String (id = the String object; pool = from the string pool)
  | { k: 'null' }
  | { k: 'r'; id: number }; // reference to an object in `heap`

export interface Local {
  name: string;
  type: string;
  final?: boolean;
  v: Value;
}

export interface StaticClass {
  cls: string;
  fields: { name: string; type: string; final?: boolean; v: Value }[];
}

export interface Frame {
  id: number; // stable per call, so a frame keeps its identity across steps
  method: string;
  cls: string;
  line: number;
  file?: string; // source file, when it isn't the main file (multi-file projects in VS Code)
  locals: Local[];
  ret?: Value | null; // present on "return" steps for the top frame
}

export type HeapObj =
  | { kind: 'array'; type: string; len: number; items: Value[] }
  // java.util lists/stacks/queues/sets; `role` says how to draw it
  | { kind: 'list'; role?: 'list' | 'stack' | 'queue' | 'set'; type: string; len: number; items: Value[] }
  | { kind: 'map'; type: string; len: number; entries: { k: Value; v: Value }[] }
  | { kind: 'object'; type: string; fields: { name: string; type?: string; final?: boolean; v: Value }[] }
  | { kind: 'opaque'; type: string };

export interface Step {
  kind: 'line' | 'return' | 'exception';
  line: number;
  file?: string; // the top frame's source file, when it isn't the main file
  out: number; // length of stdout at this step
  stack: Frame[]; // bottom (main) -> top
  heap: Record<string, HeapObj>;
  statics?: StaticClass[]; // static fields of the user's classes that have been initialized
  exception?: string; // "java.lang.ArithmeticException: / by zero" on an exception step
  caught?: boolean; // something catches it (else the program stops here)
  catchLine?: number; // where student code catches it: the catch (or finally) it jumps to...
  catchFile?: string; // ...in this file, when it isn't the main file
  catchFrame?: number; // ...in this call; every call above it ends early (unwinds)
  hiddenFrames?: number;
}

export interface Diagnostic {
  line: number;
  col: number;
  endCol: number;
  message: string;
  severity: 'error' | 'warning';
  file?: string; // set for errors in another file of the project
}

/** The rest of a multi-file program (sent by the VS Code extension): paths relative to the source root. */
export interface Project {
  mainPath: string;
  files: { path: string; code: string }[];
}

/** A user class's methods and their bytecode size: the "Code" segment of the memory layout. */
export interface CodeClass {
  cls: string;
  methods: { name: string; sig: string; bytes: number }[];
}

export type EndReason = 'finished' | 'timeout' | 'step_limit' | 'too_deep';

export type RunResult =
  | { ok: true; end: EndReason; maxSteps: number; stdout: string; steps: Step[]; code?: CodeClass[]; diagnostics: Diagnostic[]; ms: number }
  | { ok: false; error: 'compile'; diagnostics: Diagnostic[] }
  | { ok: false; error: 'server'; message: string };

export type CountResult =
  | { ok: true; end: EndReason; count: number; ms: number }
  | { ok: false; error: 'compile'; diagnostics: Diagnostic[] }
  | { ok: false; error: 'server'; message: string };
