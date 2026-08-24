'use strict';

// Puts what an agent said about its own work next to what the engine's sensor
// found in the very same file, and stops there.
//
// The case that made this worth building, from a real run: an agent wrote a
// traceability record claiming 45 of 46 requirements covered and the rest not
// applicable, and the engine's traceability sensor read that same file and
// reported 89 findings. Both records sat in the same directory. The human was
// shown the agent's summary.
//
// This module therefore reports two numbers and never reconciles them. It does
// not subtract one from the other, does not call either wrong, does not label a
// "discrepancy" -- the sensor and the record answer slightly different questions
// and a confident-looking delta would be a fabrication. The judgement belongs to
// the person, and what they need is to know the two exist and where to read them.
//
// Nothing here parses markdown or a path. Records are found by filename, and the
// stage they belong to is read from a field INSIDE the file, because a path
// convention is a convention while a declared field is data.
//
// Pure module: never import `vscode`.

const fs = require('fs');
const path = require('path');

// The sensor whose verdict can be set against a machine-readable claim. Others
// (required sections, upstream coverage, linters) inspect artifacts that carry no
// self-report to compare with.
const TRACEABILITY_SENSOR = 'traceability';
const RECORD_FILENAME = 'traceability.json';

// Directory names that hold engine bookkeeping rather than stage output. Filtered
// by prefix rather than by name so a new one does not have to be learned.
function isHidden(name) {
  return name.startsWith('.');
}

// Every traceability record under an intent.
//
// Walked rather than derived from the stage graph's `produces` list: a stage that
// repeats per unit of work writes one record per unit, so the graph says how many
// kinds of record exist and only the filesystem says how many there are.
function findRecords(intentDir, limit = 400) {
  const found = [];
  const queue = [intentDir];
  let visited = 0;
  while (queue.length > 0 && visited < limit) {
    const dir = queue.shift();
    visited += 1;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name === RECORD_FILENAME) found.push(full);
    }
  }
  return found;
}

// One record's own account of itself.
//
// The status vocabulary is NOT enumerated. Three runs produced OK, Deferred and
// N/A, and a fourth may produce something else; every value is counted under its
// own name and the caller displays whatever came back. A record that cannot be
// read at all is returned with `readable: false` rather than skipped, because a
// self-report that is unreadable is itself worth seeing.
function readRecord(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { filePath, readable: false };
  }
  const coverage = Array.isArray(raw && raw.coverage) ? raw.coverage : [];
  const byStatus = new Map();
  for (const row of coverage) {
    const status = row && typeof row.status === 'string' ? row.status : '(unstated)';
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }
  return {
    filePath,
    readable: true,
    // From inside the file. Pairing on this rather than on the directory name
    // means a record still matches when it is written somewhere unexpected.
    stage: typeof (raw && raw.stage) === 'string' ? raw.stage : undefined,
    itemCount: coverage.length,
    byStatus,
    upstreamCount: Array.isArray(raw && raw.upstream_ids) ? raw.upstream_ids.length : undefined
  };
}

// Records paired with the sensor firings that judged them.
//
// Pairing is by stage, and a record whose stage is missing or matches nothing is
// still returned with no sensor side. Dropping it would hide a self-report that
// the engine never checked, which is a different problem but not a lesser one.
function compare(intentDir, summary) {
  const failuresByStage = new Map();
  for (const failure of summary.sensorFailures) {
    if (failure.sensorId !== TRACEABILITY_SENSOR) continue;
    const key = failure.stage;
    if (!key) continue;
    if (!failuresByStage.has(key)) failuresByStage.set(key, []);
    failuresByStage.get(key).push(failure);
  }

  const rows = findRecords(intentDir)
    .map(readRecord)
    .map((record) => {
      const failures = record.stage ? failuresByStage.get(record.stage) ?? [] : [];
      return {
        ...record,
        // How many times the sensor read this stage's record and was unhappy, and
        // the total it counted. Both come from the ledger; neither is derived.
        sensorFirings: failures.length,
        sensorFindings: failures.reduce((total, failure) => total + findingCount(failure), 0),
        // Where the sensor wrote what it found. The one link worth following.
        detailPaths: failures.map((failure) => failure.detailPath).filter(Boolean)
      };
    });

  // A stage that repeats per unit of work writes one record per unit, and the
  // ledger attributes every firing to the stage rather than to a unit. Attaching
  // the same firing totals to each record would state the sensor's count once per
  // unit, so records are folded per stage and the count of them is carried
  // instead. Unfolding would need a unit name the sensor rows do not carry.
  const merged = new Map();
  const unstaged = [];
  for (const row of rows) {
    if (!row.stage) {
      unstaged.push({ ...row, recordCount: 1 });
      continue;
    }
    const existing = merged.get(row.stage);
    if (!existing) {
      merged.set(row.stage, { ...row, recordCount: 1 });
      continue;
    }
    // Claims add up across a stage's records because each covers its own unit.
    existing.recordCount += 1;
    existing.itemCount += row.itemCount;
    for (const [status, count] of row.byStatus) {
      existing.byStatus.set(status, (existing.byStatus.get(status) ?? 0) + count);
    }
    existing.readable = existing.readable && row.readable;
  }

  // Stages the sensor faulted where no record was found. Reported separately
  // because "the record disagrees" and "there is no record" are different states.
  const all = [...merged.values(), ...unstaged];
  const recordedStages = new Set(all.map((row) => row.stage).filter(Boolean));
  const faultedWithoutRecord = [...failuresByStage.keys()].filter(
    (stage) => !recordedStages.has(stage)
  );

  return { rows: all, faultedWithoutRecord };
}

// `Findings count` is a ledger field, so it is read rather than assumed. A row
// without it contributes nothing to the total instead of contributing a guess.
function findingCount(failure) {
  const raw = failure.findingsCount;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

// The rows worth a person's attention: a record the sensor faulted. A record the
// sensor passed needs no display, and a run with none of these produces nothing.
function contested(intentDir, summary) {
  const { rows, faultedWithoutRecord } = compare(intentDir, summary);
  return {
    rows: rows.filter((row) => row.sensorFirings > 0 || !row.readable),
    faultedWithoutRecord
  };
}

module.exports = {
  TRACEABILITY_SENSOR,
  RECORD_FILENAME,
  findRecords,
  readRecord,
  compare,
  contested
};
