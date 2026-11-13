'use strict';

// The /aidlc command builder: choices in, one command out, with the engine's documented
// grammar. `composeCommand` is pure here and is the very function the page's script runs
// (embedded by source), so these cases are the page's behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

const { composeCommand, renderCommandBuilder, acceptablePrompt } = require('../src/aidlc/command-builder');

test('nothing picked composes /aidlc alone, the engine\'s own recommended start', () => {
  assert.deepEqual(composeCommand({}), { text: '/aidlc', placeholder: false, prompt: '/aidlc ' });
  assert.deepEqual(composeCommand(undefined).text, '/aidlc');
});

test('propose: the description follows /aidlc unquoted, as in the engine\'s help', () => {
  assert.equal(composeCommand({ kind: 'propose', description: '  Fix the  login timeout bug ' }).text, '/aidlc Fix the login timeout bug');
});

test('a named plan uses --scope, never the bare word, and quotes the task', () => {
  // A bare scope word before free text is ambiguous when it is also English ("feature
  // flags for billing"); the engine stops to ask. The flag form never does.
  assert.equal(composeCommand({ kind: 'workshop', description: 'Add a review mode' }).text, '/aidlc --scope workshop "Add a review mode"');
  assert.equal(composeCommand({ kind: 'bugfix' }).text, '/aidlc --scope bugfix');
  assert.equal(composeCommand({ kind: 'poc' }).text, '/aidlc --scope poc');
  assert.equal(composeCommand({ kind: 'scope', scope: 'mvp', description: 'x' }).text, '/aidlc --scope mvp "x"');
  // The scope name is restricted to what a slug can be, so the select cannot inject.
  assert.equal(composeCommand({ kind: 'scope', scope: 'mvp" --evil', description: 'x' }).text, '/aidlc --scope mvp--evil "x"');
  assert.equal(composeCommand({ kind: 'scope' }).text, '/aidlc', 'no scope chosen yet: nothing is guessed');
});

test('compose on existing code carries --project-type brownfield unless the person said otherwise', () => {
  assert.equal(composeCommand({ kind: 'compose-brownfield' }).text, '/aidlc compose --project-type brownfield');
  assert.equal(composeCommand({ kind: 'compose-brownfield', projectType: 'greenfield' }).text, '/aidlc compose --project-type greenfield');
  assert.equal(composeCommand({ kind: 'compose', projectType: 'default' }).text, '/aidlc compose');
});

test('the dials append in a fixed order and only when set', () => {
  const c = composeCommand({ kind: 'compose-brownfield', depth: 'minimal', testStrategy: 'minimal', description: 'CHANGE.md를 기준으로 오답 복습 모드를 추가한다' });
  assert.equal(c.text, '/aidlc compose --project-type brownfield --depth minimal --test-strategy minimal "CHANGE.md를 기준으로 오답 복습 모드를 추가한다"');
  assert.equal(composeCommand({ depth: 'default', testStrategy: 'default' }).text, '/aidlc');
  assert.equal(composeCommand({ kind: 'bugfix', testStrategy: 'comprehensive' }).text, '/aidlc --scope bugfix --test-strategy comprehensive');
});

test('a quoted task escapes its own double quotes and collapses newlines', () => {
  assert.equal(composeCommand({ kind: 'workshop', description: 'say "hi"\nplease' }).text, '/aidlc --scope workshop "say \\"hi\\" please"');
});

test('the placeholder is shown only where a task is expected and none is typed', () => {
  assert.equal(composeCommand({ kind: 'workshop' }).placeholder, true);
  assert.equal(composeCommand({ kind: 'compose' }).placeholder, true);
  assert.equal(composeCommand({ kind: 'propose' }).placeholder, false, 'propose with nothing is /aidlc, which the engine takes');
  assert.equal(composeCommand({ kind: 'workshop', description: 'x' }).placeholder, false);
});

test('the prompt ends with a space so the person can type on, and the host accepts only that shape', () => {
  assert.equal(composeCommand({ kind: 'poc' }).prompt, '/aidlc --scope poc ');
  assert.equal(acceptablePrompt('/aidlc '), true);
  assert.equal(acceptablePrompt('/aidlc --scope poc "x" '), true);
  assert.equal(acceptablePrompt('/aidlcx'), false);
  assert.equal(acceptablePrompt('rm -rf /'), false);
  assert.equal(acceptablePrompt('/aidlc\nrm -rf /'), false, 'no newlines: one line into the chat input');
  assert.equal(acceptablePrompt('/aidlc ' + 'x'.repeat(5000)), false);
  assert.equal(acceptablePrompt(42), false);
});

test('the page embeds composeCommand by source, and the embedded copy composes identically', () => {
  const html = renderCommandBuilder({ catalogue: [{ name: 'poc', run: 5, total: 30, depth: 'minimal' }], nonce: 'n', guideHref: 'command:x' });
  const embedded = /const compose = (function composeCommand\(choices\) \{[\s\S]*?\n\});\n/.exec(html);
  assert.ok(embedded, 'composeCommand source is in the script');
  const fn = vm.runInNewContext(`(${embedded[1]})`);
  for (const choices of [{}, { kind: 'workshop', description: 'a "b"' }, { kind: 'compose-brownfield', depth: 'minimal' }, { kind: 'scope', scope: 'poc', testStrategy: 'standard', description: 'x' }]) {
    // Across vm contexts object prototypes differ; compare the values.
    assert.equal(JSON.stringify(fn(choices)), JSON.stringify(composeCommand(choices)));
  }
});

test('the builder offers a preset only when the installed engine has that scope, and the picker only with a catalogue', () => {
  const full = renderCommandBuilder({ catalogue: [{ name: 'workshop', run: 23, total: 30 }, { name: 'bugfix', run: 6, total: 30 }], nonce: 'n', guideHref: 'command:x' });
  assert.match(full, /value="workshop"/);
  assert.match(full, /value="bugfix"/);
  assert.doesNotMatch(full, /id="kind-poc"/, 'poc is not in this engine');
  assert.match(full, /<select id="scopePick"/);
  assert.match(full, /<option value="workshop">workshop · 23\/30<\/option>/);
  // No catalogue: the three presets the engine's help lists, no picker.
  const none = renderCommandBuilder({ catalogue: [], nonce: 'n', guideHref: 'command:x' });
  for (const k of ['workshop', 'bugfix', 'poc', 'compose-brownfield', 'propose']) assert.match(none, new RegExp(`id="kind-${k}"`));
  assert.doesNotMatch(none, /<select id="scopePick"/);
  // Every option shows the flag it adds, so the command is explained by construction.
  assert.match(full, /<span class="opt-flag">--scope workshop<\/span>/);
  assert.match(full, /<span class="opt-flag">--depth minimal<\/span>/);
  assert.match(full, /<span class="opt-flag">--test-strategy comprehensive<\/span>/);
  assert.match(full, /<span class="opt-flag">--project-type brownfield<\/span>/);
  assert.doesNotMatch(full, / style="/, 'the page CSP drops inline styles');
});
