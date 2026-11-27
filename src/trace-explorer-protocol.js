'use strict';

// The message contract between the Trace Explorer panel (extension host) and its webview.
//
// WHY A MODULE OF ITS OWN
//
// The webview is a page that runs script, so everything it posts back is untrusted input:
// a bug in a view, or content from a project file that escaped rendering, must not be able
// to make the host do anything beyond what the page is for. The page is read-only. The
// host does exactly two things on its behalf: open a file in an editor, when the file is
// inside the opened project, and re-read the project. Nothing here runs a command, opens
// a chat, writes a file, or starts a process, and no validator passes through a field it
// does not know: every cleaned message is built fresh from the fields named below.
//
// The same idea as acceptablePrompt() in aidlc/command-builder.js -- "accept back only
// what the page could have made" -- applied to every message type instead of one.
//
// Pure Node (path, fs reads only), no vscode import, so it is testable under node --test.
// The webview cannot require this file; media/trace-explorer/main.js mirrors the type
// strings (see docs/trace-explorer/msg-protocol.md).

const nodePath = require('path');
const nodeFs = require('fs');

const PROTOCOL_VERSION = 1;

// webview -> host
const TO_HOST = Object.freeze({
  READY: 'ready',
  OPEN_FILE: 'openFile',
  REFRESH: 'refresh',
  SELECTION_CHANGED: 'selectionChanged'
});

// host -> webview
const TO_WEBVIEW = Object.freeze({
  SET_DATA: 'setData',
  DATA_ERROR: 'dataError',
  NAVIGATE_TO: 'navigateTo'
});

const TABS = Object.freeze(['trace', 'cov', 'rev', 'about']);
const SET_DATA_REASONS = Object.freeze(['initial', 'refresh', 'file-change']);
const DATA_ERROR_CODES = Object.freeze(['no-project', 'read-failed', 'not-serializable', 'too-large', 'bad-shape']);

const LIMITS = Object.freeze({
  PATH_MAX: 1024,
  NODE_ID_MAX: 256,
  ERROR_MESSAGE_MAX: 500,
  LINE_MAX: 10_000_000,
  // The reference project serialises to well under 1 MiB. 8 MiB leaves room for large
  // intents while refusing something that would stall the webview's JSON parse.
  SET_DATA_MAX_BYTES: 8 * 1024 * 1024
});

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function cleanNodeId(v) {
  if (typeof v !== 'string') return undefined;
  if (v.length === 0 || v.length > LIMITS.NODE_ID_MAX) return undefined;
  if (v.trim() === '' || CONTROL_CHARS.test(v)) return undefined;
  return v;
}

function isValidLine(v) {
  return Number.isInteger(v) && v >= 1 && v <= LIMITS.LINE_MAX;
}

function isSeq(v) {
  return Number.isInteger(v) && v >= 0;
}

// `target` strictly inside `root` (the root itself does not count: it is a folder).
// A name that merely starts with two dots ("..notes.md") is not an escape.
function isInside(p, root, target) {
  const rel = p.relative(root, target);
  if (rel === '' || p.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + p.sep);
}

// Resolves a path the webview asked to open to a real file inside the project, or null.
//
// Checks, in order, all of which must pass:
//   1. A non-empty string of bounded length without control characters.
//   2. No URI scheme or colon (command:, file:, vscode:, http:, Windows alternate data
//      streams). The only colon allowed is a Windows drive letter under the win32 path module.
//   3. No UNC / protocol-relative prefix (//host, \\host).
//   4. Under POSIX, no backslash: it is a file-name character there and a separator to
//      everyone reading the path, so it is refused rather than given one meaning.
//   5. No '..' segment at all, even one that would land back inside the root.
//   6. Lexically inside the root after resolution (absolute paths are allowed only when
//      they name something inside the root).
//   7. With fs (the default): the realpath of the target is inside the realpath of the
//      root, so a symlink in the project pointing outside it is refused, and the target is
//      an existing regular file. The returned absPath is the resolved real path, so what
//      the host opens is the file that was checked, not a link that could be re-pointed.
//
// options.path: a path module (path.posix / path.win32 for tests). Defaults to `path`.
// options.fs:   { realpathSync, statSync }. Defaults to `fs`. Pass null for a lexical-only
//               check (tests, or a platform check); the host must not pass null.
function resolveProjectFile(projectRoot, requested, options = {}) {
  const p = options.path || nodePath;
  const fs = options.fs === undefined ? nodeFs : options.fs;

  if (typeof projectRoot !== 'string' || projectRoot === '' || !p.isAbsolute(projectRoot)) return null;
  if (typeof requested !== 'string') return null;
  if (requested.length === 0 || requested.length > LIMITS.PATH_MAX) return null;
  if (CONTROL_CHARS.test(requested)) return null;

  const win = p.sep === '\\';
  const drive = win && /^[A-Za-z]:[\\/]/.test(requested);
  if ((drive ? requested.slice(2) : requested).includes(':')) return null;
  if (/^[\\/]{2}/.test(requested)) return null;
  if (!win && requested.includes('\\')) return null;
  if (requested.split(/[\\/]+/).some((s) => s === '..')) return null;

  const root = p.resolve(projectRoot);
  const lexical = p.resolve(root, requested);
  if (!isInside(p, root, lexical)) return null;

  let absPath = lexical;
  if (fs) {
    let realRoot;
    let realTarget;
    try {
      realRoot = fs.realpathSync(root);
      realTarget = fs.realpathSync(lexical);
    } catch {
      return null; // missing file, dangling link, unreadable root
    }
    if (!isInside(p, realRoot, realTarget)) return null;
    try {
      if (!fs.statSync(realTarget).isFile()) return null;
    } catch {
      return null;
    }
    absPath = realTarget;
  }

  const relPath = p.relative(root, lexical).split(p.sep).join('/');
  return { relPath, absPath };
}

// Validates one message from the webview. Returns a freshly built message holding only the
// known fields, or null to drop it. Unknown types (openChat, save, runCommand, ...) are null.
//
// ctx.projectRoot: absolute path of the opened project; required for openFile.
// ctx.path / ctx.fs: passed to resolveProjectFile.
function validateWebviewMessage(raw, ctx = {}) {
  if (!isPlainObject(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case TO_HOST.READY: {
      const out = { type: TO_HOST.READY };
      if (raw.protocol !== undefined) {
        if (!Number.isInteger(raw.protocol) || raw.protocol < 1) return null;
        out.protocol = raw.protocol;
      }
      return out;
    }
    case TO_HOST.REFRESH:
      return { type: TO_HOST.REFRESH };
    case TO_HOST.SELECTION_CHANGED: {
      let nodeId = null;
      if (raw.nodeId !== null && raw.nodeId !== undefined) {
        nodeId = cleanNodeId(raw.nodeId);
        if (nodeId === undefined) return null;
      }
      const out = { type: TO_HOST.SELECTION_CHANGED, nodeId };
      if (raw.tab !== undefined) {
        if (!TABS.includes(raw.tab)) return null;
        out.tab = raw.tab;
      }
      return out;
    }
    case TO_HOST.OPEN_FILE: {
      if (!ctx || typeof ctx.projectRoot !== 'string') return null;
      if (raw.line !== undefined && !isValidLine(raw.line)) return null;
      const resolved = resolveProjectFile(ctx.projectRoot, raw.path, { path: ctx.path, fs: ctx.fs });
      if (!resolved) return null;
      const out = { type: TO_HOST.OPEN_FILE, path: resolved.relPath, absPath: resolved.absPath };
      if (raw.line !== undefined) out.line = raw.line;
      return out;
    }
    default:
      return null;
  }
}

// --- host -> webview builders ------------------------------------------------------------

function buildDataErrorMessage(code, message, { seq = 0 } = {}) {
  const text = String(message ?? '');
  return {
    type: TO_WEBVIEW.DATA_ERROR,
    protocol: PROTOCOL_VERSION,
    seq: isSeq(seq) ? seq : 0,
    code: DATA_ERROR_CODES.includes(code) ? code : 'read-failed',
    message: text.length > LIMITS.ERROR_MESSAGE_MAX ? text.slice(0, LIMITS.ERROR_MESSAGE_MAX - 1) + '…' : text
  };
}

// Builds the setData message for a TraceData object, or the dataError that replaces it.
// Returns { ok: true, message, bytes } or { ok: false, message: <dataError>, bytes? }.
//
// The data is serialised once here: that proves it is JSON-safe (no cycles, no BigInt),
// measures it against maxBytes, and the parsed copy is what is posted, so the webview
// receives exactly the bytes that were measured (no functions, no prototypes, no undefined).
// seq and reason are the host's own values; wrong ones are a programming error and throw.
function buildSetDataMessage(data, { seq = 0, reason = 'initial', maxBytes = LIMITS.SET_DATA_MAX_BYTES } = {}) {
  if (!isSeq(seq)) throw new TypeError('setData seq must be a non-negative integer');
  if (!SET_DATA_REASONS.includes(reason)) throw new TypeError(`setData reason must be one of ${SET_DATA_REASONS.join(', ')}`);
  if (!(Number.isFinite(maxBytes) && maxBytes > 0)) throw new TypeError('maxBytes must be a positive number');

  if (!isPlainObject(data) || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    return { ok: false, message: buildDataErrorMessage('bad-shape', 'Trace data has no nodes[] / edges[].', { seq }) };
  }
  let json;
  try {
    json = JSON.stringify(data);
  } catch (err) {
    return {
      ok: false,
      message: buildDataErrorMessage('not-serializable', `Trace data could not be serialised: ${err && err.message ? err.message : err}`, { seq })
    };
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxBytes) {
    return {
      ok: false,
      bytes,
      message: buildDataErrorMessage(
        'too-large',
        `Trace data is ${bytes} bytes, over the ${maxBytes}-byte limit for the explorer. Narrow it to one intent.`,
        { seq }
      )
    };
  }
  return {
    ok: true,
    bytes,
    message: { type: TO_WEBVIEW.SET_DATA, protocol: PROTOCOL_VERSION, seq, reason, data: JSON.parse(json) }
  };
}

// Returns the navigateTo message, or null when the node id is not acceptable.
function buildNavigateToMessage(nodeId, tab = 'trace') {
  const id = cleanNodeId(nodeId);
  if (id === undefined || !TABS.includes(tab)) return null;
  return { type: TO_WEBVIEW.NAVIGATE_TO, protocol: PROTOCOL_VERSION, nodeId: id, tab };
}

// Validates a host -> webview message (the webview mirrors this logic; the host may use it
// as a self-check before posting). Returns a cleaned copy or null.
function validateHostMessage(raw) {
  if (!isPlainObject(raw) || typeof raw.type !== 'string') return null;
  const seq = raw.seq === undefined ? 0 : raw.seq;
  switch (raw.type) {
    case TO_WEBVIEW.SET_DATA: {
      if (!isSeq(seq) || !SET_DATA_REASONS.includes(raw.reason)) return null;
      const d = raw.data;
      if (!isPlainObject(d) || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) return null;
      return { type: TO_WEBVIEW.SET_DATA, protocol: PROTOCOL_VERSION, seq, reason: raw.reason, data: d };
    }
    case TO_WEBVIEW.DATA_ERROR: {
      if (!isSeq(seq) || !DATA_ERROR_CODES.includes(raw.code) || typeof raw.message !== 'string') return null;
      return { type: TO_WEBVIEW.DATA_ERROR, protocol: PROTOCOL_VERSION, seq, code: raw.code, message: raw.message.slice(0, LIMITS.ERROR_MESSAGE_MAX) };
    }
    case TO_WEBVIEW.NAVIGATE_TO:
      return buildNavigateToMessage(raw.nodeId, raw.tab === undefined ? 'trace' : raw.tab);
    default:
      return null;
  }
}

module.exports = {
  PROTOCOL_VERSION,
  TO_HOST,
  TO_WEBVIEW,
  TABS,
  SET_DATA_REASONS,
  DATA_ERROR_CODES,
  LIMITS,
  resolveProjectFile,
  validateWebviewMessage,
  validateHostMessage,
  buildSetDataMessage,
  buildDataErrorMessage,
  buildNavigateToMessage
};
