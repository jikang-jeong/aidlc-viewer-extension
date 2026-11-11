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

function renderHtml(markdown, journey) {
  const getWebviewHtml = loadGetWebviewHtml();
  const webview = { cspSource: 'vscode-resource:', asWebviewUri: (u) => ({ toString: () => String(u) }) };
  return getWebviewHtml(webview, { fsPath: '/p/doc.md' }, markdown, { fsPath: '/ext' }, journey);
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
      replaceChildren(...kids) { node.children = kids; },
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

// The Markdown renderer the webview loads from media/, the shipped bundles themselves,
// so what these tests render is what the viewer renders. Evaluated once per process.
const MEDIA = path.join(__dirname, '..', 'media');
const RENDERER_BUNDLES = ['markdown-it.min.js', 'markdown-it-task-lists.min.js'].map((f) =>
  fs.readFileSync(path.join(MEDIA, f), 'utf8')
);

function runViewerScript(markdown, state = {}, journey) {
  const html = renderHtml(markdown, journey);
  // The first INLINE script: the external <script src> tags before it are the renderer
  // bundles, which are loaded into the sandbox below rather than fetched.
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const dom = makeDom(html);
  const posted = [];
  let stored = { ...state };
  const sandbox = {
    document: dom.document,
    window: { addEventListener() {}, devicePixelRatio: 1 },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => stored, setState: (s) => { stored = s; } }),
    mermaid: { initialize() {}, run: async () => {}, render: async () => ({ svg: '' }) },
    requestAnimationFrame: (fn) => fn(),
    getComputedStyle: () => ({ lineHeight: '20px' }),
    setTimeout: (fn) => fn(),
    clearTimeout() {},
    console
  };
  sandbox.window.document = dom.document;
  vm.createContext(sandbox);
  // The UMD bundles attach to globalThis; the viewer script reads them off `window`.
  for (const bundle of RENDERER_BUNDLES) vm.runInContext(bundle, sandbox);
  // (markdown-it attaches to globalThis, the task-lists plugin to `window` when it exists.)
  sandbox.window.markdownit = sandbox.window.markdownit || sandbox.markdownit;
  sandbox.window.markdownitTaskLists = sandbox.window.markdownitTaskLists || sandbox.markdownitTaskLists;
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

// ---------------------------------------------------------------------------
// Keeping your place across a mode switch
// ---------------------------------------------------------------------------
//
// The two panes have different heights, so a scroll RATIO copied from one to the other
// lands on different text -- the old sync did that, and Edit "jumped a little". And a
// textarea that was display:none has no layout in the tick it becomes visible, so a
// scrollTop set then is dropped -- double-click "went to the top". Both are now done by
// text: the block at the top of the pane being left is found in the pane being entered,
// after the browser has laid it out.

function blocks(dom, list) {
  // list: [{ text, top, bottom }] in document order, relative to the preview scroller.
  const nodes = list.map((b) => ({
    textContent: b.text,
    getBoundingClientRect: () => ({ top: b.top, bottom: b.bottom })
  }));
  dom.elements.get('preview').querySelectorAll = () => nodes;
  dom.elements.get('previewScroll').getBoundingClientRect = () => ({ top: 0, bottom: 500 });
  dom.elements.get('previewScroll').clientHeight = 500;
}

test('Edit opens on the text that was at the top of the view, not at a scroll ratio', () => {
  const md = 'L1 intro paragraph text here\n\n' + 'filler line of text\n\n'.repeat(40) + 'The anchor paragraph I was reading.\n\n' + 'more\n'.repeat(10);
  const { dom } = runViewerScript(md);
  // The view is scrolled so that "The anchor paragraph" is the first visible block.
  blocks(dom, [
    { text: 'L1 intro paragraph text here', top: -900, bottom: -880 },
    { text: 'The anchor paragraph I was reading.', top: 2, bottom: 22 },
    { text: 'more', top: 30, bottom: 50 }
  ]);
  dom.fire('modeEdit', 'click');
  const editor = dom.elements.get('editor');
  assert.equal(editor.selectionStart, md.indexOf('The anchor paragraph'));
  assert.ok(editor.scrollTop > 0, 'the textarea scrolled to the anchor');
});

test('View returns to the text that was at the top of the editor', () => {
  const md = 'top\n' + 'x\n'.repeat(30) + 'Deep in the file is this sentence.\n' + 'y\n'.repeat(30);
  const { dom } = runViewerScript(md);
  dom.fire('modeEdit', 'click');
  const editor = dom.elements.get('editor');
  // Editor scrolled to line ~31 (lineHeight 20px in the stub).
  editor.scrollTop = 31 * 20;
  let scrolledTo;
  const ps = dom.elements.get('previewScroll');
  Object.defineProperty(ps, 'scrollTop', { get: () => 0, set: (v) => { scrolledTo = v; }, configurable: true });
  blocks(dom, [
    { text: 'top', top: 0, bottom: 20 },
    { text: 'Deep in the file is this sentence.', top: 900, bottom: 920 }
  ]);
  dom.fire('modeRead', 'click');
  assert.ok(typeof scrolledTo === 'number' && scrolledTo > 0, 'the view scrolled to the anchor block');
});

test('restoring the remembered mode on open computes no anchor, so nothing is read before it exists', () => {
  // previewScroll is declared after the restore call; reading it there threw at load and
  // blanked the viewer. Caught by executing the script, not by reading it.
  assert.doesNotThrow(() => runViewerScript('# T', { mode: 'edit' }));
  assert.doesNotThrow(() => runViewerScript('# T', { mode: 'read' }));
});

test('a Markdown table renders as rows, which pins the escaping inside the template literal', () => {
  // The webview script lives inside a template literal, which unescapes once before the
  // browser sees it. A split on '\\\\n' in source reached the browser as a split on the
  // two characters backslash-n, so a table collapsed into one line. It had been that
  // way; the new mode-switch code copied the pattern and the executing tests caught both.
  const md = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n';
  const { dom } = runViewerScript(md);
  const html = dom.elements.get('preview').innerHTML;
  const rows = (html.match(/<tr>/g) || []).length;
  assert.ok(rows >= 3, `expected a header row and two body rows, got ${rows} in: ${html.slice(0, 200)}`);
});


// ---------------------------------------------------------------------------
// Before anything has run
// ---------------------------------------------------------------------------
//
// A freshly set-up project has no position to show. The strip used to hide; it now
// says "Not started" and what to type, because that is the question for the next
// several minutes and a toast is gone in seconds.

test('with a not-started payload the strip shows the hint instead of hiding', () => {
  const { dom } = runViewerScript('# T', {}, { notStarted: true, hint: 'Type /aidlc followed by what you want to build.' });
  const strip = dom.elements.get('journey');
  assert.equal(strip.hidden, false);
  assert.ok(strip.classList.contains('not-started'));
  const texts = (dom.elements.get('jCollapsed').children || []).map((c) => c.textContent);
  assert.deepEqual(texts, ['Not started', 'Type /aidlc followed by what you want to build.']);
  // Clicking it does not expand: there is no stage list yet.
  dom.fire('journey', 'click');
  assert.ok(!strip.classList.contains('expanded'));
});

test('with no payload at all the strip stays hidden, as before', () => {
  const { dom } = runViewerScript('# T', {}, undefined);
  assert.equal(dom.elements.get('journey').hidden, true);
});

// ---------------------------------------------------------------------------
// HTML comments, and what the document may contain
// ---------------------------------------------------------------------------

test('HTML comments render dimmed, with their markup escaped', () => {
  // AI-DLC artifacts carry instructions to the agent in comments. A Markdown renderer
  // drops them; this one used to escape them into body text. Shown dimmed instead, so
  // a person sees what the file tells the agent without it reading as the document.
  const { dom } = runViewerScript('# T\n\n<!-- Things agents must never do -->\n\nBody <!-- inline --> text.\n\n<!-- <script>alert(1)</script> -->\n');
  const html = dom.elements.get('preview').innerHTML;
  assert.match(html, /<span class="md-comment">&lt;!-- Things agents must never do --&gt;<\/span>/);
  assert.match(html, /Body <span class="md-comment">&lt;!-- inline --&gt;<\/span> text\./);
  // A comment is not a place to smuggle markup.
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a document that mentions </script> still loads the viewer', () => {
  // JSON.stringify leaves "</script>" intact, and inside the inline <script> that ended
  // the script early: the viewer never started. Found by the comment test's fixture.
  const { dom } = runViewerScript('See </script> in prose, and <!-- </script> --> in a comment.\n');
  assert.ok(dom.elements.get('editor').value.includes('</script> in prose'), 'the source survived intact');
  assert.match(dom.elements.get('preview').innerHTML, /&lt;\/script&gt; in prose/);
});

// ---------------------------------------------------------------------------
// The viewer's colours are the theme's
// ---------------------------------------------------------------------------

test('the viewer stylesheet hard-codes no colour: every one is a theme variable with a fallback', () => {
  // Reported from a light theme: red headings and red code on a grey chip, nearly the
  // text colour. The palette was One Dark's, fixed, and read fine only on a dark
  // background. Every colour now comes from a token the theme defines for its own
  // background. A hex value is allowed only as the fallback inside var(..., #fallback),
  // so a theme that defines no such token still renders as before.
  const html = renderHtml('# T');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const offenders = css
    .split('\n')
    .map((l, i) => ({ i: i + 1, l: l.trim() }))
    .filter(({ l }) => /#[0-9a-fA-F]{3,8}\b/.test(l))
    // Strip every var(--x, #fallback) and see whether a hex survives outside one.
    .filter(({ l }) => /#[0-9a-fA-F]{3,8}\b/.test(l.replace(/var\(--[a-zA-Z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/g, '')));
  assert.deepEqual(offenders, [], 'hex colours outside a var() fallback');
  // The tokens it leans on are VS Code's text-rendering tokens, which every theme sets.
  for (const token of ['--vscode-terminal-ansiRed', '--vscode-textLink-foreground', '--vscode-textBlockQuote-border']) {
    assert.ok(css.includes(token), `${token} is used`);
  }
  // Not textPreformat-foreground for inline code: Kiro Light defines it at 2.8:1
  // against its own page, grey on light grey. The ANSI palette is defined for
  // legibility on both backgrounds.
  assert.ok(!css.includes('--vscode-textPreformat-foreground'), 'inline code does not take the low-contrast preformat token');
});
