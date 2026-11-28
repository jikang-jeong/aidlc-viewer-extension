// Graph engine for the Trace Explorer.
//
// Pure functions over a TraceData object ({ nodes[], edges[], ... }, see
// docs/trace-explorer/data-model.md). Ported from the design spec's script
// (design-spec/AI-DLC Trace Explorer.html: N/OUT/IN, bfs, select(), natural,
// shortId, shortLabel, verdictClass, isDerived, esc). Runs in the webview
// (exposes self.AidlcTrace) and under node --test (module.exports).
// No DOM, no require, no globals beyond the wrapper.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AidlcTrace = Object.assign(root.AidlcTrace || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMPTY = Object.freeze([]);

  // Lane order and grouping, as in the spec's LANES (colours live in CSS).
  var LANES = Object.freeze([
    Object.freeze({ key: 'req', label: 'Requirement', types: Object.freeze(['functional_requirement', 'nfr']) }),
    Object.freeze({ key: 'nfrd', label: 'NFR detail', types: Object.freeze(['nfr_detail']) }),
    Object.freeze({ key: 'us', label: 'User story', types: Object.freeze(['user_story']) }),
    Object.freeze({ key: 'ac', label: 'Acceptance criterion', types: Object.freeze(['acceptance_criterion']) }),
    Object.freeze({ key: 'br', label: 'Business rule', types: Object.freeze(['business_rule']) }),
    Object.freeze({ key: 'des', label: 'Design', types: Object.freeze(['component', 'unit', 'design_decision', 'stage', 'note']) }),
    Object.freeze({ key: 'code', label: 'Code', types: Object.freeze(['code']) }),
    Object.freeze({ key: 'test', label: 'Test', types: Object.freeze(['test']) }),
  ]);

  function laneOf(type) {
    for (var i = 0; i < LANES.length; i++) if (LANES[i].types.indexOf(type) !== -1) return LANES[i];
    return null;
  }

  function dict() { return Object.create(null); }

  /**
   * Build O(1) lookup indexes. Null-prototype objects keyed by node id, so the
   * spec's N[id] / OUT[id] / IN[id] idioms port directly.
   * Edges whose endpoints are not nodes are still indexed (as in the spec).
   * Later duplicates of a node id win (as in the spec).
   * @returns {{byId: Object<string, object>, out: Object<string, object[]>, in: Object<string, object[]>}}
   */
  function buildIndexes(data) {
    var byId = dict(), out = dict(), inn = dict();
    var nodes = (data && Array.isArray(data.nodes)) ? data.nodes : EMPTY;
    var edges = (data && Array.isArray(data.edges)) ? data.edges : EMPTY;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n && n.id != null) byId[n.id] = n;
    }
    for (var j = 0; j < edges.length; j++) {
      var e = edges[j];
      if (!e || e.source == null || e.target == null) continue;
      (out[e.source] || (out[e.source] = [])).push(e);
      (inn[e.target] || (inn[e.target] = [])).push(e);
    }
    return { byId: byId, out: out, in: inn, edges: edges, nodes: nodes };
  }

  function outEdges(indexes, id) { return (indexes && indexes.out[id]) || EMPTY; }
  function inEdges(indexes, id) { return (indexes && indexes.in[id]) || EMPTY; }

  /**
   * Reachability, identical to the spec's bfs(start, dir): 'down' follows
   * source->target, anything else follows target->source. The start node is
   * never in the result, even on a cycle. Insertion order equals the spec's.
   * @returns {Set<string>}
   */
  function bfs(indexes, startId, dir) {
    var seen = new Set();
    if (!indexes || startId == null) return seen;
    var down = dir === 'down';
    var adj = down ? indexes.out : indexes.in;
    var q = [startId], head = 0;
    while (head < q.length) {
      var list = adj[q[head++]];
      if (!list) continue;
      for (var i = 0; i < list.length; i++) {
        var y = down ? list[i].target : list[i].source;
        if (!seen.has(y) && y !== startId) { seen.add(y); q.push(y); }
      }
    }
    return seen;
  }

  /**
   * The visible subgraph for a selection, as computed by the spec's select().
   * Returns null when selectedId is not a node (the spec ignores such selects).
   * nodeIds: selected + upstream + downstream (includes ids without a node
   * record or without a lane); edges: those inside the upstream closure or
   * inside the downstream closure; lanes: non-empty lanes in LANES order with
   * node records sorted by natural(shortId + id).
   */
  function subgraph(indexes, selectedId) {
    if (!indexes || selectedId == null || !indexes.byId[selectedId]) return null;
    var up = bfs(indexes, selectedId, 'up');
    var down = bfs(indexes, selectedId, 'down');
    var A = new Set([selectedId]), D = new Set([selectedId]);
    up.forEach(function (x) { A.add(x); });
    down.forEach(function (x) { D.add(x); });
    var all = new Set(A);
    D.forEach(function (x) { all.add(x); });

    var edges = [];
    var src = indexes.edges || EMPTY;
    for (var i = 0; i < src.length; i++) {
      var e = src[i];
      if (!e) continue;
      if ((A.has(e.source) && A.has(e.target)) || (D.has(e.source) && D.has(e.target))) edges.push(e);
    }

    var buckets = LANES.map(function () { return []; });
    all.forEach(function (id) {
      var n = indexes.byId[id];
      if (!n) return;
      for (var k = 0; k < LANES.length; k++) {
        if (LANES[k].types.indexOf(n.type) !== -1) { buckets[k].push(n); break; }
      }
    });
    var lanes = [];
    for (var k = 0; k < LANES.length; k++) {
      if (!buckets[k].length) continue;
      buckets[k].sort(function (a, b) { return natural(shortId(a) + a.id, shortId(b) + b.id); });
      lanes.push({ key: LANES[k].key, label: LANES[k].label, types: LANES[k].types, nodes: buckets[k] });
    }
    return { selectedId: selectedId, up: up, down: down, nodeIds: Array.from(all), edges: edges, lanes: lanes };
  }

  /** Counts of downstream node records by type (the Coverage matrix cells). */
  function downstreamCounts(indexes, id) {
    var counts = {};
    if (!indexes) return counts;
    bfs(indexes, id, 'down').forEach(function (x) {
      var n = indexes.byId[x];
      if (n) counts[n.type] = (counts[n.type] || 0) + 1;
    });
    return counts;
  }

  function natural(a, b) {
    return String(a == null ? '' : a).localeCompare(String(b == null ? '' : b), undefined, { numeric: true });
  }

  // Spec: design decisions show their stage, notes show "deferral note".
  // Falls back to the id when a design decision has no stage.
  function shortId(n) {
    if (!n) return '';
    if (n.type === 'design_decision') return n.stage != null && n.stage !== '' ? String(n.stage) : String(n.id);
    if (n.type === 'note') return 'deferral note';
    return String(n.id);
  }

  function shortLabel(n) {
    var t = (n && n.label) ? String(n.label) : '';
    return t.length > 90 ? t.slice(0, 88) + '...' : t;
  }

  // Spec classes for the spec's wording; also covers the reader's wording
  // ("Not Met", "Not covered"), which the spec's regexes would leave unstyled
  // or (for a case-insensitive Covered) misclassify as ok.
  function verdictClass(v) {
    if (!v) return '';
    v = String(v);
    if (/^not (met|covered)/i.test(v)) return 'bad';
    if (/^Met|Covered/.test(v)) return 'ok';
    if (/Not met/.test(v)) return 'bad';
    if (/Deferred|Unverified/.test(v)) return 'def';
    return '';
  }

  // Spec origins say "... (derived)"; the reader uses "derived:<rule>" and
  // derived: true. A file path that merely contains "derived" is not derived.
  function isDerived(e) {
    if (!e) return false;
    if (e.derived === true) return true;
    var o = e.origin == null ? '' : String(e.origin);
    return /^derived:/.test(o) || /\(derived\)/.test(o);
  }

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  return {
    LANES: LANES,
    laneOf: laneOf,
    buildIndexes: buildIndexes,
    outEdges: outEdges,
    inEdges: inEdges,
    bfs: bfs,
    subgraph: subgraph,
    downstreamCounts: downstreamCounts,
    natural: natural,
    shortId: shortId,
    shortLabel: shortLabel,
    verdictClass: verdictClass,
    isDerived: isDerived,
    esc: esc,
  };
});
