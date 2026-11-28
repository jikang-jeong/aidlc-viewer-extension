'use strict';

// Guards the inventory-api oracle (tests/fixtures/inventory-api-expected.json).
//
// Two layers, so the oracle cannot drift silently in either direction:
//   1. The stored JSON must equal a fresh recomputation from the raw fixture
//      files. If someone edits the fixture, or hand-edits the JSON, this fails.
//   2. The headline numbers are also written out literally below. If someone
//      changes the helper's counting code and regenerates the JSON, this fails.
//
// Neither layer touches src/; the oracle is independent of the data layer it
// is meant to check. See tests/fixtures/inventory-api/README.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fx = require('./helpers/inventory-fixture');

const expected = fx.loadExpected();

test('fixture project and intent folder exist', () => {
  assert.ok(fs.existsSync(path.join(fx.PROJECT_ROOT, 'aidlc')), fx.PROJECT_ROOT);
  assert.ok(fs.existsSync(path.join(fx.INTENT_ROOT, 'runtime-graph.json')));
  assert.equal(fx.INTENT_ID, '260825-inventory-api');
  assert.equal(expected.intent.id, fx.INTENT_ID);
  assert.equal(expected.intent.path, fx.INTENT_REL);
});

test('stored oracle equals a fresh recomputation from raw files', () => {
  const fresh = fx.computeFacts();
  for (const key of Object.keys(fresh)) {
    assert.deepStrictEqual(fresh[key], expected[key], `oracle section "${key}" drifted; regenerate and review`);
  }
  assert.deepStrictEqual(Object.keys(expected).sort(), Object.keys(fresh).sort());
});

test('loadExpected returns an independent copy', () => {
  const a = fx.loadExpected();
  a.traceability.fileCount = -1;
  assert.equal(fx.loadExpected().traceability.fileCount, 8);
});

test('helper does not depend on the data layer under src/', () => {
  const srcText = fs.readFileSync(require.resolve('./helpers/inventory-fixture'), 'utf8');
  assert.doesNotMatch(srcText, /require\(['"][^'"]*\/src\//);
  assert.doesNotMatch(srcText, /require\(['"]vscode['"]\)/);
});

// ---- literal headline numbers (independent of the helper's code) ----

test('traceability: 8 files with these entry counts', () => {
  const t = expected.traceability;
  assert.equal(t.fileCount, 8);
  const counts = Object.fromEntries(t.files.map((f) => [f.stage, [f.upstreamCount, f.coverageCount, f.reverseCount]]));
  assert.deepStrictEqual(counts, {
    'user-stories': [17, 17, 2],
    'domain-design': [10, 10, 3],
    'units-generation': [10, 10, 0],
    'functional-design': [29, 29, 1],
    'nfr-requirements': [4, 4, 5],
    'nfr-design': [32, 32, 0],
    'infrastructure-design': [32, 32, 0],
    'code-generation': [77, 77, 0],
  });
  // Every file covers exactly its upstream list.
  for (const f of t.files) {
    assert.deepStrictEqual(f.upstreamNotCovered, [], f.path);
    assert.deepStrictEqual(f.coveredNotUpstream, [], f.path);
  }
  // Inception files carry no unit; construction files carry "inventory-api".
  for (const f of t.files) assert.equal(f.unit, f.path.startsWith('construction/') ? 'inventory-api' : null, f.path);
});

test('traceability: coverage status totals (no GAP anywhere)', () => {
  const t = expected.traceability.totals;
  assert.equal(t.coverageEntries, 211);
  assert.deepStrictEqual(t.coverageByStatus, { OK: 186, Deferred: 17, 'N/A': 8, GAP: 0 });
  assert.equal(t.reverseEntries, 11);
  assert.deepStrictEqual(t.reverseByStatus, { OK: 4, Deferred: 5, 'N/A': 2, GAP: 0 });
  const byStage = Object.fromEntries(expected.traceability.files.map((f) => [f.stage, f.coverageByStatus]));
  assert.deepStrictEqual(byStage['infrastructure-design'], { OK: 19, Deferred: 5, 'N/A': 8, GAP: 0 });
  assert.deepStrictEqual(byStage['nfr-design'], { OK: 26, Deferred: 6, 'N/A': 0, GAP: 0 });
  assert.deepStrictEqual(byStage['code-generation'], { OK: 72, Deferred: 5, 'N/A': 0, GAP: 0 });
  assert.deepStrictEqual(byStage['user-stories'], { OK: 16, Deferred: 1, 'N/A': 0, GAP: 0 });
});

test('ids: distinct requirement IDs by prefix', () => {
  const ids = expected.ids;
  const counts = Object.fromEntries(Object.entries(ids.byPrefix).map(([k, v]) => [k, v.count]));
  assert.deepStrictEqual(counts, { FR: 13, NFR: 36, US: 10, AC: 29, BR: 16, U: 1 });
  assert.equal(ids.total, 105);
  assert.deepStrictEqual(ids.nfrParents, ['NFR1', 'NFR2', 'NFR3', 'NFR4']);
  assert.equal(ids.nfrChildCount, 32);
  assert.deepStrictEqual(ids.byPrefix.U.ids, ['U1']);
  assert.deepStrictEqual(ids.nonPrefixedIds, ['ApiEdge', 'InventoryItem', 'Item']);
  assert.equal(ids.byPrefix.US.ids[0], 'US1.1');
  assert.equal(ids.byPrefix.US.ids.at(-1), 'US4.2');
});

test('links: what coverage targets point at', () => {
  const l = expected.links;
  assert.equal(l.idToIdLinks, 93);
  assert.equal(l.idToFileLinks, 72);
  assert.equal(l.idToTextEntries, 80); // 5 code-gen + 32 infra + 32 nfr-design + 10 domain + 1 user-stories
  assert.equal(l.multiTargetEntries.length, 10);
  assert.equal(l.distinctTargetFiles, 23);
  assert.deepStrictEqual(l.missingTargetFiles, ['.github/dependabot.yml']);
});

test('statusConflicts: IDs whose status differs between stages', () => {
  const ids = expected.statusConflicts.map((c) => c.id);
  assert.equal(ids.length, 11);
  assert.ok(ids.includes('NFR1.9') && ids.includes('NFR1.10') && ids.includes('NFR4'));
});

test('runtime-graph: 22 approved stages and sensor firings', () => {
  const g = expected.runtimeGraph;
  assert.equal(g.stageCount, 22);
  assert.deepStrictEqual(g.outcomes, { approved: 22 });
  assert.equal(g.scope, 'mvp');
  assert.equal(g.stages[0].slug, 'workspace-scaffold');
  assert.equal(g.stages.at(-1).slug, 'ci-pipeline');
  assert.equal(g.sensors.total, 175);
  assert.deepStrictEqual(g.sensors.byResult, { failed: 10, passed: 165 });
  assert.equal(g.sensors.withDetailPath, 10);
  assert.equal(g.sensors.missingDetailFiles.length, 2);
  assert.deepStrictEqual(g.bolt_dag.batches, [['inventory-api']]);
});

test('aidlc-state.md: 22 executed, 11 skipped, all executed phases verified', () => {
  const s = expected.state;
  assert.deepStrictEqual(s.stagesByPlan, { EXECUTE: 22, SKIP: 11 });
  assert.deepStrictEqual(s.stagesByMark, { x: 22, ' ': 11 });
  assert.equal(s.phaseProgress.Operation, 'Skipped');
  assert.equal(s.currentStatus.Status, 'Completed');
  // The state file and the runtime graph agree on which stages ran, in order.
  assert.deepStrictEqual(s.executed, expected.runtimeGraph.stages.map((x) => x.slug));
});

test('reviews: 10 engine records, 7 READY / 3 NOT-READY, 102 findings', () => {
  const r = expected.reviews;
  assert.equal(r.recordCount, 10);
  assert.deepStrictEqual(r.byVerdict, { READY: 7, 'NOT-READY': 3 });
  assert.equal(r.attemptCount, 7);
  assert.equal(r.totalFindings, 102);
  assert.equal(r.markdownReviewFiles.length, 10);
  const notReady = r.records.filter((x) => x.verdict === 'NOT-READY').map((x) => `${x.stage}#${x.iteration}`);
  assert.deepStrictEqual(notReady.sort(), ['functional-design#1', 'infrastructure-design#1', 'nfr-design#1']);
  for (const x of r.records) assert.equal(x.findingCount, x.derivedFindingCount, x.path);
  assert.ok(r.records.every((x) => x.reviewer === 'aidlc-architecture-reviewer-agent'));
});

test('source tree: 41 files under src/ (22 source, 19 test)', () => {
  const s = expected.sourceTree;
  assert.equal(s.srcTotal, 41);
  assert.equal(s.srcSourceFiles, 22);
  assert.equal(s.srcTestFiles, 19);
  assert.equal(s.srcIntegrationTestFiles, 6);
});

test('audit: the trimmed shard keeps only the change request and the backward jump', () => {
  const a = expected.audit;
  assert.deepStrictEqual(a.files, ['9c5884848955-782427804e2d.md']);
  assert.equal(a.headingCount, 2);
  assert.equal(a.eventLineCount, 1);
  assert.equal(a.keyEvents.STAGE_JUMPED, 1);
});

test('spot checks', () => {
  const sc = expected.spotChecks;
  assert.deepStrictEqual(sc['AC1.1.1'], {
    'code-generation': { status: 'OK', target: 'src/items/item-handlers.ts' },
    'functional-design': { status: 'OK', target: 'BR1.1' },
  });
  assert.deepStrictEqual(sc['FR1.1'], { 'user-stories': { status: 'OK', target: 'US1.1' } });
  assert.equal(sc.NFR4['user-stories'].status, 'Deferred');
  assert.equal(sc.NFR4['user-stories'].target, 'infrastructure-design');
  assert.equal(sc['US3.1']['units-generation'].target, 'U1');
  assert.equal(sc['AC2.1.1']['functional-design'].target, 'BR2.1, BR2.4');
  assert.equal(sc['NFR1.9']['code-generation'].status, 'OK');
  assert.equal(sc['NFR1.9']['nfr-design'].status, 'Deferred');
  assert.equal(sc.reverse['US4.2']['user-stories'].status, 'N/A');
  assert.equal(sc.reverse['BR4.2']['functional-design'].status, 'N/A');
});

test('classifyTarget splits comma lists and recognises file paths', () => {
  assert.deepStrictEqual(fx.classifyTarget('BR2.1, BR2.4'), { kind: 'ids', tokens: ['BR2.1', 'BR2.4'] });
  assert.deepStrictEqual(fx.classifyTarget('src/items/item.ts'), { kind: 'file', tokens: ['src/items/item.ts'] });
  assert.equal(fx.classifyTarget('InventoryItem').kind, 'text');
  assert.equal(fx.classifyTarget('infrastructure-design').kind, 'text');
});
