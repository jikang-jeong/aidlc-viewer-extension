'use strict';

// Tests for media/trace-explorer/views/reviews-view.js and about-view.js.
//
// Every expectation is recomputed here from the data the reader builds from the
// reference project (readTraceData + buildIndexes), not copied from the view's own helpers.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { readTraceData } = require('../src/aidlc/trace-data');
const G = require('../media/trace-explorer/lib/graph');
const { renderReviews, reviewsViewInternals } = require('../media/trace-explorer/views/reviews-view');
const { renderAbout } = require('../media/trace-explorer/views/about-view');

const { PROJECT_ROOT } = require('./helpers/inventory-fixture');
const VIEWS = path.resolve(__dirname, '..', 'media', 'trace-explorer', 'views');
const DATA = readTraceData(PROJECT_ROOT, { intent: '260825-inventory-api' });
const IDX = G.buildIndexes(DATA);
const STATE = Object.freeze({ tab: 'rev', selected: null, covMode: 'fr', query: '' });

const REV = renderReviews(DATA, IDX, STATE);
const ABOUT = renderAbout(DATA, IDX, STATE);

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function sections(html) {
  const j = html.indexOf('<h3>The backward jump</h3>');
  const d = html.indexOf('<h3>Open findings at approval</h3>');
  assert.ok(j > 0 && d > j, 'reviews, jump and findings sections in that order');
  return { reviews: html.slice(0, j), jump: html.slice(j, d), drift: html.slice(d) };
}

function rows(html) {
  const re = /<div class="rev" role="listitem"[^>]*><span class="d" title="([^"]*)">([^<]*)<\/span>(?:<span class="src"><button[^>]*data-open="([^"]*)"(?: data-line="(\d+)")? aria-label="([^"]*)"[^>]*>([^<]*)<\/button><\/span>|<span>([^<]*)<\/span>)<span class="v(?: (R|N))?">([^<]*)<\/span><span class="sev">([^<]*)<\/span><\/div>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ date: unesc(m[1]), shown: unesc(m[2]), file: m[3] && unesc(m[3]), line: m[4] ? Number(m[4]) : null, aria: m[5] && unesc(m[5]), stage: unesc(m[6] || m[7]), cls: m[8] || '', verdict: unesc(m[9]), counts: unesc(m[10]) });
  return out;
}

function driftGroups(html) {
  const parts = html.split('<div class="grp" role="heading" aria-level="4">').slice(1);
  return parts.map((p) => {
    const head = unesc(p.slice(0, p.indexOf('</div>')));
    const items = [];
    const re = /<div class="lk"><span class="bdg[^"]*">([^<]*)<\/span><span class="rel">([^<]*)<\/span>((?:<button[^>]*data-go="[^"]*"[^>]*>[^<]*<\/button>)*)<span class="sev">([^<]*)<\/span>(?:<span class="src"><button[^>]*data-open="([^"]*)"[^>]*>([^<]*)<\/button><\/span>)?/g;
    let m;
    while ((m = re.exec(p))) {
      const goes = [...m[3].matchAll(/data-go="([^"]*)"/g)].map((x) => unesc(x[1]));
      items.push({ severity: unesc(m[1]), findingId: unesc(m[2]), goes, summary: unesc(m[4]), open: m[5] && unesc(m[5]), openLabel: m[6] && unesc(m[6]) });
    }
    return { head, items };
  });
}

const SEV = { Critical: 0, Major: 1, Minor: 2 };
// Expected order, computed here independently of the view: by time, undated last, ties stable.
const byTime = (list) => list.map((r, i) => ({ r, i })).sort((a, b) => {
  const ta = a.r.date ? Date.parse(a.r.date) : Infinity, tb = b.r.date ? Date.parse(b.r.date) : Infinity;
  return ta === tb ? a.i - b.i : ta < tb ? -1 : 1;
}).map((x) => x.r);
const SORTED = byTime(DATA.reviews);
const rank = (s) => (s in SEV ? SEV[s] : 3);

// ---------------------------------------------------------------- fixture sanity

test('fixture: the reader returns the reviews, jump and drift the view expects', () => {
  assert.strictEqual(DATA.reviews.length, 21);
  assert.ok(DATA.jump, 'one backward jump');
  assert.strictEqual(DATA.drift.length, 37);
});

// ---------------------------------------------------------------- reviews

test('reviews: one row per review, oldest first (the spec order)', () => {
  const r = rows(sections(REV).reviews);
  assert.strictEqual(r.length, DATA.reviews.length);
  assert.deepStrictEqual(r.map((x) => x.date), SORTED.map((x) => x.date));
  for (let i = 1; i < r.length; i++) assert.ok(Date.parse(r[i - 1].date) <= Date.parse(r[i].date), `row ${i} not after row ${i - 1}`);
  assert.match(sections(REV).reviews, /<div class="revList" role="list">/);
  assert.strictEqual(r[0].stage, 'intent-capture');
  assert.strictEqual(r[r.length - 1].stage, 'nfr-design (iter 2)');
  // The rendered date is the short UTC form of the ISO timestamp.
  assert.match(sections(REV).reviews, /<span class="d" title="2026-08-28T13:40:37Z">2026-08-28 13:40<\/span>/);
});

test('reviews: verdict pill is R for READY, N for NOT-READY, neutral otherwise', () => {
  const r = rows(REV);
  for (const x of r) assert.strictEqual(x.cls, x.verdict === 'READY' ? 'R' : x.verdict === 'NOT-READY' ? 'N' : '', `${x.date} ${x.verdict}`);
  assert.strictEqual(r.filter((x) => x.cls === 'N').length, DATA.reviews.filter((x) => x.verdict !== 'READY').length);
  assert.strictEqual(r.filter((x) => x.cls === 'N').length, 3);
});

test('reviews: finding counts are recomputed from each review\'s findings', () => {
  let total = 0;
  const r = rows(REV);
  assert.strictEqual(r.length, SORTED.length);
  r.forEach((row, i) => {
    const rv = SORTED[i];
    assert.strictEqual(row.date, rv.date);
    const c = { Critical: 0, Major: 0, Minor: 0 };
    for (const f of rv.findings) c[f.severity] = (c[f.severity] || 0) + 1;
    const parts = [];
    if (c.Critical) parts.push(c.Critical + ' critical');
    if (c.Major) parts.push(c.Major + ' major');
    if (c.Minor) parts.push(c.Minor + ' minor');
    let want = parts.length ? parts.join(', ') : 'no findings';
    if (rv.open != null) {
      const open = rv.findings.filter((f) => f.status === 'New' || f.status === 'Unresolved').length;
      want += ' · ' + open + ' open';
    }
    assert.strictEqual(row.counts, want, `${row.date} ${row.stage}`);
    total += c.Critical + c.Major + c.Minor;
  });
  assert.ok(total > 0);
});

test('reviews: counts match one engine review file read directly', () => {
  const rel = 'aidlc/spaces/default/intents/260825-inventory-api/.aidlc-engine/reviews/functional-design/units/inventory-api/58cb9181c57f4edf/1.json';
  const raw = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8'));
  const findings = raw.findings || (raw.review && raw.review.findings) || [];
  const sev = (f) => String(f.severity || '').toLowerCase();
  const c = { critical: 0, major: 0, minor: 0 };
  for (const f of findings) if (sev(f) in c) c[sev(f)]++;
  const open = findings.filter((f) => /^(new|unresolved)$/i.test(String(f.status || ''))).length;
  assert.deepStrictEqual([c.critical, c.major, c.minor, open], [1, 3, 6, 9]);
  const i = SORTED.findIndex((x) => x.source === rel);
  assert.ok(i >= 0, 'review from that file is in the data');
  assert.strictEqual(rows(REV)[i].counts, '1 critical, 3 major, 6 minor · 9 open');
  assert.strictEqual(rows(REV)[i].cls, 'N');
});

test('reviews: undated reviews go last, tied dates keep data order, dates compare as times', () => {
  const mk = (stage, date) => ({ stage, date, verdict: 'READY', critical: 0, major: 0, minor: 0, findings: [] });
  const list = [
    mk('undated-a', undefined), mk('late', '2026-01-02T00:00:00Z'), mk('tie-1', '2026-01-01T10:00:00Z'),
    mk('undated-b', ''), mk('tie-2', '2026-01-01T10:00:00Z'), mk('offset', '2026-01-01T09:30:00-02:00')
  ];
  // 09:30-02:00 is 11:30Z: after the ties, although it sorts first as a string.
  const want = ['tie-1', 'tie-2', 'offset', 'late', 'undated-a', 'undated-b'];
  assert.deepStrictEqual(reviewsViewInternals.sortReviews(list).map((x) => x.stage), want);
  const h = renderReviews({ reviews: list }, null, STATE);
  assert.deepStrictEqual(rows(h).map((x) => x.stage), want);
  assert.strictEqual(rows(h)[5].shown, 'no date');
  // Unknown verdicts get the neutral pill, never the red one.
  const odd = renderReviews({ reviews: [Object.assign(mk('s', '2026-01-01T00:00:00Z'), { verdict: 'PENDING' })] }, null, STATE);
  assert.ok(odd.includes('<span class="v">PENDING</span>'));
  assert.ok(!odd.includes('class="v N"'));
});

test('reviews: the first contract-design review opens contract-summary.md at line 377', () => {
  const i = SORTED.findIndex((x) => x.stage === 'contract-design');
  assert.ok(/contract-summary\.md$/.test(SORTED[i].file));
  assert.strictEqual(rows(REV)[i].line, 377);
  assert.match(sections(REV).reviews, /data-open="[^"]*contract-summary\.md" data-line="377" aria-label="Open review: contract-design, 2026-10-02 10:49"/);
  // line 1 or missing: no data-line.
  const h = renderReviews({ reviews: [{ stage: 's', date: '2026-01-01T00:00:00Z', verdict: 'READY', file: 'a.md', line: 1 }, { stage: 't', date: '2026-01-02T00:00:00Z', verdict: 'READY', file: 'b.md', line: 'x' }] }, null, STATE);
  assert.ok(!h.includes('data-line'));
});

test('reviews: stage opens the review markdown, iteration shown only after the first', () => {
  const r = rows(REV);
  r.forEach((row, i) => {
    const rv = SORTED[i];
    assert.strictEqual(row.file, rv.file);
    assert.strictEqual(row.line, rv.line > 1 ? rv.line : null, `${rv.stage} data-line`);
    assert.strictEqual(/\(iter \d+\)$/.test(row.stage), rv.iteration > 1);
    assert.strictEqual(row.aria, `Open review: ${rv.stage}${rv.iteration > 1 ? ` (iteration ${rv.iteration})` : ''}, ${row.shown}`);
  });
});

// ---------------------------------------------------------------- jump

test('jump: card with changed, invalidated and invalidated-review files', () => {
  const j = sections(REV).jump;
  const J = DATA.jump;
  assert.strictEqual((j.match(/<div class="jump">/g) || []).length, 1);
  assert.match(j, /2026-11-09 15:18 UTC<\/b>: functional-design back to contract-design/);
  assert.ok(j.includes(G.esc(J.reason)), 'reason shown');
  const lists = [...j.matchAll(/<ul class="flist src">([\s\S]*?)<\/ul>/g)].map((m) => [...m[1].matchAll(/data-open="([^"]*)"/g)].map((x) => unesc(x[1])));
  assert.strictEqual(lists.length, 3);
  assert.deepStrictEqual(lists[0], J.changed);
  assert.deepStrictEqual(lists[1], J.invalidated);
  assert.deepStrictEqual(lists[2], J.invalidated_reviews.map((p) => p.replace(/#.*$/, '')));
  assert.strictEqual(lists[0].length, 1);
  assert.strictEqual(lists[1].length, 9);
  assert.ok(j.includes(`Changed upstream (${J.changed.length} file)`));
  assert.ok(j.includes(`Invalidated downstream (${J.invalidated.length} artifacts, ${J.invalidated_reviews.length} review)`));
  // Labels drop the intent folder; the data-open path keeps the full project-relative path.
  assert.ok(j.includes('>inception/contract-design/contract-summary.md</button>'));
  const reworked = DATA.nodes.filter((n) => n.rework).length;
  assert.strictEqual(reworked, 16);
  assert.ok(j.includes(`(${reworked} business rules)`));
  assert.ok(j.includes(`data-open="${G.esc(J.origin)}"`), 'audit shard is linked');
});

// ---------------------------------------------------------------- drift

test('drift: titled honestly, never as documentation drift', () => {
  assert.ok(REV.includes('<h3>Open findings at approval</h3>'));
  assert.ok(!/documentation drift found/i.test(REV));
});

test('drift: grouped by stage and unit, sorted by severity, every finding shown once', () => {
  const d = sections(REV).drift;
  const groups = driftGroups(d);
  const keyOf = (x) => x.stage + (x.unit ? ' · ' + x.unit : '');
  const want = new Map();
  for (const x of DATA.drift) want.set(keyOf(x), (want.get(keyOf(x)) || 0) + 1);
  assert.strictEqual(groups.length, want.size);
  assert.strictEqual(groups.length, 6);
  for (const g of groups) {
    const m = /^(.*) \((\d+)\)$/.exec(g.head);
    assert.ok(m, g.head);
    assert.strictEqual(Number(m[2]), want.get(m[1]), g.head);
    assert.strictEqual(g.items.length, want.get(m[1]), g.head);
    for (let i = 1; i < g.items.length; i++) {
      assert.ok(rank(g.items[i - 1].severity) <= rank(g.items[i].severity), `${g.head} severity order at ${i}`);
    }
    const ids = DATA.drift.filter((x) => keyOf(x) === m[1]).map((x) => x.findingId).sort();
    assert.deepStrictEqual(g.items.map((x) => x.findingId).sort(), ids, g.head);
  }
  assert.strictEqual(groups.reduce((n, g) => n + g.items.length, 0), DATA.drift.length);
  // Groups follow the AI-DLC stage order (the fixture's runtime-graph.json `stages`), not review dates:
  // nfr-design was reviewed last but comes before infrastructure-design and code-generation.
  const rg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'aidlc/spaces/default/intents/260825-inventory-api/runtime-graph.json'), 'utf8'));
  const stageOrder = rg.stages.map((x) => x.stage_slug);
  const heads = groups.map((g) => g.head.split(' ')[0]);
  assert.deepStrictEqual(heads, heads.slice().sort((a, b) => stageOrder.indexOf(a) - stageOrder.indexOf(b)));
  assert.deepStrictEqual(heads,
    ['contract-design', 'functional-design', 'nfr-requirements', 'nfr-design', 'infrastructure-design', 'code-generation']);
  // The view's fixed list agrees with the fixture's runtime order for every stage the fixture ran.
  const fixed = reviewsViewInternals.STAGE_ORDER.filter((x) => stageOrder.includes(x));
  assert.deepStrictEqual(fixed, stageOrder);
  assert.ok(d.includes('<div class="grp" role="heading" aria-level="4">'));
  // nfr-requirements: the two Major findings come first.
  const nfr = groups.find((g) => g.head.startsWith('nfr-requirements'));
  assert.deepStrictEqual(nfr.items.slice(0, 2).map((x) => x.severity), ['Major', 'Major']);
  const sevSummary = `${DATA.drift.length} findings (${DATA.drift.filter((x) => x.severity === 'Major').length} major, ${DATA.drift.filter((x) => x.severity === 'Minor').length} minor) in 6 stage reviews.`;
  assert.ok(d.includes(sevSummary), sevSummary);
});

test('drift: graph IDs are data-go buttons, only for nodes that exist', () => {
  const groups = driftGroups(sections(REV).drift);
  const all = groups.flatMap((g) => g.items);
  const goes = all.flatMap((x) => x.goes);
  for (const id of goes) assert.ok(IDX.byId[id], `${id} is a node`);
  const withKnown = DATA.drift.filter((x) => x.ids.some((id) => IDX.byId[id])).length;
  assert.strictEqual(all.filter((x) => x.goes.length).length, withKnown);
  assert.ok(withKnown > 0);
  assert.ok(goes.includes('NFR2.3'));
  // Every finding links somewhere: its file, else the review that raised it.
  const byKey = new Map(DATA.drift.map((x) => [x.stage + '|' + x.findingId, x]));
  for (const g of groups) {
    const stage = g.head.split(' ')[0];
    for (const it of g.items) {
      const d = byKey.get(stage + '|' + it.findingId);
      const want = d.file || DATA.reviews.find((r) => r.id === d.review).file;
      assert.strictEqual(it.open, want, `${stage} ${it.findingId}`);
      if (!d.file) assert.ok(it.openLabel.startsWith('review: '));
    }
  }
  const r06 = groups.find((g) => g.head.startsWith('code-generation')).items.find((x) => x.findingId === 'R-06');
  assert.strictEqual(r06.goes.length, 0);
  assert.match(r06.open, /code-generation\/reviews\/review-0\d\.md$/);
});

test('drift: rows show the first sentence; the rest, location and action sit in <details>', () => {
  const d = sections(REV).drift;
  const rowsHtml = d.split('<div class="lk">').slice(1);
  assert.strictEqual(rowsHtml.length, DATA.drift.length);
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const byNote = new Map(DATA.drift.map((x) => [norm(x.note), x]));
  let withDetails = 0;
  const seen = new Set();
  for (const row of rowsHtml) {
    const summary = unesc(/<span class="sev">([^<]*)<\/span>/.exec(row)[1]);
    assert.ok(summary.length <= 240, `summary is ${summary.length} chars`);
    const det = /<details class="sev"><summary>More detail<\/summary>([\s\S]*?)<\/details>/.exec(row);
    const restM = det && /^<p class="mt4">([^<]*)<\/p>/.exec(det[1]);
    const rest = restM ? unesc(restM[1]) : '';
    // The opened details continue the note; they never repeat the sentence shown on the row.
    if (rest) assert.ok(!rest.startsWith(summary.replace(/…$/, '')), 'rest does not repeat the first sentence');
    const full = summary.endsWith('…') ? summary.slice(0, -1) + ' ' + rest.replace(/^…/, '') : summary + (rest ? ' ' + rest : '');
    const x = byNote.get(norm(full));
    assert.ok(x, `row reassembles to a finding note: ${summary.slice(0, 60)}`);
    seen.add(x);
    if (det) {
      withDetails++;
      if (x.location) assert.ok(det[1].includes(`<b>Location:</b> ${G.esc(x.location)}`), `${x.findingId} location`);
      if (x.requiredAction) assert.ok(det[1].includes(`<b>Required action:</b> ${G.esc(x.requiredAction)}`), `${x.findingId} action`);
    } else {
      assert.ok(!x.location && !x.requiredAction && !rest);
    }
  }
  assert.strictEqual(seen.size, DATA.drift.length);
  assert.ok(withDetails > 0);
  assert.ok(!d.includes('Full finding'));
});

test('firstSentence: abbreviations do not end a sentence; long sentences are cut and continued', () => {
  const { firstSentence, splitNote } = reviewsViewInternals;
  assert.strictEqual(firstSentence('Use e.g. Foo here. Then bar.'), 'Use e.g. Foo here.');
  assert.strictEqual(firstSentence('Pick one, i.e. The first. Next.'), 'Pick one, i.e. The first.');
  assert.strictEqual(firstSentence('Logs, metrics, etc. Are kept. Done.'), 'Logs, metrics, etc. Are kept.');
  assert.strictEqual(firstSentence('REST vs. HTTP API. Second.'), 'REST vs. HTTP API.');
  assert.strictEqual(firstSentence('One e.g. two. Three. Four'), 'One e.g. two.');
  assert.strictEqual(firstSentence('No terminal punctuation'), 'No terminal punctuation');
  assert.deepStrictEqual(splitNote('A. B c.'), { first: 'A.', rest: 'B c.' });
  assert.deepStrictEqual(splitNote('Only one.'), { first: 'Only one.', rest: '' });
  const long = 'word '.repeat(80).trim() + '. Next sentence.';
  const sp = splitNote(long);
  assert.ok(sp.first.length <= 240 && sp.first.endsWith('…'));
  assert.ok(sp.rest.startsWith('…') && sp.rest.endsWith('. Next sentence.'));
  assert.strictEqual(sp.first.slice(0, -1) + ' ' + sp.rest.slice(1), long);
});

// ---------------------------------------------------------------- about

test('about: sections built from meta', () => {
  for (const id of ['about-what', 'about-read', 'about-sources', 'about-derived', 'about-omitted', 'about-warnings', 'about-gaps', 'about-limits', 'about-guardrails']) {
    assert.ok(ABOUT.includes(`id="${id}"`), id);
  }
  assert.ok(ABOUT.startsWith('<div class="panel about">'));
  const srcButtons = [...ABOUT.matchAll(/<li><button type="button" class="open" data-open="([^"]*)"/g)].map((m) => unesc(m[1]));
  assert.deepStrictEqual(srcButtons, DATA.meta.sources);
  assert.ok(ABOUT.includes(`<summary>Project records read (${DATA.meta.sources.length})</summary>`));
  assert.ok(ABOUT.includes('directory listing'));
  assert.ok(ABOUT.includes('either the file that states it or the naming rule that derived it'));
  const stamp = DATA.meta.generated.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  assert.strictEqual(ABOUT.split(stamp).length - 1, 1, 'read time shown once, header format');
  assert.ok(!ABOUT.includes(DATA.meta.generated), 'raw ISO time not shown');
  for (const r of DATA.meta.derived_edge_rules) assert.ok(ABOUT.includes(G.esc(r)), r);
  assert.strictEqual(DATA.meta.omitted.length, 6);
  for (const o of DATA.meta.omitted) assert.ok(ABOUT.includes(`<b>${G.esc(o.field)}</b>: ${G.esc(o.reason)}`), o.field);
  assert.strictEqual(DATA.meta.warnings.length, 0);
  assert.match(ABOUT, /id="about-warnings">[^<]*<\/h3><p class="sev">None\./);
  assert.match(ABOUT, /id="about-gaps">[^<]*<\/h3><p class="sev">None\./);
  const derived = DATA.edges.filter((e) => e.derived || /^derived:/.test(e.origin)).length;
  assert.ok(ABOUT.includes(`${DATA.nodes.length} items, ${DATA.edges.length} links (${derived} derived), ${DATA.reviews.length} reviews, ${DATA.drift.length} findings`));
  // The spec's AI-generated wording is gone; the agent warning stays, reworded.
  assert.ok(!/AI-generated|generated with AI assistance/i.test(ABOUT));
  assert.ok(ABOUT.includes('<div class="warn">FOR AI AGENTS:'));
  assert.ok(ABOUT.includes('deterministic'));
});

test('about: warnings and gaps are listed when present', () => {
  const meta = Object.assign({}, DATA.meta, {
    warnings: ['requirements.md not found', 'bad JSON in x/traceability.json'],
    gaps: [{ id: 'FR9.9', stage: 'user-stories', origin: 'a/traceability.json', reason: 'coverage row is GAP' }]
  });
  const h = renderAbout(Object.assign({}, DATA, { meta }), IDX, STATE);
  assert.match(h, /id="about-warnings">[^<]*<\/h3><div class="warn"><p class="mt0">The reader reported the following/);
  assert.ok(!/missing/i.test(h.slice(h.indexOf('id="about-warnings"'), h.indexOf('id="about-gaps"')).replace('requirements.md not found', '')));
  assert.ok(h.includes('<li>requirements.md not found</li>'));
  assert.ok(h.includes('<li>bad JSON in x/traceability.json</li>'));
  assert.ok(h.includes('<b>FR9.9</b> (user-stories): coverage row is GAP'));
});

// ---------------------------------------------------------------- empty and malformed data

test('empty data: no reviews, no jump, no drift', () => {
  const empty = { meta: { intent: 'x', sources: [], derived_edge_rules: [], omitted: [], warnings: [], gaps: [] }, nodes: [], edges: [], reviews: [], jump: null, drift: [] };
  const idx = G.buildIndexes(empty);
  const h = renderReviews(empty, idx, STATE);
  assert.ok(h.includes('No reviews found for this intent.'));
  assert.ok(!h.includes('class="jump"'), 'no jump card without data.jump');
  assert.ok(h.includes('No backward jump is recorded'));
  assert.ok(h.includes('<h3>Open findings at approval</h3><div class="empty">'));
  assert.ok(!h.includes('data-go'));
  assert.strictEqual(rows(h).length, 0);
  const a = renderAbout(empty, idx, STATE);
  assert.ok(a.includes('No project record was read.'));
  assert.ok(a.includes('Nothing was omitted.'));
  for (const bad of [undefined, null, {}, { reviews: 'x', drift: 5, jump: 'y', meta: 3 }, { reviews: [null, 1], drift: [null], jump: {} }]) {
    assert.strictEqual(typeof renderReviews(bad, null, STATE), 'string');
    assert.strictEqual(typeof renderAbout(bad, null, STATE), 'string');
  }
});

test('views do not mutate data or state', () => {
  const copy = JSON.parse(JSON.stringify(DATA));
  const st = { tab: 'rev', selected: 'FR1.1', covMode: 'fr', query: 'x' };
  renderReviews(copy, G.buildIndexes(copy), st);
  renderAbout(copy, null, st);
  assert.deepStrictEqual(copy.reviews, JSON.parse(JSON.stringify(DATA.reviews)));
  assert.deepStrictEqual(copy.drift, JSON.parse(JSON.stringify(DATA.drift)));
  assert.deepStrictEqual(st, { tab: 'rev', selected: 'FR1.1', covMode: 'fr', query: 'x' });
});

// ---------------------------------------------------------------- CSP and escaping

test('no style= attributes in any output', () => {
  for (const h of [REV, ABOUT, renderReviews({}, null, STATE), renderAbout({}, null, STATE)]) {
    assert.ok(!/\sstyle\s*=/i.test(h));
    assert.ok(!/<style/i.test(h));
  }
});

test('hostile strings are escaped', () => {
  const X = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
  const hostile = {
    meta: { intent: X, space: X, generated: X, generator: X, intentPath: X, sources: [X], derived_edge_rules: [X], omitted: [{ field: X, reason: X }], warnings: [X], gaps: [{ id: X, stage: X, unit: X, origin: X, reason: X }] },
    nodes: [{ id: X, type: 'business_rule', label: X, rework: true }],
    edges: [],
    reviews: [{ stage: X, unit: X, verdict: X, date: X, iteration: X, reviewer: X, file: X, critical: 1, major: 0, minor: 0, open: 1, findings: [] }],
    jump: { ts: X, source: X, target: X, reason: X, impact: X, origin: X, changed: [X], invalidated: [X], invalidated_reviews: [X] },
    drift: [{ id: X, ids: [X], file: X, note: X, stage: X, unit: X, severity: X, findingId: X, status: X }]
  };
  const idx = G.buildIndexes(hostile);
  for (const h of [renderReviews(hostile, idx, STATE), renderAbout(hostile, idx, STATE)]) {
    assert.ok(!h.includes('<img'), 'no raw img');
    assert.ok(!h.includes('<script'), 'no raw script');
    assert.ok(!/"\s*onerror=/.test(h), 'no attribute break-out');
    assert.ok(h.includes('&lt;script&gt;'));
  }
  const h = renderReviews(hostile, idx, STATE);
  assert.ok(h.includes('data-go="&quot;&gt;&lt;img'), 'hostile node id is escaped inside data-go');
  assert.ok(h.includes('<span class="v">&quot;'), 'an unknown verdict gets the neutral pill');
});

// ---------------------------------------------------------------- browser wrapper

test('views load in a browser-like context and attach to AidlcTrace', () => {
  const ctx = { self: {} };
  vm.createContext(ctx);
  for (const f of ['reviews-view.js', 'about-view.js']) {
    const src = fs.readFileSync(path.join(VIEWS, f), 'utf8');
    assert.ok(!/\brequire\s*\(/.test(src), `${f} has no require`);
    vm.runInContext(src, ctx, { filename: f });
  }
  assert.strictEqual(typeof ctx.self.AidlcTrace.renderReviews, 'function');
  assert.strictEqual(typeof ctx.self.AidlcTrace.renderAbout, 'function');
  const h = ctx.self.AidlcTrace.renderReviews(JSON.parse(JSON.stringify(DATA)), null, STATE);
  assert.strictEqual(rows(h).length, DATA.reviews.length);
});

test('drift: meta.stageOrder from the reader wins over the built-in list', () => {
  const mk = (stage, findingId) => ({ stage, findingId, severity: 'Minor', note: 'n.', ids: [] });
  const data = { reviews: [], drift: [mk('code-generation', 'R-1'), mk('intent-capture', 'R-2'), mk('custom', 'R-3')] };
  const heads = (d) => reviewsViewInternals.groupDrift(d).map((g) => g.stage);
  assert.deepStrictEqual(heads(data), ['intent-capture', 'code-generation', 'custom']);
  assert.deepStrictEqual(heads(Object.assign({ meta: { stageOrder: ['custom', 'code-generation', 'intent-capture'] } }, data)), ['custom', 'code-generation', 'intent-capture']);
  assert.deepStrictEqual(heads(Object.assign({ meta: { stageOrder: [] } }, data)), ['intent-capture', 'code-generation', 'custom']);
});
