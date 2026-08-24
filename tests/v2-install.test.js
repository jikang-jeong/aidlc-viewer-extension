'use strict';

// Contract for the v2 install layer.
//
// One rule matters more than the rest and most of this file exists to hold it: an
// install may create the `aidlc/` seed and may never overwrite it. Nine files are
// seeded there and the workflow turns them into the project's own accumulated
// rules, which live nowhere else. Three observed projects had six learned rules in
// project.md and an affirmed practice in team.md, in a directory the user never
// opens. A reinstall that reapplied the seed would delete that silently.
//
// The second rule: removal without a receipt is refused rather than guessed at.
// `.kiro/` and `aidlc/` are exactly where a project keeps its own work, so a wrong
// guess is unrecoverable.
//
// No test here writes into a project. The planner is handed a listing and returns
// operations, which is what makes both rules testable at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = require('../src/aidlc/install-state');
const plan = require('../src/aidlc/install-plan');

// The top-level listing of the real upstream payload, confirmed by extracting
// dist/kiro-ide at the pinned commit.
const PAYLOAD = [
  { name: '.kiro', isDirectory: true },
  { name: 'aidlc', isDirectory: true },
  { name: 'AGENTS.md', isDirectory: false },
  { name: '.gitignore', isDirectory: false }
];

function project(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-install-'));
  build({
    root,
    dir(rel) {
      fs.mkdirSync(path.join(root, rel), { recursive: true });
    },
    file(rel, contents = '') {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    }
  });
  return root;
}

// A project that has been installed and never run: exactly the nine seed files.
function seededOnly({ dir, file }) {
  dir('.kiro/agents');
  file('.kiro/agents/aidlc.json', '{}');
  for (const name of ['org.md', 'team.md', 'project.md']) {
    file(`aidlc/spaces/default/memory/${name}`, '# seed');
  }
  for (const name of ['ideation', 'inception', 'construction', 'operation']) {
    file(`aidlc/spaces/default/memory/phases/${name}.md`, '# seed');
  }
  file('aidlc/spaces/default/memory/templates/.gitkeep', '');
  file('aidlc/active-space', 'default');
}

// ---------------------------------------------------------------------------
// The seed must never be overwritten
// ---------------------------------------------------------------------------

test('a project whose memory has moved past the seed gets no aidlc/ operation at all', () => {
  const root = project((helpers) => {
    seededOnly(helpers);
    // What a run produces: an intent record, and rules the workflow learned.
    helpers.file(
      'aidlc/spaces/default/memory/project.md',
      '## Corrections\n- ALWAYS something the team learned (learned 2026-08-21)\n'
    );
    for (let i = 0; i < 12; i += 1) {
      helpers.file(`aidlc/spaces/default/intents/260101-x/ideation/a${i}.md`, '# artifact');
    }
  });

  const s = state.readInstallState(root);
  assert.equal(s.memory.beyondSeed, true);

  const result = plan.planInstall({
    payloadEntries: PAYLOAD,
    state: s,
    harness: 'kiro-ide',
    upstreamCommit: 'abc1234'
  });

  // The assertion that matters: no operation names the seed directory.
  const touchesSeed = result.ops.filter((op) => op.to === plan.SEED_ENTRY);
  assert.deepEqual(touchesSeed, []);
  // And the reason is stated rather than silent.
  assert.ok(result.notes.some((note) => note.level === 'warn' && /left untouched/.test(note.text)));
});

test('a project installed but never run may be seeded, because nothing has been written yet', () => {
  const root = project(seededOnly);
  const s = state.readInstallState(root);
  assert.equal(s.memory.beyondSeed, false);

  const result = plan.planInstall({ payloadEntries: PAYLOAD, state: s });
  const seedOp = result.ops.find((op) => op.to === plan.SEED_ENTRY);
  assert.equal(seedOp.type, plan.OP.SEED_TREE);
});

test('a project with no aidlc/ at all is seeded', () => {
  const root = project(({ dir }) => dir('.kiro'));
  const s = state.readInstallState(root);
  assert.equal(s.memory, undefined);
  const result = plan.planInstall({ payloadEntries: PAYLOAD, state: s });
  assert.equal(result.ops.find((op) => op.to === plan.SEED_ENTRY).type, plan.OP.SEED_TREE);
});

test('seeding never replaces, so an edit made before the first run survives', () => {
  // SEED_TREE is a fill-in-the-gaps operation by contract. This pins that the
  // planner never emits a replace for the seed, whatever the project looks like.
  for (const build of [seededOnly, ({ dir }) => dir('.kiro')]) {
    const root = project(build);
    const result = plan.planInstall({
      payloadEntries: PAYLOAD,
      state: state.readInstallState(root)
    });
    for (const op of result.ops) {
      if (op.to === plan.SEED_ENTRY) assert.notEqual(op.type, plan.OP.REPLACE_TREE);
    }
  }
});

// ---------------------------------------------------------------------------
// The engine is replaced, and the receipt survives that
// ---------------------------------------------------------------------------

test('the engine tree is replaced outright, because a half-old engine is untested', () => {
  const root = project(({ dir }) => dir('.kiro/agents'));
  const result = plan.planInstall({
    payloadEntries: PAYLOAD,
    state: state.readInstallState(root)
  });
  const engineOp = result.ops.find((op) => op.to === plan.ENGINE_ENTRY);
  assert.equal(engineOp.type, plan.OP.REPLACE_TREE);
});

test('the receipt is preserved through the engine replacement that contains it', () => {
  // The receipt lives inside .kiro/ so that the installer writes only where it
  // owns, which means replacing .kiro/ would destroy the record of what to remove.
  const root = project(({ dir }) => dir('.kiro'));
  const result = plan.planInstall({
    payloadEntries: PAYLOAD,
    state: state.readInstallState(root)
  });
  const engineOp = result.ops.find((op) => op.to === plan.ENGINE_ENTRY);
  const receiptName = path.join(...state.RECEIPT_PATH.slice(1));
  assert.ok(engineOp.preserve.includes(receiptName));
});

test('a shared file is appended to under a marker, never replaced', () => {
  const root = project(({ file }) => {
    file('AGENTS.md', '# the project had its own reason to keep this\n');
    file('.gitignore', 'node_modules\n');
  });
  const result = plan.planInstall({
    payloadEntries: PAYLOAD,
    state: state.readInstallState(root)
  });
  for (const name of state.SHARED_FILES) {
    const op = result.ops.find((o) => o.to === name);
    assert.equal(op.type, plan.OP.APPEND_SECTION);
    assert.equal(op.markerBegin, plan.MARKER_BEGIN);
  }
});

test('an entry the payload grew is copied without replacing, and reported', () => {
  const root = project(({ dir }) => dir('.kiro'));
  const result = plan.planInstall({
    payloadEntries: [...PAYLOAD, { name: 'somethingNew', isDirectory: true }],
    state: state.readInstallState(root)
  });
  const op = result.ops.find((o) => o.to === 'somethingNew');
  assert.equal(op.type, plan.OP.SEED_TREE);
  assert.ok(result.unexpected.includes('somethingNew'));
  assert.ok(result.notes.some((note) => /no specific handling/.test(note.text)));
});

test('every plan ends by writing a receipt', () => {
  const root = project(({ dir }) => dir('.kiro'));
  const result = plan.planInstall({
    payloadEntries: PAYLOAD,
    state: state.readInstallState(root),
    harness: 'kiro-ide',
    upstreamCommit: 'deadbee'
  });
  const receiptOp = result.ops[result.ops.length - 1];
  assert.equal(receiptOp.type, plan.OP.WRITE_RECEIPT);
  assert.equal(receiptOp.receipt.harness, 'kiro-ide');
  assert.equal(receiptOp.receipt.upstreamCommit, 'deadbee');
  assert.equal(receiptOp.receipt.schemaVersion, state.RECEIPT_SCHEMA);
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

test('removal without a receipt is refused, not guessed', () => {
  // A v2 project set up by hand has no receipt. Deleting what merely looks like an
  // install would target the two directories a project keeps its own work in.
  const root = project(({ dir }) => {
    dir('.kiro/agents');
    dir('aidlc/spaces');
  });
  const result = plan.planRemoval(state.readInstallState(root));
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'no-receipt');
});

test('removal takes back exactly what the receipt records', () => {
  const root = project(({ dir, file }) => {
    dir('.kiro');
    file(
      path.join(...state.RECEIPT_PATH),
      JSON.stringify({
        schemaVersion: 1,
        harness: 'kiro-ide',
        upstreamCommit: 'abc',
        files: ['.kiro/agents/aidlc.json', '.kiro/tools/x.ts'],
        appended: ['AGENTS.md']
      })
    );
  });
  const s = state.readInstallState(root);
  assert.equal(s.installedByExtension, true);

  const result = plan.planRemoval(s);
  assert.equal(result.blocked, false);
  const deleted = result.ops.filter((op) => op.type === 'delete-file').map((op) => op.to);
  assert.ok(deleted.includes('.kiro/agents/aidlc.json'));
  assert.ok(deleted.includes('.kiro/tools/x.ts'));
  // The receipt removes itself last.
  assert.equal(deleted[deleted.length - 1], path.join(...state.RECEIPT_PATH));
  const section = result.ops.find((op) => op.type === 'remove-section');
  assert.equal(section.to, 'AGENTS.md');
});

test('removal never deletes the project memory, and says so when there is any', () => {
  const root = project((helpers) => {
    seededOnly(helpers);
    for (let i = 0; i < 12; i += 1) {
      helpers.file(`aidlc/spaces/default/intents/260101-x/a${i}.md`, '#');
    }
    helpers.file(
      path.join(...state.RECEIPT_PATH),
      JSON.stringify({ schemaVersion: 1, files: ['.kiro/agents/aidlc.json'], appended: [] })
    );
  });
  const result = plan.planRemoval(state.readInstallState(root));
  const targets = result.ops.map((op) => op.to);
  assert.ok(!targets.some((target) => target.startsWith('aidlc/')));
  assert.ok(result.notes.some((note) => /only if you mean to lose that history/.test(note.text)));
});

// ---------------------------------------------------------------------------
// State reading
// ---------------------------------------------------------------------------

test('a receipt field this build does not read is reported rather than dropped', () => {
  const root = project(({ dir, file }) => {
    dir('.kiro');
    file(
      path.join(...state.RECEIPT_PATH),
      JSON.stringify({ schemaVersion: 2, files: [], appended: [], somethingLater: true })
    );
  });
  assert.deepEqual(state.readInstallState(root).receipt.unknownFields, ['somethingLater']);
});

test('an unreadable receipt reads as no receipt, so removal is refused rather than partial', () => {
  const root = project(({ dir, file }) => {
    dir('.kiro');
    file(path.join(...state.RECEIPT_PATH), '{ truncated');
  });
  const s = state.readInstallState(root);
  assert.equal(s.receipt, undefined);
  assert.equal(plan.planRemoval(s).blocked, true);
});

test('a missing git repository is reported, because the affirmed practices assume one', () => {
  // One observed project carried trunk-based-development rules with no repository
  // to apply them to, and the engine's own health check passed it.
  const root = project(({ dir }) => dir('.kiro'));
  const s = state.readInstallState(root);
  assert.equal(s.hasGitRepo, false);
  assert.ok(
    state.previewInstall(s).notes.some((note) => /No git repository/.test(note.text))
  );
});

test('v1 files are reported as left alone, never as something to replace', () => {
  const root = project(({ dir }) => {
    dir('aidlc-docs/inception');
    dir('.kiro');
  });
  const notes = state.previewInstall(state.readInstallState(root)).notes;
  // Matched on meaning rather than on wording. The exact sentence was rewritten
  // when the dialog was shortened, and a test pinned to the old phrasing failed
  // while the behaviour it was protecting had not changed. What matters is that v1
  // is named, that it is said to be left alone, and that nothing offers to replace
  // or remove it.
  const v1Note = notes.find((note) => /v1/i.test(note.text));
  assert.ok(v1Note, 'v1 is mentioned when v1 is present');
  assert.match(v1Note.text, /left alone|left exactly|untouched|not.*(touch|replac|remov)/i);
  for (const note of notes) {
    if (!/v1/i.test(note.text)) continue;
    assert.doesNotMatch(
      note.text,
      /v1[^.]*\b(replaced|removed|deleted|overwritten)\b/i,
      `a note threatens v1: ${note.text}`
    );
  }
});

test('the notices stay short enough to be read', () => {
  // They ran to eleven lines of prose on a real project, which is long enough that
  // the one line that matters gets skipped. Notes are now one line each and say
  // what happens to a named thing.
  //
  // The worst case: v2 already installed, v1 also present, the workflow has grown
  // aidlc/, both shared files exist, and there is no git repository.
  const root = project(({ dir, file }) => {
    dir('.kiro/steering/aws-aidlc-rules');
    file('.kiro/steering/aws-aidlc-rules/core.md', 'x');
    file(
      '.kiro/aidlc-viewer-install.json',
      JSON.stringify({
        version: 1,
        harness: 'kiro-ide',
        upstreamCommit: 'abc1234',
        files: ['.kiro/x'],
        appended: [],
        seeded: ['aidlc/spaces/default/memory/project.md']
      })
    );
    dir('aidlc/spaces/default/memory');
    for (let i = 0; i < 146; i += 1) {
      file(`aidlc/spaces/default/memory/f${i}.md`, 'x');
    }
    file('AGENTS.md', 'x');
    file('.gitignore', 'x');
  });

  const notes = state.previewInstall(state.readInstallState(root)).notes;
  assert.ok(notes.length <= 6, `too many notes: ${notes.length}`);
  for (const note of notes) {
    assert.ok(!note.text.includes('\n'), `a note spans lines: ${note.text}`);
    assert.ok(note.text.length <= 130, `a note is too long (${note.text.length}): ${note.text}`);
  }
  // The note that must survive any future trimming.
  assert.ok(
    notes.some((note) => /aidlc\/.*146.*left alone/i.test(note.text)),
    'the workflow-written directory must be named as left alone'
  );
});

test('nothing to say produces nothing to read', () => {
  // A project with git and no AI-DLC has no notes at all, so the dialog is two
  // lines. Asserted because an empty list is the easy case to accidentally fill
  // with reassurance nobody asked for.
  const root = project(({ dir }) => {
    dir('.git');
  });
  assert.deepEqual(state.previewInstall(state.readInstallState(root)).notes, []);
});

test('counts of one are not written as plurals', () => {
  const root = project(({ dir, file }) => {
    dir('.git');
    dir('.kiro');
    file('.kiro/only.md', 'x');
  });
  const notes = state.previewInstall(state.readInstallState(root)).notes;
  const engine = notes.find((note) => note.text.startsWith('.kiro/'));
  assert.ok(engine);
  assert.match(engine.text, /1 file:/);
  assert.doesNotMatch(engine.text, /1 files/);
});

test('every note says whether it outlives the install', () => {
  // The install is no longer gated on a confirmation, so these notes are read after
  // the fact. A note describing what was found beforehand is noise by then; a note
  // about something the user should still fix is not. Marked at the source because
  // only previewInstall knows which of its own statements outlive the operation,
  // and the alternative was the caller matching on note text.
  const root = project(({ dir, file }) => {
    dir('.kiro/steering/aws-aidlc-rules');
    file('.kiro/steering/aws-aidlc-rules/core.md', 'x');
    file(
      '.kiro/aidlc-viewer-install.json',
      JSON.stringify({
        version: 1,
        harness: 'kiro-ide',
        upstreamCommit: 'abc1234',
        files: ['.kiro/x'],
        appended: [],
        seeded: ['aidlc/spaces/default/memory/project.md']
      })
    );
    dir('aidlc/spaces/default/memory');
    for (let i = 0; i < 146; i += 1) {
      file(`aidlc/spaces/default/memory/f${i}.md`, 'x');
    }
    file('AGENTS.md', 'x');
    file('.gitignore', 'x');
  });

  const notes = state.previewInstall(state.readInstallState(root)).notes;
  for (const note of notes) {
    assert.equal(typeof note.lasting, 'boolean', `note has no lasting flag: ${note.text}`);
  }
  // A missing git repository is the user's to fix, and is still missing afterwards.
  const git = notes.find((note) => /No git repository/.test(note.text));
  assert.ok(git);
  assert.equal(git.lasting, true);
  // "Already installed" describes the state this install has just replaced.
  const already = notes.find((note) => /already installed/i.test(note.text));
  assert.ok(already);
  assert.equal(already.lasting, false);
});

test('a project with git has nothing lasting to report', () => {
  // Which is what makes a clean install quiet: the completion message carries the
  // result and no notices at all.
  const root = project(({ dir }) => {
    dir('.git');
  });
  const notes = state.previewInstall(state.readInstallState(root)).notes;
  assert.equal(notes.filter((note) => note.lasting).length, 0);
});

test('reading a path that does not exist is a verdict, not an error', () => {
  assert.equal(state.readInstallState('/nonexistent/nowhere').ok, true);
  assert.equal(state.readInstallState(undefined).ok, false);
});
