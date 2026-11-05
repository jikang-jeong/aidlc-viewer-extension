'use strict';

// Any AI-DLC in the folder means no setup, from any entry point, decided when acting.
//
// From a customer workshop. The presenter had people install the engine with the
// upstream install.sh and configure the project by hand with `aidlc config`. The order
// on screen was: pick the folder in the viewer (the setup toast appears; the folder is
// still empty), run `aidlc config` in a terminal, then press the toast's v2 button. The
// toast had buttons, so it was still there. Setup ran over the configured project,
// asked Kiro IDE or Kiro CLI again -- the "recorded harness" guard had been dead since
// 0.0.25 moved the install to the engine, which writes no receipt for it to read -- and
// the other answer switched the harness: `/aidlc` gone, hooks replaced. Reproduced here
// against the real engine: 18 files deleted, 18 added, 31 changed. The same stale toast's
// v1 button would have produced a project with both generations, which cannot work.
//
// The rule now: the extension sets up projects with no AI-DLC and never writes into one
// that has any. Upgrades and harness changes are the engine's (`aidlc config`), and
// the refusal says so. The test is at the moment of acting, so a toast that outlived the
// folder's state cannot act on it. These tests run the real WatchController methods
// (aidlcSetupNeeded through offerAidlcSetup, runSetup) with `vscode` stubbed and the
// installer module intercepted so a call to it is recorded, never executed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const EXTENSION = path.join(__dirname, '..', 'src', 'extension.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function makeV2(root) {
  fs.mkdirSync(path.join(root, '.kiro', 'tools', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kiro', 'tools', 'data', 'stage-graph.json'), '{}');
}
function makeV1(root) {
  fs.mkdirSync(path.join(root, 'aidlc-docs'), { recursive: true });
}

// Load extension.js with `vscode` stubbed and `./install-commands` replaced by a recorder.
// `answers` scripts the toasts in order: each showInformationMessage with buttons pops the
// next. A toast with buttons stays on screen until pressed, so its promise is held: the
// test calls `calls.release()` to press the button, after doing whatever happens on the
// machine in between.
function load({ answers = [] } = {}) {
  const calls = { toasts: [], setup: [], release: undefined };
  const queue = [...answers];
  const uri = (p) => ({ fsPath: p, toString: () => `file://${p}` });
  const stub = {
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {},
    ThemeColor: class {},
    MarkdownString: class {},
    EventEmitter: class {
      constructor() {
        this.event = () => {};
        this.fire = () => {};
      }
    },
    FileType: {},
    RelativePattern: class {},
    ProgressLocation: {},
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    workspace: { workspaceFolders: [], fs: { stat: async () => ({ type: 2 }) } },
    window: {
      showInformationMessage: (message, ...buttons) => {
        calls.toasts.push({ message, buttons });
        if (!buttons.length) return Promise.resolve(undefined);
        return new Promise((resolve) => {
          calls.release = () => {
            calls.release = undefined;
            resolve(queue.shift());
          };
        });
      },
      showWarningMessage: async () => undefined,
      showErrorMessage: async (message) => {
        calls.toasts.push({ message, buttons: [], error: true });
      }
    },
    commands: { executeCommand: async () => undefined }
  };
  const installer = {
    setup: async (folderUri, installV1, preselected) => {
      calls.setup.push({ path: folderUri.fsPath, preselected });
    },
    checkV2: async () => {},
    removeV2: async () => {}
  };
  const realLoad = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (request === 'vscode') return stub;
    if (request === './install-commands') return installer;
    return realLoad.call(this, request, ...rest);
  };
  try {
    const loaded = new Module(EXTENSION);
    loaded.filename = EXTENSION;
    loaded.paths = Module._nodeModulePaths(path.dirname(EXTENSION));
    loaded._compile(
      `${fs.readFileSync(EXTENSION, 'utf8')}\nmodule.exports = { WatchController, aidlcSetupNeeded };`,
      EXTENSION
    );
    return { ...loaded.exports, calls };
  } finally {
    Module._load = realLoad;
  }
}

function controller(WatchController) {
  const store = new Map();
  const state = {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    update: async (key, value) => {
      store.set(key, value);
    }
  };
  const context = {
    extensionUri: { fsPath: path.join(__dirname, '..') },
    workspaceState: state,
    globalState: state
  };
  const c = new WatchController(context);
  c.refresh = () => {};
  c.refreshSupervision = () => {};
  c.showStartPage = () => {};
  c.installV1 = async () => {};
  return c;
}

test('aidlcSetupNeeded: true only for a folder with no AI-DLC of either generation', async () => {
  const { aidlcSetupNeeded } = load();
  const ext = { fsPath: path.join(__dirname, '..') };
  const empty = tmpDir('gate-empty-');
  const v1 = tmpDir('gate-v1-');
  makeV1(v1);
  const v2 = tmpDir('gate-v2-');
  makeV2(v2);
  const both = tmpDir('gate-both-');
  makeV1(both);
  makeV2(both);

  assert.strictEqual(await aidlcSetupNeeded({ fsPath: empty }, ext), true);
  assert.strictEqual(await aidlcSetupNeeded({ fsPath: v1 }, ext), false, 'v1 present: no offer');
  assert.strictEqual(await aidlcSetupNeeded({ fsPath: v2 }, ext), false, 'v2 present: no offer');
  assert.strictEqual(await aidlcSetupNeeded({ fsPath: both }, ext), false);
});

test('the workshop order: toast shown on an empty folder, folder configured by hand, then v2 pressed -- nothing is installed', async () => {
  const root = tmpDir('gate-stale-');
  // The toast's answers: v2, then Kiro CLI (the answer that used to switch the harness).
  const { WatchController, calls } = load({ answers: ['AI-DLC v2', 'Kiro CLI'] });
  const c = controller(WatchController);

  // offerAidlcSetup checks the folder (empty), shows the generation toast, and waits.
  const pending = c.offerAidlcSetup({ fsPath: root });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(calls.toasts.length, 1, 'the generation toast is up');
  assert.deepStrictEqual(calls.toasts[0].buttons, ['AI-DLC v1', 'AI-DLC v2', 'Not now']);

  // Meanwhile, in a terminal: `aidlc config`. The folder is now a v2 project.
  makeV2(root);

  // Press v2. The harness toast appears; press Kiro CLI.
  calls.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(calls.toasts.length, 2, 'the harness toast is up');
  calls.release();
  await pending;

  assert.deepStrictEqual(calls.setup, [], 'the installer was never called');
  const last = calls.toasts[calls.toasts.length - 1];
  assert.match(last.message, /already set up/);
  assert.match(last.message, /aidlc config/, 'the engine command is handed over, not run');
});

test('the same stale toast with v1 pressed over a now-v2 folder installs nothing: the generations do not share a project', async () => {
  const root = tmpDir('gate-stale-v1-');
  const { WatchController, calls } = load({ answers: ['AI-DLC v1'] });
  const c = controller(WatchController);
  const pending = c.offerAidlcSetup({ fsPath: root });
  await new Promise((resolve) => setImmediate(resolve));
  makeV2(root);
  calls.release();
  await pending;
  assert.deepStrictEqual(calls.setup, []);
  assert.match(calls.toasts[calls.toasts.length - 1].message, /already set up/);
});

test('runSetup from the toolbar refuses a v2 project and names the engine command; refuses a v1 project and names the rule', async () => {
  const v2 = tmpDir('gate-toolbar-v2-');
  makeV2(v2);
  {
    const { WatchController, calls } = load();
    const c = controller(WatchController);
    await c.runSetup({ fsPath: v2 });
    assert.deepStrictEqual(calls.setup, []);
    assert.strictEqual(calls.toasts.length, 1);
    assert.match(calls.toasts[0].message, /AI-DLC v2 is already set up/);
    assert.match(calls.toasts[0].message, /aidlc config/);
    assert.match(calls.toasts[0].message, /Kiro IDE and Kiro CLI/, 'says what the command is for');
  }
  const v1 = tmpDir('gate-toolbar-v1-');
  makeV1(v1);
  {
    const { WatchController, calls } = load();
    const c = controller(WatchController);
    await c.runSetup({ fsPath: v1 });
    assert.deepStrictEqual(calls.setup, []);
    assert.match(calls.toasts[0].message, /AI-DLC v1 is already set up/);
    assert.match(calls.toasts[0].message, /do not share a project/);
  }
});

test('an empty folder still reaches the installer, with the preselection intact', async () => {
  const root = tmpDir('gate-empty-go-');
  const { WatchController, calls } = load({ answers: ['AI-DLC v2', 'Kiro IDE'] });
  const c = controller(WatchController);
  const pending = c.offerAidlcSetup({ fsPath: root });
  await new Promise((resolve) => setImmediate(resolve));
  calls.release();
  await new Promise((resolve) => setImmediate(resolve));
  calls.release();
  await pending;
  assert.deepStrictEqual(calls.setup, [{ path: root, preselected: 'v2:kiro-ide' }]);
});

test('the refusal message never promises a reinstall or a removal command that does not exist', () => {
  const src = fs.readFileSync(EXTENSION, 'utf8');
  const start = src.indexOf('function alreadySetUpMessage');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.doesNotMatch(body, /reinstall/i);
  assert.doesNotMatch(body, /v1: Remove/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const titles = pkg.contributes.commands.map((c) => c.title);
  assert.ok(!titles.some((t) => /Remove AI-DLC v1/.test(t)), 'there is no v1 Remove, so the message must not name one');
});
