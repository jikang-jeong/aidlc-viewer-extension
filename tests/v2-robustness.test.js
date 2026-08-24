'use strict';

// Robustness contract for the v2 readers.
//
// The requirement these tests encode is not "parse correctly". It is: NO INPUT
// MAY THROW. A reader that crashes on an unfamiliar file takes the whole tree
// view down with it, and the whole point of this layer is that a project which
// exercises an unfamiliar corner of the engine still renders -- reporting the
// corner as a gap instead of failing.
//
// So every case below feeds something deliberately hostile: a truncated file, a
// value of the wrong type, an unknown enum, a field renamed, a shape the engine
// has never actually produced. The assertion is always the same two parts: it
// returned, and it told us what it did not understand.
//
// Fixtures are SYNTHESISED here, never copied from a real project. This is a
// public repository and real runs contain customer intent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const detect = require('../src/aidlc/detect');
const graph = require('../src/aidlc/graph');
const runtime = require('../src/aidlc/runtime');
const audit = require('../src/aidlc/audit');
const { diagnose } = require('../src/aidlc/diagnose');
const {
  buildV2, buildFromStages, V2_STATUS, checkpointIndexForPath
} = require('../src/aidlc/journey-v2');

// ---------------------------------------------------------------------------
// Fixture builder: writes a minimal v2 project into a temp dir.
// ---------------------------------------------------------------------------

function makeProject(spec = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-robust-'));
  const write = (relPath, contents) => {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
  };

  fs.mkdirSync(path.join(root, 'aidlc', 'spaces'), { recursive: true });
  write(path.join('.kiro', 'agents', 'aidlc.json'), { name: 'aidlc' });

  if ('stageGraph' in spec) write(path.join('.kiro', 'tools', 'data', 'stage-graph.json'), spec.stageGraph);
  if ('scopeGrid' in spec) write(path.join('.kiro', 'tools', 'data', 'scope-grid.json'), spec.scopeGrid);

  const intents = path.join('aidlc', 'spaces', 'default', 'intents');
  if ('manifest' in spec) write(path.join(intents, 'intents.json'), spec.manifest);
  if ('intentDir' in spec) {
    const dir = path.join(intents, spec.intentDir);
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    if ('runtimeGraph' in spec) write(path.join(dir, 'runtime-graph.json'), spec.runtimeGraph);
    if ('auditShard' in spec) write(path.join(dir, 'audit', 'shard.md'), spec.auditShard);
  }
  return root;
}

// A well-formed baseline, so a failure elsewhere is provably about the hostile
// part of a case and not about the scaffolding.
const GOOD_GRAPH = [
  { slug: 'a', name: 'A', phase: 'p1', execution: 'ALWAYS' },
  { slug: 'b', name: 'B', phase: 'p1', execution: 'CONDITIONAL' },
  { slug: 'c', name: 'C', phase: 'p2', execution: 'ALWAYS', for_each: 'unit-of-work' }
];
const GOOD_GRID = {
  wide: { stages: { a: 'EXECUTE', b: 'EXECUTE', c: 'EXECUTE' } },
  narrow: { stages: { a: 'EXECUTE', b: 'SKIP', c: 'SKIP' } }
};

function record(fields) {
  return Object.entries(fields).map(([k, v]) => `**${k}**: ${v}`).join('\n');
}
function shard(records) {
  return records.map(record).join('\n---\n');
}

// ---------------------------------------------------------------------------
// Nothing throws, whatever is on disk
// ---------------------------------------------------------------------------

test('detect: a path that does not exist is a verdict, not an error', () => {
  const result = detect.detectGeneration('/nonexistent/nowhere-at-all');
  assert.equal(result.generation, detect.GENERATION.NONE);
});

test('detect: a missing root argument is a verdict, not an error', () => {
  assert.equal(detect.detectGeneration(undefined).generation, detect.GENERATION.NONE);
  assert.equal(detect.detectGeneration('').generation, detect.GENERATION.NONE);
});

test('detect: v1 and v2 markers together report both rather than picking one', () => {
  const root = makeProject({});
  fs.mkdirSync(path.join(root, 'aidlc-docs'), { recursive: true });
  assert.equal(detect.detectGeneration(root).generation, detect.GENERATION.BOTH);
});

for (const [label, contents] of [
  ['truncated mid-object', '{"stages": [{"slug": "a"'],
  ['empty file', ''],
  ['an object where an array belongs', '{"stages": []}'],
  ['an array of nulls', '[null, null]'],
  ['an array of strings', '["a", "b"]'],
  ['deeply wrong types', '[{"slug": 42, "phase": ["p"], "produces": "not-an-array"}]']
]) {
  test(`graph: stage-graph.json ${label} yields undefined, never a throw`, () => {
    const root = makeProject({ stageGraph: contents });
    const result = graph.readStageGraph(root);
    // Either it found no usable stage (undefined) or it found some and dropped
    // the unusable ones. Both are acceptable; throwing is not.
    if (result) assert.ok(Array.isArray(result.stages));
  });
}

test('graph: a stage field the model has never seen is reported, not dropped silently', () => {
  const root = makeProject({
    stageGraph: [{ slug: 'a', phase: 'p1', some_field_from_the_future: true }]
  });
  const result = graph.readStageGraph(root);
  assert.ok(result.unknownStageFields.includes('some_field_from_the_future'));
});

test('graph: a scope decision that is neither EXECUTE nor SKIP is reported and treated as out of scope', () => {
  const root = makeProject({
    stageGraph: GOOD_GRAPH,
    scopeGrid: { s: { stages: { a: 'EXECUTE', b: 'DEFERRED_SOMEHOW' } } }
  });
  const grid = graph.readScopeGrid(root);
  assert.ok(grid.unknownDecisions.includes('DEFERRED_SOMEHOW'));
  const stages = graph.stagesForScope(graph.readStageGraph(root), grid, 's');
  assert.equal(stages.find((s) => s.slug === 'b').inScope, false);
});

test('graph: an unknown scope name leaves every stage in scope rather than claiming they were skipped', () => {
  const root = makeProject({ stageGraph: GOOD_GRAPH, scopeGrid: GOOD_GRID });
  const stages = graph.stagesForScope(
    graph.readStageGraph(root),
    graph.readScopeGrid(root),
    'a-scope-nobody-has-heard-of'
  );
  assert.ok(stages.every((s) => s.inScope));
});

for (const [label, contents] of [
  ['not an object', '"just a string"'],
  ['stages missing', '{"scope": "x"}'],
  ['stages of the wrong type', '{"stages": {"a": 1}}'],
  ['truncated', '{"scope": "x", "stages": [{'],
  ['stage rows missing their slug', '{"stages": [{"outcome": "approved"}]}']
]) {
  test(`runtime: runtime-graph.json ${label} yields undefined, never a throw`, () => {
    const root = makeProject({ intentDir: '260101-x', runtimeGraph: contents });
    const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
    const result = runtime.readRuntime(dir);
    if (result) assert.ok(result.byStage instanceof Map);
  });
}

test('runtime: a runtime-graph key the model does not read is reported', () => {
  const root = makeProject({
    intentDir: '260101-x',
    runtimeGraph: { scope: 's', stages: [], something_new: { a: 1 } }
  });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  assert.deepEqual(runtime.readRuntime(dir).unknownFields, ['something_new']);
});

test('runtime: an outcome value beyond approved/pending is reported and counts as unfinished', () => {
  const root = makeProject({
    intentDir: '260101-x',
    runtimeGraph: { scope: 's', stages: [{ stage_slug: 'a', outcome: 'quarantined' }] }
  });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  const result = runtime.readRuntime(dir);
  assert.deepEqual(result.unknownOutcomes, ['quarantined']);
  assert.equal(result.byStage.get('a').done, false);
});

for (const boltDag of [
  null,
  'a string',
  {},
  { units: 'not an array' },
  { units: [null, { noName: true }] },
  { units: [{ name: 'u1' }], batches: 'not an array' },
  { units: [{ name: 'u1', depends_on: 'not an array' }] }
]) {
  test(`runtime: bolt_dag shaped as ${JSON.stringify(boltDag)} does not throw`, () => {
    const result = runtime.readUnits(boltDag);
    if (result) {
      assert.ok(Array.isArray(result.units));
      assert.ok(Array.isArray(result.batches));
    }
  });
}

test('runtime: a manifest whose entries name a directory that is absent reports the mismatch', () => {
  const root = makeProject({
    manifest: [{ slug: 'gone', dirName: '260101-gone' }],
    intentDir: '260101-here'
  });
  const listing = runtime.listIntents(root, 'default');
  assert.deepEqual(listing.missingOnDisk, ['260101-gone']);
  // With no manifest match it must still find what IS on disk.
  assert.deepEqual(listing.intents.map((i) => i.id), ['260101-here']);
});

test('runtime: a directory absent from the manifest is reported, not hidden', () => {
  const root = makeProject({
    manifest: [{ slug: 'a', dirName: '260101-a' }],
    intentDir: '260101-a'
  });
  const extra = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-unlisted');
  fs.mkdirSync(extra, { recursive: true });
  const listing = runtime.listIntents(root, 'default');
  assert.deepEqual(listing.missingFromManifest, ['260101-unlisted']);
});

for (const [label, manifest] of [
  ['not an array or object', '"nope"'],
  ['array of numbers', '[1, 2, 3]'],
  ['entries with no directory name', '[{"slug": "only-a-slug"}]'],
  ['truncated', '[{"dirName": "260101-a"']
]) {
  test(`runtime: a manifest that is ${label} falls back to the directory walk`, () => {
    const root = makeProject({ manifest, intentDir: '260101-a' });
    const listing = runtime.listIntents(root, 'default');
    assert.deepEqual(listing.intents.map((i) => i.id), ['260101-a']);
  });
}

test('audit: a missing audit directory yields no events rather than an error', () => {
  const root = makeProject({ intentDir: '260101-x' });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  const summary = audit.summarise(dir);
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.unknownEvents, []);
});

test('audit: records with no Event line are skipped without disturbing the rest', () => {
  const root = makeProject({
    intentDir: '260101-x',
    auditShard: [
      '**Timestamp**: 2026-01-01T00:00:00Z',
      '---',
      record({ Event: 'HUMAN_TURN', Timestamp: '2026-01-01T00:00:01Z' }),
      '---',
      'free prose that is not a record at all'
    ].join('\n')
  });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  assert.equal(audit.summarise(dir).total, 1);
});

test('audit: the stage field is read under either spelling', () => {
  // Sensor rows use `Stage slug`; other rows use `Stage`. Reading one name only
  // silently produced an empty per-stage tally, so both are pinned here.
  const root = makeProject({
    intentDir: '260101-x',
    auditShard: shard([
      { Event: 'SENSOR_FAILED', 'Stage slug': 'alpha', Timestamp: '2026-01-01T00:00:00Z' },
      { Event: 'SENSOR_FAILED', Stage: 'beta', Timestamp: '2026-01-01T00:00:01Z' }
    ])
  });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  const summary = audit.summarise(dir);
  assert.equal(summary.failuresByStage.get('alpha'), 1);
  assert.equal(summary.failuresByStage.get('beta'), 1);
});

test('audit: an event name the model has never seen is counted and reported', () => {
  const root = makeProject({
    intentDir: '260101-x',
    auditShard: shard([{ Event: 'SOMETHING_NOBODY_HAS_SEEN', Timestamp: '2026-01-01T00:00:00Z' }])
  });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  const summary = audit.summarise(dir);
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.unknownEvents, ['SOMETHING_NOBODY_HAS_SEEN']);
});

test('audit: a record with no timestamp still orders and does not throw', () => {
  const root = makeProject({
    intentDir: '260101-x',
    auditShard: shard([
      { Event: 'ERROR_LOGGED', Stage: 'a', Error: 'Refusing something' },
      { Event: 'HUMAN_TURN' }
    ])
  });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  const summary = audit.summarise(dir);
  assert.equal(summary.refusals.length, 1);
  assert.ok(Array.isArray(audit.refusalContext(summary, 0)));
});

test('audit: asking for context on a refusal that does not exist yields nothing', () => {
  const root = makeProject({ intentDir: '260101-x', auditShard: '' });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  const summary = audit.summarise(dir);
  assert.deepEqual(audit.refusalContext(summary, 99), []);
  assert.deepEqual(audit.refusalContext(summary, undefined), []);
});

// ---------------------------------------------------------------------------
// The whole model, end to end, on inputs that should not be survivable
// ---------------------------------------------------------------------------

test('buildV2: a project with no stage graph reports why instead of throwing', () => {
  const root = makeProject({});
  const model = buildV2(root);
  assert.equal(model.ok, false);
  assert.equal(model.reason, 'stage-graph-unreadable');
});

test('buildV2: a graph with no scope grid still builds and flags the gap', () => {
  const root = makeProject({ stageGraph: GOOD_GRAPH, intentDir: '260101-x' });
  const model = buildV2(root);
  assert.equal(model.ok, true);
  assert.equal(model.gaps.scopeGridMissing, true);
});

test('buildV2: an intent with no runtime graph reads as nothing started', () => {
  const root = makeProject({ stageGraph: GOOD_GRAPH, scopeGrid: GOOD_GRID, intentDir: '260101-x' });
  const model = buildV2(root);
  const intent = model.intents[0];
  assert.equal(intent.journey.currentIndex, -1);
  assert.deepEqual(model.gaps.intentsWithoutRuntime, ['260101-x']);
});

test('buildV2: a manifest scope disagreeing with the runtime scope is reported, not resolved', () => {
  const root = makeProject({
    stageGraph: GOOD_GRAPH,
    scopeGrid: GOOD_GRID,
    manifest: [{ dirName: '260101-x', scope: 'narrow' }],
    intentDir: '260101-x',
    runtimeGraph: { scope: 'wide', stages: [] }
  });
  const model = buildV2(root);
  assert.deepEqual(model.gaps.scopeDisagreements, ['260101-x']);
});

test('buildV2: no phase is hardcoded, so a graph with invented phase names works', () => {
  const root = makeProject({
    stageGraph: [
      { slug: 'x', name: 'X', phase: 'brand-new-phase' },
      { slug: 'y', name: 'Y', phase: 'another-one' }
    ],
    intentDir: '260101-x'
  });
  const model = buildV2(root);
  assert.deepEqual(model.phases, ['brand-new-phase', 'another-one']);
});

test('buildV2: a directory inside the intent that is not a phase is reported', () => {
  const root = makeProject({ stageGraph: GOOD_GRAPH, intentDir: '260101-x' });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'p1'), { recursive: true });
  const model = buildV2(root);
  assert.ok(model.gaps.nonPhaseDirs.includes('audit'));
  assert.ok(!model.gaps.nonPhaseDirs.includes('p1'));
});

// ---------------------------------------------------------------------------
// Unit accounting. Three real projects each recorded units differently, so the
// rules that survived all three are pinned as behaviour.
// ---------------------------------------------------------------------------

function stagesWith(forEach) {
  return [
    { slug: 'c', name: 'C', phase: 'p2', inScope: true, forEach, execution: 'ALWAYS' }
  ];
}

test('units: a stage marked done counts every unit done even with no unit rows in the ledger', () => {
  // A `subagent` stage was observed finishing all its units while emitting no
  // UNIT_COMPLETED at all. Counting the ledger alone reported 0 of 1 on a
  // completed stage, so stage status has to outrank the ledger.
  const runtimeStub = {
    byStage: new Map([['c', { slug: 'c', outcome: 'approved', done: true }]]),
    units: { units: [{ name: 'u1' }, { name: 'u2' }], batches: [['u1'], ['u2']] }
  };
  const journey = buildFromStages(stagesWith('unit-of-work'), runtimeStub, new Map(), new Map());
  const node = journey.checkpoints[0];
  assert.equal(node.status, V2_STATUS.DONE);
  assert.equal(node.unitsDone, 2);
  assert.equal(node.unitsPlanned, 2);
});

test('units: an in-flight stage counts only units the ledger explicitly closed', () => {
  const runtimeStub = {
    byStage: new Map([['c', { slug: 'c', outcome: 'pending', done: false }]]),
    units: { units: [{ name: 'u1' }, { name: 'u2' }], batches: [['u1'], ['u2']] }
  };
  const closed = new Map([['c', new Set(['u1'])]]);
  const seen = new Map([['c', new Set(['u1', 'u2'])]]);
  const node = buildFromStages(stagesWith('unit-of-work'), runtimeStub, closed, seen).checkpoints[0];
  assert.equal(node.unitsDone, 1);
  assert.deepEqual(node.unitsInFlight, ['u2']);
});

test('units: a completed stage reports nothing in flight, even with no closure rows', () => {
  // A `subagent` stage emits no UNIT_COMPLETED, so on a completed one the ledger
  // shows every unit as seen and none as closed. Reporting those as in flight
  // contradicted the count beside them, which read 1/1 done.
  const runtimeStub = {
    byStage: new Map([['c', { slug: 'c', outcome: 'approved', done: true }]]),
    units: { units: [{ name: 'u1' }], batches: [['u1']] }
  };
  const seen = new Map([['c', new Set(['u1'])]]);
  const node = buildFromStages(
    stagesWith('unit-of-work'), runtimeStub, new Map(), seen
  ).checkpoints[0];
  assert.equal(node.unitsDone, 1);
  assert.deepEqual(node.unitsInFlight, []);
});

test('units: a stage the scope skipped reports nothing in flight', () => {
  const runtimeStub = {
    byStage: new Map(),
    units: { units: [{ name: 'u1' }], batches: [['u1']] }
  };
  const stages = [{ ...stagesWith('unit-of-work')[0], inScope: false }];
  const seen = new Map([['c', new Set(['u1'])]]);
  const node = buildFromStages(stages, runtimeStub, new Map(), seen).checkpoints[0];
  assert.equal(node.status, V2_STATUS.SKIPPED);
  assert.deepEqual(node.unitsInFlight, []);
});

test('units: the same unit closed twice counts once', () => {
  // A unit can be re-reviewed after its completion row, which was observed on a
  // real project. Counting rows would then claim more units than exist.
  const root = makeProject({
    intentDir: '260101-x',
    auditShard: shard([
      { Event: 'UNIT_COMPLETED', Stage: 'c', Unit: 'u1', Timestamp: '2026-01-01T00:00:00Z' },
      { Event: 'REVIEW_COMPLETED', Stage: 'c', Unit: 'u1', Timestamp: '2026-01-01T00:00:01Z' },
      { Event: 'UNIT_COMPLETED', Stage: 'c', Unit: 'u1', Timestamp: '2026-01-01T00:00:02Z' }
    ])
  });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  assert.equal(audit.summarise(dir).unitsCompleted.get('c').size, 1);
});

test('units: the Unit field is collected off whatever event carries it', () => {
  // Which events carry it depends on the stage's execution mode, so keying on
  // one event name is what produced a zero count on a finished stage.
  const root = makeProject({
    intentDir: '260101-x',
    auditShard: shard([
      { Event: 'REVIEW_REQUESTED', Stage: 'c', Unit: 'u9', Timestamp: '2026-01-01T00:00:00Z' }
    ])
  });
  const dir = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-x');
  const summary = audit.summarise(dir);
  assert.deepEqual([...summary.unitsSeen.get('c')], ['u9']);
  assert.equal(summary.unitsCompleted.has('c'), false);
});

test('units: a stage that does not repeat reports no unit numbers at all', () => {
  const runtimeStub = {
    byStage: new Map(),
    units: { units: [{ name: 'u1' }], batches: [['u1']] }
  };
  const node = buildFromStages(stagesWith(undefined), runtimeStub).checkpoints[0];
  assert.equal(node.unitsDone, undefined);
  assert.equal(node.unitsPlanned, undefined);
});

test('units: a run that never decomposed reports an empty unit list, not a fabricated one', () => {
  const runtimeStub = { byStage: new Map(), units: undefined };
  const journey = buildFromStages(stagesWith('unit-of-work'), runtimeStub);
  assert.deepEqual(journey.units, []);
  assert.equal(journey.checkpoints[0].unitsPlanned, 0);
});

// ---------------------------------------------------------------------------
// Locating the open file on the strip
// ---------------------------------------------------------------------------

test('the open artifact is located by the stage slug in its path', () => {
  // v1 needs a lookup table because its directory names and stage names are
  // different vocabularies. v2 puts the slug in the path, so this is a set
  // membership test against slugs the project itself declared -- a stage this
  // build has never heard of still matches.
  const journey = {
    checkpoints: [
      { id: 'intent-capture', label: 'Intent Capture' },
      { id: 'domain-design', label: 'Domain Design' },
      { id: 'functional-design', label: 'Functional Design' }
    ]
  };
  const base = 'aidlc/spaces/default/intents/260101-x';
  assert.equal(
    checkpointIndexForPath(journey, `${base}/inception/domain-design/components.md`),
    1
  );
  assert.equal(
    checkpointIndexForPath(journey, `${base}/ideation/intent-capture/intent-statement.md`),
    0
  );
});

test('a per-unit artifact resolves to its stage, not to the unit directory', () => {
  // A repeating stage writes under <phase>/<stage>/<unit>/file.md, so the search
  // runs from the deepest component outward and the stage nearer the file wins.
  const journey = { checkpoints: [{ id: 'functional-design', label: 'FD' }] };
  assert.equal(
    checkpointIndexForPath(
      journey,
      'aidlc/spaces/default/intents/260101-x/construction/functional-design/u1-core/entities.md'
    ),
    0
  );
});

test('a file that is not a stage artifact matches nothing', () => {
  const journey = { checkpoints: [{ id: 'domain-design', label: 'DD' }] };
  for (const rel of [
    'aidlc/spaces/default/intents/260101-x/audit/shard.md',
    'README.md',
    'src/server.js',
    'domain-design.md'
  ]) {
    assert.equal(checkpointIndexForPath(journey, rel), -1, `must not match ${rel}`);
  }
});

test('locating an artifact never throws on a malformed journey or path', () => {
  for (const journey of [undefined, null, {}, { checkpoints: 'no' }]) {
    assert.equal(checkpointIndexForPath(journey, 'a/b/c.md'), -1);
  }
  const journey = { checkpoints: [{ id: 'x', label: 'X' }] };
  for (const rel of [undefined, null, '', 'x', 42, {}]) {
    assert.equal(checkpointIndexForPath(journey, rel), -1);
  }
});

test('a repeating stage carries unitProgress in the shape the viewer strip reads', () => {
  // The strip already renders "2/3" from this field on a v1 project. Producing the
  // same field here is what makes it work on v2 with no change to the strip.
  const runtimeStub = {
    byStage: new Map([['c', { slug: 'c', outcome: 'approved', done: true }]]),
    units: { units: [{ name: 'u1' }, { name: 'u2' }], batches: [['u1'], ['u2']] }
  };
  const node = buildFromStages(stagesWith('unit-of-work'), runtimeStub).checkpoints[0];
  assert.deepEqual(node.unitProgress, { done: 2, total: 2 });
});

test('a stage that does not repeat carries no unitProgress', () => {
  const runtimeStub = { byStage: new Map(), units: undefined };
  const node = buildFromStages(stagesWith(undefined), runtimeStub).checkpoints[0];
  assert.equal(node.unitProgress, undefined);
});

// ---------------------------------------------------------------------------
// The denominator, which is what v1 got wrong
// ---------------------------------------------------------------------------

test('denominator: stages the scope skipped leave the denominator', () => {
  const root = makeProject({
    stageGraph: GOOD_GRAPH,
    scopeGrid: GOOD_GRID,
    intentDir: '260101-x',
    runtimeGraph: { scope: 'narrow', stages: [{ stage_slug: 'a', outcome: 'approved' }] }
  });
  const journey = buildV2(root).intents[0].journey;
  assert.equal(journey.plannedTotal, 1);
  assert.equal(journey.counts.done, 1);
  assert.equal(journey.counts.skipped, 2);
});

test('denominator: the scope comes from the intent, so two intents can differ in the same project', () => {
  const root = makeProject({
    stageGraph: GOOD_GRAPH,
    scopeGrid: GOOD_GRID,
    intentDir: '260101-wide',
    runtimeGraph: { scope: 'wide', stages: [] }
  });
  const second = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-narrow');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(
    path.join(second, 'runtime-graph.json'),
    JSON.stringify({ scope: 'narrow', stages: [] })
  );
  const model = buildV2(root);
  const totals = Object.fromEntries(model.intents.map((i) => [i.id, i.journey.plannedTotal]));
  assert.equal(totals['260101-wide'], 3);
  assert.equal(totals['260101-narrow'], 1);
});

test('position: the furthest evidenced stage wins, so a late edit cannot move it backwards', () => {
  // An mtime cursor was observed jumping back when an early artifact was edited
  // days later. Position is therefore derived from evidence order, not recency.
  const root = makeProject({
    stageGraph: GOOD_GRAPH,
    scopeGrid: GOOD_GRID,
    intentDir: '260101-x',
    runtimeGraph: {
      scope: 'wide',
      stages: [
        { stage_slug: 'a', outcome: 'approved', completed_at: '2026-03-01T00:00:00Z' },
        { stage_slug: 'c', outcome: 'approved', completed_at: '2026-01-01T00:00:00Z' }
      ]
    }
  });
  const journey = buildV2(root).intents[0].journey;
  assert.equal(journey.checkpoints[journey.currentIndex].id, 'c');
});

// ---------------------------------------------------------------------------
// Out of scope is not the same as skipped
// ---------------------------------------------------------------------------

test('a stage the scope never included is marked out of scope, not skipped', () => {
  // Reported from a screenshot: a project sitting in its second phase showed every
  // Operation stage as "skipped". Read literally that claims the run went past
  // deployment, which cannot be true from ideation. The scope had simply never
  // included those stages, which is a different fact and is known before anything
  // runs.
  //
  // The status stays `skipped` so every renderer keeps hatching it and keeps it out
  // of the denominator. `outOfScope` is what carries the distinction to the places
  // that print a word.
  const stages = [
    { slug: 'a', name: 'A', phase: 'ideation', inScope: true },
    { slug: 'b', name: 'B', phase: 'ideation', inScope: false },
    { slug: 'z', name: 'Z', phase: 'operation', inScope: false }
  ];
  const runtime = {
    units: { units: [] },
    byStage: new Map([['a', { done: true, outcome: 'approved' }]])
  };
  const journey = buildFromStages(stages, runtime);

  const [a, b, z] = journey.checkpoints;
  assert.equal(a.status, V2_STATUS.DONE);
  assert.equal(a.outOfScope, undefined, 'an in-scope stage carries no out-of-scope mark');

  for (const cp of [b, z]) {
    assert.equal(cp.status, V2_STATUS.SKIPPED, 'status unchanged, so hatching still works');
    assert.equal(cp.outOfScope, true);
    assert.equal(cp.planned, false);
  }

  // And the denominator still counts only what the scope included.
  assert.equal(journey.plannedTotal, 1);
  assert.equal(journey.counts.done, 1);
});

test('an in-scope stage not yet reached is pending, never out of scope', () => {
  // The other half of the screenshot: some rows read "not started" and some read
  // "skipped", with nothing to tell the reader why. A stage ahead of the run that the
  // scope did include must be pending.
  const stages = [
    { slug: 'a', name: 'A', phase: 'ideation', inScope: true },
    { slug: 'later', name: 'Later', phase: 'operation', inScope: true }
  ];
  const runtime = {
    units: { units: [] },
    byStage: new Map([['a', { done: true, outcome: 'approved' }]])
  };
  const later = buildFromStages(stages, runtime).checkpoints[1];
  assert.equal(later.status, V2_STATUS.PENDING);
  assert.equal(later.outOfScope, undefined);
  assert.equal(later.planned, true);
});

test('v1 checkpoints never carry the out-of-scope mark', () => {
  // v1 has no scope, and its `skipped` means what it has always meant: the run moved
  // past a stage without producing anything. Asserted because the renderers now take
  // their wording from this field, so v1's text is unchanged only as long as v1 never
  // sets it.
  const v1 = require('../src/aidlc/journey');
  for (const artifacts of [
    [],
    [{ relPath: 'inception/requirements/requirements.md', mtime: 1 }],
    [{ relPath: 'operations/review.md', mtime: 1 }],
    [{ relPath: 'construction/plans/u1-plan.md', mtime: 1 }]
  ]) {
    for (const rulesInstalled of [false, true]) {
      const journey = v1.buildJourney({ artifacts, rulesInstalled });
      for (const cp of journey.checkpoints) {
        assert.ok(!('outOfScope' in cp), `a v1 checkpoint carries outOfScope: ${cp.id}`);
        // v1 does set `conditional`, which is why the renderers key off this field
        // instead. If v1 ever set it, v1's labels would change.
        assert.ok(!('mayNotRun' in cp), `a v1 checkpoint carries mayNotRun: ${cp.id}`);
      }
    }
  }
});

test('an out-of-scope stage reads the same whatever phase it sits in', () => {
  // The treatment must not depend on position. A stage the scope excluded looks the
  // same one row below the run as it does five phases below it.
  const stages = ['initialization', 'ideation', 'inception', 'construction', 'operation'].map(
    (phase, index) => ({ slug: `s${index}`, name: `S${index}`, phase, inScope: false })
  );
  const journey = buildFromStages(stages, undefined);
  assert.equal(journey.plannedTotal, 0);
  for (const cp of journey.checkpoints) {
    assert.equal(cp.status, V2_STATUS.SKIPPED);
    assert.equal(cp.outOfScope, true);
  }
});

test('a conditional stage in scope is not promised, because EXECUTE means eligible', () => {
  // Reported on a greenfield project: Reverse Engineering read "not started", which
  // promises it will run. The scope grid did say EXECUTE for it, so the extension was
  // faithful to one input and blind to the other -- the stage graph declares that
  // stage CONDITIONAL, and with no existing code to read it does not run.
  //
  // So there are three reasons a stage has not happened, not two: the scope excluded
  // it, the scope allowed it but the stage decides against the project, or it is
  // simply waiting its turn.
  const stages = [
    { slug: 'always', name: 'Always', phase: 'inception', inScope: true, execution: 'ALWAYS' },
    { slug: 'maybe', name: 'Maybe', phase: 'inception', inScope: true, execution: 'CONDITIONAL' },
    { slug: 'never', name: 'Never', phase: 'inception', inScope: false, execution: 'ALWAYS' }
  ];
  const journey = buildFromStages(stages, { units: { units: [] }, byStage: new Map() });
  const [always, maybe, never] = journey.checkpoints;

  // All three are pending or skipped; the status alone cannot tell them apart.
  assert.equal(always.status, V2_STATUS.PENDING);
  assert.equal(maybe.status, V2_STATUS.PENDING);
  assert.equal(never.status, V2_STATUS.SKIPPED);

  // The fields the renderers read to say which is which. `mayNotRun` rather than
  // `conditional`, because v1 sets `conditional` too -- eight of its checkpoints are
  // conditional, so a renderer keying off that field would have relabelled v1's
  // "not started" rows. Caught by checking, not assumed.
  assert.equal(always.mayNotRun, undefined);
  assert.equal(maybe.mayNotRun, true);
  assert.equal(never.outOfScope, true);
  // The underlying fact stays on both, for anything that wants it.
  assert.equal(always.conditional, false);
  assert.equal(maybe.conditional, true);

  // A conditional stage is still in the denominator: it may yet run.
  assert.equal(journey.plannedTotal, 2);
});

test('a stage graph that states no execution rule promises nothing extra', () => {
  // Absence must not become a claim. An unstated execution reads as unconditional
  // only because that is the safer default for a count, and the field says so
  // plainly rather than the renderer guessing.
  const journey = buildFromStages(
    [{ slug: 'x', name: 'X', phase: 'inception', inScope: true }],
    undefined
  );
  assert.equal(journey.checkpoints[0].conditional, false);
  assert.equal(journey.checkpoints[0].mayNotRun, undefined);
  assert.equal(journey.checkpoints[0].status, V2_STATUS.PENDING);
});

test('a conditional stage that already ran is done, not conditional-looking', () => {
  // Once there is a record the condition has been resolved, so the label must not
  // keep hedging about a stage that has finished.
  const stages = [
    { slug: 'maybe', name: 'Maybe', phase: 'inception', inScope: true, execution: 'CONDITIONAL' }
  ];
  const runtime = {
    units: { units: [] },
    byStage: new Map([['maybe', { done: true, outcome: 'approved' }]])
  };
  const cp = buildFromStages(stages, runtime).checkpoints[0];
  assert.equal(cp.status, V2_STATUS.DONE);
  // Both flags stay true as facts about the stage, so renderers must key the hedging
  // on the status as well as on the flag.
  assert.equal(cp.conditional, true);
  assert.equal(cp.mayNotRun, true);
});

// ---------------------------------------------------------------------------
// Gates waiting on a person
// ---------------------------------------------------------------------------
//
// STAGE_AWAITING_APPROVAL was in the panel's "not understood" list -- a tool for
// supervising delegation announcing it had no meaning for the event that says the
// delegation is waiting on you. These pin the semantics rather than the wording.

function ledger(records) {
  // A shard in the format the engine writes: records separated by a rule, fields as
  // bold labels. Built here rather than fixtured so each case states its own shape.
  return records
    .map((fields) =>
      Object.entries(fields)
        .map(([key, value]) => `**${key}**: ${value}`)
        .join('\n')
    )
    .join('\n\n---\n\n');
}

function intentWith(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'audit', 'shard.md'), ledger(records));
  return dir;
}

test('a gate nothing resolved is reported as waiting on a person', () => {
  const dir = intentWith([
    { Timestamp: '2026-01-01T00:00:00Z', Event: 'STAGE_STARTED', Stage: 'domain-design' },
    { Timestamp: '2026-01-01T00:01:00Z', Event: 'STAGE_AWAITING_APPROVAL', Stage: 'domain-design' }
  ]);
  const result = diagnose(dir);
  assert.equal(result.waitingOnYou.length, 1);
  assert.equal(result.waitingOnYou[0].stage, 'domain-design');
  // Quoted from the engine rather than concluded, and the panel says which.
  assert.equal(result.waitingOnYou[0].stated, true);
});

test('a stage that finished its work is waiting even with no gate event', () => {
  // The case that broke the first version within the hour: a project sitting at a
  // Requirements Analysis gate with the chat asking for approval, and this reporting
  // nothing, because that engine emitted no awaiting-approval record for that gate.
  // Keying on one event name is a rule base with a single rule, and the v2 branch
  // moves -- UNIT_COMPLETED is already gone from the newer engine.
  for (const evidence of ['REVIEW_COMPLETED', 'ARTIFACT_CREATED', 'ARTIFACT_UPDATED']) {
    const dir = intentWith([
      { Timestamp: '2026-01-01T00:00:00Z', Event: 'STAGE_STARTED', Stage: 's' },
      { Timestamp: '2026-01-01T00:01:00Z', Event: evidence, Stage: 's' }
    ]);
    const result = diagnose(dir);
    assert.equal(result.waitingOnYou.length, 1, `${evidence} did not read as finished work`);
    // Concluded, not quoted. The distinction reaches the screen.
    assert.equal(result.waitingOnYou[0].stated, false);
    assert.equal(result.waitingOnYou[0].evidence, evidence);
  }
});

test('checks running over an artifact are part of writing it, not movement after it', () => {
  // Sensors fire on every artifact write, so treating any later event as movement
  // would silence every gate the moment the engine checked its own output.
  const dir = intentWith([
    { Timestamp: '2026-01-01T00:01:00Z', Event: 'ARTIFACT_UPDATED', Stage: 's' },
    { Timestamp: '2026-01-01T00:02:00Z', Event: 'SENSOR_FIRED', Stage: 's' },
    { Timestamp: '2026-01-01T00:03:00Z', Event: 'SENSOR_PASSED', Stage: 's' },
    { Timestamp: '2026-01-01T00:04:00Z', Event: 'SENSOR_FAILED', Stage: 's' }
  ]);
  assert.equal(diagnose(dir).waitingOnYou.length, 1);
});

test('a stage the runtime graph has as done is not waiting, whatever the ledger says', () => {
  // The graph is the authority on completion. A ledger that never recorded the
  // approval must not keep a finished stage on screen.
  const dir = intentWith([
    { Timestamp: '2026-01-01T00:01:00Z', Event: 'REVIEW_COMPLETED', Stage: 's' }
  ]);
  const runtime = { byStage: new Map([['s', { done: true, outcome: 'approved' }]]) };
  assert.equal(diagnose(dir, { runtime }).waitingOnYou.length, 0);
  // And without that authority it is still reported, rather than suppressed on a guess.
  assert.equal(diagnose(dir).waitingOnYou.length, 1);
});

test('a gate the stage moved past is history, not a warning', () => {
  // The reason the raw count cannot be shown: a finished run reached a gate at every
  // stage, so listing them all would be thirteen warnings about approved work.
  const dir = intentWith([
    { Timestamp: '2026-01-01T00:01:00Z', Event: 'STAGE_AWAITING_APPROVAL', Stage: 'domain-design' },
    { Timestamp: '2026-01-01T00:02:00Z', Event: 'GATE_APPROVED', Stage: 'domain-design' },
    { Timestamp: '2026-01-01T00:03:00Z', Event: 'STAGE_COMPLETED', Stage: 'domain-design' }
  ]);
  assert.equal(diagnose(dir).waitingOnYou.length, 0);
});

test('resolution is not a fixed list of event names', () => {
  // Any later activity on that stage settles the gate. Enumerating which events count
  // as approval would break the first time upstream renames one, and the question
  // being answered is only "did this stage move".
  for (const resolver of [
    'SUMMARY_CONFIRMATION_RECORDED',
    'STAGE_COMPLETED',
    'STAGE_SKIPPED',
    'STAGE_REVISING',
    'SOMETHING_THIS_BUILD_HAS_NEVER_SEEN'
  ]) {
    const dir = intentWith([
      { Timestamp: '2026-01-01T00:01:00Z', Event: 'STAGE_AWAITING_APPROVAL', Stage: 's' },
      { Timestamp: '2026-01-01T00:02:00Z', Event: resolver, Stage: 's' }
    ]);
    assert.equal(diagnose(dir).waitingOnYou.length, 0, `${resolver} did not settle the gate`);
  }
});

test('a stage parked twice is reported once', () => {
  // A stage re-entered after a rejection parks again. Counting both would claim two
  // open gates where there is one.
  const dir = intentWith([
    { Timestamp: '2026-01-01T00:01:00Z', Event: 'STAGE_AWAITING_APPROVAL', Stage: 's' },
    { Timestamp: '2026-01-01T00:02:00Z', Event: 'GATE_REJECTED', Stage: 's' },
    { Timestamp: '2026-01-01T00:03:00Z', Event: 'STAGE_AWAITING_APPROVAL', Stage: 's' }
  ]);
  const result = diagnose(dir);
  assert.equal(result.waitingOnYou.length, 1);
  // The later of the two, so the timestamp shown is the wait actually in force.
  assert.equal(result.waitingOnYou[0].timestamp, '2026-01-01T00:03:00Z');
});

test('gates on different stages are reported separately', () => {
  const dir = intentWith([
    { Timestamp: '2026-01-01T00:01:00Z', Event: 'STAGE_AWAITING_APPROVAL', Stage: 'a' },
    { Timestamp: '2026-01-01T00:02:00Z', Event: 'STAGE_AWAITING_APPROVAL', Stage: 'b' },
    { Timestamp: '2026-01-01T00:03:00Z', Event: 'STAGE_COMPLETED', Stage: 'a' }
  ]);
  assert.deepEqual(diagnose(dir).waitingOnYou.map((entry) => entry.stage), ['b']);
});

test('a gate with no stage recorded is not attributed to a guess', () => {
  // Every judgement here is per stage, so a record naming none cannot be placed. It is
  // left out rather than assigned to whichever stage was nearby.
  const dir = intentWith([
    { Timestamp: '2026-01-01T00:01:00Z', Event: 'STAGE_AWAITING_APPROVAL' }
  ]);
  assert.deepEqual(diagnose(dir).waitingOnYou, []);
});

test('a ledger with no gates reports none, and does not throw', () => {
  const dir = intentWith([{ Timestamp: '2026-01-01T00:00:00Z', Event: 'HUMAN_TURN' }]);
  assert.deepEqual(diagnose(dir).waitingOnYou, []);
});

test('the gate events are no longer reported as unrecognised', () => {
  // The point of the change. If either name returns to the unknown list, the panel is
  // back to advertising that it does not understand its own subject.
  const dir = intentWith([
    { Timestamp: '2026-01-01T00:01:00Z', Event: 'STAGE_AWAITING_APPROVAL', Stage: 's' },
    { Timestamp: '2026-01-01T00:02:00Z', Event: 'SUMMARY_CONFIRMATION_RECORDED', Stage: 's' }
  ]);
  const unknown = diagnose(dir).unknownEvents;
  assert.ok(!unknown.includes('STAGE_AWAITING_APPROVAL'), unknown.join(', '));
  assert.ok(!unknown.includes('SUMMARY_CONFIRMATION_RECORDED'), unknown.join(', '));
});
