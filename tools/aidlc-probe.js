#!/usr/bin/env node
'use strict';

// Diagnostic runner. Point it at any AI-DLC project and it prints what the
// adapter understood, and -- the reason this exists -- everything it did NOT.
//
//   node tools/aidlc-probe.js <project-dir>
//   node tools/aidlc-probe.js <project-dir> --refusals
//
// `--refusals` prints every engine refusal in the ledger with the event sequence
// around it. Without it only the refusals still blocking are shown, because a
// finished run accumulates refusals it long since recovered from (44 across three
// observed projects, none of them still in the way) and listing all of them by
// default would train a reader to skip the section.
//
// The modules under src/aidlc/ are written to report unknowns rather than drop
// them, so a project that exercises a part of the engine the model has not met
// shows up in the GAPS section instead of quietly producing a plausible-looking
// wrong answer. That makes a new sample a test rather than a reading exercise:
// run it, read GAPS, and any non-empty line is a finding.
//
// Reads only. Never invokes an engine verb, never writes into the project.

const path = require('path');
const detect = require('../src/aidlc/detect');
const audit = require('../src/aidlc/audit');
const diagnose = require('../src/aidlc/diagnose');
const { buildV2 } = require('../src/aidlc/journey-v2');

function heading(text) {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function line(label, value) {
  console.log(`  ${String(label).padEnd(26)} ${value}`);
}

// A gap line is only printed when it has content, so a clean run is short and a
// project with findings is long. Returns how many gaps were reported.
function reportGaps(gaps) {
  const rows = [];
  const push = (label, value) => {
    if (Array.isArray(value) ? value.length > 0 : Boolean(value)) {
      rows.push([label, Array.isArray(value) ? value.join(', ') : value]);
    }
  };
  push('unknown stage fields', gaps.unknownStageFields);
  push('unknown runtime-graph fields', gaps.unknownRuntimeFields);
  push('unknown event names', gaps.unknownEvents);
  push('unknown scope decisions', gaps.unknownScopeDecisions);
  push('scope grid missing', gaps.scopeGridMissing);
  push('intents without runtime', gaps.intentsWithoutRuntime);
  push('unknown outcome values', gaps.unknownOutcomes);
  push('non-phase directories', gaps.nonPhaseDirs);
  push('manifest entry, no directory', gaps.manifestMissingOnDisk);
  push('directory, not in manifest', gaps.diskMissingFromManifest);
  push('scope disagreement', gaps.scopeDisagreements);
  if (rows.length === 0) {
    console.log('  none — every value in this project is one the model knows');
    return 0;
  }
  for (const [label, value] of rows) line(label, value);
  return rows.length;
}

// One refusal, with the ordering that explains it. The message is the engine's
// own words; the sequence is what no other surface shows.
function printRefusal(entry, indent = '  ') {
  console.log(`${indent}${entry.settled === false ? 'BLOCKING' : 'recovered'}  ${entry.timestamp ?? '?'}  stage≈${entry.stage ?? '?'}`);
  if (entry.message) console.log(`${indent}  ${entry.message.slice(0, 150)}`);
  if (entry.command) console.log(`${indent}  command: ${entry.command.slice(0, 130)}`);
  for (const row of entry.context) {
    const marker = row.event === 'ERROR_LOGGED' && row.timestamp === entry.timestamp ? '>' : ' ';
    console.log(
      `${indent}  ${marker} ${String(row.timestamp ?? '').slice(11, 19)}  ${row.event}${row.unit ? `  unit=${row.unit}` : ''}`
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const showAllRefusals = args.includes('--refusals');
  const root = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? process.cwd());
  console.log(`AI-DLC probe: ${root}`);

  const { generation, markers } = detect.detectGeneration(root);
  heading('DETECT');
  line('generation', generation);
  line('v1 markers', markers.v1.length ? markers.v1.join(', ') : '(none)');
  line('v2 markers', markers.v2.length ? markers.v2.join(', ') : '(none)');

  if (generation !== detect.GENERATION.V2 && generation !== detect.GENERATION.BOTH) {
    console.log('\nNo v2 install here; nothing further to report.');
    return;
  }

  const model = buildV2(root);
  if (!model.ok) {
    console.log(`\nCould not build the v2 model: ${model.reason}`);
    return;
  }

  heading('GRAPH');
  line('stages in graph', model.stageCount);
  line('phases (workflow order)', model.phases.join(' > '));
  line('scopes in grid', model.scopeNames.length ? model.scopeNames.join(', ') : '(none)');

  let totalGaps = 0;
  for (const intent of model.intents) {
    const j = intent.journey;
    heading(`INTENT ${intent.id}`);
    line('space', intent.space);
    line('scope', intent.scope ?? '(not recorded)');
    line('in-scope stages done', `${j.counts.done}/${j.plannedTotal}`);
    line('of all stages', `${j.counts.done}/${j.checkpoints.length}`);
    line('skipped by scope', j.counts.skipped);
    const at = j.currentIndex >= 0 ? j.checkpoints[j.currentIndex] : undefined;
    line('furthest reached', at ? `${at.label} (${at.status})` : '(nothing started)');

    // Stages that repeat per unit of work. A single count for such a stage is
    // what made the v1 model overstate progress, so they are broken out.
    if (j.units.length > 0) {
      line('units of work', j.units.join(', '));
      for (const node of j.checkpoints) {
        if (!node.forEach || !node.planned) continue;
        line(`  ${node.label}`, `${node.unitsDone}/${node.unitsPlanned} units (${node.status})`);
      }
    }

    // Per phase, because a single total hides which part of the workflow is live.
    for (const phase of model.phases) {
      const nodes = j.checkpoints.filter((n) => n.phase === phase && n.planned);
      if (nodes.length === 0) continue;
      const done = nodes.filter((n) => n.status === 'done').length;
      line(`  ${phase}`, `${done}/${nodes.length}`);
    }

    const summary = audit.summarise(intent.dir);
    const diag = diagnose.diagnose(intent.dir);
    console.log('');
    line('audit events', summary.total);
    line('sensor failures', `${diag.sensorFailureTotal} across ${diag.sensorFailures.size} stage(s)`);
    for (const [stage, failures] of [...diag.sensorFailures].sort((a, b) => b[1].length - a[1].length)) {
      line(`  ${stage}`, failures.length);
    }
    // A run accumulates refusals it recovered from. Only the ones with nothing
    // after them for their stage are actually in the way.
    // The gate figure sits beside the refusal figure because they answer the same
    // shape of question: the ledger records every one a run ever reached, and only
    // the unresolved ones are anyone's problem now.
    line(
      'approval gates',
      `${diag.approvalWaits.length} reached, ${diag.waitingOnYou.length} still waiting on a person`
    );
    for (const entry of diag.waitingOnYou) {
      line('', `  ${entry.stage ?? '(stage not recorded)'} since ${entry.timestamp ?? '(no time)'}`);
    }
    line('engine refusals', `${diag.refusals.length} total, ${diag.live.length} still blocking`);
    for (const entry of diag.live) printRefusal(entry, '    ');
    if (showAllRefusals) {
      for (const entry of diag.refusals) {
        if (entry.settled === false) continue;
        printRefusal(entry, '    ');
      }
    } else if (diag.refusals.length > diag.live.length) {
      line('', `(pass --refusals to see the ${diag.refusals.length - diag.live.length} recovered)`);
    }
    if (diag.undecided.length > 0) {
      line('refusals undecided', diag.undecided.length);
    }
    if (summary.unknownEvents.length) {
      line('UNKNOWN events', summary.unknownEvents.join(', '));
      totalGaps += 1;
    }
  }

  heading('GAPS — anything here is a finding, not noise');
  totalGaps += reportGaps(model.gaps);

  console.log(
    `\n${totalGaps === 0
      ? 'Clean: this project contained nothing the model does not already handle.'
      : `${totalGaps} gap category(ies) reported above. Each one is a place the model is thin.`}`
  );
}

main();
