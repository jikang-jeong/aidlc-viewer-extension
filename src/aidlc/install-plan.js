'use strict';

// Plans a v2 install as a list of operations, and never performs one.
//
// Separating the plan from the doing is what makes this reviewable. A caller can
// show the plan, refuse it, or execute it, and every decision about what to touch
// is made here where it can be read and tested rather than inline in a loop that
// is already writing files.
//
// The one rule the whole module exists to enforce: an install may create the
// `aidlc/` seed and may never overwrite it. Nine files are seeded there, and the
// workflow then turns them into the project's own accumulated rules -- three
// observed projects had six learned rules in project.md and an affirmed practice
// in team.md. Those live nowhere else. So a project whose memory has moved past
// the seed gets its `.kiro/` engine replaced and its `aidlc/` left alone, and the
// plan says so explicitly rather than relying on a copy routine to skip.
//
// Pure module: never import `vscode`, never touch the filesystem. It is handed a
// listing and returns operations.

const path = require('path');

const {
  RECEIPT_PATH,
  RECEIPT_SCHEMA,
  SHARED_FILES
} = require('./install-state');

// Marker pair delimiting the section this extension appends to a file it shares.
// Removal finds its own work by these and leaves everything else, which is the
// only way to take back an append without guessing where it ended.
const MARKER_BEGIN = '<!-- BEGIN AIDLC VIEWER -->';
const MARKER_END = '<!-- END AIDLC VIEWER -->';

// Operation kinds. Deliberately few, and each one describable in a sentence to a
// user before it runs.
const OP = {
  REPLACE_TREE: 'replace-tree',
  SEED_TREE: 'seed-tree',
  COPY_FILE: 'copy-file',
  APPEND_SECTION: 'append-section',
  WRITE_RECEIPT: 'write-receipt'
};

// Paths inside the engine tree that belong to v1, not to v2.
//
// The two generations share `.kiro/`. v2 owns it wholesale except for these, which
// v1's own installer put there and which a v2 install must carry through its
// replacement of that tree. Without this, installing v2 into a project that had v1
// silently deleted v1's rules -- while previewInstall told the user v1 files would
// be left exactly as they are.
//
// Listed as top-level names under `.kiro/` rather than as full paths, because that
// is the granularity the replace operation preserves at.
const V1_PATHS_INSIDE_ENGINE = ['steering', 'aws-aidlc-rule-details'];

// Top-level entries of the upstream payload, split by how each may be treated.
//
// Anything the payload carries that is not named here is copied as a plain file,
// and reported, because a payload that grew an entry is news rather than an error.
const ENGINE_ENTRY = '.kiro';
const SEED_ENTRY = 'aidlc';

// Build the plan.
//
// `payloadEntries` is the top-level listing of the extracted upstream payload, as
// `{ name, isDirectory }`. `state` comes from readInstallState.
function planInstall({ payloadEntries, state, harness, upstreamCommit }) {
  const ops = [];
  const notes = [];
  const unexpected = [];

  const memoryMovedOn = Boolean(state && state.memory && state.memory.beyondSeed);

  for (const entry of payloadEntries) {
    if (entry.name === ENGINE_ENTRY) {
      // The engine is wholly owned by whoever installed it, so a reinstall
      // replaces it outright. Replacing rather than merging is the point: a
      // half-old engine is a configuration nobody has tested.
      ops.push({
        type: OP.REPLACE_TREE,
        from: entry.name,
        to: entry.name,
        // The receipt lives inside this tree and must survive its replacement,
        // or removal loses the record of what to remove. v1's rules live there
        // too, and the preview promises they are left alone, so they are carried
        // through as well.
        preserve: [
          path.join(...RECEIPT_PATH.slice(1)),
          ...V1_PATHS_INSIDE_ENGINE
        ]
      });
      continue;
    }

    if (entry.name === SEED_ENTRY) {
      if (memoryMovedOn) {
        // The refusal this module exists for.
        notes.push({
          level: 'warn',
          text:
            `aidlc/ holds ${state.memory.fileCount} files, so the workflow has ` +
            'written its own rules and records there. It is left untouched; the ' +
            'seed is not reapplied.'
        });
        continue;
      }
      // Absent, or present and still exactly the seed. Seeding fills in what is
      // missing and never replaces a file that is already there, so a project
      // that edited one seed file before running anything keeps that edit.
      ops.push({ type: OP.SEED_TREE, from: entry.name, to: entry.name });
      continue;
    }

    if (SHARED_FILES.includes(entry.name)) {
      // Shared with whatever else the project keeps in that file.
      ops.push({
        type: OP.APPEND_SECTION,
        from: entry.name,
        to: entry.name,
        markerBegin: MARKER_BEGIN,
        markerEnd: MARKER_END
      });
      continue;
    }

    if (entry.isDirectory) {
      // A directory the payload grew. Seeded rather than replaced, because this
      // build does not know whether the project owns anything inside it.
      unexpected.push(entry.name);
      ops.push({ type: OP.SEED_TREE, from: entry.name, to: entry.name });
      continue;
    }

    unexpected.push(entry.name);
    ops.push({ type: OP.COPY_FILE, from: entry.name, to: entry.name });
  }

  if (unexpected.length > 0) {
    notes.push({
      level: 'info',
      text:
        `The upstream payload carries ${unexpected.join(', ')}, which this build ` +
        'has no specific handling for. Copied without replacing anything.'
    });
  }

  ops.push({
    type: OP.WRITE_RECEIPT,
    to: path.join(...RECEIPT_PATH),
    receipt: {
      schemaVersion: RECEIPT_SCHEMA,
      harness,
      upstreamCommit,
      // Filled in by the executor with what it actually wrote, so removal takes
      // back exactly that and not what the plan hoped for.
      files: [],
      appended: []
    }
  });

  return { ops, notes, unexpected };
}

// Build the removal plan from a receipt.
//
// Only what the receipt records is removed. Without a receipt nothing can be
// removed safely, and this returns a refusal rather than falling back to deleting
// what looks like an install: `.kiro/` and `aidlc/` are exactly the directories a
// project keeps its own work in, and a wrong guess there is unrecoverable.
function planRemoval(state) {
  if (!state || !state.receipt) {
    return {
      blocked: true,
      reason: 'no-receipt',
      text:
        'No install receipt from this extension, so there is no record of which ' +
        'files it added. Remove them by hand rather than have this guess.'
    };
  }

  // A receipt from an older build, or one hand-edited, could name a path under the
  // seed directory. Filtered here rather than trusted, because the consequence of
  // getting it wrong is deleting the rules a project accumulated: the seeded
  // `aidlc/spaces/default/memory/project.md` is the very file the workflow appends
  // every learned correction to, and no backup covers it.
  const seedPrefix = `${SEED_ENTRY}${path.sep}`;
  const protectedPaths = [];
  const removable = state.receipt.files.filter((file) => {
    const normalised = file.split('/').join(path.sep);
    if (normalised === SEED_ENTRY || normalised.startsWith(seedPrefix)) {
      protectedPaths.push(file);
      return false;
    }
    return true;
  });

  const ops = removable.map((file) => ({ type: 'delete-file', to: file }));
  for (const file of state.receipt.appended) {
    ops.push({
      type: 'remove-section',
      to: file,
      markerBegin: MARKER_BEGIN,
      markerEnd: MARKER_END
    });
  }
  ops.push({ type: 'delete-file', to: path.join(...RECEIPT_PATH) });

  const notes = [];
  if (protectedPaths.length > 0) {
    notes.push({
      level: 'info',
      text:
        `${protectedPaths.length} path(s) the installer seeded under ${SEED_ENTRY}/ ` +
        'are left in place, because the workflow writes the project\'s own rules to ' +
        'those same paths.'
    });
  }
  if (state.memory && state.memory.beyondSeed) {
    notes.push({
      level: 'warn',
      text:
        `aidlc/ holds ${state.memory.fileCount} files of workflow output and ` +
        'accumulated rules. Removal does not delete it, and nothing else will ' +
        'either -- delete it yourself only if you mean to lose that history.'
    });
  }
  return { blocked: false, ops, notes, protectedPaths };
}

module.exports = {
  OP,
  V1_PATHS_INSIDE_ENGINE,
  MARKER_BEGIN,
  MARKER_END,
  ENGINE_ENTRY,
  SEED_ENTRY,
  planInstall,
  planRemoval
};
