'use strict';

// Guards the two places where v2 support reached into code the v1 path uses.
//
// The tree's phase grouping used to be ordered by a hardcoded
// ['setup', 'inception', 'construction', 'operations']. That list cannot express
// v2, which compiles its own phase names per project, so ordering now comes from
// the order the checkpoints are already in. The v1 result must be unchanged, and
// "must be unchanged" is worth a test rather than an assurance: the phase rows in
// the tree are what 3,000 users read to see where a project is.
//
// The adapter is the second reach-in. It is handed the v1 journey and must give
// back that same object for a v1 project, so nothing downstream can alter the v1
// path even by accident.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CHECKPOINTS, buildJourney, PHASE } = require('../src/aidlc/journey');
const { readProject, GENERATION } = require('../src/aidlc/index');

// The grouping the tree performs, lifted out of extension.js so it can be tested
// without vscode. Kept deliberately identical to the code there.
function groupByPhaseInCheckpointOrder(checkpoints) {
  const byPhase = new Map();
  for (const cp of checkpoints) {
    if (!byPhase.has(cp.phase)) byPhase.set(cp.phase, []);
    byPhase.get(cp.phase).push(cp);
  }
  return [...byPhase].map(([phase, nodes]) => ({ phase, nodes }));
}

// The order that used to be hardcoded.
const LEGACY_ORDER = ['setup', 'inception', 'construction', 'operations'];

test('v1 phase order is unchanged by deriving it from checkpoint order', () => {
  const journey = buildJourney({ artifacts: [], rulesInstalled: false });
  const derived = groupByPhaseInCheckpointOrder(journey.checkpoints).map((g) => g.phase);
  const legacy = LEGACY_ORDER.filter((phase) =>
    journey.checkpoints.some((cp) => cp.phase === phase)
  );
  assert.deepEqual(derived, legacy);
});

test('v1 phase order holds for a project with artifacts in every phase', () => {
  // A journey where each phase has produced something, so no phase can be
  // missing from the grouping and the orders are compared in full.
  const artifacts = [
    { relPath: 'inception/requirements/requirements.md', mtime: 1 },
    { relPath: 'construction/plans/unit-plan.md', mtime: 2 },
    { relPath: 'operations/review-checklist.md', mtime: 3 }
  ];
  const journey = buildJourney({ artifacts, rulesInstalled: true });
  const derived = groupByPhaseInCheckpointOrder(journey.checkpoints).map((g) => g.phase);
  assert.deepEqual(derived, LEGACY_ORDER);
});

test('v1 checkpoints are declared in phase order, which is why deriving works', () => {
  // If a future edit interleaved the checkpoint list, derived order would stop
  // matching the legacy order and the test above would fail without saying why.
  // This states the underlying property directly.
  let lastIndex = -1;
  for (const cp of CHECKPOINTS) {
    const index = LEGACY_ORDER.indexOf(cp.phase);
    assert.notEqual(index, -1, `checkpoint ${cp.id} has phase "${cp.phase}" outside the v1 set`);
    assert.ok(index >= lastIndex, `checkpoint ${cp.id} breaks phase grouping order`);
    lastIndex = index;
  }
});

test('grouping keeps every checkpoint exactly once', () => {
  const journey = buildJourney({ artifacts: [], rulesInstalled: false });
  const grouped = groupByPhaseInCheckpointOrder(journey.checkpoints);
  const flattened = grouped.flatMap((g) => g.nodes);
  assert.equal(flattened.length, journey.checkpoints.length);
  assert.deepEqual(
    flattened.map((cp) => cp.id),
    journey.checkpoints.map((cp) => cp.id)
  );
});

test('grouping copes with a phase list it has never seen', () => {
  // The reason the hardcoded list had to go: a v2 project names its phases in its
  // own compiled graph, and a name not on a list would have been dropped from the
  // tree entirely.
  const invented = [
    { id: 'a', phase: 'discovery' },
    { id: 'b', phase: 'discovery' },
    { id: 'c', phase: 'shaping' },
    { id: 'd', phase: 'hardening' }
  ];
  const grouped = groupByPhaseInCheckpointOrder(invented);
  assert.deepEqual(grouped.map((g) => g.phase), ['discovery', 'shaping', 'hardening']);
  assert.deepEqual(grouped.map((g) => g.nodes.length), [2, 1, 1]);
});

test('grouping drops a phase the scope skipped in full, and never drops a v1 phase', () => {
  // A "0/0, 7 skipped" row asks the reader what is missing when the answer is
  // that the project was never going to run that phase. v1 has no scope
  // mechanism, so this filter cannot remove anything from a v1 tree.
  const withSkippedPhase = [
    { id: 'a', phase: 'ideation', status: 'done' },
    { id: 'b', phase: 'operation', status: 'skipped' },
    { id: 'c', phase: 'operation', status: 'skipped' }
  ];
  const kept = groupByPhaseInCheckpointOrder(withSkippedPhase)
    .filter((g) => g.nodes.some((cp) => cp.status !== 'skipped'))
    .map((g) => g.phase);
  assert.deepEqual(kept, ['ideation']);

  const v1 = buildJourney({ artifacts: [], rulesInstalled: false });
  const v1Kept = groupByPhaseInCheckpointOrder(v1.checkpoints)
    .filter((g) => g.nodes.some((cp) => cp.status !== 'skipped'))
    .map((g) => g.phase);
  assert.deepEqual(v1Kept, LEGACY_ORDER);
});

// ---------------------------------------------------------------------------
// The adapter must not touch the v1 path
// ---------------------------------------------------------------------------

function tempDir(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-v1-guard-'));
  build(root);
  return root;
}

test('adapter returns the v1 journey object itself for a v1 project', () => {
  const root = tempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'aidlc-docs', 'inception'), { recursive: true });
  });
  const v1Journey = buildJourney({ artifacts: [], rulesInstalled: true });
  const result = readProject(root, { v1Journey });
  assert.equal(result.generation, GENERATION.V1);
  // Identity, not deep equality: proving the adapter did not rebuild or reshape it.
  assert.strictEqual(result.journey, v1Journey);
  assert.equal(result.v2, undefined);
});

test('adapter returns the v1 journey for a folder that is not AI-DLC at all', () => {
  const root = tempDir(() => {});
  const v1Journey = buildJourney({ artifacts: [], rulesInstalled: false });
  const result = readProject(root, { v1Journey });
  assert.equal(result.generation, GENERATION.NONE);
  assert.strictEqual(result.journey, v1Journey);
});

test('adapter falls back to the v1 journey when a v2 install is unreadable', () => {
  // A v2 marker present but no compiled stage graph. The tree must still render.
  const root = tempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'aidlc', 'spaces'), { recursive: true });
  });
  const v1Journey = buildJourney({ artifacts: [], rulesInstalled: false });
  const result = readProject(root, { v1Journey });
  assert.equal(result.generation, GENERATION.V2);
  assert.equal(result.v2.ok, false);
  assert.strictEqual(result.journey, v1Journey);
});

test('a project carrying both generations prefers v2 but still reports v1 markers', () => {
  const root = tempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'aidlc-docs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'aidlc', 'spaces'), { recursive: true });
  });
  const result = readProject(root, { v1Journey: undefined });
  assert.equal(result.generation, GENERATION.BOTH);
  assert.ok(result.markers.v1.length > 0);
  assert.ok(result.markers.v2.length > 0);
});

test('the v1 phase vocabulary is still exactly what the colour map covers', () => {
  // getStageColor in extension.js assigns a tone per phase name. This pins the v1
  // set so a rename there cannot silently grey out a phase row.
  const phases = new Set(CHECKPOINTS.map((cp) => cp.phase));
  assert.deepEqual([...phases].sort(), [...LEGACY_ORDER].sort());
  assert.deepEqual(
    [PHASE.SETUP, PHASE.INCEPTION, PHASE.CONSTRUCTION, PHASE.OPERATIONS],
    LEGACY_ORDER
  );
});

// ---------------------------------------------------------------------------
// The tree's summary row must key on the generation, not on the journey
// ---------------------------------------------------------------------------

// The predicate extension.js uses to decide whether the summary row falls back to
// the journey, lifted out so it can be tested without vscode. Kept identical.
function usesJourney(summary) {
  if (!summary || summary.generation !== 'v2') return false;
  const journey = summary.journey;
  if (!journey || !Array.isArray(journey.checkpoints)) return false;
  const index = journey.currentIndex;
  return typeof index === 'number' && index >= 0 && index < journey.checkpoints.length;
}

test('the summary row falls back to the journey only for v2', () => {
  // A v1 journey answers too, so a first attempt keyed on "does the journey say
  // anything" and rewrote the label, description and tooltip a v1 project shows.
  // That is the regression this whole layer exists to avoid, so the gate is the
  // generation.
  const withArtifacts = buildJourney({
    artifacts: [{ relPath: 'inception/requirements/requirements.md', mtime: 1 }],
    rulesInstalled: true
  });
  assert.ok(withArtifacts.currentIndex >= 0, 'a v1 journey does report a position');

  assert.equal(usesJourney({ generation: 'v1', journey: withArtifacts }), false);
  assert.equal(usesJourney({ generation: 'none', journey: withArtifacts }), false);
  assert.equal(usesJourney({ generation: undefined, journey: withArtifacts }), false);
  assert.equal(usesJourney({ generation: 'v2', journey: withArtifacts }), true);
});

test('the summary row does not fall back when a v2 project has not started', () => {
  const nothing = buildJourney({ artifacts: [], rulesInstalled: false });
  assert.equal(nothing.currentIndex, -1);
  assert.equal(usesJourney({ generation: 'v2', journey: nothing }), false);
});

test('the summary row survives a journey that is absent or malformed', () => {
  for (const journey of [undefined, null, {}, { checkpoints: 'no' }, { checkpoints: [] }]) {
    assert.equal(usesJourney({ generation: 'v2', journey }), false);
  }
});

// ---------------------------------------------------------------------------
// Reading must stay cheap enough to sit on the tree's refresh path
// ---------------------------------------------------------------------------

test('a repeat read of an unchanged project does not re-parse the ledger', () => {
  // The uncached read measured 25-35ms on three real runs, dominated by parsing a
  // ~330KB append-only ledger, and it is called on every tree refresh and panel
  // update. Uncached that is 30ms of the extension host's only thread each time a
  // file watcher fires while a workflow is running.
  const root = tempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.kiro', 'tools', 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.kiro', 'tools', 'data', 'stage-graph.json'),
      JSON.stringify([{ slug: 'a', name: 'A', phase: 'p' }])
    );
    const intent = path.join(dir, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
    fs.mkdirSync(path.join(intent, 'audit'), { recursive: true });
    fs.writeFileSync(
      path.join(intent, 'runtime-graph.json'),
      JSON.stringify({ scope: 's', stages: [] })
    );
    fs.writeFileSync(
      path.join(intent, 'audit', 'shard.md'),
      '**Event**: HUMAN_TURN\n**Timestamp**: 2026-01-01T00:00:00Z'
    );
  });

  const first = readProject(root, {});
  const second = readProject(root, {});
  // Identity of the cached model proves the second call did no work, which a
  // timing assertion could not do reliably on a loaded machine.
  assert.strictEqual(first.v2, second.v2);
});

test('appending to the ledger invalidates the cache', () => {
  // The signature covers each shard's size as well as its mtime, because a shard
  // appended to within the same millisecond as the previous read would otherwise
  // be missed. The ledger is append-only, so size always moves.
  const root = tempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.kiro', 'tools', 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.kiro', 'tools', 'data', 'stage-graph.json'),
      JSON.stringify([{ slug: 'a', name: 'A', phase: 'p' }])
    );
    const intent = path.join(dir, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
    fs.mkdirSync(path.join(intent, 'audit'), { recursive: true });
    fs.writeFileSync(
      path.join(intent, 'runtime-graph.json'),
      JSON.stringify({ scope: 's', stages: [] })
    );
    fs.writeFileSync(
      path.join(intent, 'audit', 'shard.md'),
      '**Event**: HUMAN_TURN\n**Timestamp**: 2026-01-01T00:00:00Z'
    );
  });
  const shard = path.join(
    root, 'aidlc', 'spaces', 'default', 'intents', '260101-x', 'audit', 'shard.md'
  );

  assert.equal(readProject(root, {}).v2.active.diagnosis.eventTotal, 1);
  fs.appendFileSync(
    shard,
    '\n---\n**Event**: GATE_APPROVED\n**Timestamp**: 2026-01-01T00:00:01Z\n**Stage**: a'
  );
  assert.equal(readProject(root, {}).v2.active.diagnosis.eventTotal, 2);
});

test('a v1 project is never cached, because its journey is rebuilt by the caller', () => {
  const root = tempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'aidlc-docs'), { recursive: true });
  });
  const a = buildJourney({ artifacts: [], rulesInstalled: true });
  const b = buildJourney({ artifacts: [], rulesInstalled: true });
  assert.strictEqual(readProject(root, { v1Journey: a }).journey, a);
  assert.strictEqual(readProject(root, { v1Journey: b }).journey, b);
});

// ---------------------------------------------------------------------------
// The renderers, compared against 0.0.19's own code
// ---------------------------------------------------------------------------
//
// Every v2 change that adds a field ends up read by a renderer, and a renderer that
// reads it for v1 too changes what three thousand people see. That has now happened
// twice in development: once when the tree summary row branched on whether a journey
// existed, and once when a label branched on `conditional`, which v1 also sets.
//
// So these tests do not check that v1's data is unchanged -- other tests do that.
// They extract the label-deciding code from 0.0.19's extension.js and from the
// current one, run both over identical v1 journeys, and require the answers to match.
// Re-implementing the logic in the test would prove only that the test agrees with
// itself.

const RELEASED = 'e17e4ad'; // v0.0.19

// extension.js requires `vscode`, so it is compiled with that module stubbed and the
// internals under test exported. Nothing here touches the editor or the filesystem.
function loadExtensionInternals() {
  const Module = require('module');
  const file = path.join(__dirname, '..', 'src', 'extension.js');
  const realLoad = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (request !== 'vscode') return realLoad.call(this, request, ...rest);
    return {
      TreeItem: class {
        constructor(label) {
          this.label = label;
        }
      },
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: class {},
      ThemeColor: class {},
      MarkdownString: class {
        constructor(value) {
          this.value = value;
        }
      },
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
      FileType: {},
      RelativePattern: class {},
      ProgressLocation: {}
    };
  };
  try {
    const loaded = new Module(file);
    loaded.filename = file;
    loaded.paths = Module._nodeModulePaths(path.dirname(file));
    loaded._compile(
      `${fs.readFileSync(file, 'utf8')}
module.exports = { currentPhaseFromJourney, buildStageTooltip, isIgnoredEventPath, shouldSkipDirectory };`,
      file
    );
    return loaded.exports;
  } finally {
    Module._load = realLoad;
  }
}

function releasedExtensionSource() {
  const { execFileSync } = require('child_process');
  return execFileSync('git', ['show', `${RELEASED}:src/extension.js`], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
}

function currentExtensionSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
}

// The webview's per-stage tag block, lifted out and made callable.
function tagFunctionFrom(source) {
  const start = source.indexOf("let tag = '';");
  assert.notEqual(start, -1, 'the tag block moved; this test needs updating');
  const end = source.indexOf('if (tag) {', start);
  assert.ok(end > start, 'the end of the tag block moved');
  const body = source.slice(start, end).replace(/entry\.cp/g, 'cp');
  // eslint-disable-next-line no-new-func
  return new Function('cp', `${body}\nreturn tag;`);
}

// The segment tooltip's state phrase, lifted out the same way.
function tooltipStateFrom(source) {
  const labelLine = source.slice(
    source.indexOf('const STATE_LABEL ='),
    source.indexOf('\n', source.indexOf('const STATE_LABEL ='))
  );
  const fn = source.indexOf('function tooltipFor(');
  assert.notEqual(fn, -1, 'tooltipFor moved; this test needs updating');
  const bodyStart = source.indexOf('{', fn);
  const stop = source.indexOf('bits.push(PHASE_LABEL', bodyStart);
  const block = source.slice(bodyStart + 1, stop);
  // eslint-disable-next-line no-new-func
  return new Function(
    'cp',
    'index',
    'journey',
    'PHASE_LABEL',
    `${labelLine}\n${block}\nreturn bits.join(' | ');`
  );
}

const V1_LAYOUTS = [
  [],
  [{ relPath: 'inception/requirements/requirements.md', mtime: 1 }],
  [
    { relPath: 'construction/plans/u1-plan.md', mtime: 1 },
    { relPath: 'construction/alpha/functional-design.md', mtime: 2 },
    { relPath: 'construction/beta/functional-design.md', mtime: 3 }
  ],
  [{ relPath: 'operations/review.md', mtime: 1 }],
  [
    { relPath: 'inception/x.md', mtime: 1 },
    { relPath: 'construction/y/z.md', mtime: 2 },
    { relPath: 'unrecognised/u.md', mtime: 3 }
  ]
];

function everyV1Journey() {
  const journeys = [];
  for (const artifacts of V1_LAYOUTS) {
    for (const rulesInstalled of [false, true]) {
      journeys.push(buildJourney({ artifacts, rulesInstalled }));
    }
  }
  return journeys;
}

test("the strip's per-stage tag is identical to 0.0.19 on every v1 layout", () => {
  const before = tagFunctionFrom(releasedExtensionSource());
  const after = tagFunctionFrom(currentExtensionSource());
  let compared = 0;
  for (const journey of everyV1Journey()) {
    for (const cp of journey.checkpoints) {
      compared += 1;
      assert.equal(
        after(cp),
        before(cp),
        `tag changed for ${cp.id}: 0.0.19 said "${before(cp)}", now "${after(cp)}"`
      );
    }
  }
  assert.ok(compared > 100, `only ${compared} checkpoints compared`);
});

test("the segment tooltip's state phrase is identical to 0.0.19 on every v1 layout", () => {
  const before = tooltipStateFrom(releasedExtensionSource());
  const after = tooltipStateFrom(currentExtensionSource());
  for (const journey of everyV1Journey()) {
    journey.checkpoints.forEach((cp, index) => {
      assert.equal(
        after(cp, index, journey, {}),
        before(cp, index, journey, {}),
        `tooltip changed for ${cp.id}`
      );
    });
  }
});

test('v1 carries none of the fields the v2 labels are keyed off', () => {
  // The mechanism that keeps the two tests above passing. A v2 change may add a field
  // and read it in a renderer; it may not add one v1 also produces. `conditional` is
  // the counterexample that proves the rule -- v1 sets it, which is why the label
  // reads `mayNotRun` instead.
  for (const journey of everyV1Journey()) {
    for (const cp of journey.checkpoints) {
      assert.ok(!('outOfScope' in cp), `v1 checkpoint has outOfScope: ${cp.id}`);
      assert.ok(!('mayNotRun' in cp), `v1 checkpoint has mayNotRun: ${cp.id}`);
    }
  }
});

test('the v2-only tooltip branch is unreachable from a v1 journey', () => {
  // buildStageTooltip reports scope figures that would all be meaningless for v1, and
  // it is gated on the phase lookup rather than on the presence of a journey -- a v1
  // journey answers that question too, which is how the first attempt at this leaked.
  const { currentPhaseFromJourney } = loadExtensionInternals();
  for (const journey of everyV1Journey()) {
    const summary = {
      generation: 'v1',
      journey,
      currentStage: 'inception',
      counts: { inception: 1, construction: 0, operations: 0 }
    };
    assert.equal(
      currentPhaseFromJourney(summary),
      undefined,
      'a v1 summary reached the v2 tooltip branch'
    );
  }
});

// ---------------------------------------------------------------------------
// Which file events must refresh
// ---------------------------------------------------------------------------

test("v2's evidence lives in dot-directories, and events there must still refresh", () => {
  // Reported as "the agent said the sensors fired and it re-ran them, and the panel
  // showed the same thing". It did. v2 keeps the compiled graphs and runtime state
  // under .kiro/tools/data/ and each sensor's findings under .aidlc-sensors/, and the
  // watcher was dropping events under any dot-directory -- so the two most
  // authoritative inputs to the strip and the panel could change with nothing asking
  // the reader to look again.
  //
  // The audit ledger was the exception that hid it: it sits in a plain `audit/`
  // directory, so ledger-driven figures did update while graph-driven ones did not.
  const { isIgnoredEventPath } = loadExtensionInternals();
  const root = { fsPath: '/p' };
  const ignored = (rel) => isIgnoredEventPath(root, { fsPath: `/p/${rel}` });

  for (const rel of [
    '.kiro/tools/data/runtime-graph.json',
    '.kiro/tools/data/stage-graph.json',
    '.kiro/tools/data/scope-grid.json',
    'aidlc/spaces/default/intents/i1/.aidlc-sensors/intent-capture/claim-sources-abc.md',
    'aidlc/spaces/default/intents/i1/audit/shard.md'
  ]) {
    assert.equal(ignored(rel), false, `a v2 evidence path is being ignored: ${rel}`);
  }
});

test('the directories that were noisy are still ignored', () => {
  // The rule this loosens exists for a reason: a refresh per object written into .git
  // during a rebase is worth nothing, because the tree never shows any of it.
  const { isIgnoredEventPath } = loadExtensionInternals();
  const root = { fsPath: '/p' };
  const ignored = (rel) => isIgnoredEventPath(root, { fsPath: `/p/${rel}` });

  for (const rel of [
    '.git/objects/ab/cdef',
    '.git/refs/heads/main',
    'node_modules/pkg/index.js',
    '.vscode/settings.json',
    '.idea/workspace.xml',
    'dist/bundle.js',
    'build/out.js',
    'coverage/lcov.info',
    '.venv/lib/python3.12/site-packages/x.py',
    '__pycache__/m.cpython-312.pyc',
    'target/debug/app'
  ]) {
    assert.equal(ignored(rel), true, `a noisy path is no longer ignored: ${rel}`);
  }
});

test('v1 paths are unaffected by the dot-directory exception', () => {
  // v1 keeps its rules under .kiro/ too, so this widened what triggers a refresh for
  // v1 as well. Nothing v1 displays changes: the tree still excludes .kiro/ from
  // rendering, so the effect is that a refresh recomputes the same answer -- and only
  // when rule files change, which is at setup.
  const { isIgnoredEventPath, shouldSkipDirectory } = loadExtensionInternals();
  const root = { fsPath: '/p' };

  for (const rel of [
    'aidlc-docs/inception/requirements.md',
    'aidlc-docs/construction/plans/u1-plan.md',
    '.kiro/steering/aws-aidlc-rules/core-workflow.md',
    '.kiro/aws-aidlc-rule-details/common/x.md'
  ]) {
    assert.equal(isIgnoredEventPath(root, { fsPath: `/p/${rel}` }), false, rel);
  }

  // And the tree's own filter is untouched, which is what keeps .kiro/ off screen.
  assert.equal(shouldSkipDirectory('.kiro'), true);
  assert.equal(shouldSkipDirectory('.aidlc-sensors'), true);
  assert.equal(shouldSkipDirectory('aidlc-docs'), false);
});
