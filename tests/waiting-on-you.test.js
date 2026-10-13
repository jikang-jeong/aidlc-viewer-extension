'use strict';

// Pins "Waiting for you": what the engine writes down when it stops for a person, read as
// structure rather than inferred from ledger order.
//
// Since 2.8 the engine writes each refusal to <intent>/.aidlc-engine/guard-refusals/ with
// its code, stage, blocked action and a list of remedies flagged `requiresHuman`; since
// 2.11 it writes a Plan Approval review request when a plan is parked for a decision. The
// ledger still only says that something stopped. These fixtures are shaped from a real
// 2.11.0 run; the `kind:ask` payload the engine prints at the same moment is NOT read,
// because it is printed to stdout and written nowhere.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const diag = require('../src/aidlc/diagnose');

function intentWith({ refusals = [], plans = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-'));
  const intent = path.join(root, 'aidlc', 'spaces', 'default', 'intents', '261013-x');
  fs.mkdirSync(path.join(intent, 'audit'), { recursive: true });
  const gr = path.join(intent, '.aidlc-engine', 'guard-refusals');
  fs.mkdirSync(gr, { recursive: true });
  refusals.forEach((r, i) => fs.writeFileSync(path.join(gr, `${'a'.repeat(63)}${i}.json`), typeof r === 'string' ? r : JSON.stringify(r)));
  const pa = path.join(root, 'aidlc', '.aidlc-sessions', 'plan-approval');
  fs.mkdirSync(pa, { recursive: true });
  plans.forEach((p, i) => fs.writeFileSync(path.join(pa, `review-request-${'b'.repeat(23)}${i}.json`), typeof p === 'string' ? p : JSON.stringify(p)));
  return { root, intent };
}

const realRefusal = {
  version: 1, count: 2, codes: ['REQUIRED_ARTIFACTS_MISSING'], updatedAt: '2026-10-12T23:16:41Z',
  refusal: {
    code: 'REQUIRED_ARTIFACTS_MISSING', blockedAction: 'present-approval-gate', stage: 'intent-capture', state: 'in-progress',
    userMessage: 'Cannot present "intent-capture" for approval: none of its declared artifacts exist.',
    remedies: [
      { op: 'request-review', action: 'Request the next permitted review.', requiresHuman: false },
      { op: 'request-changes', label: 'Request changes', action: 'Say what to change.', requiresHuman: true }
    ]
  }
};

test("a guard refusal is read as the engine wrote it: code, stage, and which remedies need a person", () => {
  const { root, intent } = intentWith({ refusals: [realRefusal] });
  try {
    const [r] = diag.readGuardRefusals(intent);
    assert.equal(r.code, 'REQUIRED_ARTIFACTS_MISSING');
    assert.equal(r.stage, 'intent-capture');
    assert.equal(r.count, 2);
    assert.equal(r.requiresHuman, true);
    assert.deepEqual(r.remedies.map((m) => m.op), ['request-review', 'request-changes']);
    const d = diag.diagnose(intent, { projectRoot: root });
    assert.equal(d.waitingOnYou.length, 1);
    assert.equal(d.waitingOnYou[0].kind, 'guard-refusal');
    assert.equal(d.waitingOnYou[0].stated, true, 'the engine said it; this is not inferred');
    // Only the human remedy is shown as something to do.
    assert.deepEqual(d.waitingOnYou[0].remedies.map((m) => m.op), ['request-changes']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a refusal the agent can clear itself is not waiting on you", () => {
  const agentOnly = { ...realRefusal, refusal: { ...realRefusal.refusal, remedies: [{ op: 'request-review', requiresHuman: false }] } };
  const { root, intent } = intentWith({ refusals: [agentOnly] });
  try {
    const d = diag.diagnose(intent, { projectRoot: root });
    assert.equal(d.guardRefusals.length, 1, 'still reported as a refusal');
    assert.equal(d.waitingOnYou.length, 0, 'but not as yours to act on');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a parked code-generation plan is waiting on you, per unit, and the engine\'s own beat is not', () => {
  const { root, intent } = intentWith({
    plans: [
      { version: 1, intentId: '261013-x', targetId: 'unit:api' },
      { version: 1, intentId: '261013-x', targetId: 'next:whatever' },
      { version: 1, intentId: 'some-other-intent', targetId: 'unit:zzz' }
    ]
  });
  try {
    const d = diag.diagnose(intent, { projectRoot: root });
    const plans = d.waitingOnYou.filter((w) => w.kind === 'plan-approval');
    assert.equal(plans.length, 1, 'engine beat and other intents are excluded');
    assert.equal(plans[0].unit, 'api');
    assert.equal(plans[0].stated, true);
    assert.match(plans[0].message, /unit "api"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable record is reported as unreadable, never dropped silently or treated as a wait', () => {
  const { root, intent } = intentWith({ refusals: ['{not json'], plans: ['{also not'] });
  try {
    const refusals = diag.readGuardRefusals(intent);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].unreadable, true);
    const d = diag.diagnose(intent, { projectRoot: root });
    assert.equal(d.waitingOnYou.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a project with none of these directories -- every pre-2.8 project -- reads as nothing waiting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'old-'));
  const intent = path.join(root, 'aidlc', 'spaces', 'default', 'intents', 'i');
  fs.mkdirSync(path.join(intent, 'audit'), { recursive: true });
  try {
    assert.deepEqual(diag.readGuardRefusals(intent), []);
    assert.deepEqual(diag.readPlanApprovalRequests(root), []);
    assert.doesNotThrow(() => diag.diagnose(intent, { projectRoot: root }));
    // And without a projectRoot at all -- the old call shape -- it still works.
    assert.doesNotThrow(() => diag.diagnose(intent, {}));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stated wait and an inferred wait on the same stage collapse to the stated one', () => {
  const merged = diag.mergeWaiting(
    [{ stage: 'intent-capture', stated: false, reason: 'inferred from ledger order' }, { stage: 'other', stated: false }],
    [{ requiresHuman: true, stage: 'intent-capture', code: 'X', remedies: [{ op: 'fix', requiresHuman: true }] }],
    []
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].kind, 'guard-refusal');
  assert.equal(merged[0].stated, true);
  assert.equal(merged[1].kind, 'gate');
  assert.equal(merged[1].stage, 'other');
});
