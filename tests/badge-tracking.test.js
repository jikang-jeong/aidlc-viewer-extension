'use strict';

// Pins the badge to the tree: a file counts as NEW only if the tree can show it.
//
// The activity-bar badge is the size of the NEW set, and opening a file is the only
// thing that removes a file from that set. So every tracked-but-invisible file is a
// phantom the badge counts and the tree cannot display -- the numbers disagree, and
// nothing the user can click will reconcile them. Reported exactly that way: the badge
// said more than the aidlc folder showed.
//
// Two ways a phantom used to get in, pinned separately below. The regression:
// WATCHED_DOT_DIRS lets `.kiro/**` events through so the v2 reader refreshes, and a v2
// engine install writes ~100 `.md` files under `.kiro/` in one stroke -- every one was
// tracked. The old corner: a dot-file like `.notes.md` at a visible level was tracked
// but never rendered, as old as the badge itself.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const EXTENSION = path.join(__dirname, '..', 'src', 'extension.js');

// The same stub-loader the v1-isolation tests use: compile extension.js with vscode
// replaced, and export the internals under test.
function loadInternals() {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return {
        Uri: { file: (p) => ({ fsPath: p }) },
        window: {},
        workspace: { fs: {} },
        commands: {},
        EventEmitter: class {
          constructor() {
            this.event = () => {};
            this.fire = () => {};
          }
        },
        TreeItem: class {
          constructor(value) {
            this.value = value;
          }
        },
        TreeItemCollapsibleState: {},
        ThemeIcon: class {},
        ThemeColor: class {},
        MarkdownString: class {
          constructor(value) {
            this.value = value;
          }
        },
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
    loaded._compile(
      `${fs.readFileSync(EXTENSION, 'utf8')}
module.exports = { isVisibleInTree, isIgnoredEventPath };`,
      EXTENSION
    );
    return loaded.exports;
  } finally {
    Module._load = realLoad;
  }
}

const root = { fsPath: '/p' };
const at = (rel) => ({ fsPath: path.join('/p', rel) });

test('an engine-owned markdown file refreshes the reader but is never tracked as NEW', () => {
  // The two decisions are different on purpose and this is the pair that shows it: the
  // event must pass the ignore filter (the v2 reader depends on it) and must fail the
  // visibility check (the tree will never render it, so a NEW mark could never be
  // cleared).
  const { isVisibleInTree, isIgnoredEventPath } = loadInternals();
  for (const rel of [
    '.kiro/agents/aidlc-architect-agent.md',
    '.kiro/steering/aidlc-practices.md',
    '.aidlc-sensors/requirements-analysis/findings.md'
  ]) {
    assert.equal(isIgnoredEventPath(root, at(rel)), false, `${rel} must still refresh`);
    assert.equal(isVisibleInTree(root, at(rel)), false, `${rel} must not be tracked`);
  }
});

test('what the tree shows is exactly what gets tracked', () => {
  const { isVisibleInTree } = loadInternals();
  for (const rel of [
    'aidlc-docs/inception/requirements.md',
    'aidlc/spaces/default/intents/thing-ab12cd34/requirements.md',
    'README.md',
    'docs/deep/nested/file.md'
  ]) {
    assert.equal(isVisibleInTree(root, at(rel)), true, rel);
  }
});

test('a dot-file at a visible level is not tracked, because the tree hides it too', () => {
  // Older than the regression: the tree's children filter drops any name starting with
  // a dot, files included, so tracking one made a permanent phantom.
  const { isVisibleInTree } = loadInternals();
  assert.equal(isVisibleInTree(root, at('.notes.md')), false);
  assert.equal(isVisibleInTree(root, at('aidlc-docs/.draft.md')), false);
});

test('skipped directories cannot contribute NEW marks through any segment', () => {
  const { isVisibleInTree } = loadInternals();
  for (const rel of [
    'node_modules/pkg/README.md',
    'dist/notes.md',
    'sub/.hidden/inside.md'
  ]) {
    assert.equal(isVisibleInTree(root, at(rel)), false, rel);
  }
});

test('a filename matching a skip-directory name is still a file, and still visible', () => {
  // SKIP_DIRS names directories. `out.md` and `target.md` are files that happen to
  // collide with those names, and only intermediate segments may be judged as
  // directories.
  const { isVisibleInTree } = loadInternals();
  assert.equal(isVisibleInTree(root, at('out.md')), true);
  assert.equal(isVisibleInTree(root, at('docs/target.md')), true);
});

test('the root itself and paths outside it are never trackable', () => {
  const { isVisibleInTree } = loadInternals();
  assert.equal(isVisibleInTree(root, { fsPath: '/p' }), false);
  assert.equal(isVisibleInTree(root, { fsPath: '/elsewhere/file.md' }), false);
});

test('the create wiring itself gates tracking on visibility', () => {
  // The functions above are pure and provable, but the bug lives in the WIRING: one
  // line calling handleCreate unconditionally reintroduces every phantom while all the
  // function tests stay green -- demonstrated by mutating exactly that line. So the
  // wiring is pinned at the source level, the same way the .cmd quoting decision is.
  const source = fs.readFileSync(EXTENSION, 'utf8');
  assert.match(
    source,
    /if \(isVisibleInTree\(folderUri, uri\)\) this\.handleCreate\(uri\);/,
    'handleCreate must be gated on tree visibility'
  );
  // And the refresh must NOT be gated: the v2 reader depends on hidden-path events.
  const wiring = /onDidCreate\(\(uri\) => \{[\s\S]*?\}\);/.exec(source)[0];
  assert.match(wiring, /this\.scheduleRefresh\(\);/);
});
