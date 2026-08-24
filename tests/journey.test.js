'use strict';

// Journey model tests.
//
// Artifact lists below mirror the directory shapes of two REAL v1 projects
// (structure only, no customer content):
//   * a greenfield project with 2 units of work and Reverse Engineering skipped
//   * a brownfield project with 1 unit of work and Operations not reached
// Both shapes were read off real `aidlc-docs/` trees.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildJourney, checkpointIdForPath, CHECKPOINTS, STATUS } = require('../src/aidlc/journey');

function md(dir, names, mtime = 1000) {
  return names.map((name, i) => ({ relPath: `${dir}/${name}.md`, mtime: mtime + i }));
}

// Greenfield, 2 units, no reverse-engineering directory. Operations reached last.
const GREENFIELD = [
  ...md('inception/requirements', ['requirements', 'requirements-questions', 'clarification-round3'], 1000),
  ...md('inception/user-stories', ['stories', 'personas'], 1100),
  ...md('inception/plans', ['execution-plan', 'story-generation-plan', 'unit-of-work-plan'], 1200),
  ...md('inception/application-design', ['application-design', 'components', 'services'], 1300),
  ...md('inception/application-design', ['unit-of-work', 'unit-of-work-dependency'], 1400),
  ...md('construction/backend/functional-design', ['business-rules', 'domain-entities'], 1500),
  ...md('construction/frontend/functional-design', ['frontend-components'], 1510),
  ...md('construction/backend/nfr-requirements', ['nfr-requirements'], 1600),
  ...md('construction/frontend/nfr-requirements', ['nfr-requirements'], 1610),
  ...md('construction/backend/nfr-design', ['logical-components'], 1700),
  ...md('construction/frontend/nfr-design', ['logical-components'], 1710),
  ...md('construction/backend/infrastructure-design', ['infrastructure-design'], 1800),
  ...md('construction/frontend/infrastructure-design', ['infrastructure-design'], 1810),
  ...md('construction/backend/code', ['code-summary'], 1900),
  ...md('construction/frontend/code', ['code-summary'], 1910),
  ...md('construction/plans', ['backend-code-generation-plan'], 1920),
  ...md('construction/build-and-test', ['build-and-test-summary', 'build-instructions'], 2000),
  ...md('operations', ['product-handover'], 2100)
];

// Brownfield, 1 unit, stopped mid-construction, operations never started.
const BROWNFIELD = [
  ...md('inception/reverse-engineering', ['architecture', 'code-structure', 'api-documentation'], 1000),
  ...md('inception/requirements', ['requirements'], 1100),
  ...md('inception/user-stories', ['stories', 'personas'], 1200),
  ...md('inception/plans', ['execution-plan'], 1300),
  ...md('inception/application-design', ['application-design', 'component-dependencies'], 1400),
  ...md('inception/application-design', ['unit-of-work'], 1500),
  ...md('construction/bedrock-proxy/functional-design', ['business-rules'], 1600),
  ...md('construction/bedrock-proxy/nfr-requirements', ['nfr-requirements'], 1700),
  ...md('construction/bedrock-proxy/nfr-design', ['logical-components'], 1800),
  ...md('construction/bedrock-proxy/infrastructure-design', ['deployment-architecture'], 1900)
];

function byId(journey) {
  return new Map(journey.checkpoints.map((c) => [c.id, c]));
}

// ---------------------------------------------------------------------------
// Checkpoint list shape
// ---------------------------------------------------------------------------

test('there are 15 checkpoints in AI-DLC v1 stage order', () => {
  assert.equal(CHECKPOINTS.length, 15);
  assert.deepEqual(
    CHECKPOINTS.map((c) => c.id),
    [
      'setup-repo',
      'workspace-detection',
      'reverse-engineering',
      'requirements-analysis',
      'user-stories',
      'workflow-planning',
      'application-design',
      'units-generation',
      'functional-design',
      'nfr-requirements',
      'nfr-design',
      'infrastructure-design',
      'code-generation',
      'build-and-test',
      'operations'
    ]
  );
});

test('checkpoints carry the four phases used by the collapsed strip', () => {
  const phases = [...new Set(CHECKPOINTS.map((c) => c.phase))];
  assert.deepEqual(phases, ['setup', 'inception', 'construction', 'operations']);
});

// ---------------------------------------------------------------------------
// Path attribution
// ---------------------------------------------------------------------------

test('directory owns its artifacts regardless of filename drift', () => {
  // The rules say component-dependency.md; a real project emitted the plural.
  assert.equal(checkpointIdForPath('inception/application-design/component-dependencies.md'), 'application-design');
  assert.equal(checkpointIdForPath('inception/requirements/clarification-round3.md'), 'requirements-analysis');
});

test('unit-of-work* files split Units Generation from Application Design', () => {
  assert.equal(checkpointIdForPath('inception/application-design/unit-of-work.md'), 'units-generation');
  assert.equal(checkpointIdForPath('inception/application-design/unit-of-work-story-map.md'), 'units-generation');
  assert.equal(checkpointIdForPath('inception/application-design/services.md'), 'application-design');
});

test('execution-plan.md is the Workflow Planning artifact; other plans are unattributed', () => {
  assert.equal(checkpointIdForPath('inception/plans/execution-plan.md'), 'workflow-planning');
  assert.equal(checkpointIdForPath('inception/plans/story-generation-plan.md'), undefined);
  assert.equal(checkpointIdForPath('construction/plans/backend-code-generation-plan.md'), undefined);
});

test('per-unit construction directories map to their stage', () => {
  assert.equal(checkpointIdForPath('construction/bedrock-proxy/code/x.md'), 'code-generation');
  assert.equal(checkpointIdForPath('construction/bedrock-proxy/nfr-design/x.md'), 'nfr-design');
  assert.equal(checkpointIdForPath('construction/build-and-test/summary.md'), 'build-and-test');
});

test('non-markdown and out-of-shape paths are not attributed', () => {
  assert.equal(checkpointIdForPath('inception/requirements/diagram.png'), undefined);
  assert.equal(checkpointIdForPath('inception/requirements/nested/deeper.md'), undefined);
  assert.equal(checkpointIdForPath(''), undefined);
  assert.equal(checkpointIdForPath(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Greenfield project
// ---------------------------------------------------------------------------

test('greenfield: reverse engineering is SKIPPED, not pending', () => {
  const cp = byId(buildJourney({ artifacts: GREENFIELD }));
  assert.equal(cp.get('reverse-engineering').status, STATUS.SKIPPED);
});

test('greenfield: units are discovered from construction subdirectories', () => {
  const journey = buildJourney({ artifacts: GREENFIELD });
  assert.deepEqual(journey.units, ['backend', 'frontend']);
});

test('greenfield: per-unit stages are done only when every unit is covered', () => {
  const cp = byId(buildJourney({ artifacts: GREENFIELD }));
  for (const id of ['functional-design', 'nfr-requirements', 'nfr-design', 'infrastructure-design', 'code-generation']) {
    assert.equal(cp.get(id).status, STATUS.DONE, `${id} should be done`);
    assert.deepEqual(cp.get(id).unitProgress, { done: 2, total: 2 }, id);
  }
});

test('greenfield: workspace detection is inferred done from artifacts existing', () => {
  const cp = byId(buildJourney({ artifacts: GREENFIELD }));
  assert.equal(cp.get('workspace-detection').status, STATUS.DONE);
});

test('greenfield: current position is the newest attributed artifact', () => {
  const journey = buildJourney({ artifacts: GREENFIELD });
  assert.equal(journey.checkpoints[journey.currentIndex].id, 'operations');
});

test('greenfield: setup-repo reflects the caller-supplied flag', () => {
  assert.equal(byId(buildJourney({ artifacts: GREENFIELD })).get('setup-repo').status, STATUS.PENDING);
  assert.equal(
    byId(buildJourney({ artifacts: GREENFIELD, rulesInstalled: true })).get('setup-repo').status,
    STATUS.DONE
  );
});

// ---------------------------------------------------------------------------
// Brownfield project
// ---------------------------------------------------------------------------

test('brownfield: reverse engineering ran, so it is DONE', () => {
  const cp = byId(buildJourney({ artifacts: BROWNFIELD }));
  assert.equal(cp.get('reverse-engineering').status, STATUS.DONE);
});

test('brownfield: single unit, code generation not started yet', () => {
  const journey = buildJourney({ artifacts: BROWNFIELD });
  const cp = byId(journey);
  assert.deepEqual(journey.units, ['bedrock-proxy']);
  assert.equal(cp.get('infrastructure-design').status, STATUS.DONE);
  assert.equal(cp.get('code-generation').status, STATUS.PENDING);
});

test('brownfield: trailing checkpoints stay PENDING and are never marked skipped', () => {
  const cp = byId(buildJourney({ artifacts: BROWNFIELD }));
  assert.equal(cp.get('build-and-test').status, STATUS.PENDING);
  assert.equal(cp.get('operations').status, STATUS.PENDING);
});

test('brownfield: current position is infrastructure design', () => {
  const journey = buildJourney({ artifacts: BROWNFIELD });
  assert.equal(journey.checkpoints[journey.currentIndex].id, 'infrastructure-design');
});

// ---------------------------------------------------------------------------
// Partial construction and cursors
// ---------------------------------------------------------------------------

test('a per-unit stage covering some units is ACTIVE with unit progress', () => {
  const artifacts = [
    ...md('inception/requirements', ['requirements']),
    ...md('inception/application-design', ['unit-of-work']),
    ...md('construction/backend/code', ['summary'], 2000),
    ...md('construction/frontend/functional-design', ['fd'], 1500)
  ];
  const cp = byId(buildJourney({ artifacts }));
  assert.equal(cp.get('code-generation').status, STATUS.ACTIVE);
  assert.deepEqual(cp.get('code-generation').unitProgress, { done: 1, total: 2 });
  assert.deepEqual(cp.get('code-generation').unitsDone, ['backend']);
});

test('the open file maps to its own checkpoint, independent of current position', () => {
  const journey = buildJourney({
    artifacts: GREENFIELD,
    openFileRelPath: 'inception/requirements/requirements.md'
  });
  assert.equal(journey.checkpoints[journey.openIndex].id, 'requirements-analysis');
  assert.equal(journey.checkpoints[journey.currentIndex].id, 'operations');
  assert.notEqual(journey.openIndex, journey.currentIndex);
});

test('an unattributable open file yields openIndex -1', () => {
  const journey = buildJourney({
    artifacts: GREENFIELD,
    openFileRelPath: 'inception/plans/story-generation-plan.md'
  });
  assert.equal(journey.openIndex, -1);
});

test('units existing is evidence Units Generation happened, even without its artifact', () => {
  // Observed in a real project: construction/<unit>/ directories existed while
  // inception/application-design/unit-of-work*.md did not.
  const artifacts = [
    ...md('inception/requirements', ['requirements']),
    ...md('construction/gateway-ops/code', ['summary'], 2000),
    ...md('construction/krw-report/code', ['summary'], 2010)
  ];
  const journey = buildJourney({ artifacts });
  const cp = byId(journey);
  assert.deepEqual(journey.units, ['gateway-ops', 'krw-report']);
  assert.equal(cp.get('units-generation').artifactCount, 0);
  assert.equal(cp.get('units-generation').status, STATUS.DONE);
});

test('Units Generation stays skipped when no units and later stages ran', () => {
  const artifacts = [
    ...md('inception/requirements', ['requirements']),
    ...md('construction/build-and-test', ['summary'], 2000)
  ];
  const cp = byId(buildJourney({ artifacts }));
  assert.deepEqual(buildJourney({ artifacts }).units, []);
  assert.equal(cp.get('units-generation').status, STATUS.SKIPPED);
});

// ---------------------------------------------------------------------------
// Plan-file evidence
//
// Third real project shape: a unit had functional-design but no code/ directory,
// while construction/plans/<unit>-code-generation-plan.md existed AND
// build-and-test had completed. Artifact-only logic called Code Generation
// "skipped" for a project that demonstrably generated and built code.
// ---------------------------------------------------------------------------

const PLAN_EVIDENCED = [
  ...md('inception/requirements', ['requirements', 'requirement-verification-questions'], 1000),
  ...md('inception/plans', ['execution-plan', 'user-stories-assessment'], 1100),
  ...md('inception/application-design', ['application-design'], 1200),
  ...md('inception/application-design', ['unit-of-work'], 1300),
  ...md('construction/dashboard-app/functional-design', ['functional-design'], 1400),
  ...md('construction/plans', ['dashboard-app-code-generation-plan'], 1450),
  ...md('construction/build-and-test', ['build-and-test-summary'], 1500)
];

test('plan evidence + a later stage completing means the stage is DONE', () => {
  const cp = byId(buildJourney({ artifacts: PLAN_EVIDENCED }));
  const code = cp.get('code-generation');
  assert.equal(code.artifactCount, 0, 'the stage wrote no artifact of its own');
  assert.equal(code.planned, true, 'but its plan file exists');
  assert.equal(code.status, STATUS.DONE, 'and build-and-test has since completed');
  assert.deepEqual(code.unitsPlanned, ['dashboard-app']);
});

test('plan evidence with nothing after it means the stage is ACTIVE, not DONE', () => {
  const artifacts = PLAN_EVIDENCED.filter((a) => !a.relPath.startsWith('construction/build-and-test/'));
  const cp = byId(buildJourney({ artifacts }));
  assert.equal(cp.get('code-generation').status, STATUS.ACTIVE);
});

test('build-and-test never completes while code generation looks skipped', () => {
  // Guards the specific incoherence found in a real project.
  const journey = buildJourney({ artifacts: PLAN_EVIDENCED });
  const cp = byId(journey);
  assert.equal(cp.get('build-and-test').status, STATUS.DONE);
  assert.notEqual(cp.get('code-generation').status, STATUS.SKIPPED);
});

test('user-stories-assessment.md is NOT evidence that User Stories ran', () => {
  // The assessment records whether to run the stage, so it exists in projects
  // that decided to skip it.
  const cp = byId(buildJourney({ artifacts: PLAN_EVIDENCED }));
  assert.equal(cp.get('user-stories').status, STATUS.SKIPPED);
  assert.equal(cp.get('user-stories').planned, false);
});

test('story-generation-plan.md IS evidence that User Stories ran', () => {
  const artifacts = [...PLAN_EVIDENCED, ...md('inception/plans', ['story-generation-plan'], 1110)];
  const cp = byId(buildJourney({ artifacts }));
  assert.equal(cp.get('user-stories').planned, true);
  assert.equal(cp.get('user-stories').status, STATUS.DONE);
});

test('conditional design stages with neither artifact nor plan stay SKIPPED', () => {
  const cp = byId(buildJourney({ artifacts: PLAN_EVIDENCED }));
  for (const id of ['nfr-requirements', 'nfr-design', 'infrastructure-design']) {
    assert.equal(cp.get(id).status, STATUS.SKIPPED, id);
    assert.equal(cp.get(id).planned, false, id);
  }
});

// ---------------------------------------------------------------------------
// Shapes found only after widening the sample beyond the first projects.
// Each block below exists because a real project broke the model here.
// ---------------------------------------------------------------------------

test('units are discovered from flat unit directories with no stage subdirectory', () => {
  // Real shape: construction/U1-foundation/unit-design.md for five units, with no
  // functional-design/ or code/ subdirectories at all.
  const artifacts = [
    ...md('inception/requirements', ['requirements']),
    { relPath: 'construction/U1-foundation/unit-design.md', mtime: 1500 },
    { relPath: 'construction/U2-client/unit-design.md', mtime: 1510 },
    ...md('construction/build-and-test', ['build-and-test-summary'], 1600)
  ];
  const journey = buildJourney({ artifacts });
  assert.deepEqual(journey.units, ['U1-foundation', 'U2-client']);
  assert.deepEqual(byId(journey).get('code-generation').unitProgress, { done: 0, total: 2 });
});

test('an unrecognised artifact shape is surfaced, never silently dropped', () => {
  const journey = buildJourney({
    artifacts: [
      { relPath: 'construction/U1-foundation/unit-design.md', mtime: 1 },
      { relPath: 'construction/plans/code-generation-plan.md', mtime: 2 },
      { relPath: 'audit.md', mtime: 3 },
      { relPath: 'aidlc-state.md', mtime: 4 }
    ]
  });
  // Plans and bookkeeping are expected to be unattributed; the flat unit file is not.
  assert.deepEqual(journey.unattributed, ['construction/U1-foundation/unit-design.md']);
});

test('unattributed is sorted so the UI list is stable across filesystems', () => {
  const journey = buildJourney({
    artifacts: [
      { relPath: 'construction/U3-work/unit-design.md', mtime: 3 },
      { relPath: 'construction/U1-foundation/unit-design.md', mtime: 1 },
      { relPath: 'construction/U2-client/unit-design.md', mtime: 2 }
    ]
  });
  assert.deepEqual(journey.unattributed, [
    'construction/U1-foundation/unit-design.md',
    'construction/U2-client/unit-design.md',
    'construction/U3-work/unit-design.md'
  ]);
});

test('POLICY: unattributed artifacts are never guessed into a checkpoint', () => {
  // Locks the deliberate decision documented in the module header. If a future
  // change maps unit-design.md (a filename the AI-DLC rules never mandate) to a
  // stage, this test should be changed only with a mandated filename to rely on.
  const artifacts = [
    ...md('inception/requirements', ['requirements'], 1000),
    { relPath: 'construction/U1-foundation/unit-design.md', mtime: 1500 },
    ...md('construction/build-and-test', ['build-and-test-summary'], 1600)
  ];
  const journey = buildJourney({ artifacts });
  const cp = byId(journey);
  assert.equal(cp.get('functional-design').artifactCount, 0, 'not guessed into functional design');
  assert.equal(cp.get('functional-design').status, STATUS.SKIPPED);
  assert.equal(journey.unattributed.length, 1, 'reported instead');
  assert.deepEqual(journey.units, ['U1-foundation'], 'but the unit is still discovered');
});

test('a plan filename without a unit prefix still counts as evidence', () => {
  // Real shape: construction/plans/code-generation-plan.md (no `<unit>-` prefix).
  const artifacts = [
    ...md('inception/requirements', ['requirements']),
    { relPath: 'construction/U1-foundation/unit-design.md', mtime: 1500 },
    { relPath: 'construction/plans/code-generation-plan.md', mtime: 1550 },
    ...md('construction/build-and-test', ['build-and-test-summary'], 1600)
  ];
  const cp = byId(buildJourney({ artifacts }));
  assert.equal(cp.get('code-generation').planned, true);
  assert.equal(cp.get('code-generation').status, STATUS.DONE);
});

test('audit.md and aidlc-state.md are never stage artifacts, wherever they sit', () => {
  // Real shape: a copy of audit.md inside operations/ made Operations look complete.
  const artifacts = [
    ...md('inception/requirements', ['requirements']),
    ...md('construction/build-and-test', ['build-and-test-summary'], 1600),
    { relPath: 'operations/audit.md', mtime: 1700 },
    { relPath: 'audit.md', mtime: 1710 },
    { relPath: 'aidlc-state.md', mtime: 1720 }
  ];
  const cp = byId(buildJourney({ artifacts }));
  assert.equal(cp.get('operations').artifactCount, 0);
  assert.equal(cp.get('operations').status, STATUS.PENDING);
});

test('current position is the furthest evidenced checkpoint, not the newest file', () => {
  // Real shape: execution-plan.md was edited six days after the workflow ended,
  // which made an mtime cursor jump backwards to Workflow planning.
  const artifacts = [
    ...md('inception/requirements', ['requirements'], 1000),
    ...md('construction/build-and-test', ['build-and-test-summary'], 1100),
    { relPath: 'inception/plans/execution-plan.md', mtime: 9999 }
  ];
  const journey = buildJourney({ artifacts });
  assert.equal(journey.checkpoints[journey.currentIndex].id, 'build-and-test');
  assert.equal(journey.checkpoints[journey.recentIndex].id, 'workflow-planning');
  assert.notEqual(journey.currentIndex, journey.recentIndex);
});

// ---------------------------------------------------------------------------
// Operations is a placeholder in AI-DLC v1
// ---------------------------------------------------------------------------

test('Operations is flagged as a placeholder', () => {
  const cp = byId(buildJourney({ artifacts: GREENFIELD }));
  assert.equal(cp.get('operations').placeholder, true);
  // No other checkpoint is a placeholder.
  const flagged = buildJourney({ artifacts: GREENFIELD }).checkpoints.filter((c) => c.placeholder);
  assert.deepEqual(flagged.map((c) => c.id), ['operations']);
});

test('an unreached Operations placeholder is excluded from plannedTotal', () => {
  // v1 rules: "The AI-DLC workflow currently ends after the Build and Test phase
  // in CONSTRUCTION." A project that finished Build and Test must read complete.
  const artifacts = [
    ...md('inception/requirements', ['requirements'], 1000),
    ...md('inception/application-design', ['unit-of-work'], 1100),
    ...md('construction/backend/code', ['summary'], 1200),
    ...md('construction/build-and-test', ['summary'], 1300)
  ];
  const journey = buildJourney({ artifacts, rulesInstalled: true });
  const cp = byId(journey);
  assert.equal(cp.get('operations').status, STATUS.PENDING);
  assert.equal(journey.counts.done, journey.plannedTotal, 'should read as complete');
});

test('Operations counts toward plannedTotal once it produces artifacts', () => {
  const withOps = buildJourney({ artifacts: [...GREENFIELD] });
  assert.equal(byId(withOps).get('operations').status, STATUS.DONE);
  const withoutOps = buildJourney({ artifacts: GREENFIELD.filter((a) => !a.relPath.startsWith('operations/')) });
  assert.equal(withOps.plannedTotal, withoutOps.plannedTotal + 1);
});

test('plannedTotal excludes skipped stages as well', () => {
  const journey = buildJourney({ artifacts: GREENFIELD });
  assert.equal(
    journey.plannedTotal,
    journey.checkpoints.length - journey.counts.skipped,
    'greenfield reached Operations, so only the skipped stage is excluded'
  );
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

test('an empty project has no skipped checkpoints and no current position', () => {
  const journey = buildJourney({ artifacts: [] });
  assert.equal(journey.currentIndex, -1);
  assert.equal(journey.counts.skipped, 0);
  assert.equal(journey.counts.done, 0);
  assert.equal(journey.counts.pending, 15);
});

test('malformed input degrades instead of throwing', () => {
  for (const bad of [undefined, {}, { artifacts: null }, { artifacts: [{}, { relPath: 42 }] }]) {
    const journey = buildJourney(bad);
    assert.equal(journey.checkpoints.length, 15);
    assert.equal(journey.currentIndex, -1);
  }
});

test('status counts always sum to the checkpoint count', () => {
  for (const artifacts of [GREENFIELD, BROWNFIELD, []]) {
    const journey = buildJourney({ artifacts });
    const total = Object.values(journey.counts).reduce((a, b) => a + b, 0);
    assert.equal(total, 15);
  }
});
