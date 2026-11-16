import * as monaco from 'monaco-editor';

/**
 * Java editor help for Monaco: autocomplete, hover and parameter hints.
 * The answers come from the Java server (server/src/Assist.java), which asks the real Java compiler.
 */

interface ServerItem {
  label: string;
  kind: string;
  detail: string;
  insert: string;
  sort: string;
  import?: string; // e.g. "java.util.Scanner" -> also add the import line
}

const K = monaco.languages.CompletionItemKind;
const KINDS: Record<string, monaco.languages.CompletionItemKind> = {
  method: K.Method,
  constructor: K.Constructor,
  field: K.Field,
  constant: K.Constant,
  variable: K.Variable,
  class: K.Class,
  interface: K.Interface,
  enum: K.Enum,
  'enum-member': K.EnumMember,
  record: K.Struct,
  keyword: K.Keyword,
};

const SNIPPET = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

const SNIPPETS: [string, string, string][] = [
  ['sout', 'System.out.println(${1});', 'Print a line'],
  ['psvm', 'public static void main(String[] args) {\n\t$0\n}', 'main method'],
  ['fori', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}', 'Counting for loop'],
  ['foreach', 'for (${1:int} ${2:x} : ${3:arr}) {\n\t$0\n}', 'For-each loop'],
  ['while', 'while (${1:condition}) {\n\t$0\n}', 'While loop'],
  ['ifelse', 'if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}', 'If / else'],
  ['scanner', 'Scanner ${1:in} = new Scanner(System.in);', 'Read input (needs java.util.Scanner)'],
];

const KEYWORDS = [
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'new',
  'int', 'double', 'boolean', 'char', 'long', 'float', 'byte', 'short', 'void', 'var',
  'true', 'false', 'null', 'this', 'super', 'class', 'interface', 'enum', 'record', 'extends', 'implements',
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'try', 'catch', 'finally', 'throw', 'throws',
  'instanceof', 'import',
];

async function post<T>(path: string, body: object, token: monaco.CancellationToken): Promise<T | null> {
  const ctrl = new AbortController();
  const sub = token.onCancellationRequested(() => ctrl.abort());
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // cancelled, or the server isn't running: just offer nothing
  } finally {
    sub.dispose();
  }
}

/** Where to add `import x;`: after the last existing import, else at the very top. */
function importEdit(model: monaco.editor.ITextModel, qualified: string): monaco.languages.TextEdit {
  let line = 0;
  for (let i = 1; i <= model.getLineCount(); i++) if (/^\s*import\s/.test(model.getLineContent(i))) line = i;
  const text = `import ${qualified};\n` + (line === 0 ? '\n' : '');
  const at = line === 0 ? 1 : line + 1;
  return { range: new monaco.Range(at, 1, at, 1), text };
}

let registered = false;

export function registerJavaAssist() {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('java', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position, _ctx, token) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      const afterDot = /\.\s*$/.test(before);

      const data = await post<{ items: ServerItem[] }>(
        '/complete',
        { code: model.getValue(), line: position.lineNumber, col: position.column },
        token,
      );
      const suggestions: monaco.languages.CompletionItem[] = (data?.items ?? []).map((it) => {
        const isCall = it.kind === 'method' || it.kind === 'constructor';
        return {
          label: it.label, // full signature shows as `detail` beside the highlighted item
          kind: KINDS[it.kind] ?? K.Text,
          detail: it.detail,
          insertText: it.insert,
          insertTextRules: isCall ? SNIPPET : undefined,
          // After inserting `name(`, pop up the parameter hints right away.
          command: isCall ? { id: 'editor.action.triggerParameterHints', title: 'parameter hints' } : undefined,
          sortText: it.sort + it.label,
          additionalTextEdits: it.import ? [importEdit(model, it.import)] : undefined,
          range,
        };
      });

      // Keywords and snippets only make sense at the start of an expression, not after `something.`
      if (!afterDot) {
        for (const kw of KEYWORDS) suggestions.push({ label: kw, kind: K.Keyword, insertText: kw, sortText: '8' + kw, range });
        for (const [label, body, detail] of SNIPPETS) {
          suggestions.push({ label, kind: K.Snippet, detail, insertText: body, insertTextRules: SNIPPET, sortText: '9' + label, range });
        }
      }
      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider('java', {
    async provideHover(model, position, token) {
      const data = await post<{ text: string | null }>(
        '/hover',
        { code: model.getValue(), line: position.lineNumber, col: position.column },
        token,
      );
      if (!data?.text) return null;
      const word = model.getWordAtPosition(position);
      return {
        contents: [{ value: data.text }],
        range: word ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) : undefined,
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider('java', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position, token) {
      const data = await post<{
        signatures: { label: string; params: string[] }[];
        activeSignature: number;
        activeParameter: number;
      }>('/signature', { code: model.getValue(), line: position.lineNumber, col: position.column }, token);
      if (!data || data.signatures.length === 0) return null;
      return {
        value: {
          signatures: data.signatures.map((s) => ({
            label: s.label,
            parameters: s.params.map((p) => ({ label: p })),
          })),
          activeSignature: data.activeSignature,
          activeParameter: data.activeParameter,
        },
        dispose() {},
      };
    },
  });
}
