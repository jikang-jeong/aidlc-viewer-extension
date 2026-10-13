'use strict';

// Pins the single-pane viewer: one rendered view with an Edit mode in the same space.
//
// The split view -- raw Markdown left, rendering right -- was replaced because it showed
// everything twice and left room for neither; the complaint was having to edit in one
// pane while reading in the other. What replaced it is one pane and a mode toggle. These
// tests pin the two properties that make that safe for six thousand people's files:
//
//   1. The source is never rewritten from the rendering. Edit mode shows the SAME
//      textarea the split view always saved from, so what a person types is what is
//      saved, byte for byte. A view that round-tripped rendered HTML back to Markdown
//      would silently alter lists, tables and Mermaid blocks -- the worst kind of bug.
//   2. Nothing in the script references the removed splitter. A stale reference would
//      throw on load and leave the viewer blank with no error a user could see.
//
// The webview HTML is compiled with vscode stubbed and the script is executed against a
// minimal DOM, so the wiring is tested rather than inferred from the source text.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');

const EXTENSION = path.join(__dirname, '..', 'src', 'extension.js');

function loadGetWebviewHtml() {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return {
        Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }), joinPath: (...a) => ({ fsPath: a.join('/'), toString: () => a.join('/') }) },
        window: {},
        workspace: { fs: {} },
        commands: {},
        EventEmitter: class { constructor() { this.event = () => {}; this.fire = () => {}; } },
        TreeItem: class { constructor(v) { this.value = v; } },
        TreeItemCollapsibleState: {},
        ThemeIcon: class {},
        ThemeColor: class {},
        MarkdownString: class { constructor(v) { this.value = v; } },
        FileType: {},
        RelativePattern: class {},
        ProgressLocation: {}
      };
    }
    return realLoad(request, parent, isMain);
  };
  try {
    const loaded = new Module(EXTENSION);
    loaded.filename = EXTENSION;
    loaded.paths = Module._nodeModulePaths(path.dirname(EXTENSION));
    loaded._compile(`${fs.readFileSync(EXTENSION, 'utf8')}\nmodule.exports = { getWebviewHtml };`, EXTENSION);
    return loaded.exports.getWebviewHtml;
  } finally {
    Module._load = realLoad;
  }
}

function renderHtml(markdown) {
  const getWebviewHtml = loadGetWebviewHtml();
  const webview = { cspSource: 'vscode-resource:', asWebviewUri: (u) => ({ toString: () => String(u) }) };
  return getWebviewHtml(webview, { fsPath: '/p/doc.md' }, markdown, { fsPath: '/ext' }, undefined);
}

// A DOM small enough to read, large enough for the viewer script's event wiring.
function makeDom(html) {
  const elements = new Map();
  const listeners = new Map();
  function el(id, extra = {}) {
    const classes = new Set();
    const attrs = {};
    const node = {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      style: { setProperty() {}, removeProperty() {}, transform: '', transformOrigin: '' },
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        toggle: (c, force) => { if (force === undefined) force = !classes.has(c); force ? classes.add(c) : classes.delete(c); return force; },
        contains: (c) => classes.has(c)
      },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k],
      addEventListener: (type, fn) => { const key = `${id}:${type}`; (listeners.get(key) ?? listeners.set(key, []).get(key)).push(fn); },
      removeEventListener() {},
      focus() { node.focused = true; },
      setSelectionRange(a, b) { node.selectionStart = a; node.selectionEnd = b; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild() {},
      scrollTop: 0, scrollHeight: 1000, clientHeight: 500,
      ...extra
    };
    elements.set(id, node);
    return node;
  }
  for (const id of ['editor', 'preview', 'status', 'reload', 'save', 'zoomOut', 'zoomIn', 'zoomLevel', 'previewScroll', 'journey', 'jCollapsed', 'jExpanded', 'modeRead', 'modeEdit']) el(id);
  const body = el('body');
  const shell = el('shell');
  const actions = el('actions');
  const document = {
    body,
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: (sel) => (sel === '.shell' ? shell : sel === '.actions' ? actions : sel === '.pane.single' ? shell : null),
    querySelectorAll: () => [],
    createElement: () => el(`anon-${Math.random()}`),
    addEventListener: (type, fn) => { const key = `document:${type}`; (listeners.get(key) ?? listeners.set(key, []).get(key)).push(fn); }
  };
  const fire = (id, type, event = {}) => { for (const fn of listeners.get(`${id}:${type}`) ?? []) fn({ preventDefault() {}, ...event }); };
  return { document, elements, listeners, fire, body, html };
}

function runViewerScript(markdown, state = {}) {
  const html = renderHtml(markdown);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const dom = makeDom(html);
  const posted = [];
  let stored = { ...state };
  const sandbox = {
    document: dom.document,
    window: { addEventListener() {}, devicePixelRatio: 1 },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => stored, setState: (s) => { stored = s; } }),
    marked: { parse: (s) => `<p>${s}</p>`, setOptions() {}, use() {} },
    mermaid: { initialize() {}, run: async () => {}, render: async () => ({ svg: '' }) },
    DOMPurify: { sanitize: (s) => s },
    requestAnimationFrame: (fn) => fn(),
    getComputedStyle: () => ({ lineHeight: '20px' }),
    setTimeout: (fn) => fn(),
    clearTimeout() {},
    console
  };
  sandbox.window.document = dom.document;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { dom, posted, state: () => stored };
}

test('the viewer script loads with the splitter gone, so no stale reference blanks the view', () => {
  // A leftover getElementById('splitter').addEventListener would throw at load and
  // leave a blank panel with no error the user can see. The script is executed, not
  // grepped, so this fails the way a user would experience it.
  assert.doesNotThrow(() => runViewerScript('# Hello'));
});

test('Read is the default mode, and Edit swaps the same pane rather than opening another', () => {
  const { dom } = runViewerScript('# Hello');
  assert.equal(dom.body.classList.contains('editing'), false);
  assert.equal(dom.elements.get('modeRead').classList.contains('active'), true);
  dom.fire('modeEdit', 'click');
  assert.equal(dom.body.classList.contains('editing'), true);
  assert.equal(dom.elements.get('modeEdit').getAttribute('aria-selected'), 'true');
  assert.equal(dom.elements.get('modeRead').getAttribute('aria-selected'), 'false');
  dom.fire('modeRead', 'click');
  assert.equal(dom.body.classList.contains('editing'), false);
});

test('what is saved is the textarea, byte for byte -- never the rendering turned back into Markdown', () => {
  // The one property that makes a single-pane editor safe. Content that a rendered
  // round-trip would mangle -- a Mermaid fence, a nested list, a table -- must come
  // back exactly as typed.
  const tricky = '# T\n\n```mermaid\ngraph TD; A-->B\n```\n\n- a\n  - b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n';
  const { dom, posted } = runViewerScript(tricky);
  const editor = dom.elements.get('editor');
  assert.equal(editor.value, tricky, 'the editor holds the source verbatim');
  dom.fire('modeEdit', 'click');
  editor.value = tricky + 'appended\n';
  dom.fire('save', 'click');
  const save = posted.find((m) => m.type === 'save');
  assert.ok(save, 'save must post to the extension');
  assert.equal(save.content, tricky + 'appended\n');
});

test('the mode is remembered, so reopening lands where the person left', () => {
  const { dom, state } = runViewerScript('# Hello');
  dom.fire('modeEdit', 'click');
  assert.equal(state().mode, 'edit');
  const reopened = runViewerScript('# Hello', state());
  assert.equal(reopened.dom.body.classList.contains('editing'), true);
});

test('Ctrl/Cmd+E toggles the mode, and plain E does not', () => {
  const { dom } = runViewerScript('# Hello');
  dom.fire('document', 'keydown', { key: 'e', ctrlKey: true });
  assert.equal(dom.body.classList.contains('editing'), true);
  dom.fire('document', 'keydown', { key: 'e' });
  assert.equal(dom.body.classList.contains('editing'), true, 'plain e must not toggle');
  dom.fire('document', 'keydown', { key: 'E', metaKey: true });
  assert.equal(dom.body.classList.contains('editing'), false);
});

test('the markup carries one pane and no splitter', () => {
  const html = renderHtml('# Hello');
  assert.equal(/class="splitter"/.test(html), false);
  assert.equal(/class="pane raw"/.test(html), false);
  assert.equal(/class="pane preview-pane"/.test(html), false);
  assert.match(html, /class="pane single"/);
  assert.match(html, /id="modeRead"/);
  assert.match(html, /id="modeEdit"/);
  // The textarea still exists -- it is the save path -- and starts hidden.
  assert.match(html, /<textarea id="editor"[^>]*hidden/);
});

// ---------------------------------------------------------------------------
// Double-click to edit, save to view
// ---------------------------------------------------------------------------

function blockTarget(text) {
  // A rendered block the person double-clicked: closest() finds itself for block
  // selectors and nothing for the excluded ones.
  return {
    textContent: text,
    closest: (sel) => (/^a, svg/.test(sel) ? null : /p, li/.test(sel) ? { textContent: text } : null)
  };
}

test('double-clicking a block switches to Edit with the cursor at that block\'s source', () => {
  const md = '# Title\n\nFirst paragraph here.\n\nSecond paragraph, the one I want.\n';
  const { dom } = runViewerScript(md);
  dom.fire('preview', 'dblclick', { target: blockTarget('Second paragraph, the one I want.') });
  assert.equal(dom.body.classList.contains('editing'), true);
  const editor = dom.elements.get('editor');
  assert.equal(editor.selectionStart, md.indexOf('Second paragraph'));
});

test('double-clicking a link, diagram or code block does not switch modes', () => {
  // A double-click there usually means "select this", not "edit here".
  const { dom } = runViewerScript('# T\n\n[x](y)\n');
  const linkTarget = { textContent: 'x', closest: (sel) => (/^a, svg/.test(sel) ? {} : null) };
  dom.fire('preview', 'dblclick', { target: linkTarget });
  assert.equal(dom.body.classList.contains('editing'), false);
});

test('a block whose text is not found in the source still opens Edit, at the top', () => {
  // The renderer may have changed the text (an image alt, a diagram caption). Edit
  // still opens; the cursor just has nowhere specific to go.
  const { dom } = runViewerScript('# T\n\nbody\n');
  dom.fire('preview', 'dblclick', { target: blockTarget('text that is not in the source') });
  assert.equal(dom.body.classList.contains('editing'), true);
  assert.equal(dom.elements.get('editor').selectionStart, undefined);
});

test('saving from Edit returns to View; saving from View stays in View', () => {
  const { dom, posted } = runViewerScript('# T\n');
  dom.fire('modeEdit', 'click');
  dom.elements.get('editor').value = '# T\n\nmore\n';
  dom.fire('save', 'click');
  assert.equal(dom.body.classList.contains('editing'), false, 'save ends the edit');
  assert.equal(posted.filter((m) => m.type === 'save').length, 1);
  dom.fire('save', 'click');
  assert.equal(dom.body.classList.contains('editing'), false);
});

test('the mode buttons read View and Edit, each with an icon', () => {
  const html = renderHtml('# T');
  assert.match(html, /id="modeRead"[^>]*>\u{1F50D} View</u);
  assert.match(html, /id="modeEdit"[^>]*>\u270E Edit</);
});
