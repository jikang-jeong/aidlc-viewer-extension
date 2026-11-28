'use strict';

// Tests for src/aidlc/trace-data.js.
//
// Two halves. The first reads the reference project (tests/fixtures/
// inventory-api) and checks the result against numbers computed a
// second way: the independent oracle in tests/helpers/inventory-fixture.js and
// the counts of the design spec's DATA object (which was assembled from the
// same engine files by another tool). The second half feeds synthesised,
// hostile projects and checks the reader returns, with warnings, instead of
// throwing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readTraceData, _internal } = require('../src/aidlc/trace-data');
const fixture = require('./helpers/inventory-fixture');

const data = readTraceData(fixture.PROJECT_ROOT, { intent: fixture.INTENT_ID });
const expected = fixture.loadExpected();
const byId = new Map(data.nodes.map((n) => [n.id, n]));
const count = (list, key) => list.reduce((acc, x) => ((acc[x[key]] = (acc[x[key]] || 0) + 1), acc), {});

// ---------------------------------------------------------------------------
// Reference project
// ---------------------------------------------------------------------------

test('reference project: reads cleanly, with no warnings or gaps', () => {
  assert.strictEqual(data.meta.intent, fixture.INTENT_ID);
  assert.strictEqual(data.meta.intentPath, fixture.INTENT_REL);
  assert.deepStrictEqual(data.meta.warnings, []);
  assert.deepStrictEqual(data.meta.gaps, []);
  assert.strictEqual(data.repo, path.resolve(fixture.PROJECT_ROOT));
});

test('reference project: node counts by type match the design spec', () => {
  assert.deepStrictEqual(count(data.nodes, 'type'), {
    functional_requirement: 13,
    nfr: 4,
    nfr_detail: 32,
    user_story: 10,
    acceptance_criterion: 29,
    business_rule: 16,
    component: 2,
    unit: 1,
    design_decision: 64,
    stage: 1,
    note: 5,
    code: 16,
    test: 23
  });
  assert.strictEqual(data.nodes.length, 216);
});

test('reference project: edge counts by relation match the design spec', () => {
  assert.deepStrictEqual(count(data.edges, 'relation'), {
    realized_by_story: 16,
    deferred_to: 1,
    owned_by_component: 10,
    built_in_unit: 10,
    refined_by_rule: 35,
    refined_by: 32,
    designed_as: 64,
    implemented_in: 63,
    verified_by_test: 9,
    deferral_note: 5,
    has_acceptance_criterion: 29,
    tested_by: 12
  });
  assert.strictEqual(data.edges.length, 286);
  assert.deepStrictEqual(count(data.edges, 'status'), { OK: 261, Deferred: 17, 'N/A': 8 });
});

test('reference project: file edges equal the oracle link totals', () => {
  const fromFiles = data.edges.filter((e) => !e.derived);
  const { idToIdLinks, idToFileLinks, idToTextEntries } = expected.links;
  assert.strictEqual(fromFiles.length, idToIdLinks + idToFileLinks + idToTextEntries);
  // Every file-backed edge names a traceability.json that was read.
  const traceFiles = new Set(expected.traceability.files.map((f) => `${fixture.INTENT_REL}/${f.path}`));
  for (const e of fromFiles) {
    assert.ok(traceFiles.has(e.origin), `unexpected origin ${e.origin}`);
    assert.ok(e.stage, 'file edges carry their stage');
  }
  for (const e of data.edges.filter((x) => x.derived)) {
    assert.match(e.origin, /^derived:(id-convention|file-name-convention)$/);
  }
});

test('reference project: every edge endpoint is a node', () => {
  for (const e of data.edges) {
    assert.ok(byId.has(e.source), `missing source ${e.source}`);
    assert.ok(byId.has(e.target), `missing target ${e.target}`);
  }
});

test('reference project: every requirement ID the oracle found is a node of the right type', () => {
  const typeOf = { FR: 'functional_requirement', US: 'user_story', AC: 'acceptance_criterion', BR: 'business_rule', U: 'unit' };
  for (const [prefix, { ids }] of Object.entries(expected.ids.byPrefix)) {
    for (const id of ids) {
      const node = byId.get(id);
      assert.ok(node, `missing ${id}`);
      if (typeOf[prefix]) assert.strictEqual(node.type, typeOf[prefix], id);
      else assert.ok(['nfr', 'nfr_detail'].includes(node.type), id);
    }
  }
});

test('reference project: code and test nodes come from traceability and the file tree', () => {
  const tests = data.nodes.filter((n) => n.type === 'test');
  const infraTests = tests.filter((n) => n.id.startsWith('infra/'));
  assert.strictEqual(tests.length - infraTests.length, expected.sourceTree.srcTestFiles);
  for (const missing of expected.links.missingTargetFiles) {
    assert.strictEqual(byId.get(missing).exists, false, `${missing} should be flagged missing`);
  }
  assert.strictEqual(byId.get('src/items/item-handlers.ts').exists, true);
  assert.ok(
    data.edges.some((e) => e.source === 'infra/lib/compute-stack.ts' && e.target === 'infra/test/compute-stack.test.ts' && e.relation === 'tested_by')
  );
});

test('reference project: labels and text come from the defining markdown', () => {
  assert.strictEqual(byId.get('US1.1').label, 'Create an item');
  assert.strictEqual(byId.get('US1.1').priority, 'Must');
  assert.match(byId.get('US1.1').text, /^As Alex the Integrating Developer/);
  assert.strictEqual(byId.get('NFR1').label, 'Correctness/consistency');
  assert.match(byId.get('FR1.1').label, /^The system shall create an inventory item/);
  assert.doesNotMatch(byId.get('FR1.1').label, /\[Q1\]/);
  assert.strictEqual(byId.get('BR1.1').label, 'Unique, well-formed SKU on create; duplicate rejected');
  assert.strictEqual(byId.get('BR1.1').kind, 'constraint');
  assert.strictEqual(byId.get('NFR3.2').category, 'observability');
  assert.strictEqual(byId.get('U1').kind, 'service');
  assert.match(byId.get('ApiEdge').text, /HTTP boundary/);
  assert.match(byId.get('AC1.1.1').path, /inception\/user-stories\/stories\.md$/);
});

test('reference project: verdicts from build-and-test records', () => {
  const v = (id) => byId.get(id).verdict;
  assert.strictEqual(v('FR1.1'), 'Covered');
  assert.strictEqual(v('AC2.1.4'), 'Covered'); // inside a "AC2.1.1 to AC2.1.4" range
  assert.strictEqual(v('NFR1'), 'Not covered');
  assert.strictEqual(v('NFR2'), 'Covered');
  assert.strictEqual(v('NFR1.1'), 'Met');
  assert.strictEqual(v('NFR3.5'), 'Met'); // "NFR3.1/NFR3.5"
  assert.strictEqual(v('NFR1.9'), 'Not Met');
  assert.strictEqual(v('NFR1.11'), 'Unverified');
  // test-results.md says N/A (owned by CI Pipeline); ci-pipeline/quality-gates.md
  // takes the target over from exactly that verdict.
  assert.strictEqual(v('NFR4.2'), 'Met by configuration');
  assert.match(byId.get('NFR4.2').verdictSource, /ci-pipeline\/quality-gates\.md$/);
  assert.match(byId.get('NFR4.2').verdictNote, /G1, G2/);
  assert.deepStrictEqual(byId.get('NFR4.2').verdictPrior.verdict, 'N/A');
  assert.strictEqual(byId.get('NFR1.11').verdictNote, '99.9% over 30 days needs production traffic');
  assert.match(byId.get('NFR1.9').verdictNote, /accepted at NFR Design/);
  assert.strictEqual(byId.get('NFR1.9').verdictAccepted, true);
  assert.strictEqual(byId.get('NFR1.11').verdictAccepted, true);
  assert.strictEqual(byId.get('NFR1.1').verdictAccepted, undefined);
  assert.strictEqual(v('NFR1.5'), 'Deferred');
  assert.match(byId.get('NFR1.1').verdictSource, /test-results\.md$/);
  assert.strictEqual(byId.get('BR1.1').verdict, undefined);
});

test('reference project: why chains resolve [Qn] to the recorded answer', () => {
  const why = byId.get('FR1.1').why;
  assert.deepStrictEqual(why.map((w) => w.ref), ['Q1', 'Q2']);
  assert.strictEqual(why[0].stage, 'requirements-analysis');
  assert.match(why[0].q, /^Item data model/);
  assert.match(why[0].a, /^B\. Minimal \+ description/);
  assert.deepStrictEqual(byId.get('FR2.1').why[1], { ref: 'scope-document', stage: 'upstream artifact' });
  // rules.md `source: contract Q7, contract Q8`, answers recorded as a bare letter.
  const br = byId.get('BR6.1').why;
  assert.deepStrictEqual(br.map((w) => `${w.stage}:${w.ref}`), ['contract-design:Q7', 'contract-design:Q8']);
  assert.match(br[0].a, /^A\. Cognito User Pool JWT bearer token/);
  const oq = byId.get('BR2.3').why[0];
  assert.strictEqual(oq.ref, 'OQ2');
  assert.match(oq.q, /Concurrency mechanism/);
  assert.strictEqual(byId.get('US1.1').why, undefined);
});

test('reference project: reverse rows become node notes', () => {
  const notes = byId.get('BR4.2').notes;
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].stage, 'functional-design');
  assert.strictEqual(notes[0].status, 'N/A');
});

test('reference project: reviews prefer engine JSON and keep earlier markdown passes', () => {
  assert.strictEqual(data.reviews.length, 21);
  const engine = data.reviews.filter((r) => r.sourceKind === 'engine-json');
  assert.strictEqual(engine.length, expected.reviews.recordCount);
  assert.deepStrictEqual(count(engine, 'verdict'), expected.reviews.byVerdict);
  // Each engine record points at the markdown mirror the engine wrote for it.
  for (const r of engine) assert.match(r.file, /\/reviews\/review-\d+\.md$/);
  const md = data.reviews.filter((r) => r.sourceKind === 'markdown');
  assert.strictEqual(md.length, 11);
  const sorted = data.reviews.map((r) => r.date).slice().sort();
  assert.deepStrictEqual(data.reviews.map((r) => r.date), sorted);
  const fd1 = engine.find((r) => r.stage === 'functional-design' && r.iteration === 1);
  assert.deepStrictEqual([fd1.verdict, fd1.critical, fd1.major, fd1.minor], ['NOT-READY', 1, 3, 6]);
  const intent = data.reviews[0];
  assert.deepStrictEqual([intent.stage, intent.critical, intent.major, intent.minor], ['intent-capture', 0, 0, 3]);
  assert.strictEqual(intent.open, null);
  // Markdown reviews carry the line of their `## Review` heading.
  const contract = md.find((r) => r.stage === 'contract-design');
  assert.strictEqual(contract.line, 377);
  for (const r of md) {
    const lines = fs.readFileSync(path.join(fixture.PROJECT_ROOT, r.file), 'utf8').split(/\r?\n/);
    assert.match(lines[r.line - 1], /^## Review\b/, r.file);
  }
  for (const r of engine) assert.strictEqual(r.line, 1);
});

test('reference project: backward jump from the audit ledger', () => {
  const j = data.jump;
  assert.ok(j);
  assert.strictEqual(j.ts, '2026-11-09T15:18:59Z');
  assert.strictEqual(j.source, 'functional-design');
  assert.strictEqual(j.target, 'contract-design');
  assert.strictEqual(j.changed.length, 1);
  assert.strictEqual(j.invalidated.length, 9);
  assert.strictEqual(j.invalidated_reviews.length, 1);
  assert.strictEqual(j.reason, 'Cognito auth plus review fixes, back to Contract Design');
  assert.match(j.origin, /^aidlc\/.*\/audit\/.*\.md$/);
});

test('reference project: rework marks nodes defined in invalidated files', () => {
  const rework = data.nodes.filter((n) => n.rework);
  assert.strictEqual(rework.length, 16);
  assert.ok(rework.every((n) => n.type === 'business_rule'));
});

test('reference project: drift lists findings open in each final review', () => {
  assert.ok(data.drift.length > 0);
  for (const d of data.drift) {
    assert.ok(['New', 'Unresolved'].includes(d.status));
    assert.ok(data.reviews.some((r) => r.id === d.review));
    if (d.id) assert.ok(byId.has(d.id));
    if (d.file) assert.ok(fs.existsSync(path.join(fixture.PROJECT_ROOT, d.file)), d.file);
  }
  const auth = data.drift.find((d) => d.stage === 'nfr-requirements' && d.findingId === 'R-01');
  assert.deepStrictEqual(auth.ids, ['NFR2.3', 'NFR2.4']);
  assert.match(auth.file, /security-requirements\.md$/);
  // The superseded code-generation attempt contributes nothing.
  assert.ok(!data.drift.some((d) => d.review.includes('4fe7d91a8083f410')));
});

test('reference project: omitted fields are declared with reasons', () => {
  const fields = data.meta.omitted.map((o) => o.field);
  assert.ok(fields.includes('gitlab'));
  for (const o of data.meta.omitted) assert.ok(o.reason.length > 10);
  assert.ok(data.meta.sources.length > 10);
  assert.ok(data.meta.sources.every((s) => !path.isAbsolute(s)));
});

test('reference project: runtime graph is a listed source and gives the stage order', () => {
  assert.ok(data.meta.sources.includes(`${fixture.INTENT_REL}/runtime-graph.json`));
  assert.deepStrictEqual(data.meta.listedDirs, ['.kiro/aidlc-common/stages/']);
  assert.ok(!data.meta.sources.some((s) => s.startsWith('.kiro/')), 'stage specs are listed, not read');
  assert.deepStrictEqual(data.meta.stageOrder, expected.runtimeGraph.stages.map((s) => s.slug));
  assert.strictEqual(data.meta.stageOrder.length, 22);
  assert.deepStrictEqual(data.meta.stageOrder.slice(0, 3), ['workspace-scaffold', 'workspace-detection', 'state-init']);
  assert.strictEqual(data.meta.stageOrder[data.meta.stageOrder.length - 1], 'ci-pipeline');
});

test('reference project: defaults to the only intent when none is named', () => {
  const again = readTraceData(fixture.PROJECT_ROOT);
  assert.strictEqual(again.meta.intent, fixture.INTENT_ID);
  assert.strictEqual(again.nodes.length, data.nodes.length);
});

test('module stays free of vscode', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'aidlc', 'trace-data.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]vscode['"]\)/);
});

// ---------------------------------------------------------------------------
// Synthesised projects
// ---------------------------------------------------------------------------

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-trace-'));
  const intent = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260101-demo');
  fs.mkdirSync(intent, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = rel.startsWith('/') ? path.join(root, rel.slice(1)) : path.join(intent, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return root;
}

test('no project at all: empty result with a warning', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-trace-empty-'));
  const d = readTraceData(root);
  assert.deepStrictEqual([d.nodes.length, d.edges.length, d.reviews.length, d.jump], [0, 0, 0, null]);
  assert.deepStrictEqual([d.meta.stageOrder, d.meta.listedDirs], [[], []]);
  assert.ok(d.meta.warnings.length > 0);
});

test('unknown intent name: empty result with a warning', () => {
  const root = makeProject({ 'inception/user-stories/traceability.json': { stage: 'user-stories', coverage: [] } });
  const d = readTraceData(root, { intent: 'nope' });
  assert.strictEqual(d.nodes.length, 0);
  assert.match(d.meta.warnings.join('\n'), /not found/);
});

test('hostile inputs never throw and are reported', () => {
  const root = makeProject({
    'inception/user-stories/traceability.json': '{ truncated',
    'inception/domain-design/traceability.json': { stage: 'domain-design', coverage: 'not an array' },
    'inception/units-generation/traceability.json': {
      stage: 'units-generation',
      coverage: [null, 7, { status: 'OK' }, { id: 'US1.1', status: 'Weird', target: 'U1' }]
    },
    'construction/u1/mystery-stage/traceability.json': {
      stage: 'mystery-stage',
      coverage: [{ id: 'FR1.1', status: 'OK', target: 'something' }]
    },
    '.aidlc-engine/reviews/x/stage/a/1.json': '][',
    'audit/a.md': '## Stage Jump\n**Event**: STAGE_JUMPED\n**Direction**: BACKWARD\n**Changed Upstream Artifacts**: not json\n',
    'inception/requirements-analysis/requirements.md': '- **FR9.9** never traced [Q1]\n',
    'construction/build-and-test/test-results.md': '## Final target verdicts\n- Met:\n- : x\n',
    'runtime-graph.json': { stages: [{ stage_slug: 'b' }, null, { stage_slug: 7 }, { stage_slug: 'a' }, { stage_slug: 'b' }] }
  });
  let d;
  assert.doesNotThrow(() => {
    d = readTraceData(root);
  });
  const w = d.meta.warnings.join('\n');
  assert.match(w, /not valid JSON/);
  assert.match(w, /no coverage array/);
  assert.match(w, /without an id/);
  assert.match(w, /unknown status "Weird"/);
  assert.match(w, /mystery-stage/);
  assert.match(w, /FR9\.9 is defined but appears in no traceability\.json/);
  // An unknown status is kept as written and its target shown as a note, never resolved as OK.
  assert.ok(d.edges.some((e) => e.source === 'US1.1' && e.status === 'Weird' && e.relation === 'deferral_note'));
  assert.ok(d.jump);
  assert.deepStrictEqual(d.jump.changed, []);
  assert.deepStrictEqual(d.meta.stageOrder, ['b', 'a']);
});

test('GAP rows, upstream-only IDs, deferrals and N/A notes', () => {
  const root = makeProject({
    'inception/user-stories/traceability.json': {
      stage: 'user-stories',
      upstream_ids: ['FR1.1', 'FR1.2', 'FR1.3', 'FR1.4', 'FR1.5'],
      coverage: [
        { id: 'FR1.1', status: 'OK', target: 'US1.1, US1.2' },
        { id: 'FR1.2', status: 'GAP' },
        { id: 'FR1.3', status: 'Deferred', target: 'nfr-requirements' },
        { id: 'FR1.4', status: 'N/A', target: 'delivered elsewhere' }
      ]
    },
    'construction/u1/code-generation/traceability.json': {
      stage: 'code-generation',
      unit: 'u1',
      coverage: [
        { id: 'AC1.1.1', status: 'OK', target: 'src/a.ts' },
        { id: 'AC1.1.2', status: 'OK', target: 'src/a.int.test.ts' }
      ]
    },
    '/src/a.ts': 'x',
    '/src/a.int.test.ts': 'x',
    '/src/b.spec.js': 'x',
    '/node_modules/c.test.js': 'x'
  });
  const d = readTraceData(root);
  const rel = (r) => d.edges.filter((e) => e.relation === r).map((e) => `${e.source}>${e.target}`);
  assert.deepStrictEqual(rel('realized_by_story'), ['FR1.1>US1.1', 'FR1.1>US1.2']);
  assert.deepStrictEqual(rel('deferred_to'), ['FR1.3>stage:nfr-requirements']);
  assert.deepStrictEqual(rel('na_note'), ['FR1.4>note:FR1.4:user-stories']);
  assert.deepStrictEqual(rel('implemented_in'), ['AC1.1.1>src/a.ts']);
  assert.deepStrictEqual(rel('verified_by_test'), ['AC1.1.2>src/a.int.test.ts']);
  assert.deepStrictEqual(rel('tested_by'), ['src/a.ts>src/a.int.test.ts']);
  assert.deepStrictEqual(rel('has_acceptance_criterion'), ['US1.1>AC1.1.1', 'US1.1>AC1.1.2']);
  assert.deepStrictEqual(d.meta.gaps.map((g) => `${g.id}:${g.reason}`), [
    'FR1.2:coverage row is GAP',
    'FR1.5:listed in upstream_ids with no coverage row'
  ]);
  const tests = d.nodes.filter((n) => n.type === 'test').map((n) => n.id).sort();
  assert.deepStrictEqual(tests, ['src/a.int.test.ts', 'src/b.spec.js']);
});

test('helpers: ID ranges, questions and rule yaml', () => {
  assert.deepStrictEqual(_internal.expandIds('AC1.1.1 to AC1.1.3'), ['AC1.1.1', 'AC1.1.2', 'AC1.1.3']);
  assert.deepStrictEqual(_internal.expandIds('FR1.1, FR1.2'), ['FR1.1', 'FR1.2']);
  assert.deepStrictEqual(_internal.expandIds('NFR3.1 / NFR3.5'), ['NFR3.1', 'NFR3.5']);
  const q = _internal.parseQuestions('## Q1 — Pick one?\n\nA. **First** option\n   continued\nB. Second\n\n[Answer]: A\n');
  assert.deepStrictEqual(q.get('Q1'), { q: 'Pick one?', a: 'A. First option continued' });
  const rules = _internal.parseRuleYaml('```yaml\nrules:\n  - id: BR1.1\n    statement: S\n    logic: >\n      long\n      text\n    source: FR1.1, contract Q2\n```\n');
  assert.deepStrictEqual(rules, [{ id: 'BR1.1', statement: 'S', logic: 'long text', source: 'FR1.1, contract Q2' }]);
});
