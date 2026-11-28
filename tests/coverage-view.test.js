'use strict';

// Tests for media/trace-explorer/views/coverage-view.js.
//
// Three independent checks of the matrix numbers:
//   1. a BFS written here, straight over data.edges (not lib/graph.js), on the
//      data readTraceData builds from the fixture project;
//   2. the design spec's own renderCov(), cut out of the HTML and run in a vm
//      context on the spec's embedded DATA, compared cell by cell;
//   3. a few pinned literal rows (the same numbers the spec's renderCov shows for its DATA).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const G = require('../media/trace-explorer/lib/graph');
// In the webview, lib/graph.js fills self.AidlcTrace before the views run.
globalThis.AidlcTrace = Object.assign(globalThis.AidlcTrace || {}, G);
const V = require('../media/trace-explorer/views/coverage-view');
const { readTraceData } = require('../src/aidlc/trace-data');

// The design spec's script and DATA, extracted from the HTML reference into tests/fixtures/design-spec/.
const SPEC_PATH = path.resolve(__dirname, 'fixtures', 'design-spec', 'reference.js');
const SPEC_DATA_PATH = path.resolve(__dirname, 'fixtures', 'design-spec', 'data.json');
const { PROJECT_ROOT } = require('./helpers/inventory-fixture');

const DATA = readTraceData(PROJECT_ROOT, { intent: '260825-inventory-api' });
const IDX = G.buildIndexes(DATA);

const html = fs.readFileSync(SPEC_PATH, 'utf8');
const SPEC_DATA = JSON.parse(fs.readFileSync(SPEC_DATA_PATH, 'utf8'));

const TYPE_OF_MODE = { fr: 'functional_requirement', nfr: 'nfr_detail', br: 'business_rule' };
const COLS = {
  fr: ['user_story', 'acceptance_criterion', 'business_rule', 'component', 'code', 'test'],
  nfr: ['design_decision', 'code', 'test', 'note'],
  br: ['code', 'test'],
};
const HEADERS = {
  fr: ['ID', 'Requirement', 'Stories', 'Criteria', 'Rules', 'Component', 'Code', 'Tests', 'As built'],
  nfr: ['ID', 'Requirement', 'Designs', 'Code', 'Tests', 'Deferral', 'As built'],
  br: ['ID', 'Requirement', 'Code', 'Tests', 'As built'],
};

// ---- independent oracle: BFS over the raw edge list ----
function independentCounts(data, startId, types) {
  const nodeType = new Map(data.nodes.map((n) => [n.id, n.type]));
  const seen = new Set();
  let frontier = [startId];
  while (frontier.length) {
    const next = [];
    for (const e of data.edges) {
      if (frontier.includes(e.source) && e.target !== startId && !seen.has(e.target)) {
        seen.add(e.target);
        next.push(e.target);
      }
    }
    frontier = next;
  }
  return types.map((t) => [...seen].filter((id) => nodeType.get(id) === t).length);
}

// ---- parse rendered HTML (ours and the spec's) into rows ----
function parseRows(out) {
  const rows = [];
  const re = /<tr class="row"[^>]*data-(?:go|id)="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(out))) {
    const cells = [...m[2].matchAll(/<span class="(cell0|cellN)"[^>]*>(\d+)<\/span>/g)].map((c) => ({ cls: c[1], n: Number(c[2]) }));
    const bdg = /<span class="bdg[^"]*">([^<]*)<\/span>/.exec(m[2]);
    rows.push({ id: m[1], cells, verdict: bdg ? bdg[1] : (/via parent/.test(m[2]) ? null : undefined) });
  }
  return rows;
}
function headers(out) {
  return [...out.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
}
function unesc(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ---- the spec's renderCov, run in a vm on the spec's DATA ----
function specSlice(from, to) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `spec contains ${from} .. ${to}`);
  return html.slice(a, b);
}
function runSpecRenderCov(data, mode) {
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || { innerHTML: '' }) };
  const code = 'const DATA = ' + JSON.stringify(data) + ';\n' +
    specSlice('const N = {};', "document.getElementById('stats')") + '\n' +
    specSlice('function bfs(start, dir)', 'function select(') + '\n' +
    specSlice('let covMode', "document.getElementById('covTools').onclick") + '\n' +
    'covMode = ' + JSON.stringify(mode) + '; renderCov();';
  vm.runInNewContext(code, { document });
  return { tools: els.covTools.innerHTML, table: els.covTable.innerHTML };
}

function render(mode, data = DATA, idx = IDX) {
  return V.renderCoverage(data, idx, { tab: 'cov', selected: null, covMode: mode, query: '' });
}

// ---------------------------------------------------------------- fixture

test('fixture: row counts per mode equal the node counts by type', () => {
  const expected = { fr: 13, nfr: 32, br: 16 };
  for (const mode of ['fr', 'nfr', 'br']) {
    const byType = DATA.nodes.filter((n) => n.type === TYPE_OF_MODE[mode]).length;
    assert.strictEqual(byType, expected[mode], mode + ' type count');
    const rows = parseRows(render(mode));
    assert.strictEqual(rows.length, expected[mode], mode + ' rendered rows');
  }
});

test('fixture: chip counts come from the data and the active chip is aria-pressed', () => {
  for (const mode of ['fr', 'nfr', 'br']) {
    const out = render(mode);
    const chips = [...out.matchAll(/<button type="button" class="chipBtn( on)?" data-mode="(\w+)" aria-pressed="(true|false)">([^<]*)<\/button>/g)];
    assert.deepStrictEqual(chips.map((c) => c[2]), ['fr', 'nfr', 'br']);
    assert.deepStrictEqual(chips.map((c) => c[4]), ['Functional (13)', 'NFR detail (32)', 'Business rules (16)']);
    for (const c of chips) {
      assert.strictEqual(c[3] === 'true', c[2] === mode, 'aria-pressed on ' + c[2]);
      assert.strictEqual(!!c[1], c[2] === mode, '.on on ' + c[2]);
    }
  }
  // counts are not hard-coded: drop some nodes and the labels follow
  const fewer = { ...DATA, nodes: DATA.nodes.filter((n) => n.id !== 'FR1.1' && n.id !== 'BR1.1') };
  const out = render('fr', fewer, G.buildIndexes(fewer));
  assert.match(out, />Functional \(12\)</);
  assert.match(out, />Business rules \(15\)</);
  assert.match(out, />NFR detail \(32\)</);
});

test('fixture: headers per mode follow the spec', () => {
  for (const mode of ['fr', 'nfr', 'br']) assert.deepStrictEqual(headers(render(mode)), HEADERS[mode]);
});

test('fixture: every cell equals an independent BFS over data.edges; zero cells are cell0', () => {
  for (const mode of ['fr', 'nfr', 'br']) {
    const rows = parseRows(render(mode));
    const ids = DATA.nodes.filter((n) => n.type === TYPE_OF_MODE[mode]).map((n) => n.id)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    assert.deepStrictEqual(rows.map((r) => unesc(r.id)), ids, mode + ' row order');
    for (const r of rows) {
      const want = independentCounts(DATA, unesc(r.id), COLS[mode]);
      assert.deepStrictEqual(r.cells.map((c) => c.n), want, mode + ' ' + r.id);
      for (const c of r.cells) assert.strictEqual(c.cls, c.n === 0 ? 'cell0' : 'cellN');
    }
  }
});

// Derivations below name the raw traceability files under the intent
// (aidlc/spaces/default/intents/260825-inventory-api/), abbreviated:
//   user-stories   = inception/user-stories/traceability.json
//   domain-design  = inception/domain-design/traceability.json
//   functional     = construction/inventory-api/functional-design/traceability.json
//   code-gen       = construction/inventory-api/code-generation/traceability.json
//   nfr-design     = construction/inventory-api/nfr-design/traceability.json
//   infra-design   = construction/inventory-api/infrastructure-design/traceability.json
//   id-convention / file-name-convention = the reader's derived rules.
// The unit U1 (units-generation) is reachable but has no column.
test('fixture: pinned literal rows', () => {
  const row = (mode, id) => parseRows(render(mode)).find((r) => r.id === id);
  const nums = (r) => r.cells.map((c) => c.n);
  // FR1.1: user-stories FR1.1->US1.1; domain-design US1.1->InventoryItem; id-convention AC1.1.1-5;
  // functional AC1.1.1/2->BR1.1, AC1.1.3-5->BR4.1; code-gen AC1.1.1->src/items/item-handlers.ts,
  // AC1.1.2 and BR1.1->src/items/item-repository.ts, AC1.1.3-5->src/items/item-validation.ts,
  // BR4.1->src/shared/validation.ts; file-name-convention item-handlers.test.ts,
  // item-repository.int.test.ts, item-validation.test.ts (shared/validation.ts has no test).
  assert.deepStrictEqual(nums(row('fr', 'FR1.1')), [1, 5, 2, 1, 4, 3]);
  // FR2.1: user-stories FR2.1->US2.1; domain-design ->InventoryItem; id-convention AC2.1.1-6;
  // functional AC2.1.1/2->BR2.1+BR2.4, AC2.1.3/4->BR2.2, AC2.1.5->BR2.1, AC2.1.6->BR1.2;
  // code-gen AC2.1.1-4, BR2.4, BR2.2->src/stock/stock-repository.ts, AC2.1.5->src/stock/stock-validation.ts,
  // BR1.2->src/items/item-service.ts; tests: code-gen AC2.1.6->src/stock/stock-api.int.test.ts and
  // BR2.1->src/stock/stock-repository.int.test.ts, file-name-convention stock-validation.test.ts,
  // item-service.test.ts (stock-repository.int.test.ts counted once).
  assert.deepStrictEqual(nums(row('fr', 'FR2.1')), [1, 6, 4, 1, 3, 4]);
  // FR1.3: user-stories FR1.3->US1.2; domain-design ->InventoryItem; id-convention AC1.2.1-2;
  // functional AC1.2.1/2->BR1.2; code-gen AC1.2.1/2 and BR1.2->src/items/item-service.ts;
  // file-name-convention item-service.test.ts.
  assert.deepStrictEqual(nums(row('fr', 'FR1.3')), [1, 2, 1, 1, 1, 1]);
  // NFR1.5: nfr-design and infra-design one designed_as each (design:nfr-design:NFR1.5,
  // design:infrastructure-design:NFR1.5); code-gen row Deferred with free text -> note:NFR1.5:code-generation.
  assert.deepStrictEqual(nums(row('nfr', 'NFR1.5')), [2, 0, 0, 1]);
  assert.strictEqual(row('nfr', 'NFR1.5').verdict, 'Deferred');
  // NFR2.3: nfr-design + infra-design designs; code-gen ->infra/lib/compute-stack.ts;
  // file-name-convention ../test/ -> infra/test/compute-stack.test.ts.
  assert.deepStrictEqual(nums(row('nfr', 'NFR2.3')), [2, 1, 1, 0]);
  // BR2.1: code-gen BR2.1->src/stock/stock-repository.int.test.ts (a test target, so verified_by_test).
  assert.deepStrictEqual(nums(row('br', 'BR2.1')), [0, 1]);
  // BR4.1: code-gen BR4.1->src/shared/validation.ts; no test file matches the naming convention.
  assert.deepStrictEqual(nums(row('br', 'BR4.1')), [1, 0]);
});

test('fixture: rows open in Trace (row click + ID button) and verdicts use verdictClass', () => {
  const out = render('nfr');
  const trs = [...out.matchAll(/<tr class="row" data-go="([^"]+)"[^>]*><td class="mono">(<button[^>]*>)<b>([^<]*)<\/b><\/button><\/td>/g)];
  assert.strictEqual(trs.length, 32);
  for (const [, id, btn, label] of trs) {
    assert.strictEqual(label, id);
    assert.strictEqual(btn, '<button type="button" class="idlink" data-go="' + id + '" aria-label="Open ' + id + ' in Trace">');
  }
  // ID cell: class idlink only (no .src / .open, whose word-break:break-all splits IDs mid-token)
  const idCells = [...out.matchAll(/<tr class="row"[^>]*>(<td[^>]*>)(<button[^>]*>)/g)];
  assert.strictEqual(idCells.length, 32);
  for (const [, td, btn] of idCells) {
    assert.strictEqual(td, '<td class="mono">');
    assert.match(btn, /\sclass="idlink"/);
  }
  assert.doesNotMatch(out, /class="[^"]*\b(src|open)\b[^"]*"/);
  // one tab stop per row: the button, not the row
  assert.doesNotMatch(out, /<tr[^>]*tabindex/);
  for (const n of DATA.nodes.filter((x) => x.type === 'nfr_detail')) {
    const cls = G.verdictClass(n.verdict);
    const want = '<span class="bdg' + (cls ? ' ' + cls : '') + '">' + G.esc(n.verdict) + '</span>';
    assert.ok(out.includes(want), n.id + ' badge ' + want);
  }
  assert.ok(out.includes('<span class="bdg bad">Not Met</span>'));
  // business rules carry no verdict in the reader: spec's "via parent"
  const br = parseRows(render('br'));
  assert.ok(br.every((r) => r.verdict === null));
});

test('fixture: sticky-header table structure, accessible names and footer stamp', () => {
  const nouns = { fr: 'functional requirements', nfr: 'NFR details', br: 'business rules' };
  for (const mode of ['fr', 'nfr', 'br']) {
    const out = render(mode);
    assert.match(out, /<div class="tableWrap"><table><caption[\s\S]*<\/caption><thead><tr><th[\s\S]*<\/thead><tbody>/);
    assert.ok(out.includes('<caption class="sr-only">Coverage of ' + nouns[mode] + ': distinct items reachable downstream</caption>'), mode + ' caption');
    const ths = [...out.matchAll(/<th\b[^>]*>/g)].map((m) => m[0]);
    assert.strictEqual(ths.length, HEADERS[mode].length);
    for (const th of ths) assert.match(th, /\sscope="col"/, mode + ' ' + th);
    assert.ok(out.includes('<div class="covTools" role="group" aria-label="Rows to show">'), mode + ' chip group');
    assert.ok(out.startsWith('<section class="cov">'), 'no duplicate label on the inner section');
    assert.match(out, /<p class="stamp mt8">Counts are distinct items reachable downstream through the trace links\. Click a row, or press Enter on its ID, to open it in Trace\./);
  }
});

// ---------------------------------------------------------------- spec parity

test('spec DATA: cells, row order and verdicts match the spec\'s own renderCov', () => {
  const specIdx = G.buildIndexes(SPEC_DATA);
  for (const mode of ['fr', 'nfr', 'br']) {
    const spec = runSpecRenderCov(SPEC_DATA, mode);
    const theirs = parseRows(spec.table);
    const ours = parseRows(render(mode, SPEC_DATA, specIdx));
    assert.ok(theirs.length > 0, mode + ' spec rendered rows');
    assert.deepStrictEqual(ours.map((r) => r.id), theirs.map((r) => r.id), mode + ' ids');
    assert.deepStrictEqual(ours.map((r) => r.cells), theirs.map((r) => r.cells), mode + ' cells');
    assert.deepStrictEqual(ours.map((r) => r.verdict), theirs.map((r) => r.verdict), mode + ' verdicts');
    assert.deepStrictEqual(headers(render(mode, SPEC_DATA, specIdx)), headers(spec.table), mode + ' headers');
    // the spec hard-codes its chip counts; ours, counted from its DATA, agree with them
    const specChips = [...spec.tools.matchAll(/data-m="(\w+)">([^<]*)</g)].map((m) => m[2]);
    const ourChips = [...render(mode, SPEC_DATA, specIdx).matchAll(/data-mode="\w+" aria-pressed="\w+">([^<]*)</g)].map((m) => m[1]);
    assert.deepStrictEqual(ourChips, specChips);
  }
});

test('spec DATA: the requirement text is cut at 120 characters like the spec', () => {
  const spec = runSpecRenderCov(SPEC_DATA, 'fr').table;
  const ours = render('fr', SPEC_DATA, G.buildIndexes(SPEC_DATA));
  const texts = (s) => [...s.matchAll(/<tr class="row"[^>]*><td class="mono[^"]*">(?:<button[^>]*>)?<b>[^<]*<\/b>(?:<\/button>)?<\/td><td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);
  assert.deepStrictEqual(texts(ours).map(unesc), texts(spec).map(unesc));
});

// ---------------------------------------------------------------- robustness

test('no style= attributes in any mode', () => {
  for (const mode of ['fr', 'nfr', 'br']) assert.doesNotMatch(render(mode), /\sstyle\s*=/i);
});

test('hostile ids, text and verdicts are escaped', () => {
  const evil = '"><img src=x onerror=alert(1)>\'';
  const data = {
    meta: {},
    nodes: [
      { id: 'FR' + evil, type: 'functional_requirement', text: '<script>alert(1)</script>' + evil, verdict: 'Covered' + evil },
      { id: 'US' + evil, type: 'user_story', label: evil },
      { id: 'BR<b>', type: 'business_rule', text: 'x'.repeat(200) + '<i>' },
    ],
    edges: [{ source: 'FR' + evil, target: 'US' + evil, relation: 'realized_by_story' }],
    reviews: [], jump: null, drift: [],
  };
  const idx = G.buildIndexes(data);
  for (const mode of ['fr', 'br']) {
    const out = render(mode, data, idx);
    assert.doesNotMatch(out, /<img|<script|<i>|<b>BR<b>/);
    assert.doesNotMatch(out, /\sstyle\s*=/i);
  }
  const fr = render('fr', data, idx);
  assert.ok(fr.includes('data-go="FR&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;"'));
  assert.deepStrictEqual(parseRows(fr)[0].cells.map((c) => c.n), [1, 0, 0, 0, 0, 0]);
  // long text truncated, full text in the title
  const br = render('br', data, idx);
  assert.match(br, /<td title="x{200}&lt;i&gt;">x{120}<\/td>/);
});

test('empty state per mode, and with no data at all', () => {
  const data = { meta: {}, nodes: [{ id: 'FR1', type: 'functional_requirement', text: 't' }], edges: [], reviews: [], jump: null, drift: [] };
  const out = render('br', data, G.buildIndexes(data));
  assert.match(out, /<td colspan="5"><div class="empty">No business rules in the trace records of this project\.<\/div><\/td>/);
  assert.match(out, />Business rules \(0\)</);
  const none = V.renderCoverage({ nodes: [], edges: [] }, null, { covMode: 'nfr' });
  assert.match(none, /colspan="7"><div class="empty">No NFR details/);
  assert.match(V.renderCoverage(null, null, {}), /No functional requirements/);
});

test('unknown or missing mode falls back to fr; state is not mutated', () => {
  const state = Object.freeze({ tab: 'cov', selected: 'FR1.1', covMode: 'bogus', query: '' });
  const out = V.renderCoverage(DATA, IDX, state);
  assert.deepStrictEqual(headers(out), HEADERS.fr);
  assert.match(out, /data-mode="fr" aria-pressed="true"/);
  assert.deepStrictEqual(headers(V.renderCoverage(DATA, IDX, undefined)), HEADERS.fr);
});

test('renderCoverage throws a clear message when graph helpers are absent', () => {
  const saved = globalThis.AidlcTrace;
  try {
    for (const k of ['natural', 'verdictClass', 'buildIndexes', 'downstreamCounts', 'esc']) {
      globalThis.AidlcTrace = Object.assign({}, G, { [k]: undefined });
      assert.throws(() => V.renderCoverage(DATA, IDX, { covMode: 'fr' }),
        new RegExp('graph helpers \\(lib/graph\\.js\\) are not loaded: missing AidlcTrace\\.' + k + '$'), k);
    }
    delete globalThis.AidlcTrace;
    assert.throws(() => V.renderCoverage(DATA, IDX, {}), /graph helpers \(lib\/graph\.js\) are not loaded: missing AidlcTrace\.natural, /);
  } finally {
    globalThis.AidlcTrace = saved;
  }
});

test('module exports through the shared wrapper and uses no require or DOM', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'media', 'trace-explorer', 'views', 'coverage-view.js'), 'utf8');
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\bdocument\b|\bwindow\b/);
  // browser path: loads into self.AidlcTrace next to lib/graph.js
  const ctx = { self: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '..', 'media', 'trace-explorer', 'lib', 'graph.js'), 'utf8'), ctx);
  vm.runInNewContext(src, ctx);
  assert.strictEqual(typeof ctx.self.AidlcTrace.renderCoverage, 'function');
  assert.strictEqual(typeof ctx.self.AidlcTrace.buildIndexes, 'function');
  const out = ctx.self.AidlcTrace.renderCoverage(DATA, ctx.self.AidlcTrace.buildIndexes(DATA), { covMode: 'br' });
  assert.strictEqual(parseRows(out).length, 16);
});
