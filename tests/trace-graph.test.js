'use strict';

// Tests for media/trace-explorer/lib/graph.js.
//
// The reference implementation is the design spec's own script: the test cuts
// the N/OUT/IN index block, the helpers and bfs() out of
// the design spec (tests/fixtures/design-spec/reference.js) and runs them in a vm context, then
// compares the module against them for every node, on the spec's embedded
// DATA and on the data the reader builds from the fixture project.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const G = require('../media/trace-explorer/lib/graph');
const { readTraceData } = require('../src/aidlc/trace-data');

const MODULE_PATH = path.resolve(__dirname, '..', 'media', 'trace-explorer', 'lib', 'graph.js');
// The design spec's script and DATA, extracted from the HTML reference into tests/fixtures/design-spec/.
const SPEC_PATH = path.resolve(__dirname, 'fixtures', 'design-spec', 'reference.js');
const SPEC_DATA_PATH = path.resolve(__dirname, 'fixtures', 'design-spec', 'data.json');
const { PROJECT_ROOT } = require('./helpers/inventory-fixture');

const html = fs.readFileSync(SPEC_PATH, 'utf8');
const SPEC_DATA = JSON.parse(fs.readFileSync(SPEC_DATA_PATH, 'utf8'));
const READER_DATA = readTraceData(PROJECT_ROOT, { intent: '260825-inventory-api' });

// Arrays built inside the vm context have another realm's Array.prototype,
// so the reference side is spread into this realm before deepStrictEqual.

// Cut the spec's pure code out of the HTML.
function specSlice(from, to) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `spec contains ${from} .. ${to}`);
  return html.slice(a, b);
}
const SPEC_HELPERS = specSlice('const N = {};', "document.getElementById('stats')");
const SPEC_BFS = specSlice('function bfs(start, dir)', 'let current = null');

// Spec's select() lane/edge computation, verbatim apart from the DOM output.
const SPEC_SELECT = `
function specSelect(id) {
  if (!N[id]) return null;
  const up = bfs(id, 'up'), down = bfs(id, 'down');
  const A = new Set([id, ...up]), D = new Set([id, ...down]);
  const all = new Set([...A, ...D]);
  const shownEdges = DATA.edges.filter(e => (A.has(e.source) && A.has(e.target)) || (D.has(e.source) && D.has(e.target)));
  const lanes = LANES.map(l => ({l, items: [...all].map(x => N[x]).filter(n => n && l[2].includes(n.type)).sort((a, b) => natural(shortId(a) + a.id, shortId(b) + b.id))}))
    .filter(x => x.items.length);
  return { up, down, all, shownEdges, lanes };
}
function specCounts(id) {
  const d = [...bfs(id, 'down')].map(x => N[x]).filter(Boolean);
  const c = {}; d.forEach(x => c[x.type] = (c[x.type] || 0) + 1); return c;
}`;

function specContext(data) {
  const ctx = vm.createContext({ DATA: data });
  vm.runInContext(SPEC_HELPERS + '\n' + SPEC_BFS + '\n' + SPEC_SELECT +
    '\nthis.api = { bfs, specSelect, specCounts, natural, shortId, shortLabel, verdictClass, isDerived, esc, LANES };', ctx);
  return ctx.api;
}

const DATASETS = [
  ['spec DATA', SPEC_DATA],
  ['reader data', READER_DATA],
];

// ---------------------------------------------------------------------------
// Equivalence with the spec, for every node
// ---------------------------------------------------------------------------

for (const [name, data] of DATASETS) {
  const spec = specContext(data);
  const ix = G.buildIndexes(data);

  test(`${name}: dataset is non-trivial`, () => {
    assert.ok(data.nodes.length >= 200, `${data.nodes.length} nodes`);
    assert.ok(data.edges.length >= 280, `${data.edges.length} edges`);
  });

  test(`${name}: buildIndexes matches the spec's N/OUT/IN`, () => {
    const ctx = vm.createContext({ DATA: data });
    vm.runInContext(SPEC_HELPERS + '\nthis.ix = { N, OUT, IN };', ctx);
    assert.deepStrictEqual(Object.keys(ix.byId).sort(), Object.keys(ctx.ix.N).sort());
    for (const id of Object.keys(ctx.ix.N)) assert.strictEqual(ix.byId[id], ctx.ix.N[id]);
    assert.deepStrictEqual(Object.keys(ix.out).sort(), Object.keys(ctx.ix.OUT).sort());
    assert.deepStrictEqual(Object.keys(ix.in).sort(), Object.keys(ctx.ix.IN).sort());
    for (const k of Object.keys(ctx.ix.OUT)) assert.deepStrictEqual(ix.out[k], [...ctx.ix.OUT[k]]);
    for (const k of Object.keys(ctx.ix.IN)) assert.deepStrictEqual(ix.in[k], [...ctx.ix.IN[k]]);
  });

  test(`${name}: bfs up/down equals the spec's bfs for every node (same order)`, () => {
    let nonEmpty = 0;
    for (const n of data.nodes) {
      for (const dir of ['up', 'down']) {
        const mine = [...G.bfs(ix, n.id, dir)];
        const ref = [...spec.bfs(n.id, dir)];
        assert.deepStrictEqual(mine, ref, `${dir} of ${n.id}`);
        if (mine.length) nonEmpty++;
      }
    }
    assert.ok(nonEmpty > data.nodes.length, `most traversals reach something (${nonEmpty})`);
  });

  test(`${name}: subgraph equals the spec's select() for every node`, () => {
    for (const n of data.nodes) {
      const mine = G.subgraph(ix, n.id);
      const ref = spec.specSelect(n.id);
      assert.deepStrictEqual([...mine.up], [...ref.up], n.id);
      assert.deepStrictEqual([...mine.down], [...ref.down], n.id);
      assert.deepStrictEqual(mine.nodeIds, [...ref.all], n.id);
      assert.strictEqual(mine.edges.length, ref.shownEdges.length, n.id);
      mine.edges.forEach((e, i) => assert.strictEqual(e, ref.shownEdges[i], `${n.id} edge ${i}`));
      assert.deepStrictEqual(mine.lanes.map((l) => l.key), [...ref.lanes].map((l) => l.l[0]), n.id);
      assert.deepStrictEqual(mine.lanes.map((l) => l.label), [...ref.lanes].map((l) => l.l[1]), n.id);
      mine.lanes.forEach((l, i) => {
        assert.deepStrictEqual(l.nodes.map((x) => x.id), [...ref.lanes[i].items].map((x) => x.id), `${n.id} lane ${l.key}`);
      });
    }
  });

  test(`${name}: downstreamCounts equals the spec's coverage cell counts`, () => {
    for (const n of data.nodes) {
      assert.deepStrictEqual({ ...G.downstreamCounts(ix, n.id) }, { ...spec.specCounts(n.id) }, n.id);
    }
  });

  test(`${name}: shortId / shortLabel equal the spec for every node`, () => {
    for (const n of data.nodes) {
      assert.strictEqual(G.shortId(n), String(spec.shortId(n)), n.id);
      assert.strictEqual(G.shortLabel(n), spec.shortLabel(n), n.id);
    }
  });

  test(`${name}: natural sorts ids like the spec`, () => {
    const ids = data.nodes.map((n) => n.id);
    assert.deepStrictEqual(ids.slice().sort(G.natural), ids.slice().sort(spec.natural));
  });
}

test('spec DATA: verdictClass and isDerived agree with the spec on every value', () => {
  const spec = specContext(SPEC_DATA);
  for (const n of SPEC_DATA.nodes) assert.strictEqual(G.verdictClass(n.verdict), spec.verdictClass(n.verdict), String(n.verdict));
  for (const e of SPEC_DATA.edges) assert.strictEqual(G.isDerived(e), spec.isDerived(e), e.origin);
  assert.strictEqual(SPEC_DATA.edges.filter(G.isDerived).length, 41);
});

test('reader data: isDerived recognises derived:<rule> origins', () => {
  const derived = READER_DATA.edges.filter(G.isDerived);
  assert.strictEqual(derived.length, 41);
  assert.ok(derived.every((e) => /^derived:/.test(e.origin)));
  assert.strictEqual(G.isDerived({ origin: 'derived:id-convention' }), true);
  assert.strictEqual(G.isDerived({ origin: 'ID convention (derived)' }), true);
  assert.strictEqual(G.isDerived({ origin: 'x/y', derived: true }), true);
  assert.strictEqual(G.isDerived({ origin: 'aidlc/derived-stuff/traceability.json' }), false);
  assert.strictEqual(G.isDerived({}), false);
  assert.strictEqual(G.isDerived(null), false);
});

test('verdictClass covers the reader wording', () => {
  assert.strictEqual(G.verdictClass('Covered'), 'ok');
  assert.strictEqual(G.verdictClass('Met'), 'ok');
  assert.strictEqual(G.verdictClass('Met (first run)'), 'ok');
  assert.strictEqual(G.verdictClass('Not covered'), 'bad');
  assert.strictEqual(G.verdictClass('Not Met'), 'bad');
  assert.strictEqual(G.verdictClass('Not met (accepted)'), 'bad');
  assert.strictEqual(G.verdictClass('Deferred'), 'def');
  assert.strictEqual(G.verdictClass('Unverified'), 'def');
  assert.strictEqual(G.verdictClass('N/A'), '');
  assert.strictEqual(G.verdictClass('See sub-NFRs'), '');
  assert.strictEqual(G.verdictClass(undefined), '');
  assert.strictEqual(G.verdictClass(''), '');
});

test('esc escapes markup characters and nullish input', () => {
  assert.strictEqual(G.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.strictEqual(G.esc(null), '');
  assert.strictEqual(G.esc(undefined), '');
  assert.strictEqual(G.esc(0), '0');
});

test('natural orders numeric segments and tolerates nullish', () => {
  assert.deepStrictEqual(['FR10', 'FR2', 'FR1.10', 'FR1.2'].sort(G.natural), ['FR1.2', 'FR1.10', 'FR2', 'FR10']);
  assert.strictEqual(G.natural(null, undefined), 0);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('empty and malformed data', () => {
  for (const d of [undefined, null, {}, { nodes: [], edges: [] }, { nodes: 'x', edges: 5 }]) {
    const ix = G.buildIndexes(d);
    assert.strictEqual(Object.keys(ix.byId).length, 0);
    assert.strictEqual(G.bfs(ix, 'X', 'down').size, 0);
    assert.strictEqual(G.subgraph(ix, 'X'), null);
    assert.deepStrictEqual(G.downstreamCounts(ix, 'X'), {});
  }
  const ix = G.buildIndexes({ nodes: [null, { id: 'A', type: 'code' }], edges: [null, { source: 'A' }] });
  assert.ok(ix.byId.A);
  assert.strictEqual(G.bfs(ix, 'A', 'down').size, 0);
  assert.strictEqual(G.bfs(null, 'A', 'down').size, 0);
});

test('unknown ids and nodes without edges', () => {
  const ix = G.buildIndexes({ nodes: [{ id: 'A', type: 'functional_requirement' }], edges: [] });
  assert.strictEqual(G.subgraph(ix, 'nope'), null);
  assert.strictEqual(G.subgraph(ix, undefined), null);
  assert.strictEqual(G.bfs(ix, 'nope', 'up').size, 0);
  assert.deepStrictEqual(G.outEdges(ix, 'A'), []);
  assert.deepStrictEqual(G.inEdges(ix, 'nope'), []);
  const sg = G.subgraph(ix, 'A');
  assert.deepStrictEqual(sg.nodeIds, ['A']);
  assert.deepStrictEqual(sg.edges, []);
  assert.deepStrictEqual(sg.lanes.map((l) => [l.key, l.nodes.map((n) => n.id)]), [['req', ['A']]]);
  // Prototype keys are not mistaken for nodes or edges.
  assert.strictEqual(G.subgraph(ix, 'constructor'), null);
  assert.strictEqual(G.bfs(ix, '__proto__', 'down').size, 0);
});

test('cycles terminate and never include the start node', () => {
  const data = {
    nodes: ['A', 'B', 'C', 'D'].map((id) => ({ id, type: 'code' })),
    edges: [
      { source: 'A', target: 'B' }, { source: 'B', target: 'C' }, { source: 'C', target: 'A' },
      { source: 'C', target: 'D' }, { source: 'D', target: 'D' },
    ],
  };
  const ix = G.buildIndexes(data);
  const spec = specContext(data);
  for (const n of data.nodes) for (const dir of ['up', 'down']) {
    assert.deepStrictEqual([...G.bfs(ix, n.id, dir)], [...spec.bfs(n.id, dir)], `${dir} ${n.id}`);
  }
  assert.deepStrictEqual([...G.bfs(ix, 'A', 'down')], ['B', 'C', 'D']);
  assert.deepStrictEqual([...G.bfs(ix, 'D', 'down')], []);
  assert.deepStrictEqual([...G.bfs(ix, 'D', 'up')], ['C', 'B', 'A']);
  const sg = G.subgraph(ix, 'A');
  assert.strictEqual(sg.edges.length, 5);
});

test('dangling edges are traversed but excluded from lanes and counts', () => {
  const data = {
    nodes: [{ id: 'FR1', type: 'functional_requirement' }, { id: 'T', type: 'test' }, { id: 'Z', type: 'mystery' }],
    edges: [{ source: 'FR1', target: 'ghost' }, { source: 'ghost', target: 'T' }, { source: 'FR1', target: 'Z' }],
  };
  const ix = G.buildIndexes(data);
  assert.deepStrictEqual([...G.bfs(ix, 'FR1', 'down')], ['ghost', 'Z', 'T']);
  const sg = G.subgraph(ix, 'FR1');
  assert.deepStrictEqual(sg.nodeIds, ['FR1', 'ghost', 'Z', 'T']);
  assert.deepStrictEqual(sg.lanes.map((l) => l.key), ['req', 'test']);
  assert.deepStrictEqual(G.downstreamCounts(ix, 'FR1'), { test: 1, mystery: 1 });
});

test('LANES order and laneOf match the spec', () => {
  const spec = specContext(SPEC_DATA);
  assert.deepStrictEqual(G.LANES.map((l) => [l.key, l.label, [...l.types]]), [...spec.LANES].map((l) => [l[0], l[1], [...l[2]]]));
  assert.strictEqual(G.laneOf('note').key, 'des');
  assert.strictEqual(G.laneOf('unknown'), null);
});

test('handles a large graph quickly', () => {
  const nodes = [], edges = [];
  for (let i = 0; i < 2000; i++) nodes.push({ id: 'N' + i, type: 'code' });
  for (let i = 0; i < 8000; i++) edges.push({ source: 'N' + (i % 2000), target: 'N' + ((i * 7 + 13) % 2000) });
  const t0 = Date.now();
  const ix = G.buildIndexes({ nodes, edges });
  for (let i = 0; i < 50; i++) G.subgraph(ix, 'N' + i);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

// ---------------------------------------------------------------------------
// Browser wrapper
// ---------------------------------------------------------------------------

test('loads in a fake browser context and exposes self.AidlcTrace', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.ok(!/\brequire\s*\(/.test(src), 'no require in the module');
  assert.ok(!/\bdocument\b|\bwindow\b/.test(src), 'no DOM access');
  const self = { AidlcTrace: { existing: 1 } };
  const ctx = vm.createContext({ self });
  vm.runInContext(src, ctx);
  assert.strictEqual(self.AidlcTrace.existing, 1, 'keeps other modules');
  for (const k of ['buildIndexes', 'bfs', 'subgraph', 'natural', 'shortId', 'shortLabel', 'verdictClass', 'isDerived', 'esc', 'downstreamCounts']) {
    assert.strictEqual(typeof self.AidlcTrace[k], 'function', k);
  }
  const ix = self.AidlcTrace.buildIndexes(SPEC_DATA);
  assert.strictEqual(self.AidlcTrace.bfs(ix, 'FR2.2', 'down').size, G.bfs(G.buildIndexes(SPEC_DATA), 'FR2.2', 'down').size);
  const keys = Object.keys(ctx).filter((k) => k !== 'self');
  assert.deepStrictEqual(keys, [], 'no extra globals');
});
