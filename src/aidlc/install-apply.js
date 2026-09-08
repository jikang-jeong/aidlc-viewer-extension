'use strict';

// Executes an install plan, and records exactly what it wrote.
//
// This is the only module here that modifies a project, so everything it does is
// deliberately dull: no path is computed from a pattern, every destination is
// checked to be inside the project root, and each write is appended to a receipt
// as it happens rather than predicted up front. The receipt is what makes removal
// possible, and a receipt of what the plan intended rather than what the executor
// achieved would remove the wrong files after a partial failure.
//
// The rule inherited from the plan and enforced again here: SEED_TREE never
// overwrites an existing file. It is written as a separate operation from
// REPLACE_TREE precisely so that the difference cannot be lost in a shared copy
// helper -- the seed becomes the project's accumulated rules the moment the
// workflow runs, and three observed projects had grown theirs to 138-146 files.
//
// Pure module: never import `vscode`. The caller owns all user interaction.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { OP } = require('./install-plan');

// Every destination is resolved and then checked to be strictly inside the root.
//
// "Strictly" is the whole point. An entry named `''`, `.` or `./` resolves to the
// root itself, and REPLACE_TREE deletes its target recursively -- so accepting a
// destination equal to the root would let one malformed payload entry erase the
// user's entire project. The payload arrives over the network and its top-level
// names become these destinations verbatim, so this is an input, not a hypothesis.
//
// `..` traversal is refused by the same check.
function resolveInside(root, relative) {
  if (typeof relative !== 'string' || relative.trim() === '') return undefined;
  const bounded = path.resolve(root);
  const full = path.resolve(bounded, relative);
  // Must be a proper descendant: equal to the root is refused, not allowed.
  if (full === bounded || !full.startsWith(bounded + path.sep)) return undefined;
  return full;
}

function listFilesRelative(dir, prefix = '', limit = 5000) {
  const out = [];
  const queue = [{ dir, prefix }];
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = current.prefix ? path.join(current.prefix, entry.name) : entry.name;
      if (entry.isDirectory()) queue.push({ dir: path.join(current.dir, entry.name), prefix: rel });
      else out.push(rel);
    }
  }
  return out;
}

// Undo an install from its receipt.
//
// Empty directories left behind are removed only when they are inside a tree the
// installer created, and only when they are empty, so a directory the project put
// something else in survives.
function applyRemoval({ root, ops }) {
  const removed = [];
  const kept = [];

  for (const op of ops) {
    const target = resolveInside(root, op.to);
    if (!target) {
      kept.push({ path: op.to, reason: 'escapes-root' });
      continue;
    }
    if (op.type === 'delete-file') {
      try {
        fs.rmSync(target, { force: true });
        removed.push(op.to);
      } catch (error) {
        kept.push({ path: op.to, reason: String(error.message) });
      }
      continue;
    }
    if (op.type === 'remove-section') {
      let existing;
      try {
        existing = fs.readFileSync(target, 'utf8');
      } catch {
        kept.push({ path: op.to, reason: 'absent' });
        continue;
      }
      const begin = existing.indexOf(op.markerBegin);
      const end = existing.indexOf(op.markerEnd);
      if (begin === -1 || end <= begin) {
        // The markers are gone, so someone edited the section. Removing a guessed
        // range would take their edit with it.
        kept.push({ path: op.to, reason: 'markers-not-found' });
        continue;
      }
      const rest = `${existing.slice(0, begin)}${existing
        .slice(end + op.markerEnd.length)
        .replace(/^\n/, '')}`;
      if (rest.trim() === '') fs.rmSync(target, { force: true });
      else fs.writeFileSync(target, rest);
      removed.push(op.to);
    }
  }

  pruneEmptyDirs(root, removed);
  return { ok: true, removed, kept };
}

// Remove directories the deletions emptied, deepest first, never the root.
function pruneEmptyDirs(root, removedPaths) {
  const dirs = new Set();
  for (const rel of removedPaths) {
    let dir = path.dirname(rel);
    while (dir && dir !== '.' && dir !== path.sep) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  for (const rel of [...dirs].sort((a, b) => b.length - a.length)) {
    const full = resolveInside(root, rel);
    if (!full || full === path.resolve(root)) continue;
    try {
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    } catch {
      // Not empty, or gone already. Either way there is nothing to do.
    }
  }
}

module.exports = { resolveInside, listFilesRelative, applyRemoval };
