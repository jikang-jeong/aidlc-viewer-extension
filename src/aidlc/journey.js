'use strict';

// AI-DLC v1 journey model.
//
// PURE MODULE — must never require('vscode').
//
// The extension host collects a flat list of markdown artifacts under the stage
// root and hands it here; every derived fact (which checkpoint ran, which was
// skipped, where the project currently is, which checkpoint a given file belongs
// to) is computed from that list alone.
//
// Why this shape:
//   * Directory names are mandated by core-workflow.md and are stable across
//     projects. Filenames are mostly agent-invented and drift (the rules say
//     `component-dependency.md`, real projects emit `component-dependencies.md`),
//     so filenames are only consulted where a directory is genuinely ambiguous.
//   * No markdown CONTENT is parsed. aidlc-state.md is enrichment elsewhere,
//     never load-bearing here, so a malformed or future-version state file cannot
//     break the journey.
//   * Keeping vscode out means the host can keep using vscode.workspace.fs
//     (remote/virtual filesystems) while this stays unit-testable.
//
// DELIBERATE POLICY: artifacts this model cannot attribute to a checkpoint are
// reported in `unattributed` rather than guessed at. Five real projects were used
// to develop this model and each of the last three broke an assumption the earlier
// ones had confirmed, so guessing at non-mandated filenames is expected to be wrong
// again on the next project. Surfacing the gap lets the UI say "N artifacts are not
// mapped to a stage" and lets the next counter-example be found instead of hidden.
// Do not replace this with a heuristic mapping without a mandated filename to rely on.

const PHASE = {
  SETUP: 'setup',
  INCEPTION: 'inception',
  CONSTRUCTION: 'construction',
  OPERATIONS: 'operations'
};

const STATUS = {
  DONE: 'done',
  ACTIVE: 'active',
  PENDING: 'pending',
  SKIPPED: 'skipped'
};

// Subdirectories of construction/ that are not units of work.
const CONSTRUCTION_RESERVED = new Set(['plans', 'build-and-test', 'shared-infrastructure']);

// Workflow bookkeeping files, never a stage artifact. Observed in a real project:
// a copy of audit.md sat inside operations/, which made Operations look complete
// on a project that never ran it.
const BOOKKEEPING_FILE = /^(audit|aidlc-state)\.md$/i;

// Ordered checkpoints. Order is the AI-DLC v1 stage order from core-workflow.md,
// with the extension's own rule setup prepended as checkpoint 1.
//
// kind:
//   external — not an artifact-producing stage; status supplied by the caller
//   implicit — produces no directory of its own; inferred from any artifact existing
//   dir      — owns every artifact under dir[] (optionally minus excludeFile)
//   file     — owns artifacts under dir[] whose filename matches file
//   unit     — repeats per unit: construction/<unit>/<unitDir>/
//
// plan: filename pattern under a plans/ directory that EVIDENCES the stage ran,
// even when the stage wrote no artifact of its own. These names are mandated by
// core-workflow.md (`aidlc-docs/construction/plans/{unit-name}-{stage}-plan`).
// For construction plans the leading capture group is the unit name.
//
// Deliberately NOT treated as evidence: inception/plans/user-stories-assessment.md.
// That file records the decision of WHETHER to run User Stories, so it is present
// in projects that decided to skip the stage.
const CHECKPOINTS = [
  { id: 'setup-repo', label: 'Setup repo', phase: PHASE.SETUP, kind: 'external' },
  { id: 'workspace-detection', label: 'Workspace detection', phase: PHASE.INCEPTION, kind: 'implicit' },
  {
    id: 'reverse-engineering',
    label: 'Reverse engineering',
    phase: PHASE.INCEPTION,
    kind: 'dir',
    dir: ['inception', 'reverse-engineering'],
    conditional: true
  },
  {
    id: 'requirements-analysis',
    label: 'Requirements analysis',
    phase: PHASE.INCEPTION,
    kind: 'dir',
    dir: ['inception', 'requirements']
  },
  {
    id: 'user-stories',
    label: 'User stories',
    phase: PHASE.INCEPTION,
    kind: 'dir',
    dir: ['inception', 'user-stories'],
    plan: /^story-generation-plan\.md$/i,
    conditional: true
  },
  {
    // Workflow Planning writes no directory of its own; execution-plan.md in
    // inception/plans/ is its artifact.
    id: 'workflow-planning',
    label: 'Workflow planning',
    phase: PHASE.INCEPTION,
    kind: 'file',
    dir: ['inception', 'plans'],
    file: /^execution-plan\.md$/i
  },
  {
    // Application Design and Units Generation share inception/application-design/.
    // The unit-of-work* files belong to Units Generation; everything else here
    // belongs to Application Design.
    id: 'application-design',
    label: 'Application design',
    phase: PHASE.INCEPTION,
    kind: 'dir',
    dir: ['inception', 'application-design'],
    excludeFile: /^unit-of-work/i,
    plan: /^application-design-plan\.md$/i,
    conditional: true
  },
  {
    id: 'units-generation',
    label: 'Units generation',
    phase: PHASE.INCEPTION,
    kind: 'file',
    dir: ['inception', 'application-design'],
    file: /^unit-of-work/i,
    plan: /^unit-of-work-plan\.md$/i,
    conditional: true
  },
  { id: 'functional-design', label: 'Functional design', phase: PHASE.CONSTRUCTION, kind: 'unit', unitDir: 'functional-design', plan: /^(?:(.+)-)?functional-design-plan\.md$/i, conditional: true },
  { id: 'nfr-requirements', label: 'NFR requirements', phase: PHASE.CONSTRUCTION, kind: 'unit', unitDir: 'nfr-requirements', plan: /^(?:(.+)-)?nfr-requirements-plan\.md$/i, conditional: true },
  { id: 'nfr-design', label: 'NFR design', phase: PHASE.CONSTRUCTION, kind: 'unit', unitDir: 'nfr-design', plan: /^(?:(.+)-)?nfr-design-plan\.md$/i, conditional: true },
  { id: 'infrastructure-design', label: 'Infrastructure design', phase: PHASE.CONSTRUCTION, kind: 'unit', unitDir: 'infrastructure-design', plan: /^(?:(.+)-)?infrastructure-design-plan\.md$/i, conditional: true },
  { id: 'code-generation', label: 'Code generation', phase: PHASE.CONSTRUCTION, kind: 'unit', unitDir: 'code', plan: /^(?:(.+)-)?code-generation-plan\.md$/i },
  { id: 'build-and-test', label: 'Build and test', phase: PHASE.CONSTRUCTION, kind: 'dir', dir: ['construction', 'build-and-test'] },
  {
    // v1 does not implement this phase. operations.md states it plainly:
    //   "This phase is currently a placeholder and will be expanded in future
    //    versions. The AI-DLC workflow currently ends after the Build and Test
    //    phase in CONSTRUCTION."
    // So it is excluded from the planned count until it actually produces
    // artifacts. Counting it would mean no v1 project could ever read complete.
    id: 'operations',
    label: 'Operations',
    phase: PHASE.OPERATIONS,
    kind: 'dir',
    dir: ['operations'],
    placeholder: true
  }
];

const CHECKPOINT_INDEX_BY_ID = new Map(CHECKPOINTS.map((cp, i) => [cp.id, i]));

function splitPath(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
}

function startsWithDir(segments, dir) {
  if (segments.length !== dir.length + 1) {
    // Artifacts must sit directly inside the stage directory, not deeper.
    return false;
  }
  return dir.every((part, i) => segments[i].toLowerCase() === part);
}

/**
 * Which unit of work does this path belong to, if any?
 *
 *   construction/<unit>/<stageDir>/<file>.md  -> { unit, stageDir }
 *   construction/<unit>/<file>.md             -> { unit, stageDir: undefined }
 *
 * The flat form has no per-stage directory. Observed in a real project whose five
 * units each held a single combined `unit-design.md`. The unit must still be
 * discovered there, otherwise every per-unit checkpoint reports a total of zero.
 */
function unitOf(segments) {
  if (segments.length < 3) return undefined;
  if (segments[0].toLowerCase() !== 'construction') return undefined;
  const unit = segments[1];
  if (CONSTRUCTION_RESERVED.has(unit.toLowerCase())) return undefined;
  return { unit, stageDir: segments.length >= 4 ? segments[2].toLowerCase() : undefined };
}

/**
 * Map one artifact path to a checkpoint id, or undefined when the artifact is not
 * attributable (plan files other than execution-plan.md, stray documents, ...).
 * Unattributable artifacts never affect status or current position.
 *
 * @param {string} relPath path relative to the stage root (the aidlc-docs folder)
 * @returns {string|undefined} checkpoint id
 */
function checkpointIdForPath(relPath) {
  const segments = splitPath(relPath);
  if (segments.length === 0) return undefined;

  const fileName = segments[segments.length - 1];
  if (!/\.md$/i.test(fileName)) return undefined;
  if (BOOKKEEPING_FILE.test(fileName)) return undefined;

  const unitHit = unitOf(segments);
  if (unitHit) {
    if (!unitHit.stageDir) return undefined; // flat unit file: unit known, stage not
    const cp = CHECKPOINTS.find((c) => c.kind === 'unit' && c.unitDir === unitHit.stageDir);
    return cp ? cp.id : undefined;
  }

  for (const cp of CHECKPOINTS) {
    if (cp.kind === 'file') {
      if (startsWithDir(segments, cp.dir) && cp.file.test(fileName)) return cp.id;
    }
  }

  for (const cp of CHECKPOINTS) {
    if (cp.kind === 'dir') {
      if (!startsWithDir(segments, cp.dir)) continue;
      if (cp.excludeFile && cp.excludeFile.test(fileName)) continue;
      return cp.id;
    }
  }

  return undefined;
}

/**
 * Collect plan-file evidence. Plan files are NOT artifacts of the stage (they are
 * process documents), but their mandated names evidence that the stage ran even
 * when its own artifact directory is absent.
 *
 * Observed in a real project: construction/plans/dashboard-app-code-generation-plan.md
 * existed with no construction/dashboard-app/code/ directory, while build-and-test
 * had completed. Without plan evidence, Code Generation reported "skipped" for a
 * project that demonstrably generated and built code.
 *
 * @returns {Map<string, Set<string>>} checkpoint id -> set of unit names ('' when not per-unit)
 */
function collectPlanEvidence(artifacts) {
  const evidence = new Map();

  for (const artifact of artifacts) {
    const segments = splitPath(artifact && artifact.relPath);
    if (segments.length !== 3) continue;
    if (segments[1].toLowerCase() !== 'plans') continue;

    const fileName = segments[2];
    for (const cp of CHECKPOINTS) {
      if (!cp.plan) continue;
      const match = fileName.match(cp.plan);
      if (!match) continue;
      if (!evidence.has(cp.id)) evidence.set(cp.id, new Set());
      // Construction plan patterns capture the unit name in group 1.
      evidence.get(cp.id).add(match[1] ? match[1] : '');
    }
  }

  return evidence;
}

/**
 * Build the journey model.
 *
 * Status is resolved from three independent kinds of evidence, in this order:
 *   1. direct   — the stage's own artifacts exist
 *   2. planned  — the stage's plan file exists (it was entered)
 *   3. position — a LATER stage produced artifacts (so this one was passed)
 *
 * Absence of a stage's own artifact is NOT absence of the stage. Three real
 * projects each broke a naive artifact-only rule in a different place, so the
 * evidence tiers are deliberately general rather than special-cased per stage.
 *
 * @param {object} input
 * @param {Array<{relPath: string, mtime?: number}>} input.artifacts markdown files under the stage root
 * @param {boolean} [input.rulesInstalled] whether AI-DLC rules exist in the project
 * @param {string} [input.openFileRelPath] the artifact currently open in the viewer
 * @returns {{checkpoints: Array, units: string[], currentIndex: number, openIndex: number, counts: object}}
 */
function buildJourney(input) {
  const artifacts = Array.isArray(input && input.artifacts) ? input.artifacts : [];
  const rulesInstalled = Boolean(input && input.rulesInstalled);

  // --- attribute artifacts -------------------------------------------------
  const countById = new Map();
  const unitsByCheckpoint = new Map(); // checkpoint id -> Set(unit) with direct artifacts
  const allUnits = new Set();
  const unattributed = [];
  let newest;

  for (const artifact of artifacts) {
    const segments = splitPath(artifact && artifact.relPath);
    const unitHit = unitOf(segments);
    if (unitHit) allUnits.add(unitHit.unit);

    const id = checkpointIdForPath(artifact && artifact.relPath);
    if (!id) {
      const fileName = segments[segments.length - 1] || '';
      // Plans and bookkeeping are expected to be unattributed; anything else is a
      // shape this model does not recognise and is surfaced so it is not lost
      // silently.
      const expected = segments[1] === 'plans' || BOOKKEEPING_FILE.test(fileName);
      if (!expected && /\.md$/i.test(fileName)) unattributed.push(artifact.relPath);
      continue;
    }

    countById.set(id, (countById.get(id) || 0) + 1);
    if (unitHit) {
      if (!unitsByCheckpoint.has(id)) unitsByCheckpoint.set(id, new Set());
      unitsByCheckpoint.get(id).add(unitHit.unit);
    }

    const mtime = Number(artifact.mtime) || 0;
    if (!newest || mtime > newest.mtime) {
      newest = { id, mtime, relPath: artifact.relPath };
    }
  }

  const planEvidence = collectPlanEvidence(artifacts);
  const units = [...allUnits].sort();
  const anyArtifact = countById.size > 0;

  // A later stage having artifacts means this stage was passed, not pending.
  const hasLaterArtifacts = CHECKPOINTS.map(() => false);
  for (let i = CHECKPOINTS.length - 2; i >= 0; i -= 1) {
    const nextProduced = (countById.get(CHECKPOINTS[i + 1].id) || 0) > 0;
    hasLaterArtifacts[i] = nextProduced || hasLaterArtifacts[i + 1];
  }

  const checkpoints = CHECKPOINTS.map((cp, i) => {
    const artifactCount = countById.get(cp.id) || 0;
    const planned = planEvidence.get(cp.id);
    const passed = hasLaterArtifacts[i];

    const node = {
      id: cp.id,
      label: cp.label,
      phase: cp.phase,
      conditional: Boolean(cp.conditional),
      placeholder: Boolean(cp.placeholder),
      artifactCount,
      planned: Boolean(planned),
      status: STATUS.PENDING
    };

    if (cp.kind === 'external') {
      node.status = rulesInstalled ? STATUS.DONE : STATUS.PENDING;
      return node;
    }

    if (cp.kind === 'implicit') {
      // Workspace Detection always runs first; no artifact can exist without it.
      node.status = anyArtifact ? STATUS.DONE : STATUS.PENDING;
      return node;
    }

    if (cp.kind === 'unit') {
      const directUnits = unitsByCheckpoint.get(cp.id) || new Set();
      const plannedUnits = planned || new Set();
      node.unitProgress = { done: directUnits.size, total: units.length };
      node.unitsDone = [...directUnits].sort();
      node.unitsPlanned = [...plannedUnits].filter(Boolean).sort();

      if (directUnits.size > 0 && directUnits.size >= units.length) {
        node.status = STATUS.DONE;
      } else if (directUnits.size > 0) {
        node.status = STATUS.ACTIVE;
      } else if (plannedUnits.size > 0) {
        // Entered (a plan exists) but wrote no artifact. Completed if the workflow
        // has since moved past it.
        node.status = passed ? STATUS.DONE : STATUS.ACTIVE;
      } else if (units.length > 0 && passed) {
        node.status = STATUS.SKIPPED;
      } else if (passed) {
        node.status = STATUS.SKIPPED;
      }
      return node;
    }

    // dir / file kinds
    if (artifactCount > 0) {
      node.status = STATUS.DONE;
    } else if (cp.id === 'units-generation' && units.length > 0) {
      // Units existing is itself the outcome of Units Generation, even when
      // inception/application-design/unit-of-work*.md was never written.
      node.status = STATUS.DONE;
    } else if (planned) {
      node.status = passed ? STATUS.DONE : STATUS.ACTIVE;
    } else if (passed) {
      node.status = STATUS.SKIPPED;
    }

    return node;
  });

  // --- cursors -------------------------------------------------------------
  // "Where am I" is the FURTHEST checkpoint with evidence, not the most recently
  // touched file. Observed in a real project: execution-plan.md was edited six days
  // after the workflow finished, so an mtime cursor jumped backwards to Workflow
  // planning on an otherwise completed project. mtime is kept as a separate,
  // clearly-named signal instead.
  let currentIndex = -1;
  for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
    if (checkpoints[i].status === STATUS.DONE || checkpoints[i].status === STATUS.ACTIVE) {
      currentIndex = i;
      break;
    }
  }

  const recentIdx = newest === undefined ? undefined : CHECKPOINT_INDEX_BY_ID.get(newest.id);
  const recentIndex = recentIdx === undefined ? -1 : recentIdx;

  const openId = input && input.openFileRelPath ? checkpointIdForPath(input.openFileRelPath) : undefined;
  const openIdx = openId === undefined ? undefined : CHECKPOINT_INDEX_BY_ID.get(openId);
  const openIndex = openIdx === undefined ? -1 : openIdx;

  const counts = { done: 0, active: 0, pending: 0, skipped: 0 };
  for (const node of checkpoints) counts[node.status] += 1;

  // Denominator for "how far along is this project". A checkpoint is excluded when
  // it was skipped by the adaptive workflow (not work left to do) or when it is a
  // placeholder the workflow never reaches and it produced nothing.
  const plannedTotal = checkpoints.filter(
    (node) => node.status !== STATUS.SKIPPED && !(node.placeholder && node.status !== STATUS.DONE)
  ).length;

  return {
    checkpoints,
    units,
    currentIndex,
    recentIndex,
    openIndex,
    counts,
    plannedTotal,
    // Sorted so the UI renders a stable list and tests are order-independent:
    // directory walk order is filesystem-dependent.
    unattributed: unattributed.sort()
  };
}

module.exports = {
  PHASE,
  STATUS,
  CHECKPOINTS,
  buildJourney,
  checkpointIdForPath
};
