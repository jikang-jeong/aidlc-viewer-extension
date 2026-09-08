'use strict';

// Pins removal: the one destructive operation this extension performs.
//
// Installation belongs to the engine now -- `aidlc config` writes the project and
// records its own inventory -- so what remains ours is taking an install back, and the
// receipt-reading that decides what taking-back may touch. The receipts come from two
// generations of record-keeper: this extension's own file, still on disk in projects
// installed by builds up to 0.0.23, and the engine's manifest, translated by
// engine-manifest.js for everything the engine installed. Both shapes are exercised
// here through the same planner.
//
// Fixtures are built by hand rather than by running an installer, because the thing
// under test is what removal does to a project in a given state -- not how the project
// got there.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = require('../src/aidlc/install-state');
const { planRemoval, MARKER_BEGIN, MARKER_END } = require('../src/aidlc/install-plan');
const { applyRemoval, resolveInside } = require('../src/aidlc/install-apply');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'removal-'));
}

function file(root, rel, content = 'x') {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// A receipt in this extension's own on-disk format, as builds up to 0.0.23 wrote it.
function writeReceipt(root, { files = [], appended = [], seeded = [] } = {}) {
  file(
    root,
    path.join(...state.RECEIPT_PATH),
    JSON.stringify({ schema: state.RECEIPT_SCHEMA, harness: 'kiro-ide', files, appended, seeded })
  );
}

// ---------------------------------------------------------------------------
// What removal refuses
// ---------------------------------------------------------------------------

test('removal without any record is refused, not guessed', () => {
  const root = makeRoot();
  try {
    file(root, '.kiro/agents/aidlc.md');
    const plan = planRemoval(state.readInstallState(root));
    assert.equal(plan.blocked, true);
    assert.equal(plan.reason, 'no-receipt');
    // And the refusal explains itself, because "nothing happened" reads as a bug.
    assert.match(plan.text, /by hand/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable receipt reads as no receipt, so removal is refused rather than partial', () => {
  const root = makeRoot();
  try {
    file(root, path.join(...state.RECEIPT_PATH), '{ truncated');
    const plan = planRemoval(state.readInstallState(root));
    assert.equal(plan.blocked, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a receipt naming a seeded path anyway is refused that deletion', () => {
  // A hand-edited receipt, or a bug in a future build, could list the seed directory.
  // `aidlc/spaces/default/memory/project.md` is where the workflow appends every
  // learned correction, and no backup covers it -- so the protection lives in the
  // planner, not in the receipt's honesty.
  const root = makeRoot();
  try {
    writeReceipt(root, {
      files: ['.kiro/agents/a.md', 'aidlc/spaces/default/memory/project.md', 'aidlc']
    });
    const plan = planRemoval(state.readInstallState(root));
    assert.ok(!plan.blocked);
    const targets = plan.ops.filter((op) => op.type === 'delete-file').map((op) => op.to);
    assert.ok(targets.includes('.kiro/agents/a.md'));
    assert.ok(!targets.some((t) => t.startsWith('aidlc')), targets.join(', '));
    // And the protection is said, not silent.
    assert.ok(plan.notes.some((note) => /seeded/.test(note.text)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a receipt path that escapes the project is kept, never followed', () => {
  // The planner trusts the receipt's list; the applier must not. A receipt edited to
  // name ../../ must fail at the boundary, with the reason recorded.
  const root = makeRoot();
  try {
    const result = applyRemoval({
      root,
      ops: [{ type: 'delete-file', to: path.join('..', 'escape.md') }]
    });
    assert.deepEqual(result.removed, []);
    assert.equal(result.kept[0].reason, 'escapes-root');
    assert.equal(resolveInside(root, '../escape.md'), undefined);
    assert.equal(resolveInside(root, ''), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// What removal takes back, and what it leaves
// ---------------------------------------------------------------------------

test('removal takes back exactly what the record lists, and the receipt goes last', () => {
  const root = makeRoot();
  try {
    file(root, '.kiro/agents/a.md');
    file(root, '.kiro/tools/aidlc.ts');
    file(root, 'aidlc/spaces/default/memory/project.md', 'LEARNED');
    file(root, 'untracked.md', 'mine');
    writeReceipt(root, { files: ['.kiro/agents/a.md', '.kiro/tools/aidlc.ts'] });

    const plan = planRemoval(state.readInstallState(root));
    const result = applyRemoval({ root, ops: plan.ops });

    assert.equal(fs.existsSync(path.join(root, '.kiro/agents/a.md')), false);
    assert.equal(fs.existsSync(path.join(root, '.kiro/tools/aidlc.ts')), false);
    // The receipt deletes itself, after everything it names -- a failure part way
    // through must leave the record that describes what is left.
    assert.equal(result.removed[result.removed.length - 1], path.join(...state.RECEIPT_PATH));
    // Untracked files and the seed are not the record's to take.
    assert.equal(fs.readFileSync(path.join(root, 'untracked.md'), 'utf8'), 'mine');
    assert.equal(
      fs.readFileSync(path.join(root, 'aidlc/spaces/default/memory/project.md'), 'utf8'),
      'LEARNED'
    );
    // Emptied directories are pruned; occupied ones are not.
    assert.equal(fs.existsSync(path.join(root, '.kiro/agents')), false);
    assert.equal(fs.existsSync(path.join(root, 'aidlc')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removal through the engine's manifest behaves like removal through our receipt", () => {
  // The engine performs installs now and writes its own inventory. install-state
  // translates it; from the planner on, the two records must be indistinguishable.
  const root = makeRoot();
  try {
    file(root, '.kiro/agents/a.md');
    file(root, 'aidlc/spaces/default/memory/project.md', 'LEARNED');
    file(
      root,
      '.kiro/tools/data/aidlc-manifest.json',
      JSON.stringify({
        schemaVersion: 1,
        frameworkVersion: '2.8.0',
        harnessDir: '.kiro',
        files: { '.kiro/agents/a.md': 'sha256:aa' },
        rootContributions: {}
      })
    );

    const read = state.readInstallState(root);
    assert.equal(read.receiptSource, 'engine-manifest');
    const plan = planRemoval(read);
    assert.ok(!plan.blocked);
    applyRemoval({ root, ops: plan.ops });

    assert.equal(fs.existsSync(path.join(root, '.kiro/agents/a.md')), false);
    assert.equal(
      fs.readFileSync(path.join(root, 'aidlc/spaces/default/memory/project.md'), 'utf8'),
      'LEARNED'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("our own receipt outranks the engine's manifest when both exist", () => {
  // A project installed by an older build carries our receipt; the engine's manifest
  // may appear beside it later. The record that did the installing does the removing.
  const root = makeRoot();
  try {
    writeReceipt(root, { files: ['.kiro/ours.md'] });
    file(
      root,
      '.kiro/tools/data/aidlc-manifest.json',
      JSON.stringify({ files: { '.kiro/theirs.md': 'sha256:aa' }, rootContributions: {} })
    );
    const read = state.readInstallState(root);
    assert.equal(read.receiptSource, 'extension');
    assert.deepEqual(read.receipt.files, ['.kiro/ours.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Marked sections in shared files
// ---------------------------------------------------------------------------

test('removal restores a shared file to what the project had before', () => {
  const root = makeRoot();
  try {
    file(
      root,
      'AGENTS.md',
      `# my own agents doc\n\n${MARKER_BEGIN}\ninstalled content\n${MARKER_END}\n`
    );
    writeReceipt(root, { files: [], appended: ['AGENTS.md'] });
    applyRemoval({ root, ops: planRemoval(state.readInstallState(root)).ops });
    assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').trim(), '# my own agents doc');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removal deletes a shared file that is nothing but our section', () => {
  const root = makeRoot();
  try {
    file(root, '.gitignore', `${MARKER_BEGIN}\naidlc-tmp/\n${MARKER_END}\n`);
    writeReceipt(root, { files: [], appended: ['.gitignore'] });
    applyRemoval({ root, ops: planRemoval(state.readInstallState(root)).ops });
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removal leaves a marked section alone when someone edited the markers away', () => {
  // Removing a guessed range would take the user's edit with it. The file is kept and
  // the reason is recorded, so the report can say why.
  const root = makeRoot();
  try {
    const edited = '# they removed our markers but kept some content\n';
    file(root, 'AGENTS.md', edited);
    writeReceipt(root, { files: [], appended: ['AGENTS.md'] });
    const result = applyRemoval({ root, ops: planRemoval(state.readInstallState(root)).ops });
    assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), edited);
    assert.ok(result.kept.some((entry) => entry.reason === 'markers-not-found'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The receipt fields themselves
// ---------------------------------------------------------------------------

test('a receipt field this build does not read is reported rather than dropped', () => {
  // A newer build may record more than this one understands. Surviving that is what
  // lets receipts move across versions in both directions.
  const root = makeRoot();
  try {
    file(
      root,
      path.join(...state.RECEIPT_PATH),
      JSON.stringify({
        schema: state.RECEIPT_SCHEMA,
        harness: 'kiro-ide',
        files: ['.kiro/a.md'],
        appended: [],
        seeded: [],
        futureField: { anything: true }
      })
    );
    const receipt = state.readReceipt(root);
    assert.ok(receipt, 'a receipt with extra fields must still read');
    assert.deepEqual(receipt.files, ['.kiro/a.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
