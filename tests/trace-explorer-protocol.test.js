'use strict';

// The Trace Explorer message contract. The webview runs script, so everything it posts is
// untrusted: these cases are what the host accepts back, and everything it drops.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const P = require('../src/trace-explorer-protocol');
const {
  TO_HOST,
  TO_WEBVIEW,
  LIMITS,
  resolveProjectFile,
  validateWebviewMessage,
  validateHostMessage,
  buildSetDataMessage,
  buildDataErrorMessage,
  buildNavigateToMessage
} = P;

// A read-only stand-in for fs: `files` exist as regular files, `dirs` as folders, and
// `links` maps a path to what realpath returns for it (a symlink, or a path under one).
function fakeFs({ files = [], dirs = [], links = {} } = {}) {
  const f = new Set(files);
  const d = new Set(dirs);
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    realpathSync(p) {
      if (Object.prototype.hasOwnProperty.call(links, p)) return links[p];
      if (f.has(p) || d.has(p)) return p;
      throw enoent();
    },
    statSync(p) {
      if (f.has(p)) return { isFile: () => true };
      if (d.has(p)) return { isFile: () => false };
      throw enoent();
    }
  };
}

const ROOT = '/work/proj';
const posixCtx = (fsImpl) => ({ projectRoot: ROOT, path: path.posix, fs: fsImpl });
const baseFs = fakeFs({
  dirs: [ROOT, `${ROOT}/aidlc-docs`],
  files: [`${ROOT}/aidlc-docs/requirements.md`, `${ROOT}/..notes.md`, `${ROOT}/src/app.ts`]
});
const open = (p, extra = {}, fsImpl = baseFs) => validateWebviewMessage({ type: 'openFile', path: p, ...extra }, posixCtx(fsImpl));

// ---------------------------------------------------------------------------------------
// constants

test('message types: the four webview->host and three host->webview names, frozen, no overlap', () => {
  assert.deepEqual(Object.values(TO_HOST).sort(), ['openFile', 'ready', 'refresh', 'selectionChanged']);
  assert.deepEqual(Object.values(TO_WEBVIEW).sort(), ['dataError', 'navigateTo', 'setData']);
  assert.ok(Object.isFrozen(TO_HOST) && Object.isFrozen(TO_WEBVIEW) && Object.isFrozen(LIMITS));
  const both = new Set([...Object.values(TO_HOST), ...Object.values(TO_WEBVIEW)]);
  assert.equal(both.size, 7);
  assert.equal(P.PROTOCOL_VERSION, 1);
});

// ---------------------------------------------------------------------------------------
// webview -> host: valid

test('ready: accepted bare or with a protocol number; unknown fields are dropped', () => {
  assert.deepEqual(validateWebviewMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(validateWebviewMessage({ type: 'ready', protocol: 1, command: 'x' }), { type: 'ready', protocol: 1 });
  assert.equal(validateWebviewMessage({ type: 'ready', protocol: '1' }), null);
  assert.equal(validateWebviewMessage({ type: 'ready', protocol: 0 }), null);
});

test('refresh: accepted, carries nothing through', () => {
  assert.deepEqual(validateWebviewMessage({ type: 'refresh', path: '/etc/passwd', command: 'rm' }), { type: 'refresh' });
});

test('selectionChanged: node id or null, optional tab', () => {
  assert.deepEqual(validateWebviewMessage({ type: 'selectionChanged', nodeId: 'FR-01' }), { type: 'selectionChanged', nodeId: 'FR-01' });
  assert.deepEqual(validateWebviewMessage({ type: 'selectionChanged', nodeId: null, tab: 'cov' }), { type: 'selectionChanged', nodeId: null, tab: 'cov' });
  assert.deepEqual(validateWebviewMessage({ type: 'selectionChanged' }), { type: 'selectionChanged', nodeId: null });
  assert.deepEqual(
    validateWebviewMessage({ type: 'selectionChanged', nodeId: 'code:src/inventory/handler.ts', tab: 'trace', extra: 1 }),
    { type: 'selectionChanged', nodeId: 'code:src/inventory/handler.ts', tab: 'trace' }
  );
});

test('selectionChanged: bad node ids and tabs are refused', () => {
  for (const nodeId of [42, '', '   ', 'a\nb', 'a\u0000', 'x'.repeat(LIMITS.NODE_ID_MAX + 1), {}, ['FR-01']]) {
    assert.equal(validateWebviewMessage({ type: 'selectionChanged', nodeId }), null, JSON.stringify(nodeId));
  }
  assert.equal(validateWebviewMessage({ type: 'selectionChanged', nodeId: 'FR-01', tab: 'settings' }), null);
  assert.ok(validateWebviewMessage({ type: 'selectionChanged', nodeId: 'x'.repeat(LIMITS.NODE_ID_MAX) }));
});

test('openFile: a project-relative file is accepted and resolved to its real path', () => {
  assert.deepEqual(open('aidlc-docs/requirements.md'), {
    type: 'openFile',
    path: 'aidlc-docs/requirements.md',
    absPath: `${ROOT}/aidlc-docs/requirements.md`
  });
  assert.deepEqual(open('./aidlc-docs//requirements.md').path, 'aidlc-docs/requirements.md');
  assert.equal(open('aidlc-docs/requirements.md', { line: 12 }).line, 12);
});

test('openFile: an absolute path inside the root is accepted', () => {
  assert.equal(open(`${ROOT}/src/app.ts`).path, 'src/app.ts');
});

test('openFile: a name that only starts with two dots is not an escape', () => {
  assert.equal(open('..notes.md').path, '..notes.md');
});

test('openFile: only known fields come back; command-like extras are not passed through', () => {
  const out = open('src/app.ts', { command: 'workbench.action.terminal.new', args: ['x'], prompt: '/aidlc' });
  assert.deepEqual(Object.keys(out).sort(), ['absPath', 'path', 'type']);
});

test('openFile: bad line numbers are refused', () => {
  for (const line of [0, -1, 1.5, '3', NaN, LIMITS.LINE_MAX + 1]) {
    assert.equal(open('src/app.ts', { line }), null, String(line));
  }
});

test('openFile: no project root means nothing opens', () => {
  assert.equal(validateWebviewMessage({ type: 'openFile', path: 'src/app.ts' }), null);
  assert.equal(validateWebviewMessage({ type: 'openFile', path: 'src/app.ts' }, { projectRoot: undefined }), null);
  assert.equal(resolveProjectFile('relative/root', 'a.md', { path: path.posix, fs: null }), null);
  assert.equal(resolveProjectFile('', 'a.md', { path: path.posix, fs: null }), null);
});

// ---------------------------------------------------------------------------------------
// malformed input and unknown types

test('malformed envelopes are dropped', () => {
  class Msg { constructor() { this.type = 'refresh'; } }
  for (const raw of [undefined, null, 'refresh', 7, true, [], [{ type: 'refresh' }], {}, { type: 5 }, { type: null }, { kind: 'refresh' }, new Msg()]) {
    assert.equal(validateWebviewMessage(raw), null, String(raw));
  }
});

test('unknown types, including every host action the read-only viewer must never take, are dropped', () => {
  const ctx = posixCtx(baseFs);
  for (const type of [
    'openChat', 'save', 'requestLatest', 'runCommand', 'executeCommand', 'command', 'terminal', 'writeFile',
    'OPENFILE', 'openfile', ' openFile', 'setData', 'navigateTo', '__proto__', 'constructor', 'toString', 'hasOwnProperty', ''
  ]) {
    assert.equal(validateWebviewMessage({ type, path: 'src/app.ts', prompt: '/aidlc', command: 'x' }, ctx), null, type);
  }
});

test('a JSON-parsed __proto__ key does not confuse the validator', () => {
  const raw = JSON.parse('{"type":"refresh","__proto__":{"type":"openChat"}}');
  assert.deepEqual(validateWebviewMessage(raw), { type: 'refresh' });
});

// ---------------------------------------------------------------------------------------
// path escapes

test('openFile: .. segments are refused, even ones that land back inside the root', () => {
  for (const p of ['../outside.md', '../../etc/passwd', 'aidlc-docs/../../x', 'aidlc-docs/../src/app.ts', '..', 'src/..', `${ROOT}/../proj/src/app.ts`]) {
    assert.equal(open(p), null, p);
  }
});

test('openFile: absolute paths outside the root, and sibling folders sharing its prefix, are refused', () => {
  const fsImpl = fakeFs({ dirs: [ROOT], files: ['/etc/passwd', '/work/proj-evil/x.md', '/work/projx/a.md'] });
  for (const p of ['/etc/passwd', '/work/proj-evil/x.md', '/work/projx/a.md', '/work', '/']) {
    assert.equal(open(p, {}, fsImpl), null, p);
  }
});

test('openFile: the root itself and folders are refused (only files open)', () => {
  for (const p of ['.', './', ROOT, `${ROOT}/`, 'aidlc-docs']) {
    assert.equal(open(p), null, p);
  }
});

test('openFile: URIs, schemes, UNC and colon tricks are refused', () => {
  for (const p of [
    'file:///etc/passwd', 'command:workbench.action.terminal.new', 'vscode://file/etc/passwd',
    'https://example.com/x', 'kiroAgent.focusChatInput:', 'src/app.ts:1', 'C:\\Windows\\win.ini',
    '//server/share/x', '\\\\server\\share\\x'
  ]) {
    assert.equal(open(p), null, p);
  }
});

test('openFile: backslashes, control characters, empty, oversized and non-string paths are refused (POSIX)', () => {
  for (const p of ['src\\app.ts', '..\\..\\etc\\passwd', 'src/app.ts\u0000.png', 'src/app.ts\n', '', 'a/'.repeat(LIMITS.PATH_MAX), undefined, null, 7, ['src/app.ts'], { path: 'src/app.ts' }]) {
    assert.equal(open(p), null, JSON.stringify(p));
  }
});

test('openFile: missing files and dangling links are refused', () => {
  assert.equal(open('aidlc-docs/nope.md'), null);
  const fsImpl = fakeFs({ dirs: [ROOT], links: { [`${ROOT}/dangling.md`]: '/gone/x.md' } });
  assert.equal(open('dangling.md', {}, fsImpl), null);
});

test('openFile: a symlink inside the project pointing outside it is refused', () => {
  const fsImpl = fakeFs({
    dirs: [ROOT],
    files: ['/etc/passwd', '/home/me/.ssh/id_rsa'],
    links: {
      [`${ROOT}/innocent.md`]: '/etc/passwd',
      // a linked folder: everything below it resolves outside
      [`${ROOT}/docs/key.md`]: '/home/me/.ssh/id_rsa'
    }
  });
  assert.equal(open('innocent.md', {}, fsImpl), null);
  assert.equal(open('docs/key.md', {}, fsImpl), null);
});

test('openFile: a symlink that stays inside the project opens its target, not the link', () => {
  const fsImpl = fakeFs({
    dirs: [ROOT],
    files: [`${ROOT}/aidlc-docs/requirements.md`],
    links: { [`${ROOT}/latest.md`]: `${ROOT}/aidlc-docs/requirements.md` }
  });
  assert.deepEqual(open('latest.md', {}, fsImpl), { type: 'openFile', path: 'latest.md', absPath: `${ROOT}/aidlc-docs/requirements.md` });
});

test('openFile: a project root that is itself behind a symlink still works', () => {
  // e.g. /tmp -> /private/tmp on macOS
  const fsImpl = fakeFs({
    files: ['/real/proj/a.md', '/real/other.md'],
    links: { [ROOT]: '/real/proj', [`${ROOT}/a.md`]: '/real/proj/a.md', [`${ROOT}/up.md`]: '/real/other.md' }
  });
  assert.equal(open('a.md', {}, fsImpl).absPath, '/real/proj/a.md');
  assert.equal(open('up.md', {}, fsImpl), null, 'escapes the real root');
});

test('openFile: Windows paths (lexical check under path.win32)', () => {
  const ctx = { projectRoot: 'C:\\work\\proj', path: path.win32, fs: null };
  const ok = (p) => validateWebviewMessage({ type: 'openFile', path: p }, ctx);
  assert.equal(ok('aidlc-docs\\requirements.md').path, 'aidlc-docs/requirements.md');
  assert.equal(ok('aidlc-docs/requirements.md').path, 'aidlc-docs/requirements.md');
  assert.equal(ok('C:\\work\\proj\\src\\app.ts').path, 'src/app.ts');
  assert.equal(ok('c:\\WORK\\proj\\src\\app.ts').path, 'src/app.ts', 'drive and folder case do not matter on Windows');
  for (const p of ['D:\\x.md', 'C:\\work\\proj-evil\\x.md', '..\\x.md', 'a\\..\\..\\x.md', '\\\\server\\share\\x.md', '//server/share/x.md', 'a.md:stream', 'C:x.md', 'C:\\work\\proj\\a.md:secret']) {
    assert.equal(ok(p), null, p);
  }
});

test('openFile: against the real filesystem (read-only), with this package as the project root', () => {
  const root = path.resolve(__dirname, '..');
  const ctx = { projectRoot: root };
  const pkg = validateWebviewMessage({ type: 'openFile', path: 'package.json' }, ctx);
  assert.equal(pkg.path, 'package.json');
  assert.equal(pkg.absPath, fs.realpathSync(path.join(root, 'package.json')));
  assert.ok(validateWebviewMessage({ type: 'openFile', path: path.join(root, 'src', 'trace-explorer-protocol.js') }, ctx));
  assert.equal(validateWebviewMessage({ type: 'openFile', path: 'src' }, ctx), null, 'a folder');
  assert.equal(validateWebviewMessage({ type: 'openFile', path: 'no-such-file.md' }, ctx), null);
  assert.equal(validateWebviewMessage({ type: 'openFile', path: path.join(root, '..', 'AGENTS.md') }, ctx), null);
  assert.equal(validateWebviewMessage({ type: 'openFile', path: '../AGENTS.md' }, ctx), null);
});

// ---------------------------------------------------------------------------------------
// host -> webview builders

const sample = () => ({
  meta: { intent: '260825-inventory-api', warnings: [], omitted: [] },
  nodes: [{ id: 'FR-01', type: 'functional_requirement', label: 'List items' }],
  edges: [],
  reviews: [],
  jump: null,
  drift: []
});

test('buildSetDataMessage: a well-formed payload becomes setData with seq, reason and its size', () => {
  const r = buildSetDataMessage(sample(), { seq: 3, reason: 'file-change' });
  assert.equal(r.ok, true);
  assert.equal(r.message.type, 'setData');
  assert.equal(r.message.seq, 3);
  assert.equal(r.message.reason, 'file-change');
  assert.equal(r.message.protocol, 1);
  assert.deepEqual(r.message.data, sample());
  assert.equal(r.bytes, Buffer.byteLength(JSON.stringify(sample())));
  assert.deepEqual(JSON.parse(JSON.stringify(r.message)), r.message, 'round-trips through JSON unchanged');
  assert.deepEqual(validateHostMessage(r.message), r.message);
});

test('buildSetDataMessage: defaults are seq 0 and reason initial', () => {
  const r = buildSetDataMessage(sample());
  assert.equal(r.message.seq, 0);
  assert.equal(r.message.reason, 'initial');
});

test('buildSetDataMessage: the posted copy is plain data, detached from the original', () => {
  const data = sample();
  data.nodes[0].render = () => 'x';
  data.nodes[0].missing = undefined;
  const r = buildSetDataMessage(data);
  assert.equal(r.ok, true);
  assert.equal('render' in r.message.data.nodes[0], false);
  assert.equal('missing' in r.message.data.nodes[0], false);
  data.nodes[0].label = 'changed';
  assert.equal(r.message.data.nodes[0].label, 'List items');
});

test('buildSetDataMessage: wrong shape becomes dataError bad-shape', () => {
  for (const data of [undefined, null, [], 'x', { nodes: [] }, { nodes: {}, edges: [] }]) {
    const r = buildSetDataMessage(data);
    assert.equal(r.ok, false);
    assert.equal(r.message.type, 'dataError');
    assert.equal(r.message.code, 'bad-shape');
  }
});

test('buildSetDataMessage: cycles and BigInt become dataError not-serializable', () => {
  const cyclic = sample();
  cyclic.nodes[0].self = cyclic;
  assert.equal(buildSetDataMessage(cyclic, { seq: 2 }).message.code, 'not-serializable');
  assert.equal(buildSetDataMessage(cyclic, { seq: 2 }).message.seq, 2);
  const big = sample();
  big.meta.count = 10n;
  assert.equal(buildSetDataMessage(big).message.code, 'not-serializable');
});

test('buildSetDataMessage: the size guard refuses payloads over maxBytes', () => {
  const data = sample();
  const size = Buffer.byteLength(JSON.stringify(data));
  assert.equal(buildSetDataMessage(data, { maxBytes: size }).ok, true, 'exactly at the limit is allowed');
  const r = buildSetDataMessage(data, { maxBytes: size - 1, seq: 9 });
  assert.equal(r.ok, false);
  assert.equal(r.bytes, size);
  assert.equal(r.message.code, 'too-large');
  assert.equal(r.message.seq, 9);
  assert.match(r.message.message, new RegExp(String(size)));
  // multi-byte characters are counted as bytes, not string length
  const wide = sample();
  wide.nodes[0].label = '\u00e9'.repeat(100);
  const wideBytes = Buffer.byteLength(JSON.stringify(wide));
  assert.equal(buildSetDataMessage(wide, { maxBytes: JSON.stringify(wide).length }).ok, false);
  assert.equal(buildSetDataMessage(wide, { maxBytes: wideBytes }).ok, true);
  assert.equal(LIMITS.SET_DATA_MAX_BYTES, 8 * 1024 * 1024);
});

test('buildSetDataMessage: host programming errors throw', () => {
  assert.throws(() => buildSetDataMessage(sample(), { seq: -1 }), TypeError);
  assert.throws(() => buildSetDataMessage(sample(), { seq: 1.5 }), TypeError);
  assert.throws(() => buildSetDataMessage(sample(), { reason: 'poll' }), TypeError);
  assert.throws(() => buildSetDataMessage(sample(), { maxBytes: 0 }), TypeError);
});

test('buildDataErrorMessage: known codes kept, unknown become read-failed, long text truncated', () => {
  assert.deepEqual(buildDataErrorMessage('no-project', 'Open a folder first.', { seq: 4 }), {
    type: 'dataError', protocol: 1, seq: 4, code: 'no-project', message: 'Open a folder first.'
  });
  assert.equal(buildDataErrorMessage('boom', 'x').code, 'read-failed');
  assert.equal(buildDataErrorMessage('read-failed', 'x'.repeat(2000)).message.length, LIMITS.ERROR_MESSAGE_MAX);
  assert.equal(buildDataErrorMessage('read-failed', undefined).message, '');
  assert.equal(buildDataErrorMessage('read-failed', 'x', { seq: -3 }).seq, 0);
  assert.ok(validateHostMessage(buildDataErrorMessage('too-large', 'x')));
});

test('buildNavigateToMessage: node id and tab checked; trace by default', () => {
  assert.deepEqual(buildNavigateToMessage('FR-01'), { type: 'navigateTo', protocol: 1, nodeId: 'FR-01', tab: 'trace' });
  assert.equal(buildNavigateToMessage('BR-3', 'cov').tab, 'cov');
  assert.equal(buildNavigateToMessage(''), null);
  assert.equal(buildNavigateToMessage('FR-01\n'), null);
  assert.equal(buildNavigateToMessage(12), null);
  assert.equal(buildNavigateToMessage('FR-01', 'settings'), null);
});

test('validateHostMessage: accepts what the builders make and nothing else', () => {
  assert.deepEqual(validateHostMessage({ type: 'navigateTo', nodeId: 'FR-01' }), buildNavigateToMessage('FR-01'));
  for (const raw of [
    null, [], { type: 'openChat' }, { type: 'setContent', content: 'x' },
    { type: 'setData', reason: 'initial', data: null },
    { type: 'setData', reason: 'poll', data: sample() },
    { type: 'setData', reason: 'initial', seq: -1, data: sample() },
    { type: 'dataError', code: 'nope', message: 'x' },
    { type: 'dataError', code: 'read-failed', message: 5 },
    { type: 'navigateTo', nodeId: '' }
  ]) {
    assert.equal(validateHostMessage(raw), null, JSON.stringify(raw));
  }
});
