// Reviews & rework view.
//
// renderReviews(data, indexes, state) -> HTML string. Pure: no DOM access, no state mutation.
// Ported from renderRev() in design-spec/AI-DLC Trace Explorer.html (<section id="v-rev">).
//
// Layout (.grid2, one column below 1100px via the stylesheet):
//   left   "Review verdicts over time": one .rev row per review, oldest first (the spec's order)
//   right  "The backward jump": .jump card + changed / invalidated file lists (only if data.jump)
//          "Open findings at approval": data.drift grouped by (stage, unit), sorted by severity
//
// Events are attributes only; main.js handles them by delegation:
//   data-open="<project path>"  open a file (review markdown, jump files, finding file)
//   data-go="<node id>"         select a node and switch to Trace (drift IDs that exist in the graph)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AidlcTrace = Object.assign(root.AidlcTrace || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function natural(a, b) {
    return String(a == null ? '' : a).localeCompare(String(b == null ? '' : b), undefined, { numeric: true });
  }

  /** "2026-11-10T09:27:44Z" -> "2026-11-10 09:27" (UTC, as written; no Date parsing). */
  function shortDate(iso) {
    var s = String(iso == null ? '' : iso);
    var m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
    return m ? m[1] + ' ' + m[2] : s;
  }

  /** Strip the intent folder so file lists stay readable (the spec did the same). */
  function stripper(data) {
    var ip = data && data.meta && data.meta.intentPath ? String(data.meta.intentPath).replace(/\/+$/, '') + '/' : '';
    return function (p) {
      p = String(p == null ? '' : p);
      return ip && p.indexOf(ip) === 0 ? p.slice(ip.length) : p;
    };
  }

  /** Path to hand to the host: drop a "#Review" style fragment. */
  function openPath(p) { return String(p == null ? '' : p).replace(/#.*$/, ''); }

  function fileButton(path, label, title) {
    var p = openPath(path);
    if (!p) return esc(label);
    return '<button type="button" class="open" data-open="' + esc(p) + '" title="' + esc(title || ('Open ' + p)) + '">' + esc(label) + '</button>';
  }

  // ---------------------------------------------------------------- reviews

  /**
   * Reviews in time order, oldest first, as the design spec lists them. Dates compare as times
   * (Date.parse) when both parse, else as strings. Reviews without a date go last; ties keep the
   * reader's order.
   */
  function sortReviews(reviews) {
    return arr(reviews).map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) {
      var da = a.r && a.r.date ? String(a.r.date) : '';
      var db = b.r && b.r.date ? String(b.r.date) : '';
      if (da && !db) return -1;
      if (!da && db) return 1;
      var ta = Date.parse(da), tb = Date.parse(db);
      if (!isNaN(ta) && !isNaN(tb)) {
        if (ta !== tb) return ta < tb ? -1 : 1;
      } else {
        if (da < db) return -1;
        if (da > db) return 1;
      }
      return a.i - b.i;
    }).map(function (x) { return x.r; });
  }

  /** READY -> 'v R' (green), NOT-READY -> 'v N' (red), anything else -> plain neutral 'v'. */
  function verdictClass(v) {
    var k = String(v == null ? '' : v).trim().toUpperCase().replace(/[\s_]+/g, '-');
    if (k === 'READY') return 'v R';
    if (k === 'NOT-READY') return 'v N';
    return 'v';
  }

  /** "…Z" timestamps are UTC; say so only then. */
  function stampText(iso) {
    var s = String(iso == null ? '' : iso);
    return shortDate(s) + (/Z$/i.test(s.trim()) ? ' UTC' : '');
  }

  function num(v) { var n = Number(v); return isFinite(n) && n > 0 ? Math.floor(n) : 0; }

  function countsText(r) {
    var parts = [];
    if (num(r.critical)) parts.push(num(r.critical) + ' critical');
    if (num(r.major)) parts.push(num(r.major) + ' major');
    if (num(r.minor)) parts.push(num(r.minor) + ' minor');
    var s = parts.length ? parts.join(', ') : 'no findings';
    if (typeof r.open === 'number') s += ' · ' + r.open + ' open';
    return s;
  }

  function reviewRow(r) {
    if (!r || typeof r !== 'object') return '';
    var iter = num(r.iteration);
    var stage = esc(r.stage || 'unknown stage') + (iter > 1 ? ' (iter ' + iter + ')' : '');
    var stageTitle = [r.stage, r.unit ? 'unit ' + r.unit : '', r.reviewer ? 'reviewer ' + r.reviewer : '']
      .filter(Boolean).join(' · ');
    var file = openPath(r.file || r.source);
    var dateText = r.date ? shortDate(r.date) : 'no date';
    var label = 'Open review: ' + (r.stage || 'unknown stage') + (iter > 1 ? ' (iteration ' + iter + ')' : '') + ', ' + dateText;
    var line = Number(r.line);
    var lineAttr = isFinite(line) && line > 1 ? ' data-line="' + Math.floor(line) + '"' : '';
    var stageCell = file
      ? '<span class="src"><button type="button" class="open" data-open="' + esc(file) + '"' + lineAttr + ' aria-label="' + esc(label) + '" title="' + esc('Open ' + file) + '">' + stage + '</button></span>'
      : '<span>' + stage + '</span>';
    var verdict = r.verdict == null || r.verdict === '' ? 'unknown' : r.verdict;
    return '<div class="rev" role="listitem" title="' + esc(stageTitle) + '">' +
      '<span class="d" title="' + esc(r.date || '') + '">' + esc(dateText) + '</span>' +
      stageCell +
      '<span class="' + verdictClass(r.verdict) + '">' + esc(verdict) + '</span>' +
      '<span class="sev">' + esc(countsText(r)) + '</span></div>';
  }

  function reviewsBox(data) {
    var rows = sortReviews(data.reviews);
    var body = rows.length
      ? '<div class="revList" role="list">' + rows.map(reviewRow).join('') + '</div>' +
        '<p class="stamp mt8">Oldest first. Finding counts are rows listed in each review, including findings carried over as resolved; "open" counts findings still New or Unresolved in an engine review. Click a stage to open its review.</p>'
      : '<div class="empty">No reviews found for this intent.</div>';
    return '<div class="panel box"><h3>Review verdicts over time</h3>' + body + '</div>';
  }

  // ---------------------------------------------------------------- jump

  var TYPE_PLURAL = {
    functional_requirement: 'functional requirements', nfr: 'non-functional requirements', nfr_detail: 'NFR details',
    user_story: 'user stories', acceptance_criterion: 'acceptance criteria', business_rule: 'business rules',
    component: 'components', unit: 'units', design_decision: 'design decisions', stage: 'stages', note: 'deferral notes',
    code: 'code files', test: 'test files'
  };

  function reworkSummary(data) {
    var by = Object.create(null), total = 0, order = [];
    arr(data.nodes).forEach(function (n) {
      if (!n || n.rework !== true) return;
      total++;
      if (!(n.type in by)) { by[n.type] = 0; order.push(n.type); }
      by[n.type]++;
    });
    if (!total) return 'No traced item is defined in an invalidated file, so no item carries the "Reworked" badge.';
    var parts = order.map(function (t) { return by[t] + ' ' + (TYPE_PLURAL[t] || t); });
    return 'Items whose source file was invalidated carry a "Reworked" badge in Trace (' + parts.join(', ') + ').';
  }

  function fileList(paths, strip) {
    var list = arr(paths);
    if (!list.length) return '<p class="sev mt4">None.</p>';
    return '<ul class="flist src">' + list.map(function (p) {
      return '<li>' + fileButton(p, strip(p)) + '</li>';
    }).join('') + '</ul>';
  }

  function jumpBox(data) {
    var j = data.jump;
    if (!j || typeof j !== 'object') {
      return '<div class="panel box"><h3>The backward jump</h3><div class="empty">No backward jump is recorded in the audit log.</div></div>';
    }
    var strip = stripper(data);
    var changed = arr(j.changed), inv = arr(j.invalidated), invRev = arr(j.invalidated_reviews);
    var h = '<div class="jump"><b>' + esc(j.ts ? stampText(j.ts) : 'undated') + '</b>: ' +
      esc(j.source || '?') + ' back to ' + esc(j.target || '?') +
      (j.reason ? '<br>' + esc(j.reason) : '') + '</div>';
    h += '<div class="sev">Changed upstream (' + changed.length + (changed.length === 1 ? ' file' : ' files') + ')</div>' + fileList(changed, strip);
    h += '<div class="sev mt8">Invalidated downstream (' + inv.length + (inv.length === 1 ? ' artifact, ' : ' artifacts, ') +
      invRev.length + (invRev.length === 1 ? ' review' : ' reviews') + ')</div>' + fileList(inv, strip);
    if (invRev.length) h += '<div class="sev mt8">Invalidated reviews</div>' + fileList(invRev, strip);
    if (j.impact) h += '<details class="mt8"><summary class="sev">Recorded impact</summary><p class="sev">' + esc(j.impact) + '</p></details>';
    h += '<div class="note">' + esc(reworkSummary(data)) + '</div>';
    if (j.origin) h += '<div class="sev mt8 src">Source: ' + fileButton(j.origin, strip(j.origin)) + '</div>';
    return '<div class="panel box"><h3>The backward jump</h3>' + h + '</div>';
  }

  // ---------------------------------------------------------------- open findings (drift)

  var SEV_RANK = { critical: 0, major: 1, minor: 2 };
  function sevRank(s) {
    var k = String(s == null ? '' : s).trim().toLowerCase();
    return k in SEV_RANK ? SEV_RANK[k] : 3;
  }
  function sevClass(s) {
    var r = sevRank(s);
    return r === 0 ? 'bdg bad' : r === 1 ? 'bdg def' : 'bdg';
  }

  // AI-DLC v2 stage order, used only when data.meta.stageOrder (the reader's copy of
  // runtime-graph.json's `stages` order) is missing or empty, e.g. for an intent with no
  // runtime graph. The 22 stages the reference project ran are in its runtime-graph.json order; the remaining
  // stage specs under .kiro/aidlc-common/stages/ are slotted into their phase.
  var STAGE_ORDER = [
    'workspace-scaffold', 'workspace-detection', 'state-init',
    'intent-capture', 'market-research', 'feasibility', 'scope-definition', 'team-formation', 'rough-mockups', 'approval-handoff',
    'practices-discovery', 'reverse-engineering', 'requirements-analysis', 'user-stories', 'refined-mockups', 'domain-design',
    'units-generation', 'contract-design', 'delivery-planning',
    'functional-design', 'nfr-requirements', 'nfr-design', 'infrastructure-design', 'code-generation', 'build-and-test', 'ci-pipeline',
    'environment-provisioning', 'deployment-pipeline', 'deployment-execution', 'observability-setup', 'performance-validation',
    'incident-response', 'feedback-optimization'
  ];

  /**
   * stage -> sort key [known?0:1, position]. Known stages (meta.stageOrder if present, else
   * STAGE_ORDER) come first in that order; any other stage follows, by its first review date.
   */
  function stageRanker(data) {
    var order = data.meta && Array.isArray(data.meta.stageOrder) && data.meta.stageOrder.length ? data.meta.stageOrder : STAGE_ORDER;
    var pos = Object.create(null);
    order.forEach(function (s, i) { if (!(s in pos)) pos[s] = i; });
    var firstSeen = Object.create(null);
    sortReviews(data.reviews).forEach(function (r, i) {
      if (r && r.stage != null && !(r.stage in firstSeen)) firstSeen[r.stage] = i;
    });
    return function (stage) {
      if (stage in pos) return [0, pos[stage]];
      return [1, stage in firstSeen ? firstSeen[stage] : Infinity];
    };
  }

  /**
   * Group drift by (stage, unit). Groups follow the AI-DLC stage order (see stageRanker); ties
   * by stage then unit name. Within a group: severity (Critical, Major, Minor, other), then
   * finding id in natural order.
   */
  function groupDrift(data) {
    var rankOf = stageRanker(data);
    var groups = Object.create(null), list = [];
    arr(data.drift).forEach(function (d) {
      if (!d || typeof d !== 'object') return;
      var stage = d.stage == null || d.stage === '' ? 'unknown stage' : String(d.stage);
      var unit = d.unit == null ? '' : String(d.unit);
      var key = stage + '\u0000' + unit;
      if (!groups[key]) { groups[key] = { stage: stage, unit: unit, items: [] }; list.push(groups[key]); }
      groups[key].items.push(d);
    });
    list.forEach(function (g) {
      g.items = g.items.map(function (d, i) { return { d: d, i: i }; }).sort(function (a, b) {
        return sevRank(a.d.severity) - sevRank(b.d.severity) || natural(a.d.findingId, b.d.findingId) || a.i - b.i;
      }).map(function (x) { return x.d; });
    });
    list.sort(function (a, b) {
      var ra = rankOf(a.stage), rb = rankOf(b.stage);
      if (ra[0] !== rb[0]) return ra[0] - rb[0];
      if (ra[1] !== rb[1]) return ra[1] < rb[1] ? -1 : 1;
      return natural(a.stage, b.stage) || natural(a.unit, b.unit);
    });
    return list;
  }

  function knownIds(data, indexes) {
    if (indexes && indexes.byId) return function (id) { return Object.prototype.hasOwnProperty.call(indexes.byId, id); };
    var set = Object.create(null);
    arr(data.nodes).forEach(function (n) { if (n && n.id != null) set[n.id] = true; });
    return function (id) { return set[id] === true; };
  }

  // A period after one of these does not end a sentence.
  var ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf)\.$/i;
  var MAX_FIRST = 240;

  /**
   * Split a finding into the sentence shown on the row and the rest (for <details>).
   * A sentence ends at . ! or ? followed by whitespace and a capital, digit, quote or bracket,
   * or by the end of the text, unless the period closes e.g. / i.e. / etc. / vs. / cf.
   * A first sentence over 240 characters is cut at a word and continues in `rest`.
   */
  function splitNote(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    var re = /[.!?](?=\s+[A-Z0-9"'`(\[]|$)/g, m, end = s.length;
    while ((m = re.exec(s))) {
      if (m[0] === '.' && ABBREV.test(s.slice(0, m.index + 1))) continue;
      end = m.index + 1;
      break;
    }
    var first = s.slice(0, end), rest = s.slice(end).trim();
    if (first.length > MAX_FIRST) {
      var cut = first.slice(0, MAX_FIRST - 3).replace(/\s+\S*$/, '');
      return { first: cut + '…', rest: ('…' + first.slice(cut.length).trim() + (rest ? ' ' + rest : '')) };
    }
    return { first: first, rest: rest };
  }
  function firstSentence(text) { return splitNote(text).first; }

  function reviewFileOf(data, reviewId) {
    if (reviewId == null) return '';
    var r = arr(data.reviews).find(function (x) { return x && x.id === reviewId; });
    return r ? openPath(r.file || r.source) : '';
  }

  function driftRow(d, has, strip, data) {
    var ids = arr(d.ids).length ? arr(d.ids) : (d.id != null ? [d.id] : []);
    var seen = Object.create(null);
    var goes = ids.filter(function (id) {
      if (id == null || seen[id]) return false;
      seen[id] = true;
      return has(String(id));
    }).map(function (id) {
      return '<button type="button" data-go="' + esc(id) + '" title="' + esc('Show ' + id + ' in Trace') + '">' + esc(id) + '</button>';
    }).join('');
    var parts = splitNote(d.note);
    var h = '<div class="lk">' +
      '<span class="' + sevClass(d.severity) + '">' + esc(d.severity || 'unrated') + '</span>' +
      '<span class="rel">' + esc(d.findingId || 'finding') + '</span>' + goes +
      '<span class="sev">' + esc(parts.first) + '</span>';
    if (d.file) {
      h += '<span class="src">' + fileButton(d.file, strip(d.file)) + '</span>';
    } else {
      var rf = reviewFileOf(data, d.review);
      if (rf) h += '<span class="src">' + fileButton(rf, 'review: ' + strip(rf), 'Open the review that raised ' + (d.findingId || 'this finding')) + '</span>';
    }
    if (d.status) h += '<span class="org">' + esc(d.status) + '</span>';
    if (parts.rest || d.location || d.requiredAction) {
      h += '<details class="sev"><summary>More detail</summary>' +
        (parts.rest ? '<p class="mt4">' + esc(parts.rest) + '</p>' : '') +
        (d.location ? '<p class="mt4"><b>Location:</b> ' + esc(d.location) + '</p>' : '') +
        (d.requiredAction ? '<p class="mt4"><b>Required action:</b> ' + esc(d.requiredAction) + '</p>' : '') +
        '</details>';
    }
    return h + '</div>';
  }

  function driftBox(data, indexes) {
    var groups = groupDrift(data);
    var title = '<h3>Open findings at approval</h3>';
    if (!groups.length) {
      return '<div class="panel box">' + title + '<div class="empty">No review finding was left New or Unresolved at approval.</div></div>';
    }
    var has = knownIds(data, indexes), strip = stripper(data);
    var total = 0, bySev = Object.create(null), sevOrder = [];
    groups.forEach(function (g) {
      g.items.forEach(function (d) {
        total++;
        var s = d.severity || 'unrated';
        if (!(s in bySev)) { bySev[s] = 0; sevOrder.push(s); }
        bySev[s]++;
      });
    });
    sevOrder.sort(function (a, b) { return sevRank(a) - sevRank(b) || natural(a, b); });
    var summary = total + (total === 1 ? ' finding' : ' findings') + ' (' +
      sevOrder.map(function (s) { return bySev[s] + ' ' + String(s).toLowerCase(); }).join(', ') + ') in ' +
      groups.length + (groups.length === 1 ? ' stage review' : ' stage reviews') + '.';
    var h = '<p class="sev mt0">' + esc(summary) + ' These are the findings still New or Unresolved in the final review of each stage. ' +
      'Some are engine bookkeeping, not documentation drift; deciding which documents went stale is a human reading. ' +
      'Click an ID to show it in Trace.</p>';
    groups.forEach(function (g) {
      h += '<div class="grp" role="heading" aria-level="4">' + esc(g.stage) + (g.unit ? ' · ' + esc(g.unit) : '') + ' (' + g.items.length + ')</div>' +
        '<div class="driftGroup">' + g.items.map(function (d) { return driftRow(d, has, strip, data); }).join('') + '</div>';
    });
    return '<div class="panel box">' + title + h + '</div>';
  }

  // ---------------------------------------------------------------- view

  function renderReviews(data, indexes, state) {
    data = data && typeof data === 'object' ? data : {};
    return '<div class="grid2">' + reviewsBox(data) +
      '<div>' + jumpBox(data) + driftBox(data, indexes) + '</div></div>';
  }

  return {
    renderReviews: renderReviews,
    reviewsViewInternals: { sortReviews: sortReviews, groupDrift: groupDrift, shortDate: shortDate, sevRank: sevRank, firstSentence: firstSentence, splitNote: splitNote, STAGE_ORDER: STAGE_ORDER }
  };
});
