'use strict';

// Bundle contract tests.
//
// The extension derives real behavior from the shape of the bundled AI-DLC rule
// snapshot under rules/aidlc-rules/:
//
//   * getBundledStageStepCounts() counts *.md per stage directory and uses that
//     count as the progress denominator.
//   * BUNDLED_STAGE_STEP_FALLBACK hardcodes those same counts for the case where
//     the bundle cannot be read. If the bundle changes and the fallback does not,
//     progress silently shifts.
//   * ensureAidlcRules() copies aws-aidlc-rules/core-workflow.md and the whole
//     aws-aidlc-rule-details/ tree into the user's project.
//   * extensions/collaboration/persona-proxy/ is a local addition that does NOT
//     exist upstream. A careless bundle sync would delete it.
//
// These tests pin that shape so a bundle update cannot break the extension
// without CI noticing first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const BUNDLE_ROOT = path.join(REPO_ROOT, 'rules', 'aidlc-rules');
const RULE_DETAILS = path.join(BUNDLE_ROOT, 'aws-aidlc-rule-details');

// Keep in sync with BUNDLED_STAGE_STEP_FALLBACK in src/extension.js.
const EXPECTED_STAGE_STEP_COUNTS = {
  inception: 7,
  construction: 6,
  operations: 1
};

function countMarkdown(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md')).length;
}

test('bundle root and core workflow file exist', () => {
  assert.ok(fs.existsSync(BUNDLE_ROOT), `missing bundle root: ${BUNDLE_ROOT}`);
  const coreWorkflow = path.join(BUNDLE_ROOT, 'aws-aidlc-rules', 'core-workflow.md');
  assert.ok(fs.existsSync(coreWorkflow), 'core-workflow.md is what ensureAidlcRules copies to CLAUDE.md');
});

test('rule details contains the five expected sections', () => {
  for (const section of ['common', 'inception', 'construction', 'operations', 'extensions']) {
    const dir = path.join(RULE_DETAILS, section);
    assert.ok(fs.existsSync(dir), `missing rule-details section: ${section}`);
  }
});

test('per-stage markdown counts match the hardcoded progress fallback', () => {
  for (const [stage, expected] of Object.entries(EXPECTED_STAGE_STEP_COUNTS)) {
    const actual = countMarkdown(path.join(RULE_DETAILS, stage));
    assert.equal(
      actual,
      expected,
      `${stage}: bundle has ${actual} rule files but BUNDLED_STAGE_STEP_FALLBACK says ${expected}. ` +
        'Update src/extension.js and this test together.'
    );
  }
});

test('every stage directory the extension reads is non-empty', () => {
  for (const stage of Object.keys(EXPECTED_STAGE_STEP_COUNTS)) {
    assert.ok(countMarkdown(path.join(RULE_DETAILS, stage)) > 0, `${stage} would produce a zero denominator`);
  }
});

test('extensions follow the <name>.md + <name>.opt-in.md convention', () => {
  const extensionsRoot = path.join(RULE_DETAILS, 'extensions');
  const optIns = [];

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.opt-in.md')) {
        optIns.push(full);
      }
    }
  })(extensionsRoot);

  assert.ok(optIns.length > 0, 'no extension opt-in files found');

  for (const optIn of optIns) {
    // core-workflow.md derives the rules file by stripping .opt-in.md and appending .md
    const rulesFile = optIn.replace(/\.opt-in\.md$/, '.md');
    assert.ok(fs.existsSync(rulesFile), `opt-in without matching rules file: ${optIn}`);
  }
});

test('persona-proxy extension is present (local addition, absent upstream)', () => {
  const dir = path.join(RULE_DETAILS, 'extensions', 'collaboration', 'persona-proxy');
  assert.ok(fs.existsSync(path.join(dir, 'persona-proxy.md')), 'persona-proxy.md was lost');
  assert.ok(fs.existsSync(path.join(dir, 'persona-proxy.opt-in.md')), 'persona-proxy.opt-in.md was lost');
});

test('bundle VERSION is readable and non-empty', () => {
  const version = fs.readFileSync(path.join(BUNDLE_ROOT, 'VERSION'), 'utf8').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, `unexpected VERSION content: ${JSON.stringify(version)}`);
});
