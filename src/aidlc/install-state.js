'use strict';

// What is already installed in a project, and what installing would touch.
//
// The v1 setup path answers one question -- which of its targets are absent --
// and copies those. That is enough when the payload is 37 rule files that nobody
// edits. It is not enough for v2, where the payload is 293 files and nine of them
// become the project's own accumulated rules the moment the workflow runs.
//
// The distinction this module exists to make: `.kiro/` is the engine, replaceable
// at will, while `aidlc/` is the engine's seed AND the project's memory, and after
// the first run it is entirely the latter. Three observed projects had rewritten
// their aidlc/spaces/default/memory/project.md into six accumulated learning
// rules and their team.md into an affirmed team practice. A reinstall that copied
// the seed over those would delete work no backup covers, silently, in a directory
// the user never opened.
//
// So nothing here writes. It reports state precisely enough that a caller can
// decide, and refuses to guess when it cannot tell.
//
// Pure module: never import `vscode`.

const fs = require('fs');
const path = require('path');

const { GENERATION, detectGeneration } = require('./detect');

// Where an install receipt lives. Inside `.kiro/` because that is the tree the
// installer owns; putting it in `aidlc/` would mean writing into the directory
// this module exists to protect.
const RECEIPT_PATH = ['.kiro', 'aidlc-viewer-install.json'];
const RECEIPT_SCHEMA = 1;

// The engine tree, wholly owned by whatever installed it.
const ENGINE_DIR = ['.kiro'];

// Seeded once, then the project's own. Every path below is created by the
// installer and then written to by the workflow, so none of them may be
// overwritten by a later install.
const SEEDED_THEN_OWNED = ['aidlc'];

// Files the installer has to share with whatever else the project keeps there.
// Both are appended to under a marker rather than replaced, because a project can
// have its own reason to hold either.
const SHARED_FILES = ['AGENTS.md', '.gitignore'];

function statOf(target) {
  try {
    return fs.statSync(target);
  } catch {
    return undefined;
  }
}

function exists(root, segments) {
  return Boolean(statOf(path.join(root, ...segments)));
}

function countFiles(dir, limit = 2000) {
  let total = 0;
  const queue = [dir];
  while (queue.length > 0 && total < limit) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
      else total += 1;
    }
  }
  return total;
}

function readReceipt(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, ...RECEIPT_PATH), 'utf8'));
    if (!raw || typeof raw !== 'object') return undefined;
    return {
      schemaVersion: raw.schemaVersion,
      harness: raw.harness,
      upstreamCommit: raw.upstreamCommit,
      installedAt: raw.installedAt,
      // Files this extension put there, so removal can take back exactly those.
      files: Array.isArray(raw.files) ? raw.files : [],
      // Sections appended to a file that already existed, removable by marker.
      appended: Array.isArray(raw.appended) ? raw.appended : [],
      // Anything else the receipt carries that this build does not read.
      unknownFields: Object.keys(raw).filter(
        (key) =>
          ![
            'schemaVersion', 'harness', 'upstreamCommit', 'installedAt', 'files', 'appended'
          ].includes(key)
      )
    };
  } catch {
    return undefined;
  }
}

// Whether the project's memory has moved on from the seed.
//
// Answered by file count rather than by content, because the seed is nine files
// and a run that has produced anything at all has more. Content comparison would
// mean deciding what an edit looks like, and an edited seed file is as much the
// project's own as a new one.
//
// `undefined` means the directory is absent, which is different from present and
// untouched.
function memoryHasContent(root) {
  const dir = path.join(root, ...SEEDED_THEN_OWNED);
  if (!statOf(dir)) return undefined;
  // The seed is nine files. Anything beyond that came from a run. The threshold
  // is deliberately the seed's own size rather than a round number, so a project
  // that has done exactly nothing still reads as untouched.
  const SEED_FILE_COUNT = 9;
  const found = countFiles(dir);
  return { fileCount: found, beyondSeed: found > SEED_FILE_COUNT };
}

// Everything a caller needs before offering to install, reinstall or remove.
function readInstallState(root) {
  if (!root) return { ok: false, reason: 'no-root' };
  const { generation, markers } = detectGeneration(root);
  const receipt = readReceipt(root);
  const memory = memoryHasContent(root);

  const engineDir = path.join(root, ...ENGINE_DIR);
  const engine = statOf(engineDir)
    ? { present: true, fileCount: countFiles(engineDir) }
    : { present: false };

  return {
    ok: true,
    generation,
    markers,
    // Present only when this extension did the installing. A v2 project set up by
    // hand or by the upstream instructions has none, and that is a normal state:
    // it means removal cannot be offered, not that something is wrong.
    receipt,
    installedByExtension: Boolean(receipt),
    engine,
    // The single most important field. When the project's memory has moved past
    // the seed, a reinstall must not touch `aidlc/` at all.
    memory,
    // Files the installer shares rather than owns.
    sharedFiles: SHARED_FILES.filter((name) => exists(root, [name])),
    // Whether a git repository exists. Not required to install, but the practices
    // the workflow affirms assume trunk-based development with worktrees, and one
    // observed project carried those rules with no repository to apply them to.
    hasGitRepo: exists(root, ['.git'])
  };
}

// What an install would do to this project, as a list of consequences rather than
// a yes or no. The caller shows these; nothing is decided here.
function previewInstall(state) {
  if (!state || !state.ok) return { blocked: true, reason: 'no-state' };
  const notes = [];

  if (state.generation === GENERATION.V2 || state.generation === GENERATION.BOTH) {
    notes.push({
      level: 'warn',
      text: 'AI-DLC v2 is already installed here.'
    });
  }
  if (state.generation === GENERATION.V1 || state.generation === GENERATION.BOTH) {
    notes.push({
      level: 'info',
      text: 'AI-DLC v1 files are present and will be left exactly as they are.'
    });
  }
  if (state.memory && state.memory.beyondSeed) {
    notes.push({
      level: 'warn',
      text:
        `This project's aidlc/ directory holds ${state.memory.fileCount} files, ` +
        'which means the workflow has run and written its own rules and records ' +
        'there. It will not be touched.'
    });
  }
  if (state.engine.present) {
    notes.push({
      level: 'info',
      text: `.kiro/ already holds ${state.engine.fileCount} files and would be replaced.`
    });
  }
  for (const name of state.sharedFiles) {
    notes.push({
      level: 'info',
      text: `${name} exists and would gain an appended section, not be replaced.`
    });
  }
  if (!state.hasGitRepo) {
    notes.push({
      level: 'warn',
      text:
        'No git repository here. The practices the workflow affirms assume ' +
        'trunk-based development with worktrees, so run git init first if you ' +
        'intend to reach Construction.'
    });
  }
  return { blocked: false, notes };
}

module.exports = {
  RECEIPT_PATH,
  RECEIPT_SCHEMA,
  ENGINE_DIR,
  SEEDED_THEN_OWNED,
  SHARED_FILES,
  readReceipt,
  memoryHasContent,
  readInstallState,
  previewInstall
};
