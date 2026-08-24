'use strict';

// Reader for the v2 audit ledger.
//
// The ledger is markdown, but it is not prose: the engine writes fixed
// `**Field**: value` lines separated by `---`, and every row carries an
// `**Event**` from a closed vocabulary. So this reads named fields off records
// rather than interpreting sentences. Nothing here parses artifact content.
//
// Two facts about the format cost real debugging time and are encoded here so
// they cannot be forgotten:
//
//   1. The stage field name DIFFERS BY EVENT. Sensor rows use
//      `**Stage slug**`; most other rows use `**Stage**`. Reading only one name
//      silently returns an empty tally.
//   2. A failing sensor emits its OWN event (`SENSOR_FAILED`). Inferring failure
//      from a missing `SENSOR_PASSED` also flags rows that are merely in flight.
//
// Anything whose event name this module does not recognise is returned under
// `unknownEvents` instead of being dropped, so a project that exercises a part
// of the engine this one did not immediately says so.
//
// Pure module: never import `vscode` here.

const fs = require('fs');
const path = require('path');

const RECORD_SEPARATOR = /\r?\n---\r?\n/;

// Event names this module gives meaning to. Every other event is counted but
// reported as unknown; the vocabulary is large (80+) and we deliberately do not
// enumerate all of it, because a name we never act on needs no entry here.
const EVENT = {
  SENSOR_FIRED: 'SENSOR_FIRED',
  SENSOR_PASSED: 'SENSOR_PASSED',
  SENSOR_FAILED: 'SENSOR_FAILED',
  ERROR_LOGGED: 'ERROR_LOGGED',
  HUMAN_TURN: 'HUMAN_TURN',
  GATE_APPROVED: 'GATE_APPROVED',
  GATE_REJECTED: 'GATE_REJECTED',
  STAGE_STARTED: 'STAGE_STARTED',
  STAGE_COMPLETED: 'STAGE_COMPLETED',
  STAGE_SKIPPED: 'STAGE_SKIPPED',
  STAGE_REVISING: 'STAGE_REVISING',
  REVIEW_REQUESTED: 'REVIEW_REQUESTED',
  REVIEW_COMPLETED: 'REVIEW_COMPLETED',
  QUESTION_ANSWERED: 'QUESTION_ANSWERED',
  ARTIFACT_CREATED: 'ARTIFACT_CREATED',
  ARTIFACT_UPDATED: 'ARTIFACT_UPDATED',
  RULE_LEARNED: 'RULE_LEARNED',
  SUBAGENT_COMPLETED: 'SUBAGENT_COMPLETED',
  // Emitted once per unit of work for a stage that repeats. This is the only
  // record of per-unit progress: `runtime-graph.json` tracks a stage as a single
  // row no matter how many units it ran for.
  UNIT_COMPLETED: 'UNIT_COMPLETED',
  WORKFLOW_STARTED: 'WORKFLOW_STARTED',
  WORKFLOW_COMPLETED: 'WORKFLOW_COMPLETED',
  PHASE_STARTED: 'PHASE_STARTED',
  PHASE_COMPLETED: 'PHASE_COMPLETED',
  PHASE_SKIPPED: 'PHASE_SKIPPED',
  // The engine has finished a stage's work and is waiting for a person. This is
  // the one event the whole supervision surface exists for, and it was sitting in
  // the "not understood" list -- a panel about delegation that could not say when
  // the delegation was waiting on you.
  //
  // It carries `Stage` rather than `Stage slug`, like the other stage-lifecycle
  // events and unlike the sensor rows.
  STAGE_AWAITING_APPROVAL: 'STAGE_AWAITING_APPROVAL',
  // A person confirmed a summary. Read as the resolution of the above, alongside
  // the gate and completion events.
  SUMMARY_CONFIRMATION_RECORDED: 'SUMMARY_CONFIRMATION_RECORDED'
};

const KNOWN_EVENTS = new Set(Object.values(EVENT));

function field(record, name) {
  // Anchored to line start so a field name quoted inside a value cannot match.
  const match = record.match(
    new RegExp(`^\\*\\*${name}\\*\\*:[ \\t]*(.*)$`, 'm')
  );
  return match ? match[1].trim() : undefined;
}

// The stage a record belongs to, trying both spellings. Order matters only for
// speed; a record carries one or the other, never both.
function stageOf(record) {
  return field(record, 'Stage') ?? field(record, 'Stage slug');
}

function listShardPaths(intentDir) {
  const dir = path.join(intentDir, 'audit');
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

// Every audit record, in file order within a shard and shard-name order across
// shards. Shard filename order is NOT execution order across clones, so callers
// must not treat the sequence as a global timeline; timestamps are the ordering
// key when order matters.
function readEvents(intentDir) {
  const events = [];
  for (const shardPath of listShardPaths(intentDir)) {
    let content;
    try {
      content = fs.readFileSync(shardPath, 'utf8');
    } catch {
      continue;
    }
    for (const record of content.split(RECORD_SEPARATOR)) {
      const name = field(record, 'Event');
      if (!name) continue;
      events.push({
        event: name,
        timestamp: field(record, 'Timestamp'),
        stage: stageOf(record),
        // Only present on per-unit rows, and the only place a unit name appears
        // in the ledger.
        unit: field(record, 'Unit'),
        sensorId: field(record, 'Sensor ID'),
        // How many findings the sensor counted. A ledger field, so it is read
        // rather than inferred from the finding list.
        findingsCount: field(record, 'Findings count'),
        outputPath: field(record, 'Output path'),
        detailPath: field(record, 'Detail path'),
        error: field(record, 'Error'),
        // Refusal rows name the tool and the exact invocation instead of a
        // stage. Carried through so a reader can see, and fix, what was run.
        tool: field(record, 'Tool'),
        command: field(record, 'Command'),
        shard: path.basename(shardPath)
      });
    }
  }
  return events;
}

function tally(events) {
  const counts = new Map();
  for (const entry of events) counts.set(entry.event, (counts.get(entry.event) ?? 0) + 1);
  return counts;
}

// What the supervision surface needs, computed in one pass.
//
// Sensor failures are reported PER STAGE as well as in total, because they are
// stage-local: a run can accumulate failures early and then produce none for
// many stages, and a bare cumulative number would keep warning about work the
// user already moved past.
function summarise(intentDir) {
  const events = readEvents(intentDir);
  const counts = tally(events);

  const sensorFailures = [];
  const failuresByStage = new Map();
  const refusals = [];
  // Stages the engine parked for a person, in ledger order. Whether one is STILL
  // waiting is not decidable here -- it depends on what came after, which is
  // diagnose's job.
  const awaitingApproval = [];
  const unitsCompleted = new Map();
  const unitsSeen = new Map();
  for (const entry of events) {
    if (entry.event === EVENT.SENSOR_FAILED) {
      sensorFailures.push(entry);
      const key = entry.stage ?? '(unattributed)';
      failuresByStage.set(key, (failuresByStage.get(key) ?? 0) + 1);
    } else if (entry.event === EVENT.ERROR_LOGGED) {
      refusals.push(entry);
    } else if (entry.event === EVENT.STAGE_AWAITING_APPROVAL) {
      awaitingApproval.push(entry);
    }
    // The `Unit` field rides on WHICHEVER events a stage happens to emit, and
    // which those are depends on the stage's execution mode: an `inline` stage
    // was observed closing each unit with UNIT_COMPLETED, while a `subagent`
    // stage carried the unit on its review rows and emitted no UNIT_COMPLETED at
    // all. Keying on one event name therefore reported zero units for a stage
    // that had finished all of them. So every unit-bearing row counts as
    // evidence the unit was worked, and only UNIT_COMPLETED counts as evidence
    // it was closed.
    if (entry.stage && entry.unit) {
      if (!unitsSeen.has(entry.stage)) unitsSeen.set(entry.stage, new Set());
      unitsSeen.get(entry.stage).add(entry.unit);
      if (entry.event === EVENT.UNIT_COMPLETED) {
        // A set, not a count: a stage can be re-run for the same unit after a
        // rejection, and counting rows would then claim more units than exist.
        if (!unitsCompleted.has(entry.stage)) unitsCompleted.set(entry.stage, new Set());
        unitsCompleted.get(entry.stage).add(entry.unit);
      }
    }
  }

  const unknownEvents = [...counts.keys()].filter((name) => !KNOWN_EVENTS.has(name)).sort();

  return {
    total: events.length,
    counts,
    sensorFailures,
    failuresByStage,
    refusals,
    awaitingApproval,
    unitsCompleted,
    unitsSeen,
    unknownEvents,
    events
  };
}

// Records around an engine refusal, in timestamp order.
//
// The refusal message alone does not explain how the workflow reached the state
// it refuses. The surrounding sequence does: an artifact write landing between a
// review request and its verdict is what invalidates the receipt, and that is
// only visible as an ordering. So this returns the window rather than the row.
function refusalContext(summary, refusalIndexOrEvent, window = 5) {
  const ordered = [...summary.events].sort((a, b) =>
    String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? ''))
  );
  const target =
    typeof refusalIndexOrEvent === 'number'
      ? summary.refusals[refusalIndexOrEvent]
      : refusalIndexOrEvent;
  if (!target) return [];
  const at = ordered.indexOf(target);
  if (at < 0) return [];
  return ordered.slice(Math.max(0, at - window), at + window + 1);
}

module.exports = {
  EVENT,
  KNOWN_EVENTS,
  field,
  stageOf,
  listShardPaths,
  readEvents,
  summarise,
  refusalContext
};
