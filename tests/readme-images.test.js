'use strict';

// README images must render in three places: the repository on GitHub, the local file, and
// the marketplace listing built from the vsix. Only one form satisfies all three: a
// RELATIVE path to a file that is shipped in the vsix. GitHub and local viewers resolve it
// against the file; vsce rewrites it to an absolute raw URL when packaging, which is what
// the marketplace shows. An absolute URL to a branch that has not been pushed is broken
// everywhere, which is how the README looked on 2026-10-13.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

test('every README image is a relative path', () => {
  assert.ok(images.length > 0, 'the README has images');
  for (const src of images) {
    assert.ok(!/^https?:/.test(src), `${src} is absolute; it breaks locally and until pushed, and vsce cannot rewrite it`);
  }
});

test('every README image exists and is not excluded from the vsix', () => {
  for (const src of images) {
    assert.ok(fs.existsSync(path.join(root, src)), `${src} is missing`);
    const excluded = ignore.some((pattern) => {
      if (pattern === src) return true;
      if (pattern.endsWith('/**')) return src.startsWith(pattern.slice(0, -3) + '/');
      return false;
    });
    assert.ok(!excluded, `${src} is listed in .vscodeignore and will not be in the vsix`);
  }
});

test('the demo gif is not shipped: it was 5.7MB of a 7.4MB package', () => {
  assert.ok(ignore.includes('media/merged.gif'));
  assert.ok(!images.includes('media/merged.gif'), 'and the README no longer embeds it');
});
