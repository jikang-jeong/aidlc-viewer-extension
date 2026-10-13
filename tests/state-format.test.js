'use strict';

// State-file format contract + regression characterization.
//
// The first half pins the *shape of the input* any progress parser must handle.
// The second half loads parseAidlcState from src/extension.js (with `vscode`
// stubbed) and runs it over the fixtures.
//
// Fixtures are synthetic and reproduce formats observed in real v1 projects.
// Never commit customer project files here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KNOWN_PHASES = ['inception', 'construction', 'operations'];

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function stageProgressSection(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Stage Progress/i.test(line)) {
      inSection = true;
      continue;
    }
    // `###` phase subheadings stay inside the section; the next `##` ends it.
    if (inSection && /^##\s/.test(line) && !/^###/.test(line)) {
      break;
    }
    if (inSection) {
      out.push(line);
    }
  }
  return out;
}

const ORDINAL_UNITS = readFixture('aidlc-state.real-format.md');
const HYPHENATED_UNITS = readFixture('aidlc-state.hyphenated-units.md');

// ---------------------------------------------------------------------------
// Format contract: what any replacement parser must cope with.
// ---------------------------------------------------------------------------

test('both fixtures expose a Stage Progress section', () => {
  assert.ok(stageProgressSection(ORDINAL_UNITS).length > 0);
  assert.ok(stageProgressSection(HYPHENATED_UNITS).length > 0);
});

test('phase names live in ### subheadings, never inline on item lines', () => {
  for (const source of [ORDINAL_UNITS, HYPHENATED_UNITS]) {
    const section = stageProgressSection(source).join('\n');
    for (const phase of ['INCEPTION', 'CONSTRUCTION', 'OPERATIONS']) {
      assert.match(section, new RegExp(`^###\\s+.*${phase}\\s+PHASE`, 'm'), `no ### heading for ${phase}`);
    }
    assert.doesNotMatch(
      section,
      /^\s*-\s*\[[ xX]\]\s*(INCEPTION|CONSTRUCTION|OPERATIONS)\b/m,
      'real files do not carry inline phase prefixes'
    );
  }
});

test('separator is an em-dash, not an ASCII hyphen', () => {
  for (const source of [ORDINAL_UNITS, HYPHENATED_UNITS]) {
    assert.ok(stageProgressSection(source).join('\n').includes('—'));
  }
});

test('construction rows nest one level per unit of work', () => {
  const nested = stageProgressSection(ORDINAL_UNITS).filter((line) => /^\s{2,}-\s*\[[ xX]\]/.test(line));
  assert.equal(nested.length, 10, 'expected 5 per-unit stages x 2 units');
});

test('top-level rows are the 14 v1 stages', () => {
  const top = stageProgressSection(ORDINAL_UNITS).filter((line) => /^-\s*\[[ xX]\]/.test(line));
  assert.equal(top.length, 14, '7 inception + 6 construction + 1 operations');
});

test('a skipped stage is marked unchecked with a SKIPPED reason', () => {
  assert.match(ORDINAL_UNITS, /^- \[ \] Reverse Engineering — SKIPPED/m);
});

// ---------------------------------------------------------------------------
// The parser itself, run over the fixtures.
//
// Until 0.0.26 the tests below this line characterised two failure modes of the
// old regex instead: it required a one-word phase before the dash, so in a current
// file it matched nothing (ordinal unit labels) or matched fragments of unit names
// under a bogus phase (hyphenated unit labels). The user-visible form was a tree row
// reading "Operations" on a project in Inception, because "Operations - PLACEHOLDER"
// was the one line a current file has in the old shape. The parser reads the phase
// from the ### heading now, and these run it rather than describe it.
// ---------------------------------------------------------------------------

function loadParser() {
  const Module = require('module');
  const file = path.join(__dirname, '..', 'src', 'extension.js');
  const realLoad = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (request !== 'vscode') return realLoad.call(this, request, ...rest);
    return {
      TreeItem: class {}, TreeItemCollapsibleState: {}, ThemeIcon: class {}, ThemeColor: class {},
      MarkdownString: class {}, Uri: { file: (p) => ({ fsPath: p }) }, window: {}, workspace: { fs: {} },
      commands: {}, EventEmitter: class { constructor() { this.event = () => {}; this.fire = () => {}; } },
      FileType: {}, RelativePattern: class {}, ProgressLocation: {}
    };
  };
  try {
    const loaded = new Module(file);
    loaded.filename = file;
    loaded.paths = Module._nodeModulePaths(path.dirname(file));
    loaded._compile(`${fs.readFileSync(file, 'utf8')}\nmodule.exports = { parseAidlcState };`, file);
    return loaded.exports.parseAidlcState;
  } finally {
    Module._load = realLoad;
  }
}

test('the 14 top-level stages parse, each under the phase of its ### heading', () => {
  const parse = loadParser();
  for (const text of [ORDINAL_UNITS, HYPHENATED_UNITS]) {
    const { steps } = parse(text);
    assert.equal(steps.length, 14, 'one step per v1 stage; the indented unit rows are not steps');
    const byPhase = {};
    for (const s of steps) byPhase[s.stage] = (byPhase[s.stage] || 0) + 1;
    assert.deepEqual(byPhase, { inception: 7, construction: 6, operations: 1 });
    for (const s of steps) assert.ok(KNOWN_PHASES.includes(s.stage), `unknown phase ${s.stage}`);
  }
});

test('the status is the word after the dash; the parenthesis is a note about it', () => {
  const parse = loadParser();
  const { steps } = parse(ORDINAL_UNITS);
  const reverse = steps.find((s) => s.name === 'Reverse Engineering');
  assert.equal(reverse.status, 'SKIPPED', '"— SKIPPED (Greenfield)" is skipped, not "greenfield"');
  const infra = parse(HYPHENATED_UNITS).steps.find((s) => s.name === 'Infrastructure Design');
  assert.equal(infra.status, 'IN PROGRESS', '"— IN PROGRESS (per unit)" is in progress, not "per unit"');
});

test('the in-progress step is the one marked so, never a skipped or placeholder one', () => {
  const parse = loadParser();
  assert.equal(parse(HYPHENATED_UNITS).inProgressStep.name, 'Infrastructure Design');
  // Every stage done; the unchecked rows are SKIPPED and PLACEHOLDER, which are not work.
  assert.equal(parse(ORDINAL_UNITS).inProgressStep, undefined);
});

test('a file in the current shape with plain hyphens and no emoji parses the same', () => {
  // The shape seen on 2026-10-13 from current upstream rules: no emoji, ASCII hyphen,
  // "- [ ] Application Design - IN PROGRESS". This is the file that read "Operations".
  const parse = loadParser();
  const text = [
    '## Stage Progress', '### INCEPTION PHASE',
    '- [x] Workspace Detection', '- [x] Reverse Engineering (skipped - greenfield project)',
    '- [x] Workflow Planning (approved 2026-10-13)', '- [ ] Application Design - IN PROGRESS',
    '- [ ] Units Generation - EXECUTE', '', '### CONSTRUCTION PHASE', '- [ ] Code Generation - EXECUTE',
    '', '### OPERATIONS PHASE', '- [ ] Operations - PLACEHOLDER', '', '## Next'
  ].join('\n');
  const { steps, inProgressStep } = parse(text);
  assert.equal(steps.length, 7);
  assert.equal(inProgressStep.name, 'Application Design');
  assert.equal(inProgressStep.stage, 'inception');
});

test('the older one-line shape, "Phase - Step (STATUS)", still parses', () => {
  const parse = loadParser();
  const { steps, inProgressStep } = parse(
    '## Stage Progress\n- [x] Inception - Requirements (COMPLETE)\n- [ ] Inception - Design (IN PROGRESS)\n- [ ] Construction - Code\n## Next'
  );
  assert.deepEqual(steps.map((s) => [s.stage, s.name, s.done, s.status]), [
    ['inception', 'Requirements', true, 'COMPLETE'],
    ['inception', 'Design', false, 'IN PROGRESS'],
    ['construction', 'Code', false, '']
  ]);
  assert.equal(inProgressStep.name, 'Design');
});
