'use strict';

// Issue #5, from a person following a Claude Code + Codex CLI run of AI-DLC 2.11.3 in
// VS Code: a repo with no `.kiro/` at all.
//
// 1. The engine writes the same compiled data under the directory of the harness it was
//    asked for -- `.claude/tools/data/stage-graph.json`, `.codex/...` -- and this extension
//    read `.kiro/tools/data/` only. The project was detected as v2 (by `aidlc/spaces`) and
//    then the read failed with `stage-graph-unreadable`. Reproduced on 2.11.3 with
//    `aidlc config --harness claude --yes` then `--harness codex --yes` before the fix;
//    the fixtures below are that project's shape.
// 2. `aidlc/spaces/<space>/intents/audit/` is the space-level audit shard (the engine's
//    audit-format.md: knowledge-base events "land in the space-level audit shard"), not an
//    intent. It has no dot in its name, so it passed as one: an intent called `audit` with
//    every stage pending, or `audit` reported as on disk but missing from the manifest. The
//    shard content below is pasted from a real `aidlc engine knowledge onboard` run.
//
// The tests run the readers on disk fixtures; none re-implements the lookup it checks.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const harness = require('../src/aidlc/harness-dirs');
const detect = require('../src/aidlc/detect');
const graph = require('../src/aidlc/graph');
const runtime = require('../src/aidlc/runtime');
const { readProject } = require('../src/aidlc/index');
const { readScopeCatalogue } = require('../src/aidlc/command-guide');

const STAGE_GRAPH = [
  { slug: 'workspace-detection', name: 'Workspace Detection', number: '0.1', phase: 'initialization', mode: 'engine', execution: 'ALWAYS' },
  { slug: 'intent-capture', name: 'Intent Capture', number: '1.1', phase: 'inception', mode: 'collaborative', execution: 'ALWAYS' },
  { slug: 'code-generation', name: 'Code Generation', number: '3.5', phase: 'construction', mode: 'agent', execution: 'ALWAYS' }
];
// Keyed by scope at the top level, as the engine writes it.
const SCOPE_GRID = {
  bugfix: { stages: { 'workspace-detection': 'EXECUTE', 'intent-capture': 'EXECUTE', 'code-generation': 'EXECUTE' } },
  poc: { stages: { 'workspace-detection': 'EXECUTE', 'intent-capture': 'SKIP', 'code-generation': 'EXECUTE' } }
};
// The engine's own records beside the stage graph, as `aidlc config --harness claude`
// writes them on 2.11.3.
const HARNESS_JSON = { schemaVersion: 1, distribution: 'claude', productName: 'Claude Code', name: 'claude', harnessDir: '.claude', rulesSubdir: 'rules' };
const STAMP_JSON = { schemaVersion: 1, frameworkVersion: '2.11.3', distribution: 'claude', harnessDir: '.claude' };
// `.claude/scopes/aidlc-bugfix.md` as the engine writes it (byte-identical to the `.kiro`
// one on 2.11.3).
const BUGFIX_SCOPE = `---
name: bugfix
depth: Minimal
keywords:
  - fix
  - bug
  - broken
  - bugfix
description: Fix a specific bug
skeleton: off
existing_code: true
runner: true
review_cap: advisory
guard_policy: off
sensors: on
learnings: off
summary_confirmation: off
plan_approval: on
collaborators: off
---

# Bugfix
`;
// The space-level shard, `aidlc/spaces/default/intents/audit/<host>-<clone>.md`, exactly as
// `aidlc engine knowledge onboard docs/glossary.md` wrote it on 2.11.3.
const SPACE_SHARD_NAME = '7cf34de9343e-223450f5c791.md';
const SPACE_SHARD = `# AI-DLC Audit Log

## Document Indexed
**Timestamp**: 2026-11-28T02:27:29Z
**Event**: DOCUMENT_INDEXED
**Space**: default
**Document**: 01a21ffa-a3fb-78e1-a98d-c1afaec4f762
**Source**: documents/glossary.md
**Digest**: b5d1b25a59f0f3d77db909662b5644df69a96fdc08f8255e7f3ef453d17a2930

---

`;

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function write(root, rel, contents) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
}
// A project configured for one harness: its compiled data and records under `dir`.
function configureFor(root, dir, { stageGraph = STAGE_GRAPH, scopeGrid = SCOPE_GRID } = {}) {
  write(root, path.join(dir, 'tools', 'data', 'stage-graph.json'), stageGraph);
  write(root, path.join(dir, 'tools', 'data', 'scope-grid.json'), scopeGrid);
  write(root, path.join(dir, 'tools', 'data', 'harness.json'), { ...HARNESS_JSON, harnessDir: dir, distribution: dir.slice(1), productName: dir === '.claude' ? 'Claude Code' : dir.slice(1) });
  write(root, path.join(dir, 'tools', 'data', 'aidlc-stamp.json'), { ...STAMP_JSON, harnessDir: dir, distribution: dir.slice(1) });
  write(root, path.join(dir, 'scopes', 'aidlc-bugfix.md'), BUGFIX_SCOPE);
}
function claudeProject() {
  const root = tmp('issue5-claude-');
  configureFor(root, '.claude');
  fs.mkdirSync(path.join(root, 'aidlc', 'spaces', 'default', 'intents'), { recursive: true });
  return root;
}
function intentRecord(root, name, { manifest } = {}) {
  const intents = path.join('aidlc', 'spaces', 'default', 'intents');
  write(root, path.join(intents, name, 'aidlc-state.md'), '# AI-DLC State\n\n**Current Stage**: intent-capture\n');
  write(root, path.join(intents, name, 'runtime-graph.json'), {
    workflow_id: 'w1', scope: 'bugfix', started_at: '2026-11-28T02:00:00Z',
    stages: [{ stage_slug: 'workspace-detection', outcome: 'approved' }, { stage_slug: 'intent-capture', outcome: 'pending' }, { stage_slug: 'code-generation', outcome: 'pending' }]
  });
  if (manifest) write(root, path.join(intents, 'intents.json'), [{ uuid: 'u1', slug: 'fix-it', dirName: name, scope: 'bugfix', status: 'in_progress' }]);
}
function spaceShard(root) {
  write(root, path.join('aidlc', 'spaces', 'default', 'intents', 'audit', SPACE_SHARD_NAME), SPACE_SHARD);
}

// ---------------------------------------------------------------------------
// 1. The harness directory
// ---------------------------------------------------------------------------

test('the five harness directories are the ones the engine writes, .kiro first', () => {
  // From the 2.11.3 runtime tree: kiro and kiro-ide -> .kiro, claude -> .claude,
  // codex -> .codex, cursor -> .cursor, copilot and opencode -> .aidlc. `.kiro` first so a
  // project this extension set up reads exactly what it read before.
  assert.deepEqual(harness.HARNESS_DIRS, ['.kiro', '.claude', '.codex', '.cursor', '.aidlc']);
});

test('the harness directory is whichever one holds the stage graph, and .kiro wins a tie', () => {
  for (const dir of ['.claude', '.codex', '.cursor', '.aidlc']) {
    const root = tmp('issue5-dir-');
    configureFor(root, dir);
    assert.equal(harness.harnessDir(root), dir, `${dir} alone must be found`);
    assert.deepEqual(harness.harnessDataDir(root), [dir, 'tools', 'data']);
  }
  const both = tmp('issue5-both-');
  configureFor(both, '.claude');
  configureFor(both, '.kiro');
  assert.equal(harness.harnessDir(both), '.kiro');

  // A directory without the stage graph is not the harness directory, whatever else it holds.
  const stray = tmp('issue5-stray-');
  write(stray, path.join('.claude', 'settings.json'), {});
  write(stray, path.join('.claude', 'tools', 'data', 'scope-grid.json'), SCOPE_GRID);
  assert.equal(harness.harnessDir(stray), undefined);
  assert.equal(harness.harnessDataDir(stray), undefined);
  assert.equal(harness.readHarnessRecord(stray), undefined);
});

test('the harness record is the engine\'s own words: directory, distribution, product, version', () => {
  const root = claudeProject();
  assert.deepEqual(harness.readHarnessRecord(root), {
    dir: '.claude', distribution: 'claude', productName: 'Claude Code', version: '2.11.3'
  });
  // Records missing or unreadable: the directory is still known, the rest is not guessed.
  fs.unlinkSync(path.join(root, '.claude', 'tools', 'data', 'harness.json'));
  fs.writeFileSync(path.join(root, '.claude', 'tools', 'data', 'aidlc-stamp.json'), '{not json');
  assert.deepEqual(harness.readHarnessRecord(root), {
    dir: '.claude', distribution: undefined, productName: undefined, version: undefined
  });
});

// ---------------------------------------------------------------------------
// 2. Detection and the readers follow it
// ---------------------------------------------------------------------------

test('a project with only .claude/ is detected as v2, by its compiled data alone', () => {
  const root = tmp('issue5-detect-');
  configureFor(root, '.codex');
  const { generation, markers } = detect.detectGeneration(root);
  assert.equal(generation, detect.GENERATION.V2);
  assert.deepEqual(markers.v2, ['.codex/tools/data/stage-graph.json']);
  // The v1 `.aidlc/aidlc-rules` layout and the v2 `.aidlc/tools/data` layout stay distinct.
  const v1 = tmp('issue5-v1-');
  write(v1, path.join('.aidlc', 'aidlc-rules', 'core.md'), '# rules');
  assert.equal(detect.detectGeneration(v1).generation, detect.GENERATION.V1);
});

test('the stage graph and scope grid are read from the harness directory the project has', () => {
  const root = claudeProject();
  const stages = graph.readStageGraph(root);
  assert.equal(stages.stages.length, 3);
  assert.deepEqual(stages.stages.map((s) => s.slug), ['workspace-detection', 'intent-capture', 'code-generation']);
  const grid = graph.readScopeGrid(root);
  assert.deepEqual(Object.keys(grid.scopes).sort(), ['bugfix', 'poc']);

  // No harness directory: the readers say so the way they always have.
  const bare = tmp('issue5-bare-');
  assert.equal(graph.readStageGraph(bare), undefined);
  assert.equal(graph.readScopeGrid(bare), undefined);
});

test('readProject on a Claude Code project: ok, with its stages, scopes and intents', () => {
  const root = claudeProject();
  intentRecord(root, '261128-fix-it', { manifest: true });
  const project = readProject(root);
  assert.equal(project.generation, 'v2');
  assert.equal(project.v2.ok, true, JSON.stringify(project.v2));
  assert.equal(project.v2.stageCount, 3);
  assert.deepEqual(project.v2.scopeNames.sort(), ['bugfix', 'poc']);
  assert.equal(project.v2.intents.length, 1);
  assert.equal(project.v2.intents[0].id, '261128-fix-it');
});

test('the cache notices the harness directory appearing, and which one is read', () => {
  // The symptom before the fix was a cached `stage-graph-unreadable`; the stamp must move
  // when `.claude/tools/data/` arrives, and again when `.kiro/` arrives and takes over.
  const root = tmp('issue5-cache-');
  fs.mkdirSync(path.join(root, 'aidlc', 'spaces', 'default', 'intents'), { recursive: true });
  assert.equal(readProject(root).v2.ok, false);
  assert.equal(readProject(root).v2.reason, 'stage-graph-unreadable');

  configureFor(root, '.claude');
  assert.equal(readProject(root).v2.ok, true, 'the .claude data must be picked up on the next read');
  assert.equal(readProject(root).v2.stageCount, 3);

  // `.kiro` arrives with a different graph: it is read now, even though nothing the previous
  // stamp held (the .claude mtimes) changed.
  configureFor(root, '.kiro', { stageGraph: STAGE_GRAPH.slice(0, 2) });
  assert.equal(readProject(root).v2.stageCount, 2, '.kiro takes precedence once present');
});

test('the Start page scope rows read the scope files beside the data, in .claude/scopes', () => {
  const root = claudeProject();
  const rows = readScopeCatalogue(root);
  const bugfix = rows.find((r) => r.name === 'bugfix');
  assert.ok(bugfix);
  assert.equal(bugfix.description, 'Fix a specific bug');
  assert.equal(bugfix.depth, 'minimal');
  assert.equal(bugfix.reviewCap, 'advisory');
  assert.equal(bugfix.planApproval, 'on');
  // Counted without Initialization, as the engine's help counts.
  assert.equal(bugfix.run, 2);
  assert.equal(bugfix.total, 2);
});

// ---------------------------------------------------------------------------
// 3. intents/audit is a shard, not an intent
// ---------------------------------------------------------------------------

test('an intent record is a directory that holds aidlc-state.md; the space shard is not one', () => {
  const root = claudeProject();
  intentRecord(root, '261128-fix-it');
  spaceShard(root);
  write(root, path.join('aidlc', 'spaces', 'default', 'intents', 'half-made', 'notes.md'), '');
  const intentsDir = path.join(root, 'aidlc', 'spaces', 'default', 'intents');
  assert.equal(runtime.isIntentRecord(intentsDir, '261128-fix-it'), true);
  assert.equal(runtime.isIntentRecord(intentsDir, 'audit'), false);
  assert.equal(runtime.isIntentRecord(intentsDir, 'half-made'), false);
  assert.equal(runtime.isIntentRecord(intentsDir, '.aidlc-sensors'), false);
});

test('without intents.json, the directory walk lists the record and not the audit shard', () => {
  const root = claudeProject();
  intentRecord(root, '261128-fix-it');
  spaceShard(root);
  const listed = runtime.listIntents(root, 'default');
  assert.equal(listed.source, 'directory');
  assert.deepEqual(listed.intents.map((i) => i.id), ['261128-fix-it']);
  assert.deepEqual(listed.missingFromManifest, []);

  // The reporter's first symptom: a space whose only entry is the shard. No intent at all,
  // rather than one called `audit` with every stage pending.
  const shardOnly = claudeProject();
  spaceShard(shardOnly);
  assert.deepEqual(runtime.listIntents(shardOnly, 'default').intents, []);
  const project = readProject(shardOnly);
  assert.equal(project.v2.ok, true);
  assert.deepEqual(project.v2.intents, []);
});

test('with intents.json, the audit shard is not reported as missing from the manifest', () => {
  const root = claudeProject();
  intentRecord(root, '261128-fix-it', { manifest: true });
  spaceShard(root);
  const listed = runtime.listIntents(root, 'default');
  assert.equal(listed.source, 'manifest');
  assert.deepEqual(listed.intents.map((i) => i.id), ['261128-fix-it']);
  assert.deepEqual(listed.missingFromManifest, [], 'the reporter\'s second symptom');
  assert.deepEqual(listed.missingOnDisk, []);
  const project = readProject(root);
  assert.deepEqual(project.v2.gaps.diskMissingFromManifest, []);
  assert.deepEqual(project.v2.gaps.manifestMissingOnDisk, []);
});

// ---------------------------------------------------------------------------
// 4. The shell: the Start page names the harness the project is configured for
// ---------------------------------------------------------------------------

// Load extension.js with `vscode` stubbed far enough to open the Start page and capture
// its HTML; the installer module is replaced so nothing can run.
function loadController(root) {
  const EXTENSION = path.join(__dirname, '..', 'src', 'extension.js');
  const captured = { html: undefined };
  const uri = (p) => ({ fsPath: p, toString: () => `file://${p}` });
  const stub = {
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {}, ThemeColor: class {}, MarkdownString: class {},
    EventEmitter: class { constructor() { this.event = () => {}; this.fire = () => {}; } },
    FileType: {}, RelativePattern: class {}, ProgressLocation: {}, ViewColumn: { One: 1 },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    workspace: { workspaceFolders: [], fs: { stat: async () => ({ type: 2 }) } },
    window: {
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      createWebviewPanel: () => {
        const panel = { webview: { cspSource: 'vscode-webview:', asWebviewUri: (u) => u, onDidReceiveMessage: () => {} } };
        Object.defineProperty(panel.webview, 'html', { set(value) { captured.html = value; }, get() { return captured.html; } });
        return panel;
      }
    },
    commands: { executeCommand: async () => undefined }
  };
  const realLoad = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (request === 'vscode') return stub;
    if (request === './install-commands') return { setup: async () => {}, checkV2: async () => {}, removeV2: async () => {} };
    return realLoad.call(this, request, ...rest);
  };
  try {
    const loaded = new Module(EXTENSION);
    loaded.filename = EXTENSION;
    loaded.paths = Module._nodeModulePaths(path.dirname(EXTENSION));
    loaded._compile(`${fs.readFileSync(EXTENSION, 'utf8')}\nmodule.exports = { WatchController };`, EXTENSION);
    const store = new Map();
    const state = { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); } };
    const c = new loaded.exports.WatchController({ extensionUri: uri(path.join(__dirname, '..')), workspaceState: state, globalState: state });
    c.refresh = () => {};
    c.refreshSupervision = () => {};
    return { controller: c, captured };
  } finally {
    Module._load = realLoad;
  }
}

test('the Start page says which tool the project is configured for when it is not Kiro', () => {
  const claude = claudeProject();
  const a = loadController(claude);
  a.controller.showStartPage({ fsPath: claude }, 'v2');
  assert.match(a.captured.html, /Project configured for Claude Code: \.claude\/, aidlc\//);
  assert.doesNotMatch(a.captured.html, /\.kiro\/agents, hooks/);

  // A Kiro project reads as before.
  const kiro = tmp('issue5-start-kiro-');
  configureFor(kiro, '.kiro');
  fs.mkdirSync(path.join(kiro, 'aidlc', 'spaces'), { recursive: true });
  const b = loadController(kiro);
  b.controller.showStartPage({ fsPath: kiro }, 'v2');
  assert.match(b.captured.html, /Project configured: \.kiro\/agents, hooks, aidlc\//);
});
