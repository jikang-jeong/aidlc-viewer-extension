'use strict';

// CI contract tests.
//
// The GitHub Actions `verify` job ran red on both of its first runs while `npm test`
// was green on every developer machine, for two reasons the local run could not show:
//
//   * `node --test "tests/*.test.js"`: npm hands the quoted glob to node unexpanded,
//     and Node 20 does not expand globs itself (that arrived in 21), so it printed
//     "Could not find 'tests/*.test.js'". The directory form `node --test tests/` is
//     the mirror image: Node 20 searches it, Node 22 runs it as a module and fails.
//     Bare `node --test` fixed both, until the Trace Explorer brought a trimmed real
//     project under tests/fixtures/: its 23 `*.test.ts` files match the runner's default
//     patterns on Node 22.18+ (type stripping on by default) and run as tests there, and
//     not on Node 20. So `npm test` is now tools/run-tests.js, which hands node --test the
//     explicit list of tests/*.test.js: no shell, no glob, no default patterns.
//   * tests/v1-isolation.test.js compares the strip's tag and tooltip phrase against
//     the 0.0.19 source with `git show e17e4ad:src/extension.js`. actions/checkout
//     clones one commit deep by default, so git had no such object.
//
// These pin the settings. The behaviour itself is pinned by the CI matrix: only a real
// Node 20 and Node 22 can show the failures, and the matrix runs both.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const runner = require('../tools/run-tests');

test('the test script is the explicit runner, so every Node runs the same files', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts.test,
    'node tools/run-tests.js',
    'a quoted glob is not expanded on Node 20, a directory is run as a module on Node 22, and the ' +
      'default patterns run the fixture\'s *.test.ts files on Node 22; list the files explicitly'
  );
});

test('the runner lists exactly tests/*.test.js, and none of the files the default patterns would add', () => {
  const files = runner.testFiles();
  assert.ok(files.includes(path.join('tests', 'ci-contract.test.js')), 'this file is in the suite');
  assert.deepEqual(files, [...files].sort(), 'a deterministic order');
  for (const file of files) {
    assert.equal(path.dirname(file), 'tests', `${file}: only files directly under tests/`);
    assert.match(path.basename(file), /\.test\.js$/, `${file}: only *.test.js`);
  }
  // What bare `node --test` would also run on a Node with type stripping: the fixture's
  // test files. They are a real project's names, so they stay; the runner never sees them.
  const fixtureTests = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/(\.test|-test|_test)\.[cm]?[jt]s$|^test[-.]/.test(entry.name) || full.split(path.sep).includes('test')) fixtureTests.push(path.relative(REPO_ROOT, full));
    }
  };
  walk(path.join(REPO_ROOT, 'tests', 'fixtures'));
  assert.ok(fixtureTests.length > 0, 'the fixture still carries test-named files (otherwise this guard is moot)');
  for (const file of fixtureTests) assert.ok(!files.includes(file), `${file} must not be run as a test`);
});

test('the verify job checks out the full history the 0.0.19 comparison needs', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const start = workflow.indexOf('\n  verify:');
  const end = workflow.indexOf('\n  package:');
  assert.ok(start !== -1 && end > start, 'the verify and package jobs moved; this test needs updating');
  const verify = workflow.slice(start, end);
  assert.match(
    verify,
    /uses: actions\/checkout@[^\n]*\n\s+with:\n(?:\s+#[^\n]*\n)*\s+fetch-depth: 0\n/,
    'tests/v1-isolation.test.js runs `git show e17e4ad:...`; a one-commit checkout has no such object'
  );
  // The commit the comparison reads must be the one the workflow comment names.
  const isolation = fs.readFileSync(path.join(__dirname, 'v1-isolation.test.js'), 'utf8');
  const released = /const RELEASED = '([0-9a-f]+)'/.exec(isolation);
  assert.ok(released, 'RELEASED moved in v1-isolation.test.js');
  assert.ok(verify.includes(released[1]), `ci.yml's comment names a different commit than RELEASED (${released[1]})`);
});
