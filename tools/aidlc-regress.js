#!/usr/bin/env node
'use strict';

// Regression check against the real v2 projects on this machine.
//
// Every test in tests/ builds its own fixture, which is right: they must run in CI,
// where these projects do not exist, and a test that needs a particular machine is
// not a test. But it means the suite cannot see a change that reads correctly on a
// fixture and wrongly on a real run, and that has happened repeatedly -- each time
// caught by hand, and once only because a screenshot was posted.
//
// So this records what the reader says about each real project, and fails when the
// answer moves. Not a substitute for the suite: a companion for the samples the
// suite deliberately cannot reach.
//
//   node tools/aidlc-regress.js            check against the recorded baseline
//   node tools/aidlc-regress.js --update   record the current answers as baseline
//
// A project that is not present is skipped and named, never silently passed. A run
// with no projects present exits 0 and says so, so this can sit in a pre-commit hook
// on any machine.
//
// The baseline is committed. Reading a diff of it is the point: when a sample's
// answer changes, the diff says which project, which field, and from what to what --
// which is the information the screenshot conversations kept having to reconstruct.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readProject } = require('../src/aidlc/index');

// Where the samples live. Overridable so this is not welded to one machine.
const SAMPLE_ROOT = process.env.AIDLC_SAMPLES ?? path.join(os.homedir(), 'Develop', 'aidlc');
const SAMPLES = ['v2-probe', 'v2-probe2', 'v2-probe3', 'v2-test'];
const BASELINE = path.join(__dirname, 'regress-baseline.json');

// What is recorded, and deliberately what is not.
//
// Counts and classifications, because those are what broke: a stage labelled
// skipped that was never in scope, a conditional stage promised as certain, a gate
// reported as waiting after it was approved. Not timestamps, not paths, not the
// engine's own prose -- those change when upstream moves and would make this cry
// wolf on every install.
//
// Stage slugs ARE recorded, because which stage is where is the answer being
// checked. A new stage upstream shows up as a diff, which is correct: that is news.
function describe(root) {
  const project = readProject(root, {});
  if (!project.v2 || !project.v2.ok) {
    return { generation: project.generation, v2: 'unreadable' };
  }
  const v2 = project.v2;
  const record = {
    generation: project.generation,
    stageCount: v2.stageCount,
    phases: v2.phases,
    scopeCount: v2.scopeNames.length,
    // Named so a gap appearing or closing is visible. This is the drift detector
    // now that the install follows the branch rather than a fixed commit.
    gaps: Object.fromEntries(
      Object.entries(v2.gaps ?? {})
        .filter(([, values]) => Array.isArray(values) && values.length > 0)
        .map(([kind, values]) => [kind, [...values].sort()])
    )
  };

  if (!v2.active) {
    record.active = null;
    return record;
  }

  const { journey, diagnosis, contrast, scope } = v2.active;
  record.active = {
    scope,
    at: journey.checkpoints[journey.currentIndex]?.label ?? null,
    plannedTotal: journey.plannedTotal,
    counts: journey.counts,
    units: journey.units,
    // The three-way split that took two rounds to get right. Recorded as counts per
    // label so a stage moving between them is a one-line diff.
    labels: tallyLabels(journey.checkpoints),
    // Per stage, so a single stage changing category is visible rather than hidden
    // inside a total.
    byStage: Object.fromEntries(
      journey.checkpoints.map((cp) => [cp.id, labelFor(cp)])
    ),
    refusals: diagnosis.refusals.length,
    refusalsLive: diagnosis.live.length,
    approvalGates: diagnosis.approvalWaits.length,
    waitingOnYou: diagnosis.waitingOnYou.map((entry) => entry.stage).sort(),
    sensorFailureTotal: diagnosis.sensorFailureTotal,
    sensorsByStage: Object.fromEntries(
      [...diagnosis.sensorFailures.entries()]
        .map(([stage, list]) => [stage, list.length])
        .sort(([a], [b]) => a.localeCompare(b))
    ),
    contrastRows: contrast.rows.length,
    // The claim-versus-check figures, which are the panel's most load-bearing
    // numbers and the ones a reader is most likely to quote.
    contrast: Object.fromEntries(
      contrast.rows.map((row) => [
        row.stage,
        {
          items: row.itemCount,
          records: row.recordCount,
          unaccounted: row.sensorFindings
        }
      ])
    )
  };
  return record;
}

// The word the strip and the tree print for a checkpoint. Kept in step with the
// renderers by intent: if this and they disagree, one of them is wrong and the
// baseline diff is where that shows up.
function labelFor(cp) {
  if (cp.status === 'done') return 'done';
  if (cp.status === 'active') return 'in progress';
  if (cp.outOfScope) return 'not in scope';
  if (cp.status === 'skipped') return 'skipped';
  if (cp.status === 'pending') return cp.mayNotRun ? 'if needed' : 'not started';
  return cp.status;
}

function tallyLabels(checkpoints) {
  const counts = {};
  for (const cp of checkpoints) {
    const label = labelFor(cp);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

// A readable path to every difference, rather than a dumped pair of objects. The
// point of this tool is that the failure names the field.
function differences(before, after, trail = []) {
  const found = [];
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      found.push(...differences(before[key], after[key], [...trail, key]));
    }
    return found;
  }
  const left = JSON.stringify(before);
  const right = JSON.stringify(after);
  if (left !== right) found.push({ at: trail.join('.'), before: left, after: right });
  return found;
}

function main() {
  const update = process.argv.includes('--update');
  const present = [];
  const missing = [];
  const current = {};

  for (const name of SAMPLES) {
    const root = path.join(SAMPLE_ROOT, name);
    if (!fs.existsSync(root)) {
      missing.push(name);
      continue;
    }
    present.push(name);
    try {
      current[name] = describe(root);
    } catch (error) {
      // A throw is itself the finding. The reader's contract is that no project
      // makes it throw.
      current[name] = { threw: String(error && error.message) };
    }
  }

  if (missing.length > 0) {
    console.log(`skipped, not on this machine: ${missing.join(', ')}`);
  }
  if (present.length === 0) {
    console.log('no sample projects found, nothing to check');
    console.log(`looked under ${SAMPLE_ROOT} (override with AIDLC_SAMPLES)`);
    return 0;
  }

  if (update) {
    fs.writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`baseline written for ${present.length} project(s): ${present.join(', ')}`);
    console.log('commit it, so the next change to a sample answer shows up as a diff');
    return 0;
  }

  if (!fs.existsSync(BASELINE)) {
    console.log('no baseline recorded yet. run with --update to write one');
    return 1;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  let failed = 0;

  for (const name of present) {
    const threw = current[name].threw;
    if (threw) {
      console.log(`FAIL ${name}: reading it threw -- ${threw}`);
      failed += 1;
      continue;
    }
    if (!(name in baseline)) {
      console.log(`NEW  ${name}: not in the baseline. run --update to record it`);
      continue;
    }
    const diff = differences(baseline[name], current[name]);
    if (diff.length === 0) {
      console.log(`ok   ${name}`);
      continue;
    }
    failed += 1;
    console.log(`FAIL ${name}: ${diff.length} field(s) changed`);
    for (const entry of diff) {
      console.log(`       ${entry.at}`);
      console.log(`         was ${entry.before}`);
      console.log(`         now ${entry.after}`);
    }
  }

  for (const name of Object.keys(baseline)) {
    if (!present.includes(name) && !missing.includes(name)) {
      console.log(`gone ${name}: in the baseline but no longer a sample`);
    }
  }

  if (failed > 0) {
    console.log('');
    console.log('A sample answer moved. Either the change is wrong, or the sample');
    console.log('progressed and the baseline should be updated on purpose:');
    console.log('  node tools/aidlc-regress.js --update');
    return 1;
  }
  console.log('');
  console.log(`${present.length} sample(s) unchanged`);
  return 0;
}

process.exitCode = main();
