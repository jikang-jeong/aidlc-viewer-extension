// Trace Explorer webview entry point.
//
// Runs last, after lib/graph.js and the views/*.js renderers have added themselves to
// self.AidlcTrace. It owns:
//   - the message channel to the extension host (types mirrored from
//     src/trace-explorer-protocol.js, which a webview cannot require),
//   - UI state: active tab, selected node, coverage mode, picker query,
//   - rendering: the active tab's view is a pure function renderX(data, indexes, state)
//     returning HTML; a missing renderer or one that throws gets a placeholder, so one
//     broken view never takes the others down,
//   - all event wiring, by delegation on data-* attributes (views emit no handlers):
//       data-tab="trace|cov|rev|about"    switch tab
//       data-select="<node id>"           select a node, stay on this tab
//       data-go="<node id>"               select a node and switch to Trace
//       data-open="<project path>" [data-line="<n>"]   ask the host to open a file
//       data-mode="<coverage mode>"       set the coverage mode
//       data-action="refresh"             ask the host to re-read the project
//       data-query (on an <input>)        picker search text; Enter selects an exact ID
//
// Optional per-view hook: AidlcTrace.afterRenderTrace / afterRenderCoverage /
// afterRenderReviews / afterRenderAbout(container, data, indexes, state) is called after
// the HTML is inserted (e.g. to measure the DOM). It must not attach inline handlers.
(function (root) {
  'use strict';

  // ---- protocol (mirror of src/trace-explorer-protocol.js) ----
  var PROTOCOL_VERSION = 1;
  var TO_HOST = { READY: 'ready', OPEN_FILE: 'openFile', REFRESH: 'refresh', SELECTION_CHANGED: 'selectionChanged' };
  var TO_WEBVIEW = { SET_DATA: 'setData', DATA_ERROR: 'dataError', NAVIGATE_TO: 'navigateTo' };
  var TABS = ['trace', 'cov', 'rev', 'about'];
  var SET_DATA_REASONS = ['initial', 'refresh', 'file-change'];
  var DATA_ERROR_CODES = ['no-project', 'read-failed', 'not-serializable', 'too-large', 'bad-shape'];
  var NODE_ID_MAX = 256;
  var ERROR_MESSAGE_MAX = 500;
  var CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

  var COV_MODES = ['fr', 'nfr', 'br'];
  var RENDERERS = {
    trace: { fn: 'renderTrace', after: 'afterRenderTrace', label: 'Trace' },
    cov: { fn: 'renderCoverage', after: 'afterRenderCoverage', label: 'Coverage' },
    rev: { fn: 'renderReviews', after: 'afterRenderReviews', label: 'Reviews and rework' },
    about: { fn: 'renderAbout', after: 'afterRenderAbout', label: 'About' }
  };

  var doc = root.document;
  var vscode = typeof root.acquireVsCodeApi === 'function' ? root.acquireVsCodeApi() : null;

  function lib() { return root.AidlcTrace || {}; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function isSeq(v) { return typeof v === 'number' && v >= 0 && Math.floor(v) === v; }
  function cleanNodeId(v) {
    if (typeof v !== 'string' || v.length === 0 || v.length > NODE_ID_MAX) return null;
    if (v.trim() === '' || CONTROL_CHARS.test(v)) return null;
    return v;
  }

  function post(msg) {
    if (vscode) vscode.postMessage(msg);
  }

  // ---- state ----
  var state = { tab: 'trace', selected: null, covMode: 'fr', query: '' };
  var data = null;
  var indexes = null;
  var nodeIds = null; // Set-like object of node ids in the current data
  var lastSeq = -1;
  var pendingNav = null;
  var errorState = null; // { code, message } while the last read failed

  (function restore() {
    var saved = vscode && typeof vscode.getState === 'function' ? vscode.getState() : null;
    if (!isPlainObject(saved)) return;
    if (TABS.indexOf(saved.tab) !== -1) state.tab = saved.tab;
    if (cleanNodeId(saved.selected)) state.selected = saved.selected;
    if (COV_MODES.indexOf(saved.covMode) !== -1) state.covMode = saved.covMode;
    if (typeof saved.query === 'string') state.query = saved.query.slice(0, 200);
  })();

  function persist() {
    if (vscode && typeof vscode.setState === 'function') {
      vscode.setState({ tab: state.tab, selected: state.selected, covMode: state.covMode, query: state.query });
    }
  }

  function notifySelection() {
    post({ type: TO_HOST.SELECTION_CHANGED, nodeId: state.selected, tab: state.tab });
  }

  // A view gets a copy, so a renderer that mutates its state argument cannot corrupt ours.
  function viewState() {
    return { tab: state.tab, selected: state.selected, covMode: state.covMode, query: state.query };
  }

  function byId(id) { return doc.getElementById(id); }

  function hasNode(id) { return !!(nodeIds && id != null && Object.prototype.hasOwnProperty.call(nodeIds, id)); }

  function naturalCompare(a, b) {
    var L = lib();
    if (typeof L.natural === 'function') return L.natural(a, b);
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  // The node selected when nothing is (first load, or the selection vanished on reload):
  // the first functional requirement in natural order, else the first node.
  function defaultSelection() {
    if (!data || !data.nodes.length) return null;
    var frs = [];
    for (var i = 0; i < data.nodes.length; i++) {
      var n = data.nodes[i];
      if (n && n.type === 'functional_requirement' && typeof n.id === 'string') frs.push(n.id);
    }
    if (frs.length) return frs.sort(naturalCompare)[0];
    var first = data.nodes[0];
    return first && typeof first.id === 'string' ? first.id : null;
  }

  function buildIndexes(d) {
    var L = lib();
    var ids = Object.create(null);
    for (var i = 0; i < d.nodes.length; i++) {
      var n = d.nodes[i];
      if (n && n.id != null) ids[n.id] = true;
    }
    nodeIds = ids;
    if (typeof L.buildIndexes === 'function') {
      try {
        return L.buildIndexes(d);
      } catch (err) {
        showBanner('err', 'Could not index the trace data: ' + (err && err.message ? err.message : err));
        return null;
      }
    }
    return null;
  }

  // ---- banner ----
  function showBanner(kind, text, list) {
    var el = byId('te-banner');
    if (!el) return;
    if (!kind) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.className = 'banner' + (kind === 'warn' ? ' warn' : kind === 'err' ? ' err' : '');
    var html = esc(text);
    if (list && list.length) {
      var shown = list.slice(0, 20);
      html += '<ul>' + shown.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
      if (list.length > shown.length) html += '<div class="sev">and ' + (list.length - shown.length) + ' more</div>';
    }
    el.innerHTML = html;
  }

  function updateHeader() {
    var meta = (data && isPlainObject(data.meta)) ? data.meta : {};
    var title = byId('te-title');
    var intent = byId('te-intent');
    var stats = byId('te-stats');
    var stamp = byId('te-stamp');
    if (title) title.textContent = meta.intent ? String(meta.intent).replace(/^\d{6}-/, '') : 'Trace Explorer';
    if (intent) intent.innerHTML = meta.intent ? 'Intent <code>' + esc(meta.intent) + '</code> ·' : '';
    if (stats) {
      if (!data) stats.textContent = '';
      else {
        var derived = 0;
        for (var i = 0; i < data.edges.length; i++) {
          var e = data.edges[i];
          if (e && (e.derived === true || /^derived:/.test(String(e.origin || '')))) derived++;
        }
        var reviews = Array.isArray(data.reviews) ? data.reviews.length : 0;
        stats.textContent = data.nodes.length + ' items, ' + data.edges.length + ' links (' + derived + ' derived), ' + reviews + ' reviews';
      }
    }
    if (stamp && meta.generated) {
      stamp.textContent = 'Read from the AI-DLC records at ' + String(meta.generated).replace('T', ' ').replace(/\.\d+Z$/, 'Z') +
        '. A derivative view; the artifacts stay the source of truth.';
    }
  }

  // ---- tabs and rendering ----
  function applyTabChrome() {
    for (var i = 0; i < TABS.length; i++) {
      var key = TABS[i];
      var on = key === state.tab;
      var tab = byId('tab-' + key);
      var view = byId('view-' + key);
      if (tab) {
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.setAttribute('tabindex', on ? '0' : '-1');
        tab.classList.toggle('active', on);
      }
      if (view) {
        view.classList.toggle('active', on);
        view.hidden = !on;
      }
    }
  }

  function placeholder(key, text) {
    return '<div class="panel box"><div class="empty">' + esc(text || (RENDERERS[key].label + ' view is not available in this build.')) + '</div></div>';
  }

  function renderActive() {
    var key = state.tab;
    var view = byId('view-' + key);
    if (!view) return;
    if (!data) {
      view.innerHTML = placeholder(key, errorState ? 'No data: ' + errorState.message : 'Loading trace data…');
      return;
    }
    var spec = RENDERERS[key];
    var L = lib();
    var fn = L[spec.fn];
    if (typeof fn !== 'function') {
      view.innerHTML = placeholder(key);
      return;
    }
    var focus = captureFocus(view);
    var scroll = captureScroll(view);
    try {
      var html = fn(data, indexes, viewState());
      view.innerHTML = typeof html === 'string' ? html : '';
    } catch (err) {
      view.innerHTML = placeholder(key, spec.label + ' view failed: ' + (err && err.message ? err.message : err));
      restoreFocus(view, focus);
      return;
    }
    restoreScroll(view, scroll);
    if (typeof L[spec.after] === 'function') {
      try { L[spec.after](view, data, indexes, viewState()); } catch (err) { /* geometry is optional */ }
    }
    restoreFocus(view, focus);
  }

  // ---- scroll positions across re-renders ----
  //
  // innerHTML creates new scroll containers at scroll 0, so a lane scrolled into view, a
  // long picker list or a scrolled table jumped back to the start on every click. Saved by
  // selector and index, restored before the after-render hook (which may measure) and
  // before focus is restored. The detail panel's position is kept only while the same node
  // is shown; a new node's detail starts at the top.
  var SCROLLERS = ['.canvasWrap', '.picker', '.pickList', '.tableWrap', '.detail'];
  var SCROLLER_SELECTOR = SCROLLERS.join(',');

  function captureScroll(view) {
    var out = { selected: state.selected, items: [] };
    if (typeof view.querySelectorAll !== 'function') return out;
    for (var i = 0; i < SCROLLERS.length; i++) {
      var list = view.querySelectorAll(SCROLLERS[i]);
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (el.scrollLeft || el.scrollTop) out.items.push({ sel: SCROLLERS[i], i: j, left: el.scrollLeft || 0, top: el.scrollTop || 0 });
      }
    }
    return out;
  }

  function restoreScroll(view, saved) {
    if (!saved || typeof view.querySelectorAll !== 'function') return;
    for (var k = 0; k < saved.items.length; k++) {
      var it = saved.items[k];
      if (it.sel === '.detail' && saved.selected !== state.selected) continue;
      var el = view.querySelectorAll(it.sel)[it.i];
      if (!el) continue;
      el.scrollLeft = it.left;
      el.scrollTop = it.top;
    }
  }

  // If the element is clipped by its scroll container, scroll it (and only as far as needed).
  function ensureVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function' || typeof el.closest !== 'function') return;
    var box = el.closest(SCROLLER_SELECTOR);
    if (box === el) box = null;
    if (!box || typeof box.getBoundingClientRect !== 'function') return;
    var r = el.getBoundingClientRect();
    var b = box.getBoundingClientRect();
    var inside = r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= b.bottom;
    if (!inside && typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (err) { el.scrollIntoView(false); }
    }
  }

  // ---- focus across re-renders ----
  //
  // innerHTML replaces the element that had focus, and the browser then puts focus on
  // <body>: a keyboard user who pressed Enter on a chip or a node had to Tab through the
  // whole page to get back. So before a render we note *what* was focused (the action
  // attribute and value, and which panel of the view it was in), and afterwards focus the
  // element with the same identity in the same panel. If it is gone, we fall back to the
  // panel's selected item, then to the view itself. Focus is only moved when it was
  // inside a view before the render (never stolen from the tab bar, banner or header).
  var FOCUS_ATTRS = ['data-query', 'data-select', 'data-go', 'data-mode', 'data-open', 'data-action', 'data-tab'];
  var PANELS = ['picker', 'canvas', 'detail'];
  var PANEL_SELECTOR = '.picker,.canvas,.detail';

  function attrOf(el, name) { return el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : null; }

  function viewOf(el) {
    for (var i = 0; i < TABS.length; i++) {
      var v = byId('view-' + TABS[i]);
      if (v && el && typeof v.contains === 'function' && v.contains(el)) return v;
    }
    return null;
  }

  function panelKey(el) {
    var p = el && typeof el.closest === 'function' ? el.closest(PANEL_SELECTOR) : null;
    if (!p) return null;
    for (var i = 0; i < PANELS.length; i++) if (p.classList && p.classList.contains(PANELS[i])) return PANELS[i];
    return null;
  }

  // Returns null when focus was not inside any view; otherwise what to restore.
  function captureFocus(view) {
    var a = doc.activeElement;
    var inView = viewOf(a);
    if (!inView) return null;
    var out = { sameView: inView === view, attr: null, value: null, panel: null, caret: null };
    if (!out.sameView || a === inView) return out;
    var el = typeof a.closest === 'function' ? a.closest(ACTION_SELECTOR + ',[data-query]') : null;
    if (el && el !== inView && inView.contains(el)) {
      for (var i = 0; i < FOCUS_ATTRS.length; i++) {
        var v = attrOf(el, FOCUS_ATTRS[i]);
        if (v != null) { out.attr = FOCUS_ATTRS[i]; out.value = v; break; }
      }
    }
    out.panel = panelKey(a);
    if (out.attr === 'data-query' && typeof a.selectionStart === 'number') out.caret = a.selectionStart;
    return out;
  }

  var NATIVE_FOCUSABLE = { BUTTON: 1, INPUT: 1, A: 1, SELECT: 1, TEXTAREA: 1 };
  function isFocusable(el) {
    if (!el) return false;
    if (NATIVE_FOCUSABLE[String(el.tagName || '').toUpperCase()]) return true;
    if (typeof el.tabIndex === 'number' && el.tabIndex >= 0) return true;
    var t = parseInt(attrOf(el, 'tabindex'), 10);
    return t >= 0;
  }

  // The element with attr (= value) in scope, preferring one a keyboard can focus: in
  // Coverage the <tr data-go> row comes before its <button data-go> ID link.
  function findByAttr(scope, attr, value) {
    if (!scope || typeof scope.querySelectorAll !== 'function') return null;
    var list = scope.querySelectorAll('[' + attr + ']');
    var fallback = null;
    for (var i = 0; i < list.length; i++) {
      if (value !== null && list[i].getAttribute(attr) !== value) continue;
      if (isFocusable(list[i])) return list[i];
      if (!fallback) fallback = list[i];
    }
    return fallback;
  }

  function first(scope, selector) {
    return scope && typeof scope.querySelector === 'function' ? scope.querySelector(selector) : null;
  }

  function selectedIn(scope, panel) {
    if (panel === 'picker') return first(scope, '.pick.on') || first(scope, '.pick[aria-selected="true"]') || first(scope, '[data-query]');
    if (panel === 'canvas') return first(scope, '.node.sel') || first(scope, '.node[aria-current="true"]');
    if (panel === 'detail') {
      var h = first(scope, 'h3');
      if (h && !h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
      return h;
    }
    return null;
  }

  function focusEl(el) {
    if (!el || typeof el.focus !== 'function') return false;
    try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
    return doc.activeElement === el;
  }

  function restoreFocus(view, f) {
    if (!f) return;
    if (!f.sameView) {
      // An action in another view switched tabs (e.g. data-go from Coverage to Trace):
      // that element is now hidden, so land on what was selected here.
      var landing = selectedIn(first(view, '.canvas'), 'canvas') || selectedIn(first(view, '.picker'), 'picker');
      if (focusEl(landing)) ensureVisible(landing);
      else focusEl(view);
      return;
    }
    var scope = (f.panel && first(view, '.' + f.panel)) || view;
    var target = null;
    if (f.attr) {
      target = findByAttr(scope, f.attr, f.value);
      // the same action, its value now reflecting state (the chip for the new mode)
      if (!target && f.attr === 'data-mode') target = findByAttr(scope, 'data-mode', state.covMode);
      if (!target && (f.attr === 'data-select' || f.attr === 'data-go')) target = findByAttr(scope, f.attr, state.selected);
    }
    if (!target && f.panel) target = selectedIn(scope, f.panel);
    if (!target && f.attr) target = findByAttr(view, f.attr, f.value);
    if (focusEl(target)) {
      ensureVisible(target);
      if (f.caret != null && typeof target.setSelectionRange === 'function') target.setSelectionRange(f.caret, f.caret);
      return;
    }
    focusEl(view);
  }

  function render() {
    applyTabChrome();
    renderActive();
  }

  function setTab(key, focusTab) {
    if (TABS.indexOf(key) === -1) return;
    var changed = key !== state.tab;
    state.tab = key;
    render();
    if (focusTab) {
      var t = byId('tab-' + key);
      if (t && typeof t.focus === 'function') t.focus();
    }
    if (changed) { persist(); notifySelection(); }
  }

  function select(id, tab) {
    if (!hasNode(id)) return false;
    var changed = id !== state.selected || (tab && tab !== state.tab);
    state.selected = id;
    if (tab && TABS.indexOf(tab) !== -1) state.tab = tab;
    render();
    if (changed) { persist(); notifySelection(); }
    return true;
  }

  // ---- host messages ----
  function onSetData(msg) {
    data = msg.data;
    errorState = null;
    indexes = buildIndexes(data);
    if (state.selected && !hasNode(state.selected)) state.selected = null;
    if (!state.selected) state.selected = defaultSelection();
    var warnings = (isPlainObject(data.meta) && Array.isArray(data.meta.warnings)) ? data.meta.warnings : [];
    if (warnings.length) showBanner('warn', warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') + ' while reading the project:', warnings.map(String));
    else if (!data.nodes.length) showBanner('warn', 'The project was read, but it has no trace items yet.');
    else showBanner(null);
    updateHeader();
    if (pendingNav) {
      var nav = pendingNav;
      pendingNav = null;
      if (hasNode(nav.nodeId)) { state.selected = nav.nodeId; state.tab = nav.tab; }
    }
    render();
    persist();
  }

  function onDataError(msg) {
    errorState = { code: msg.code, message: msg.message };
    var hint = msg.code === 'no-project' ? ' Open a folder with an AI-DLC v2 intent, then Refresh.' : '';
    showBanner('err', msg.message + hint);
    render();
  }

  function onNavigateTo(msg) {
    if (!data) { pendingNav = msg; return; }
    select(msg.nodeId, msg.tab);
  }

  // Mirrors validateHostMessage in src/trace-explorer-protocol.js.
  function validateHostMessage(raw) {
    if (!isPlainObject(raw) || typeof raw.type !== 'string') return null;
    var seq = raw.seq === undefined ? 0 : raw.seq;
    switch (raw.type) {
      case TO_WEBVIEW.SET_DATA: {
        if (!isSeq(seq) || SET_DATA_REASONS.indexOf(raw.reason) === -1) return null;
        var d = raw.data;
        if (!isPlainObject(d) || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) return null;
        return { type: raw.type, seq: seq, reason: raw.reason, data: d };
      }
      case TO_WEBVIEW.DATA_ERROR:
        if (!isSeq(seq) || DATA_ERROR_CODES.indexOf(raw.code) === -1 || typeof raw.message !== 'string') return null;
        return { type: raw.type, seq: seq, code: raw.code, message: raw.message.slice(0, ERROR_MESSAGE_MAX) };
      case TO_WEBVIEW.NAVIGATE_TO: {
        var id = cleanNodeId(raw.nodeId);
        var tab = raw.tab === undefined ? 'trace' : raw.tab;
        if (!id || TABS.indexOf(tab) === -1) return null;
        return { type: raw.type, nodeId: id, tab: tab };
      }
      default:
        return null;
    }
  }

  function onMessage(event) {
    var msg = validateHostMessage(event && event.data);
    if (!msg) return;
    if (msg.type === TO_WEBVIEW.SET_DATA || msg.type === TO_WEBVIEW.DATA_ERROR) {
      if (msg.seq < lastSeq) return; // a slower, older read finished after a newer one
      lastSeq = msg.seq;
    }
    if (msg.type === TO_WEBVIEW.SET_DATA) onSetData(msg);
    else if (msg.type === TO_WEBVIEW.DATA_ERROR) onDataError(msg);
    else onNavigateTo(msg);
  }

  // ---- DOM events (delegation only) ----
  var ACTION_SELECTOR = '[data-tab],[data-select],[data-go],[data-open],[data-mode],[data-action]';

  function closestAction(target) {
    return target && typeof target.closest === 'function' ? target.closest(ACTION_SELECTOR) : null;
  }

  function act(el) {
    var v;
    if ((v = el.getAttribute('data-tab')) != null) return setTab(v, false);
    if ((v = el.getAttribute('data-go')) != null) return select(v, 'trace');
    if ((v = el.getAttribute('data-select')) != null) return select(v);
    if ((v = el.getAttribute('data-open')) != null) {
      var msg = { type: TO_HOST.OPEN_FILE, path: v };
      var line = parseInt(el.getAttribute('data-line'), 10);
      if (line >= 1) msg.line = line;
      return post(msg);
    }
    if ((v = el.getAttribute('data-mode')) != null) {
      if (COV_MODES.indexOf(v) === -1 || v === state.covMode) return;
      state.covMode = v;
      render();
      return persist();
    }
    if (el.getAttribute('data-action') === 'refresh') {
      showBanner('info', 'Reading the project again…');
      return post({ type: TO_HOST.REFRESH });
    }
  }

  function onClick(event) {
    var el = closestAction(event.target);
    if (!el) return;
    if (typeof event.preventDefault === 'function' && el.tagName === 'A') event.preventDefault();
    act(el);
  }

  function onKeyDown(event) {
    var t = event.target;
    // Tab bar: arrow keys, Home, End (WAI-ARIA tabs, automatic activation).
    if (t && typeof t.getAttribute === 'function' && t.getAttribute('role') === 'tab') {
      var i = TABS.indexOf(t.getAttribute('data-tab'));
      var next = null;
      if (event.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
      else if (event.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
      else if (event.key === 'Home') next = TABS[0];
      else if (event.key === 'End') next = TABS[TABS.length - 1];
      if (next) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        setTab(next, true);
      }
      return;
    }
    // Picker search: Enter selects an exact (case-insensitive) ID match.
    if (t && typeof t.hasAttribute === 'function' && t.hasAttribute('data-query')) {
      if (event.key === 'Enter' && data) {
        var q = String(t.value || '').trim().toLowerCase();
        for (var k = 0; k < data.nodes.length; k++) {
          var n = data.nodes[k];
          if (n && typeof n.id === 'string' && n.id.toLowerCase() === q) { select(n.id); break; }
        }
      }
      return;
    }
    // Non-button actionables (e.g. <tr tabindex="0" data-go>): Enter or Space activates.
    if (event.key === 'Enter' || event.key === ' ') {
      var el = closestAction(t);
      if (el && el === t && el.tagName !== 'BUTTON' && el.tagName !== 'A') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        act(el);
      }
    }
  }

  function onInput(event) {
    var t = event.target;
    if (!t || typeof t.hasAttribute !== 'function' || !t.hasAttribute('data-query')) return;
    state.query = String(t.value || '').slice(0, 200);
    renderActive();
    persist();
  }

  doc.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('input', onInput);
  root.addEventListener('message', onMessage);

  render();
  post({ type: TO_HOST.READY, protocol: PROTOCOL_VERSION });
})(typeof self !== 'undefined' ? self : this);
