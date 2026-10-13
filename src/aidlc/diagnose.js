'use strict';

// Turns the audit ledger into the two things a person needs when a v2 workflow
// stalls or drifts, and deliberately stops short of a third.
//
// WHAT THIS DOES NOT DO, on purpose: it never classifies a refusal, never infers
// a cause, never suggests a fix. Across three real projects the engine produced
// 12 distinct refusal messages in one run alone and the vocabulary kept growing
// between projects, so any table of recognised messages would be stale on
// arrival and confidently wrong on the case it did not know. The engine's own
// message already states the remedy; it is carried through verbatim.
//
// What is genuinely missing from every existing surface is the SEQUENCE. A
// refusal says "no fresh review receipt exists" without saying that an artifact
// write landed between the review request and its verdict, which is the fact
// that explains it -- and that fact is only visible as an ordering of events.
// Reconstructing it by hand cost one session ~46 credits and three passes
// through the engine's TypeScript source. So the sequence is the product here.
//
// Pure module: never import `vscode`.

const fs = require('fs');
const path = require('path');
const auditReader = require('./audit');

// A refusal, with enough around it to be understood.
//
// A refusal row carries NO stage field. Its fields are Timestamp, Event, Tool,
// Command and Error -- the stage appears only inside the command string, and
// picking it out of there would mean parsing a CLI invocation, which breaks the
// moment an argument is renamed. So the stage is derived POSITIONALLY: whichever
// stage the ledger was working on immediately before the refusal. That holds
// regardless of how the command line is spelled.
//
// `settled` answers "is this still in my way": true when that stage shows
// activity afterwards. When the ledger cannot answer it stays undefined rather
// than defaulting either way, because a refusal wrongly marked settled hides a
// live blocker and one wrongly marked live cries wolf over history.
function describeRefusals(summary, options = {}) {
  const window = options.window ?? 5;
  const ordered = byTimestamp(summary.events);

  // Stage in effect at each position, carried forward from the last row that
  // named one, plus the last position each stage was seen at.
  const stageAt = [];
  const lastActivity = new Map();
  let current;
  ordered.forEach((entry, index) => {
    if (entry.stage) {
      current = entry.stage;
      lastActivity.set(entry.stage, index);
    }
    stageAt[index] = current;
  });

  const positions = new Map(ordered.map((entry, index) => [entry, index]));

  return summary.refusals.map((refusal) => {
    const at = positions.get(refusal);
    const stage = at === undefined ? undefined : stageAt[at];
    const movedOnAt = stage ? lastActivity.get(stage) : undefined;
    return {
      // Verbatim. The engine wrote a better message than any paraphrase, and it
      // already states the remedy.
      message: refusal.error,
      // The exact invocation that was refused, so it can be corrected and rerun
      // without reconstructing it from prose.
      tool: refusal.tool,
      command: refusal.command,
      // Positional, and labelled as such so a reader knows it was not stated.
      stage,
      stageInferred: true,
      timestamp: refusal.timestamp,
      settled: at === undefined || movedOnAt === undefined ? undefined : movedOnAt > at,
      // The ordering that explains it.
      context: at === undefined ? [] : ordered.slice(Math.max(0, at - window), at + window + 1)
    };
  });
}

// Sensor failures grouped by the stage that produced them, each keeping the
// engine's own paths so a reader can open the artifact and the failure detail.
//
// Grouped rather than totalled because failures are stage-local: one project put
// 25 of its 51 in a single stage while producing none in most others, and a
// single cumulative number would keep warning about a stage the user finished
// hours ago.
function sensorFailuresByStage(summary) {
  const byStage = new Map();
  for (const failure of summary.sensorFailures) {
    const key = failure.stage ?? '(unattributed)';
    if (!byStage.has(key)) byStage.set(key, []);
    byStage.get(key).push({
      sensorId: failure.sensorId,
      timestamp: failure.timestamp,
      // The artifact the sensor was unhappy with, and where it wrote why.
      outputPath: failure.outputPath,
      detailPath: failure.detailPath
    });
  }
  return byStage;
}

// Which stages are waiting for a person right now.
//
// This is the question the whole supervision surface exists to answer. In v2 the
// agent reads and you approve, so a stage parked at its gate is not slow -- it is
// stopped, on you, and the chat said so once and scrolled away.
//
// The first version of this keyed on STAGE_AWAITING_APPROVAL alone, and a real case
// broke it within the hour: a project sitting at a Requirements Analysis gate, the
// chat asking for approval, and this reporting nothing, because that engine emitted
// no such event for that gate. One event name is a rule base with a single rule, and
// following the v2 branch means the vocabulary moves -- UNIT_COMPLETED is already
// absent from the newer engine.
//
// So the judgement is now about state, and takes any of three kinds of evidence that
// a stage finished its work:
//
//   the engine said so           STAGE_AWAITING_APPROVAL, when it emits it
//   a review closed              REVIEW_COMPLETED, the subagent path
//   an artifact was written       ARTIFACT_CREATED / ARTIFACT_UPDATED, the inline path
//
// combined with the two facts that make it a wait rather than progress: the runtime
// graph does not have the stage as done, and nothing since that evidence moved the
// stage on. A stage whose last act was a skip is not waiting, and neither is one
// still writing.
//
// The evidence kinds are named, but the resolution is not: any later activity on the
// stage settles it. Enumerating which events count as an approval would break the
// first time upstream renames one, and the question is only whether the stage moved.
const FINISHED_WORK = new Set([
  'STAGE_AWAITING_APPROVAL',
  'REVIEW_COMPLETED',
  'ARTIFACT_CREATED',
  'ARTIFACT_UPDATED'
]);

// Acts that mean the stage is done with, so a later one of these is not a wait.
const CLOSED_OUT = new Set([
  'STAGE_COMPLETED',
  'STAGE_SKIPPED',
  'GATE_APPROVED',
  'GATE_REJECTED',
  'STAGE_REVISING'
]);

function describeApprovalWaits(summary, runtime) {
  const ordered = byTimestamp(summary.events);
  // Last position of each kind of act, per stage.
  const lastFinished = new Map();
  const lastClosed = new Map();
  const lastAny = new Map();
  ordered.forEach((entry, index) => {
    if (!entry.stage) return;
    lastAny.set(entry.stage, index);
    if (FINISHED_WORK.has(entry.event)) lastFinished.set(entry.stage, { index, entry });
    if (CLOSED_OUT.has(entry.event)) lastClosed.set(entry.stage, index);
  });

  const waits = [];
  for (const [stage, finished] of lastFinished) {
    // Done according to the runtime graph is not waiting, whatever the ledger says.
    // The graph is the authority on completion; the ledger is the authority on what
    // happened.
    const record = runtime && runtime.byStage ? runtime.byStage.get(stage) : undefined;
    if (record && record.done) continue;
    // Closed out after finishing its work: approved, rejected, skipped or revising.
    const closedAt = lastClosed.get(stage);
    if (closedAt !== undefined && closedAt > finished.index) continue;
    // Still working: something happened after the last evidence of finishing, and it
    // was not a close-out. Sensors firing on the artifact count as still working,
    // which is why this compares positions rather than looking only at the tail.
    if (lastAny.get(stage) > finished.index && !FINISHED_WORK.has(ordered[lastAny.get(stage)].event)) {
      // A sensor pass on an artifact just written is part of finishing it, not work
      // after it. Anything else is treated as movement, so this errs toward silence.
      const after = ordered.slice(finished.index + 1, lastAny.get(stage) + 1);
      if (after.some((entry) => entry.stage === stage && !SENSOR_NOISE.has(entry.event))) continue;
    }
    waits.push({
      stage,
      timestamp: finished.entry.timestamp,
      // Which of the three kinds of evidence placed this, so a reader of the data
      // knows whether the engine said it or it was concluded.
      evidence: finished.entry.event,
      stated: finished.entry.event === 'STAGE_AWAITING_APPROVAL',
      detail: finished.entry.details
    });
  }
  return byTimestamp(waits);
}

// Checks running over an artifact are part of writing it, not activity after it.
const SENSOR_NOISE = new Set(['SENSOR_FIRED', 'SENSOR_PASSED', 'SENSOR_FAILED']);



// `runtime` is the caller's already-read runtime graph. Passed in rather than read
// ---------------------------------------------------------------------------
// What the engine wrote down about needing a person (2.11.0 and later)
// ---------------------------------------------------------------------------

// Two records the engine keeps on disk when it stops for a human, read here as
// structure rather than inferred from ledger text.
//
// Why this exists beside describeApprovalWaits: that function reconstructs "waiting"
// from the ORDER of ledger events, which was the only evidence the 2.6-era engine left.
// Since 2.8 the engine also writes the refusal itself -- the code, the stage, the
// blocked action, and a list of remedies each flagged `requiresHuman` -- and since 2.11
// it writes a Plan Approval review request when a plan is parked for a decision. Those
// files say what the person needs to do; the ledger only says that something stopped.
//
// Both are read as the engine wrote them. The `kind:ask` payload the engine prints to
// stdout at the same moment is NOT read here, because it is not written anywhere a
// later reader can find it.

// `<intent>/.aidlc-engine/guard-refusals/<hash>.json`. One file per distinct refusal;
// `count` is how many times it recurred. The file is removed when the refusal clears,
// so its presence is the live state.
function readGuardRefusals(intentDir) {
  const dir = path.join(intentDir, '.aidlc-engine', 'guard-refusals');
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const refusals = [];
  for (const name of names) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      refusals.push({ file: name, unreadable: true });
      continue;
    }
    const refusal = record && typeof record === 'object' ? record.refusal ?? {} : {};
    const remedies = Array.isArray(refusal.remedies) ? refusal.remedies : [];
    refusals.push({
      file: name,
      code: typeof refusal.code === 'string' ? refusal.code : undefined,
      codes: Array.isArray(record?.codes) ? record.codes.filter((c) => typeof c === 'string') : [],
      stage: typeof refusal.stage === 'string' ? refusal.stage : undefined,
      blockedAction: typeof refusal.blockedAction === 'string' ? refusal.blockedAction : undefined,
      userMessage: typeof refusal.userMessage === 'string' ? refusal.userMessage : undefined,
      count: typeof record?.count === 'number' ? record.count : undefined,
      updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : undefined,
      // The engine's own verdict on who can clear this. A refusal with no human
      // remedy is the agent's to resolve; one with a human remedy is waiting on you.
      requiresHuman: remedies.some((r) => r && r.requiresHuman === true),
      remedies: remedies
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          op: typeof r.op === 'string' ? r.op : undefined,
          label: typeof r.label === 'string' ? r.label : undefined,
          action: typeof r.action === 'string' ? r.action : undefined,
          requiresHuman: r.requiresHuman === true
        }))
    });
  }
  return refusals;
}

// `aidlc/.aidlc-sessions/plan-approval/review-request-<id>.json`, one per plan the
// engine has parked for a decision. The directory is project-wide, so each request
// names its intent and the caller filters.
function readPlanApprovalRequests(projectRoot) {
  const dir = path.join(projectRoot, 'aidlc', '.aidlc-sessions', 'plan-approval');
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => /^review-request-[0-9a-f]+\.json$/.test(name));
  } catch {
    return [];
  }
  const requests = [];
  for (const name of names) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      requests.push({ file: name, unreadable: true });
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const target = typeof record.targetId === 'string' ? record.targetId : '';
    requests.push({
      file: name,
      intentId: typeof record.intentId === 'string' ? record.intentId : undefined,
      targetId: target || undefined,
      // `unit:<name>` is a per-unit plan; `next:` is the engine's own beat and not a
      // decision for a person, per the engine's pendingBuiltPlanReviews.
      unit: target.startsWith('unit:') ? target.slice('unit:'.length) : undefined,
      isEngineBeat: target.startsWith('next:'),
      feedback: typeof record.feedback === 'string' ? record.feedback : undefined
    });
  }
  return requests;
}

// Orchestrates the per-intent diagnosis. The audit summary is passed in rather than read
// here so this stays a transform over data the caller gathered, and so the completion
// authority is the same object the journey was built from.
function diagnose(intentDir, options = {}) {
  const summary = auditReader.summarise(intentDir, options.knownStages);
  const refusals = describeRefusals(summary, options);
  const approvalWaits = describeApprovalWaits(summary, options.runtime);
  const guardRefusals = readGuardRefusals(intentDir);
  const openQuestions = readOpenQuestions(intentDir);
  const intentId = path.basename(intentDir);
  const planApproval = options.projectRoot
    ? readPlanApprovalRequests(options.projectRoot).filter(
        (r) => !r.unreadable && !r.isEngineBeat && (r.intentId === undefined || r.intentId === intentId)
      )
    : [];
  return {
    eventTotal: summary.total,
    refusals,
    live: refusals.filter((entry) => entry.settled === false),
    // Neither settled nor unsettled could be decided. Surfaced so it is visible
    // that the ledger was ambiguous rather than quietly counted as either.
    undecided: refusals.filter((entry) => entry.settled === undefined),
    sensorFailures: sensorFailuresByStage(summary),
    sensorFailureTotal: summary.sensorFailures.length,
    // Stages parked at a gate with nothing having moved them since, inferred from the
    // ledger. Kept as the fallback for engines that write nothing more.
    approvalWaits,
    // What the engine itself wrote about needing a person. `stated` is true on every
    // entry here, as opposed to the inferred `approvalWaits`.
    guardRefusals,
    planApproval,
    // Everything waiting on a person, from every source, deduplicated by stage. Stated
    // entries first because they carry the engine's own words and remedies.
    // Questions the engine wrote and a person has not answered yet.
    openQuestions,
    // `agentBusy` comes from Kiro's session record, read by the caller.
    agentBusy: Boolean(options.agentBusy),
    waitingOnYou: mergeWaiting(approvalWaits, guardRefusals, planApproval, openQuestions, Boolean(options.agentBusy), options.chatQuestions ?? []),
    // An event name this build has no meaning for. Not an error: the vocabulary
    // differs between projects, and reporting it is how the next project tells
    // us what we have not met yet.
    unknownEvents: summary.unknownEvents,
    summary
  };
}

// Questions the engine wrote for a person and that are still unanswered.
//
// Seen on four real v2 intents (2026-10-13): a stage that needs decisions writes a
// `*questions*.md` under the stage's directory with one `[Answer]:` per question, the
// same convention v1 uses, and touches `.aidlc-human-turn` with the time it handed the
// turn over. On the two finished intents every `[Answer]:` was filled and
// `.aidlc-engine-touch` was later than `.aidlc-human-turn`; on the two in progress,
// answers were open and the human turn was the later of the two. The open `[Answer]:`
// lines are the concrete thing the person has to do, so they are what is reported;
// the two timestamps are carried for the page to say when the turn was handed over.
//
// This is a third, distinct source from guard refusals and plan approvals. Before it
// was read, a project with three unanswered questions showed "Nothing is waiting on
// your decision", which was false in the one way this page must never be.
function readOpenQuestions(intentDir) {
  const out = [];
  if (!intentDir) return out;
  let humanTurn;
  let engineTouch;
  try { humanTurn = fs.readFileSync(path.join(intentDir, '.aidlc-human-turn'), 'utf8').trim(); } catch { /* absent */ }
  try { engineTouch = fs.readFileSync(path.join(intentDir, '.aidlc-engine-touch'), 'utf8').trim(); } catch { /* absent */ }
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/questions.*\.md$/i.test(e.name)) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const open = (text.match(/^\[Answer\]:\s*$/gm) || []).length;
      if (open === 0) continue;
      const total = (text.match(/^\[Answer\]:/gm) || []).length;
      const rel = path.relative(intentDir, full).split(path.sep);
      // <phase>/<stage>/<file>: the stage is the directory the file sits in.
      const stage = rel.length >= 2 ? rel[rel.length - 2] : undefined;
      out.push({ file: full, relPath: rel.join('/'), stage, open, total, humanTurn, engineTouch });
    }
  };
  walk(intentDir, 0);
  return out;
}

// One list for the page. A guard refusal with a human remedy, a parked plan, and an
// inferred gate wait can all name the same stage; the stated ones win and the inferred
// one is kept only when nothing stated covers that stage.
function mergeWaiting(approvalWaits, guardRefusals, planApproval, openQuestions = [], agentBusy = false, chatQuestions = []) {
  const out = [];
  const covered = new Set();
  // What Kiro recorded the agent asking in the chat, unanswered. The most direct form of
  // "waiting on you" there is: the question is on screen and the agent has stopped. It
  // names no stage (the chat does not know stages), so it never covers one, and it is
  // listed whether or not a turn is open -- a pending question IS the open turn's state.
  for (const q of chatQuestions) {
    out.push({
      kind: 'chat',
      stated: true,
      interaction: q.kind,
      message: q.question ?? 'The agent asked a question in the chat and is waiting for your answer.',
      options: q.options,
      session: q.sessionTitle,
      updatedAt: Number.isFinite(q.at) ? new Date(q.at).toISOString() : undefined
    });
  }
  // While the agent has a turn open on this project, a questions file with empty
  // answers is most likely the one it is writing right now -- seen live: the file
  // appeared with one open [Answer]: while the agent's turn was still running. It
  // becomes the person's turn when the agent's turn ends. Until then it is not listed.
  for (const q of agentBusy ? [] : openQuestions) {
    out.push({
      kind: 'questions',
      stated: true,
      stage: q.stage,
      message: `${q.open} of ${q.total} question${q.total === 1 ? '' : 's'} unanswered in ${q.relPath}`,
      file: q.file,
      open: q.open,
      total: q.total,
      updatedAt: q.humanTurn
    });
    if (q.stage) covered.add(q.stage);
  }
  for (const r of guardRefusals) {
    if (r.unreadable || !r.requiresHuman) continue;
    out.push({
      kind: 'guard-refusal',
      stated: true,
      stage: r.stage,
      code: r.code,
      message: r.userMessage,
      remedies: r.remedies.filter((m) => m.requiresHuman),
      count: r.count,
      updatedAt: r.updatedAt
    });
    if (r.stage) covered.add(r.stage);
  }
  for (const p of planApproval) {
    out.push({
      kind: 'plan-approval',
      stated: true,
      stage: 'code-generation',
      unit: p.unit,
      message: p.unit
        ? `A code-generation plan for unit "${p.unit}" is waiting for your approval.`
        : 'A code-generation plan is waiting for your approval.',
      feedback: p.feedback
    });
    covered.add('code-generation');
  }
  for (const w of approvalWaits ?? []) {
    if (w.stage && covered.has(w.stage)) continue;
    // An INFERRED gate -- "an artifact was written and nothing moved the stage since" --
    // is also what a stage looks like while the agent is working on the person's answer:
    // the artifact is there, the next event has not landed yet. If Kiro's own record
    // says a turn is open on this project, the agent is busy and this is not the
    // person's turn. A gate the engine STATED (STAGE_AWAITING_APPROVAL) is kept: that
    // is the engine's word, and a turn can be open for other reasons.
    if (agentBusy && w.stated !== true) continue;
    out.push({ kind: 'gate', stated: w.stated === true, ...w });
  }
  return out;
}

// Stable ordering for display. Timestamps are second-precision, so ties are
// broken by the order the records were read, which is append order within a
// shard. Across shards a same-second tie is genuinely unordered and left as
// read rather than invented.
function byTimestamp(events) {
  return events
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = String(a.entry.timestamp ?? '');
      const right = String(b.entry.timestamp ?? '');
      if (left !== right) return left < right ? -1 : 1;
      return a.index - b.index;
    })
    .map((wrapped) => wrapped.entry);
}

module.exports = {
  readOpenQuestions,
  readGuardRefusals,
  readPlanApprovalRequests,
  mergeWaiting,
  describeRefusals,
  describeApprovalWaits,
  sensorFailuresByStage,
  diagnose,
  byTimestamp
};
