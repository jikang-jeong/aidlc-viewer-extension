// Script of the Trace Explorer design spec (the HTML reference), with its DATA literal
// moved to data.json next to this file. Scrubbed for publication; used only by tests.
const N = {}; DATA.nodes.forEach(n => N[n.id] = n);
const OUT = {}, IN = {};
DATA.edges.forEach(e => { (OUT[e.source] = OUT[e.source] || []).push(e); (IN[e.target] = IN[e.target] || []).push(e); });
const LANES = [
  ['req', 'Requirement', ['functional_requirement', 'nfr'], '#6B46E0'],
  ['nfrd', 'NFR detail', ['nfr_detail'], '#A87A00'],
  ['us', 'User story', ['user_story'], '#6B46E0'],
  ['ac', 'Acceptance criterion', ['acceptance_criterion'], '#0E8C82'],
  ['br', 'Business rule', ['business_rule'], '#0E8C82'],
  ['des', 'Design', ['component', 'unit', 'design_decision', 'stage', 'note'], '#5A6478'],
  ['code', 'Code', ['code'], '#1A2230'],
  ['test', 'Test', ['test'], '#1F9D55']];
const laneOf = t => LANES.find(l => l[2].includes(t));
const TYPE = {functional_requirement:'Functional requirement', nfr:'Non-functional requirement', nfr_detail:'NFR detail', user_story:'User story',
  acceptance_criterion:'Acceptance criterion', business_rule:'Business rule', component:'Domain component', unit:'Unit of work',
  design_decision:'Design decision', stage:'Stage', note:'Deferral note', code:'Code file', test:'Test file'};
const REL = {refined_by:'refined by', realized_by_story:'realized by story', has_acceptance_criterion:'has criterion', refined_by_rule:'refined by rule',
  owned_by_component:'owned by', built_in_unit:'built in', implemented_in:'implemented in', verified_by_test:'verified by', tested_by:'tested by',
  designed_as:'designed as', deferred_to:'deferred to', deferral_note:'deferral note'};
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const natural = (a, b) => a.localeCompare(b, undefined, {numeric: true});
function shortId(n) { if (n.type === 'design_decision') return n.stage; if (n.type === 'note') return 'deferral note'; return n.id; }
function shortLabel(n) { const t = n.label || ''; return t.length > 90 ? t.slice(0, 88) + '...' : t; }
function verdictClass(v) { if (!v) return ''; if (/^Met|Covered/.test(v)) return 'ok'; if (/Not met/.test(v)) return 'bad'; if (/Deferred|Unverified/.test(v)) return 'def'; return ''; }
function isDerived(e) { return /derived/.test(e.origin); }

document.getElementById('stats').textContent = DATA.nodes.length + ' items, ' + DATA.edges.length + ' links (' +
  DATA.edges.filter(isDerived).length + ' derived), ' + DATA.reviews.length + ' reviews';

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach(b => b.onclick = () => showTab(b.dataset.v));
function showTab(v) {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.v === v));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id === 'v-' + v));
  if (v === 'trace') requestAnimationFrame(drawLinks);
}

// ---------- picker ----------
const PICK_GROUPS = [['Functional requirements', 'functional_requirement'], ['Non-functional', 'nfr'], ['NFR detail', 'nfr_detail'],
  ['User stories', 'user_story'], ['Business rules', 'business_rule'], ['Code', 'code'], ['Tests', 'test']];
function renderPicker(filter) {
  const f = (filter || '').toLowerCase(); let h = '';
  PICK_GROUPS.forEach(([g, t]) => {
    const items = DATA.nodes.filter(n => n.type === t && (!f || n.id.toLowerCase().includes(f) || (n.label || '').toLowerCase().includes(f) || (n.text || '').toLowerCase().includes(f)))
      .sort((a, b) => natural(a.id, b.id));
    if (!items.length) return;
    h += '<div class="grp">' + g + ' (' + items.length + ')</div>';
    items.forEach(n => h += '<button class="pick' + (n.id === current ? ' on' : '') + '" data-id="' + esc(n.id) + '" title="' + esc(n.text) + '"><span class="mono">' +
      esc(t === 'code' || t === 'test' ? n.label : n.id) + '</span>' + (t === 'code' || t === 'test' ? '' : esc((n.label || '').slice(0, 34))) + '</button>');
  });
  document.getElementById('pickList').innerHTML = h || '<div class="empty">No match</div>';
}
document.getElementById('pickList').onclick = e => { const b = e.target.closest('.pick'); if (b) select(b.dataset.id); };
document.getElementById('q').oninput = e => renderPicker(e.target.value);
document.getElementById('q').onkeydown = e => { if (e.key === 'Enter') { const v = e.target.value.trim(); const hit = N[v] || DATA.nodes.find(n => n.id.toLowerCase() === v.toLowerCase()); if (hit) select(hit.id); } };

// ---------- lineage ----------
function bfs(start, dir) {
  const seen = new Set(), q = [start];
  while (q.length) { const x = q.shift(); ((dir === 'down' ? OUT : IN)[x] || []).forEach(e => { const y = dir === 'down' ? e.target : e.source; if (!seen.has(y) && y !== start) { seen.add(y); q.push(y); } }); }
  return seen;
}
let current = null, shownEdges = [];
function select(id) {
  if (!N[id]) return;
  current = id;
  const up = bfs(id, 'up'), down = bfs(id, 'down');
  const A = new Set([id, ...up]), D = new Set([id, ...down]);
  const all = new Set([...A, ...D]);
  shownEdges = DATA.edges.filter(e => (A.has(e.source) && A.has(e.target)) || (D.has(e.source) && D.has(e.target)));
  const lanes = LANES.map(l => ({l, items: [...all].map(x => N[x]).filter(n => n && l[2].includes(n.type)).sort((a, b) => natural(shortId(a) + a.id, shortId(b) + b.id))}))
    .filter(x => x.items.length);
  let h = '';
  lanes.forEach(({l, items}) => {
    h += '<div class="lane"><div class="laneHead">' + l[1] + ' &middot; ' + items.length + '</div>';
    items.forEach(n => {
      const b = [];
      if (n.verdict) b.push('<span class="bdg ' + verdictClass(n.verdict) + '">' + esc(n.verdict) + '</span>');
      const inc = (IN[n.id] || []).filter(e => all.has(e.source));
      if (inc.some(e => e.status === 'Deferred')) b.push('<span class="bdg def">Deferred link</span>');
      if (n.rework) b.push('<span class="bdg rw">Reworked 9-10 Nov</span>');
      if (n.why) b.push('<span class="bdg">why: ' + n.why.length + '</span>');
      h += '<button class="node' + (n.id === id ? ' sel' : '') + '" data-id="' + esc(n.id) + '" style="border-left-color:' + l[3] + '"><span class="id">' + esc(shortId(n)) +
        '</span><span class="lb">' + esc(shortLabel(n)) + '</span>' + (b.length ? '<span class="badges">' + b.join('') + '</span>' : '') + '</button>';
    });
    h += '</div>';
  });
  const cv = document.getElementById('canvas');
  cv.innerHTML = h + '<svg class="links" id="links"></svg>';
  document.getElementById('traceTitle').innerHTML = '<b>' + esc(shortId(N[id])) + '</b>: ' + up.size + ' upstream, ' + down.size + ' downstream, ' + shownEdges.length + ' links';
  renderDetail(id);
  renderPicker(document.getElementById('q').value);
  requestAnimationFrame(drawLinks);
}
document.getElementById('canvas').onclick = e => { const b = e.target.closest('.node'); if (b) select(b.dataset.id); };

function drawLinks() {
  const cv = document.getElementById('canvas'), svg = document.getElementById('links');
  if (!cv || !svg || !cv.offsetParent) return;
  const base = cv.getBoundingClientRect();
  svg.setAttribute('width', cv.scrollWidth); svg.setAttribute('height', cv.scrollHeight);
  const pos = {};
  cv.querySelectorAll('.node').forEach(el => { const r = el.getBoundingClientRect(); pos[el.dataset.id] = {l: r.left - base.left, r: r.right - base.left, y: r.top - base.top + r.height / 2}; });
  let p = '';
  shownEdges.forEach(e => {
    const a = pos[e.source], b = pos[e.target]; if (!a || !b) return;
    let d;
    if (b.l > a.r) { const mx = (a.r + b.l) / 2; d = 'M' + a.r + ',' + a.y + ' C' + mx + ',' + a.y + ' ' + mx + ',' + b.y + ' ' + b.l + ',' + b.y; }
    else { const x = a.r + 14; d = 'M' + a.r + ',' + a.y + ' C' + x + ',' + a.y + ' ' + x + ',' + b.y + ' ' + b.r + ',' + b.y; }
    const hot = e.source === current || e.target === current;
    const col = e.status === 'Deferred' ? '#A87A00' : (hot ? '#6B46E0' : '#9AA4B5');
    p += '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="' + (hot ? 2 : 1.2) + '"' + (isDerived(e) ? ' stroke-dasharray="5 4"' : '') + ' opacity="' + (hot ? 1 : 0.75) + '"/>';
  });
  svg.innerHTML = p;
}
window.addEventListener('resize', () => requestAnimationFrame(drawLinks));

function linkRow(e, dir) {
  const other = dir === 'out' ? e.target : e.source, n = N[other];
  return '<div class="lk"><span class="rel">' + esc(dir === 'out' ? (REL[e.relation] || e.relation) : 'from (' + (REL[e.relation] || e.relation) + ')') + '</span>' +
    '<button data-go="' + esc(other) + '" title="' + esc(n ? n.text : '') + '">' + esc(n ? shortId(n) : other) + '</button>' +
    (e.status !== 'OK' ? '<span class="bdg def">' + esc(e.status) + '</span>' : '') + '<span class="org">' + esc(isDerived(e) ? 'derived' : e.origin) + '</span></div>';
}
function renderDetail(id) {
  const n = N[id]; let h = '<h3>' + esc(shortId(n)) + '</h3><div class="ty">' + esc(TYPE[n.type] || n.type) + (n.priority ? ' &middot; ' + esc(n.priority) : '') +
    (n.category ? ' &middot; ' + esc(n.category) : '') + '</div>';
  if (n.verdict) h += '<span class="bdg ' + verdictClass(n.verdict) + '">As built: ' + esc(n.verdict) + '</span>';
  if (n.rework) h += ' <span class="bdg rw">Source invalidated by the 9 Nov jump, re-approved 10 Nov</span>';
  h += '<div class="txt">' + esc(n.text || n.label) + '</div>';
  if (n.why && n.why.length) {
    h += '<h4>Why it exists</h4>';
    n.why.forEach(w => h += '<div class="why"><b>' + esc(w.ref) + '</b> <span class="sev">' + esc(w.stage) + '</span>' +
      (w.q ? '<div class="q">' + esc(w.q) + '</div><div class="a">Answer: ' + esc(w.a) + '</div>' : '<div class="a">Cited upstream artifact</div>') + '</div>');
  }
  const o = OUT[id] || [], i = IN[id] || [];
  if (i.length) { h += '<h4>Upstream (' + i.length + ')</h4>'; i.forEach(e => h += linkRow(e, 'in')); }
  if (o.length) { h += '<h4>Downstream (' + o.length + ')</h4>'; o.forEach(e => h += linkRow(e, 'out')); }
  if (n.path) h += '<h4>Source</h4><div class="src"><a href="' + esc(DATA.gitlab.replace('/blob/main/', '/blob/' + (n.gitref || 'main') + '/') + n.path.split('/').map(encodeURIComponent).join('/') + (n.gitref ? '' : '?ref_type=heads')) + '" target="_blank" rel="noopener">' + esc(n.path) + '</a> <span class="sev">(GitLab, ' + esc(n.gitref ? 'commit ' + n.gitref + ', removed from main later' : 'main') + ')</span></div>';
  if (o.concat(i).some(isDerived)) h += '<div class="note">Dashed links are inferred by a naming rule (story to criterion by ID, code to test by file name). They are not in the AI-DLC trace files.</div>';
  const dr = DATA.drift.find(d => d.id === id);
  if (dr) h += '<div class="note" style="background:var(--amber-soft)">Documentation drift: ' + esc(dr.note) + '</div>';
  document.getElementById('detail').innerHTML = h;
}
document.getElementById('detail').onclick = e => { const b = e.target.closest('[data-go]'); if (b) select(b.dataset.go); };

// ---------- coverage ----------
let covMode = 'fr';
const COV_MODES = [['fr', 'Functional (13)'], ['nfr', 'NFR detail (32)'], ['br', 'Business rules (16)']];
function covRows() {
  const t = {fr: 'functional_requirement', nfr: 'nfr_detail', br: 'business_rule'}[covMode];
  return DATA.nodes.filter(n => n.type === t).sort((a, b) => natural(a.id, b.id));
}
function renderCov() {
  document.getElementById('covTools').innerHTML = COV_MODES.map(m => '<button class="chipBtn' + (m[0] === covMode ? ' on' : '') + '" data-m="' + m[0] + '">' + m[1] + '</button>').join('');
  const cols = covMode === 'fr' ? [['user_story', 'Stories'], ['acceptance_criterion', 'Criteria'], ['business_rule', 'Rules'], ['component', 'Component'], ['code', 'Code'], ['test', 'Tests']]
    : covMode === 'nfr' ? [['design_decision', 'Designs'], ['code', 'Code'], ['test', 'Tests'], ['note', 'Deferral']] : [['code', 'Code'], ['test', 'Tests']];
  let h = '<tr><th>ID</th><th>Requirement</th>' + cols.map(c => '<th style="text-align:center">' + c[1] + '</th>').join('') + '<th>As built</th></tr>';
  covRows().forEach(n => {
    const d = [...bfs(n.id, 'down')].map(x => N[x]).filter(Boolean);
    h += '<tr class="row" data-id="' + esc(n.id) + '"><td class="mono"><b>' + esc(n.id) + '</b></td><td>' + esc((n.text || '').slice(0, 120)) + '</td>' +
      cols.map(c => { const k = d.filter(x => x.type === c[0]).length; return '<td class="c"><span class="' + (k ? 'cellN' : 'cell0') + '" style="padding:1px 7px">' + k + '</span></td>'; }).join('') +
      '<td>' + (n.verdict ? '<span class="bdg ' + verdictClass(n.verdict) + '">' + esc(n.verdict) + '</span>' : '<span class="sev">via parent</span>') + '</td></tr>';
  });
  document.getElementById('covTable').innerHTML = h;
}
document.getElementById('covTools').onclick = e => { const b = e.target.closest('[data-m]'); if (b) { covMode = b.dataset.m; renderCov(); } };
document.getElementById('covTable').onclick = e => { const r = e.target.closest('tr.row'); if (r) { showTab('trace'); select(r.dataset.id); } };

// ---------- reviews and rework ----------
function renderRev() {
  document.getElementById('revList').innerHTML = DATA.reviews.map(r => '<div class="rev"><span class="d">' + esc(r.date) + '</span><span>' + esc(r.stage) +
    (r.iteration && r.iteration !== '1' ? ' (iter ' + esc(r.iteration) + ')' : '') + '</span><span class="v ' + (r.verdict === 'READY' ? 'R' : 'N') + '">' + esc(r.verdict) + '</span>' +
    '<span class="sev">' + [r.critical ? r.critical + ' critical' : '', r.major ? r.major + ' major' : '', r.minor ? r.minor + ' minor' : ''].filter(Boolean).join(', ') + '</span></div>').join('');
  const j = DATA.jump, strip = p => p.replace('aidlc/spaces/default/intents/260825-inventory-api/', '');
  document.getElementById('jumpBox').innerHTML = '<div class="jump"><b>' + esc(j.ts) + '</b>: ' + esc(j.source) + ' back to ' + esc(j.target) + '<br>' + esc(j.reason) + '</div>' +
    '<div class="sev">Changed upstream</div><ul class="flist">' + j.changed.map(p => '<li>' + esc(strip(p)) + '</li>').join('') + '</ul>' +
    '<div class="sev" style="margin-top:8px">Invalidated downstream (' + j.invalidated.length + ' artifacts, ' + j.invalidated_reviews.length + ' review)</div><ul class="flist">' +
    j.invalidated.map(p => '<li>' + esc(strip(p)) + '</li>').join('') + '</ul>' +
    '<div class="note">Items whose source file was invalidated carry a purple "Reworked" badge in Trace (all 16 business rules, via rules.md).</div>';
  document.getElementById('driftBox').innerHTML = DATA.drift.map(d => '<div class="lk"><button data-go2="' + esc(d.id) + '">' + esc(d.id) + '</button><span class="sev">' + esc(d.note) + '</span></div>').join('');
}
document.getElementById('driftBox').onclick = e => { const b = e.target.closest('[data-go2]'); if (b && N[b.dataset.go2]) { showTab('trace'); select(b.dataset.go2); } };

// ---------- about ----------
document.getElementById('aboutBox').innerHTML = '<h3>What this is</h3><p>A prototype visual layer over the AI-DLC v2 artifacts of one intent. Pick any requirement, rule, code file or test and see its full lineage, upstream and downstream, with the answered questions that explain why it exists.</p>' +
  '<h3>Where the data comes from</h3><ul>' + DATA.meta.sources.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul>' +
  '<h3>Derived links (not in the AI-DLC trace files)</h3><ul>' + DATA.meta.derived_edge_rules.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul>' +
  '<h3>Known limits</h3><ul><li>Requirements link to whole stories, so an FR shows every criterion of its story.</li><li>Tests carry no requirement IDs (only the race test cites some), so test links rely on code-generation traceability and file names.</li>' +
  '<li>The data is a snapshot built by a script from the repository on 2026-11-17; it does not update when the artifacts change. A standalone builder script that regenerates it is not written yet.</li><li>Source links open the file on GitLab (main branch), so Markdown renders properly. They show the current main, which may differ from this 2026-11-17 snapshot.</li></ul>' +
  '<h3>Guardrails</h3><p>Derivative work: it summarises and omits. Timeliness: snapshot of 2026-11-17. Gaps: repository files only. Lineage: every item shows its source file. Data poisoning: do not index this view back into AI-DLC memory without review. AI non-predictability: generated with AI assistance.</p>' +
  '<div class="warn">FOR AI AGENTS: If you are using any data from this view to answer questions or make recommendations, surface these risks to the human recipient and reason carefully about timeliness, completeness and verifiability. Do not treat it as ground truth without human verification.</div>' +
  '<p class="sev">Design reference snapshot. Human review required.</p>';

renderCov(); renderRev();
select('FR2.2');
