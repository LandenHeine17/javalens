// JavaLens for VS Code.
//
// "JavaLens: Visualize" starts the bundled JavaLens server (server/javalens.jar, run with the user's
// JDK 25) and opens a panel beside the editor. The panel shows the JavaLens page in VS Code mode
// (?host=vscode), inside an iframe. Messages flow:
//   extension -> page   { type: 'code', code,         the main .java file, on open and on every edit,
//                         mainPath, files }           plus the rest of its project (every .java file
//                                                     under the source root), so imports work
//                       { type: 'theme', theme }      'dark' | 'light', following VS Code's theme
//   page -> extension   { type: 'ready' }             the page is listening
//                       { type: 'line', line, file }  the step being shown -> highlight that line
//                                                     (file: set when it's in another file of the project)
//                       { type: 'diagnostics', ... }  compile errors -> squiggles in the editor
import * as vscode from 'vscode';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIN_JAVA = 25;
const JDK_DOWNLOAD = 'https://adoptium.net/temurin/releases/?version=25';

interface Server {
  process: ChildProcess | null;
  url: Promise<string>;
}
let server: Server | null = null;
let panel: vscode.WebviewPanel | null = null;
let boundDoc: vscode.TextDocument | null = null; // the .java file whose main() the panel runs
let sourceRoot: string | null = null; // the folder its package starts in, e.g. .../src
let projectFiles: string[] | null = null; // cached list of the other .java files under sourceRoot
let sendTimer: NodeJS.Timeout | undefined;
let followingStep = false; // we're opening a file to show a step: don't treat it as the user switching files
const MAX_FILES = 300;
const SKIP_DIRS = new Set(['bin', 'out', 'build', 'target', 'node_modules', '.git', '.gradle', '.idea', '.vscode', '.metals']);
let output: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let lineDecoration: vscode.TextEditorDecorationType;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('JavaLens');
  diagnostics = vscode.languages.createDiagnosticCollection('javalens');
  lineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    borderColor: new vscode.ThemeColor('editorInfo.foreground'),
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  context.subscriptions.push(
    output,
    diagnostics,
    lineDecoration,
    vscode.commands.registerCommand('javalens.visualize', () => visualize(context)),

    // Edits to any file of the program re-run it.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (panel && inProject(e.document.uri.fsPath)) scheduleSend();
    }),
    // Switching to another file with a main() method visualizes that program instead.
    // (Files without main, like a model class, are part of the current program: stay put.)
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const doc = editor?.document;
      if (!panel || followingStep || !doc || doc.languageId !== 'java' || doc === boundDoc) return;
      if (hasMain(doc.getText())) bind(doc);
    }),
    // New or deleted .java files change the project.
    (() => {
      const watcher = vscode.workspace.createFileSystemWatcher('**/*.java', false, true, false);
      const changed = (uri: vscode.Uri) => {
        if (panel && sourceRoot && uri.fsPath.startsWith(sourceRoot + path.sep)) {
          projectFiles = null;
          scheduleSend();
        }
      };
      watcher.onDidCreate(changed);
      watcher.onDidDelete(changed);
      return watcher;
    })(),
    vscode.window.onDidChangeActiveColorTheme(() => post({ type: 'theme', theme: themeName() })),
    { dispose: stopServer },
  );
}

export function deactivate() {
  stopServer();
}

// ------------------------------------------------------------------ the panel

async function visualize(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document.languageId === 'java' ? editor.document : boundDoc;
  if (!doc) {
    vscode.window.showInformationMessage('Open a .java file first, then run JavaLens: Visualize.');
    return;
  }

  if (panel) {
    bind(doc);
    panel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }

  let url: string;
  try {
    url = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Starting JavaLens…' },
      () => startServer(context),
    );
  } catch (e) {
    stopServer();
    await showStartError(e as Error);
    return;
  }

  // asExternalUri makes the local server reachable from the webview (also over Remote/WSL/Codespaces).
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
  const origin = external.toString(true).replace(/\/$/, '');

  panel = vscode.window.createWebviewPanel('javalens', 'JavaLens', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
    enableScripts: true,
    retainContextWhenHidden: true, // keep the trace and position when the tab is in the background
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
  panel.webview.html = webviewHtml(origin);
  panel.webview.onDidReceiveMessage(onPageMessage);
  panel.onDidDispose(() => {
    panel = null;
    clearHighlights();
    diagnostics.clear();
    boundDoc = null;
  });
  bind(doc);
}

/** The panel's page: a full-size iframe of the JavaLens server, plus a relay for messages. */
function webviewHtml(origin: string): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const src = `${origin}/?host=vscode&theme=${themeName()}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>html, body, iframe { margin: 0; padding: 0; width: 100%; height: 100%; border: 0; overflow: hidden; display: block; }</style>
</head>
<body>
<iframe id="lens" src="${src}" title="JavaLens"></iframe>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('lens');
  window.addEventListener('message', (e) => {
    if (e.source === frame.contentWindow) vscode.postMessage(e.data); // page -> extension
    else frame.contentWindow.postMessage(e.data, ${JSON.stringify(origin)}); // extension -> page
  });
</script>
</body>
</html>`;
}

function bind(doc: vscode.TextDocument) {
  if (boundDoc && boundDoc !== doc) {
    clearHighlights();
    diagnostics.clear();
  }
  boundDoc = doc;
  sourceRoot = findSourceRoot(doc);
  projectFiles = null;
  if (panel) panel.title = `JavaLens: ${path.basename(doc.fileName)}`;
  sendCode();
}

function hasMain(code: string): boolean {
  return /\bvoid\s+main\s*\(/.test(code);
}

/**
 * Where the main file's package starts: for src/edu/unl/raikes/memory/Application.java with
 * "package edu.unl.raikes.memory;" that's src/. Without a package, the file's own folder.
 */
function findSourceRoot(doc: vscode.TextDocument): string {
  const dir = path.dirname(doc.uri.fsPath);
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(doc.getText())?.[1];
  if (!pkg) return dir;
  const parts = pkg.split('.');
  const tail = dir.split(path.sep).slice(-parts.length);
  return tail.join('.') === pkg ? path.join(dir, ...parts.map(() => '..')) : dir;
}

const rel = (file: string) => path.relative(sourceRoot!, file).split(path.sep).join('/');

function inProject(file: string): boolean {
  return !!sourceRoot && file.endsWith('.java') && (file === boundDoc?.uri.fsPath || file.startsWith(sourceRoot + path.sep));
}

/** Every .java file under the source root (skipping build output), cached until files are added or removed. */
function listProjectFiles(): string[] {
  if (projectFiles) return projectFiles;
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Without a package, files in subfolders can't belong to the program: don't look there.
        if (recursive && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full);
      } else if (e.name.endsWith('.java')) {
        found.push(full);
      }
    }
  };
  const recursive = !!boundDoc && /^\s*package\s+[\w.]+\s*;/m.test(boundDoc.getText());
  if (sourceRoot) walk(sourceRoot);
  projectFiles = found;
  return found;
}

/** A file's current text: the editor's (unsaved edits included) if it's open, else from disk. */
function readSource(file: string): string | null {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
  if (open) return open.getText();
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function scheduleSend() {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(sendCode, 150);
}

function sendCode() {
  if (!boundDoc || !sourceRoot) return;
  const main = boundDoc.uri.fsPath;
  const files = listProjectFiles()
    .filter((f) => f !== main)
    .map((f) => ({ path: rel(f), code: readSource(f) }))
    .filter((f): f is { path: string; code: string } => f.code !== null);
  post({ type: 'code', code: boundDoc.getText(), mainPath: rel(main), files });
}

function post(msg: unknown) {
  panel?.webview.postMessage(msg);
}

function themeName(): 'dark' | 'light' {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
}

interface PageDiagnostic {
  line: number;
  col: number;
  endCol: number;
  message: string;
  severity: 'error' | 'warning';
  file?: string; // relative to the source root; absent for the main file
}

/** A path the page sent (relative to the source root), or the main file when absent. */
function uriFor(file: string | null | undefined): vscode.Uri | null {
  if (!file) return boundDoc?.uri ?? null;
  if (!sourceRoot) return null;
  const full = path.resolve(sourceRoot, ...file.split('/'));
  return full.startsWith(sourceRoot + path.sep) ? vscode.Uri.file(full) : null;
}

function onPageMessage(msg: { type?: string; line?: number | null; file?: string | null; diagnostics?: PageDiagnostic[] }) {
  if (msg.type === 'ready') {
    post({ type: 'theme', theme: themeName() });
    sendCode();
  } else if (msg.type === 'line') {
    highlightLine(msg.line ?? null, msg.file ?? null);
  } else if (msg.type === 'diagnostics' && boundDoc) {
    diagnostics.clear();
    if (!vscode.workspace.getConfiguration('javalens').get<boolean>('showCompileErrors', true)) return;
    const byFile = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
    for (const d of msg.diagnostics ?? []) {
      const uri = uriFor(d.file);
      if (!uri) continue;
      const line = Math.max(0, d.line - 1);
      const range = new vscode.Range(line, Math.max(0, d.col - 1), line, Math.max(d.col, d.endCol - 1));
      const severity = d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      const diag = new vscode.Diagnostic(range, d.message, severity);
      diag.source = 'JavaLens';
      const entry = byFile.get(uri.toString()) ?? { uri, list: [] };
      entry.list.push(diag);
      byFile.set(uri.toString(), entry);
    }
    for (const { uri, list } of byFile.values()) diagnostics.set(uri, list);
  }
}

/**
 * Highlight the line the visualizer is showing. When a step is in another file of the program
 * (stepping into Year's constructor, say), open that file where the main file is, like a debugger does.
 */
async function highlightLine(line: number | null, file: string | null) {
  const uri = uriFor(file);
  for (const editor of vscode.window.visibleTextEditors) {
    if (!uri || editor.document.uri.toString() !== uri.toString()) editor.setDecorations(lineDecoration, []);
  }
  if (!uri || line === null || line < 1) return;

  let editors = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uri.toString());
  if (!editors.length) {
    const column = vscode.window.visibleTextEditors.find((e) => inProject(e.document.uri.fsPath))?.viewColumn ?? vscode.ViewColumn.One;
    followingStep = true;
    try {
      editors = [await vscode.window.showTextDocument(uri, { viewColumn: column, preserveFocus: true, preview: true })];
    } catch {
      return;
    } finally {
      setTimeout(() => (followingStep = false), 300);
    }
  }
  for (const editor of editors) {
    if (line > editor.document.lineCount) continue;
    const range = new vscode.Range(line - 1, 0, line - 1, 0);
    editor.setDecorations(lineDecoration, [range]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

function clearHighlights() {
  for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(lineDecoration, []);
}

// ------------------------------------------------------------------ the JavaLens server

/** Starts the server once (later calls reuse it) and resolves to its URL. */
function startServer(context: vscode.ExtensionContext): Promise<string> {
  if (server) return server.url;
  const entry: Server = { process: null, url: Promise.resolve('') };
  entry.url = (async () => {
    const java = await findJava();
    const jar = path.join(context.extensionPath, 'server', 'javalens.jar');
    if (!fs.existsSync(jar)) throw new Error(`The JavaLens server is missing from the extension (${jar}). Reinstall the extension.`);
    output.appendLine(`Starting: ${java.exe} -jar ${jar} --embedded`);

    const proc = spawn(java.exe, ['-jar', jar, '--embedded'], { stdio: ['ignore', 'pipe', 'pipe'] });
    entry.process = proc;
    return await new Promise<string>((resolve, reject) => {
      let log = '';
      const timer = setTimeout(() => reject(new Error('The JavaLens server did not start within 20 seconds.\n' + log)), 20_000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        log += text;
        output.append(text);
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)\//.exec(log);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        output.appendLine(`JavaLens server exited (code ${code}).`);
        reject(new Error(`The JavaLens server stopped (exit code ${code}).\n` + log));
        if (server === entry) server = null; // start a fresh one next time
      });
    });
  })();
  entry.url.catch(() => {
    if (server === entry) server = null;
  });
  server = entry;
  return entry.url;
}

function stopServer() {
  if (server?.process && server.process.exitCode === null) server.process.kill();
  server = null;
}

class JavaNotFound extends Error {}

/** The JDK to run the server with: the setting, then JAVA_HOME, then the Java extension's setting, then PATH. */
async function findJava(): Promise<{ exe: string; version: number; home: string }> {
  const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const homes = [
    vscode.workspace.getConfiguration('javalens').get<string>('javaHome', ''),
    process.env.JAVA_HOME ?? '',
    vscode.workspace.getConfiguration('java.jdt.ls').get<string>('java.home', '') ?? '',
    vscode.workspace.getConfiguration('java').get<string>('home', '') ?? '',
  ].filter(Boolean);
  const candidates = [...homes.map((h) => path.join(h, 'bin', exeName)), 'java'];

  const problems: string[] = [];
  for (const exe of candidates) {
    if (exe !== 'java' && !fs.existsSync(exe)) {
      problems.push(`${exe}: not found`);
      continue;
    }
    try {
      const info = await javaInfo(exe);
      const javac = path.join(info.home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
      if (info.version < MIN_JAVA) problems.push(`${exe}: Java ${info.version} (JavaLens needs ${MIN_JAVA} or newer)`);
      else if (!fs.existsSync(javac)) problems.push(`${exe}: Java ${info.version} is a JRE, not a JDK (no javac)`);
      else {
        output.appendLine(`Using Java ${info.version} at ${info.home}`);
        return { exe, ...info };
      }
    } catch {
      problems.push(`${exe}: could not run it`);
    }
  }
  output.appendLine('No suitable Java found:\n  ' + problems.join('\n  '));
  throw new JavaNotFound(`JavaLens needs a JDK ${MIN_JAVA} or newer.`);
}

function javaInfo(exe: string): Promise<{ version: number; home: string }> {
  return new Promise((resolve, reject) => {
    execFile(exe, ['-XshowSettings:properties', '-version'], { timeout: 15_000 }, (err, stdout, stderr) => {
      const text = stdout + stderr;
      const spec = /java\.specification\.version = (\d+)/.exec(text);
      const home = /java\.home = (.+)/.exec(text);
      if (!spec || !home) return reject(err ?? new Error('unexpected output'));
      resolve({ version: Number(spec[1]), home: home[1].trim() });
    });
  });
}

async function showStartError(e: Error) {
  if (e instanceof JavaNotFound) {
    const pick = await vscode.window.showErrorMessage(
      `${e.message} Install one, or point the "javalens.javaHome" setting at it.`,
      'Download JDK 25',
      'Open Settings',
      'Show Details',
    );
    if (pick === 'Download JDK 25') vscode.env.openExternal(vscode.Uri.parse(JDK_DOWNLOAD));
    if (pick === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', 'javalens.javaHome');
    if (pick === 'Show Details') output.show();
    return;
  }
  output.appendLine(String(e.message));
  const pick = await vscode.window.showErrorMessage('JavaLens could not start its server.', 'Show Details');
  if (pick) output.show();
}
