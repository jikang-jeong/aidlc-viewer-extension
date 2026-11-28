'use strict';

// The Trace Explorer's wiring in extension.js: the command, the tree row, the live
// reload from the watchers, and the close on deactivate.
//
// extension.js is loaded with `vscode` stubbed (as workspace-folder.test.js does) and
// with the panel module replaced by a recorder, so these tests pin what extension.js
// asks of the panel, not how the panel renders. The panel itself is covered by
// trace-explorer-panel.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const EXTENSION = path.join(ROOT, 'src', 'extension.js');
const PANEL = path.join(ROOT, 'src', 'trace-explorer-panel.js');
const { PROJECT_ROOT: FIXTURE } = require('./helpers/inventory-fixture');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CMD = 'markdownWatchViewer.showTraceExplorer';

const uri = (p) => ({ fsPath: p, toString: () => `file://${p}` });

function load() {
  const calls = { toasts: [], panel: [], watchers: [] };
  const panelStub = {
    open: false,
    createOrShow(context, opts) {
      calls.panel.push(['createOrShow', opts]);
      this.open = true;
    },
    scheduleReload(reason) {
      calls.panel.push(['scheduleReload', reason]);
      return true;
    },
    dispose() {
      calls.panel.push(['dispose']);
      this.open = false;
    },
    isOpen() {
      return this.open;
    },
    VIEW_TYPE: 'markdownWatchViewer.traceExplorer'
  };
  const emitter = () => {
    const handlers = [];
    const on = (h) => handlers.push(h);
    on.fire = (x) => handlers.forEach((h) => h(x));
    return on;
  };
  const vscodeStub = {
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    ThemeColor: class {},
    MarkdownString: class {},
    EventEmitter: class {
      constructor() {
        this.event = () => {};
        this.fire = () => {};
      }
    },
    FileType: {},
    RelativePattern: class {
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    ProgressLocation: {},
    Uri: { file: uri, from: (parts) => ({ ...parts, fsPath: parts.path }), joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    workspace: {
      workspaceFolders: [],
      fs: { stat: async () => ({ type: 2 }), readDirectory: async () => [] },
      createFileSystemWatcher(pattern, ignoreCreate, ignoreChange, ignoreDelete) {
        const w = {
          pattern: pattern.pattern,
          flags: [Boolean(ignoreCreate), Boolean(ignoreChange), Boolean(ignoreDelete)],
          onDidCreate: emitter(),
          onDidChange: emitter(),
          onDidDelete: emitter(),
          disposed: false,
          dispose() {
            this.disposed = true;
          }
        };
        calls.watchers.push(w);
        return w;
      }
    },
    window: {
      showInformationMessage: async (message) => {
        calls.toasts.push(message);
        return undefined;
      },
      showWarningMessage: async () => undefined
    },
    commands: { executeCommand: async () => undefined }
  };
  const realLoad = Module._load;
  Module._load = function stubbed(request, parent, ...rest) {
    if (request === 'vscode') return vscodeStub;
    if (request === './trace-explorer-panel') return panelStub;
    return realLoad.call(this, request, parent, ...rest);
  };
  try {
    const loaded = new Module(EXTENSION);
    loaded.filename = EXTENSION;
    loaded.paths = Module._nodeModulePaths(path.dirname(EXTENSION));
    loaded._compile(
      `${fs.readFileSync(EXTENSION, 'utf8')}\nmodule.exports = { WatchController, MarkdownTreeDataProvider, deactivate, isTraceInputPath, getWebviewHtml };`,
      EXTENSION
    );
    return { ...loaded.exports, calls, panelStub, vscodeStub };
  } finally {
    Module._load = realLoad;
  }
}

function memoryState() {
  const store = new Map();
  return {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    update: async (key, value) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
    keys: () => [...store.keys()]
  };
}

function controllerFor(WatchController, root) {
  const context = {
    extensionUri: uri(ROOT),
    workspaceState: memoryState(),
    globalState: memoryState(),
    subscriptions: []
  };
  const c = new WatchController(context);
  c.treeDataProvider.rootUri = root ? uri(root) : undefined;
  return c;
}

test('package.json declares the command as "AI-DLC: Trace Explorer", palette-gated to v2', () => {
  const decl = PKG.contributes.commands.find((c) => c.command === CMD);
  assert.ok(decl, 'command declared');
  assert.equal(`${decl.category}: ${decl.title}`, 'AI-DLC: Trace Explorer');
  const palette = PKG.contributes.menus.commandPalette.find((m) => m.command === CMD);
  assert.equal(palette && palette.when, 'aidlcViewer.v2Detected');
  assert.ok(PKG.activationEvents.includes(`onCommand:${CMD}`));
});

test('the panel module is required only by extension.js and does not gate on vscode.version', () => {
  const src = fs.readFileSync(EXTENSION, 'utf8');
  assert.match(src, /require\('\.\/trace-explorer-panel'\)/);
  assert.ok(!/vscode\.version/.test(fs.readFileSync(PANEL, 'utf8')));
});

test('the command opens the panel on the watched v2 project', async () => {
  const { WatchController, calls } = load();
  const c = controllerFor(WatchController, FIXTURE);
  await c.showTraceExplorer();
  assert.deepEqual(calls.panel, [['createOrShow', { projectRoot: FIXTURE }]]);
  assert.deepEqual(calls.toasts, []);
});

test('no folder: the usual folder prompt, no panel', async () => {
  const { WatchController, calls } = load();
  const c = controllerFor(WatchController, undefined);
  await c.showTraceExplorer();
  assert.deepEqual(calls.panel, []);
  assert.equal(calls.toasts.length, 1);
  assert.match(calls.toasts[0], /Open an AI-DLC project folder first/);
});

test('a folder without v2: a gentle message, no panel', async () => {
  const { WatchController, calls } = load();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-trace-none-'));
  const c = controllerFor(WatchController, empty);
  await c.showTraceExplorer();
  assert.deepEqual(calls.panel, []);
  assert.equal(calls.toasts.length, 1);
  assert.match(calls.toasts[0], /Trace Explorer reads an AI-DLC v2 project/);
});

test('the tree has a Trace Explorer row on v2, right after Usage, running the command', async () => {
  const { WatchController } = load();
  const c = controllerFor(WatchController, FIXTURE);
  const items = await c.treeDataProvider.getChildren();
  const labels = items.map((i) => i.label);
  const at = labels.indexOf('Trace Explorer');
  assert.ok(at > 0, `row present in ${labels.slice(0, 5).join(', ')}`);
  assert.equal(labels[at - 1], 'Usage');
  assert.equal(items[at].command.command, CMD);
  assert.equal(items[at].iconPath.id, 'type-hierarchy');
});

test('isTraceInputPath: aidlc/ and the harness directories only, never node_modules or .git', () => {
  const { isTraceInputPath } = load();
  const root = uri('/p');
  const is = (rel) => isTraceInputPath(root, uri(path.join('/p', rel)));
  assert.ok(is('aidlc/spaces/x/intents/i/inception/traceability.json'));
  assert.ok(is('aidlc/spaces/x/intents/i/.aidlc-engine/reviews/r.json'));
  assert.ok(is('aidlc/spaces/x/intents/i/runtime-graph.json'));
  assert.ok(is('.kiro/aidlc-common/stages/inception/a.md'));
  // The stage specs of a project configured for another tool (issue #5) live under its
  // own harness directory; a refresh there has to reach the panel like one under .kiro/.
  assert.ok(is('.claude/aidlc-common/stages/inception/a.md'));
  assert.ok(is('.codex/aidlc-common/stages/construction/b.md'));
  assert.ok(is('.aidlc/aidlc-common/stages/inception/a.md'));
  assert.ok(!is('.vscode/settings.json'));
  assert.ok(!is('src/index.ts'));
  assert.ok(!is('aidlc/node_modules/x.json'));
  assert.ok(!is('aidlc/.git/HEAD'));
  assert.ok(!is('README.md'));
  assert.ok(!isTraceInputPath(root, uri('/elsewhere/aidlc/a.json')));
});

test('watchers: JSON changes under aidlc/ reload an open panel and leave the tree alone', async () => {
  const { WatchController, calls, panelStub } = load();
  const c = controllerFor(WatchController, FIXTURE);
  c.primeKnownFiles = async () => {};
  c.refresh = () => {};
  let treeRefreshes = 0;
  c.scheduleRefresh = () => {
    treeRefreshes += 1;
  };
  await c.setWatchedFolder(uri(FIXTURE), { showMessage: false });
  try {
    const json = calls.watchers.find((w) => w.pattern === 'aidlc/**/*.json');
    assert.ok(json, 'a JSON watcher scoped to aidlc/');
    assert.deepEqual(json.flags, [true, false, true], 'changes only; create/delete come from the dir watcher');
    const md = calls.watchers.find((w) => w.pattern === '**/*.md');
    const reloads = () => calls.panel.filter((x) => x[0] === 'scheduleReload').length;
    const tj = uri(path.join(FIXTURE, 'aidlc', 'spaces', 's', 'intents', 'i', 'construction', 'traceability.json'));

    // Panel closed: nothing.
    json.onDidChange.fire(tj);
    assert.equal(reloads(), 0);

    panelStub.open = true;
    json.onDidChange.fire(tj);
    assert.equal(reloads(), 1);
    assert.deepEqual(calls.panel.at(-1), ['scheduleReload', 'file-change']);
    assert.equal(treeRefreshes, 0, 'a JSON change does not refresh the tree');

    // A review record under the engine's dot-folder reloads the panel, though the tree ignores it.
    md.onDidChange.fire(uri(path.join(FIXTURE, 'aidlc', 'spaces', 's', 'intents', 'i', '.aidlc-engine', 'reviews', 'r.md')));
    assert.equal(reloads(), 2);
    assert.equal(treeRefreshes, 0);

    // A source file outside aidlc/: tree refresh as before, no panel reload.
    md.onDidChange.fire(uri(path.join(FIXTURE, 'docs', 'notes.md')));
    assert.equal(reloads(), 2);
    assert.equal(treeRefreshes, 1);
  } finally {
    c.dispose();
  }
  assert.ok(calls.watchers.every((w) => w.disposed), 'every watcher, the JSON one included, is disposed');
});

test('switching the watched folder closes a panel showing the old one', async () => {
  const { WatchController, calls } = load();
  const c = controllerFor(WatchController, FIXTURE);
  c.primeKnownFiles = async () => {};
  c.refresh = () => {};
  await c.showTraceExplorer();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-trace-other-'));
  await c.setWatchedFolder(uri(FIXTURE), { showMessage: false });
  assert.ok(!calls.panel.some((x) => x[0] === 'dispose'), 'same folder keeps the panel');
  await c.setWatchedFolder(uri(other), { showMessage: false });
  assert.ok(calls.panel.some((x) => x[0] === 'dispose'));
  c.dispose();
});

test('deactivate closes the panel', () => {
  const { deactivate, calls } = load();
  deactivate();
  assert.deepEqual(calls.panel, [['dispose']]);
});

// ---------------------------------------------------------------------------
// openFile(item, { viewColumn, line }): the Trace Explorer's markdown links open the
// rendered viewer beside the panel, scrolled to the line. Tree clicks are unchanged.
// ---------------------------------------------------------------------------

// The stubbed vscode is the object the loaded module holds, so it is extended in place.
function loadWithStub() {
  const loadedExt = load();
  const c = controllerFor(loadedExt.WatchController, FIXTURE);
  return { ...loadedExt, c, created: [], VC: { One: 1, Beside: -2 } };
}

function withViewerStubs(h) {
  const vscodeStub = h.vscodeStub;
  vscodeStub.ViewColumn = h.VC;
  vscodeStub.window.createWebviewPanel = (viewType, title, column) => {
    const panel = {
      viewType,
      column,
      reveals: [],
      posted: [],
      webview: {
        html: '',
        cspSource: 'x',
        asWebviewUri: (u) => ({ toString: () => String(u.fsPath || u) }),
        onDidReceiveMessage: () => {},
        postMessage(m) {
          panel.posted.push(m);
          return Promise.resolve(true);
        }
      },
      reveal(...args) {
        panel.reveals.push(args);
      },
      onDidDispose: () => {}
    };
    h.created.push(panel);
    return panel;
  };
  h.c.markFileOpened = async () => {};
  h.c.getJourneyPayload = async () => null;
  h.vscodeStub.workspace.fs.readFile = async (u) => fs.readFileSync(u.fsPath);
}

test('openFile: a tree click still opens in ViewColumn.One', async () => {
  const h = loadWithStub();
  withViewerStubs(h);
  const item = { type: 'file', resourceUri: uri(path.join(FIXTURE, 'AGENTS.md')) };
  await h.c.openFile(item);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].column, h.VC.One);
  assert.doesNotMatch(h.created[0].webview.html, /let pendingSourceLine = [1-9]/);
  await h.c.openFile(item);
  assert.deepEqual(h.created[0].reveals, [[h.VC.One]], 'an open viewer is revealed in One');
  assert.deepEqual(h.created[0].posted.filter((m) => m.type === 'scrollToLine'), []);
});

test("openFile: { viewColumn: 'beside', line } opens beside, focused, scrolled to the line", async () => {
  const h = loadWithStub();
  withViewerStubs(h);
  const item = { type: 'file', resourceUri: uri(path.join(FIXTURE, 'AGENTS.md')) };
  await h.c.openFile(item, { viewColumn: 'beside', line: 12 });
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.created[0].column, { viewColumn: h.VC.Beside, preserveFocus: false });
  assert.match(h.created[0].webview.html, /let pendingSourceLine = 12;/, 'the new viewer scrolls once rendered');
  // Already open: revealed beside, and told to scroll.
  await h.c.openFile(item, { viewColumn: h.VC.Beside, line: 30 });
  assert.deepEqual(h.created[0].reveals, [[h.VC.Beside, false]]);
  assert.deepEqual(h.created[0].posted.at(-1), { type: 'scrollToLine', line: 30 });
  // A junk line is ignored rather than posted.
  await h.c.openFile(item, { viewColumn: 'beside', line: '9; alert(1)' });
  assert.equal(h.created[0].posted.filter((m) => m.type === 'scrollToLine').length, 1);
});

test('the openFile command forwards its second argument', () => {
  const src = fs.readFileSync(EXTENSION, 'utf8');
  assert.match(src, /registerCommand\('markdownWatchViewer\.openFile', \(item, options\) => controller\.openFile\(item, options\)\)/);
});

// The renderer, run against the real markdown-it bundles (as renderer.test.js does).
function loadRenderer() {
  const { getWebviewHtml } = load();
  const html = getWebviewHtml({ cspSource: 'x', asWebviewUri: (u) => ({ toString: () => String(u.fsPath) }) }, { fsPath: '/p/doc.md' }, '', { fsPath: '/ext' }, undefined);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const start = script.indexOf('      function markdownRenderer()');
  const end = script.indexOf('      function escapeHtml(value)');
  const endOfEscape = script.indexOf('\n      }\n', end) + '\n      }\n'.length;
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const f of ['markdown-it.min.js', 'markdown-it-task-lists.min.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'media', f), 'utf8'), sandbox);
  }
  sandbox.window.markdownit = sandbox.window.markdownit || sandbox.markdownit;
  sandbox.window.markdownitTaskLists = sandbox.window.markdownitTaskLists || sandbox.markdownitTaskLists;
  vm.runInContext(script.slice(start, endOfEscape) + '\nthis.render = markdownToHtml;', sandbox);
  return sandbox.render;
}

test('renderer: block elements carry their 1-based source line, only when asked', () => {
  const render = loadRenderer();
  const src = '# Title\n\nPara one\ncontinues.\n\n- a\n- b\n\n```js\nx\n```\n\n| h |\n|---|\n| c |\n';
  assert.doesNotMatch(render(src), /data-source-line/, 'the default render is unchanged');
  const html = render(src, { sourceLines: true });
  assert.match(html, /<h1 data-source-line="1">Title<\/h1>/);
  assert.match(html, /<p data-source-line="3">Para one/);
  assert.match(html, /<ul data-source-line="6">\s*<li data-source-line="6">a<\/li>\s*<li data-source-line="7">b/);
  assert.match(html, /<code[^>]*data-source-line="9"/);
  assert.match(html, /<table data-source-line="13">\s*<thead>\s*<tr>/, 'rows and cells stay bare');
});

test('renderer: a multi-line comment does not shift the lines after it', () => {
  const render = loadRenderer();
  const src = 'Intro.\n\n<!--\none\ntwo\n-->\n\n## After\n';
  const html = render(src, { sourceLines: true });
  assert.match(html, /<h2 data-source-line="8">After<\/h2>/);
});

test('the viewer handles scrollToLine and scrolls to the block that starts at or before it', () => {
  const src = fs.readFileSync(EXTENSION, 'utf8');
  assert.match(src, /msg\.type === 'scrollToLine'/);
  assert.match(src, /function scrollToSourceLine\(line\)/);
  assert.match(src, /markdownToHtml\(source, \{ sourceLines: true \}\)/);
});
