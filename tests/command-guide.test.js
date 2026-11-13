'use strict';

// The /aidlc guide on the Start page. Pins that the scope rows are READ from the
// project's engine files and counted the way `aidlc --help` counts, that the page
// carries the guide under "What was set up" on v2 only, and that nothing in it relies on
// an inline style the page's CSP would drop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guide = require('../src/aidlc/command-guide');
const page = require('../src/credits-page');

// A project the way `aidlc config` leaves it: a stage graph with an initialization
// phase, a scope grid, and a scope file per scope with frontmatter.
function configuredProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-guide-'));
  const write = (rel, contents) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
  };
  write('.kiro/agents/aidlc-aidlc.md', '---\nname: aidlc\n---\n');
  write('.kiro/tools/data/stage-graph.json', [
    { slug: 'workspace-scaffold', name: 'Workspace Scaffold', phase: 'initialization', execution: 'ALWAYS' },
    { slug: 'state-init', name: 'State Init', phase: 'initialization', execution: 'ALWAYS' },
    { slug: 'intent-capture', name: 'Intent Capture', phase: 'ideation', execution: 'ALWAYS' },
    { slug: 'requirements-analysis', name: 'Requirements Analysis', phase: 'inception', execution: 'ALWAYS' },
    { slug: 'code-generation', name: 'Code Generation', phase: 'construction', execution: 'ALWAYS' },
    { slug: 'build-and-test', name: 'Build and Test', phase: 'construction', execution: 'ALWAYS' }
  ]);
  write('.kiro/tools/data/scope-grid.json', {
    // 2 of 4 counted stages (initialization excluded, as the engine's help excludes it).
    tiny: { stages: { 'workspace-scaffold': 'EXECUTE', 'state-init': 'EXECUTE', 'intent-capture': 'SKIP', 'requirements-analysis': 'EXECUTE', 'code-generation': 'EXECUTE', 'build-and-test': 'SKIP' } },
    full: { stages: { 'workspace-scaffold': 'EXECUTE', 'state-init': 'EXECUTE', 'intent-capture': 'EXECUTE', 'requirements-analysis': 'EXECUTE', 'code-generation': 'EXECUTE', 'build-and-test': 'EXECUTE' } }
  });
  write('.kiro/scopes/aidlc-tiny.md', '---\nname: tiny\ndepth: Minimal\ntestStrategy: Minimal\nkeywords:\n  - quick\ndescription: "A quick one"\nguard_policy: off\nplan_approval: off\n---\n# tiny\n');
  write('.kiro/scopes/aidlc-full.md', '---\nname: full\ndepth: Comprehensive\nkeywords: []\ndescription: Everything\nguard_policy: strict\n---\n# full\n');
  return root;
}

test('scope rows are read from the project and counted without the Initialization stages', () => {
  const rows = guide.readScopeCatalogue(configuredProject());
  assert.deepEqual(rows.map((r) => [r.name, r.run, r.total]), [['tiny', 2, 4], ['full', 4, 4]], 'lightest first; 2 of 4, not 4 of 6');
  const tiny = rows.find((r) => r.name === 'tiny');
  assert.equal(tiny.description, 'A quick one', 'quotes stripped');
  assert.equal(tiny.depth, 'minimal');
  assert.equal(tiny.testStrategy, 'minimal');
  assert.equal(tiny.planApproval, 'off');
  assert.equal(rows.find((r) => r.name === 'full').guardPolicy, 'strict');
});

test('a project without the engine files yields no rows, and the guide says where the list is', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-guide-empty-'));
  assert.deepEqual(guide.readScopeCatalogue(empty), []);
  const html = guide.renderCommandGuide({ root: empty });
  assert.match(html, /\/aidlc --help/);
  assert.doesNotMatch(html, /<table class="scopes">/);
});

test('the frontmatter reader takes key: value lines only and never throws on a missing file', () => {
  assert.equal(guide.readScopeFrontmatter('/nonexistent/aidlc-x.md'), undefined);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fm-')), 'a.md');
  fs.writeFileSync(f, '---\nname: x\nkeywords:\n  - a\n  - b\ndescription: "Quoted, with: colon"\nempty:\nlist: []\n---\nbody: not frontmatter\n');
  const fm = guide.readScopeFrontmatter(f);
  assert.equal(fm.name, 'x');
  assert.equal(fm.description, 'Quoted, with: colon');
  assert.equal(fm.empty, undefined);
  assert.equal(fm.list, undefined);
  assert.equal(fm.body, undefined, 'the body is not read');
  fs.writeFileSync(f, 'no frontmatter here\n');
  assert.equal(guide.readScopeFrontmatter(f), undefined);
});

test('the guide draws each scope as a bar from the stylesheet\'s width classes, never an inline style', () => {
  const root = configuredProject();
  const html = guide.renderCommandGuide({ root });
  assert.match(html, /<code>tiny<\/code>[\s\S]*?bar-fill w50[\s\S]*?2\/4/);
  assert.match(html, /<code>full<\/code>[\s\S]*?bar-fill w100[\s\S]*?4\/4/);
  assert.doesNotMatch(html, / style="/, 'the page CSP drops inline styles; the bar must be a class');
  assert.equal(guide.widthClass(1, 3), 'w33');
  assert.equal(guide.widthClass(0, 0), 'w0');
  assert.equal(guide.widthClass(5, 4), 'w100');
});

test('the guide carries the ways to start, both dials with their levels, the switches and the situations', () => {
  const html = guide.renderCommandGuide({ root: configuredProject() });
  for (const needle of [
    '/aidlc compose', '--status', '--depth', '--test-strategy', 'minimal', 'standard', 'comprehensive',
    '--project-type', '--review', '--guard-policy', '--sensors', '--stage', 'workshop', 'bugfix', 'poc', '--help'
  ]) {
    assert.ok(html.includes(needle), `guide mentions ${needle}`);
  }
  // The engine's own numbers for the levels, not invented ones.
  assert.match(html, /2–4 questions per stage/);
  assert.match(html, /5–15 total/);
});

test('the Start page places the guide under "What was set up" on v2, and not at all on v1', () => {
  const root = configuredProject();
  const webview = { cspSource: 'x', asWebviewUri: (u) => String(u) };
  const v2 = page.renderStartPage({ webview, root, project: { generation: 'v2' }, nonce: 'n', generation: 'v2', installed: ['engine', 'project'] });
  const setUp = v2.indexOf('What was set up');
  const guideAt = v2.indexOf('How to start /aidlc');
  assert.ok(setUp > 0 && guideAt > setUp, 'guide follows What was set up');
  assert.match(v2, /<code>tiny<\/code>/, 'the rows are the project\'s');
  // Every class the guide uses has a rule in the page's own stylesheet.
  for (const cls of ['guide', 'ways', 'way-cmd', 'way-what', 'way-eg', 'dials', 'dial', 'steps', 'step', 'scopes', 'switches', 'examples', 'nowrap']) {
    assert.match(v2, new RegExp(`\\.${cls}\\b[^{]*\\{`), `stylesheet has .${cls}`);
  }
  const v1 = page.renderStartPage({ webview, root, project: { generation: 'v1' }, nonce: 'n', generation: 'v1', installed: ['rules'] });
  assert.doesNotMatch(v1, /How to start \/aidlc/);
});
