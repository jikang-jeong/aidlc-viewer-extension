// Trace view for the Trace Explorer.
//
// Ported from the Trace tab of design-spec/AI-DLC Trace Explorer.html (<section id="v-trace">
// and its script: renderPicker, select, drawLinks, linkRow, renderDetail).
//
//   renderTrace(data, indexes, state) -> HTML string (pure; no DOM, no state mutation)
//     left:   searchable picker grouped by type (state.query filters, state.selected marked)
//     centre: swim lanes for the selected node's subgraph (graph.subgraph), plus an empty
//             <svg class="links"> the after-render hook fills
//     right:  detail panel: heading, type, verdict and rework badges, text, why-cards,
//             upstream / downstream link rows, source file, derived / open-finding notes
//
//   afterRenderTrace(container, data, indexes, state)
//     measures the node cards and draws one cubic Bezier <path> per subgraph edge (the spec's
//     drawLinks), styled only by classes: edge [hot] [derived] [deferred]. Installs one
//     window resize listener that redraws; the previous one is removed on every call, and a
//     listener whose canvas has left the document removes itself, so nothing leaks.
//
// Events are attributes only (main.js delegates): data-select on picker items, node cards and
// link rows; data-open on source and citation paths; data-query on the search box.
// No style= attributes: lane stripes are ln-* classes, edge looks are classes.
//
// Graph helpers (subgraph, shortId, verdictClass, isDerived, esc, ...) come from
// lib/graph.js through AidlcTrace (self.AidlcTrace in the webview, globalThis.AidlcTrace
// under node --test), resolved at call time: no require, and load order does not matter.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AidlcTrace = Object.assign(root.AidlcTrace || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GLOBAL = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : {});
  function G() { return GLOBAL.AidlcTrace || {}; }

  // Picker groups, as in the spec's PICK_GROUPS.
  var PICK_GROUPS = [
    ['Functional requirements', 'functional_requirement'],
    ['Non-functional', 'nfr'],
    ['NFR detail', 'nfr_detail'],
    ['User stories', 'user_story'],
    ['Business rules', 'business_rule'],
    ['Code', 'code'],
    ['Tests', 'test'],
  ];

  var TYPE = {
    functional_requirement: 'Functional requirement', nfr: 'Non-functional requirement', nfr_detail: 'NFR detail',
    user_story: 'User story', acceptance_criterion: 'Acceptance criterion', business_rule: 'Business rule',
    component: 'Domain component', unit: 'Unit of work', design_decision: 'Design decision', stage: 'Stage',
    note: 'Deferral note', code: 'Code file', test: 'Test file',
  };

  // Spec's REL, plus the reader's relations the spec's data never had (na_note, traces_to).
  var REL = {
    refined_by: 'refined by', realized_by_story: 'realized by story', has_acceptance_criterion: 'has criterion',
    refined_by_rule: 'refined by rule', owned_by_component: 'owned by', built_in_unit: 'built in',
    implemented_in: 'implemented in', verified_by_test: 'verified by', tested_by: 'tested by',
    designed_as: 'designed as', deferred_to: 'deferred to', deferral_note: 'deferral note',
    na_note: 'N/A note', traces_to: 'traces to',
  };

  function bdg(cls) { return '<span class="bdg' + (cls ? ' ' + cls : '') + '"'; }
  function own(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  function relLabel(r) { return own(REL, r) ? REL[r] : String(r == null ? '' : r); }
  function typeLabel(t) { return own(TYPE, t) ? TYPE[t] : String(t == null ? '' : t); }
  function nodesOf(data) { return data && Array.isArray(data.nodes) ? data.nodes.filter(function (n) { return n && n.id != null; }) : []; }
  function lookup(indexes, id) { return indexes && indexes.byId && id != null ? indexes.byId[id] : undefined; }
  function isCodeLike(t) { return t === 'code' || t === 'test'; }

  // Date part of an ISO timestamp, for badge text ("2026-11-09").
  function day(ts) { var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(ts || '')); return m ? m[1] : ''; }

  // ------------------------------------------------------------------ picker

  function matches(n, f) {
    if (!f) return true;
    return String(n.id).toLowerCase().indexOf(f) !== -1 ||
      String(n.label || '').toLowerCase().indexOf(f) !== -1 ||
      String(n.text || '').toLowerCase().indexOf(f) !== -1;
  }

  function renderPicker(data, state) {
    var g = G(), esc = g.esc;
    var f = String((state && state.query) || '').trim().toLowerCase();
    var selected = state ? state.selected : null;
    var nodes = nodesOf(data);
    var h = '';
    PICK_GROUPS.forEach(function (grp) {
      var t = grp[1];
      var items = nodes.filter(function (n) { return n.type === t && matches(n, f); })
        .sort(function (a, b) { return g.natural(a.id, b.id); });
      if (!items.length) return;
      h += '<div class="grp">' + esc(grp[0]) + ' (' + items.length + ')</div>';
      items.forEach(function (n) {
        var on = n.id === selected;
        var code = isCodeLike(t);
        var name = code ? String(n.id) : String(n.id) + (n.label ? ' ' + n.label : '');
        h += '<button type="button" class="pick' + (on ? ' on' : '') + '" data-select="' + esc(n.id) + '"' +
          (on ? ' aria-current="true"' : '') + ' aria-label="' + esc(name) + '" title="' + esc(n.text || n.label || n.id) + '">' +
          '<span class="mono">' + esc(code ? (n.label || n.id) : n.id) + '</span>' +
          (code ? '' : esc(String(n.label || '').slice(0, 34))) + '</button>';
      });
    });
    if (!h) h = '<div class="empty">' + (nodes.length ? 'No match' : 'No trace items in this project') + '</div>';
    return '<div class="panel picker">' +
      '<input type="search" data-query placeholder="Search ID or text, e.g. FR2.2" autocomplete="off" spellcheck="false"' +
      ' aria-label="Search trace items" value="' + esc((state && state.query) || '') + '">' +
      '<div class="pickList">' + h + '</div></div>';
  }

  // ------------------------------------------------------------------ canvas

  function nodeCard(n, lane, sg, inView, indexes, data) {
    var g = G(), esc = g.esc;
    var b = [];
    if (n.verdict) b.push(bdg(g.verdictClass(n.verdict)) + '>' + esc(n.verdict) + '</span>');
    var inc = g.inEdges(indexes, n.id);
    if (inc.some(function (e) { return inView.has(e.source) && e.status === 'Deferred'; })) b.push('<span class="bdg def">Deferred link</span>');
    if (n.rework) {
      var rd = day(data && data.jump && data.jump.ts);
      b.push('<span class="bdg rw"' + (rd ? ' title="Source invalidated by the backward jump of ' + esc(rd) + '"' : '') + '>Reworked' + (rd ? '<span class="sr-only"> (source invalidated by the backward jump of ' + esc(rd) + ')</span>' : '') + '</span>');
    }
    if (Array.isArray(n.why) && n.why.length) b.push('<span class="bdg">why: ' + n.why.length + '</span>');
    var sel = n.id === sg.selectedId;
    return '<button type="button" class="node ln-' + esc(lane.key) + (sel ? ' sel' : '') + '" data-select="' + esc(n.id) + '"' +
      (sel ? ' aria-current="true"' : '') + ' title="' + esc(n.text || n.label || n.id) + '">' +
      '<span class="id">' + esc(g.shortId(n)) + '</span><span class="lb">' + esc(g.shortLabel(n)) + '</span>' +
      (b.length ? '<span class="badges">' + b.join('') + '</span>' : '') + '</button>';
  }

  var LEGEND = '<span class="legend"><span><i></i>from AI-DLC trace files</span><span><i class="d"></i>derived by naming rule</span>' +
    '<span><i class="a"></i>Deferred</span><span><i class="s"></i>touches the selection</span></span>';

  function renderCanvas(data, indexes, sg) {
    var g = G(), esc = g.esc;
    var title, body;
    if (!sg) {
      title = nodesOf(data).length ? 'Select an item to see its lineage' : 'No trace items';
      body = '<div class="empty">' + (nodesOf(data).length ? 'Pick an item from the list on the left.' : 'The project has no trace items yet.') + '</div>';
    } else {
      var sn = indexes.byId[sg.selectedId];
      title = '<b>' + esc(g.shortId(sn)) + '</b>: ' + sg.up.size + ' upstream, ' + sg.down.size + ' downstream, ' +
        sg.edges.length + ' link' + (sg.edges.length === 1 ? '' : 's');
      body = '';
      var inView = new Set(sg.nodeIds);
      sg.lanes.forEach(function (lane) {
        body += '<div class="lane" role="group" aria-label="' + esc(lane.label) + '"><div class="laneHead">' + esc(lane.label) + ' &middot; ' + lane.nodes.length + '</div>';
        lane.nodes.forEach(function (n) { body += nodeCard(n, lane, sg, inView, indexes, data); });
        body += '</div>';
      });
      body += '<svg class="links" aria-hidden="true" focusable="false"></svg>';
    }
    return '<div class="panel canvasWrap"><div class="canvasHead"><span class="t">' + title + '</span>' + LEGEND + '</div>' +
      '<div class="canvas">' + body + '</div></div>';
  }

  // ------------------------------------------------------------------ detail

  function linkRow(e, dir, indexes) {
    var g = G(), esc = g.esc;
    var other = dir === 'out' ? e.target : e.source;
    var n = lookup(indexes, other);
    var rel = dir === 'out' ? relLabel(e.relation) : 'from (' + relLabel(e.relation) + ')';
    var derived = g.isDerived(e);
    var org = derived ? 'derived' : (e.stage || e.origin || '');
    var target = n
      ? '<button type="button" data-select="' + esc(other) + '" title="' + esc(n.text || n.label || other) + '">' + esc(g.shortId(n)) + '</button>'
      : '<span class="mono" title="Not a trace item">' + esc(other) + '</span>';
    return '<div class="lk"><span class="rel">' + esc(rel) + '</span>' + target +
      (e.status && e.status !== 'OK' ? '<span class="bdg def">' + esc(e.status) + '</span>' : '') +
      '<span class="org" title="' + esc(e.origin || '') + '">' + esc(org) + '</span></div>';
  }

  function whyCard(w) {
    var esc = G().esc;
    var ref = w.path
      ? '<span class="src"><button type="button" class="open" data-open="' + esc(w.path) + '" title="Open ' + esc(w.path) + '"><b>' + esc(w.ref) + '</b></button></span>'
      : '<b>' + esc(w.ref) + '</b>';
    var body;
    if (w.q && w.a) body = '<div class="q">' + esc(w.q) + '</div><div class="a">Answer: ' + esc(w.a) + '</div>';
    else if (w.q) body = '<div class="q">' + esc(w.q) + '</div>';
    else body = '<div class="a">Cited upstream artifact</div>';
    return '<div class="why">' + ref + ' <span class="sev">' + esc(w.stage || '') + '</span>' + body + '</div>';
  }

  function driftFor(data, id) {
    if (!data || !Array.isArray(data.drift)) return [];
    return data.drift.filter(function (d) {
      return d && (d.id === id || (Array.isArray(d.ids) && d.ids.indexOf(id) !== -1));
    });
  }

  function renderDetail(data, indexes, sg) {
    var g = G(), esc = g.esc;
    if (!sg) {
      return '<div class="panel detail"><div class="empty">' +
        (nodesOf(data).length ? 'Nothing selected.' : 'No trace items to show.') + '</div></div>';
    }
    var id = sg.selectedId;
    var n = indexes.byId[id];
    var h = '<h3 tabindex="-1">' + esc(g.shortId(n)) + '</h3><div class="ty">' + esc(typeLabel(n.type)) +
      (n.priority ? ' &middot; ' + esc(n.priority) : '') + (n.category ? ' &middot; ' + esc(n.category) : '') +
      (n.kind ? ' &middot; ' + esc(n.kind) : '') + '</div>';
    if (n.type === 'design_decision' || n.type === 'note') h += '<div class="sev">' + esc(n.id) + '</div>';
    if (n.verdict) {
      h += bdg(g.verdictClass(n.verdict)) + (n.verdictSource ? ' title="' + esc(n.verdictSource) + '"' : '') +
        '>As built: ' + esc(n.verdict) + '</span>';
    }
    if (n.rework) {
      var j = data && data.jump;
      var why = j ? 'Source invalidated by the backward jump' + (day(j.ts) ? ' of ' + day(j.ts) : '') +
        (j.source && j.target ? ' (' + j.source + ' back to ' + j.target + ')' : '') : 'Source invalidated by a backward jump';
      h += ' <span class="bdg rw">' + esc(why) + '</span>';
    }
    h += '<div class="txt">' + esc(n.text || n.label || n.id) + '</div>';

    if (Array.isArray(n.why) && n.why.length) {
      h += '<h4>Why it exists</h4>';
      n.why.forEach(function (w) { if (w) h += whyCard(w); });
    }
    if (Array.isArray(n.notes) && n.notes.length) {
      h += '<h4>Notes</h4>';
      n.notes.forEach(function (x) {
        if (!x) return;
        h += '<div class="lk"><span class="rel">' + esc(x.stage || '') + '</span>' +
          (x.status ? bdg(x.status === 'Deferred' ? 'def' : '') + '>' + esc(x.status) + '</span>' : '') +
          '<span>' + esc(x.text || '') + '</span></div>';
      });
    }

    var i = g.inEdges(indexes, id), o = g.outEdges(indexes, id);
    if (i.length) { h += '<h4>Upstream (' + i.length + ')</h4>'; i.forEach(function (e) { h += linkRow(e, 'in', indexes); }); }
    if (o.length) { h += '<h4>Downstream (' + o.length + ')</h4>'; o.forEach(function (e) { h += linkRow(e, 'out', indexes); }); }
    if (!i.length && !o.length) h += '<div class="sev mt8">No trace links to or from this item.</div>';

    if (n.path) {
      h += '<h4>Source</h4><div class="src">';
      if (n.exists === false) h += '<span class="mono">' + esc(n.path) + '</span> <span class="sev">(not in the project)</span>';
      else h += '<button type="button" class="open" data-open="' + esc(n.path) + '" title="Open in an editor">' + esc(n.path) + '</button>';
      h += '</div>';
    }
    if (o.concat(i).some(g.isDerived)) {
      h += '<div class="note">Dashed links are inferred by a naming rule (story to criterion by ID, code to test by file name). They are not in the AI-DLC trace files.</div>';
    }
    driftFor(data, id).forEach(function (d) {
      h += '<div class="note drift">Open finding at approval' + (d.stage ? ' (' + esc(d.stage) + (d.findingId ? ' ' + esc(d.findingId) : '') + ')' : '') +
        (d.severity ? ' <span class="sev">' + esc(d.severity) + '</span>' : '') + ': ' + esc(d.note || '') +
        (d.file ? '<div class="src"><button type="button" class="open" data-open="' + esc(d.file) + '">' + esc(d.file) + '</button></div>' : '') +
        '</div>';
    });
    return '<div class="panel detail">' + h + '</div>';
  }

  // ------------------------------------------------------------------ public

  function selection(indexes, state) {
    var g = G();
    var id = state ? state.selected : null;
    if (id == null || typeof g.subgraph !== 'function') return null;
    return g.subgraph(indexes, id);
  }

  /** Pure render of the Trace tab. */
  function renderTrace(data, indexes, state) {
    var g = G();
    var ix = indexes || g.buildIndexes(data);
    var sg = selection(ix, state);
    return '<div class="trace">' + renderPicker(data, state) + renderCanvas(data, ix, sg) + renderDetail(data, ix, sg) + '</div>';
  }

  // ---- after render: SVG edges (the spec's drawLinks) ----

  function r1(x) { return Math.round(x * 10) / 10; }

  // Cubic Bezier between two measured cards, as in the spec: forward edges leave the right side
  // of a and enter the left side of b; any other edge loops out 14px right of a into b's right side.
  function edgePath(a, b) {
    if (b.l > a.r) {
      var mx = r1((a.r + b.l) / 2);
      return 'M' + r1(a.r) + ',' + r1(a.y) + ' C' + mx + ',' + r1(a.y) + ' ' + mx + ',' + r1(b.y) + ' ' + r1(b.l) + ',' + r1(b.y);
    }
    var x = r1(a.r + 14);
    return 'M' + r1(a.r) + ',' + r1(a.y) + ' C' + x + ',' + r1(a.y) + ' ' + x + ',' + r1(b.y) + ' ' + r1(b.r) + ',' + r1(b.y);
  }

  function edgeClass(e, selectedId) {
    var g = G();
    var c = 'edge';
    if (e.source === selectedId || e.target === selectedId) c += ' hot';
    if (g.isDerived(e)) c += ' derived';
    if (e.status === 'Deferred') c += ' deferred';
    return c;
  }

  /** Draw the edges into container's svg.links. Returns the number of paths drawn. */
  function drawLinks(container, sg) {
    if (!container || !sg || typeof container.querySelector !== 'function') return 0;
    var cv = container.querySelector('.canvas');
    var svg = cv && cv.querySelector('svg.links');
    if (!cv || !svg) return 0;
    // Read all geometry first, then write, so the browser lays out once.
    var base = cv.getBoundingClientRect();
    if (!base || (!base.width && !base.height)) return 0; // hidden tab: nothing to measure
    var w = cv.scrollWidth || Math.round(base.width), hgt = cv.scrollHeight || Math.round(base.height);
    var pos = Object.create(null);
    var cards = cv.querySelectorAll('.node');
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i];
      var r = el.getBoundingClientRect();
      pos[el.getAttribute('data-select')] = { l: r.left - base.left, r: r.right - base.left, y: r.top - base.top + r.height / 2 };
    }
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(hgt));
    var p = '', count = 0;
    sg.edges.forEach(function (e) {
      var a = pos[e.source], b = pos[e.target];
      if (!a || !b) return;
      p += '<path class="' + edgeClass(e, sg.selectedId) + '" d="' + edgePath(a, b) + '"/>';
      count++;
    });
    svg.innerHTML = p;
    return count;
  }

  // The view is re-rendered on every selection, so the picker's scroll box starts at the top
  // again. Bring the selected item back into it (only the picker scrolls, never the page).
  function revealPick(container) {
    var box = container && typeof container.querySelector === 'function' ? container.querySelector('.picker') : null;
    var on = box && typeof box.querySelector === 'function' ? box.querySelector('.pick.on') : null;
    if (!on || typeof on.getBoundingClientRect !== 'function' || typeof box.getBoundingClientRect !== 'function') return;
    if (typeof box.clientHeight !== 'number' || !box.clientHeight) return;
    // Rects work whatever the layout (sticky column, or static when stacked below 1100px).
    var br = box.getBoundingClientRect(), r = on.getBoundingClientRect();
    var top = r.top - br.top + (box.scrollTop || 0); // item offset inside the scroll box
    var h = r.height || 0;
    if (top < box.scrollTop || top + h > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, Math.round(top - box.clientHeight / 3));
  }

  var listener = null; // { win, fn } of the one live resize listener

  function detach() {
    if (listener) {
      try { listener.win.removeEventListener('resize', listener.fn); } catch (err) { /* window gone */ }
      listener = null;
    }
  }

  function windowOf(container) {
    var doc = container && container.ownerDocument;
    var w = doc && doc.defaultView;
    if (w && typeof w.addEventListener === 'function') return w;
    if (typeof GLOBAL.addEventListener === 'function' && GLOBAL.document) return GLOBAL;
    return null;
  }

  function connected(container) {
    if (!container) return false;
    if (typeof container.isConnected === 'boolean') return container.isConnected;
    return true;
  }

  /** After-render hook: draws edges and keeps them in place on window resize. */
  function afterRenderTrace(container, data, indexes, state) {
    detach();
    var ix = indexes || G().buildIndexes(data);
    var sg = selection(ix, state);
    if (!sg) return 0;
    revealPick(container);
    var drawn = drawLinks(container, sg);
    var win = windowOf(container);
    if (win) {
      var pending = false;
      var raf = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : function (f) { return setTimeout(f, 16); };
      var fn = function () {
        var canvas = container.querySelector && container.querySelector('.canvas');
        if (!connected(container) || !canvas) { if (listener && listener.fn === fn) detach(); return; }
        if (pending) return;
        pending = true;
        raf(function () { pending = false; drawLinks(container, sg); });
      };
      win.addEventListener('resize', fn);
      listener = { win: win, fn: fn };
    }
    return drawn;
  }

  return {
    renderTrace: renderTrace,
    afterRenderTrace: afterRenderTrace,
    disposeTrace: detach,
    traceEdgePath: edgePath,
    TRACE_PICK_GROUPS: PICK_GROUPS,
  };
});
