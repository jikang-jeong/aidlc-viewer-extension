'use strict';

// Tests for media/trace-explorer/views/trace-view.js.
// Renders against the real inventory-api fixture via readTraceData + buildIndexes, and checks
// the SVG edge pass with a small fake DOM that answers getBoundingClientRect.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readTraceData } = require('../src/aidlc/trace-data');
const graph = require('../media/trace-explorer/lib/graph.js');
// The view resolves graph helpers from AidlcTrace at call time, as in the webview where
// lib/graph.js fills self.AidlcTrace first.
globalThis.AidlcTrace = Object.assign(globalThis.AidlcTrace || {}, graph);
const view = require('../media/trace-explorer/views/trace-view.js');
const { PROJECT_ROOT, INTENT_ID } = require('./helpers/inventory-fixture');

const data = readTraceData(PROJECT_ROOT, { intent: INTENT_ID });
const ix = graph.buildIndexes(data);
const st = (selected, query = '') => ({ tab: 'trace', selected, covMode: 'fr', query });

function section(html, cls) {
  const start = html.indexOf(`<div class="panel ${cls}`);
  assert.ok(start >= 0, `no ${cls} panel`);
  const next = ['picker', 'canvasWrap', 'detail'].map((c) => html.indexOf(`<div class="panel ${c}`, start + 1)).filter((i) => i > start);
  return html.slice(start, next.length ? Math.min(...next) : undefined);
}
function decode(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function groups(html) {
  const out = {};
  for (const m of section(html, 'picker').matchAll(/<div class="grp">([^<]*) \((\d+)\)<\/div>/g)) out[m[1]] = Number(m[2]);
  return out;
}
// [{key, ids[]}] for each lane in the canvas, in order.
function lanes(html) {
  const canvas = section(html, 'canvasWrap');
  return canvas.split('<div class="lane"').slice(1).map((chunk) => ({
    key: /class="node ln-([a-z]+)/.exec(chunk)[1],
    ids: [...chunk.matchAll(/<button type="button" class="node[^"]*" data-select="([^"]*)"/g)].map((m) => decode(m[1])),
  }));
}

test('picker: groups and counts match the fixture, sorted naturally', () => {
  const html = view.renderTrace(data, ix, st('FR1.1'));
  assert.deepEqual(groups(html), {
    'Functional requirements': 13, 'Non-functional': 4, 'NFR detail': 32, 'User stories': 10,
    'Business rules': 16, Code: 16, Tests: 23,
  });
  const picker = section(html, 'picker');
  const frs = [...picker.matchAll(/class="pick[^"]*" data-select="(FR[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(frs, [...frs].sort(graph.natural));
  assert.equal(frs[0], 'FR1.1');
  // exactly one item is marked selected, and it is FR1.1
  const on = [...picker.matchAll(/class="pick on" data-select="([^"]*)" aria-current="true"/g)].map((m) => m[1]);
  assert.deepEqual(on, ['FR1.1']);
  assert.match(picker, /<input type="search" data-query /);
});

test('picker: state.query filters by id, label and text (case-insensitive)', () => {
  let html = view.renderTrace(data, ix, st('FR1.1', 'fr2.2'));
  assert.equal(groups(html)['Functional requirements'], 1);
  assert.match(section(html, 'picker'), /data-select="FR2\.2"/);
  assert.doesNotMatch(section(html, 'picker'), /data-select="FR1\.1"/);
  assert.match(section(html, 'picker'), /value="fr2\.2"/);
  html = view.renderTrace(data, ix, st('FR1.1', 'FR2.2'));
  assert.equal(groups(html)['Functional requirements'], 1);
  html = view.renderTrace(data, ix, st('FR1.1', 'item-handlers'));
  assert.equal(groups(html).Code, 1);
  html = view.renderTrace(data, ix, st('FR1.1', 'zzz-no-such-thing'));
  assert.match(section(html, 'picker'), /<div class="empty">No match<\/div>/);
  // code and test items show the file name, not the path
  html = view.renderTrace(data, ix, st('FR1.1', 'item-handlers.ts'));
  assert.match(section(html, 'picker'), /data-select="src\/items\/item-handlers\.ts"[^>]*><span class="mono">item-handlers\.ts<\/span><\/button>/);
});

test('canvas: lanes and node ids for FR1.1 follow graph.subgraph', () => {
  for (const id of ['FR1.1', 'BR1.1', 'src/items/item-handlers.ts', 'NFR1', 'US1.1']) {
    const html = view.renderTrace(data, ix, st(id));
    const sg = graph.subgraph(ix, id);
    assert.deepEqual(lanes(html), sg.lanes.map((l) => ({ key: l.key, ids: l.nodes.map((n) => n.id) })), id);
    const sel = [...section(html, 'canvasWrap').matchAll(/class="node ln-[a-z]+ sel" data-select="([^"]*)" aria-current="true"/g)].map((m) => decode(m[1]));
    assert.deepEqual(sel, [id]);
    assert.match(html, new RegExp(`${sg.up.size} upstream, ${sg.down.size} downstream, ${sg.edges.length} links?<`));
  }
});

test('canvas: concrete lanes for FR1.1, BR1.1 and a code file', () => {
  const keys = (id) => lanes(view.renderTrace(data, ix, st(id))).map((l) => `${l.key}:${l.ids.length}`).join(' ');
  assert.equal(keys('FR1.1'), 'req:1 us:1 ac:5 br:2 des:2 code:4 test:3');
  assert.equal(keys('BR1.1'), 'req:2 us:1 ac:2 br:1 code:1 test:1');
  assert.equal(keys('src/items/item-handlers.ts'), 'req:2 us:1 ac:1 code:1 test:1');
  const fr = lanes(view.renderTrace(data, ix, st('FR1.1')));
  assert.deepEqual(fr[0].ids, ['FR1.1']);
  assert.deepEqual(fr[1].ids, ['US1.1']);
  assert.deepEqual(fr[2].ids, ['AC1.1.1', 'AC1.1.2', 'AC1.1.3', 'AC1.1.4', 'AC1.1.5']);
});

test('canvas: node cards carry lane stripe, verdict, rework and why badges', () => {
  const html = section(view.renderTrace(data, ix, st('FR1.1')), 'canvasWrap');
  assert.match(html, /class="node ln-req sel" data-select="FR1\.1"[^>]*><span class="id">FR1\.1<\/span><span class="lb">[^<]+<\/span><span class="badges"><span class="bdg ok">Covered<\/span><span class="bdg">why: 2<\/span>/);
  assert.match(html, /data-select="BR1\.1"[\s\S]*?<span class="bdg rw" title="Source invalidated by the backward jump of 2026-11-09">Reworked<span class="sr-only"> \(source invalidated by the backward jump of 2026-11-09\)<\/span><\/span>/);
  assert.match(html, /<svg class="links" aria-hidden="true" focusable="false"><\/svg>/);
  // a deferred incoming link inside the view is flagged on the card
  const nfr = section(view.renderTrace(data, ix, st('NFR1')), 'canvasWrap');
  assert.match(nfr, /bdg def">Deferred link</);
});

test('detail: FR1.1 heading, type, verdict, why-cards, links, source', () => {
  const d = section(view.renderTrace(data, ix, st('FR1.1')), 'detail');
  assert.match(d, /<h3 tabindex="-1">FR1\.1<\/h3><div class="ty">Functional requirement<\/div>/);
  assert.match(d, /<span class="bdg ok" title="[^"]*cross-unit-traceability\.md">As built: Covered<\/span>/);
  assert.match(d, /<div class="txt">The system shall create an inventory item/);
  assert.match(d, /<h4>Why it exists<\/h4>/);
  assert.equal((d.match(/<div class="why">/g) || []).length, 2);
  assert.match(d, /<div class="why"><span class="src"><button type="button" class="open" data-open="[^"]*requirements-analysis-questions\.md"[^>]*><b>Q1<\/b><\/button><\/span> <span class="sev">requirements-analysis<\/span><div class="q">Item data model/);
  const outs = ix.out['FR1.1'].length;
  assert.match(d, new RegExp(`<h4>Downstream \\(${outs}\\)</h4>`));
  assert.doesNotMatch(d, /<h4>Upstream/);
  assert.match(d, /<div class="lk"><span class="rel">realized by story<\/span><button type="button" data-select="US1\.1"/);
  assert.match(d, /<h4>Source<\/h4><div class="src"><button type="button" class="open" data-open="aidlc\/spaces\/default\/intents\/260825-inventory-api\/inception\/requirements-analysis\/requirements\.md"/);
  assert.doesNotMatch(d, /href=/);
});

test('detail: BR1.1 rework badge, upstream rows and open findings; US1.1 derived note', () => {
  const d = section(view.renderTrace(data, ix, st('BR1.1')), 'detail');
  assert.match(d, /<span class="bdg rw">Source invalidated by the backward jump of 2026-11-09 \(functional-design back to contract-design\)<\/span>/);
  assert.match(d, /<h4>Upstream \(2\)<\/h4>/);
  assert.match(d, /<span class="rel">from \(refined by rule\)<\/span><button type="button" data-select="AC1\.1\.1"/);
  const findings = data.drift.filter((x) => x.id === 'BR1.1' || (x.ids || []).includes('BR1.1')).length;
  assert.ok(findings > 0);
  assert.equal((d.match(/<div class="note drift">Open finding at approval/g) || []).length, findings);

  const us = section(view.renderTrace(data, ix, st('US1.1')), 'detail');
  assert.match(us, /<span class="org" title="derived:id-convention">derived<\/span>/);
  assert.match(us, /<div class="note">Dashed links are inferred by a naming rule/);
});

test('detail: code file and design decision', () => {
  const d = section(view.renderTrace(data, ix, st('src/items/item-handlers.ts')), 'detail');
  assert.match(d, /<h3 tabindex="-1">src\/items\/item-handlers\.ts<\/h3><div class="ty">Code file<\/div>/);
  assert.match(d, /<h4>Upstream \(\d+\)<\/h4>/);
  const dd = data.nodes.find((n) => n.type === 'design_decision');
  const h = section(view.renderTrace(data, ix, st(dd.id)), 'detail');
  assert.match(h, new RegExp(`<h3 tabindex="-1">${dd.stage}</h3><div class="ty">Design decision</div><div class="sev">${dd.id.replace(/[.]/g, '\\.')}</div>`));
  // a code target that is not on disk is shown, not offered as a link
  const gone = data.nodes.find((n) => n.exists === false);
  assert.ok(gone, 'the fixture has a code target that is not on disk (.github/dependabot.yml)');
  const gd = section(view.renderTrace(data, ix, st(gone.id)), 'detail');
  assert.match(gd, /\(not in the project\)/);
  assert.doesNotMatch(gd, /<h4>Source<\/h4><div class="src"><button/);
});

test('unknown, empty or missing selection renders placeholders, not a throw', () => {
  for (const sel of [null, undefined, '', 'NOPE', '__proto__', 'constructor']) {
    const html = view.renderTrace(data, ix, st(sel));
    assert.match(section(html, 'canvasWrap'), /Pick an item from the list/);
    assert.match(section(html, 'detail'), /Nothing selected\./);
    assert.doesNotMatch(html, /class="pick on"/);
    assert.equal(Object.keys(groups(html)).length, 7);
  }
  assert.doesNotThrow(() => view.renderTrace(data, ix, undefined));
});

test('data with no nodes, and a node with no edges', () => {
  for (const d of [{ nodes: [], edges: [] }, {}, null]) {
    const html = view.renderTrace(d, graph.buildIndexes(d), st(null));
    assert.match(html, /No trace items in this project/);
    assert.match(html, /The project has no trace items yet\./);
    assert.match(html, /No trace items to show\./);
    assert.equal(view.afterRenderTrace(fakeContainer(html).container, d, graph.buildIndexes(d), st(null)), 0);
  }
  const lone = { nodes: [{ id: 'FR9', type: 'functional_requirement', label: 'Alone' }], edges: [] };
  const lix = graph.buildIndexes(lone);
  const html = view.renderTrace(lone, lix, st('FR9'));
  assert.deepEqual(lanes(html), [{ key: 'req', ids: ['FR9'] }]);
  assert.match(html, /0 upstream, 0 downstream, 0 links/);
  assert.match(section(html, 'detail'), /No trace links to or from this item\./);
  const f = fakeContainer(html);
  assert.equal(view.afterRenderTrace(f.container, lone, lix, st('FR9')), 0);
  assert.equal(f.svg.innerHTML, '');
  view.disposeTrace();
});

test('no style= attributes and no inline handlers for any selection', () => {
  const ids = ['FR1.1', 'BR1.1', 'NFR1', 'US1.1', 'src/items/item-handlers.ts', null, ...data.nodes.slice(0, 60).map((n) => n.id)];
  for (const id of ids) {
    const html = view.renderTrace(data, ix, st(id, id ? '' : 'item'));
    assert.doesNotMatch(html, /\sstyle\s*=/i, String(id));
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, String(id));
    assert.doesNotMatch(html, /\sstroke(-[a-z]+)?\s*=/i, String(id));
  }
});

test('keyboard: every actionable element is a native button (focusable, Enter activates)', () => {
  const html = view.renderTrace(data, ix, st('FR1.1'));
  const tags = [...html.matchAll(/<([a-z]+)\b[^>]*\sdata-(select|open)=/g)].map((m) => m[1]);
  assert.ok(tags.length > 50);
  assert.deepEqual([...new Set(tags)], ['button']);
  // the only tabindex is the detail heading's -1 (script focus target, not in the Tab order)
  assert.deepEqual(html.match(/<[a-z0-9]+\b[^>]*tabindex="[^"]*"/g), ['<h3 tabindex="-1"']);
  assert.doesNotMatch(html, /data-go=/); // Trace selects and stays
});

test('hostile labels, ids and paths are escaped', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const d = {
    meta: {},
    nodes: [
      { id: 'FR<1>"x', type: 'functional_requirement', label: evil, text: evil, path: 'a"b<c>.md', verdict: '<b>Met</b>', why: [{ ref: evil, stage: evil, q: evil, a: evil, path: '"><script>' }] },
      { id: "US'1", type: 'user_story', label: evil, priority: evil, notes: [{ stage: evil, status: evil, text: evil }] },
    ],
    edges: [{ source: 'FR<1>"x', target: "US'1", relation: evil, status: evil, origin: evil }],
    drift: [{ id: 'FR<1>"x', ids: [], note: evil, stage: evil, findingId: evil, severity: evil, file: '"><svg onload=x>' }],
    jump: { ts: evil, source: evil, target: evil },
  };
  const dix = graph.buildIndexes(d);
  for (const sel of ['FR<1>"x', "US'1"]) {
    for (const q of ['', '<img']) {
      const html = view.renderTrace(d, dix, st(sel, q));
      assert.doesNotMatch(html, /<img|<script|<svg onload|<b>Met/);
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
    }
  }
  const html = view.renderTrace(d, dix, st('FR<1>"x'));
  assert.match(html, /data-select="FR&lt;1&gt;&quot;x"/);
  assert.match(html, /data-open="a&quot;b&lt;c&gt;\.md"/);
});

test('renderTrace is pure: it does not mutate state or data', () => {
  const s = Object.freeze(st('FR1.1', 'fr'));
  const before = JSON.stringify(data);
  const a = view.renderTrace(data, ix, s);
  const b = view.renderTrace(data, ix, s);
  assert.equal(a, b);
  assert.equal(JSON.stringify(data), before);
  assert.equal(view.renderTrace(data, null, s), a); // builds its own indexes when none are given
});

// ---------------------------------------------------------------- fake DOM for afterRenderTrace

// Lays the rendered node cards out like the CSS: lanes 178px wide with a 34px gap, cards 60px tall
// with an 8px gap, 18px / 14px padding. Returns the container, the svg and a fake window.
function fakeContainer(html, { hidden = false } = {}) {
  const ls = html.includes('<div class="lane"') ? lanes(html) : [];
  const ORIGIN = { left: 100, top: 50 };
  const rect = (l, t, w, h) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h });
  const cards = [];
  ls.forEach((lane, i) => lane.ids.forEach((id, j) => {
    const l = ORIGIN.left + 18 + i * (178 + 34), t = ORIGIN.top + 14 + 30 + j * (60 + 8);
    cards.push({ getAttribute: (k) => (k === 'data-select' ? id : null), getBoundingClientRect: () => rect(l, t, 178, 60) });
  }));
  const attrs = {};
  const svg = { innerHTML: '', setAttribute: (k, v) => { attrs[k] = v; }, attrs };
  const hasSvg = html.includes('<svg class="links"');
  const canvas = {
    scrollWidth: 18 * 2 + ls.length * 212, scrollHeight: 800,
    getBoundingClientRect: () => (hidden ? rect(0, 0, 0, 0) : rect(ORIGIN.left, ORIGIN.top, 1200, 800)),
    querySelector: (s) => (s === 'svg.links' && hasSvg ? svg : null),
    querySelectorAll: (s) => (s === '.node' ? cards : []),
  };
  const listeners = new Set();
  const frames = [];
  const win = {
    addEventListener: (t, fn) => { if (t === 'resize') listeners.add(fn); },
    removeEventListener: (t, fn) => { if (t === 'resize') listeners.delete(fn); },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
  };
  const container = {
    isConnected: true,
    ownerDocument: { defaultView: win },
    querySelector: (s) => (s === '.canvas' ? canvas : null),
  };
  const flush = () => { while (frames.length) frames.shift()(); };
  return { container, svg, canvas, cards, win, listeners, flush };
}

function paths(svgHtml) {
  return [...svgHtml.matchAll(/<path class="([^"]*)" d="([^"]*)"\/>/g)].map((m) => ({ cls: m[1].split(' '), d: m[2] }));
}

test('afterRenderTrace: one cubic Bezier path per subgraph edge, styled by class only', () => {
  for (const id of ['FR1.1', 'BR1.1', 'src/items/item-handlers.ts', 'NFR1', 'US1.1']) {
    const s = st(id);
    const html = view.renderTrace(data, ix, s);
    const f = fakeContainer(html);
    const n = view.afterRenderTrace(f.container, data, ix, s);
    const sg = graph.subgraph(ix, id);
    const drawable = sg.edges.filter((e) => ix.byId[e.source] && ix.byId[e.target] && graph.laneOf(ix.byId[e.source].type) && graph.laneOf(ix.byId[e.target].type));
    const ps = paths(f.svg.innerHTML);
    assert.equal(n, drawable.length, id);
    assert.equal(ps.length, drawable.length, id);
    assert.equal(drawable.length, sg.edges.length, `${id}: every fixture edge has both ends on the canvas`);
    assert.equal((f.svg.innerHTML.match(/<path /g) || []).length, ps.length);
    assert.doesNotMatch(f.svg.innerHTML, /stroke|style=|opacity=|fill=/);
    for (const p of ps) {
      assert.equal(p.cls[0], 'edge');
      assert.match(p.d, /^M-?[\d.]+,-?[\d.]+ C-?[\d.]+,-?[\d.]+ -?[\d.]+,-?[\d.]+ -?[\d.]+,-?[\d.]+$/);
    }
    sg.edges.forEach((e, i) => {
      assert.equal(ps[i].cls.includes('hot'), e.source === id || e.target === id);
      assert.equal(ps[i].cls.includes('derived'), graph.isDerived(e));
      assert.equal(ps[i].cls.includes('deferred'), e.status === 'Deferred');
    });
    assert.equal(f.svg.attrs.width, String(f.canvas.scrollWidth));
    assert.equal(f.svg.attrs.height, String(f.canvas.scrollHeight));
  }
  view.disposeTrace();
});

test('afterRenderTrace: geometry matches the spec drawLinks (forward and loop-back)', () => {
  // forward: a.r=196, b.l=230 -> mid 213
  assert.equal(view.traceEdgePath({ l: 18, r: 196, y: 74 }, { l: 230, r: 408, y: 142 }), 'M196,74 C213,74 213,142 230,142');
  // same lane or backwards: loop out 14px to the right, enter b's right side
  assert.equal(view.traceEdgePath({ l: 18, r: 196, y: 74 }, { l: 18, r: 196, y: 142 }), 'M196,74 C210,74 210,142 196,142');
  const s = st('FR1.1');
  const html = view.renderTrace(data, ix, s);
  const f = fakeContainer(html);
  view.afterRenderTrace(f.container, data, ix, s);
  const k = graph.subgraph(ix, 'FR1.1').edges.findIndex((e) => e.source === 'FR1.1');
  assert.ok(k >= 0);
  // FR1.1 sits in lane 0 row 0 (left 18, right 196, mid y 14+30+30=74) relative to the canvas,
  // US1.1 in lane 1 row 0 (left 230)
  assert.equal(paths(f.svg.innerHTML)[k].d, 'M196,74 C213,74 213,74 230,74');
  view.disposeTrace();
});

test('afterRenderTrace: hidden canvas, unknown selection and missing svg draw nothing', () => {
  const s = st('FR1.1');
  const html = view.renderTrace(data, ix, s);
  const hidden = fakeContainer(html, { hidden: true });
  assert.equal(view.afterRenderTrace(hidden.container, data, ix, s), 0);
  assert.equal(hidden.svg.innerHTML, '');
  const unk = fakeContainer(html);
  assert.equal(view.afterRenderTrace(unk.container, data, ix, st('NOPE')), 0);
  assert.equal(unk.listeners.size, 0);
  const nosvg = fakeContainer(view.renderTrace(data, ix, st(null)));
  assert.equal(view.afterRenderTrace(nosvg.container, data, ix, s), 0);
  assert.doesNotThrow(() => view.afterRenderTrace(null, data, ix, s));
  view.disposeTrace();
});

test('afterRenderTrace: resize redraws, and listeners never accumulate', () => {
  const s = st('FR1.1');
  const html = view.renderTrace(data, ix, s);
  const f = fakeContainer(html);
  for (let i = 0; i < 5; i++) view.afterRenderTrace(f.container, data, ix, s);
  assert.equal(f.listeners.size, 1);

  // a resize moves the cards: the redraw (on the next frame) uses the new geometry
  const before = f.svg.innerHTML;
  f.cards.forEach((c) => { const r = c.getBoundingClientRect(); c.getBoundingClientRect = () => ({ ...r, top: r.top + 100, bottom: r.bottom + 100 }); });
  const [fn] = f.listeners;
  fn(); fn(); fn();
  f.flush();
  assert.notEqual(f.svg.innerHTML, before);
  assert.equal(paths(f.svg.innerHTML).length, graph.subgraph(ix, 'FR1.1').edges.length);
  const k = graph.subgraph(ix, 'FR1.1').edges.findIndex((e) => e.source === 'FR1.1');
  assert.equal(paths(f.svg.innerHTML)[k].d, 'M196,174 C213,174 213,174 230,174');

  // a new render in another container moves the single listener there
  const g = fakeContainer(html);
  view.afterRenderTrace(g.container, data, ix, s);
  assert.equal(f.listeners.size, 0);
  assert.equal(g.listeners.size, 1);

  // when the canvas leaves the document, the next resize removes the listener itself
  g.container.isConnected = false;
  [...g.listeners][0]();
  assert.equal(g.listeners.size, 0);

  // an unknown selection drops any live listener
  const h = fakeContainer(html);
  view.afterRenderTrace(h.container, data, ix, s);
  assert.equal(h.listeners.size, 1);
  view.afterRenderTrace(h.container, data, ix, st('NOPE'));
  assert.equal(h.listeners.size, 0);
  view.disposeTrace();
});

test('the browser wrapper adds renderTrace / afterRenderTrace to self.AidlcTrace', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'media', 'trace-explorer');
  const sandbox = { self: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, 'lib', 'graph.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, 'views', 'trace-view.js'), 'utf8'), sandbox);
  const L = sandbox.self.AidlcTrace;
  assert.equal(typeof L.renderTrace, 'function');
  assert.equal(typeof L.afterRenderTrace, 'function');
  assert.equal(typeof L.subgraph, 'function'); // graph helpers are kept
  const html = L.renderTrace(data, L.buildIndexes(data), st('FR1.1'));
  assert.equal(html, view.renderTrace(data, ix, st('FR1.1')));
});

function pickerBox(itemTopInViewport, { boxTop = 200, clientHeight = 600, scrollTop = 0 } = {}) {
  const box = { scrollTop, clientHeight, getBoundingClientRect: () => ({ top: boxTop, height: clientHeight }) };
  // the item's viewport top moves up as the box scrolls
  const base = itemTopInViewport + scrollTop;
  const on = { getBoundingClientRect: () => ({ top: base - box.scrollTop, height: 28 }) };
  box.querySelector = (q) => (q === '.pick.on' ? on : null);
  return box;
}
function withPicker(f, box) {
  const inner = f.container.querySelector;
  f.container.querySelector = (q) => (q === '.picker' ? box : inner(q));
}

test('afterRenderTrace: the selected picker item is scrolled into the picker, not the page', () => {
  const s = st('NFR1.8');
  const html = view.renderTrace(data, ix, s);
  const f = fakeContainer(html);
  // item 1500px below the top of the box's content
  const box = pickerBox(200 + 1500);
  withPicker(f, box);
  view.afterRenderTrace(f.container, data, ix, s);
  assert.equal(box.scrollTop, 1300);
  // already visible: left alone
  view.afterRenderTrace(f.container, data, ix, s);
  assert.equal(box.scrollTop, 1300);
  view.disposeTrace();
});

test('afterRenderTrace: picker reveal also works in the stacked layout (static picker, no offsetParent)', () => {
  // Below 1100px the picker is position:static, so offsetTop is not relative to it; the view
  // must use rects. The fake item has no offsetTop/offsetParent at all.
  const s = st('NFR1.8');
  const f = fakeContainer(view.renderTrace(data, ix, s));
  const box = pickerBox(1900 + 900, { boxTop: 1900, clientHeight: 300 });
  withPicker(f, box);
  view.afterRenderTrace(f.container, data, ix, s);
  assert.equal(box.scrollTop, 800);
  // an item above the visible window scrolls back up
  const up = pickerBox(1900 - 100, { boxTop: 1900, clientHeight: 300, scrollTop: 500 }); // content offset 400
  const g = fakeContainer(view.renderTrace(data, ix, s));
  withPicker(g, up);
  view.afterRenderTrace(g.container, data, ix, s);
  assert.equal(up.scrollTop, 300);
  view.disposeTrace();
});

test('picker items have an accessible name with a separator between ID and label', () => {
  const picker = section(view.renderTrace(data, ix, st('FR1.1')), 'picker');
  const fr = data.nodes.find((n) => n.id === 'FR1.1');
  assert.ok(picker.includes(`data-select="FR1.1" aria-current="true" aria-label="FR1.1 ${fr.label}"`));
  assert.match(picker, /data-select="src\/items\/item-handlers\.ts" aria-label="src\/items\/item-handlers\.ts"/);
  const n = (picker.match(/<button type="button" class="pick/g) || []).length;
  assert.equal((picker.match(/<button type="button" class="pick[^>]* aria-label="[^"]+"/g) || []).length, n);
});

test('detail heading is focusable by script only, and the panel is not a live region', () => {
  const html = view.renderTrace(data, ix, st('FR1.1'));
  assert.match(section(html, 'detail'), /^<div class="panel detail"><h3 tabindex="-1">/);
  assert.doesNotMatch(html, /aria-live/);
});

// ---------------------------------------------------------------- independent oracle

// The design spec's own algorithm (bfs + select's lane building, copied from
// the design spec; DATA from tests/fixtures/design-spec/data.json) run on the spec's DATA, compared with what
// the view renders for the same DATA, for every node.
test('oracle: spec bfs/select on the spec DATA match the rendered header and lanes for every node', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'design-spec', 'data.json'), 'utf8'));

  // --- spec code (verbatim logic) ---
  const N = {}; DATA.nodes.forEach((n) => { N[n.id] = n; });
  const OUT = {}, IN = {};
  DATA.edges.forEach((e) => { (OUT[e.source] = OUT[e.source] || []).push(e); (IN[e.target] = IN[e.target] || []).push(e); });
  const LANES = [
    ['req', 'Requirement', ['functional_requirement', 'nfr']], ['nfrd', 'NFR detail', ['nfr_detail']],
    ['us', 'User story', ['user_story']], ['ac', 'Acceptance criterion', ['acceptance_criterion']],
    ['br', 'Business rule', ['business_rule']], ['des', 'Design', ['component', 'unit', 'design_decision', 'stage', 'note']],
    ['code', 'Code', ['code']], ['test', 'Test', ['test']]];
  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const shortId = (n) => (n.type === 'design_decision' ? n.stage : n.type === 'note' ? 'deferral note' : n.id);
  function bfs(start, dir) {
    const seen = new Set(), q = [start];
    while (q.length) {
      const x = q.shift();
      ((dir === 'down' ? OUT : IN)[x] || []).forEach((e) => { const y = dir === 'down' ? e.target : e.source; if (!seen.has(y) && y !== start) { seen.add(y); q.push(y); } });
    }
    return seen;
  }
  function specSelect(id) {
    const up = bfs(id, 'up'), down = bfs(id, 'down');
    const A = new Set([id, ...up]), D = new Set([id, ...down]);
    const all = new Set([...A, ...D]);
    const shownEdges = DATA.edges.filter((e) => (A.has(e.source) && A.has(e.target)) || (D.has(e.source) && D.has(e.target)));
    const lanes = LANES.map((l) => ({ l, items: [...all].map((x) => N[x]).filter((n) => n && l[2].includes(n.type)).sort((a, b) => natural(shortId(a) + a.id, shortId(b) + b.id)) }))
      .filter((x) => x.items.length);
    return { up: up.size, down: down.size, links: shownEdges.length, lanes: lanes.map((x) => ({ key: x.l[0], ids: x.items.map((n) => n.id) })) };
  }
  // --- end spec code ---

  const six = graph.buildIndexes(DATA);
  assert.equal(DATA.nodes.length, 216);
  for (const n of DATA.nodes) {
    const want = specSelect(n.id);
    const html = view.renderTrace(DATA, six, st(n.id));
    const head = /<span class="t"><b>[^<]*<\/b>: (\d+) upstream, (\d+) downstream, (\d+) links?<\/span>/.exec(html);
    assert.ok(head, n.id);
    assert.deepEqual({ up: +head[1], down: +head[2], links: +head[3] }, { up: want.up, down: want.down, links: want.links }, n.id);
    assert.deepEqual(lanes(html), want.lanes, n.id);
    const f = fakeContainer(html);
    assert.equal(view.afterRenderTrace(f.container, DATA, six, st(n.id)), want.links, n.id);
  }
  view.disposeTrace();
});
