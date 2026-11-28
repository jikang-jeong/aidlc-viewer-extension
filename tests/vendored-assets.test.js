'use strict';

// The browser libraries shipped under media/ are copied from their npm releases and never
// edited. These tests pin that: the version each file says it is matches the version the
// notices name, the Mermaid file is byte-for-byte the recorded npm build, and the Mermaid
// file carries the js-yaml fix it was updated for.
//
// Why Mermaid gets the hash. 11.14.0 shipped for months with nine GitHub security
// advisories against that version and a js-yaml 4.1.1 inside it with a high-severity
// denial-of-service advisory (GHSA-2883-xcg3-v3hh), and nothing here could tell. The
// viewer hands every ```mermaid block in a project's markdown to this file. The hash
// makes "the npm release, unmodified" a checked statement: anyone can compute it over
// dist/mermaid.min.js from the tarball whose integrity the notices record. When Mermaid is
// updated again, update the notices and this file together, in the same commit.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MEDIA = path.join(__dirname, '..', 'media');
const notices = fs.readFileSync(path.join(MEDIA, 'THIRD-PARTY-NOTICES.md'), 'utf8');

function noticedVersion(name) {
  const m = new RegExp(`^## ${name} (\\d+\\.\\d+\\.\\d+) \\(`, 'm').exec(notices);
  assert.ok(m, `THIRD-PARTY-NOTICES.md has no "## ${name} x.y.z (" heading`);
  return m[1];
}

test('mermaid.min.js is the npm 12.4.0 build, byte for byte, and the notices say so', () => {
  const file = fs.readFileSync(path.join(MEDIA, 'mermaid.min.js'));
  const sha256 = crypto.createHash('sha256').update(file).digest('hex');
  assert.equal(sha256, 'c0891e4c0413d0710ad193b431d8cbbe9d031636e51c467d11daa4721ba22094');
  assert.ok(notices.includes(`sha256 \`${sha256}\``), 'the notices record the hash of the file that ships');
  const version = noticedVersion('mermaid');
  assert.equal(version, '12.4.0');
  const text = file.toString('latin1');
  assert.ok(text.includes(`"${version}"`), 'the bundle names the same version');
  assert.ok(!text.includes('"11.14.0"'), 'the advisory-laden build is gone');
  // The global the viewer's inline script uses, unchanged from 11.x.
  assert.ok(text.includes('globalThis["mermaid"]'), 'the IIFE still exports globalThis.mermaid');
});

test('the Mermaid bundle carries js-yaml 4.3.2 or later, which fixed GHSA-2883-xcg3-v3hh', () => {
  // The fix added a new error, 'abnormal merge sequence size', beside the budget strings
  // 4.3.0 introduced. 11.17.2 has the budget strings and not this one (js-yaml 4.3.1);
  // 11.14.0 has neither (4.1.1). String literals survive minification, version numbers do not.
  const text = fs.readFileSync(path.join(MEDIA, 'mermaid.min.js'), 'latin1');
  assert.ok(text.includes('merge keys exceeded maxTotalMergeKeys'), 'js-yaml 4.3.x budget strings');
  assert.ok(text.includes('abnormal merge sequence size'), 'the 4.3.2 fix');
});

test('the viewer keeps the dagre layout Mermaid 12 switched away from by default', () => {
  // Mermaid 12.0 made ELK the default for flowchart, state, class and ER diagrams, which
  // lays out every existing diagram differently. The security update must not redraw them.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  assert.match(source, /mermaid\.initialize\(\{[^}]*layout: 'dagre'[^}]*\}\)/);
});

test('markdown-it and its task-list plugin are the npm builds the notices name', () => {
  // Both compared byte for byte against their npm tarballs on 2026-11-28; the hashes pin
  // that. (The task-lists header inside npm's own 2.1.1 build still reads 2.1.0, so the
  // version is checked through the hash, not the banner.)
  const sha = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(MEDIA, name))).digest('hex');
  const mdit = fs.readFileSync(path.join(MEDIA, 'markdown-it.min.js'), 'utf8');
  assert.equal(noticedVersion('markdown-it'), '14.3.3');
  assert.ok(mdit.startsWith('/*! markdown-it 14.3.3 '), 'the markdown-it banner names the noticed version');
  assert.equal(sha('markdown-it.min.js'), '494ba53db1aac9f676317dda7062bd9545b5f0bbe3f12b0ab1ab4f813825cfb0');
  assert.equal(noticedVersion('markdown-it-task-lists'), '2.1.1');
  assert.equal(sha('markdown-it-task-lists.min.js'), '4f3b23f41bb3787957da2602fbccc4df0d017928c1fce62583159e096b832a81');
});
