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

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// Replace a tree, keeping named files and subtrees that live inside it.
//
// The receipt is inside `.kiro/` because that is the tree the installer owns, so
// replacing that tree would destroy the record of what to remove. v1's rules sit
// in there too, under directories v2 knows nothing about, and the install preview
// promises they are left alone -- so a preserve entry may name a whole subtree and
// not only a file.
//
// Preserved content is moved aside rather than read into memory, because v1's rule
// details run to dozens of files and buffering a subtree of unknown size to delete
// its parent is the kind of thing that works until it does not.
function replaceTree(payloadDir, root, op, written) {
  const target = resolveInside(root, op.to);
  const source = path.join(payloadDir, op.from);
  if (!target) return { ok: false, reason: 'escapes-root', text: op.to };

  let holding;
  const moved = [];
  for (const rel of op.preserve ?? []) {
    const from = path.join(target, rel);
    if (!fs.existsSync(from)) continue; // absent is normal on a first install
    holding = holding ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-preserve-'));
    const to = path.join(holding, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved.push(rel);
    } catch {
      // A rename can fail across devices. Falling back to a copy keeps the
      // guarantee that preserved content survives, which matters more than speed.
      try {
        fs.cpSync(from, to, { recursive: true });
        moved.push(rel);
      } catch {
        // Could not set it aside, so the replacement below would destroy it.
        return { ok: false, reason: 'preserve-failed', text: rel };
      }
    }
  }

  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, reason: 'replace-failed', text: String(error.message) };
  }

  for (const rel of listFilesRelative(source)) {
    copyFile(path.join(source, rel), path.join(target, rel));
    written.push(path.join(op.to, rel));
  }
  for (const rel of moved) {
    const from = path.join(holding, rel);
    const to = path.join(target, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch {
      fs.cpSync(from, to, { recursive: true });
    }
  }
  if (holding) {
    try {
      fs.rmSync(holding, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not worth failing an install over.
    }
  }
  return { ok: true };
}

// Fill in what is missing and touch nothing that exists.
//
// The whole point of the seed being a distinct operation. A file already there is
// the project's, whether the workflow wrote it or a person edited it before the
// first run, and either way it is not ours to replace.
//
// Seeded paths are recorded SEPARATELY from written ones, and removal never reads
// that list. The reason is that a seeded path and the project's own rules are the
// same path: `aidlc/spaces/default/memory/project.md` is seeded empty and then
// becomes the file the workflow appends every learned correction to. Removal
// cannot tell those apart by looking, so it does not try -- it leaves the whole
// directory and says so. Recording the paths anyway keeps the receipt an honest
// account of what the installer put there.
function seedTree(payloadDir, root, op, seeded) {
  const target = resolveInside(root, op.to);
  const source = path.join(payloadDir, op.from);
  if (!target) return { ok: false, reason: 'escapes-root', text: op.to };

  for (const rel of listFilesRelative(source)) {
    const dest = path.join(target, rel);
    if (fs.existsSync(dest)) continue;
    copyFile(path.join(source, rel), dest);
    seeded.push(path.join(op.to, rel));
  }
  return { ok: true };
}

// Append a marked section, replacing only a section this extension wrote before.
//
// Markers are how removal finds its own work in a file it shares. Rewriting
// between the markers on reinstall keeps the file from accumulating a copy per
// install, and everything outside them is left byte for byte.
function appendSection(payloadDir, root, op, written, appended) {
  const target = resolveInside(root, op.to);
  if (!target) return { ok: false, reason: 'escapes-root', text: op.to };

  let incoming;
  try {
    incoming = fs.readFileSync(path.join(payloadDir, op.from), 'utf8');
  } catch (error) {
    return { ok: false, reason: 'payload-read-failed', text: String(error.message) };
  }

  const section = `${op.markerBegin}\n${incoming.trimEnd()}\n${op.markerEnd}\n`;

  let existing;
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch {
    // No such file: the whole file becomes ours, so it is recorded as written
    // rather than appended, and removal deletes it outright.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, section);
    written.push(op.to);
    return { ok: true };
  }

  const begin = existing.indexOf(op.markerBegin);
  const end = existing.indexOf(op.markerEnd);
  if (begin !== -1 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + op.markerEnd.length).replace(/^\n/, '');
    fs.writeFileSync(target, `${before}${section}${after}`);
  } else {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(target, `${existing}${separator}${section}`);
  }
  appended.push(op.to);
  return { ok: true };
}

// Run a plan.
//
// Stops at the first failure and returns the receipt of what had been written by
// then, so the caller can offer removal of a partial install rather than leaving
// the project in a state nothing has a record of.
function applyPlan({ payloadDir, root, ops }) {
  const written = [];
  const appended = [];
  // Kept apart from `written` because removal must not consume it. A seeded path
  // becomes the project's own file the moment the workflow runs, and the path is
  // identical either way.
  const seeded = [];

  for (const op of ops) {
    let result = { ok: true };
    if (op.type === OP.REPLACE_TREE) result = replaceTree(payloadDir, root, op, written);
    else if (op.type === OP.SEED_TREE) result = seedTree(payloadDir, root, op, seeded);
    else if (op.type === OP.APPEND_SECTION) {
      result = appendSection(payloadDir, root, op, written, appended);
    } else if (op.type === OP.COPY_FILE) {
      const target = resolveInside(root, op.to);
      if (!target) result = { ok: false, reason: 'escapes-root', text: op.to };
      else if (!fs.existsSync(target)) {
        copyFile(path.join(payloadDir, op.from), target);
        written.push(op.to);
      }
    } else if (op.type === OP.WRITE_RECEIPT) {
      const target = resolveInside(root, op.to);
      if (!target) result = { ok: false, reason: 'escapes-root', text: op.to };
      else {
        // Written last, and carrying what was actually written rather than what
        // the plan intended, so a partial install removes the right files.
        const receipt = {
          ...op.receipt,
          installedAt: new Date().toISOString(),
          files: written.slice(),
          appended: appended.slice(),
          seeded: seeded.slice()
        };
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
      }
    }

    if (!result.ok) {
      return { ok: false, ...result, written, appended, seeded, failedOp: op.type };
    }
  }

  return { ok: true, written, appended, seeded };
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

module.exports = { resolveInside, listFilesRelative, applyPlan, applyRemoval };
