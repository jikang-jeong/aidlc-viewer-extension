'use strict';

// The Trace Explorer page shell, as a pure function of its inputs.
//
// No vscode here: the panel (trace-explorer-panel.js) passes in the webview's cspSource and
// the asWebviewUri()-converted asset URLs, and tools/trace-preview.js passes relative file
// paths, so the same markup is tested under node --test, shown in VS Code and opened in a
// browser.
//
// THE CSP
//
// Copied from the strict pattern in credits-page.js, tightened for a page that does run
// script: nothing is allowed by default; the stylesheet comes from the extension
// (cspSource); every script must carry this render's nonce; images only from the extension
// or data: URIs. There is no 'unsafe-inline' anywhere, so a style="" or onclick="" that
// slips into a view's HTML is dropped by the webview instead of running. The page itself
// has neither: all wiring is in main.js through event delegation on data-* attributes.
//
// THE TABS
//
// One button per protocol tab (trace, cov, rev, about), with the WAI-ARIA tab pattern:
// role=tablist / tab / tabpanel, aria-selected, aria-controls, roving tabindex. Each tab
// panel is an empty <section> that main.js fills with the view's HTML. Only the first is
// visible until main.js says otherwise.

const { TABS } = require('./trace-explorer-protocol');

const TAB_LABELS = Object.freeze({
  trace: 'Trace',
  cov: 'Coverage',
  rev: 'Reviews and rework',
  about: 'About'
});

// Load order matters: lib/graph.js defines AidlcTrace.buildIndexes and helpers the views
// use; each view adds its renderX to AidlcTrace; main.js runs last and wires everything.
const SCRIPT_ORDER = Object.freeze([
  'lib/graph.js',
  'views/trace-view.js',
  'views/coverage-view.js',
  'views/reviews-view.js',
  'views/about-view.js',
  'main.js'
]);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// A CSP source list is space-separated tokens; refuse anything that could close the
// attribute or add a directive.
function cleanSource(value) {
  const s = String(value ?? '').trim();
  if (!s || /[;"'<>\r\n]/.test(s.replace(/'self'/g, ''))) throw new TypeError('cspSource is not a plain CSP source list');
  return s;
}

function buildCsp(cspSource, nonce) {
  return [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');
}

// scriptUris: either an array in SCRIPT_ORDER order, or an object keyed by the relative
// names in SCRIPT_ORDER. Missing entries are skipped (the page still works: main.js shows a
// placeholder for any tab whose renderer is absent), but main.js is required.
function orderedScripts(scriptUris) {
  if (Array.isArray(scriptUris)) return scriptUris.map(String);
  if (scriptUris && typeof scriptUris === 'object') {
    return SCRIPT_ORDER.filter((k) => scriptUris[k] != null).map((k) => String(scriptUris[k]));
  }
  throw new TypeError('scriptUris must be an array or an object keyed by SCRIPT_ORDER names');
}

/**
 * @param {object} o
 * @param {string} o.cspSource   webview.cspSource (preview: "file: 'self'")
 * @param {string} o.nonce       fresh per render; [A-Za-z0-9]+
 * @param {string} o.cssUri      URL of trace-explorer.css
 * @param {string[]|object} o.scriptUris  URLs in SCRIPT_ORDER order, or keyed by SCRIPT_ORDER name
 * @param {string} [o.title]     panel/page title
 * @param {string} [o.bodyClass] extra body class (preview: 'vscode-light'; VS Code adds its own)
 * @param {string} [o.bootScript] inline script run before the others, with the nonce.
 *        Only tools/trace-preview.js uses it (to stand in for the extension host); the panel
 *        never passes it.
 * @returns {string} the HTML document
 */
function buildHtml({ cspSource, nonce, cssUri, scriptUris, title = 'Trace Explorer', bodyClass = '', bootScript } = {}) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) throw new TypeError('nonce must be 16+ base64/alnum characters');
  const src = cleanSource(cspSource);
  if (typeof cssUri !== 'string' || cssUri === '') throw new TypeError('cssUri is required');
  const scripts = orderedScripts(scriptUris);
  if (scripts.length === 0) throw new TypeError('at least main.js is required');

  const tabs = TABS.map((key, i) => {
    const active = i === 0;
    return `<button type="button" class="tab${active ? ' active' : ''}" role="tab" id="tab-${key}" data-tab="${key}" aria-controls="view-${key}" aria-selected="${active}" tabindex="${active ? 0 : -1}">${escapeHtml(TAB_LABELS[key] || key)}</button>`;
  }).join('\n    ');

  const views = TABS.map((key, i) => {
    const active = i === 0;
    return `<section class="view${active ? ' active' : ''}" id="view-${key}" role="tabpanel" aria-labelledby="tab-${key}" tabindex="0"${active ? '' : ' hidden'}></section>`;
  }).join('\n  ');

  const boot = typeof bootScript === 'string' && bootScript !== ''
    ? `\n<script nonce="${nonce}">${bootScript.replace(/<\/(script)/gi, '<\\/$1')}</script>`
    : '';
  const scriptTags = scripts.map((u) => `<script nonce="${nonce}" src="${escapeHtml(u)}"></script>`).join('\n');
  const cls = String(bodyClass || '').replace(/[^A-Za-z0-9 _-]/g, '').trim();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(src, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeHtml(cssUri)}">
</head>
<body${cls ? ` class="${cls}"` : ''}>
<div class="wrap">
  <header>
    <p class="kicker">AI-DLC Trace Explorer</p>
    <h1><span id="te-title">Trace Explorer</span> <span class="accent">from requirement to code</span></h1>
    <p class="sub"><span id="te-intent"></span> <span id="te-stats"></span>
      <button type="button" class="chipBtn" data-action="refresh" title="Read the project again">Refresh</button></p>
    <p class="stamp"><span class="dot"></span><span id="te-stamp">A derivative view of the AI-DLC records. The artifacts stay the source of truth.</span></p>
  </header>
  <div id="te-banner" class="banner" role="status" aria-live="polite">Loading trace data…</div>
  <div class="tabs" role="tablist" aria-label="Trace Explorer views">
    ${tabs}
  </div>
  ${views}
</div>${boot}
${scriptTags}
</body>
</html>`;
}

module.exports = { buildHtml, buildCsp, makeNonce, escapeHtml, SCRIPT_ORDER, TAB_LABELS };
