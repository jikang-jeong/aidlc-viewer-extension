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
