#!/usr/bin/env node
'use strict';

// Standalone browser preview of the Trace Explorer panel.
//
//   node tools/trace-preview.js <projectRoot> [out.html] [--intent <id>]
//
// Reads the project with the same readTraceData the panel uses, and writes one HTML file
// built by the same buildHtml. The data is embedded; the stylesheet and scripts are
// referenced by relative path into media/trace-explorer/, so edits to a view show up on
// browser reload without re-running this tool (re-run it to refresh the data).
//
// A small inline boot script (nonce'd, preview only) stands in for the extension host: it
// defines acquireVsCodeApi() so main.js runs unchanged, answers `ready` with `setData`,
// and logs openFile / refresh to the console instead of acting on them. The body gets
// a theme class and a representative set of --vscode-* variables (set on <html> through
// the CSSOM, as VS Code does; the CSP blocks style="" markup, not CSSOM), so the page looks
// the way it does in the editor. Pick the theme with ?theme=light (default), dark, hc or
// hc-light in the URL.
//
// Default output: <os.tmpdir()>/trace-explorer-preview.html.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { readTraceData } = require('../src/aidlc/trace-data');
const { buildHtml, makeNonce, SCRIPT_ORDER } = require('../src/trace-explorer-html');
const P = require('../src/trace-explorer-protocol');

const MEDIA = path.resolve(__dirname, '..', 'media', 'trace-explorer');

function assetRef(outDir, file) {
  const rel = path.relative(outDir, file);
  // Different drive (win32) or otherwise not relative: fall back to an absolute file URL.
  if (!rel || path.isAbsolute(rel)) return pathToFileURL(file).href;
  return rel.split(path.sep).map(encodeURIComponent).join('/');
}

// JSON inside a <script>: escape "<" so "</script>" or "<!--" in project text cannot end it.
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// Approximations of VS Code's default themes (Light+, Dark+, High Contrast, High Contrast
// Light), limited to the variables trace-explorer.css reads. Not exact; enough to check
// contrast, tints and the high-contrast border rules in a browser.
const FONTS = {
  '--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--vscode-editor-font-family': 'Menlo, Monaco, Consolas, "Courier New", monospace'
};
const THEMES = Object.freeze({
  light: { bodyClass: 'vscode-light', vars: { ...FONTS,
    '--vscode-editor-background': '#FFFFFF', '--vscode-editorWidget-background': '#F3F3F3',
    '--vscode-foreground': '#3B3B3B', '--vscode-editor-foreground': '#3B3B3B', '--vscode-descriptionForeground': '#717171',
    '--vscode-panel-border': '#E5E5E5', '--vscode-widget-border': '#C8C8C8',
    '--vscode-charts-purple': '#652D90', '--vscode-charts-green': '#388A34', '--vscode-charts-red': '#E51400',
    '--vscode-editorWarning-foreground': '#BF8803', '--vscode-terminal-ansiCyan': '#0598BC',
    '--vscode-textLink-foreground': '#006AB1', '--vscode-textLink-activeForeground': '#006AB1',
    '--vscode-focusBorder': '#0090F1', '--vscode-list-hoverBackground': '#E8E8E8',
    '--vscode-input-background': '#FFFFFF', '--vscode-input-foreground': '#3B3B3B',
    '--vscode-input-border': '#CECECE', '--vscode-input-placeholderForeground': '#767676',
    '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.16)' } },
  dark: { bodyClass: 'vscode-dark', vars: { ...FONTS,
    '--vscode-editor-background': '#1E1E1E', '--vscode-editorWidget-background': '#252526',
    '--vscode-foreground': '#CCCCCC', '--vscode-editor-foreground': '#D4D4D4', '--vscode-descriptionForeground': 'rgba(204, 204, 204, 0.7)',
    '--vscode-panel-border': 'rgba(128, 128, 128, 0.35)', '--vscode-widget-border': '#303031',
    '--vscode-charts-purple': '#B180D7', '--vscode-charts-green': '#89D185', '--vscode-charts-red': '#F14C4C',
    '--vscode-editorWarning-foreground': '#CCA700', '--vscode-terminal-ansiCyan': '#11A8CD',
    '--vscode-textLink-foreground': '#3794FF', '--vscode-textLink-activeForeground': '#3794FF',
    '--vscode-focusBorder': '#007FD4', '--vscode-list-hoverBackground': '#2A2D2E',
    '--vscode-input-background': '#3C3C3C', '--vscode-input-foreground': '#CCCCCC',
    '--vscode-input-border': '#3C3C3C', '--vscode-input-placeholderForeground': '#A6A6A6',
    '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.36)' } },
  hc: { bodyClass: 'vscode-high-contrast', vars: { ...FONTS,
    '--vscode-editor-background': '#000000', '--vscode-editorWidget-background': '#0C141F',
    '--vscode-foreground': '#FFFFFF', '--vscode-editor-foreground': '#FFFFFF', '--vscode-descriptionForeground': 'rgba(255, 255, 255, 0.7)',
    '--vscode-panel-border': '#6FC3DF', '--vscode-widget-border': '#6FC3DF',
    '--vscode-contrastBorder': '#6FC3DF', '--vscode-contrastActiveBorder': '#F38518',
    '--vscode-charts-purple': '#B180D7', '--vscode-charts-green': '#89D185', '--vscode-charts-red': '#F14C4C',
    '--vscode-editorWarning-foreground': '#FFD370', '--vscode-terminal-ansiCyan': '#00CDCD',
    '--vscode-textLink-foreground': '#21A6FF', '--vscode-textLink-activeForeground': '#21A6FF',
    '--vscode-focusBorder': '#F38518', '--vscode-list-hoverBackground': 'transparent',
    '--vscode-input-background': '#000000', '--vscode-input-foreground': '#FFFFFF',
    '--vscode-input-border': '#6FC3DF', '--vscode-input-placeholderForeground': 'rgba(255, 255, 255, 0.7)',
    '--vscode-widget-shadow': 'transparent' } },
  'hc-light': { bodyClass: 'vscode-high-contrast-light', vars: { ...FONTS,
    '--vscode-editor-background': '#FFFFFF', '--vscode-editorWidget-background': '#FFFFFF',
    '--vscode-foreground': '#292929', '--vscode-editor-foreground': '#292929', '--vscode-descriptionForeground': 'rgba(41, 41, 41, 0.7)',
    '--vscode-panel-border': '#0F4A85', '--vscode-widget-border': '#0F4A85',
    '--vscode-contrastBorder': '#0F4A85', '--vscode-contrastActiveBorder': '#006BBD',
    '--vscode-charts-purple': '#652D90', '--vscode-charts-green': '#374E06', '--vscode-charts-red': '#B5200D',
    '--vscode-editorWarning-foreground': '#895503', '--vscode-terminal-ansiCyan': '#0F4A85',
    '--vscode-textLink-foreground': '#0F4A85', '--vscode-textLink-activeForeground': '#0F4A85',
    '--vscode-focusBorder': '#006BBD', '--vscode-list-hoverBackground': 'transparent',
    '--vscode-input-background': '#FFFFFF', '--vscode-input-foreground': '#292929',
    '--vscode-input-border': '#0F4A85', '--vscode-input-placeholderForeground': 'rgba(41, 41, 41, 0.7)',
    '--vscode-widget-shadow': 'transparent' } }
});

function bootScript(message) {
  return `(function () {
  var MESSAGE = ${scriptJson(message)};
  var THEMES = ${scriptJson(THEMES)};
  var m = /[?&]theme=(light|dark|hc-light|hc)(?:&|$)/.exec(location.search);
  var theme = THEMES[m ? m[1] : 'light'];
  document.body.className = theme.bodyClass;
  var rootStyle = document.documentElement.style;
  for (var k in theme.vars) rootStyle.setProperty(k, theme.vars[k]);
  var stored;
  self.acquireVsCodeApi = function () {
    return {
      getState: function () { return stored; },
      setState: function (s) { stored = s; },
      postMessage: function (msg) {
        if (msg && (msg.type === ${JSON.stringify(P.TO_HOST.READY)} || msg.type === ${JSON.stringify(P.TO_HOST.REFRESH)})) {
          setTimeout(function () { self.postMessage(MESSAGE, '*'); }, 0);
        } else {
          console.log('[trace-preview] host would receive', msg);
        }
      }
    };
  };
})();`;
}

function buildPreview(projectRoot, { outFile, intent } = {}) {
  const root = path.resolve(projectRoot);
  const out = path.resolve(outFile || path.join(os.tmpdir(), 'trace-explorer-preview.html'));
  const outDir = path.dirname(out);
  const data = readTraceData(root, intent ? { intent } : {});
  const built = P.buildSetDataMessage(data, { seq: 1, reason: 'initial' });
  const scriptUris = {};
  for (const rel of SCRIPT_ORDER) scriptUris[rel] = assetRef(outDir, path.join(MEDIA, ...rel.split('/')));
  const html = buildHtml({
    cspSource: "file: 'self'",
    nonce: makeNonce(),
    cssUri: assetRef(outDir, path.join(MEDIA, 'trace-explorer.css')),
    scriptUris,
    title: `Trace Explorer preview - ${data.meta && data.meta.intent ? data.meta.intent : path.basename(root)}`,
    bodyClass: 'vscode-light',
    bootScript: bootScript(built.message)
  });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(out, html);
  return { outFile: out, ok: built.ok, bytes: built.bytes, nodes: data.nodes.length, edges: data.edges.length, warnings: (data.meta && data.meta.warnings) || [] };
}

function main(argv) {
  const args = argv.slice();
  let intent;
  const i = args.indexOf('--intent');
  if (i !== -1) {
    intent = args[i + 1];
    args.splice(i, 2);
  }
  const [projectRoot, outFile] = args;
  if (!projectRoot) {
    console.error('usage: node tools/trace-preview.js <projectRoot> [out.html] [--intent <id>]');
    return 2;
  }
  const r = buildPreview(projectRoot, { outFile, intent });
  console.log(`wrote ${r.outFile}`);
  console.log(`  ${r.nodes} nodes, ${r.edges} edges, ${r.warnings.length} warnings${r.ok ? '' : ' (data error: see the page banner)'}`);
  console.log(`  open: ${pathToFileURL(r.outFile).href}  (add ?theme=dark, ?theme=hc or ?theme=hc-light)`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { buildPreview, main, THEMES };
