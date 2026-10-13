'use strict';

// Pins that every command the UI can invoke is actually registered.
//
// "command 'markdownWatchViewer.showCredits' not found" shipped to a real machine with
// 276 tests green. The tree row carried the command, package.json declared it, and the
// registerCommand line was missing -- an edit had silently failed to match its anchor.
// Nothing executed the activate() wiring, so nothing noticed.
//
// This test reads the three places a command can be named and requires them to agree:
//   - package.json contributes.commands         (what the palette offers)
//   - `command: '...'` on tree items / buttons   (what a click invokes)
//   - registerCommand('...') in activate()        (what actually exists)
// A command named in either of the first two and absent from the third is the exact
// shape of the bug.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXTENSION = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function registered() {
  return new Set([...EXTENSION.matchAll(/registerCommand\(\s*'([^']+)'/g)].map((m) => m[1]));
}

test('every command declared in package.json is registered in activate()', () => {
  const have = registered();
  const declared = (PKG.contributes.commands ?? []).map((c) => c.command);
  const missing = declared.filter((c) => !have.has(c));
  assert.deepEqual(missing, [], `declared but never registered: ${missing.join(', ')}`);
});

test('every command a tree item or button invokes is registered', () => {
  const have = registered();
  const invoked = [...EXTENSION.matchAll(/command:\s*'(markdownWatchViewer\.[^']+)'/g)].map((m) => m[1]);
  const missing = [...new Set(invoked)].filter((c) => !have.has(c));
  assert.deepEqual(missing, [], `invoked by the UI but never registered: ${missing.join(', ')}`);
});

test('every command in menus and activation events is declared', () => {
  const declared = new Set((PKG.contributes.commands ?? []).map((c) => c.command));
  const inMenus = Object.values(PKG.contributes.menus ?? {}).flat().map((m) => m.command).filter(Boolean);
  const inActivation = (PKG.activationEvents ?? [])
    .filter((e) => e.startsWith('onCommand:'))
    .map((e) => e.slice('onCommand:'.length));
  const missing = [...new Set([...inMenus, ...inActivation])].filter((c) => !declared.has(c));
  assert.deepEqual(missing, [], `referenced but not declared: ${missing.join(', ')}`);
});
