'use strict';

// State-file format contract + regression characterization.
//
// These tests do NOT exercise src/extension.js (it requires the `vscode` module
// and cannot be loaded outside the extension host). They pin the *shape of the
// input* that any progress parser must handle, and they characterize the two
// distinct failure modes of the current parser so that a fix is provably a fix.
//
// Fixtures are synthetic and reproduce formats observed in real v1 projects.
// Never commit customer project files here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Verbatim regex and phase list from parseAidlcState() / computeProgressFromState()
// in src/extension.js. Copied, not imported: extension.js requires `vscode`.
const CURRENT_STEP_REGEX = /^\s*-\s*\[( |x|X)\]\s*([A-Za-z]+)\s*-\s*(.+?)\s*(?:\(([^)]*)\))?\s*$/;
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

// Reproduces what parseAidlcState() would extract, without importing vscode.
function currentParserSteps(text) {
  return stageProgressSection(text)
    .map((line) => line.match(CURRENT_STEP_REGEX))
    .filter(Boolean)
    .map((m) => ({ phase: m[2].toLowerCase(), name: m[3].trim(), done: m[1].toLowerCase() === 'x' }));
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
// Failure mode 1: ordinal unit labels (U1, U2) -> zero steps parsed.
// parseAidlcState returns undefined, so the artifact-count fallback runs.
// ---------------------------------------------------------------------------

test('FAILURE MODE 1: ordinal unit labels parse to zero steps', () => {
  const steps = currentParserSteps(ORDINAL_UNITS);
  assert.equal(
    steps.length,
    0,
    'Expected the current regex to match nothing (it needs "Word - rest"). ' +
      'If this now matches, the parser changed: update this characterization test.'
  );
});

// ---------------------------------------------------------------------------
// Failure mode 2: hyphenated unit labels (bedrock-proxy) -> spurious matches
// under a bogus phase key. parseAidlcState "succeeds", the fallback never runs,
// and every phase reports 0%. This is the user-visible 0% bug.
// ---------------------------------------------------------------------------

test('FAILURE MODE 2: hyphenated unit labels produce spurious matches', () => {
  const steps = currentParserSteps(HYPHENATED_UNITS);
  assert.ok(steps.length > 0, 'hyphenated unit names are consumed as "phase - name"');
  assert.deepEqual(
    [...new Set(steps.map((s) => s.phase))],
    ['bedrock'],
    'the captured phase key is a fragment of the unit name'
  );
});

test('FAILURE MODE 2: no parsed step lands in a known phase, so progress is 0%', () => {
  const steps = currentParserSteps(HYPHENATED_UNITS);
  const inKnownPhase = steps.filter((s) => KNOWN_PHASES.includes(s.phase));
  assert.equal(
    inKnownPhase.length,
    0,
    'Every phase bucket stays empty, which is why the UI shows 0% on a project full of artifacts.'
  );
});
