// Coverage view for the Trace Explorer.
//
// Port of the design spec's Coverage tab (design-spec/AI-DLC Trace Explorer.html:
// <section id="v-cov">, COV_MODES, covRows, renderCov). A traceability matrix: one
// row per requirement-like item of the chosen mode, one column per downstream node
// type, each cell the number of distinct node records reachable downstream
// (graph.downstreamCounts, which is graph.bfs(..., 'down')).
//
// Pure: renderCoverage(data, indexes, state) -> HTML string. No DOM, no require,
// no style= attributes. main.js wires the events by delegation:
//   data-mode="fr|nfr|br"  chip toggle (state.covMode, kept in webview state)
//   data-go="<id>"         row: select the item and switch to Trace
// Graph helpers come from AidlcTrace (lib/graph.js), resolved at call time, so
// load order only matters for rendering, not for loading this file. Under Node,
// seed globalThis.AidlcTrace with lib/graph.js first (see graph() below).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AidlcTrace = Object.assign(root.AidlcTrace || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Spec COV_MODES, with the row type of covRows(). The spec hard-codes the counts
  // in the labels ("Functional (13)"); here they are counted from the data.
  var MODES = Object.freeze([
    Object.freeze({ key: 'fr', label: 'Functional', type: 'functional_requirement', noun: 'functional requirements' }),
    Object.freeze({ key: 'nfr', label: 'NFR detail', type: 'nfr_detail', noun: 'NFR details' }),
    Object.freeze({ key: 'br', label: 'Business rules', type: 'business_rule', noun: 'business rules' }),
  ]);

  // Spec renderCov's `cols`, per mode: [node type, header].
  var COLUMNS = Object.freeze({
    fr: Object.freeze([
      ['user_story', 'Stories'], ['acceptance_criterion', 'Criteria'], ['business_rule', 'Rules'],
      ['component', 'Component'], ['code', 'Code'], ['test', 'Tests'],
    ].map(col)),
    nfr: Object.freeze([['design_decision', 'Designs'], ['code', 'Code'], ['test', 'Tests'], ['note', 'Deferral']].map(col)),
    br: Object.freeze([['code', 'Code'], ['test', 'Tests']].map(col)),
  });
  function col(c) { return Object.freeze({ type: c[0], label: c[1] }); }

  var TEXT_MAX = 120; // spec: (n.text || '').slice(0, 120)

  // Every AidlcTrace helper this view calls. lib/graph.js provides them all.
  var NEEDS = ['natural', 'verdictClass', 'buildIndexes', 'downstreamCounts', 'esc'];

  // Resolved at call time from self.AidlcTrace (webview: lib/graph.js loads first) or,
  // under Node, globalThis.AidlcTrace. Node callers must seed it before rendering:
  //   globalThis.AidlcTrace = Object.assign(globalThis.AidlcTrace || {}, <exports of lib/graph.js>);
  // (tests/coverage-view.test.js does exactly this).
  function graph() {
    var g = (typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : {})).AidlcTrace;
    var missing = NEEDS.filter(function (k) { return !g || typeof g[k] !== 'function'; });
    if (missing.length) {
      throw new Error('graph helpers (lib/graph.js) are not loaded: missing AidlcTrace.' + missing.join(', AidlcTrace.'));
    }
    return g;
  }

  function modeOf(key) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].key === key) return MODES[i];
    return MODES[0];
  }

  function nodesOf(data) {
    return (data && Array.isArray(data.nodes)) ? data.nodes : [];
  }

  /** Number of node records of each mode's row type (the chip counts). */
  function modeCounts(data) {
    var counts = { fr: 0, nfr: 0, br: 0 };
    var nodes = nodesOf(data);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n || n.id == null) continue;
      for (var k = 0; k < MODES.length; k++) if (n.type === MODES[k].type) counts[MODES[k].key]++;
    }
    return counts;
  }

  /**
   * The matrix as data: { mode, columns[{type,label}], rows[{id, node, counts{type:n}, cells[n]}] }.
   * Rows are the spec's covRows(): nodes of the mode's type, sorted by natural(id).
   */
  function coverageModel(data, indexes, modeKey) {
    var G = graph();
    var mode = modeOf(modeKey);
    var columns = COLUMNS[mode.key];
    var rows = nodesOf(data)
      .filter(function (n) { return n && n.id != null && n.type === mode.type; })
      .sort(function (a, b) { return G.natural(a.id, b.id); })
      .map(function (n) {
        var counts = G.downstreamCounts(indexes, n.id);
        return {
          id: String(n.id),
          node: n,
          counts: counts,
          cells: columns.map(function (c) { return counts[c.type] || 0; }),
        };
      });
    return { mode: mode.key, columns: columns, rows: rows };
  }

  function chipBar(data, active, E) {
    var counts = modeCounts(data);
    return '<div class="covTools" role="group" aria-label="Rows to show">' +
      MODES.map(function (m) {
        var on = m.key === active;
        return '<button type="button" class="chipBtn' + (on ? ' on' : '') + '" data-mode="' + m.key +
          '" aria-pressed="' + (on ? 'true' : 'false') + '">' + E(m.label) + ' (' + counts[m.key] + ')</button>';
      }).join('') +
      '</div>';
  }

  function verdictCell(n, G) {
    if (!n.verdict) return '<span class="sev">via parent</span>';
    var cls = G.verdictClass(n.verdict);
    return '<span class="bdg' + (cls ? ' ' + cls : '') + '">' + G.esc(n.verdict) + '</span>';
  }

  function rowHtml(r, G) {
    var E = G.esc;
    var n = r.node;
    var text = n.text == null ? '' : String(n.text);
    var shown = text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text;
    var cells = r.cells.map(function (k) {
      return '<td class="c"><span class="' + (k ? 'cellN' : 'cell0') + '">' + k + '</span></td>';
    }).join('');
    // The row is the mouse target; the ID button is the keyboard control (one tab stop per row).
    // .cov .idlink (trace-explorer.css) styles the button; IDs must not wrap mid-token.
    return '<tr class="row" data-go="' + E(r.id) + '" title="Open ' + E(r.id) + ' in Trace">' +
      '<td class="mono"><button type="button" class="idlink" data-go="' + E(r.id) + '" aria-label="Open ' + E(r.id) +
      ' in Trace"><b>' + E(r.id) + '</b></button></td>' +
      '<td' + (shown !== text ? ' title="' + E(text) + '"' : '') + '>' + E(shown) + '</td>' +
      cells +
      '<td>' + verdictCell(n, G) + '</td></tr>';
  }

  /**
   * Coverage tab HTML.
   * @param {object} data     TraceData
   * @param {object} indexes  AidlcTrace.buildIndexes(data)
   * @param {{covMode?: 'fr'|'nfr'|'br'}} state  read only
   * @returns {string}
   */
  function renderCoverage(data, indexes, state) {
    var G = graph();
    var E = G.esc;
    var idx = indexes || G.buildIndexes(data);
    var model = coverageModel(data, idx, state && state.covMode);
    var mode = modeOf(model.mode);
    var cols = model.columns;
    var width = cols.length + 3;

    var head = '<thead><tr><th scope="col">ID</th><th scope="col">Requirement</th>' +
      cols.map(function (c) { return '<th scope="col" class="c">' + E(c.label) + '</th>'; }).join('') +
      '<th scope="col">As built</th></tr></thead>';

    var body = model.rows.length
      ? model.rows.map(function (r) { return rowHtml(r, G); }).join('')
      : '<tr><td colspan="' + width + '"><div class="empty">No ' + E(mode.noun) +
        ' in the trace records of this project.</div></td></tr>';

    return '<section class="cov">' +
      chipBar(data, mode.key, E) +
      '<div class="tableWrap"><table><caption class="sr-only">Coverage of ' + E(mode.noun) +
      ': distinct items reachable downstream</caption>' + head + '<tbody>' + body + '</tbody></table></div>' +
      '<p class="stamp mt8">Counts are distinct items reachable downstream through the trace links. ' +
      'Click a row, or press Enter on its ID, to open it in Trace. A zero means no trace link, not necessarily missing work.</p>' +
      '</section>';
  }

  return {
    renderCoverage: renderCoverage,
    coverageModel: coverageModel,
    coverageModeCounts: modeCounts,
    COV_MODES: MODES,
    COV_COLUMNS: COLUMNS,
  };
});
