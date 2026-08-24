'use strict';

// Single entry point for reading an AI-DLC project, whichever generation it is.
//
// The caller says "here is a folder" and gets back a journey in one shape plus,
// for v2, the supervision facts. Nothing above this module needs to know which
// generation is installed, which is what keeps the v1 code path untouched: a v1
// project routes to the v1 builder and comes back looking exactly as it did
// before this module existed.
//
// Pure module: never import `vscode` here. Everything is filesystem reads.

const fs = require('fs');
const path = require('path');
const { GENERATION, detectGeneration } = require('./detect');
const { buildV2 } = require('./journey-v2');
const { diagnose } = require('./diagnose');
const { contested } = require('./contrast');

// Reading a project is filesystem-only but not free: on three real runs it took
// 25-35ms, dominated by parsing a ~330KB audit ledger, and it is called on every
// tree refresh and every panel update. Left uncached that is 30ms of the
// extension host's single thread every time a file watcher fires during an active
// workflow, and the ledger only grows.
//
// So the result is memoised against a signature built from stat calls alone. The
// signature deliberately covers only files whose change can alter the answer, and
// never their contents: hashing the ledger to avoid parsing it would cost the same
// read it is meant to save.
const cache = new Map();
const CACHE_LIMIT = 8;

function mtimeOf(target) {
  try {
    const stat = fs.statSync(target);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '-';
  }
}

// Cheap enough to run on every call: a handful of stats regardless of ledger size.
//
// A shard appended to within the same millisecond as a previous read would be
// missed by mtime alone, which is why size is part of each entry -- the ledger is
// append-only, so any new record changes it.
function signature(root) {
  const parts = [mtimeOf(path.join(root, '.kiro', 'tools', 'data', 'stage-graph.json'))];
  parts.push(mtimeOf(path.join(root, '.kiro', 'tools', 'data', 'scope-grid.json')));
  const intentsRoot = path.join(root, 'aidlc', 'spaces');
  let spaces;
  try {
    spaces = fs.readdirSync(intentsRoot, { withFileTypes: true });
  } catch {
    return parts.join('|');
  }
  for (const space of spaces) {
    if (!space.isDirectory() || space.name.startsWith('.')) continue;
    const intents = path.join(intentsRoot, space.name, 'intents');
    let entries;
    try {
      entries = fs.readdirSync(intents, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(intents, entry.name);
      parts.push(entry.name, mtimeOf(path.join(dir, 'runtime-graph.json')));
      // The ledger is sharded, so each shard is signed rather than the directory:
      // a directory's own mtime does not change when a file inside it is appended
      // to on every platform.
      let shards;
      try {
        shards = fs.readdirSync(path.join(dir, 'audit'));
      } catch {
        continue;
      }
      for (const shard of shards.sort()) {
        parts.push(mtimeOf(path.join(dir, 'audit', shard)));
      }
    }
  }
  return parts.join('|');
}

// Read a project.
//
// `v1Journey` is supplied by the caller rather than built here, because the v1
// builder takes an artifact list the caller already walked for its tree. Passing
// it through avoids walking the same directory twice and, more importantly, means
// this module cannot change v1 behaviour even by accident.
function readProject(root, options = {}) {
  const { generation, markers } = detectGeneration(root);

  // `both` prefers v2: a project that has had v2 installed is being driven by
  // the engine now, and its v1 artifacts are history. The v1 markers are still
  // reported so a caller can say so.
  const useV2 = generation === GENERATION.V2 || generation === GENERATION.BOTH;
  if (!useV2) {
    return { generation, markers, v2: undefined, journey: options.v1Journey };
  }

  // The v1 journey is not part of the cached value: the caller rebuilds it from
  // its own artifact walk each time, and for a v2 project it is only a fallback.
  const key = root;
  const stamp = signature(root);
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) {
    return { ...hit.value, journey: hit.value.journey ?? options.v1Journey };
  }

  const value = buildProject(root, generation, markers);
  cache.set(key, { stamp, value });
  // A user watches one project at a time; the cap exists so a long session that
  // moved between several does not hold every ledger it ever read.
  if (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return { ...value, journey: value.journey ?? options.v1Journey };
}

function buildProject(root, generation, markers) {
  const model = buildV2(root);
  if (!model.ok) {
    // A v2 install whose compiled graph cannot be read. Reported rather than
    // thrown: a half-finished install is a normal state to render, and the tree
    // must still work.
    return { generation, markers, v2: { ok: false, reason: model.reason }, journey: undefined };
  }

  // Supervision facts per intent, attached alongside its journey.
  const intents = model.intents.map((intent) => {
    const diagnosis = diagnose(intent.dir, { runtime: intent.runtime });
    return {
      ...intent,
      diagnosis,
      // What the agent recorded about its own coverage, set beside what the
      // engine's sensor found in the same file. Reuses the diagnosis summary so
      // the ledger is read once per intent.
      contrast: contested(intent.dir, diagnosis.summary)
    };
  });

  // The intent to show when a surface has room for one. The most recently
  // started wins; without a start time, file order. No attempt is made to guess
  // which one the user cares about beyond that.
  const active = pickActive(intents);

  return {
    generation,
    markers,
    v2: { ...model, intents, active },
    // So a caller that only knows about journeys keeps working. Left undefined
    // when no intent has started, and the caller's v1 journey stands in.
    journey: active ? active.journey : undefined
  };
}

function pickActive(intents) {
  if (intents.length === 0) return undefined;
  const unfinished = intents.filter(
    (intent) => intent.journey.counts.done < intent.journey.plannedTotal
  );
  const pool = unfinished.length > 0 ? unfinished : intents;
  return pool[pool.length - 1];
}

module.exports = { GENERATION, readProject };
