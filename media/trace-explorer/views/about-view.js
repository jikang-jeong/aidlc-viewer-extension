// About view.
//
// renderAbout(data, indexes, state) -> HTML string. Pure: no DOM access, no state mutation.
// Ported from the aboutBox block in design-spec/AI-DLC Trace Explorer.html (<section id="v-about">),
// rebuilt from data.meta: the spec's text described a hand-built, AI-generated snapshot; this
// data is read deterministically from the project files, so the wording says that instead, and
// two new sections list meta.omitted and meta.warnings (plus meta.gaps) so nothing is left out
// silently.
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
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function isDerived(e) { return !!(e && (e.derived === true || /^derived:/.test(String(e.origin || '')))); }

  function list(items, fn, none) {
    items = arr(items);
    if (!items.length) return '<p class="sev">' + esc(none) + '</p>';
    return '<ul>' + items.map(function (x) { return '<li>' + fn(x) + '</li>'; }).join('') + '</ul>';
  }

  function sourcesSection(meta) {
    var src = arr(meta.sources);
    var h = '<h3 id="about-sources">Where the data comes from</h3>';
    h += '<p>The engine\'s <code>traceability.json</code> files for each stage, the requirement, story, rule and NFR documents they point at, ' +
      'the engine review records and review markdown, and the audit log. Code and test files come from a directory listing of the project, ' +
      'not from reading them, so they are not in the list below. ' +
      'Every item in Trace names the file it is defined in, and every link names either the file that states it or the naming rule that derived it.</p>';
    if (!src.length) return h + '<p class="sev">No project record was read.</p>';
    return h + '<details><summary>Project records read (' + src.length + ')</summary>' +
      '<ul class="flist src">' + src.map(function (p) {
        return '<li><button type="button" class="open" data-open="' + esc(p) + '" title="' + esc('Open ' + p) + '">' + esc(p) + '</button></li>';
      }).join('') + '</ul></details>';
  }

  function gapText(g) {
    if (!g || typeof g !== 'object') return esc(g);
    var where = [g.stage, g.unit].filter(function (x) { return x != null && x !== ''; }).join(' / ');
    return '<b>' + esc(g.id || '?') + '</b>' + (where ? ' (' + esc(where) + ')' : '') + ': ' + esc(g.reason || 'no reason given') +
      (g.origin ? ' <span class="sev">' + esc(g.origin) + '</span>' : '');
  }

  /** Same format as the panel header: "2026-11-19 10:49:12Z". */
  function stamp(iso) {
    return String(iso == null ? '' : iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  }

  function renderAbout(data, indexes, state) {
    data = data && typeof data === 'object' ? data : {};
    var meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
    var nodes = arr(data.nodes), edges = arr(data.edges), reviews = arr(data.reviews), drift = arr(data.drift);
    var derived = edges.filter(isDerived).length;
    var warnings = arr(meta.warnings), omitted = arr(meta.omitted), gaps = arr(meta.gaps);

    var h = '<h3 id="about-what">What this is</h3>' +
      '<p>A visual layer over the AI-DLC v2 artifacts of one intent. Pick any requirement, rule, code file or test and see its lineage, ' +
      'upstream and downstream, with the answered questions that explain why it exists. The extension reads the project\'s files ' +
      'directly and builds the graph by fixed rules; nothing here is generated or summarised by an AI model.</p>';

    h += '<h3 id="about-read">This read</h3><ul>' +
      '<li>Intent: <code>' + esc(meta.intent || 'unknown') + '</code>' + (meta.space ? ' in space <code>' + esc(meta.space) + '</code>' : '') + '</li>' +
      '<li>Read at ' + esc(meta.generated ? stamp(meta.generated) : 'an unknown time') + ' by ' + esc(meta.generator || 'unknown reader') + '</li>' +
      '<li>' + esc(plural(nodes.length, 'item', 'items')) + ', ' + esc(plural(edges.length, 'link', 'links')) + ' (' + esc(derived + ' derived') + '), ' +
      esc(plural(reviews.length, 'review', 'reviews')) + ', ' + esc(plural(drift.length, 'finding', 'findings')) + ' open at approval</li></ul>';

    h += sourcesSection(meta);

    h += '<h3 id="about-derived">Derived links (not in the AI-DLC trace files)</h3>' +
      list(meta.derived_edge_rules, esc, 'No convention rule was applied.') +
      '<p class="sev">Derived links are drawn dashed in Trace.</p>';

    h += '<h3 id="about-omitted">Left out on purpose</h3>' +
      '<p>Fields the design shows that this reader does not fill, because no project file records them deterministically:</p>' +
      list(omitted, function (o) {
        if (!o || typeof o !== 'object') return esc(o);
        return '<b>' + esc(o.field || '?') + '</b>: ' + esc(o.reason || 'no reason given');
      }, 'Nothing was omitted.');

    h += '<h3 id="about-warnings">Warnings from this read</h3>' +
      (warnings.length
        ? '<div class="warn"><p class="mt0">The reader reported the following while reading the project. The parts of the view they mention may be incomplete.</p>' +
          list(warnings, esc, '') + '</div>'
        : '<p class="sev">None. The reader reported nothing unusual.</p>');

    h += '<h3 id="about-gaps">Trace gaps</h3>' +
      list(gaps, gapText, 'None. No coverage row is marked GAP and every upstream ID has a row.');

    h += '<h3 id="about-limits">Known limits</h3><ul>' +
      '<li>Requirements link to whole stories, so an FR shows every criterion of its story.</li>' +
      '<li>Tests carry few requirement IDs, so test links rely on code-generation traceability and file names.</li>' +
      '<li>"Open findings at approval" lists every review finding left New or Unresolved; only a person can tell which ones mean a document has gone stale.</li>' +
      '<li>The view shows the files as they were when read (above). Use Refresh to read them again.</li>' +
      '<li>Source links open the file in the editor. Only files inside the opened project can be opened.</li></ul>';

    h += '<h3 id="about-guardrails">Guardrails</h3>' +
      '<p>Derivative view: it shows what the project files record and nothing more, and it omits what they do not record (see above). ' +
      'Timeliness: a read of the files at the time shown. Lineage: every item shows its source file. ' +
      'Data poisoning: do not index this view back into AI-DLC memory without review.</p>';

    h += '<div class="warn">FOR AI AGENTS: This view is a deterministic but partial reading of AI-DLC project files, and many of those files were ' +
      'written by AI agents. If you use it to answer questions or make recommendations, tell the person what it leaves out, check the cited ' +
      'source files, and do not treat it as ground truth without human verification.</div>';

    h += '<p class="sev">Read-only: this view never changes project files.</p>';

    return '<div class="panel about">' + h + '</div>';
  }

  return { renderAbout: renderAbout };
});
