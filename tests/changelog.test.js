'use strict';

// The release notes live in two places that two different pages read: the README's
// "What's New" section (the marketplace's overview tab) and CHANGELOG.md (its Changes
// tab, which was empty until 0.1.3 because no changelog shipped in the vsix). Rather
// than a build step that derives one from the other, the two are kept identical by
// this test: same versions, same order, same text under each. Edit one, edit both.
//
// Also pins the package manifest against GitHub issue #3: a bracketed key under
// `configurationDefaults` is a language override, `[markdownWatchViewer.tree]` named a
// view and not a language, and on a Windows Kiro it stopped every other extension's
// settings from registering (`git.enabled` "not a registered configuration").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Entries as [version, body] in file order. README headings are `### x.y.z` under
// `## What's New`; CHANGELOG headings are `## x.y.z`. Bodies are compared with trailing
// whitespace trimmed so a final newline cannot fail the suite.
function entries(text, headingPrefix) {
  const re = new RegExp(`^${headingPrefix} (\\d+\\.\\d+\\.\\d+)\\s*$`, 'gm');
  const out = [];
  const matches = [...text.matchAll(re)];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    let body = text.slice(start, end);
    // The README section ends at the next `## ` heading; cut there.
    const nextSection = body.search(/\n## [^#]/);
    if (nextSection >= 0) body = body.slice(0, nextSection);
    out.push([matches[i][1], body.trim()]);
  }
  return out;
}

function whatsNewSection() {
  const marker = "\n## What's New\n";
  const start = readme.indexOf(marker);
  assert.ok(start >= 0, "README has a What's New section");
  const rest = readme.slice(start + marker.length);
  const next = rest.search(/\n## [^#]/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test("CHANGELOG.md carries the same versions, in the same order, as the README's What's New", () => {
  const fromReadme = entries(whatsNewSection(), '###');
  const fromChangelog = entries(changelog, '##');
  assert.ok(fromReadme.length > 0);
  assert.deepEqual(
    fromChangelog.map(([v]) => v),
    fromReadme.map(([v]) => v)
  );
});

test("each CHANGELOG.md entry is the README's entry, word for word", () => {
  const fromReadme = new Map(entries(whatsNewSection(), '###'));
  for (const [version, body] of entries(changelog, '##')) {
    assert.equal(body, fromReadme.get(version), `entry ${version} differs between CHANGELOG.md and README.md`);
  }
});

test('the newest entry in both is the version package.json is about to ship', () => {
  // A release commit bumps the version; the note for it must exist. A local rebuild of
  // an unpublished version keeps the same number, so this holds between releases too.
  const [newestReadme] = entries(whatsNewSection(), '###')[0];
  const [newestChangelog] = entries(changelog, '##')[0];
  assert.equal(newestReadme, pkg.version);
  assert.equal(newestChangelog, pkg.version);
});

test('CHANGELOG.md is not excluded from the vsix', () => {
  // open-vsx shows the Changes tab from CHANGELOG.md inside the package; the API's
  // `files` had no `changelog` entry for 0.1.2 because none shipped.
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
  assert.ok(!/^CHANGELOG/m.test(ignore), 'CHANGELOG.md must ship');
});

test('configurationDefaults has no bracketed (language-override) key -- issue #3', () => {
  const defaults = pkg.contributes.configurationDefaults ?? {};
  const bracketed = Object.keys(defaults).filter((k) => k.startsWith('['));
  assert.deepEqual(bracketed, [], 'a [..] key here is a language override and must name a language id, not a view');
});
