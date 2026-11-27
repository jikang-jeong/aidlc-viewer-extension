'use strict';

// Trace Explorer panel shell: the HTML shell, the webview script (main.js), the host panel
// (with a stubbed vscode), and the browser preview tool.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const P = require('../src/trace-explorer-protocol');
const { buildHtml, buildCsp, SCRIPT_ORDER, makeNonce } = require('../src/trace-explorer-html');
const { readTraceData } = require('../src/aidlc/trace-data');
const { PROJECT_ROOT, INTENT_ID } = require('./helpers/inventory-fixture');

const EXT_ROOT = path.join(__dirname, '..');
const MEDIA = path.join(EXT_ROOT, 'media', 'trace-explorer');
const MAIN_JS = path.join(MEDIA, 'main.js');
const GRAPH_JS = path.join(MEDIA, 'lib', 'graph.js');

const NONCE = 'abcDEF0123456789abcDEF0123456789';

function sampleHtml(extra = {}) {
  return buildHtml({
    cspSource: 'https://*.vscode-cdn.net',
    nonce: NONCE,
    cssUri: 'https://x.vscode-cdn.net/media/trace-explorer/trace-explorer.css',
    scriptUris: SCRIPT_ORDER.map((s) => `https://x.vscode-cdn.net/media/trace-explorer/${s}`),
    title: 'Trace Explorer',
    ...extra
  });
}

let fixtureData;
function fixture() {
  if (!fixtureData) fixtureData = readTraceData(PROJECT_ROOT, { intent: INTENT_ID });
  return fixtureData;
}

// ---------------------------------------------------------------------------
// buildHtml
// ---------------------------------------------------------------------------

test('buildHtml: strict CSP with no unsafe-inline / unsafe-eval', () => {
  const html = sampleHtml();
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(m, 'CSP meta present');
  const csp = m[1];
  assert.match(csp, /^default-src 'none';/);
  assert.match(csp, /style-src https:\/\/\*\.vscode-cdn\.net(;|$)/);
  assert.match(csp, new RegExp(`script-src 'nonce-${NONCE}'(;|$)`));
  assert.match(csp, /img-src https:\/\/\*\.vscode-cdn\.net data:/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.equal(csp, buildCsp('https://*.vscode-cdn.net', NONCE));
});

test('buildHtml: every script carries the nonce, in the fixed order, main.js last', () => {
  const html = sampleHtml();
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.equal(scripts.length, SCRIPT_ORDER.length);
  for (const attrs of scripts) assert.match(attrs, new RegExp(`nonce="${NONCE}"`));
  const srcs = scripts.map((a) => /src="([^"]+)"/.exec(a)[1].replace(/^.*\/trace-explorer\//, ''));
  assert.deepEqual(srcs, ['lib/graph.js', 'views/trace-view.js', 'views/coverage-view.js', 'views/reviews-view.js', 'views/about-view.js', 'main.js']);
});

test('buildHtml: object scriptUris are put in SCRIPT_ORDER regardless of key order', () => {
  const obj = {};
  for (const s of [...SCRIPT_ORDER].reverse()) obj[s] = `u/${s}`;
  const html = sampleHtml({ scriptUris: obj });
  const srcs = [...html.matchAll(/src="u\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, [...SCRIPT_ORDER]);
});

test('buildHtml: no style= attribute, no <style> block, no inline event handlers', () => {
  const html = sampleHtml();
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /<link rel="stylesheet" href="https:\/\/x\.vscode-cdn\.net\/media\/trace-explorer\/trace-explorer\.css">/);
});

test('buildHtml: four tabs with ARIA tab pattern and one empty panel each', () => {
  const html = sampleHtml();
  assert.match(html, /class="tabs" role="tablist"/);
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)];
  assert.equal(tabs.length, 4);
  assert.deepEqual(tabs.map((t) => t[1]), ['Trace', 'Coverage', 'Reviews and rework', 'About']);
  P.TABS.forEach((key, i) => {
    const tab = tabs[i][0];
    assert.match(tab, new RegExp(`id="tab-${key}"`));
    assert.match(tab, new RegExp(`data-tab="${key}"`));
    assert.match(tab, new RegExp(`aria-controls="view-${key}"`));
    assert.match(tab, new RegExp(`aria-selected="${i === 0}"`));
    assert.match(tab, new RegExp(`tabindex="${i === 0 ? 0 : -1}"`));
    const panel = new RegExp(`<section class="view${i === 0 ? ' active' : ''}" id="view-${key}" role="tabpanel" aria-labelledby="tab-${key}" tabindex="0"${i === 0 ? '' : ' hidden'}></section>`);
    assert.match(html, panel, `empty tabpanel for ${key}`);
  });
  assert.match(html, /id="te-banner" class="banner" role="status"/);
});

test('buildHtml: rejects bad inputs and escapes attribute values', () => {
  assert.throws(() => sampleHtml({ nonce: 'short' }), TypeError);
  assert.throws(() => sampleHtml({ nonce: 'x"><script>alert(1)</script>0000000' }), TypeError);
  assert.throws(() => sampleHtml({ cspSource: "x; script-src 'unsafe-inline'" }), TypeError);
  assert.throws(() => sampleHtml({ cssUri: '' }), TypeError);
  const html = sampleHtml({ title: '<b>"x"</b>', cssUri: 'a"b.css' });
  assert.match(html, /<title>&lt;b&gt;&quot;x&quot;&lt;\/b&gt;<\/title>/);
  assert.match(html, /href="a&quot;b\.css"/);
  assert.match(makeNonce(), /^[A-Za-z0-9]{32}$/);
});

test('buildHtml: a boot script gets the nonce and cannot close its own tag', () => {
  const html = sampleHtml({ bootScript: 'var s = "</script><img src=x>";', bodyClass: 'vscode-light' });
  const inline = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(inline);
  assert.match(inline[1], /<\\\/script>/);
  assert.match(html, /<body class="vscode-light">/);
});

// ---------------------------------------------------------------------------
// main.js: protocol strings
// ---------------------------------------------------------------------------

test('main.js mirrors every protocol type and tab string', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  for (const v of [...Object.values(P.TO_HOST), ...Object.values(P.TO_WEBVIEW)]) {
    assert.ok(src.includes(`'${v}'`), `main.js mentions '${v}'`);
  }
  for (const t of P.TABS) assert.ok(src.includes(`'${t}'`), `main.js mentions tab '${t}'`);
  for (const r of P.SET_DATA_REASONS) assert.ok(src.includes(`'${r}'`), `main.js mentions reason '${r}'`);
  for (const c of P.DATA_ERROR_CODES) assert.ok(src.includes(`'${c}'`), `main.js mentions code '${c}'`);
  assert.match(src, new RegExp(`PROTOCOL_VERSION = ${P.PROTOCOL_VERSION};`));
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\bstyle\s*=\s*["']|\.style\./);
  assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(/);
});

// ---------------------------------------------------------------------------
// main.js in a vm with a tiny fake DOM
// ---------------------------------------------------------------------------

class FakeClassList {
  constructor(el) { this.el = el; }
  _set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  contains(c) { return this._set().has(c); }
  toggle(c, force) {
    const s = this._set();
    const on = force === undefined ? !s.has(c) : !!force;
    if (on) s.add(c); else s.delete(c);
    this.el.className = [...s].join(' ');
    return on;
  }
  add(c) { this.toggle(c, true); }
  remove(c) { this.toggle(c, false); }
}

// One compound selector: tag? (.class | [attr] | [attr="v"])*. Enough for what main.js asks.
function matchesCompound(el, sel) {
  const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/.exec(sel.trim());
  if (!m) throw new Error(`fake DOM cannot match selector: ${sel}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2].match(/\.[\w-]+|\[[^\]]+\]/g) || []) {
    if (part[0] === '.') { if (!el.classList.contains(part.slice(1))) return false; continue; }
    const am = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
    if (!el.hasAttribute(am[1])) return false;
    if (am[2] !== undefined && el.getAttribute(am[1]) !== am[2]) return false;
  }
  return true;
}
const matches = (el, selector) => selector.split(',').some((s) => matchesCompound(el, s));

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'path']);
function parseAttrs(text) {
  const attrs = {};
  for (const a of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : a[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return attrs;
}

class FakeEl {
  constructor(id, attrs = {}, tagName = 'DIV') {
    this.id = id;
    this.tagName = tagName;
    this.attrs = { ...attrs };
    this.className = attrs.class || '';
    this.hidden = 'hidden' in attrs;
    this._html = '';
    this.children = [];
    this.textContent = '';
    this.classList = new FakeClassList(this);
    this.parent = null;
    this.scrollLeft = 0;
    this.scrollTop = 0;
  }
  get innerHTML() { return this._html; }
  // Parses the markup into child elements. As in a browser, replacing the subtree that
  // holds focus sends focus to <body>.
  set innerHTML(html) {
    const doc = this.ownerDocument;
    if (doc && doc.activeElement && doc.activeElement !== this && this.contains(doc.activeElement)) doc.activeElement = doc.body;
    for (const c of this.children) c.parent = null;
    this._html = String(html);
    this.children = [];
    const stack = [this];
    for (const m of this._html.matchAll(/<(\/)?([a-zA-Z][\w-]*)([^>]*?)(\/)?>/g)) {
      const tag = m[2].toLowerCase();
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      const el = new FakeEl(undefined, parseAttrs(m[3]), tag.toUpperCase());
      el.ownerDocument = doc;
      const top = stack[stack.length - 1];
      el.parent = top;
      top.children.push(el);
      if (!m[4] && !VOID.has(tag)) stack.push(el);
    }
  }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  // As in a browser, focus() does nothing on an element that cannot take focus.
  focus(opts) {
    const focusable = ['BUTTON', 'INPUT', 'A', 'SELECT', 'TEXTAREA'].includes(this.tagName) || this.hasAttribute('tabindex');
    if (!focusable) return;
    this.lastFocusOptions = opts;
    this.ownerDocument.activeElement = this;
  }
  // Geometry, only where the tests need it: a .canvasWrap is a 300px-wide viewport and an
  // element with data-x is a 150px card at that x inside it, shifted by the wrap's scrollLeft.
  _wrap() { for (let e = this.parent; e; e = e.parent) if (e.classList.contains('canvasWrap')) return e; return null; }
  getBoundingClientRect() {
    if (this.classList.contains('canvasWrap')) return { left: 0, right: 300, top: 0, bottom: 500 };
    if (this.hasAttribute('data-x')) {
      const wrap = this._wrap();
      const left = Number(this.getAttribute('data-x')) - (wrap ? wrap.scrollLeft : 0);
      return { left, right: left + 150, top: 10, bottom: 60 };
    }
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }
  scrollIntoView(opts) {
    this.ownerDocument.scrolledIntoView = (this.ownerDocument.scrolledIntoView || 0) + 1;
    this.lastScrollIntoView = opts;
    const wrap = this._wrap();
    if (!wrap || !this.hasAttribute('data-x')) return;
    const x = Number(this.getAttribute('data-x'));
    if (x - wrap.scrollLeft < 0) wrap.scrollLeft = x;
    else if (x + 150 - wrap.scrollLeft > 300) wrap.scrollLeft = x + 150 - 300;
  }
  contains(other) { for (let e = other; e; e = e.parent) if (e === this) return true; return false; }
  querySelectorAll(selector) {
    const out = [];
    const walk = (el) => { for (const c of el.children) { if (matches(c, selector)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let e = this; e && e.tagName !== 'BODY'; e = e.parent) if (matches(e, selector)) return e;
    return null;
  }
}

// Builds a fake document whose elements are exactly the id'd elements in buildHtml's output,
// so main.js is checked against the markup it will really get.
function fakeDocument(html) {
  const doc = { listeners: {}, byId: new Map() };
  doc.body = new FakeEl(undefined, {}, 'BODY');
  doc.body.ownerDocument = doc;
  doc.activeElement = doc.body;
  for (const m of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const el = new FakeEl(m[3], parseAttrs(m[2]), m[1].toUpperCase());
    el.ownerDocument = doc;
    el.parent = doc.body;
    doc.byId.set(m[3], el);
  }
  doc.getElementById = (id) => doc.byId.get(id) || null;
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  doc.dispatch = (type, event) => { for (const fn of doc.listeners[type] || []) fn(event); };
  doc.createActionEl = (attrs, tagName = 'BUTTON', parentId) => {
    const el = new FakeEl(undefined, attrs, tagName);
    el.ownerDocument = doc;
    if (parentId) el.parent = doc.byId.get(parentId);
    return el;
  };
  return doc;
}

function runMain({ withGraph = false, renderers = {}, savedState } = {}) {
  const html = sampleHtml();
  const document = fakeDocument(html);
  const posted = [];
  let state = savedState;
  const winListeners = {};
  const sandbox = {
    document,
    console,
    acquireVsCodeApi: () => ({
      postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))),
      // the real getState returns a copy in the page's realm
      getState: () => (state === undefined ? undefined : vm.runInContext(`(${JSON.stringify(state)})`, sandbox)),
      setState: (s) => { state = s; }
    }),
    addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  if (withGraph) vm.runInContext(fs.readFileSync(GRAPH_JS, 'utf8'), sandbox, { filename: GRAPH_JS });
  if (Object.keys(renderers).length) {
    sandbox.AidlcTrace = Object.assign(sandbox.AidlcTrace || {}, renderers);
  }
  vm.runInContext(fs.readFileSync(MAIN_JS, 'utf8'), sandbox, { filename: MAIN_JS });
  // postMessage structured-clones into the page's realm; parse inside the vm to match.
  const inRealmParse = vm.runInContext('(function (s) { return JSON.parse(s); })', sandbox);
  const send = (data) => { for (const fn of winListeners.message || []) fn({ data: inRealmParse(JSON.stringify(data)) }); };
  const click = (attrs, parentId) => {
    const el = document.createActionEl(attrs, 'BUTTON', parentId);
    document.dispatch('click', { target: el, preventDefault() {} });
  };
  return { document, posted, send, click, getState: () => state, view: (k) => document.getElementById(`view-${k}`), tab: (k) => document.getElementById(`tab-${k}`) };
}

function setDataMsg(data, seq = 1, reason = 'initial') {
  const built = P.buildSetDataMessage(data, { seq, reason });
  assert.equal(built.ok, true);
  return built.message;
}

test('main.js posts ready once on load', () => {
  const w = runMain();
  assert.deepEqual(w.posted, [{ type: 'ready', protocol: P.PROTOCOL_VERSION }]);
  assert.ok(P.validateWebviewMessage(w.posted[0]), 'ready passes the host validator');
  assert.match(w.view('trace').innerHTML, /Loading/);
});

test('main.js survives setData with fixture data and no view renderers', () => {
  const w = runMain();
  w.send(setDataMsg(fixture()));
  for (const k of P.TABS) {
    // only the active tab is rendered; switch through all of them
    w.click({ 'data-tab': k });
    assert.match(w.view(k).innerHTML, /class="empty"/, `placeholder in ${k}`);
    assert.match(w.view(k).innerHTML, /not available/);
    assert.equal(w.tab(k).getAttribute('aria-selected'), 'true');
    assert.equal(w.view(k).hidden, false);
    for (const other of P.TABS.filter((o) => o !== k)) {
      assert.equal(w.tab(other).getAttribute('aria-selected'), 'false');
      assert.equal(w.view(other).hidden, true);
    }
  }
  assert.match(w.document.getElementById('te-stats').textContent, /^216 items, 286 links \(\d+ derived\), 21 reviews$/);
  assert.equal(w.document.getElementById('te-title').textContent, 'inventory-api');
  // every message posted to the host is one the host accepts
  for (const m of w.posted) assert.ok(P.validateWebviewMessage(m, { projectRoot: PROJECT_ROOT }), JSON.stringify(m));
});

test('main.js survives setData with lib/graph.js loaded and passes its indexes to views', () => {
  const calls = [];
  const w = runMain({
    withGraph: fs.existsSync(GRAPH_JS),
    renderers: {
      renderTrace: (data, indexes, state) => { calls.push({ data, indexes, state }); return '<div class="trace">T</div>'; }
    }
  });
  w.send(setDataMsg(fixture()));
  assert.equal(w.view('trace').innerHTML, '<div class="trace">T</div>');
  const last = calls[calls.length - 1];
  assert.equal(last.data.nodes.length, fixture().nodes.length);
  assert.equal(last.state.tab, 'trace');
  assert.equal(last.state.covMode, 'fr');
  assert.equal(last.state.selected, 'FR1.1', 'default selection is the first FR in natural order');
  if (fs.existsSync(GRAPH_JS)) assert.ok(last.indexes && last.indexes.byId, 'indexes from AidlcTrace.buildIndexes');
});

test('main.js: a throwing renderer shows an error placeholder and other tabs still work', () => {
  const w = runMain({
    renderers: {
      renderTrace: () => { throw new Error('boom'); },
      renderCoverage: (d, i, s) => `<p>cov ${s.covMode}</p>`
    }
  });
  w.send(setDataMsg(fixture()));
  assert.match(w.view('trace').innerHTML, /Trace view failed: boom/);
  w.click({ 'data-tab': 'cov' });
  assert.equal(w.view('cov').innerHTML, '<p>cov fr</p>');
  w.click({ 'data-mode': 'nfr' });
  assert.equal(w.view('cov').innerHTML, '<p>cov nfr</p>');
  w.click({ 'data-mode': 'bogus' });
  assert.equal(w.view('cov').innerHTML, '<p>cov nfr</p>');
  assert.equal(w.getState().covMode, 'nfr');
});

test('main.js: delegation for data-select, data-go, data-open, data-action; tab kept across setData', () => {
  const seen = [];
  const w = runMain({ renderers: { renderTrace: (d, i, s) => { seen.push(s.selected); return 'trace'; }, renderReviews: () => 'rev' } });
  w.send(setDataMsg(fixture()));
  w.click({ 'data-tab': 'rev' });
  w.posted.length = 0;

  w.click({ 'data-select': 'US1.1' });
  assert.equal(w.getState().selected, 'US1.1');
  assert.equal(w.getState().tab, 'rev', 'data-select stays on the tab');
  assert.deepEqual(w.posted.pop(), { type: 'selectionChanged', nodeId: 'US1.1', tab: 'rev' });

  // a refresh keeps the tab and the selection
  w.send(setDataMsg(fixture(), 2, 'refresh'));
  assert.equal(w.getState().tab, 'rev');
  assert.equal(w.view('rev').hidden, false);
  assert.equal(w.getState().selected, 'US1.1');

  w.click({ 'data-go': 'FR2.2' });
  assert.equal(w.getState().tab, 'trace');
  assert.equal(seen[seen.length - 1], 'FR2.2');
  assert.deepEqual(w.posted.pop(), { type: 'selectionChanged', nodeId: 'FR2.2', tab: 'trace' });

  w.click({ 'data-select': 'NOPE-404' });
  assert.equal(w.getState().selected, 'FR2.2', 'unknown ids are ignored');

  w.click({ 'data-open': 'src/app.ts', 'data-line': '12' });
  assert.deepEqual(w.posted.pop(), { type: 'openFile', path: 'src/app.ts', line: 12 });
  w.click({ 'data-open': 'README.md', 'data-line': 'x' });
  assert.deepEqual(w.posted.pop(), { type: 'openFile', path: 'README.md' });

  // a click on a child of an actionable element bubbles to it
  const parent = w.document.createActionEl({ 'data-action': 'refresh' });
  const child = w.document.createActionEl({}, 'SPAN');
  child.parent = parent;
  w.document.dispatch('click', { target: child, preventDefault() {} });
  assert.deepEqual(w.posted.pop(), { type: 'refresh' });
});

test('main.js: seq ordering, dataError, navigateTo, and invalid host messages', () => {
  const w = runMain({ renderers: { renderTrace: (d, i, s) => `sel=${s.selected}` } });
  w.send(P.buildNavigateToMessage('US1.1', 'trace')); // before data: deferred
  w.send(setDataMsg(fixture(), 5));
  assert.equal(w.view('trace').innerHTML, 'sel=US1.1');

  // older seq is ignored
  w.send(P.buildDataErrorMessage('read-failed', 'old', { seq: 4 }));
  assert.equal(w.view('trace').innerHTML, 'sel=US1.1');
  assert.equal(w.document.getElementById('te-banner').hidden, true);

  w.send(P.buildNavigateToMessage('FR1.2', 'trace'));
  assert.equal(w.view('trace').innerHTML, 'sel=FR1.2');
  w.send(P.buildNavigateToMessage('missing-node', 'trace'));
  assert.equal(w.view('trace').innerHTML, 'sel=FR1.2');

  // junk is dropped
  for (const junk of [null, 'x', { type: 'setData', seq: 9, reason: 'nope', data: fixture() }, { type: 'setData', seq: -1, reason: 'initial', data: { nodes: [] } }, { type: 'openChat' }]) w.send(junk);
  assert.equal(w.view('trace').innerHTML, 'sel=FR1.2');

  w.send(P.buildDataErrorMessage('no-project', 'No folder', { seq: 6 }));
  const banner = w.document.getElementById('te-banner');
  assert.equal(banner.hidden, false);
  assert.match(banner.className, /\berr\b/);
  assert.match(banner.innerHTML, /No folder/);

  // file-change where the selected node vanished: selection falls back to the default
  const shrunk = { ...fixture(), nodes: fixture().nodes.filter((n) => n.id !== 'FR1.2') };
  w.send(setDataMsg(shrunk, 7, 'file-change'));
  assert.equal(w.view('trace').innerHTML, 'sel=FR1.1');
  assert.equal(banner.hidden, true);
});

test('main.js: warnings show in the banner, escaped', () => {
  const w = runMain();
  const d = { ...fixture(), meta: { ...fixture().meta, warnings: ['<img src=x> bad', 'two'] } };
  w.send(setDataMsg(d));
  const banner = w.document.getElementById('te-banner');
  assert.match(banner.className, /\bwarn\b/);
  assert.match(banner.innerHTML, /2 warnings/);
  assert.match(banner.innerHTML, /&lt;img src=x&gt; bad/);
  assert.doesNotMatch(banner.innerHTML, /<img/);
});

test('main.js: restores tab and mode from vscode.getState, and arrow keys move between tabs', () => {
  const w = runMain({ savedState: { tab: 'about', selected: 'US1.1', covMode: 'br', query: 'x' }, renderers: { renderAbout: (d, i, s) => `about ${s.covMode} ${s.selected}` } });
  assert.equal(w.view('about').hidden, false);
  w.send(setDataMsg(fixture()));
  assert.equal(w.view('about').innerHTML, 'about br US1.1');
  w.document.dispatch('keydown', { key: 'ArrowRight', target: w.tab('about'), preventDefault() {} });
  assert.equal(w.getState().tab, 'trace', 'wraps around');
  w.document.dispatch('keydown', { key: 'End', target: w.tab('trace'), preventDefault() {} });
  assert.equal(w.getState().tab, 'about');
  assert.equal(w.document.activeElement, w.tab('about'));
  w.document.dispatch('keydown', { key: 'ArrowLeft', target: w.tab('about'), preventDefault() {} });
  assert.equal(w.getState().tab, 'rev');
});

test('main.js: picker query input and Enter selects an exact id', () => {
  const states = [];
  const w = runMain({ renderers: { renderTrace: (d, i, s) => { states.push(s); return ''; } } });
  w.send(setDataMsg(fixture()));
  const input = w.document.createActionEl({ 'data-query': '' }, 'INPUT', 'view-trace');
  input.value = 'fr2';
  w.document.dispatch('input', { target: input });
  assert.equal(states[states.length - 1].query, 'fr2');
  input.value = 'fr2.2';
  w.document.dispatch('keydown', { key: 'Enter', target: input });
  assert.equal(w.getState().selected, 'FR2.2');
});

// ---------------------------------------------------------------------------
// main.js: keyboard focus survives re-renders
// ---------------------------------------------------------------------------

// Minimal views shaped like the real ones: picker / canvas / detail for Trace, chips and
// rows for Coverage.
const FOCUS_VIEWS = {
  renderTrace: (d, i, s) => {
    const ids = ['FR1.1', 'FR1.2', 'US1.1'];
    const picks = ids.map((id) => `<button class="pick${id === s.selected ? ' on' : ''}" data-select="${id}">${id}</button>`).join('');
    const nodes = ids.map((id, n) => `<button class="node${id === s.selected ? ' sel' : ''}" data-select="${id}" data-x="${n * 300}">${id}</button>`).join('');
    const links = ids.filter((id) => id !== s.selected).map((id) => `<button data-go="${id}">${id}</button>`).join('');
    return `<div class="trace"><div class="panel picker"><input data-query=""><div class="pickList">${picks}</div></div>` +
      `<div class="panel canvasWrap"><div class="canvas">${nodes}</div></div>` +
      `<div class="panel detail"><h3>${s.selected}</h3>${links}</div></div>`;
  },
  renderCoverage: (d, i, s) =>
    `<div class="covTools">${['fr', 'nfr', 'br'].map((m) => `<button class="chipBtn${m === s.covMode ? ' on' : ''}" data-mode="${m}">${m}</button>`).join('')}</div>` +
    // as coverage-view.js: the row and its ID button both carry data-go; the row comes first
    '<div class="tableWrap"><table>' +
    ['FR1.1', 'US1.1'].map((id) => `<tr class="row" data-go="${id}" title="Open ${id} in Trace"><td class="mono"><button type="button" class="idlink" data-go="${id}">${id}</button></td><td>x</td></tr>`).join('') +
    '</table></div>'
};

// Focus an element and activate it the way a keyboard user would (Enter on a button = click).
function press(w, el) {
  el.focus();
  w.document.dispatch('click', { target: el, preventDefault() {} });
}

test('focus: data-mode chip keeps focus on the same chip after re-render, not <body>', () => {
  const w = runMain({ renderers: FOCUS_VIEWS });
  w.send(setDataMsg(fixture()));
  w.click({ 'data-tab': 'cov' });
  const before = w.view('cov').querySelector('[data-mode="nfr"]');
  press(w, before);
  const now = w.document.activeElement;
  assert.notEqual(now, w.document.body, 'focus must not fall to <body>');
  assert.notEqual(now, before, 'the old chip was replaced');
  assert.equal(now.getAttribute('data-mode'), 'nfr');
  assert.ok(w.view('cov').contains(now));
  assert.equal(now.lastFocusOptions && now.lastFocusOptions.preventScroll, true);
});

test('focus: data-select in the canvas stays in the canvas; in the picker stays in the picker', () => {
  const w = runMain({ renderers: FOCUS_VIEWS });
  w.send(setDataMsg(fixture()));
  const view = w.view('trace');
  press(w, view.querySelector('.canvas').querySelector('[data-select="US1.1"]'));
  let now = w.document.activeElement;
  assert.notEqual(now, w.document.body);
  assert.equal(now.getAttribute('data-select'), 'US1.1');
  assert.ok(view.querySelector('.canvas').contains(now), 'same panel, not the picker button with the same id');
  assert.ok(now.classList.contains('node'));

  press(w, view.querySelector('.picker').querySelector('[data-select="FR1.2"]'));
  now = w.document.activeElement;
  assert.equal(now.getAttribute('data-select'), 'FR1.2');
  assert.ok(view.querySelector('.picker').contains(now));
  assert.ok(now.classList.contains('on'));
});

test('focus: a detail link that disappears falls back to the detail heading', () => {
  const w = runMain({ renderers: FOCUS_VIEWS });
  w.send(setDataMsg(fixture()));
  const view = w.view('trace');
  press(w, view.querySelector('.detail').querySelector('[data-go="US1.1"]'));
  const now = w.document.activeElement;
  assert.notEqual(now, w.document.body);
  assert.equal(now.tagName, 'H3');
  assert.equal(now.getAttribute('tabindex'), '-1');
  assert.ok(view.querySelector('.detail').contains(now));
});

test('focus: data-go from Coverage lands on the selected node in Trace', () => {
  const w = runMain({ renderers: FOCUS_VIEWS });
  w.send(setDataMsg(fixture()));
  w.click({ 'data-tab': 'cov' });
  press(w, w.view('cov').querySelector('button.idlink[data-go="US1.1"]'));
  assert.equal(w.getState().tab, 'trace');
  const now = w.document.activeElement;
  assert.notEqual(now, w.document.body);
  assert.ok(w.view('trace').querySelector('.canvas').contains(now));
  assert.equal(now.getAttribute('data-select'), 'US1.1');
});

test('focus: never stolen when it was not inside the view', () => {
  const w = runMain({ renderers: FOCUS_VIEWS });
  w.send(setDataMsg(fixture()));
  // on a tab button: a data refresh leaves it there
  w.tab('trace').focus();
  w.send(setDataMsg(fixture(), 2, 'refresh'));
  assert.equal(w.document.activeElement, w.tab('trace'));
  // on <body>: a mouse click (no focus) on a chip does not pull focus into the view
  w.click({ 'data-tab': 'cov' });
  w.document.activeElement = w.document.body;
  w.document.dispatch('click', { target: w.view('cov').querySelector('[data-mode="br"]'), preventDefault() {} });
  assert.equal(w.getState().covMode, 'br');
  assert.equal(w.document.activeElement, w.document.body);
});

test('focus: a file-change refresh keeps focus on the focused node', () => {
  const w = runMain({ renderers: FOCUS_VIEWS });
  w.send(setDataMsg(fixture()));
  w.view('trace').querySelector('.canvas').querySelector('[data-select="FR1.2"]').focus();
  w.send(setDataMsg(fixture(), 2, 'file-change'));
  const now = w.document.activeElement;
  assert.equal(now.getAttribute('data-select'), 'FR1.2');
  assert.ok(w.view('trace').querySelector('.canvas').contains(now));
});

test('scroll: canvas, picker list and table keep their scroll position; the focused card stays in view', () => {
  const w = runMain({ renderers: FOCUS_VIEWS });
  w.send(setDataMsg(fixture()));
  const view = w.view('trace');
  view.querySelector('.canvasWrap').scrollLeft = 500; // the user scrolled to the right-hand lane
  view.querySelector('.pickList').scrollTop = 120;
  const card = view.querySelector('.canvas').querySelector('[data-select="US1.1"]'); // x=600: visible at 100..250
  press(w, card);
  const wrap = view.querySelector('.canvasWrap');
  assert.equal(wrap.scrollLeft, 500, 'canvasWrap scrollLeft restored');
  assert.equal(view.querySelector('.pickList').scrollTop, 120, 'picker list scrollTop restored');
  const now = w.document.activeElement;
  assert.equal(now.getAttribute('data-select'), 'US1.1');
  const r = now.getBoundingClientRect();
  const b = wrap.getBoundingClientRect();
  assert.ok(r.left >= b.left && r.right <= b.right, `focused card inside .canvasWrap (${r.left}..${r.right})`);
  assert.equal(w.document.scrolledIntoView || 0, 0, 'no scroll when it was already visible');

  // a card restored outside the visible area is scrolled in, only as far as needed
  wrap.scrollLeft = 0;
  view.querySelector('.canvas').querySelector('[data-select="US1.1"]').focus();
  w.send(setDataMsg(fixture(), 2, 'file-change'));
  const again = w.document.activeElement;
  assert.equal(again.getAttribute('data-select'), 'US1.1');
  assert.deepEqual({ ...again.lastScrollIntoView }, { block: 'nearest', inline: 'nearest' });
  const r2 = again.getBoundingClientRect();
  const b2 = view.querySelector('.canvasWrap').getBoundingClientRect();
  assert.ok(r2.left >= b2.left && r2.right <= b2.right, 'scrolled into view');

  // coverage table
  w.click({ 'data-tab': 'cov' });
  w.view('cov').querySelector('.tableWrap').scrollTop = 300;
  w.send(setDataMsg(fixture(), 3, 'refresh'));
  assert.equal(w.view('cov').querySelector('.tableWrap').scrollTop, 300);
});

test('focus: a refresh keeps focus on the coverage ID button, not the row or the section', () => {
  const w = runMain({ renderers: FOCUS_VIEWS });
  w.send(setDataMsg(fixture()));
  w.click({ 'data-tab': 'cov' });
  w.view('cov').querySelector('button.idlink[data-go="US1.1"]').focus();
  w.send(setDataMsg(fixture(), 2, 'refresh'));
  const now = w.document.activeElement;
  assert.notEqual(now, w.document.body);
  assert.notEqual(now, w.view('cov'), 'not the section');
  assert.equal(now.tagName, 'BUTTON');
  assert.ok(now.classList.contains('idlink'));
  assert.equal(now.getAttribute('data-go'), 'US1.1');
});

// ---------------------------------------------------------------------------
// trace-explorer-panel.js with a stubbed vscode
// ---------------------------------------------------------------------------

// opts.commands: registered command ids (default: the markdown viewer's, as in the extension)
// opts.executeFails: executeCommand rejects
// opts.infoChoice: what the user clicks on an information message (undefined = dismissed)
function loadPanel(opts = {}) {
  const registered = opts.commands || ['markdownWatchViewer.openFile', 'markdownWatchViewer.openInTextEditor'];
  const calls = { created: [], shown: [], warnings: [], panels: [], executed: [], infos: [] };
  const Uri = {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
    joinPath: (b, ...a) => Uri.file(path.join(b.fsPath, ...a))
  };
  const stub = {
    Uri,
    ViewColumn: { One: 1, Beside: -2 },
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    Range: class { constructor(a, b) { this.start = a; this.end = b; } },
    window: {
      createWebviewPanel(viewType, title, column, options) {
        const listeners = { message: [], dispose: [] };
        const panel = {
          viewType, title, column, options, posted: [], revealed: 0, disposed: false,
          webview: {
            html: '',
            cspSource: 'https://*.vscode-cdn.net',
            asWebviewUri: (u) => ({ toString: () => `https://file+.vscode-resource.vscode-cdn.net${u.fsPath}` }),
            postMessage: (m) => { panel.posted.push(m); return Promise.resolve(true); },
            onDidReceiveMessage: (fn) => { listeners.message.push(fn); return { dispose: () => { listeners.message = []; } }; }
          },
          onDidDispose: (fn) => { listeners.dispose.push(fn); return { dispose() {} }; },
          reveal() { panel.revealed += 1; },
          dispose() { if (panel.disposed) return; panel.disposed = true; for (const fn of listeners.dispose) fn(); },
          receive: (m) => listeners.message.map((fn) => fn(m))
        };
        calls.created.push({ viewType, title, column, options });
        calls.panels.push(panel);
        return panel;
      },
      showTextDocument: async (uri, options) => { calls.shown.push({ uri, options }); },
      showWarningMessage: (m) => { calls.warnings.push(m); },
      showInformationMessage: async (m, ...actions) => {
        calls.infos.push({ message: m, actions });
        return typeof opts.infoChoice === 'function' ? opts.infoChoice(actions) : opts.infoChoice;
      }
    },
    commands: {
      getCommands: async () => registered.slice(),
      executeCommand: async (id, ...args) => {
        calls.executed.push({ id, args });
        if (!registered.includes(id)) throw new Error(`command '${id}' not found`);
        if (opts.executeFails) throw new Error('viewer failed');
      }
    }
  };
  const file = require.resolve('../src/trace-explorer-panel');
  delete require.cache[file];
  const realLoad = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (request === 'vscode') return stub;
    return realLoad.call(this, request, ...rest);
  };
  try {
    return { mod: require(file), calls, context: { extensionUri: Uri.file(EXT_ROOT) } };
  } finally {
    Module._load = realLoad;
  }
}

const tick = () => new Promise((r) => setImmediate(r));

test('panel: singleton, strict webview options, CSP html', () => {
  const { mod, calls, context } = loadPanel();
  try {
    const panel = mod.createOrShow(context, { projectRoot: PROJECT_ROOT, intent: INTENT_ID });
    assert.equal(mod.createOrShow(context, { projectRoot: PROJECT_ROOT, intent: INTENT_ID }), panel);
    assert.equal(calls.created.length, 1);
    assert.equal(panel.revealed, 1);
    const o = calls.created[0].options;
    assert.equal(o.enableScripts, true);
    assert.equal(o.retainContextWhenHidden, true);
    assert.ok(!('enableCommandUris' in o) || o.enableCommandUris === false, 'command URIs never enabled');
    assert.equal(o.localResourceRoots.length, 1);
    assert.equal(o.localResourceRoots[0].fsPath, MEDIA);
    assert.equal(calls.created[0].viewType, mod.VIEW_TYPE);
    assert.match(panel.webview.html, /default-src 'none'/);
    assert.doesNotMatch(panel.webview.html, /unsafe-inline/);
    assert.match(panel.webview.html, /src="https:\/\/file\+\.vscode-resource\.vscode-cdn\.net[^"]*\/media\/trace-explorer\/main\.js"/);
    assert.equal(panel.posted.length, 0, 'nothing is posted before ready');
  } finally {
    mod.dispose();
  }
});

test('panel: ready -> setData; refresh increments seq; selection restored after ready', () => {
  const { mod, context } = loadPanel();
  try {
    const panel = mod.createOrShow(context, { projectRoot: PROJECT_ROOT, intent: INTENT_ID });
    panel.receive({ type: 'ready', protocol: 1 });
    assert.equal(panel.posted.length, 1);
    const first = panel.posted[0];
    assert.equal(first.type, 'setData');
    assert.equal(first.reason, 'initial');
    assert.equal(first.seq, 1);
    assert.equal(first.data.nodes.length, fixture().nodes.length);
    assert.ok(P.validateHostMessage(first));

    panel.receive({ type: 'refresh' });
    assert.equal(panel.posted[1].type, 'setData');
    assert.equal(panel.posted[1].reason, 'refresh');
    assert.equal(panel.posted[1].seq, 2);

    panel.receive({ type: 'selectionChanged', nodeId: 'US1.1', tab: 'cov' });
    assert.equal(panel.posted.length, 2, 'selectionChanged gets no reply');
    panel.receive({ type: 'ready' });
    assert.equal(panel.posted[2].type, 'setData');
    assert.deepEqual(panel.posted[3], { type: 'navigateTo', protocol: 1, nodeId: 'US1.1', tab: 'cov' });

    const msg = mod.reload('file-change');
    assert.equal(msg.reason, 'file-change');
    assert.equal(msg.seq, 4);
  } finally {
    mod.dispose();
  }
});

test('panel: openFile opens only the validated real path; junk and unknown types are dropped', async () => {
  const { mod, calls, context } = loadPanel();
  try {
    const panel = mod.createOrShow(context, { projectRoot: PROJECT_ROOT, intent: INTENT_ID });
    panel.receive({ type: 'openFile', path: 'package.json', line: 3, command: 'workbench.action.terminal.new' });
    await tick();
    assert.equal(calls.shown.length, 1);
    assert.equal(calls.shown[0].uri.fsPath, fs.realpathSync(path.join(PROJECT_ROOT, 'package.json')));
    assert.equal(calls.shown[0].options.preview, true);
    assert.equal(calls.shown[0].options.selection.start.line, 2);

    for (const bad of [
      { type: 'openFile', path: '../../etc/passwd' },
      { type: 'openFile', path: '/etc/passwd' },
      { type: 'openFile', path: 'command:workbench.action.terminal.new' },
      { type: 'openFile', path: 'aidlc' },
      { type: 'openFile', path: 'package.json', line: 0 },
      { type: 'openChat', prompt: 'x' },
      { type: 'save', content: 'x' },
      'ready',
      null
    ]) panel.receive(bad);
    await tick();
    assert.equal(calls.shown.length, 1, 'no further files opened');
    assert.equal(panel.posted.length, 0, 'dropped messages get no reply');
  } finally {
    mod.dispose();
  }
});

const MD_REL = 'AGENTS.md';
const MD_ABS = () => fs.realpathSync(path.join(PROJECT_ROOT, MD_REL));
const settle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };

test('panel: markdown opens rendered in the extension viewer (markdownWatchViewer.openFile)', async () => {
  const { mod, calls, context } = loadPanel();
  try {
    assert.equal(mod.MARKDOWN_VIEWER_COMMAND, 'markdownWatchViewer.openFile');
    const panel = mod.createOrShow(context, { projectRoot: PROJECT_ROOT, intent: INTENT_ID });
    panel.receive({ type: 'openFile', path: MD_REL });
    await settle();
    assert.equal(calls.executed.length, 1);
    const { id, args } = calls.executed[0];
    assert.equal(id, 'markdownWatchViewer.openFile');
    assert.equal(args.length, 2);
    assert.equal(args[0].type, 'file', 'the shape WatchController.openFile accepts');
    assert.deepEqual(args[1], { viewColumn: 'beside' }, 'beside the Trace Explorer, no line');
    assert.equal(args[0].resourceUri.fsPath, MD_ABS(), 'the validated real path');
    assert.equal(calls.shown.length, 0, 'not opened as text');
    assert.equal(calls.infos.length, 0, 'no line: no message');
  } finally {
    mod.dispose();
  }
});

test('panel: markdown with a line opens rendered beside, scrolled to that line, with no message', async () => {
  const { mod, calls, context } = loadPanel();
  try {
    const panel = mod.createOrShow(context, { projectRoot: PROJECT_ROOT, intent: INTENT_ID });
    panel.receive({ type: 'openFile', path: MD_REL, line: 37 });
    await settle();
    assert.equal(calls.executed.length, 1);
    const { id, args } = calls.executed[0];
    assert.equal(id, 'markdownWatchViewer.openFile');
    assert.equal(args[0].resourceUri.fsPath, MD_ABS());
    assert.deepEqual(args[1], { viewColumn: 'beside', line: 37 });
    assert.equal(calls.infos.length, 0, 'the viewer scrolls; nothing to offer');
    assert.equal(calls.shown.length, 0, 'not opened as text');
  } finally {
    mod.dispose();
  }
});

test('panel: markdown falls back to the text editor at the line when the viewer is missing or fails', async () => {
  for (const opts of [{ commands: [] }, { executeFails: true }]) {
    const { mod, calls, context } = loadPanel(opts);
    try {
      const panel = mod.createOrShow(context, { projectRoot: PROJECT_ROOT, intent: INTENT_ID });
      panel.receive({ type: 'openFile', path: MD_REL, line: 5 });
      await settle();
      assert.equal(calls.shown.length, 1, JSON.stringify(opts));
      assert.equal(calls.shown[0].uri.fsPath, MD_ABS());
      assert.equal(calls.shown[0].options.selection.start.line, 4);
      assert.equal(calls.infos.length, 0);
    } finally {
      mod.dispose();
    }
  }
});

test('panel: non-markdown files never go to the viewer; rejected paths open nothing', async () => {
  const { mod, calls, context } = loadPanel();
  try {
    const panel = mod.createOrShow(context, { projectRoot: PROJECT_ROOT, intent: INTENT_ID });
    panel.receive({ type: 'openFile', path: 'package.json', line: 2 });
    panel.receive({ type: 'openFile', path: '../../etc/passwd.md' });
    panel.receive({ type: 'openFile', path: 'missing-file.md' });
    await settle();
    assert.equal(calls.executed.length, 0);
    assert.equal(calls.shown.length, 1);
    assert.equal(calls.shown[0].uri.fsPath, fs.realpathSync(path.join(PROJECT_ROOT, 'package.json')));
    assert.equal(calls.shown[0].options.selection.start.line, 1);
  } finally {
    mod.dispose();
  }
});

test('panel: no project or no intent -> dataError no-project', () => {
  const { mod, context } = loadPanel();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-empty-'));
  try {
    const panel = mod.createOrShow(context, {});
    panel.receive({ type: 'ready' });
    assert.equal(panel.posted[0].type, 'dataError');
    assert.equal(panel.posted[0].code, 'no-project');

    mod.createOrShow(context, { projectRoot: empty });
    const last = panel.posted[panel.posted.length - 1];
    assert.equal(last.type, 'dataError');
    assert.equal(last.code, 'no-project');
    assert.ok(P.validateHostMessage(last));
  } finally {
    mod.dispose();
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('panel: dispose clears the singleton and pending reloads', async () => {
  const { mod, calls, context } = loadPanel();
  const panel = mod.createOrShow(context, { projectRoot: PROJECT_ROOT });
  assert.equal(mod.isOpen(), true);
  assert.equal(mod.scheduleReload('file-change', 5), true);
  mod.dispose();
  assert.equal(panel.disposed, true);
  assert.equal(mod.isOpen(), false);
  assert.equal(mod.reload('refresh'), null);
  assert.equal(mod.scheduleReload('file-change'), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(panel.posted.length, 0, 'the scheduled reload never ran');
  // a new panel can be created after dispose
  mod.createOrShow(context, { projectRoot: PROJECT_ROOT });
  assert.equal(calls.created.length, 2);
  mod.dispose();
});

test('panel: scheduleReload debounces several changes into one read', async () => {
  const { mod, context } = loadPanel();
  try {
    const panel = mod.createOrShow(context, { projectRoot: PROJECT_ROOT, intent: INTENT_ID });
    mod.scheduleReload('file-change', 10);
    mod.scheduleReload('file-change', 10);
    mod.scheduleReload('file-change', 10);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(panel.posted.length, 1);
    assert.equal(panel.posted[0].reason, 'file-change');
  } finally {
    mod.dispose();
  }
});

test('only extension.js and trace-explorer-panel.js require vscode among Trace Explorer files', () => {
  for (const f of ['src/trace-explorer-html.js', 'src/trace-explorer-protocol.js', 'src/aidlc/trace-data.js', 'tools/trace-preview.js', 'media/trace-explorer/main.js']) {
    const src = fs.readFileSync(path.join(EXT_ROOT, f), 'utf8');
    assert.doesNotMatch(src, /require\(\s*['"]vscode['"]\s*\)/, f);
  }
  const panelSrc = fs.readFileSync(path.join(EXT_ROOT, 'src', 'trace-explorer-panel.js'), 'utf8');
  assert.doesNotMatch(panelSrc, /enableCommandUris\s*:/);
  assert.doesNotMatch(panelSrc, /createTerminal|writeFile|child_process/);
  // The one command the panel runs is the extension's own markdown viewer, by constant.
  const exec = [...panelSrc.matchAll(/executeCommand\(([^,)]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(exec, ['MARKDOWN_VIEWER_COMMAND']);
  assert.match(panelSrc, /const MARKDOWN_VIEWER_COMMAND = 'markdownWatchViewer\.openFile';/);
});

// ---------------------------------------------------------------------------
// tools/trace-preview.js
// ---------------------------------------------------------------------------

test('trace-preview writes a standalone page for the inventory-api fixture', () => {
  const { buildPreview } = require('../tools/trace-preview');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-preview-'));
  try {
    const out = path.join(dir, 'preview.html');
    const r = buildPreview(PROJECT_ROOT, { outFile: out, intent: INTENT_ID });
    assert.equal(r.outFile, out);
    assert.equal(r.ok, true);
    assert.equal(r.nodes, fixture().nodes.length);
    const html = fs.readFileSync(out, 'utf8');
    assert.match(html, /<body class="vscode-light">/);
    assert.doesNotMatch(html, /\sstyle\s*=|unsafe-inline/);
    // assets resolve, relative to the output file, to the real media files
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(refs.length, SCRIPT_ORDER.length + 1);
    for (const ref of refs) {
      assert.doesNotMatch(ref, /^[a-z]+:/, 'relative reference');
      const abs = path.resolve(dir, decodeURIComponent(ref));
      assert.ok(abs.startsWith(MEDIA + path.sep), abs);
    }
    assert.ok(fs.existsSync(path.resolve(dir, decodeURIComponent(refs.find((r2) => r2.endsWith('main.js'))))));
    // the data is embedded inside a nonce'd boot script, with "<" escaped
    const boot = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
    assert.doesNotMatch(boot, /<\/?script/i);
    assert.match(boot, /"type":"setData"/);

    // run the boot script and main.js together: ready is answered with setData
    const document = fakeDocument(html);
    const queued = [];
    const listeners = [];
    const sandbox = {
      document, console: { log() {} }, location: { search: '' },
      setTimeout: (fn) => queued.push(fn),
      addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
      postMessage: (data) => listeners.forEach((fn) => fn({ data }))
    };
    const setProps = {};
    document.documentElement = { style: { setProperty: (k, v) => { setProps[k] = v; } } };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(boot, sandbox);
    vm.runInContext(fs.readFileSync(MAIN_JS, 'utf8'), sandbox);
    queued.forEach((fn) => fn());
    assert.match(document.getElementById('te-stats').textContent, /^216 items/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trace-preview themes: each sets its body class and every --vscode-* variable the CSS reads', () => {
  const { buildPreview, THEMES } = require('../tools/trace-preview');
  const css = fs.readFileSync(path.join(MEDIA, 'trace-explorer.css'), 'utf8');
  const used = [...new Set(css.match(/--vscode-[A-Za-z][\w.-]*/g))];
  const hcOnly = new Set(['--vscode-contrastBorder', '--vscode-contrastActiveBorder']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-preview-theme-'));
  try {
    const out = path.join(dir, 'p.html');
    buildPreview(PROJECT_ROOT, { outFile: out, intent: INTENT_ID });
    const boot = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(fs.readFileSync(out, 'utf8'))[1];
    const expected = { '': 'vscode-light', '?theme=light': 'vscode-light', '?theme=dark': 'vscode-dark', '?theme=hc': 'vscode-high-contrast', '?theme=hc-light': 'vscode-high-contrast-light' };
    for (const [search, bodyClass] of Object.entries(expected)) {
      const props = {};
      const sandbox = {
        location: { search },
        document: { body: { className: '' }, documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } } }
      };
      sandbox.self = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(boot, sandbox);
      assert.equal(sandbox.document.body.className, bodyClass, search);
      const isHc = /high-contrast/.test(bodyClass);
      for (const v of used) {
        if (hcOnly.has(v) && !isHc) continue;
        assert.ok(typeof props[v] === 'string' && props[v] !== '', `${search || '(default)'} sets ${v}`);
      }
    }
    // the dark and light palettes really differ
    assert.notEqual(THEMES.dark.vars['--vscode-editor-background'], THEMES.light.vars['--vscode-editor-background']);
    assert.notEqual(THEMES.hc.vars['--vscode-contrastBorder'], undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trace-preview CLI prints usage without arguments', () => {
  const { main } = require('../tools/trace-preview');
  const orig = console.error;
  let said = '';
  console.error = (m) => { said += m; };
  try {
    assert.equal(main([]), 2);
  } finally {
    console.error = orig;
  }
  assert.match(said, /usage: node tools\/trace-preview\.js/);
});
