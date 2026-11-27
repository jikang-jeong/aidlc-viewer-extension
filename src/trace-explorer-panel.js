'use strict';

// The Trace Explorer webview panel: one per window, read-only.
//
// This is the only Trace Explorer file that requires vscode. It owns the panel's
// lifecycle and the host side of the message protocol; the HTML is built by
// trace-explorer-html.js, the data by aidlc/trace-data.js, and every message type,
// validator and builder comes from trace-explorer-protocol.js.
//
// WHAT THE PAGE CAN MAKE THE HOST DO
//
// Exactly two things (docs/trace-explorer/msg-protocol.md): open a file that resolves to a regular
// file inside the project root (markdown in the extension's own viewer, everything else in
// a text editor), and re-read the project. Every incoming message goes
// through validateWebviewMessage, which returns a freshly built object or null; null is
// dropped with no reply. The file opened is the validated real path (absPath), never the
// string the page sent. enableCommandUris is never set, so a command: link that escaped a
// view's escaping does nothing.
//
// Registration (command, watcher hook-up) lives in extension.js:
//   const traceExplorer = require('./trace-explorer-panel');
//   traceExplorer.createOrShow(context, { projectRoot, intent });
//   traceExplorer.scheduleReload('file-change');   // from the watcher, when the panel exists

const vscode = require('vscode');
const path = require('path');
const P = require('./trace-explorer-protocol');
const { readTraceData } = require('./aidlc/trace-data');
const { buildHtml, makeNonce, SCRIPT_ORDER } = require('./trace-explorer-html');

const VIEW_TYPE = 'markdownWatchViewer.traceExplorer';
const TITLE = 'Trace Explorer';
const MEDIA_DIR = ['media', 'trace-explorer'];
const DEBOUNCE_MS = 200;

// The single panel, or null.
let current = null;

function mediaRoot(context) {
  return vscode.Uri.joinPath(context.extensionUri, ...MEDIA_DIR);
}

function renderHtml(panel, context) {
  const webview = panel.webview;
  const base = mediaRoot(context);
  const asset = (rel) => webview.asWebviewUri(vscode.Uri.joinPath(base, ...rel.split('/'))).toString();
  const scriptUris = {};
  for (const rel of SCRIPT_ORDER) scriptUris[rel] = asset(rel);
  return buildHtml({
    cspSource: webview.cspSource,
    nonce: makeNonce(),
    cssUri: asset('trace-explorer.css'),
    scriptUris,
    title: TITLE
  });
}

function post(message) {
  if (!current) return false;
  try {
    // postMessage returns a Thenable that rejects if the webview is gone.
    Promise.resolve(current.panel.webview.postMessage(message)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// Re-read the project and post setData (or dataError). Returns the message posted, or null
// when there is no panel. Synchronous: readTraceData only reads files and never throws by
// contract; a throw is still caught and reported as read-failed.
function reload(reason = 'refresh') {
  if (!current) return null;
  if (!P.SET_DATA_REASONS.includes(reason)) reason = 'refresh';
  if (current.timer) {
    clearTimeout(current.timer);
    current.timer = null;
  }
  current.seq += 1;
  const seq = current.seq;
  let message;
  if (!current.projectRoot) {
    message = P.buildDataErrorMessage('no-project', 'No project folder is open for the Trace Explorer.', { seq });
  } else {
    let data;
    try {
      data = readTraceData(current.projectRoot, current.intent ? { intent: current.intent } : {});
    } catch (err) {
      data = undefined;
      message = P.buildDataErrorMessage('read-failed', `Could not read the project: ${err && err.message ? err.message : err}`, { seq });
    }
    if (!message) {
      if (data && data.meta && !data.meta.intentPath && Array.isArray(data.nodes) && data.nodes.length === 0) {
        const why = Array.isArray(data.meta.warnings) && data.meta.warnings.length ? ` (${data.meta.warnings[0]})` : '';
        message = P.buildDataErrorMessage('no-project', `No AI-DLC v2 intent was found in ${path.basename(current.projectRoot)}${why}.`, { seq });
      } else {
        message = P.buildSetDataMessage(data, { seq, reason }).message;
      }
    }
  }
  post(message);
  if (message.type === P.TO_WEBVIEW.SET_DATA && reason === 'initial' && current.lastSelection && current.lastSelection.nodeId) {
    const nav = P.buildNavigateToMessage(current.lastSelection.nodeId, current.lastSelection.tab || 'trace');
    if (nav) post(nav);
  }
  return message;
}

// Debounced reload for the file watcher: several changes inside DEBOUNCE_MS are one read.
function scheduleReload(reason = 'file-change', delayMs = DEBOUNCE_MS) {
  if (!current) return false;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    if (current) {
      current.timer = null;
      reload(reason);
    }
  }, delayMs);
  return true;
}

// Markdown opens rendered, in the extension's own viewer: the one the tree uses when a
// file is clicked (WatchController.openFile, registered as this command). Called through
// executeCommand with the same { type: 'file', resourceUri } shape a tree item has, so
// this module needs nothing from extension.js. The second argument asks for the viewer
// beside the Trace Explorer (so it does not cover it) and, for a link with a line, for
// the rendered view scrolled to the block that line starts. If the command is not
// registered (or fails), the file opens as text at the line, as every other file does.
const MARKDOWN_VIEWER_COMMAND = 'markdownWatchViewer.openFile';
const MARKDOWN_FILE = /\.(md|markdown)$/i;

async function openAsText(absPath, line) {
  const options = { preview: true, viewColumn: vscode.ViewColumn.Beside };
  if (Number.isInteger(line) && line >= 1) {
    const pos = new vscode.Position(line - 1, 0);
    options.selection = new vscode.Range(pos, pos);
  }
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(absPath), options);
  } catch (err) {
    vscode.window.showWarningMessage(`Could not open ${path.basename(absPath)}: ${err && err.message ? err.message : err}`);
  }
}

async function openRendered(absPath, line) {
  const uri = vscode.Uri.file(absPath);
  const options = { viewColumn: 'beside' };
  if (Number.isInteger(line) && line >= 1) options.line = line;
  try {
    const commands = await vscode.commands.getCommands(true);
    if (!Array.isArray(commands) || !commands.includes(MARKDOWN_VIEWER_COMMAND)) return false;
    await vscode.commands.executeCommand(MARKDOWN_VIEWER_COMMAND, { type: 'file', resourceUri: uri, id: uri.toString() }, options);
  } catch {
    return false;
  }
  return true;
}

async function openInEditor(absPath, line) {
  if (MARKDOWN_FILE.test(absPath) && (await openRendered(absPath, line))) return;
  await openAsText(absPath, line);
}

function handleMessage(raw) {
  if (!current) return;
  const msg = P.validateWebviewMessage(raw, { projectRoot: current.projectRoot });
  if (!msg) return; // dropped: no reply, no toast (see msg-protocol.md "Errors")
  switch (msg.type) {
    case P.TO_HOST.READY:
      reload('initial');
      return;
    case P.TO_HOST.REFRESH:
      reload('refresh');
      return;
    case P.TO_HOST.SELECTION_CHANGED:
      current.lastSelection = { nodeId: msg.nodeId, tab: msg.tab };
      return;
    case P.TO_HOST.OPEN_FILE:
      return openInEditor(msg.absPath, msg.line);
    default:
      return;
  }
}

/**
 * Open the Trace Explorer, or reveal it if it is already open. If the project or intent
 * changed, the open panel re-reads.
 * @param {vscode.ExtensionContext} context
 * @param {{ projectRoot?: string, intent?: string }} [opts]
 */
function createOrShow(context, { projectRoot, intent } = {}) {
  const root = typeof projectRoot === 'string' && projectRoot ? path.resolve(projectRoot) : '';
  const wanted = typeof intent === 'string' && intent ? intent : undefined;

  if (current) {
    const changed = current.projectRoot !== root || current.intent !== wanted;
    current.projectRoot = root;
    current.intent = wanted;
    if (changed) {
      current.lastSelection = null;
      reload('refresh');
    }
    current.panel.reveal(undefined, false);
    return current.panel;
  }

  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, TITLE, vscode.ViewColumn.One, {
    enableScripts: true,
    enableForms: false,
    // enableCommandUris deliberately absent (defaults to false).
    retainContextWhenHidden: true,
    localResourceRoots: [mediaRoot(context)]
  });

  current = { panel, projectRoot: root, intent: wanted, seq: 0, timer: null, lastSelection: null, subscriptions: [] };
  const self = current;
  self.subscriptions.push(panel.webview.onDidReceiveMessage(handleMessage));
  self.subscriptions.push(
    panel.onDidDispose(() => {
      if (self.timer) clearTimeout(self.timer);
      for (const s of self.subscriptions) {
        try { s.dispose(); } catch { /* already gone */ }
      }
      self.subscriptions = [];
      if (current === self) current = null;
    })
  );
  panel.webview.html = renderHtml(panel, context);
  return panel;
}

function dispose() {
  if (current) current.panel.dispose();
}

function isOpen() {
  return current !== null;
}

module.exports = { createOrShow, reload, scheduleReload, dispose, isOpen, VIEW_TYPE, MARKDOWN_VIEWER_COMMAND };
