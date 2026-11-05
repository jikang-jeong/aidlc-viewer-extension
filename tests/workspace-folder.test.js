'use strict';

// The watched folder is the Kiro workspace folder.
//
// Kiro runs AI-DLC v2 from the workspace root: it reads `.kiro/agents` there and nowhere
// else. The viewer used to ask for a folder to watch, independently of what was open,
// and that produced two states nobody wanted: a watched sub-folder the engine never ran
// in, and a folder watched from a folder-less window whose choice vanished when the
// project was opened (workspaceState belongs to the window's workspace, and a window
// with no folder is a different one). Reported from a customer workshop, where the
// presenter had people pick the folder by hand and then open it.
//
// These tests load the real WatchController and run its real restoreWatcher,
// workspaceFolderToWatch and selectFolder against a stubbed `vscode`. The methods that
// touch the editor (setWatchedFolder, offerAidlcSetup) are replaced on the instance and
// their calls recorded; the decision logic between them is what is under test.

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

function v2Project() {
  const root = tmpDir('aidlc-ws-v2-');
  fs.mkdirSync(path.join(root, '.kiro', 'tools', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kiro', 'tools', 'data', 'stage-graph.json'), '{}');
  return root;
}

function emptyProject() {
  return tmpDir('aidlc-ws-empty-');
}

// Load extension.js with `vscode` stubbed; return the WatchController class and the
// stub so a test can set workspaceFolders and script dialog answers.
function loadController({ workspaceFolders = [], onOpenDialog, onQuickPick, onCommand } = {}) {
  const calls = { openDialog: [], quickPick: [], commands: [], toasts: [] };
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
    workspace: {
      workspaceFolders: workspaceFolders.map((p) => ({ uri: uri(p) })),
      fs: { stat: async () => ({ type: 2 }) }
    },
    window: {
      showOpenDialog: async (opts) => {
        calls.openDialog.push(opts);
        return onOpenDialog ? onOpenDialog(opts) : undefined;
      },
      showQuickPick: async (items, opts) => {
        calls.quickPick.push({ items, opts });
        return onQuickPick ? onQuickPick(items, opts) : undefined;
      },
      showInformationMessage: async (message) => {
        calls.toasts.push(message);
        return undefined;
      },
      showWarningMessage: async () => undefined
    },
    commands: {
      executeCommand: async (command, ...args) => {
        calls.commands.push({ command, args });
        return onCommand ? onCommand(command, ...args) : undefined;
      }
    }
  };
  const realLoad = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (request !== 'vscode') return realLoad.call(this, request, ...rest);
    return stub;
  };
  try {
    const loaded = new Module(EXTENSION);
    loaded.filename = EXTENSION;
    loaded.paths = Module._nodeModulePaths(path.dirname(EXTENSION));
    loaded._compile(
      `${fs.readFileSync(EXTENSION, 'utf8')}\nmodule.exports = { WatchController, samePath };`,
      EXTENSION
    );
    return { WatchController: loaded.exports.WatchController, samePath: loaded.exports.samePath, calls };
  } finally {
    Module._load = realLoad;
  }
}

function memoryState(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    update: async (key, value) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
    _store: store
  };
}

// A controller whose editor-touching methods record instead of acting.
function controllerUnderTest(WatchController, { workspaceState, globalState } = {}) {
  const context = {
    extensionUri: { fsPath: path.join(__dirname, '..') },
    workspaceState: workspaceState ?? memoryState(),
    globalState: globalState ?? memoryState()
  };
  const controller = new WatchController(context);
  const record = { watched: [], offered: [] };
  controller.setWatchedFolder = async (folderUri, options) => {
    record.watched.push({ path: folderUri.fsPath, options });
    await context.workspaceState.update('markdownWatchViewer.watchedFolder', folderUri.fsPath);
  };
  controller.offerAidlcSetup = async (folderUri) => {
    record.offered.push(folderUri.fsPath);
  };
  controller.refreshSupervision = () => {};
  return { controller, context, record };
}

test('one workspace folder open and nothing stored: it is watched on activation, silently, without a setup toast', async () => {
  const root = emptyProject();
  const { WatchController } = loadController({ workspaceFolders: [root] });
  const { controller, record } = controllerUnderTest(WatchController);

  await controller.restoreWatcher();

  assert.deepStrictEqual(record.watched.map((w) => w.path), [root]);
  assert.strictEqual(record.watched[0].options.showMessage, false, 'no "Watching folder" toast on an automatic watch');
  assert.deepStrictEqual(record.offered, [], 'an automatic watch is not an explicit pick, so setup is not offered');
  assert.strictEqual(controller.autoWatched, true);
});

test('a folder stored by an earlier activation wins over the workspace folder', async () => {
  const stored = v2Project();
  const open = emptyProject();
  const { WatchController } = loadController({ workspaceFolders: [open] });
  const { controller, record } = controllerUnderTest(WatchController, {
    workspaceState: memoryState({ 'markdownWatchViewer.watchedFolder': stored })
  });

  await controller.restoreWatcher();

  assert.deepStrictEqual(record.watched.map((w) => w.path), [stored], 'existing users keep what they set');
  assert.notStrictEqual(controller.autoWatched, true);
});

test('no workspace folder: nothing is watched and the welcome view is left to say so', async () => {
  const { WatchController, calls } = loadController({ workspaceFolders: [] });
  const { controller, record } = controllerUnderTest(WatchController);

  await controller.restoreWatcher();

  assert.deepStrictEqual(record.watched, []);
  assert.deepStrictEqual(calls.toasts, [], 'no prompt on startup');
});

test('several workspace folders: watched automatically only when exactly one carries AI-DLC', async () => {
  const withAidlc = v2Project();
  const plain = emptyProject();
  const another = emptyProject();

  {
    const { WatchController } = loadController({ workspaceFolders: [plain, withAidlc, another] });
    const { controller, record } = controllerUnderTest(WatchController);
    await controller.restoreWatcher();
    assert.deepStrictEqual(record.watched.map((w) => w.path), [withAidlc]);
  }
  {
    const second = v2Project();
    const { WatchController } = loadController({ workspaceFolders: [withAidlc, second] });
    const { controller, record } = controllerUnderTest(WatchController);
    await controller.restoreWatcher();
    assert.deepStrictEqual(record.watched, [], 'two candidates: the toolbar asks, activation does not guess');
  }
  {
    const { WatchController } = loadController({ workspaceFolders: [plain, another] });
    const { controller, record } = controllerUnderTest(WatchController);
    await controller.restoreWatcher();
    assert.deepStrictEqual(record.watched, [], 'no candidate: nothing is guessed');
  }
});

test('Open Workspace with no folder open: opens the picked folder in Kiro instead of watching it from a folder-less window', async () => {
  const picked = emptyProject();
  const { WatchController, calls } = loadController({
    workspaceFolders: [],
    onOpenDialog: () => [{ fsPath: picked }]
  });
  const { controller, context, record } = controllerUnderTest(WatchController);

  await controller.selectFolder();

  assert.deepStrictEqual(record.watched, [], 'not watched here: this window\'s state would not survive the reload');
  assert.deepStrictEqual(
    calls.commands.map((c) => c.command),
    ['vscode.openFolder'],
    'the step that was missing'
  );
  assert.strictEqual(calls.commands[0].args[0].fsPath, picked);
  assert.strictEqual(
    context.globalState.get('markdownWatchViewer.pendingSetupOffer'),
    picked,
    'the setup offer this pick would have made is carried across the reload'
  );
  assert.match(calls.openDialog[0].openLabel, /Open/, 'the button says it opens, not watches');
});

test('after that reload: the folder is watched and the carried setup offer is made once', async () => {
  const picked = emptyProject();
  const globalState = memoryState({ 'markdownWatchViewer.pendingSetupOffer': picked });
  const { WatchController } = loadController({ workspaceFolders: [picked] });
  const { controller, context, record } = controllerUnderTest(WatchController, { globalState });

  await controller.restoreWatcher();

  assert.deepStrictEqual(record.watched.map((w) => w.path), [picked]);
  assert.deepStrictEqual(record.offered, [picked], 'the explicit pick\'s setup question, asked after the reload');
  assert.strictEqual(context.globalState.get('markdownWatchViewer.pendingSetupOffer'), undefined, 'consumed');

  // A different folder opened later must not inherit the offer.
  const other = emptyProject();
  const stale = memoryState({ 'markdownWatchViewer.pendingSetupOffer': picked });
  const again = loadController({ workspaceFolders: [other] });
  const second = controllerUnderTest(again.WatchController, { globalState: stale });
  await second.controller.restoreWatcher();
  assert.deepStrictEqual(second.record.offered, [], 'offer is for the folder that was picked, not whatever opens next');
});

test('Open Workspace with several folders open: a QuickPick among them, never a disk-wide dialog', async () => {
  const a = emptyProject();
  const b = v2Project();
  const { WatchController, calls } = loadController({
    workspaceFolders: [a, b],
    onQuickPick: (items) => items.find((i) => i.uri.fsPath === b)
  });
  const { controller, record } = controllerUnderTest(WatchController);

  await controller.selectFolder();

  assert.strictEqual(calls.openDialog.length, 0);
  assert.strictEqual(calls.quickPick.length, 1);
  assert.deepStrictEqual(calls.quickPick[0].items.map((i) => i.uri.fsPath), [a, b]);
  assert.deepStrictEqual(record.watched.map((w) => w.path), [b]);
  assert.deepStrictEqual(record.offered, [b], 'an explicit pick still offers setup');
});

test('Open Workspace with one folder open: dialog starts at the root; the root offers setup, a sub-folder gets the one-line warning instead', async () => {
  const root = emptyProject();
  const sub = path.join(root, 'docs');
  fs.mkdirSync(sub);

  {
    const { WatchController, calls } = loadController({
      workspaceFolders: [root],
      onOpenDialog: () => [{ fsPath: root }]
    });
    const { controller, record } = controllerUnderTest(WatchController);
    await controller.selectFolder();
    assert.strictEqual(calls.openDialog[0].defaultUri.fsPath, root, 'the common answer is one click');
    assert.deepStrictEqual(record.offered, [root]);
    assert.deepStrictEqual(calls.toasts, []);
  }
  {
    const { WatchController, calls } = loadController({
      workspaceFolders: [root],
      onOpenDialog: () => [{ fsPath: sub }]
    });
    const { controller, record } = controllerUnderTest(WatchController);
    await controller.selectFolder();
    assert.deepStrictEqual(record.watched.map((w) => w.path), [sub], 'v1 projects may keep aidlc-docs below the root, so the pick is honoured');
    assert.deepStrictEqual(record.offered, [], 'setup is not offered where the engine would not run');
    assert.strictEqual(calls.toasts.length, 1);
    assert.match(calls.toasts[0], /workspace root/);
  }
});

test('the welcome guide opens on an automatically watched folder, as it did on an unwatched one', () => {
  const root = emptyProject();
  const { WatchController } = loadController({ workspaceFolders: [root] });
  const { controller } = controllerUnderTest(WatchController, {
    workspaceState: memoryState({ 'markdownWatchViewer.watchedFolder': root })
  });
  let shown = 0;
  controller.showHelp = () => {
    shown += 1;
  };

  controller.autoWatched = true;
  controller.maybeShowWelcomeGuide();
  assert.strictEqual(shown, 1, 'a first-time workspace sees the guide even though a folder is already watched');

  controller.welcomeGuideShown = false;
  controller.autoWatched = false;
  controller.maybeShowWelcomeGuide();
  assert.strictEqual(shown, 1, 'a workspace restored from an earlier activation does not');
});

test('samePath treats trailing separators and, off Linux, case as the same folder', () => {
  const { samePath } = loadController();
  assert.strictEqual(samePath('/a/b', '/a/b/'), true);
  assert.strictEqual(samePath('/a/b', '/a/c'), false);
  if (process.platform !== 'linux') {
    assert.strictEqual(samePath('/A/B', '/a/b'), true);
  }
});

test('the old aidlc-docs auto-detect prompt is gone: the workspace folder is watched, not asked about', () => {
  const src = fs.readFileSync(EXTENSION, 'utf8');
  assert.doesNotMatch(src, /offerWorkspaceAutoDetect/);
  assert.doesNotMatch(src, /autoDetectAsked/);
  assert.doesNotMatch(src, /Watch this workspace/);
});

test('the Not started row is the setup button when the folder has no AI-DLC', () => {
  const src = fs.readFileSync(EXTENSION, 'utf8');
  const start = src.indexOf('class ProgressItem');
  const end = src.indexOf('function formatJourneyCounts');
  const body = src.slice(start, end);
  assert.match(body, /summary\.generation === 'none'/);
  assert.match(body, /command: 'markdownWatchViewer\.setupRules'/);
});
