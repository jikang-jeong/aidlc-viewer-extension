'use strict';

// Reads the engine's own record of what it installed into a project.
//
// WHY THIS EXISTS
//
// Removal has always refused without a receipt, on the grounds that guessing which files
// to delete risks deleting the rules a project accumulated. That still holds. But the
// install is now performed by the engine, which does not write this extension's receipt --
// so removal would refuse on every project the extension had just set up.
//
// The engine writes something better. `.kiro/tools/data/aidlc-manifest.json` lists every
// file it owns with a sha256, plus `rootContributions` describing the files it merges into
// rather than owns. Measured against a real install: 307 owned files, all under the harness
// directory, and the ten seed files under `aidlc/` deliberately absent -- which is exactly
// the boundary this extension already drew by hand.
//
// So rather than keep a parallel record that can disagree with the engine's, this reads the
// engine's and presents it in the shape the removal planner already understands.
//
// WHAT IS DELIBERATELY NOT DONE
//
// The sha256 values are not verified. A file the user edited would fail such a check, and
// refusing to remove an edited file would strand the project. The hashes are read only to
// distinguish an untouched file from a modified one when that distinction is worth showing.
//
// Pure module: never import `vscode`.

const fs = require('fs');
const path = require('path');

// Where the engine writes it. The harness directory is recorded inside the manifest, but
// finding the manifest requires knowing the directory first, so the harnesses this
// extension supports are tried in turn.
const HARNESS_DIRS = ['.kiro'];

const MANIFEST_RELATIVE = path.join('tools', 'data', 'aidlc-manifest.json');

// Locate and read the engine's manifest for a project.
//
// Every failure resolves to undefined rather than throwing: a project with no manifest is
// the ordinary case for a project the extension has never touched, not an error.
function readEngineManifest(root) {
  for (const dir of HARNESS_DIRS) {
    const file = path.join(root, dir, MANIFEST_RELATIVE);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Present but unreadable. Named rather than skipped, because "the engine installed
      // this and its own record is corrupt" is a different situation from "never
      // installed", and silently treating it as the latter would offer to remove nothing.
      return { ok: false, reason: 'manifest-unreadable', path: file };
    }
    if (!parsed || typeof parsed.files !== 'object' || parsed.files === null) {
      return { ok: false, reason: 'manifest-unexpected-shape', path: file };
    }
    return {
      ok: true,
      path: file,
      harnessDir: typeof parsed.harnessDir === 'string' ? parsed.harnessDir : dir,
      version: parsed.frameworkVersion,
      distribution: parsed.distribution,
      files: Object.keys(parsed.files),
      // Files the engine merges a block into rather than owning outright. Removal must
      // take the block back rather than delete the file, which is the same distinction
      // this extension's own receipt drew between `files` and `appended`.
      contributions: Object.entries(parsed.rootContributions ?? {}).map(([file, record]) => ({
        file,
        policy: record?.policy,
        marker: record?.marker
      }))
    };
  }
  return undefined;
}

// The engine's manifest, expressed the way the removal planner reads a receipt.
//
// `seeded` is empty on purpose: the engine does not claim the seed files under `aidlc/`,
// and neither should a removal derived from its manifest. The planner protects that
// directory independently, so this agreeing with it is a second guard rather than the
// only one.
function receiptFromManifest(manifest, { harness } = {}) {
  if (!manifest || !manifest.ok) return undefined;
  return {
    source: 'engine-manifest',
    harness,
    version: manifest.version,
    upstreamCommit: manifest.version,
    files: manifest.files,
    appended: manifest.contributions
      .filter((entry) => entry.policy === 'managed-block' && entry.marker)
      .map((entry) => entry.file),
    seeded: []
  };
}

module.exports = {
  HARNESS_DIRS,
  MANIFEST_RELATIVE,
  readEngineManifest,
  receiptFromManifest
};
