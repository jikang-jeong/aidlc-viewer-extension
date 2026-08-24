'use strict';

// v2 adapter: turns compiled graph + runtime state into the same shape
// `journey.js` returns for v1, so the strip and tree renderers need no branch.
//
// The v1 model had to infer a checkpoint list from directory layout because v1
// ships no machine-readable plan. v2 does ship one, so this adapter asserts
// nothing: the stage list, their order, their phases and which of them this
// project runs all come from data. That is why it needs no per-project tuning.
//
// Pure module: never import `vscode` here.

const graphReader = require('./graph');
const runtimeReader = require('./runtime');
const auditReader = require('./audit');
const { STATUS } = require('./journey');

// Same vocabulary as v1 so a renderer cannot tell the generations apart.
const V2_STATUS = STATUS;

// One intent's journey.
//
// `stages` must already be tagged with `inScope` (see graph.stagesForScope), and
// `runtime` may be undefined: a project can have a graph and no run yet, and
// that should read as "nothing started", not as an error.
//
// `unitsCompleted` and `unitsSeen` map a stage slug to unit-name sets taken from
// the audit ledger. They are passed in rather than read here so this function
// stays a pure transform over data the caller already gathered.
function buildFromStages(stages, runtime, unitsCompleted = new Map(), unitsSeen = new Map()) {
  const unitNames = runtime && runtime.units ? runtime.units.units.map((u) => u.name) : [];
  const checkpoints = [];
  for (const stage of stages) {
    const record = runtime ? runtime.byStage.get(stage.slug) : undefined;
    let status;
    if (!stage.inScope) {
      // The scope declared this stage would not run. That is not work left to do,
      // which is why it leaves the denominator below.
      //
      // It reuses v1's `skipped` status so every renderer keeps hatching it and
      // excluding it from counts without a branch. But it is NOT what v1 means by
      // skipped: v1 skipped a stage by moving past it, so the position was always
      // beyond it. This is declared before anything runs, which is why a project
      // sitting in its second phase showed Operation stages as "skipped" and read
      // as either a bug or as a decision nobody made. `outOfScope` carries the
      // distinction to the places that print a word, and v1 never sets it.
      status = V2_STATUS.SKIPPED;
    } else if (record && record.done) {
      status = V2_STATUS.DONE;
    } else if (record) {
      // Present in the runtime graph but not approved: it has been entered.
      status = V2_STATUS.ACTIVE;
    } else {
      status = V2_STATUS.PENDING;
    }
    checkpoints.push({
      id: stage.slug,
      label: stage.name,
      phase: stage.phase,
      // v2 states its own condition, so this is read rather than guessed.
      conditional: stage.execution ? stage.execution !== 'ALWAYS' : false,
      // Whether this stage may yet decline to run, as a v2-only field.
      //
      // `conditional` cannot carry this to the renderers, because v1 sets it too --
      // eight of v1's checkpoints are conditional, so keying a label off it would
      // have relabelled v1's "not started" rows as "if needed". That is exactly the
      // regression this project guards against, and it was caught by checking rather
      // than assumed absent.
      //
      // Only ever true, and only in v2, so a renderer reading it cannot reach v1.
      mayNotRun: stage.execution && stage.execution !== 'ALWAYS' ? true : undefined,
      // v1 needed a placeholder concept for a phase its rules never reach. v2
      // expresses the same thing through scope, so nothing is a placeholder.
      placeholder: false,
      planned: stage.inScope,
      // Only ever true, and only in v2. The renderers print a different word for
      // it, because "skipped" describes something the run did and this describes
      // something the scope declared before the run began. Absent on in-scope
      // stages and absent on every v1 checkpoint, so a reader of this field cannot
      // accidentally relabel v1.
      outOfScope: stage.inScope ? undefined : true,
      status,
      outcome: record ? record.outcome : undefined,
      agent: record ? record.agent : stage.leadAgent,
      mode: stage.mode,
      produces: stage.produces,
      sensors: stage.sensors,
      // A stage that repeats per unit of work, and how far that repetition got.
      // This is where the v1 progress model was dishonest: it counted such a
      // stage as one step, so a project with several units read as further along
      // than it was. Here the repetition is declared by the graph and the units
      // come from the run, so neither is inferred.
      forEach: stage.forEach,
      unitsPlanned: stage.forEach ? unitNames.length : undefined,
      unitsDone: stage.forEach
        ? unitsDoneFor(stage, status, unitNames, unitsCompleted)
        : undefined,
      unitsInFlight: stage.forEach
        ? unitsInFlightFor(stage, status, unitsCompleted, unitsSeen)
        : undefined,
      // The same field name and shape v1 puts on a per-unit checkpoint. The
      // viewer's journey strip already reads it to show "2/3" on a repeating
      // stage, so producing it here makes the strip show unit progress on a v2
      // project with no change to the strip at all.
      unitProgress: stage.forEach
        ? {
            done: unitsDoneFor(stage, status, unitNames, unitsCompleted),
            total: unitNames.length
          }
        : undefined
    });
  }

  // Furthest checkpoint with evidence, not the most recently touched file. An
  // mtime cursor moves backwards whenever an earlier artifact is edited late,
  // which was observed on a real project and made progress appear to regress.
  let currentIndex = -1;
  for (let i = 0; i < checkpoints.length; i += 1) {
    const node = checkpoints[i];
    if (node.status === V2_STATUS.DONE || node.status === V2_STATUS.ACTIVE) currentIndex = i;
  }

  const counts = { done: 0, active: 0, pending: 0, skipped: 0 };
  for (const node of checkpoints) counts[node.status] += 1;

  const plannedTotal = checkpoints.filter((node) => node.status !== V2_STATUS.SKIPPED).length;

  return {
    checkpoints,
    // Units of work this run decomposed into, empty when it did not decompose.
    units: unitNames,
    currentIndex,
    recentIndex: currentIndex,
    openIndex: -1,
    counts,
    plannedTotal,
    unattributed: []
  };
}

// How many units of work a repeating stage has finished.
//
// Three sources of evidence, ordered by how directly they answer the question:
//
//   1. The stage itself is done. Then every unit it iterates is done, whatever
//      the ledger says, because a stage cannot be approved with work left. This
//      has to come first: a stage running in `subagent` mode was observed
//      finishing all its units without emitting one UNIT_COMPLETED, and trusting
//      the ledger alone reported 0 of 1 on a completed stage.
//   2. Explicit per-unit closures. Right while a stage is still running, which is
//      the only time a partial count is interesting.
//   3. Neither, so zero. Reported as zero rather than guessed from unit rows,
//      because "mentioned" is not "finished".
function unitsDoneFor(stage, status, unitNames, unitsCompleted) {
  if (status === V2_STATUS.DONE) return unitNames.length;
  if (status === V2_STATUS.SKIPPED) return 0;
  return unitsCompleted.get(stage.slug)?.size ?? 0;
}

// Units the ledger shows a stage touching but not closing, so a caller can say
// which unit an in-flight stage is on.
//
// Takes the stage's status for the same reason unitsDoneFor does: a `subagent`
// stage emits no UNIT_COMPLETED at all, so on a completed one the ledger shows
// every unit as seen and none as closed. Reporting those as in flight contradicted
// the count right beside it, which read 1/1 done.
function unitsInFlightFor(stage, status, unitsCompleted, unitsSeen) {
  if (status === V2_STATUS.DONE || status === V2_STATUS.SKIPPED) return [];
  const seen = unitsSeen.get(stage.slug);
  if (!seen) return [];
  const closed = unitsCompleted.get(stage.slug) ?? new Set();
  return [...seen].filter((name) => !closed.has(name)).sort();
}

// Everything the supervision surface needs for one project, or a reason it could
// not be built. Callers get `ok: false` with a `reason` rather than a thrown
// error, because a half-installed project is a normal state to render.
function buildV2(root, options = {}) {
  const stageGraph = graphReader.readStageGraph(root);
  if (!stageGraph) return { ok: false, reason: 'stage-graph-unreadable' };

  const scopeGrid = graphReader.readScopeGrid(root);
  const phases = graphReader.phaseOrder(stageGraph);

  const spaces = runtimeReader.listSpaces(root);
  const intents = [];
  for (const space of spaces) {
    const listing = runtimeReader.listIntents(root, space);
    for (const intent of listing.intents) {
      const runtime = runtimeReader.readRuntime(intent.dir);
      // The denominator comes from the scope this intent records, not from a
      // default: the workflow creates scopes at runtime and the grid is updated
      // in place, so the project's own file is the only source.
      const scopeName = runtime ? runtime.scope : undefined;
      const stages = graphReader.stagesForScope(stageGraph, scopeGrid, scopeName);
      // Per-unit progress lives only in the ledger, so the audit has to be read
      // before the journey can be honest about a stage that repeats.
      const audit = auditReader.summarise(intent.dir);
      const journey = buildFromStages(stages, runtime, audit.unitsCompleted, audit.unitsSeen);
      const disk = runtimeReader.phaseDirsOnDisk(intent.dir, phases);
      intents.push({
        id: intent.id,
        space,
        dir: intent.dir,
        // The manifest records both the scope it was created with and a status;
        // the runtime graph records the scope it actually ran. They should agree,
        // and a disagreement is reported rather than resolved.
        scope: scopeName ?? intent.scope,
        manifestScope: intent.scope,
        manifestStatus: intent.status,
        scopeDisagreement:
          Boolean(scopeName) && Boolean(intent.scope) && scopeName !== intent.scope,
        journey,
        // Reported, not corrected: a directory that is not a phase is either
        // engine bookkeeping or something this model has not met.
        nonPhaseDirs: disk.nonPhaseDirs,
        unknownOutcomes: runtime ? runtime.unknownOutcomes : [],
        unknownRuntimeFields: runtime ? runtime.unknownFields : [],
        unknownEvents: audit.unknownEvents,
        hasRuntime: Boolean(runtime),
        listingSource: listing.source,
        missingOnDisk: listing.missingOnDisk,
        missingFromManifest: listing.missingFromManifest
      });
    }
  }

  return {
    ok: true,
    generation: 'v2',
    phases,
    stageCount: stageGraph.stages.length,
    scopeNames: scopeGrid ? Object.keys(scopeGrid.scopes).sort() : [],
    intents,
    // Everything the data contained that this model does not understand. An
    // empty set here is the claim that the project is fully covered; a non-empty
    // one names exactly what to look at next.
    gaps: {
      unknownStageFields: stageGraph.unknownStageFields,
      unknownScopeDecisions: scopeGrid ? scopeGrid.unknownDecisions : [],
      scopeGridMissing: !scopeGrid,
      intentsWithoutRuntime: intents.filter((i) => !i.hasRuntime).map((i) => i.id),
      unknownOutcomes: [...new Set(intents.flatMap((i) => i.unknownOutcomes))].sort(),
      // A runtime-graph key this model does not read. `bolt_dag` reached us this
      // way: absent from the first project, present in the second, and it holds
      // the unit list.
      unknownRuntimeFields: [
        ...new Set(intents.flatMap((i) => i.unknownRuntimeFields ?? []))
      ].sort(),
      unknownEvents: [...new Set(intents.flatMap((i) => i.unknownEvents ?? []))].sort(),
      nonPhaseDirs: [...new Set(intents.flatMap((i) => i.nonPhaseDirs))].sort(),
      // The manifest and the directory tree are two views of the same list; a
      // name in one and not the other means one of them is stale.
      manifestMissingOnDisk: [...new Set(intents.flatMap((i) => i.missingOnDisk ?? []))].sort(),
      diskMissingFromManifest: [
        ...new Set(intents.flatMap((i) => i.missingFromManifest ?? []))
      ].sort(),
      scopeDisagreements: intents.filter((i) => i.scopeDisagreement).map((i) => i.id)
    },
    options
  };
}

// Which checkpoint an artifact belongs to, for a v2 project.
//
// v1 needs a lookup table for this, because its directory names and its stage
// names are different vocabularies. v2 does not: an artifact's path contains its
// stage's slug as a directory component, so the answer is a set membership test
// against the slugs the compiled graph already declared. No pattern, no parsing,
// and a stage this build has never heard of still matches because the slug came
// from the project rather than from here.
//
// `relPath` is relative to the project root, and the check runs from the deepest
// component outward: a per-unit artifact sits under
// `<phase>/<stage>/<unit>/file.md`, and the stage is the one nearer the file.
function checkpointIndexForPath(journey, relPath) {
  if (!journey || !Array.isArray(journey.checkpoints) || typeof relPath !== 'string') {
    return -1;
  }
  const bySlug = new Map(journey.checkpoints.map((node, index) => [node.id, index]));
  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  // Drop the filename; a stage never matches on it.
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const hit = bySlug.get(segments[i]);
    if (hit !== undefined) return hit;
  }
  return -1;
}

module.exports = {
  V2_STATUS,
  buildFromStages,
  buildV2,
  unitsDoneFor,
  unitsInFlightFor,
  checkpointIndexForPath
};
