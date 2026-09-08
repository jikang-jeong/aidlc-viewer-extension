'use strict';

// End-to-end contract for the install executor: install, reinstall, remove.
//
// These tests write to disk, unlike the planner tests, because what they protect
// only exists once files move. They build their own payload rather than fetching
// one, so the suite stays offline and deterministic; a fetched payload is exercised
// separately by hand against the pinned commit.
//
// Two properties matter above the rest, and both are unrecoverable if broken:
//
//   A reinstall must not touch aidlc/. Nine files are seeded there and the
//   workflow turns them into the project's own rules -- three observed projects
//   grew theirs to 138-146 files with learned corrections in project.md that exist
//   nowhere else.
//
//   Removal must take back only what the receipt records. The receipt lives inside
//   the tree the installer replaces, so a reinstall that lost it would leave a
//   project with no record of what to remove.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = require('../src/aidlc/install-state');
const plan = require('../src/aidlc/install-plan');
const apply = require('../src/aidlc/install-apply');
const payload = require('../src/aidlc/payload');

// A payload shaped like the real one: dist/kiro-ide is .kiro (the engine), aidlc
// (the seed), AGENTS.md and .gitignore.
function makePayload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-fake-payload-'));
  const write = (rel, contents) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  };
  write('.kiro/agents/aidlc.json', '{"name":"aidlc"}');
  write('.kiro/tools/aidlc-utility.ts', '// engine tool');
  write('.kiro/tools/data/stage-graph.json', '[]');
  write('aidlc/spaces/default/memory/org.md', '# org seed');
  write('aidlc/spaces/default/memory/team.md', '# team seed');
  write('aidlc/spaces/default/memory/project.md', '# project seed');
  write('aidlc/active-space', 'default');
  write('AGENTS.md', '# upstream agent instructions');
  write('.gitignore', 'aidlc/.aidlc-sessions/\n');
  return dir;
}

function emptyProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-proj-'));
}

function install(payloadDir, root, commit = 'abc1234') {
  const entries = payload.topLevelEntries(payloadDir);
  const current = state.readInstallState(root);
  const planned = plan.planInstall({
    payloadEntries: entries,
    state: current,
    harness: 'kiro-ide',
    upstreamCommit: commit
  });
  return {
    planned,
    result: apply.applyPlan({ payloadDir, root, ops: planned.ops })
  };
}

function readReceipt(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ...state.RECEIPT_PATH), 'utf8'));
}

function countFiles(dir) {
  return apply.listFilesRelative(dir).length;
}

// Simulates a run: the workflow rewrites a seeded memory file and produces an
// intent record.
function simulateRun(root) {
  const memory = path.join(root, 'aidlc', 'spaces', 'default', 'memory');
  fs.writeFileSync(
    path.join(memory, 'project.md'),
    '## Corrections\n- ALWAYS something this project learned (learned 2026-08-22)\n'
  );
  const intent = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '260822-x', 'ideation');
  fs.mkdirSync(intent, { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    fs.writeFileSync(path.join(intent, `a${i}.md`), '# artifact');
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

test('a first install writes the engine, seeds the memory, and records what it wrote', () => {
  const src = makePayload();
  const root = emptyProject();
  const { result } = install(src, root);

  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(path.join(root, '.kiro', 'agents', 'aidlc.json')));
  assert.ok(fs.existsSync(path.join(root, 'aidlc', 'spaces', 'default', 'memory', 'org.md')));

  const receipt = readReceipt(root);
  assert.equal(receipt.harness, 'kiro-ide');
  assert.equal(receipt.upstreamCommit, 'abc1234');
  // Every path in the receipt exists, because it records what was written rather
  // than what the plan intended.
  for (const rel of receipt.files) {
    assert.ok(fs.existsSync(path.join(root, rel)), `receipt names a missing file: ${rel}`);
  }
});

test('a shared file the project already had keeps its own content', () => {
  const src = makePayload();
  const root = emptyProject();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# my own notes\nkeep me\n');
  install(src, root);

  const after = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(after, /keep me/);
  assert.match(after, /upstream agent instructions/);
  // Recorded as appended, not written, so removal takes back the section rather
  // than the file.
  assert.deepEqual(readReceipt(root).appended, ['AGENTS.md']);
});

test('a shared file the project did not have becomes ours outright', () => {
  const src = makePayload();
  const root = emptyProject();
  install(src, root);
  const receipt = readReceipt(root);
  // .gitignore did not exist, so removal should delete it rather than edit it.
  assert.ok(receipt.files.includes('.gitignore'));
  assert.ok(!receipt.appended.includes('.gitignore'));
});

// ---------------------------------------------------------------------------
// Reinstall: the property that must never regress
// ---------------------------------------------------------------------------

test('a reinstall leaves every file under aidlc/ exactly as the run left it', () => {
  const src = makePayload();
  const root = emptyProject();
  install(src, root);
  simulateRun(root);

  const memoryDir = path.join(root, 'aidlc');
  const before = new Map(
    apply.listFilesRelative(memoryDir).map((rel) => [rel, fs.readFileSync(path.join(memoryDir, rel))])
  );

  const { planned, result } = install(src, root);
  assert.equal(result.ok, true);

  // No operation named the seed directory.
  assert.deepEqual(planned.ops.filter((op) => op.to === plan.SEED_ENTRY), []);
  assert.ok(planned.notes.some((note) => note.level === 'warn' && /left untouched/.test(note.text)));

  const after = new Map(
    apply.listFilesRelative(memoryDir).map((rel) => [rel, fs.readFileSync(path.join(memoryDir, rel))])
  );
  assert.equal(after.size, before.size);
  for (const [rel, bytes] of before) {
    assert.ok(after.has(rel), `reinstall lost ${rel}`);
    assert.ok(bytes.equals(after.get(rel)), `reinstall modified ${rel}`);
  }
});

test('a reinstall replaces the engine and carries the receipt through it', () => {
  const src = makePayload();
  const root = emptyProject();
  install(src, root);

  // A stale engine file from a previous version must not survive the replacement.
  fs.writeFileSync(path.join(root, '.kiro', 'tools', 'gone-upstream.ts'), '// old');
  const { result } = install(src, root, 'def5678');

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(root, '.kiro', 'tools', 'gone-upstream.ts')), false);
  // The receipt lives inside the replaced tree, so this is the test that proves
  // removal is still possible after a reinstall.
  assert.equal(readReceipt(root).upstreamCommit, 'def5678');
});

test('reinstalling twice does not accumulate copies in a shared file', () => {
  const src = makePayload();
  const root = emptyProject();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# mine\n');
  install(src, root);
  install(src, root);

  const after = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const occurrences = after.split(plan.MARKER_BEGIN).length - 1;
  assert.equal(occurrences, 1);
  assert.match(after, /# mine/);
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

test('removal takes back the engine and leaves the project memory', () => {
  const src = makePayload();
  const root = emptyProject();
  install(src, root);
  simulateRun(root);
  const memoryCount = countFiles(path.join(root, 'aidlc'));

  const removal = plan.planRemoval(state.readInstallState(root));
  assert.equal(removal.blocked, false);
  const applied = apply.applyRemoval({ root, ops: removal.ops });

  assert.deepEqual(applied.kept, []);
  assert.equal(fs.existsSync(path.join(root, '.kiro')), false);
  assert.equal(countFiles(path.join(root, 'aidlc')), memoryCount);
});

test('the seed is recorded apart from what removal may delete', () => {
  // The first version of this recorded seeded paths in the receipt's `files`
  // list, so removal deleted four files under aidlc/ -- including the project.md
  // the workflow had rewritten with the rules it learned. The seed and the
  // project's own rules are the same path, so they are recorded separately and
  // removal reads only one of the two lists.
  const src = makePayload();
  const root = emptyProject();
  install(src, root);

  const receipt = readReceipt(root);
  assert.ok(receipt.seeded.length > 0, 'seeded paths must be recorded');
  assert.ok(
    receipt.seeded.some((rel) => rel.includes('project.md')),
    'the file the workflow accumulates rules in must be among them'
  );
  for (const rel of receipt.files) {
    assert.ok(
      !rel.startsWith('aidlc/') && !rel.startsWith(`aidlc${path.sep}`),
      `removal list must not name a seeded path: ${rel}`
    );
  }
});

test('a receipt naming a seeded path anyway is refused that deletion', () => {
  // A receipt from an older build, or one edited by hand, could still list a path
  // under the seed. The planner filters rather than trusts, because the cost of
  // being wrong is a project's accumulated rules.
  const root = emptyProject();
  fs.mkdirSync(path.join(root, '.kiro'), { recursive: true });
  fs.writeFileSync(
    path.join(root, ...state.RECEIPT_PATH),
    JSON.stringify({
      schemaVersion: 1,
      files: [
        '.kiro/agents/aidlc.json',
        'aidlc/spaces/default/memory/project.md',
        'aidlc'
      ],
      appended: []
    })
  );
  const removal = plan.planRemoval(state.readInstallState(root));
  const targets = removal.ops.map((op) => op.to);
  assert.ok(targets.includes('.kiro/agents/aidlc.json'));
  assert.ok(!targets.some((target) => target.startsWith('aidlc')));
  assert.equal(removal.protectedPaths.length, 2);
});

test('removal restores a shared file to what the project had before', () => {
  const src = makePayload();
  const root = emptyProject();
  const original = '# my own notes\nkeep me\n';
  fs.writeFileSync(path.join(root, 'AGENTS.md'), original);
  install(src, root);

  const removal = plan.planRemoval(state.readInstallState(root));
  apply.applyRemoval({ root, ops: removal.ops });

  const after = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(after, /keep me/);
  assert.ok(!after.includes(plan.MARKER_BEGIN));
  assert.ok(!after.includes('upstream agent instructions'));
});

test('removal deletes a shared file it created entirely', () => {
  const src = makePayload();
  const root = emptyProject();
  install(src, root);
  apply.applyRemoval({ root, ops: plan.planRemoval(state.readInstallState(root)).ops });
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
});

test('removal leaves a marked section alone when someone edited the markers away', () => {
  // Removing a guessed range would take their edit with it.
  const src = makePayload();
  const root = emptyProject();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# mine\n');
  install(src, root);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# mine\nsomeone rewrote this by hand\n');

  const applied = apply.applyRemoval({
    root,
    ops: plan.planRemoval(state.readInstallState(root)).ops
  });
  assert.ok(applied.kept.some((entry) => entry.reason === 'markers-not-found'));
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /by hand/);
});

test('removal after a reinstall still removes everything, using the latest receipt', () => {
  const src = makePayload();
  const root = emptyProject();
  install(src, root);
  install(src, root);
  const applied = apply.applyRemoval({
    root,
    ops: plan.planRemoval(state.readInstallState(root)).ops
  });
  assert.deepEqual(applied.kept, []);
  assert.equal(fs.existsSync(path.join(root, '.kiro')), false);
});

test('a v2 install into a project that has v1 keeps v1 rules that live inside .kiro/', () => {
  // The two generations share .kiro/. v2 owns it wholesale except for the
  // directories v1's own installer created there, and previewInstall tells the user
  // v1 files are left exactly as they are. Before this was handled, installing v2
  // over v1 deleted v1's steering rules and rule details -- silently, while the
  // preview promised otherwise.
  const src = makePayload();
  const root = emptyProject();
  const v1Files = [
    '.kiro/steering/aws-aidlc-rules/core-workflow.md',
    '.kiro/aws-aidlc-rule-details/common/x.md',
    '.kiro/aws-aidlc-rule-details/inception/y.md',
    '.aidlc-rule-details/z.md',
    'CLAUDE.md'
  ];
  for (const rel of v1Files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `v1:${rel}`);
  }

  const { result } = install(src, root);
  assert.equal(result.ok, true);

  for (const rel of v1Files) {
    const full = path.join(root, rel);
    assert.ok(fs.existsSync(full), `v2 install removed a v1 file: ${rel}`);
    assert.equal(fs.readFileSync(full, 'utf8'), `v1:${rel}`, `v2 install modified ${rel}`);
  }
  // And v2 still landed.
  assert.ok(fs.existsSync(path.join(root, '.kiro', 'agents', 'aidlc.json')));
});

test('preserved subtrees survive a reinstall as well as a first install', () => {
  const src = makePayload();
  const root = emptyProject();
  const rel = '.kiro/aws-aidlc-rule-details/common/x.md';
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), 'v1 content');

  install(src, root);
  install(src, root);

  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), 'v1 content');
  // The receipt is preserved by the same mechanism, so it must also still be there.
  assert.ok(fs.existsSync(path.join(root, ...state.RECEIPT_PATH)));
});

test('a preserved path that does not exist is not an error', () => {
  // A first install has no receipt and no v1 rules to carry through.
  const src = makePayload();
  const root = emptyProject();
  const { result } = install(src, root);
  assert.equal(result.ok, true);
});

test('removal never takes back a preserved v1 path', () => {
  // Those files were not written by this extension, so they are not in the receipt
  // and removal has no reason to touch them. Asserted because the preserve list and
  // the removal list are maintained separately.
  const src = makePayload();
  const root = emptyProject();
  const rel = '.kiro/steering/aws-aidlc-rules/core-workflow.md';
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), 'v1 content');
  install(src, root);

  apply.applyRemoval({ root, ops: plan.planRemoval(state.readInstallState(root)).ops });
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), 'v1 content');
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

test('a destination equal to the project root is refused, so a tree replace cannot erase it', () => {
  // REPLACE_TREE deletes its target recursively. A payload entry named '', '.' or
  // './' resolves to the root, and the payload's top-level names become these
  // destinations verbatim over the network -- so a single malformed entry would
  // have erased the user's whole project. Refused strictly, not merely bounded.
  const root = emptyProject();
  for (const rel of ['', '.', './', ' ', undefined, null]) {
    assert.equal(apply.resolveInside(root, rel), undefined, `must refuse ${JSON.stringify(rel)}`);
  }
  assert.ok(apply.resolveInside(root, '.kiro'));
  assert.ok(apply.resolveInside(root, 'a/b/c.md'));
  for (const rel of ['../x', '/etc/passwd', 'a/../..']) {
    assert.equal(apply.resolveInside(root, rel), undefined, `must refuse ${rel}`);
  }
});

test('a plan whose entry names the root leaves the project intact', () => {
  const src = makePayload();
  const root = emptyProject();
  fs.writeFileSync(path.join(root, 'important.txt'), 'do not lose me');

  const result = apply.applyPlan({
    payloadDir: src,
    root,
    ops: [{ type: plan.OP.REPLACE_TREE, from: '.kiro', to: '.', preserve: [] }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'escapes-root');
  assert.equal(fs.readFileSync(path.join(root, 'important.txt'), 'utf8'), 'do not lose me');
});

test('a payload entry naming a path outside the project is refused', () => {
  // The payload arrives over the network, so a traversing name is a real input.
  const src = makePayload();
  const root = emptyProject();
  const result = apply.applyPlan({
    payloadDir: src,
    root,
    ops: [{ type: plan.OP.COPY_FILE, from: 'AGENTS.md', to: '../escaped.md' }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'escapes-root');
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escaped.md')), false);
});

test('a failure part way through still reports everything that was written', () => {
  const src = makePayload();
  const root = emptyProject();
  const ops = [
    { type: plan.OP.SEED_TREE, from: 'aidlc', to: 'aidlc' },
    { type: plan.OP.COPY_FILE, from: 'AGENTS.md', to: '../escaped.md' }
  ];
  const result = apply.applyPlan({ payloadDir: src, root, ops });
  assert.equal(result.ok, false);
  // Seeded paths land in their own list, not in the removal list, so a partial
  // install is reported through both and the caller can undo what is safe to undo.
  assert.ok(result.seeded.length > 0);
  assert.ok(result.seeded.every((rel) => fs.existsSync(path.join(root, rel))));
  assert.deepEqual(result.written, []);
});

test('seeding never replaces a file that is already there', () => {
  const src = makePayload();
  const root = emptyProject();
  const target = path.join(root, 'aidlc', 'spaces', 'default', 'memory', 'org.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '# edited before the first run\n');

  apply.applyPlan({
    payloadDir: src,
    root,
    ops: [{ type: plan.OP.SEED_TREE, from: 'aidlc', to: 'aidlc' }]
  });
  assert.match(fs.readFileSync(target, 'utf8'), /edited before the first run/);
});

// ---------------------------------------------------------------------------
// Payload fetch: argument handling, offline
// ---------------------------------------------------------------------------

test('the payload comes from a release asset, not from the repository tree', () => {
  // Upstream restructured on 2026-09-08: dist/<harness>/ is gone, the repository now
  // holds sources, and stage-graph.json and scope-grid.json are not committed at all --
  // they are built and shipped in the release tarball. A repository tarball therefore
  // contains nothing installable, which is why the previous approach failed with
  // "tar: */dist/kiro-ide/*: Not found in archive".
  assert.match(payload.RELEASE_API, /\/releases\/latest$/);
  assert.match(payload.RELEASE_API, new RegExp(payload.REPO.replace('/', '\\/')));
  assert.equal(payload.PAYLOAD_PREFIX, 'runtime');
});

test('the runtime asset is matched by shape, so a version bump does not break it', () => {
  // The version is in the filename and upstream bumps it every release, so matching an
  // exact name would break on the next one.
  assert.ok(payload.RUNTIME_ASSET.test('aidlc-runtime-2.8.0.tar.gz'));
  assert.ok(payload.RUNTIME_ASSET.test('aidlc-runtime-10.0.0-rc1.tar.gz'));
  // And it must not match the platform binaries shipped alongside it.
  for (const name of [
    'aidlc-darwin-arm64',
    'aidlc-linux-x64',
    'aidlc-windows-x64.exe',
    'checksums.txt',
    'install.sh',
    'version.json',
    'aidlc-release.intoto.jsonl'
  ]) {
    assert.equal(payload.RUNTIME_ASSET.test(name), false, `matched a non-payload asset: ${name}`);
  }
});

test('each harness maps to a directory the release actually ships', () => {
  // `dist/kiro-cli` became `dist/kiro` and then `runtime/kiro`. The KEY stays
  // `kiro-cli` because install receipts already on disk record it, and renaming the key
  // would make those unreadable. Only the path moved.
  assert.deepEqual(payload.HARNESSES, { 'kiro-ide': 'kiro-ide', 'kiro-cli': 'kiro' });
  for (const [key, dir] of Object.entries(payload.HARNESSES)) {
    assert.ok(dir.length > 0, `${key} maps to nothing`);
    assert.ok(!dir.includes('/'), `${key} maps to a nested path: ${dir}`);
  }
});

test('a harness that was never verified is refused before any request', async () => {
  for (const harness of ['claude', 'codex', 'copilot', 'cursor', 'opencode', '', undefined, '../..']) {
    const result = await payload.fetchPayload({ harness });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown-harness');
  }
});

test('a release carrying no runtime asset is named, not reported as a network fault', () => {
  // A release that exists but ships no runtime tarball means upstream changed how it
  // publishes -- a different problem from being offline, and one a person can act on.
  const text = payload.describeFetchFailure(
    { reason: 'no-runtime-asset', text: 'Release v9 carries no aidlc-runtime tarball.' },
    { target: 'v9', pinned: true }
  );
  assert.match(text, /runtime/i);
});

test('a missing archive reads as a missing version, not as a network fault', () => {
  const text = payload.describeFetchFailure(
    { reason: 'http-status', status: 404 },
    { target: 'v2.8.0', pinned: true }
  );
  assert.match(text, /v2\.8\.0/);
});

test('resolving the release never throws, and says why when it cannot', async () => {
  // Unauthenticated API calls are rate limited and a proxy may block api.github.com.
  // Neither may take the install down with an exception.
  const result = await payload.resolveRelease();
  assert.equal(typeof result.ok, 'boolean');
  if (!result.ok) {
    assert.ok(['release-unreadable', 'no-runtime-asset'].includes(result.reason), result.reason);
  } else {
    assert.match(result.url, /^https:\/\//);
  }
});
