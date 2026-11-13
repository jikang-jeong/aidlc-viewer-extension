'use strict';

// After a v2 setup, Kiro has to be told what IT still has to do, and the extension has
// to do the part it can. Pins:
//
//   - kiro-readiness decides between "Reload Window" and "Quit Kiro" from one fact,
//     whether Kiro's PATH resolves `aidlc`, and carries a Korean line with every English one.
//   - The completion dialog is modal (a toast never shows `detail`, which is how the
//     next step went unseen for every release before 0.1.4), offers the readiness
//     action and Later, and the person's choice comes back to extension.js.
//   - runSetup schedules the Start page in workspaceState before restarting, and
//     restoreWatcher opens it once when the extension comes back.
//   - On Windows the apply is upstream's install.ps1 with the verified directory, and an
//     elevated Kiro is asked with upstream's words rather than refused.
//   - Check setup reports whether Kiro can run `aidlc`, and knows 2.11.3's agent file name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const { kiroReadiness, ACTIONS } = require('../src/aidlc/kiro-readiness');
const engineInstall = require('../src/aidlc/engine-install');

// ---------------------------------------------------------------------------
// kiro-readiness
// ---------------------------------------------------------------------------

test('readiness: resolvable means a window reload, on every platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const r = kiroReadiness({ platform, resolvable: true });
    assert.equal(r.action, 'reload');
    assert.equal(r.label, 'Reload Window');
    assert.equal(r.command, 'workbench.action.reloadWindow');
  }
});

test('readiness: a fresh Windows install that registered PATH needs a full quit, and says reload is not enough', () => {
  const r = kiroReadiness({ platform: 'win32', resolvable: false, freshEngineInstall: true, pathStatus: 'updated' });
  assert.equal(r.action, 'quit');
  assert.equal(r.command, 'workbench.action.quit');
  assert.match(r.en, /Quit Kiro and open it again/);
  assert.match(r.en, /Reload Window is not enough/);
});

test('readiness: Windows where PATH was not registered tells the person to add it, then quit', () => {
  for (const pathStatus of ['failed', 'conflict', undefined]) {
    const r = kiroReadiness({ platform: 'win32', resolvable: false, freshEngineInstall: true, pathStatus });
    assert.equal(r.action, 'quit');
    assert.match(r.en, /Add the engine's command directory to your user PATH/);
  }
});

test('readiness: a Mac that cannot resolve aidlc is told about ~/.local/bin in the shell profile', () => {
  const r = kiroReadiness({ platform: 'darwin', resolvable: false });
  assert.equal(r.action, 'quit');
  assert.match(r.en, /~\/\.local\/bin/);
});

test('readiness: every English line has a Korean line', () => {
  const cases = [
    { platform: 'darwin', resolvable: true },
    { platform: 'darwin', resolvable: false },
    { platform: 'win32', resolvable: false, freshEngineInstall: true, pathStatus: 'updated' },
    { platform: 'win32', resolvable: false, pathStatus: 'failed' }
  ];
  for (const c of cases) {
    const r = kiroReadiness(c);
    assert.ok(r.en.length > 20);
    assert.match(r.ko, /[가-힣]/, `Korean line for ${JSON.stringify(c)}`);
    assert.ok(Object.values(ACTIONS).some((a) => a.label === r.label));
  }
});

test('engineResolvable reads the given PATH, not the process, and knows the Windows names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-path-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-nopath-'));
  fs.writeFileSync(path.join(dir, 'aidlc'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, 'aidlc.cmd'), '@echo off\n');
  const sep = path.delimiter;
  assert.equal(engineInstall.engineResolvable({ env: { PATH: `${empty}${sep}${dir}` }, platform: 'darwin' }), true);
  assert.equal(engineInstall.engineResolvable({ env: { PATH: `${empty}${sep}${dir}` }, platform: 'win32' }), true);
  assert.equal(engineInstall.engineResolvable({ env: { PATH: empty }, platform: 'darwin' }), false);
  assert.equal(engineInstall.engineResolvable({ env: { PATH: '' }, platform: 'darwin' }), false);
  assert.equal(engineInstall.engineResolvable({ env: {}, platform: 'win32' }), false);
  // A directory on PATH that holds only the POSIX name is not resolvable on Windows.
  const posixOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-posix-'));
  fs.writeFileSync(path.join(posixOnly, 'aidlc'), '');
  assert.equal(engineInstall.engineResolvable({ env: { PATH: posixOnly }, platform: 'win32' }), false);
});

// ---------------------------------------------------------------------------
// The Windows apply goes through upstream's script
// ---------------------------------------------------------------------------

test('on Windows the apply is install.ps1 with the verified directory, offline, quiet, JSON', () => {
  const args = engineInstall.windowsInstallerArgs({ base: 'C:\\t\\aidlc-provision-x', version: '2.11.3', yes: false });
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.equal(args[5], path.join('C:\\t\\aidlc-provision-x', 'install.ps1'));
  assert.deepEqual(args.slice(6), ['-From', 'C:\\t\\aidlc-provision-x', '-Version', '2.11.3', '-Quiet', '-Json']);
  // -Yes only after the person answered the administrator question.
  const yes = engineInstall.windowsInstallerArgs({ base: 'C:\\t', version: '2.11.3', yes: true });
  assert.equal(yes[yes.length - 1], '-Yes');
  assert.equal(engineInstall.WINDOWS_INSTALLER, 'install.ps1');
});

test("the script's JSON result is read from its last JSON line, and anything else is undefined", () => {
  const out = 'WARNING something\n{"ok":true,"status":"installed","path":{"status":"updated"}}\n';
  assert.deepEqual(engineInstall.parseWindowsInstallerOutput(out).path, { status: 'updated' });
  assert.equal(engineInstall.parseWindowsInstallerOutput('no json here'), undefined);
  assert.equal(engineInstall.parseWindowsInstallerOutput(''), undefined);
  assert.equal(engineInstall.parseWindowsInstallerOutput('{not json'), undefined);
});

test("the administrator warning is upstream's sentence, so both routes say the same thing", () => {
  assert.match(engineInstall.UAC_ELEVATED_WARNING, /running as administrator/);
  assert.match(engineInstall.UAC_ELEVATED_WARNING, /less safe/);
  // And the old refusal is gone from the source.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'aidlc', 'engine-install.js'), 'utf8');
  assert.doesNotMatch(src, /Refusing an Administrator install/);
});

test('pathCaveat is silent when install.ps1 registered PATH, and speaks only when it did not', () => {
  if (process.platform === 'win32') {
    assert.equal(engineInstall.pathCaveat('C:\\x\\bin', { pathStatus: 'updated' }), undefined);
    assert.equal(engineInstall.pathCaveat('C:\\x\\bin', { pathStatus: 'unchanged' }), undefined);
    assert.match(engineInstall.pathCaveat('C:\\x\\bin', { pathStatus: 'failed' }), /C:\\x\\bin/);
  } else {
    assert.equal(engineInstall.pathCaveat('/x/bin', { pathStatus: 'failed' }), undefined, 'never off Windows');
  }
  assert.doesNotThrow(() => engineInstall.pathCaveat(undefined));
});

// ---------------------------------------------------------------------------
// The completion dialog and the administrator question, through the real setup()
// ---------------------------------------------------------------------------

const TARGET = path.join(ROOT, 'src', 'install-commands.js');

function loadSetup({ root, elevated = false, engineFound = true, readiness, onModal, onWarningModal }) {
  const shown = { modals: [], toasts: [], installCalls: [] };
  const realLoad = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (request === './aidlc/engine-install') {
      return {
        DOCS_URL: 'https://example.invalid/docs',
        detectEngine: () => (engineFound ? { found: true, path: '/fake/aidlc', version: '2.11.3' } : { found: false }),
        installEngine: async (opts) => {
          shown.installCalls.push(opts);
          engineFound = true;
          return { ok: true, version: '2.11.3', binDir: 'C:\\x\\bin', pathStatus: 'updated', pathRegistered: true };
        },
        installCommand: () => 'INSTALL-COMMAND',
        pathCaveat: () => undefined,
        isElevatedWindows: async () => elevated,
        UAC_ELEVATED_WARNING: 'This PowerShell window is running as administrator. (test)',
        engineResolvable: () => true
      };
    }
    if (request === './aidlc/engine-config') {
      return {
        configureProject: async () => ({ ok: true, plan: { create: 10, update: 0, merge: 0, preserve: 0, remove: 0, conflict: 0 }, outstanding: ['engine notice line'], message: 'configured' })
      };
    }
    if (request === './aidlc/kiro-readiness' && readiness) {
      return { kiroReadiness: () => readiness };
    }
    if (request !== 'vscode') return realLoad.call(this, request, ...rest);
    return {
      window: {
        showQuickPick: (items) => Promise.resolve(items.find((i) => i.key === 'kiro-ide') ?? items[0]),
        showWarningMessage: (message, options, ...actions) => {
          const record = { message, options, actions, modal: Boolean(options && options.modal) };
          shown.modals.push(record);
          return Promise.resolve(onWarningModal ? onWarningModal(record) : undefined);
        },
        showInformationMessage: (message, options, ...actions) => {
          const record = { message, options, actions, modal: Boolean(options && options.modal) };
          (record.modal ? shown.modals : shown.toasts).push(record);
          return Promise.resolve(onModal ? onModal(record) : undefined);
        },
        showErrorMessage: (message) => { shown.toasts.push({ message, error: true }); return Promise.resolve(); },
        withProgress: (options, run) => Promise.resolve(run({ report: () => {} }, {}))
      },
      env: { clipboard: { writeText: () => Promise.resolve() }, openExternal: () => Promise.resolve(true) },
      Uri: { file: (p) => ({ fsPath: p }), parse: (s) => s, joinPath: (u, ...r) => ({ fsPath: path.join(u.fsPath, ...r) }) },
      commands: { executeCommand: () => Promise.resolve() },
      workspace: { fs: {}, workspaceFolders: [{ uri: { fsPath: root } }] },
      ProgressLocation: { Notification: 15 }
    };
  };
  try {
    const loaded = new Module(TARGET);
    loaded.filename = TARGET;
    loaded.paths = Module._nodeModulePaths(path.dirname(TARGET));
    loaded._compile(fs.readFileSync(TARGET, 'utf8'), TARGET);
    return { api: loaded.exports, shown };
  } finally {
    Module._load = realLoad;
  }
}

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-root-'));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

const RELOAD = { action: 'reload', label: 'Reload Window', command: 'workbench.action.reloadWindow', en: 'Reload the window so Kiro loads the agent.', ko: '창을 다시 로드하세요.' };
const QUIT = { action: 'quit', label: 'Quit Kiro', command: 'workbench.action.quit', en: 'Quit Kiro and open it again.', ko: 'Kiro를 완전히 종료하고 다시 여세요.' };

test('the completion dialog is modal, carries the engine notice, the English and the Korean, and offers the readiness action and Later', async () => {
  const root = freshRoot();
  const { api, shown } = loadSetup({ root, readiness: RELOAD, onModal: () => 'Later' });
  const result = await api.setup({ fsPath: root }, async () => {}, 'v2:kiro-ide');
  const done = shown.modals.find((m) => /set up for Kiro IDE/.test(m.message));
  assert.ok(done, 'completion dialog shown');
  assert.equal(done.modal, true, 'modal: a toast never renders detail');
  assert.deepEqual(done.actions, ['Reload Window', 'Later']);
  assert.match(done.options.detail, /engine notice line/);
  assert.match(done.options.detail, /Reload the window so Kiro loads the agent\./);
  assert.match(done.options.detail, /창을 다시 로드하세요\./);
  assert.doesNotMatch(done.options.detail, /already available in this window/);
  assert.deepEqual(result, { restart: undefined }, 'Later: no restart requested');
});

test("choosing the action returns it to the caller; the dialog itself restarts nothing", async () => {
  for (const [readiness, label] of [[RELOAD, 'Reload Window'], [QUIT, 'Quit Kiro']]) {
    const root = freshRoot();
    const { api } = loadSetup({ root, readiness, onModal: () => label });
    const result = await api.setup({ fsPath: root }, async () => {}, 'v2:kiro-ide');
    assert.equal(result.restart, readiness.action);
  }
});

test('an elevated Windows session is asked with upstream\'s words; Cancel installs nothing, Install anyway passes allowElevated', async () => {
  const cancel = loadSetup({ root: freshRoot(), elevated: true, engineFound: false, readiness: RELOAD, onWarningModal: () => undefined });
  await cancel.api.setup({ fsPath: cancel.api.RECEIPT_PATH ? freshRoot() : freshRoot() }, async () => {}, 'v2:kiro-ide');
  const asked = cancel.shown.modals.find((m) => /running as administrator/.test(m.message + ' ' + (m.options && m.options.detail)));
  assert.ok(asked, 'the administrator question was asked');
  assert.deepEqual(asked.actions, ['Install anyway']);
  assert.match(asked.options.detail, /관리자 권한/);
  assert.equal(cancel.shown.installCalls.length, 0, 'Cancel: nothing downloaded');

  const anyway = loadSetup({ root: freshRoot(), elevated: true, engineFound: false, readiness: RELOAD, onWarningModal: () => 'Install anyway', onModal: () => 'Later' });
  await anyway.api.setup({ fsPath: freshRoot() }, async () => {}, 'v2:kiro-ide');
  assert.equal(anyway.shown.installCalls.length, 1);
  assert.equal(anyway.shown.installCalls[0].allowElevated, true);
});

test('a non-elevated session is never asked', async () => {
  const { api, shown } = loadSetup({ root: freshRoot(), elevated: false, engineFound: false, readiness: RELOAD, onModal: () => 'Later' });
  await api.setup({ fsPath: freshRoot() }, async () => {}, 'v2:kiro-ide');
  assert.ok(!shown.modals.some((m) => /running as administrator/.test(m.message)));
  assert.equal(shown.installCalls[0].allowElevated, false);
});

// ---------------------------------------------------------------------------
// runSetup restarts and schedules the Start page; restoreWatcher opens it once
// ---------------------------------------------------------------------------

test('the Start page is scheduled in workspaceState before the restart, and opened once on the next activation', () => {
  // Read from the source, which is where the ordering lives: update the state, then run
  // the command, then return without opening the page in this window.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
  const run = src.slice(src.indexOf('const result = await installCommands.setup('), src.indexOf('this.showStartPage(target, added);\n  }'));
  const update = run.indexOf('workspaceState.update(START_PAGE_AFTER_RESTART_KEY, added)');
  const restart = run.indexOf('executeCommand(RESTART_COMMANDS[result.restart])');
  assert.ok(update > 0 && restart > update, 'the flag is written before the restart command runs');
  assert.match(src, /RESTART_COMMANDS = \{\s*reload: 'workbench\.action\.reloadWindow',\s*quit: 'workbench\.action\.quit'/);
  // Consumed once, from both activation paths (auto-watched workspace folder and stored folder).
  assert.equal((src.match(/openStartPageScheduledBeforeRestart\(/g) || []).length, 3, 'defined once, called from the two restore paths');
  const consume = src.slice(src.indexOf('async openStartPageScheduledBeforeRestart('));
  assert.match(consume.slice(0, 400), /update\(START_PAGE_AFTER_RESTART_KEY, undefined\)[\s\S]*showStartPage\(folderUri, generation\)/);
  // And the sentence that contradicted the engine is gone.
  assert.doesNotMatch(fs.readFileSync(TARGET, 'utf8'), /already available in this window'/);
});

// ---------------------------------------------------------------------------
// Check setup
// ---------------------------------------------------------------------------

test('Check setup knows the 2.11.3 agent file and reports whether Kiro can run aidlc', async () => {
  const root = freshRoot();
  fs.mkdirSync(path.join(root, '.kiro', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kiro', 'agents', 'aidlc-aidlc.md'), '---\nname: aidlc\n---\n');
  fs.mkdirSync(path.join(root, '.kiro', 'tools', 'data'), { recursive: true });
  const { api, shown } = loadSetup({ root, readiness: QUIT, onModal: () => undefined });
  await api.checkV2({ fsPath: root });
  const report = shown.modals.find((m) => /AI-DLC v2 (looks ready|is not ready)/.test(m.message));
  assert.ok(report);
  assert.match(report.options.detail, /aidlc\*\.\{md,json\}: present \(aidlc-aidlc\.md\)/);
  assert.match(report.options.detail, /Kiro can run `aidlc` from its PATH: yes/);
});
