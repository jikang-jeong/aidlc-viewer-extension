'use strict';

// Readers for the two compiled JSON files a v2 project keeps under
// `.kiro/tools/data/`. Both are written by the engine, so reading a named field
// is a contract; deriving meaning from a value is not.
//
// Design rule for this whole module: nothing about a specific project is
// hardcoded. Stage slugs, phase names, sensor ids and scope names are all read
// from the data. A stage list that grows, a phase that gets renamed and a scope
// invented at runtime all work without a code change. Anything the data
// contains that this module does not understand is reported rather than
// dropped, so a new project immediately shows where the model is thin.
//
// Pure module: never import `vscode` here.

const fs = require('fs');
const path = require('path');

const STAGE_GRAPH = ['.kiro', 'tools', 'data', 'stage-graph.json'];
const SCOPE_GRID = ['.kiro', 'tools', 'data', 'scope-grid.json'];

// Fields this module reads off a stage node. Anything else present in the file
// is surfaced through `unknownStageFields` instead of being silently ignored,
// which is how a schema change announces itself.
const KNOWN_STAGE_FIELDS = new Set([
  'slug', 'name', 'number', 'phase', 'mode', 'execution', 'condition',
  'lead_agent', 'support_agents', 'produces', 'consumes', 'inputs', 'outputs',
  'sensors', 'sensors_applicable', 'requires_stage', 'rules_in_context',
  'scopes', 'summary_confirmation', 'reviewer', 'review_class',
  'reviewer_max_iterations', 'protocol_modules', 'stage_file', 'summary'
]);

function readJson(root, segments) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ...segments), 'utf8'));
  } catch {
    return undefined;
  }
}

// The stage graph is an array of nodes. Order in the file is the workflow order;
// `number` (e.g. "3.5") is a display label, not a sort key we can rely on being
// numeric, so file order is preserved rather than re-sorted.
function readStageGraph(root) {
  const raw = readJson(root, STAGE_GRAPH);
  if (!Array.isArray(raw)) return undefined;

  const unknownStageFields = new Set();
  const stages = [];
  for (const node of raw) {
    if (!node || typeof node.slug !== 'string') continue;
    for (const key of Object.keys(node)) {
      if (!KNOWN_STAGE_FIELDS.has(key)) unknownStageFields.add(key);
    }
    stages.push({
      slug: node.slug,
      name: typeof node.name === 'string' ? node.name : node.slug,
      number: node.number,
      phase: typeof node.phase === 'string' ? node.phase : undefined,
      mode: node.mode,
      execution: node.execution,
      leadAgent: node.lead_agent,
      supportAgents: Array.isArray(node.support_agents) ? node.support_agents : [],
      // Present when the stage repeats once per unit of work. The value names
      // what it iterates over ("unit-of-work" observed); it is carried through
      // rather than interpreted, because the unit LIST is a runtime fact that
      // does not exist until the workflow has decomposed the work.
      forEach: node.for_each,
      // Logical names without extensions: "traceability" is traceability.json,
      // "components" is components.md. Never append an extension here.
      produces: Array.isArray(node.produces) ? node.produces : [],
      consumes: normaliseConsumes(node.consumes),
      sensors: Array.isArray(node.sensors) ? node.sensors : [],
      reviewer: node.reviewer,
      reviewClass: node.review_class,
      raw: node
    });
  }
  if (stages.length === 0) return undefined;
  return { stages, unknownStageFields: [...unknownStageFields].sort() };
}

// `consumes` entries have been seen both as plain strings and as objects with
// `artifact` / `required` / `conditional_on`. Accept either without deciding
// what the condition means.
function normaliseConsumes(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return { artifact: entry };
    if (entry && typeof entry === 'object') {
      return {
        artifact: entry.artifact,
        required: entry.required,
        conditionalOn: entry.conditional_on
      };
    }
    return { artifact: undefined };
  });
}

// Phases in workflow order, derived from where they first appear in the stage
// list. This is what replaces the hardcoded v1 phase order.
function phaseOrder(stageGraph) {
  const seen = [];
  for (const stage of stageGraph.stages) {
    if (stage.phase && !seen.includes(stage.phase)) seen.push(stage.phase);
  }
  return seen;
}

// The scope grid maps a scope name to a per-stage EXECUTE/SKIP decision. It is
// NOT static upstream data: the workflow writes custom scopes into it at
// runtime, so it must be read from the project every time.
//
// Only "is this stage in scope" is decided here, and only by asking whether the
// value equals the execute marker. Any other value counts as out of scope and
// is reported, so a third state added upstream shows up instead of being
// mistaken for one of the two we know.
const EXECUTE = 'EXECUTE';

function readScopeGrid(root) {
  const raw = readJson(root, SCOPE_GRID);
  if (!raw || typeof raw !== 'object') return undefined;
  const scopes = {};
  const unknownDecisions = new Set();
  for (const [scopeName, entry] of Object.entries(raw)) {
    const stages = entry && typeof entry === 'object' ? entry.stages : undefined;
    if (!stages || typeof stages !== 'object') continue;
    const inScope = new Set();
    for (const [slug, decision] of Object.entries(stages)) {
      if (decision === EXECUTE) inScope.add(slug);
      else if (typeof decision === 'string') unknownDecisions.add(decision);
    }
    scopes[scopeName] = { inScope, raw: entry };
  }
  if (Object.keys(scopes).length === 0) return undefined;
  return {
    scopes,
    // "SKIP" is expected; anything else is news.
    unknownDecisions: [...unknownDecisions].filter((d) => d !== 'SKIP').sort()
  };
}

// Stages of a scope, in workflow order, each tagged with whether the scope runs
// it. A scope name absent from the grid yields every stage as in-scope, because
// claiming a stage is skipped on missing data would understate the work left.
function stagesForScope(stageGraph, scopeGrid, scopeName) {
  const entry = scopeGrid && scopeName ? scopeGrid.scopes[scopeName] : undefined;
  return stageGraph.stages.map((stage) => ({
    ...stage,
    inScope: entry ? entry.inScope.has(stage.slug) : true
  }));
}

module.exports = {
  EXECUTE,
  KNOWN_STAGE_FIELDS,
  STAGE_GRAPH,
  SCOPE_GRID,
  readStageGraph,
  readScopeGrid,
  phaseOrder,
  stagesForScope
};
