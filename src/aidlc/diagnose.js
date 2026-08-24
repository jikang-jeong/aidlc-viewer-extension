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
// here so this stays a transform over data the caller gathered, and so the completion
// authority is the same object the journey was built from.
function diagnose(intentDir, options = {}) {
  const summary = auditReader.summarise(intentDir);
  const refusals = describeRefusals(summary, options);
  const approvalWaits = describeApprovalWaits(summary, options.runtime);
  return {
    eventTotal: summary.total,
    refusals,
    live: refusals.filter((entry) => entry.settled === false),
    // Neither settled nor unsettled could be decided. Surfaced so it is visible
    // that the ledger was ambiguous rather than quietly counted as either.
    undecided: refusals.filter((entry) => entry.settled === undefined),
    sensorFailures: sensorFailuresByStage(summary),
    sensorFailureTotal: summary.sensorFailures.length,
    // Stages parked at a gate. `waitingOnYou` is the subset nothing resolved.
    // Stages parked at a gate with nothing having moved them since. Already the
    // unresolved set, so there is no separate total: a finished run has none.
    approvalWaits,
    waitingOnYou: approvalWaits,
    // An event name this build has no meaning for. Not an error: the vocabulary
    // differs between projects, and reporting it is how the next project tells
    // us what we have not met yet.
    unknownEvents: summary.unknownEvents,
    summary
  };
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
  describeRefusals,
  describeApprovalWaits,
  sensorFailuresByStage,
  diagnose,
  byTimestamp
};
