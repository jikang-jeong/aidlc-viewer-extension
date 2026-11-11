'use strict';

// The viewer renders Markdown with markdown-it, loaded from the bundles in media/. This
// file pins what the hand-written regex renderer it replaced got wrong, found by
// rendering 423 real AI-DLC artifacts both ways (docs/v2-support.md, "The viewer renders
// with markdown-it"): 52% came out as structurally invalid HTML. Each case below is one
// of those defect classes, written as the construct an agent actually produced.
//
// The renderer functions are taken out of the webview script and run against the real
// bundles, so the thing tested is the thing shipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const EXTENSION = path.join(ROOT, 'src', 'extension.js');
const MEDIA = path.join(ROOT, 'media');

function loadRenderer() {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return {
        Uri: { file: (p) => ({ fsPath: p, toString: () => p }), joinPath: (...a) => ({ fsPath: a.join('/'), toString: () => a.join('/') }) },
        window: {}, workspace: { fs: {} }, commands: {},
        EventEmitter: class { constructor() { this.event = () => {}; this.fire = () => {}; } },
        TreeItem: class {}, TreeItemCollapsibleState: {}, ThemeIcon: class {}, ThemeColor: class {},
        MarkdownString: class {}, FileType: {}, RelativePattern: class {}, ProgressLocation: {}
      };
    }
    return realLoad(request, parent, isMain);
  };
  let getWebviewHtml;
  try {
    const loaded = new Module(EXTENSION);
    loaded.filename = EXTENSION;
    loaded.paths = Module._nodeModulePaths(path.dirname(EXTENSION));
    loaded._compile(`${fs.readFileSync(EXTENSION, 'utf8')}\nmodule.exports = { getWebviewHtml };`, EXTENSION);
    getWebviewHtml = loaded.exports.getWebviewHtml;
  } finally {
    Module._load = realLoad;
  }
  const html = getWebviewHtml({ cspSource: 'x', asWebviewUri: (u) => ({ toString: () => String(u) }) }, { fsPath: '/p/doc.md' }, '', { fsPath: '/ext' }, undefined);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  // Only the renderer: from markdownRenderer() through escapeHtml().
  const start = script.indexOf('      function markdownRenderer()');
  const end = script.indexOf('      function escapeHtml(value)');
  const endOfEscape = script.indexOf('\n      }\n', end) + '\n      }\n'.length;
  assert.ok(start > 0 && end > start, 'renderer functions found in the webview script');
  const rendererSource = script.slice(start, endOfEscape);

  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const f of ['markdown-it.min.js', 'markdown-it-task-lists.min.js']) {
    vm.runInContext(fs.readFileSync(path.join(MEDIA, f), 'utf8'), sandbox);
  }
  sandbox.window.markdownit = sandbox.window.markdownit || sandbox.markdownit;
  sandbox.window.markdownitTaskLists = sandbox.window.markdownitTaskLists || sandbox.markdownitTaskLists;
  vm.runInContext(rendererSource + '\nthis.render = markdownToHtml;', sandbox);
  return sandbox.render;
}

const render = loadRenderer();
const count = (html, re) => (html.match(re) || []).length;

test('a fenced code block is not wrapped in a paragraph', () => {
  // The dominant defect: 42% of artifacts. The placeholder for a fence was caught by
  // the paragraph rule, so every code block came out as <p><pre>..</pre></p>.
  const html = render('Intro.\n\n```js\nconst a = 1;\n```\n\nAfter.\n');
  assert.doesNotMatch(html, /<p>\s*<pre/);
  assert.match(html, /<pre><code class="language-js">const a = 1;\n<\/code><\/pre>/);
});

test('a hard-wrapped paragraph is one paragraph', () => {
  const html = render('This is one sentence\nthat continues on the next line.\n');
  assert.equal(count(html, /<p>/g), 1);
});

test('a nested list nests', () => {
  // Was: child items outside any list, grandchildren inside a <p>.
  const html = render('- parent\n  - child\n    - grandchild\n- parent 2\n');
  assert.doesNotMatch(html, /<\/ul>\s*<li>/);
  assert.doesNotMatch(html, /<p>\s*<li/);
  assert.match(html, /<li>parent\s*<ul>\s*<li>child\s*<ul>\s*<li>grandchild<\/li>/);
});

test('a list item whose text wraps onto an indented line stays one item', () => {
  // Agents hard-wrap at ~80 columns inside list items; the continuation was dropped
  // out of the list as a bare line.
  const html = render('- **Ordering**: implement each layer first,\n  then write the tests for that layer.\n- second\n');
  assert.equal(count(html, /<li>/g), 2);
  assert.match(html, /<li><strong>Ordering<\/strong>: implement each layer first,\nthen write the tests for that layer\.<\/li>/);
});

test('a multi-line blockquote is one blockquote', () => {
  const html = render('> line one\n> line two\n');
  assert.equal(count(html, /<blockquote>/g), 1);
});

test('a table with alignment colons in its separator keeps its rows', () => {
  // Was: header rendered, every body row fell out as <p>| 1 | 2 |</p>.
  const html = render('| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n');
  assert.equal(count(html, /<tr>/g), 3);
  assert.match(html, /<td style="text-align:right">2<\/td>/);
});

test('an identifier with underscores is not italicised', () => {
  const html = render('Use snake_case_name and another_one here.\n');
  assert.doesNotMatch(html, /<em>/);
});

test('an ordered list keeps its start number', () => {
  const html = render('3. three\n4. four\n');
  assert.match(html, /<ol start="3">/);
});

test('a task list renders disabled checkboxes', () => {
  const html = render('- [ ] open\n- [x] done\n');
  assert.equal(count(html, /<input class="task-list-item-checkbox"[^>]*disabled/g), 2);
  assert.equal(count(html, /checked/g), 1);
});

test('a mermaid fence is kept as the diagram source for the mermaid hook', () => {
  const html = render('```mermaid\ngraph TD\n  A --> B\n```\n');
  assert.match(html, /<pre class="mermaid">graph TD\n  A --> B<\/pre>/);
  assert.doesNotMatch(html, /language-mermaid/);
});

test('HTML comments render dimmed and escaped, but not inside code', () => {
  const html = render('Body <!-- note --> text.\n\n```\n<!-- in a fence -->\n```\n\nAnd `<!-- in a span -->` too.\n');
  assert.match(html, /Body <span class="md-comment">&lt;!-- note --&gt;<\/span> text\./);
  assert.match(html, /<pre><code>&lt;!-- in a fence --&gt;\n<\/code><\/pre>/, 'a comment in a fence is code');
  assert.match(html, /<code>&lt;!-- in a span --&gt;<\/code>/, 'a comment in a code span is code');
  assert.equal(count(html, /md-comment/g), 1);
});

test('a comment spanning lines is one dimmed comment', () => {
  const html = render('<!-- line one\nline two -->\n\nAfter.\n');
  assert.equal(count(html, /md-comment/g), 1);
  assert.match(html, /&lt;!-- line one\nline two --&gt;/);
});

test('raw HTML in the source is text, not markup', () => {
  const html = render('A <b>tag</b> and <script>alert(1)</script> here.\n');
  assert.doesNotMatch(html, /<b>|<script>/);
  assert.match(html, /&lt;b&gt;tag&lt;\/b&gt;/);
});

test('only http(s), mailto, fragment and relative links become links', () => {
  const html = render('[ok](https://example.com) [rel](docs/a.md) [frag](#x) [mail](mailto:a@b.c) [bad](javascript:alert(1)) [odd](vscode://x)\n');
  assert.equal(count(html, /<a href=/g), 4);
  assert.doesNotMatch(html, /href="javascript:|href="vscode:/);
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/, 'a refused link is shown as the text it was');
});

test('bare URLs are linked', () => {
  const html = render('See https://example.com/path for more.\n');
  assert.match(html, /<a href="https:\/\/example\.com\/path">https:\/\/example\.com\/path<\/a>/);
});

// ---------------------------------------------------------------------------
// The real artifacts: none of the old defect shapes may appear
// ---------------------------------------------------------------------------

const SAMPLES = ['v2-probe', 'v2-probe2', 'v2-probe3', 'v2-test', 'v2-brownfield-wordbook'].map((d) => path.join('/Users/jikjeong/Develop/aidlc', d));
const samplesPresent = SAMPLES.every((d) => fs.existsSync(d));

test('every artifact in the five samples renders without the old structural defects', { skip: !samplesPresent && 'samples not on this machine' }, () => {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['.git', 'node_modules', 'audit', 'memory', 'active-memory', 'build', '.kiro'].includes(e.name)) walk(p); }
      else if (e.name.endsWith('.md') && p.includes('/aidlc/')) files.push(p);
    }
  })(SAMPLES[0].replace(/[^/]+$/, ''));
  assert.ok(files.length > 300, `expected the corpus, found ${files.length} files`);
  const bad = [];
  for (const f of files) {
    const html = render(fs.readFileSync(f, 'utf8'));
    if (/<\/(ul|ol)>\s*<li>/.test(html) || /<p>\s*<(pre|table|ul|ol|li)\b/.test(html) || /<p>\|.*\|<\/p>/.test(html)) bad.push(f);
  }
  assert.deepEqual(bad, []);
});
