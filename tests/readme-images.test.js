'use strict';

// README images must render in three places: the repository on GitHub, the local file, and
// the open-vsx listing built from the vsix.
//
// What was learnt the hard way on 2026-10-13, across three attempts:
//   - An absolute URL to a branch that has not been pushed is broken everywhere.
//   - open-vsx does NOT serve arbitrary files from inside the vsix; /file/media/x.png is
//     404. A relative path in the shipped README is therefore broken on the listing.
//   - So: the source README uses RELATIVE paths (GitHub and local resolve them against
//     the file), vsce rewrites them to GitHub raw URLs at packaging (--githubBranch main),
//     and the files must actually be on that branch. The last point cannot be checked
//     offline, so the test below checks it online when it can and says so when it cannot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const RAW = 'https://github.com/jikang-jeong/aidlc-viewer-extension/raw/main/';

test('every README image is a relative path to a file that exists', () => {
  assert.ok(images.length > 0, 'the README has images');
  for (const src of images) {
    assert.ok(!/^https?:/.test(src), `${src} is absolute in the source; keep the source relative and let vsce rewrite it`);
    assert.ok(fs.existsSync(path.join(root, src)), `${src} is missing`);
  }
});

test('the package script rewrites relative paths to the main branch, because open-vsx serves no files from the vsix', () => {
  assert.match(pkg.scripts.package, /--githubBranch main/);
  assert.doesNotMatch(pkg.scripts.package, /--no-rewrite-relative-links/, 'the rewrite is the only thing that makes the listing work');
  assert.match(pkg.scripts.package, /npx --yes @vscode\/vsce@\d+\.\d+\.\d+/, 'a bare vsce is not installed here; the script silently failed once');
});

test('every README image is published on the main branch (checked online; skipped offline)', (t) => {
  for (const src of images) {
    let code;
    try {
      code = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-L', '--max-time', '8', RAW + src], { encoding: 'utf8' }).trim();
    } catch {
      t.skip('no network');
      return;
    }
    if (code === '000') {
      t.skip('no network');
      return;
    }
    assert.equal(code, '200', `${RAW}${src} is ${code}; the listing will show a broken image until this file is pushed`);
  }
});

test('the demo gif is not shipped: it was 5.7MB of a 7.4MB package', () => {
  assert.ok(ignore.includes('media/merged.gif'));
  assert.ok(!images.includes('media/merged.gif'), 'and the README no longer embeds it');
});
