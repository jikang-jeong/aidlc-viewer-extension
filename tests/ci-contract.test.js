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
//     Bare `node --test` finds tests/*.test.js by the runner's default patterns on
//     every supported Node, with no shell and no glob in between.
//   * tests/v1-isolation.test.js compares the strip's tag and tooltip phrase against
//     the 0.0.19 source with `git show e17e4ad:src/extension.js`. actions/checkout
//     clones one commit deep by default, so git had no such object.
//
// These pin the two settings. The behaviour itself is pinned by the CI matrix: only a
// real Node 20 and Node 22 can show the two failures, and the matrix runs both.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

test('the test script is bare node --test, so Node 20 and Node 22 find the same files', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts.test,
    'node --test',
    'a quoted glob is not expanded on Node 20 and a directory argument is run as a module on Node 22; ' +
      'let the runner find tests/*.test.js by its default patterns'
  );
});

test('only tests/*.test.js matches the default patterns the bare runner uses', () => {
  // The runner's default patterns, shared by Node 20 and 22 (node_modules excluded):
  // **/*.test.{cjs,mjs,js}, **/*-test.*, **/*_test.*, **/test-*.*, **/test.*, **/test/**/*.*
  const matches = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        /(\.test|-test|_test)\.[cm]?js$/.test(entry.name) ||
        /^test-[^/]*\.[cm]?js$/.test(entry.name) ||
        /^test\.[cm]?js$/.test(entry.name) ||
        (/\.[cm]?js$/.test(entry.name) && full.split(path.sep).includes('test'))
      ) {
        matches.push(path.relative(REPO_ROOT, full));
      }
    }
  };
  walk(REPO_ROOT);
  const outside = matches.filter((file) => !file.startsWith(`tests${path.sep}`));
  assert.deepEqual(outside, [], 'a file outside tests/ would be run as a test by bare node --test');
  const suite = fs.readdirSync(path.join(REPO_ROOT, 'tests')).filter((name) => name.endsWith('.test.js'));
  assert.deepEqual(
    matches.map((file) => path.basename(file)).sort(),
    suite.sort(),
    'the bare runner must pick up exactly the suite'
  );
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
