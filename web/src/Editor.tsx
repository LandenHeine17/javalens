import { useEffect, useRef } from 'react';
import MonacoEditor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import type { Diagnostic, Step } from './types';
import { registerJavaAssist } from './javaAssist';
import { handlerKind } from './analysis';

// Use the locally installed Monaco (works offline in a lecture hall) instead of a CDN copy.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });

// Editor colors matched to the app's theme (styles.css).
monaco.editor.defineTheme('javalens', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'c4a7ff' },
    { token: 'string', foreground: '9fdcaa' },
    { token: 'number', foreground: 'ffcf70' },
    { token: 'comment', foreground: '5f6779', fontStyle: 'italic' },
    { token: 'type', foreground: '7dd3fc' },
    { token: 'annotation', foreground: 'f5b84a' },
  ],
  colors: {
    'editor.background': '#12151c',
    'editorGutter.background': '#12151c',
    'editor.lineHighlightBackground': '#ffffff06',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#454b5a',
    'editorLineNumber.activeForeground': '#aab1c2',
    'editorIndentGuide.background1': '#ffffff0d',
    'editorIndentGuide.activeBackground1': '#ffffff22',
    'editor.selectionBackground': '#7c9cff40',
    'editorCursor.foreground': '#9db4ff',
    'editorWidget.background': '#1a1e27',
    'editorWidget.border': '#2a3040',
    'editorSuggestWidget.background': '#1a1e27',
    'editorSuggestWidget.border': '#2a3040',
    'editorSuggestWidget.selectedBackground': '#2a3352',
    'editorSuggestWidget.highlightForeground': '#9db4ff',
    'editorHoverWidget.background': '#1a1e27',
    'editorHoverWidget.border': '#2a3040',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff22',
  },
});

// Light version (colors match the light tokens in styles.css).
monaco.editor.defineTheme('javalens-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7048e8' },
    { token: 'string', foreground: '2b8a3e' },
    { token: 'number', foreground: 'b35c00' },
    { token: 'comment', foreground: '8b93a5', fontStyle: 'italic' },
    { token: 'type', foreground: '0b7285' },
    { token: 'annotation', foreground: 'b26a00' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'editor.lineHighlightBackground': '#0f172a06',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#b4bac6',
    'editorLineNumber.activeForeground': '#3d4454',
    'editorIndentGuide.background1': '#0f172a12',
    'editorIndentGuide.activeBackground1': '#0f172a30',
    'editor.selectionBackground': '#4c6ef533',
    'editorCursor.foreground': '#3b5bdb',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#dfe3ec',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.border': '#dfe3ec',
    'editorSuggestWidget.selectedBackground': '#e7ecff',
    'editorSuggestWidget.highlightForeground': '#3b5bdb',
    'editorHoverWidget.background': '#ffffff',
    'editorHoverWidget.border': '#dfe3ec',
  },
});

interface Props {
  code: string;
  onChange: (code: string) => void;
  step: Step | undefined;
  diagnostics: Diagnostic[];
  fontSize: number;
  counts: Map<number, number> | null; // how many times each line ran so far (null = hidden)
  onLineClick: (line: number) => void; // click a line number -> jump to when that line runs next
  theme: 'dark' | 'light';
}

export default function Editor({ code, onChange, step, diagnostics, fontSize, counts, onLineClick, theme }: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const countDecorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const lineClick = useRef(onLineClick);
  lineClick.current = onLineClick;

  const onMount: OnMount = (editor) => {
    editorRef.current = editor as unknown as monaco.editor.IStandaloneCodeEditor;
    decorations.current = editorRef.current.createDecorationsCollection();
    countDecorations.current = editorRef.current.createDecorationsCollection();
    registerJavaAssist();
    editorRef.current.onMouseDown((e) => {
      const T = monaco.editor.MouseTargetType;
      if ((e.target.type === T.GUTTER_LINE_NUMBERS || e.target.type === T.GUTTER_GLYPH_MARGIN) && e.target.position) {
        lineClick.current(e.target.position.lineNumber);
      }
    });
  };

  // Execution counts: "×12" after each line plus a heat tint, so loops and hot spots stand out.
  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model || !countDecorations.current) return;
    if (!counts || counts.size === 0) {
      countDecorations.current.clear();
      return;
    }
    const max = Math.max(...counts.values());
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    for (const [line, n] of counts) {
      if (line < 1 || line > model.getLineCount()) continue;
      const end = model.getLineMaxColumn(line);
      const heat = max <= 1 ? 1 : Math.min(4, 1 + Math.floor((Math.log(n) / Math.log(max)) * 3.999));
      decos.push({
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: `heat-${heat}` },
      });
      decos.push({
        range: new monaco.Range(line, 1, line, end),
        options: { showIfCollapsed: true, after: { content: `  ×${n}`, inlineClassName: 'line-count' } },
      });
    }
    countDecorations.current.set(decos);
  }, [counts, code]);

  // Highlight the line being executed, plus the call sites of the frames below it.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !decorations.current) return;
    if (!step) {
      decorations.current.clear();
      return;
    }
    const cls = step.kind === 'exception' ? 'line-exception' : step.kind === 'return' ? 'line-return' : 'line-current';
    const decos: monaco.editor.IModelDeltaDecoration[] = step.stack.slice(0, -1).map((f) => ({
      range: new monaco.Range(f.line, 1, f.line, 1),
      options: { isWholeLine: true, className: 'line-caller' },
    }));
    decos.push({
      range: new monaco.Range(step.line, 1, step.line, 1),
      options: { isWholeLine: true, className: cls, glyphMarginClassName: 'glyph-current' },
    });
    // An exception: mark where it will land (in this file), a catch block or a finally block.
    const model = ed.getModel();
    if (step.kind === 'exception' && step.catchLine && !step.catchFile && model && step.catchLine <= model.getLineCount()) {
      const kind = handlerKind(model.getValue(), step.catchLine);
      decos.push({
        range: new monaco.Range(step.catchLine, 1, step.catchLine, model.getLineMaxColumn(step.catchLine)),
        options: {
          isWholeLine: true,
          className: 'line-catch',
          showIfCollapsed: true,
          after: { content: kind === 'finally' ? '   ⤶ the finally block runs next' : '   ⤶ caught here', inlineClassName: 'line-catch-note' },
        },
      });
    }
    decorations.current.set(decos);
    ed.revealLineInCenterIfOutsideViewport(step.line);
  }, [step]);

  // Compile errors -> red squiggles.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'javac',
      diagnostics.filter((d) => !d.file).map((d) => ({
        startLineNumber: d.line,
        endLineNumber: d.line,
        startColumn: d.col,
        endColumn: d.endCol,
        message: d.message,
        severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      })),
    );
  }, [diagnostics]);

  return (
    <MonacoEditor
      language="java"
      theme={theme === 'light' ? 'javalens-light' : 'javalens'}
      value={code}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      options={{
        fontSize,
        minimap: { enabled: false },
        glyphMargin: true,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', Menlo, Consolas, monospace",
        lineHeight: 1.6,
        renderLineHighlight: 'all',
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on',
        roundedSelection: true,
        fontLigatures: false, // students should see <= and != exactly as they type them
        wordBasedSuggestions: 'off', // suggestions come from the Java compiler instead
        suggest: { showWords: false },
        quickSuggestions: { other: true, comments: false, strings: false },
        padding: { top: 14, bottom: 14 },
      }}
    />
  );
}
