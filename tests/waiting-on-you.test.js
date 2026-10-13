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

// ---------------------------------------------------------------------------
// Questions the engine asked and a person has not answered
// ---------------------------------------------------------------------------
//
// Seen on four real v2 intents on 2026-10-13. A stage that needs decisions writes a
// *questions*.md under <phase>/<stage>/ with one [Answer]: per question -- v1's own
// convention -- and touches .aidlc-human-turn. A project in exactly that state showed
// "Nothing is waiting on your decision", because only guard refusals and plan approvals
// were read. That is the one false statement this page must never make.

function questionsFile(intent, rel, body) {
  const full = path.join(intent, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

const Q = (answers) =>
  answers.map((a, i) => `## Q${i + 1}. Question ${i + 1}?\n\n- A. One\n- B. Two\n\n[Answer]:${a === '' ? '' : ` ${a}`}\n`).join('\n');

test('unanswered [Answer]: lines in a stage\u2019s questions file are waiting on you, with the count and the file', () => {
  const { root, intent } = intentWith();
  questionsFile(intent, 'ideation/intent-capture/intent-capture-questions.md', Q(['A', '', '', 'B', '']));
  fs.writeFileSync(path.join(intent, '.aidlc-human-turn'), '2026-10-13T02:17:56Z');
  try {
    const d = diag.diagnose(intent, { projectRoot: root });
    assert.equal(d.waitingOnYou.length, 1);
    const w = d.waitingOnYou[0];
    assert.equal(w.kind, 'questions');
    assert.equal(w.stated, true, 'the engine wrote the file; this is not inferred');
    assert.equal(w.stage, 'intent-capture', 'the stage is the directory the file sits in');
    assert.equal(w.open, 3);
    assert.equal(w.total, 5);
    assert.equal(w.message, '3 of 5 questions unanswered in ideation/intent-capture/intent-capture-questions.md');
    assert.equal(w.updatedAt, '2026-10-13T02:17:56Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a questions file with every answer filled is not waiting on anyone', () => {
  const { root, intent } = intentWith();
  questionsFile(intent, 'ideation/intent-capture/intent-capture-questions.md', Q(['A', 'B', 'X. Something else']));
  try {
    assert.deepEqual(diag.diagnose(intent, { projectRoot: root }).waitingOnYou, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an inferred gate wait on the same stage as open questions collapses into the questions', () => {
  // The questions name the concrete thing to do; the gate wait only says the stage is
  // parked. Showing both would list one wait twice.
  const merged = diag.mergeWaiting(
    [{ stage: 'intent-capture', stated: false, evidence: 'STAGE_AWAITING_APPROVAL' }],
    [],
    [],
    [{ relPath: 'ideation/intent-capture/q.md', stage: 'intent-capture', open: 1, total: 1 }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, 'questions');
});

test('questions files are found at the depth real intents use, and dot-directories are not searched', () => {
  const { root, intent } = intentWith();
  questionsFile(intent, 'inception/requirements-analysis/requirements-analysis-questions.md', Q(['']));
  // A copy the engine keeps for itself must not count twice.
  questionsFile(intent, '.aidlc-engine/cache/requirements-analysis-questions.md', Q(['']));
  try {
    const d = diag.diagnose(intent, { projectRoot: root });
    assert.equal(d.waitingOnYou.length, 1);
    assert.equal(d.waitingOnYou[0].stage, 'requirements-analysis');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// While the agent is working, it is not the person's turn
// ---------------------------------------------------------------------------
//
// Seen live: the person answered, the agent began its reply, and for the whole reply the
// Waiting row kept its colour. The inferred gate ("artifact written, nothing after")
// and an open-answers questions file are both what a stage looks like mid-reply. The one
// record that says "the agent is busy" is a turn open in Kiro's session store, read by
// the caller and passed in as agentBusy.

test('while the agent is busy, inferred gates and open questions are not listed, but a stated gate is', () => {
  const inferred = [{ stage: 'requirements-analysis', stated: false, evidence: 'ARTIFACT_UPDATED' }];
  const stated = [{ stage: 'functional-design', stated: true, evidence: 'STAGE_AWAITING_APPROVAL' }];
  const questions = [{ relPath: 'inception/requirements-analysis/q.md', stage: 'requirements-analysis', open: 1, total: 3 }];

  const idle = diag.mergeWaiting([...inferred, ...stated], [], [], questions, false);
  assert.deepEqual(idle.map((w) => `${w.kind}:${w.stage}`).sort(), ['gate:functional-design', 'questions:requirements-analysis']);

  const busy = diag.mergeWaiting([...inferred, ...stated], [], [], questions, true);
  assert.deepEqual(busy.map((w) => `${w.kind}:${w.stage}`), ['gate:functional-design'], 'only what the engine itself stated survives a busy agent');
});

test('a guard refusal that needs a person is listed whether or not the agent is busy', () => {
  const refusal = { requiresHuman: true, stage: 'code-generation', code: 'X', userMessage: 'm', remedies: [{ requiresHuman: true, label: 'r' }], count: 1 };
  assert.equal(diag.mergeWaiting([], [refusal], [], [], true).length, 1);
});

test('diagnose carries agentBusy through so the page can say the agent is working', () => {
  const { root, intent } = intentWith();
  try {
    assert.equal(diag.diagnose(intent, { projectRoot: root, agentBusy: true }).agentBusy, true);
    assert.equal(diag.diagnose(intent, { projectRoot: root }).agentBusy, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('a question pending in the chat is waiting on you, in Kiro\u2019s own words, whether or not a turn is open', () => {
  // The question IS the open turn's state: the agent asked and stopped. So, unlike an
  // inferred gate, it is listed while agentBusy.
  const chat = [{ kind: 'user_input', at: Date.now(), question: 'Reply `Looks correct` to proceed.', options: ['Looks correct'], sessionTitle: 'Demo' }];
  for (const busy of [false, true]) {
    const out = diag.mergeWaiting([], [], [], [], busy, chat);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'chat');
    assert.equal(out[0].stated, true, 'Kiro recorded the question; nothing is inferred');
    assert.equal(out[0].message, 'Reply `Looks correct` to proceed.');
    assert.deepEqual(out[0].options, ['Looks correct']);
    assert.equal(out[0].session, 'Demo');
  }
});


// ---------------------------------------------------------------------------
// Why the engine let the last turn end
// ---------------------------------------------------------------------------
//
// The engine's continue-workflow hook writes one line per allowed stop to
// .aidlc-hooks-health/continue-workflow.drops: "<iso>\t<reason>; allowing the stop
// (<kind> carve-out)". Five kinds across 164 lines in the samples; three of them say the
// person is being waited on, in the engine's words.

function dropsFile(intent, lines) {
  fs.mkdirSync(path.join(intent, '.aidlc-hooks-health'), { recursive: true });
  fs.writeFileSync(path.join(intent, '.aidlc-hooks-health', 'continue-workflow.drops'), lines.join('\n') + '\n');
}

test('the last human-wait stop reason is a stated wait on its stage, and covers an inferred gate there', () => {
  const { root, intent } = intentWith();
  dropsFile(intent, [
    '2026-10-13T07:32:43Z\tactive stage requirements-analysis has an unanswered question; allowing the stop (pending-question carve-out)',
    '2026-10-13T07:48:47Z\tcurrent stage requirements-analysis is awaiting approval or being revised; allowing the stop (human-wait carve-out)'
  ]);
  try {
    const d = diag.diagnose(intent, { projectRoot: root });
    assert.equal(d.lastStop.kind, 'human-wait');
    assert.equal(d.lastStop.stage, 'requirements-analysis');
    assert.equal(d.lastStop.humanWait, true);
    const w = d.waitingOnYou;
    assert.equal(w.length, 1);
    assert.equal(w[0].kind, 'engine-stop');
    assert.equal(w[0].stated, true);
    assert.equal(w[0].stage, 'requirements-analysis');
    assert.match(w[0].detail, /human-wait carve-out/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a conversational stop is not a wait, and is reported so the row can say "see the chat"', () => {
  const { root, intent } = intentWith();
  dropsFile(intent, ["2026-10-13T09:12:23Z\tthe ending turn was conversational (human's last prompt answered with no workflow-engine call); allowing the stop (conversational carve-out)"]);
  try {
    const d = diag.diagnose(intent, { projectRoot: root });
    assert.equal(d.lastStop.kind, 'conversational');
    assert.equal(d.lastStop.humanWait, false);
    assert.deepEqual(d.waitingOnYou, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stop reason older than the ledger\u2019s last event is stale: the stop it explains is over', () => {
  const { root, intent } = intentWith();
  dropsFile(intent, ['2026-10-13T04:12:06Z\tcurrent stage intent-capture has an unanswered logged decision; allowing the stop (pending-decision carve-out)']);
  fs.writeFileSync(path.join(intent, 'audit', 'shard.md'), '**Timestamp**: 2026-10-13T04:26:47Z\n**Event**: ERROR_LOGGED\n');
  try {
    const d = diag.diagnose(intent, { projectRoot: root });
    assert.equal(d.lastStop.stale, true);
    assert.deepEqual(d.waitingOnYou, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a human-wait stop is not listed while the agent is busy: a new turn supersedes the old stop', () => {
  const stop = { at: Date.now(), kind: 'human-wait', stage: 's', humanWait: true, stale: false, reason: 'r' };
  assert.equal(diag.mergeWaiting([], [], [], [], false, [], stop).length, 1);
  assert.equal(diag.mergeWaiting([], [], [], [], true, [], stop).length, 0);
});
