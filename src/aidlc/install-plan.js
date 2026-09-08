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


// Paths inside the engine tree that belong to v1, not to v2.
//
// The two generations share `.kiro/`. v2 owns it wholesale except for these, which
// v1's own installer put there and which a v2 install must carry through its
// replacement of that tree. Without this, installing v2 into a project that had v1
// silently deleted v1's rules -- while previewInstall told the user v1 files would
// be left exactly as they are.
//

// Top-level entries of the upstream payload, split by how each may be treated.
//
// Anything the payload carries that is not named here is copied as a plain file,
// and reported, because a payload that grew an entry is news rather than an error.
const ENGINE_ENTRY = '.kiro';
const SEED_ENTRY = 'aidlc';

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
  MARKER_BEGIN,
  MARKER_END,
  ENGINE_ENTRY,
  SEED_ENTRY,
  planRemoval
};
