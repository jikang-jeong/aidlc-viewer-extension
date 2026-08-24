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
// This is the question the whole supervision surface exists to answer, and until
// now the event that states it was in the "not understood" list. In v2 the agent
// reads and you approve, so a stage parked at its gate is not slow -- it is
// stopped, on you, and the chat said so once and scrolled away.
//
// Same live-versus-settled shape as the refusals above, and for the same reason:
// a ledger accumulates every gate a run ever reached, so the raw count is history.
// A wait is still live when nothing after it resolved that stage. Resolution is not
// enumerated as one event: an approval, a summary confirmation, a completion or a
// skip all mean the same thing here, which is that the stage moved. So any later
// activity on that stage settles the wait, and a stage the ledger cannot place is
// reported as undecided rather than guessed either way.
function describeApprovalWaits(summary) {
  const waits = summary.awaitingApproval ?? [];
  if (waits.length === 0) return [];

  const ordered = byTimestamp(summary.events);
  const positions = new Map(ordered.map((entry, index) => [entry, index]));
  // The last position each stage did anything at all.
  const lastActivity = new Map();
  ordered.forEach((entry, index) => {
    if (entry.stage) lastActivity.set(entry.stage, index);
  });

  // Only the most recent wait per stage matters. A stage re-entered after a
  // rejection parks twice, and reporting both would double-count one gate.
  const latest = new Map();
  for (const wait of waits) {
    const at = positions.get(wait);
    if (at === undefined) continue;
    const seen = latest.get(wait.stage);
    if (seen === undefined || at > positions.get(seen)) latest.set(wait.stage, wait);
  }

  const described = [...latest.values()].map((wait) => {
      const at = positions.get(wait);
      const movedOnAt = wait.stage ? lastActivity.get(wait.stage) : undefined;
      return {
        stage: wait.stage,
        timestamp: wait.timestamp,
        settled: at === undefined || movedOnAt === undefined ? undefined : movedOnAt > at,
      // What the engine had to say at the gate, verbatim when it said anything.
      detail: wait.details
    };
  });
  return byTimestamp(described);
}


function diagnose(intentDir, options = {}) {
  const summary = auditReader.summarise(intentDir);
  const refusals = describeRefusals(summary, options);
  const approvalWaits = describeApprovalWaits(summary);
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
    approvalWaits,
    waitingOnYou: approvalWaits.filter((entry) => entry.settled === false),
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
