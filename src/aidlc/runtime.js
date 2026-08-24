'use strict';

// Readers for per-intent runtime state.
//
// `runtime-graph.json` is authoritative for progress. Directory existence is a
// fallback only: several stages are approved without creating any directory
// (workspace scaffold, workspace detection, state init were all observed this
// way), so a directory walk alone under-reports what ran.
//
// Outcome values are deliberately NOT enumerated. Only one question is asked --
// "is this the approved value" -- and every other value counts as not finished
// and is reported. A state added upstream then shows up as unknown instead of
// being silently folded into one of the two we happened to see.
//
// Pure module: never import `vscode` here.

const fs = require('fs');
const path = require('path');

const SPACES_DIR = ['aidlc', 'spaces'];
const APPROVED = 'approved';

function readJson(...segments) {
  try {
    return JSON.parse(fs.readFileSync(path.join(...segments), 'utf8'));
  } catch {
    return undefined;
  }
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Anything the engine keeps beside real content is prefixed with a dot. Filtering
// on the prefix rather than on a list of known names means a new bookkeeping file
// does not turn into a phantom intent, phase or artifact. Several of these were
// observed appearing mid-run (`.aidlc-learnings-selections.json` left behind in
// stage directories, `.aidlc-sensors/`, `.aidlc-hooks-health/`).
function isBookkeeping(name) {
  return name.startsWith('.');
}

function listSpaces(root) {
  return listDirs(path.join(root, ...SPACES_DIR)).filter((name) => !isBookkeeping(name));
}

// Intents of a space. `intents.json` is preferred when present because it is the
// engine's own list; the directory walk is the fallback. Directory NAMES are
// never pattern-matched: the observed shape (`YYMMDD-<scope-slug>`) is a
// convention, not a contract, and an intent named anything at all still counts.
function listIntents(root, space) {
  const intentsDir = path.join(root, ...SPACES_DIR, space, 'intents');
  const manifest = readJson(intentsDir, 'intents.json');
  const fromManifest = collectManifestEntries(manifest);
  const onDisk = listDirs(intentsDir).filter((name) => !isBookkeeping(name));

  const matched = fromManifest.filter((entry) => onDisk.includes(entry.dirName));
  // A manifest entry whose directory is absent, and a directory the manifest does
  // not list, are both worth naming: either one means the two sources disagree.
  const missingOnDisk = fromManifest
    .filter((entry) => !onDisk.includes(entry.dirName))
    .map((entry) => entry.dirName ?? entry.slug ?? '(unnamed)');
  const missingFromManifest = fromManifest.length > 0
    ? onDisk.filter((name) => !fromManifest.some((entry) => entry.dirName === name))
    : [];

  const intents = matched.length > 0
    ? matched.map((entry) => ({
        id: entry.dirName,
        slug: entry.slug,
        uuid: entry.uuid,
        scope: entry.scope,
        status: entry.status,
        dir: path.join(intentsDir, entry.dirName)
      }))
    : onDisk.map((name) => ({ id: name, dir: path.join(intentsDir, name) }));

  return {
    intents,
    source: matched.length > 0 ? 'manifest' : 'directory',
    missingOnDisk,
    missingFromManifest
  };
}

// Manifest entries, normalised.
//
// The observed schema is an array of
// `{ uuid, slug, dirName, scope, status }`, and `slug` is NOT the directory name
// -- the directory carries a date prefix the slug does not. Matching on the wrong
// one silently yields zero intents, so `dirName` is the only key used to reach
// disk and the other fields are carried through untouched.
function collectManifestEntries(manifest) {
  const list = Array.isArray(manifest)
    ? manifest
    : manifest && Array.isArray(manifest.intents)
      ? manifest.intents
      : undefined;
  if (!list) return [];
  const entries = [];
  for (const entry of list) {
    // A bare string can only be the directory name; there is nothing else it
    // could address.
    if (typeof entry === 'string') {
      if (!isBookkeeping(entry)) entries.push({ dirName: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const dirName = entry.dirName ?? entry.dir ?? entry.id;
    if (typeof dirName !== 'string' || isBookkeeping(dirName)) continue;
    entries.push({
      dirName,
      slug: entry.slug,
      uuid: entry.uuid,
      scope: entry.scope,
      status: entry.status
    });
  }
  return entries;
}

// Top-level fields this module reads off runtime-graph.json. Anything else is
// surfaced rather than ignored: `bolt_dag` was absent from the first project
// observed and present in the second, and reading only known keys hid it. A
// field this module does not know about may be the only record of a whole
// mechanism, so silence is the wrong default.
const KNOWN_RUNTIME_FIELDS = new Set([
  'workflow_id', 'scope', 'started_at', 'stages', 'bolt_dag'
]);

// Per-stage runtime facts for one intent.
function readRuntime(intentDir) {
  const raw = readJson(intentDir, 'runtime-graph.json');
  if (!raw || !Array.isArray(raw.stages)) return undefined;
  const byStage = new Map();
  const unknownOutcomes = new Set();
  for (const stage of raw.stages) {
    if (!stage || typeof stage.stage_slug !== 'string') continue;
    const outcome = stage.outcome;
    const done = outcome === APPROVED;
    if (!done && typeof outcome === 'string') unknownOutcomes.add(outcome);
    byStage.set(stage.stage_slug, {
      slug: stage.stage_slug,
      outcome,
      done,
      startedAt: stage.started_at,
      completedAt: stage.completed_at,
      agent: stage.agent,
      raw: stage
    });
  }
  return {
    workflowId: raw.workflow_id,
    // The scope recorded here is the one this intent actually runs, which may be
    // a scope invented at runtime and absent from any upstream snapshot.
    scope: raw.scope,
    startedAt: raw.started_at,
    byStage,
    // Units of work, when the run decomposed into any. Absent on runs that never
    // decomposed, which is why this is optional rather than an empty default:
    // "no unit list" and "a list of none" are different facts.
    units: readUnits(raw.bolt_dag),
    unknownFields: Object.keys(raw).filter((key) => !KNOWN_RUNTIME_FIELDS.has(key)).sort(),
    // "pending" is expected; anything else is news.
    unknownOutcomes: [...unknownOutcomes].filter((value) => value !== 'pending').sort()
  };
}

// Units and their execution batches.
//
// The stage graph declares `for_each: "unit-of-work"` on the stages that repeat,
// but the unit LIST is a runtime fact: it does not exist until the workflow has
// decomposed the work. `bolt_dag.batches` groups units that may run together,
// so the batch count is the depth of the dependency chain rather than the number
// of units.
function readUnits(boltDag) {
  if (!boltDag || typeof boltDag !== 'object') return undefined;
  const rawUnits = Array.isArray(boltDag.units) ? boltDag.units : [];
  const units = rawUnits
    .filter((unit) => unit && typeof unit.name === 'string')
    .map((unit) => ({
      name: unit.name,
      kind: unit.kind,
      dependsOn: Array.isArray(unit.depends_on) ? unit.depends_on : []
    }));
  const batches = Array.isArray(boltDag.batches)
    ? boltDag.batches.filter(Array.isArray)
    : [];
  return { units, batches };
}

// Phase directories present inside an intent record. Used only as a fallback and
// as a cross-check: a directory whose name is not in the phase set from the
// stage graph is not a phase, which is how `audit/` and `verification/` are
// excluded without naming them.
function phaseDirsOnDisk(intentDir, phaseNames) {
  const allowed = new Set(phaseNames);
  const found = [];
  const extra = [];
  for (const name of listDirs(intentDir)) {
    if (isBookkeeping(name)) continue;
    if (allowed.has(name)) found.push(name);
    else extra.push(name);
  }
  return { phases: found, nonPhaseDirs: extra };
}

module.exports = {
  APPROVED,
  SPACES_DIR,
  KNOWN_RUNTIME_FIELDS,
  isBookkeeping,
  listSpaces,
  listIntents,
  readRuntime,
  readUnits,
  phaseDirsOnDisk
};
