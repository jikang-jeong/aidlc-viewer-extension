'use strict';

// What the setup prompts put in front of a person.
//
// These are not tests of wording. They pin the decisions that were made by
// watching someone use the thing and get it wrong: which row comes first, whether
// a row says what it installs, and whether the list argues for one answer.
//
// `install-commands.js` requires `vscode`, so it is loaded with that module
// stubbed. Nothing here touches the filesystem or the network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TARGET = path.join(__dirname, '..', 'src', 'install-commands.js');

// Load install-commands with `vscode` replaced, and capture what it tries to show.
// Reloaded per call so no state leaks between assertions.
function loadWithStub({ onQuickPick, onModal } = {}) {
  const shown = { quickPicks: [], modals: [], toasts: [], opened: [], copied: [] };
  const realLoad = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (request !== 'vscode') return realLoad.call(this, request, ...rest);
    return {
      window: {
        showQuickPick: (items, options) => {
          shown.quickPicks.push({ items, options });
          return Promise.resolve(onQuickPick ? onQuickPick(items, options) : undefined);
        },
        showWarningMessage: (message, options, ...actions) => {
          const record = { message, options, actions, modal: Boolean(options && options.modal) };
          if (record.modal) shown.modals.push(record);
          else shown.toasts.push(record);
          return Promise.resolve(onModal ? onModal(record) : undefined);
        },
        showInformationMessage: (message, options, ...actions) => {
          const modal = Boolean(options && options.modal);
          const record = { message, options, actions, modal };
          if (modal) shown.modals.push(record);
          else shown.toasts.push(record);
          return Promise.resolve(onModal ? onModal(record) : undefined);
        },
        showErrorMessage: (message) => {
          shown.toasts.push({ message, error: true, actions: [] });
          return Promise.resolve(undefined);
        },
        withProgress: (options, run) => run({ report: () => {} }, {})
      },
      env: {
        clipboard: {
          writeText: (text) => {
            shown.copied.push(text);
            return Promise.resolve();
          }
        },
        openExternal: (uri) => {
          shown.opened.push(String(uri));
          return Promise.resolve(true);
        }
      },
      Uri: {
        file: (p) => ({ fsPath: p }),
        parse: (s) => s,
        joinPath: (u, ...rest) => ({ fsPath: path.join(u.fsPath, ...rest) })
      },
      commands: { executeCommand: () => Promise.resolve() },
      workspace: { fs: {} },
      ProgressLocation: { Notification: 15 }
    };
  };
  try {
    const loaded = new Module(TARGET);
    loaded.filename = TARGET;
    loaded.paths = Module._nodeModulePaths(path.dirname(TARGET));
    loaded._compile(
      `${fs.readFileSync(TARGET, 'utf8')}
module.exports.chooseGeneration = chooseGeneration;
module.exports.handleMissingBun = handleMissingBun;`,
      TARGET
    );
    return { api: loaded.exports, shown };
  } finally {
    Module._load = realLoad;
  }
}

async function captureGenerationPrompt(state) {
  const { api, shown } = loadWithStub();
  await api.chooseGeneration(state);
  assert.equal(shown.quickPicks.length, 1, 'exactly one list is shown');
  return shown.quickPicks[0];
}

// ---------------------------------------------------------------------------
// Which generation
// ---------------------------------------------------------------------------

test('the generation list puts v1 first, in every install state', async () => {
  // Three thousand people are on v1, so it is the answer most people opening this
  // list are looking for. A list whose first row is the uncommon answer makes the
  // common one read as a fallback -- and the first row is the one Enter picks.
  for (const state of [
    { generation: 'none' },
    { generation: 'v1' },
    { generation: 'v2' },
    { generation: 'both' },
    undefined
  ]) {
    const shown = await captureGenerationPrompt(state);
    assert.equal(shown.items[0].key, 'v1', `v1 must be first for ${JSON.stringify(state)}`);
    assert.equal(shown.items[1].key, 'v2');
  }
});

test('both generations explain themselves, and neither ranks the other', async () => {
  // Order is not a recommendation. Each row describes what it is and the reader
  // decides; nothing may push toward the newer one for being newer.
  const shown = await captureGenerationPrompt({ generation: 'none' });
  assert.equal(shown.items.length, 2);
  for (const item of shown.items) {
    assert.ok(item.detail && item.detail.length > 20, 'each option explains itself');
    assert.ok(item.label.includes('AI-DLC'));
    const text = `${item.label} ${item.description} ${item.detail}`.toLowerCase();
    for (const pushy of ['recommended', 'preferred', 'legacy', 'deprecated', 'obsolete']) {
      assert.ok(!text.includes(pushy), `must not rank the generations: "${pushy}"`);
    }
  }
});

test('the question is asked, rather than left to be inferred', async () => {
  // Two buttons were tried instead of one that asks, and the report came back at
  // once: pressing "Set up AI-DLC" installed v1 because that is what it had always
  // done, and nothing on screen said the other icon was the one for v2.
  const shown = await captureGenerationPrompt({ generation: 'none' });
  assert.ok(shown.options.title, 'the list has a title');
  assert.match(shown.options.placeHolder, /\?$/, 'the prompt is a question');
  // Losing focus must not silently answer it.
  assert.equal(shown.options.ignoreFocusOut, true);
});

test('an install already present is said so, on its own row only', async () => {
  const v1Present = await captureGenerationPrompt({ generation: 'v1' });
  assert.match(v1Present.items[0].label, /already present/);
  assert.doesNotMatch(v1Present.items[1].label, /already present|reinstall/);

  const v2Present = await captureGenerationPrompt({ generation: 'v2' });
  assert.match(v2Present.items[1].label, /reinstall/);
  assert.doesNotMatch(v2Present.items[0].label, /already present|reinstall/);

  const both = await captureGenerationPrompt({ generation: 'both' });
  assert.match(both.items[0].label, /already present/);
  assert.match(both.items[1].label, /reinstall/);
});

test('dismissing the list installs nothing', async () => {
  const { api } = loadWithStub({ onQuickPick: () => undefined });
  assert.equal(await api.chooseGeneration({ generation: 'none' }), undefined);
});

test('a malformed install state does not break the list', async () => {
  // The state comes from reading a project, which can be anything.
  for (const state of [null, {}, { generation: 42 }, { generation: null }, 'v1', 0]) {
    const { api, shown } = loadWithStub();
    await assert.doesNotReject(() => api.chooseGeneration(state));
    assert.equal(shown.quickPicks[0].items[0].key, 'v1');
  }
});

// ---------------------------------------------------------------------------
// Missing bun
// ---------------------------------------------------------------------------

test('a missing bun offers no way to install without it', async () => {
  // There was a second button that installed AI-DLC anyway. The engine is invoked
  // as `bun <file>` throughout, so that produced 284 files that do nothing, with
  // gates that never fire and no error to say why.
  const { api, shown } = loadWithStub({ onModal: () => undefined });
  await api.handleMissingBun({
    found: false,
    installCommand: 'INSTALL-COMMAND',
    pathNote: 'note',
    alternatives: ['alt'],
    docsUrl: 'https://example.invalid/docs'
  });
  assert.equal(shown.modals.length, 1);
  for (const action of shown.modals[0].actions) {
    assert.ok(!/anyway|continue|skip|proceed/i.test(action), `must not offer to go on: "${action}"`);
  }
});

test('copying the bun command does not install anything', async () => {
  const { api, shown } = loadWithStub({
    onModal: (record) => record.actions.find((a) => /copy/i.test(a))
  });
  await api.handleMissingBun({
    found: false,
    installCommand: 'INSTALL-COMMAND',
    pathNote: 'note',
    alternatives: ['alt'],
    docsUrl: 'https://example.invalid/docs'
  });
  assert.deepEqual(shown.copied, ['INSTALL-COMMAND']);
  assert.equal(shown.opened.length, 0);
  // And says what to do next, rather than leaving the user at a copied string.
  assert.ok(shown.toasts.some((t) => /again/i.test(t.message)));
});

test('the docs button opens bun, and copies nothing', async () => {
  const { api, shown } = loadWithStub({
    onModal: (record) => record.actions.find((a) => /page|docs/i.test(a))
  });
  await api.handleMissingBun({
    found: false,
    installCommand: 'INSTALL-COMMAND',
    pathNote: 'note',
    alternatives: ['alt'],
    docsUrl: 'https://example.invalid/docs'
  });
  assert.deepEqual(shown.opened, ['https://example.invalid/docs']);
  assert.equal(shown.copied.length, 0);
});

test('a bun report missing its optional fields still renders', async () => {
  // prerequisite is absent on macOS, and alternatives could be empty.
  const { api, shown } = loadWithStub({ onModal: () => undefined });
  await assert.doesNotReject(() =>
    api.handleMissingBun({ found: false, installCommand: 'C', pathNote: 'N' })
  );
  assert.equal(shown.modals.length, 1);
  assert.ok(shown.modals[0].options.detail.includes('C'));
});
