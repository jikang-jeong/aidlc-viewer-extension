'use strict';

// Which AI-DLC generation a project uses, decided by path existence only.
//
// No content is read and no name is guessed. A generation is identified by the
// directories its installer creates, because those are the one thing a project
// cannot have without having been set up for that generation.
//
// Pure module: never import `vscode` here. The tests run under plain node.

const fs = require('fs');
const path = require('path');

const GENERATION = {
  V1: 'v1',
  V2: 'v2',
  NONE: 'none',
  BOTH: 'both'
};

// Each marker is a path relative to the project root. Presence of ANY marker
// for a generation is enough: installers vary by harness (Kiro IDE, Kiro CLI,
// Claude Code, Cursor) and drop different subsets.
const MARKERS = {
  [GENERATION.V2]: [
    ['aidlc', 'spaces'],
    ['.kiro', 'agents', 'aidlc.json'],
    ['.kiro', 'aidlc-common']
  ],
  [GENERATION.V1]: [
    ['aidlc-docs'],
    ['.kiro', 'aws-aidlc-rule-details'],
    ['.kiro', 'steering', 'aws-aidlc-rules'],
    ['.aidlc-rule-details'],
    ['.amazonq', 'aws-aidlc-rule-details'],
    ['.aidlc', 'aidlc-rules']
  ]
};

function exists(root, segments) {
  try {
    fs.statSync(path.join(root, ...segments));
    return true;
  } catch {
    return false;
  }
}

// Markers found, so a caller can explain the verdict instead of asserting it.
function markersFound(root) {
  const found = {};
  for (const [generation, candidates] of Object.entries(MARKERS)) {
    found[generation] = candidates
      .filter((segments) => exists(root, segments))
      .map((segments) => segments.join('/'));
  }
  return found;
}

// `both` is a real state, not an error: a project that ran v1 and later had v2
// installed keeps its v1 artifacts. The caller decides which adapter to prefer;
// this function only reports what is on disk.
function detectGeneration(root) {
  if (!root) return { generation: GENERATION.NONE, markers: { v1: [], v2: [] } };
  const markers = markersFound(root);
  const hasV1 = markers[GENERATION.V1].length > 0;
  const hasV2 = markers[GENERATION.V2].length > 0;
  let generation = GENERATION.NONE;
  if (hasV1 && hasV2) generation = GENERATION.BOTH;
  else if (hasV2) generation = GENERATION.V2;
  else if (hasV1) generation = GENERATION.V1;
  return { generation, markers };
}

module.exports = { GENERATION, MARKERS, detectGeneration, markersFound };
