'use strict';

// Single entry point for reading an AI-DLC project, whichever generation it is.
//
// The caller says "here is a folder" and gets back a journey in one shape plus,
// for v2, the supervision facts. Nothing above this module needs to know which
// generation is installed, which is what keeps the v1 code path untouched: a v1
// project routes to the v1 builder and comes back looking exactly as it did
// before this module existed.
//
// Pure module: never import `vscode` here. Everything is filesystem reads.

const { GENERATION, detectGeneration } = require('./detect');
const { buildV2 } = require('./journey-v2');
const { diagnose } = require('./diagnose');
const { contested } = require('./contrast');

// Read a project.
//
// `v1Journey` is supplied by the caller rather than built here, because the v1
// builder takes an artifact list the caller already walked for its tree. Passing
// it through avoids walking the same directory twice and, more importantly, means
// this module cannot change v1 behaviour even by accident.
function readProject(root, options = {}) {
  const { generation, markers } = detectGeneration(root);

  // `both` prefers v2: a project that has had v2 installed is being driven by
  // the engine now, and its v1 artifacts are history. The v1 markers are still
  // reported so a caller can say so.
  const useV2 = generation === GENERATION.V2 || generation === GENERATION.BOTH;
  if (!useV2) {
    return { generation, markers, v2: undefined, journey: options.v1Journey };
  }

  const model = buildV2(root);
  if (!model.ok) {
    // A v2 install whose compiled graph cannot be read. Reported rather than
    // thrown: a half-finished install is a normal state to render, and the tree
    // must still work.
    return { generation, markers, v2: { ok: false, reason: model.reason }, journey: options.v1Journey };
  }

  // Supervision facts per intent, attached alongside its journey.
  const intents = model.intents.map((intent) => {
    const diagnosis = diagnose(intent.dir);
    return {
      ...intent,
      diagnosis,
      // What the agent recorded about its own coverage, set beside what the
      // engine's sensor found in the same file. Reuses the diagnosis summary so
      // the ledger is read once per intent.
      contrast: contested(intent.dir, diagnosis.summary)
    };
  });

  // The intent to show when a surface has room for one. The most recently
  // started wins; without a start time, file order. No attempt is made to guess
  // which one the user cares about beyond that.
  const active = pickActive(intents);

  return {
    generation,
    markers,
    v2: { ...model, intents, active },
    // So a caller that only knows about journeys keeps working.
    journey: active ? active.journey : options.v1Journey
  };
}

function pickActive(intents) {
  if (intents.length === 0) return undefined;
  const unfinished = intents.filter(
    (intent) => intent.journey.counts.done < intent.journey.plannedTotal
  );
  const pool = unfinished.length > 0 ? unfinished : intents;
  return pool[pool.length - 1];
}

// Whether a surface has anything worth interrupting the user about.
//
// Deliberately narrow. Across three observed runs 44 refusals were logged and
// none were still in the way, so "there were problems" is not a signal -- "there
// is a problem now" is. Sensor failures are the exception: they are advisory,
// nothing ever resolves them, and nobody was told, so an unresolved count stays
// worth showing.
function hasSomethingToSay(project) {
  if (!project || !project.v2 || project.v2.ok === false) return false;
  const intent = project.v2.active;
  if (!intent) return false;
  return (
    intent.diagnosis.live.length > 0 ||
    intent.diagnosis.sensorFailureTotal > 0 ||
    intent.contrast.rows.length > 0 ||
    project.v2.gaps.unknownEvents.length > 0
  );
}

module.exports = { GENERATION, readProject, hasSomethingToSay };
