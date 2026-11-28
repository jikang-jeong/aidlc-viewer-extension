'use strict';

// `npm test`: run exactly tests/*.test.js, on every Node this extension supports.
//
// Why a script rather than a one-liner in package.json. Each shorter form fails somewhere:
//
//   node --test "tests/*.test.js"   npm hands the quoted glob to node unexpanded, and Node 20
//                                   does not expand globs itself ("Could not find").
//   node --test tests/*.test.js     the shell expands it on macOS/Linux; cmd.exe on Windows
//                                   does not.
//   node --test tests/              Node 20 searches the directory; Node 22 runs it as a module.
//   node --test                     the runner's default patterns, which worked until the
//                                   Trace Explorer brought a trimmed real project as a fixture:
//                                   on Node 22.18+ (type stripping on by default) the patterns
//                                   match the fixture's 23 `*.test.ts` files too, and they run
//                                   as tests. Empty placeholders today, so they pass; a fixture
//                                   that gains an enum or a decorator fails CI on Node 22 and
//                                   not on Node 20, and "679 tests" on one Node is "702" on the
//                                   other.
//
// Explicit file arguments are honoured identically by every Node version and need no
// shell, so the suite is listed here: the files directly under tests/ ending in .test.js,
// sorted. Fixtures (tests/fixtures/**), helpers (tests/helpers/**) and anything deeper are
// never tests, whatever they are named. Extra arguments are passed to node before the
// files (e.g. `npm test -- --test-reporter=tap`).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');

// The suite: a deterministic list, relative to the repository root.
function testFiles() {
  return fs
    .readdirSync(TESTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.join('tests', entry.name))
    .sort();
}

function main(argv) {
  const files = testFiles();
  if (files.length === 0) {
    console.error('run-tests: no tests/*.test.js found');
    return 1;
  }
  const result = spawnSync(process.execPath, ['--test', ...argv, ...files], {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(`run-tests: ${result.error.message}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { testFiles, TESTS_DIR };
