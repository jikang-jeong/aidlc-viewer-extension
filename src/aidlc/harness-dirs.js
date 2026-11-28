'use strict';

// Where the engine puts a project's compiled data: the harness directory.
//
// `aidlc config --harness <name>` writes the same compiled data (`tools/data/`, the
// scope files, the agents) under the directory of the harness it was asked for, and
// nowhere else. Read from the engine's own runtime tree (2.11.3,
// `~/.local/share/aidlc/versions/2.11.3/runtime/<harness>/`), the seven distributions
// land in five directories:
//
//   kiro, kiro-ide   -> .kiro
//   claude           -> .claude
//   codex            -> .codex
//   cursor           -> .cursor
//   copilot, opencode -> .aidlc
//
// So `.kiro/` is one of five, and a project set up for Claude Code or Codex CLI has
// `.claude/tools/data/stage-graph.json` and no `.kiro/` at all. This extension read the
// stage graph from `.kiro/` only, so such a project was detected as v2 (by `aidlc/spaces`)
// and then reported `stage-graph-unreadable` -- issue #5, from a person following a
// Claude Code + Codex run in VS Code. Copying the two files into `.kiro/tools/data/` by
// hand made the viewer work, which is the measurement that the data is the same: on
// 2.11.3 the only field that differs between harness directories is
// `sensors_applicable[].path`, which names the directory itself, and nothing here reads it.
//
// The order below is a preference, not a search for the newest file. `.kiro` comes first
// because it is the harness this extension installs and the one Kiro runs, so a project
// that has it keeps reading exactly what it read before this module existed. The others
// follow the engine's own listing. A project configured for several harnesses was
// configured by the same engine for each; the first directory that holds the stage graph
// is read, and Check setup names which one.
//
// Pure module: never import `vscode` here.

const fs = require('fs');
const path = require('path');

const HARNESS_DIRS = ['.kiro', '.claude', '.codex', '.cursor', '.aidlc'];

// Relative to the harness directory. The stage graph is the file the reader cannot do
// without, so its presence is what makes a directory "the" harness directory.
const DATA_DIR = ['tools', 'data'];
const STAGE_GRAPH_FILE = 'stage-graph.json';

function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

// The harness directory of a project (`.kiro`, `.claude`, ...), or undefined when no
// candidate holds a stage graph.
function harnessDir(root) {
  return HARNESS_DIRS.find((dir) => exists(path.join(root, dir, ...DATA_DIR, STAGE_GRAPH_FILE)));
}

// The compiled-data directory as path segments relative to the project root, e.g.
// `['.claude', 'tools', 'data']`; undefined when there is none.
function harnessDataDir(root) {
  const dir = harnessDir(root);
  return dir ? [dir, ...DATA_DIR] : undefined;
}

// What the engine recorded about the harness it configured, from `harness.json` and
// `aidlc-stamp.json` beside the stage graph. Every field is the engine's own word; nothing
// is inferred from the directory name. Undefined when there is no harness directory.
function readHarnessRecord(root) {
  const data = harnessDataDir(root);
  if (!data) return undefined;
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, ...data, name), 'utf8'));
    } catch {
      return undefined;
    }
  };
  const harness = read('harness.json') ?? {};
  const stamp = read('aidlc-stamp.json') ?? {};
  return {
    dir: data[0],
    distribution: typeof harness.distribution === 'string' ? harness.distribution : undefined,
    productName: typeof harness.productName === 'string' ? harness.productName : undefined,
    version: typeof stamp.frameworkVersion === 'string' ? stamp.frameworkVersion : undefined
  };
}

module.exports = { HARNESS_DIRS, DATA_DIR, STAGE_GRAPH_FILE, harnessDir, harnessDataDir, readHarnessRecord };
