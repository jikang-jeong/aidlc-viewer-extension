'use strict';

// The user-facing side of v2 setup: choose a harness, see what will happen, then
// install or remove.
//
// Everything consequential is decided in the pure modules under src/aidlc/. This
// file only asks, shows, and reports. That split is deliberate: the decision about
// whether to overwrite a directory that holds a project's accumulated rules
// belongs somewhere it can be tested, not inside a progress callback.
//
// Two policies are enforced here rather than in the planner, because both are
// about the user's choice rather than about the files:
//
//   A harness is chosen once. Kiro IDE and Kiro CLI ship agent definitions that
//   are mutually exclusive -- fourteen files differ, and upstream marks running
//   both as supported-but-untested. So a project that already has a harness is
//   not offered a different one; it is offered a reinstall of the same one, and
//   changing requires removing first.
//
//   bun is never installed for the user. It is checked, and if absent the official
//   command for their platform is offered to copy. Installing a language runtime
//   behind a confirmation dialog is not a thing an editor extension should do.

const vscode = require('vscode');

const { readInstallState, previewInstall, RECEIPT_PATH } = require('./aidlc/install-state');
const { planInstall, planRemoval } = require('./aidlc/install-plan');
const { applyPlan, applyRemoval } = require('./aidlc/install-apply');
const { fetchPayload, PINNED_COMMIT, HARNESSES } = require('./aidlc/payload');
const { detectBun } = require('./aidlc/bun-check');

const HARNESS_LABELS = {
  'kiro-ide': 'Kiro IDE',
  'kiro-cli': 'Kiro CLI'
};

// Offer the platform's install command rather than running it. Returns true when
// the caller should carry on regardless.
async function handleMissingBun(bun) {
  const copyLabel = 'Copy install command';
  const continueLabel = 'Install anyway';
  const choice = await vscode.window.showWarningMessage(
    'bun was not found. AI-DLC v2 runs its engine through bun, so its gates and ' +
      'hooks will not fire without it.',
    { modal: true, detail: `${bun.installCommand}\n\n${bun.pathNote}` },
    copyLabel,
    continueLabel
  );
  if (choice === copyLabel) {
    await vscode.env.clipboard.writeText(bun.installCommand);
    vscode.window.showInformationMessage(
      'Command copied. Run it in a terminal, then set up AI-DLC v2 again.'
    );
    return false;
  }
  // Proceeding without bun is a legitimate choice: a user may be installing now
  // and setting up their runtime afterwards.
  return choice === continueLabel;
}

// Which generation to set up.
//
// One button that asks, rather than two buttons the user has to tell apart. Two
// were tried and the report came back immediately: pressing "Set up AI-DLC"
// installed v1, because that is what it has always done, and nothing on screen
// said the other icon was the one for v2. A person deciding between two AI-DLC
// generations needs the question asked, not a pair of similar icons to guess
// between.
//
// The answer is not remembered, because it is a property of the project rather
// than of the user.
async function chooseGeneration(state) {
  const isV2 = state && (state.generation === 'v2' || state.generation === 'both');
  const isV1 = state && (state.generation === 'v1' || state.generation === 'both');

  const picked = await vscode.window.showQuickPick(
    [
      {
        key: 'v2',
        label: isV2 ? 'AI-DLC v2 — reinstall' : 'AI-DLC v2',
        description: 'current',
        detail:
          'Engine-driven: 33 stages, enforced gates, an audit ledger. Downloaded ' +
          'from upstream at a pinned commit. Needs bun.'
      },
      {
        key: 'v1',
        label: isV1 ? 'AI-DLC v1 — already present' : 'AI-DLC v1',
        description: 'bundled',
        detail:
          'Rule files your agent reads. Copied from the snapshot inside this ' +
          'extension, so it needs no network and no bun.'
      }
    ],
    {
      title: 'Set up AI-DLC',
      placeHolder: 'Which generation does this project use?',
      ignoreFocusOut: true
    }
  );
  return picked ? picked.key : undefined;
}

async function chooseHarness(existing) {
  if (existing) return existing;
  const picked = await vscode.window.showQuickPick(
    Object.keys(HARNESSES).map((key) => ({
      label: HARNESS_LABELS[key],
      description: key,
      detail:
        key === 'kiro-ide'
          ? 'Agent definitions and hooks for the Kiro editor.'
          : 'Agent definitions with MCP wiring, for the Kiro command line.',
      key
    })),
    {
      title: 'AI-DLC v2: which harness?',
      placeHolder: 'This is chosen once. Changing it later means removing and reinstalling.',
      ignoreFocusOut: true
    }
  );
  return picked ? picked.key : undefined;
}

// Show the consequences and get a decision. Returns true to proceed.
async function confirmInstall(state, harness, reinstalling) {
  const preview = previewInstall(state);
  const lines = preview.notes.map(
    (note) => `${note.level === 'warn' ? '! ' : '  '}${note.text}`
  );
  lines.push('');
  lines.push(`Harness: ${HARNESS_LABELS[harness] ?? harness}`);
  lines.push(`Upstream commit: ${PINNED_COMMIT}`);
  lines.push('');
  lines.push(
    'The engine is downloaded from the awslabs/aidlc-workflows repository at that ' +
      'exact commit. It is pinned rather than tracking the branch, so this install ' +
      'matches what the extension was verified against.'
  );

  const goLabel = reinstalling ? 'Reinstall' : 'Install';
  const choice = await vscode.window.showInformationMessage(
    reinstalling
      ? 'Reinstall AI-DLC v2 in this project?'
      : 'Set up AI-DLC v2 in this project?',
    { modal: true, detail: lines.join('\n') },
    goLabel
  );
  return choice === goLabel;
}

// The setup command. Asks which generation, then routes.
//
// `installV1` is passed in rather than imported, because the v1 installer lives in
// extension.js and depends on the extension's own bundle path. Keeping the call
// here means one button covers both generations without this file knowing how v1
// works.
async function setup(folderUri, installV1) {
  if (!folderUri) {
    vscode.window.showWarningMessage('Select a folder to watch first.');
    return;
  }
  const root = folderUri.fsPath;
  const state = readInstallState(root);
  if (!state.ok) {
    vscode.window.showErrorMessage('Could not read that folder.');
    return;
  }

  const generation = await chooseGeneration(state);
  if (!generation) return;
  if (generation === 'v1') {
    // Unchanged from what it has always done, including its own confirmation.
    await installV1();
    return;
  }
  await installV2(root, state);
}

async function installV2(root, state) {
  // A harness already recorded is kept. Offering to switch would produce a
  // project carrying two mutually exclusive sets of agent definitions.
  const existing = state.receipt ? state.receipt.harness : undefined;
  const harness = await chooseHarness(existing);
  if (!harness) return;

  const bun = detectBun();
  if (!bun.found && !(await handleMissingBun(bun))) return;

  if (!(await confirmInstall(state, harness, Boolean(state.receipt)))) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'AI-DLC v2', cancellable: false },
    async (progress) => {
      progress.report({ message: `downloading upstream ${PINNED_COMMIT}…` });
      const fetched = await fetchPayload({ commit: PINNED_COMMIT, harness });
      if (!fetched.ok) {
        vscode.window.showErrorMessage(
          `Could not fetch the AI-DLC v2 payload: ${fetched.text ?? fetched.reason}`
        );
        return;
      }

      progress.report({ message: 'writing files…' });
      const planned = planInstall({
        payloadEntries: fetched.entries,
        state,
        harness,
        upstreamCommit: fetched.commit
      });
      const result = applyPlan({ payloadDir: fetched.payloadDir, root, ops: planned.ops });

      if (!result.ok) {
        // A partial install is reported with its own count, because the receipt
        // records what was written and removal can take exactly that back.
        vscode.window.showErrorMessage(
          `AI-DLC v2 setup failed after writing ${result.written.length} file(s): ` +
            `${result.text ?? result.reason}. Use "Remove AI-DLC v2" to undo it.`
        );
        return;
      }

      // Notes the planner produced are worth surfacing after the fact too: the
      // most important one says the project's accumulated rules were left alone.
      const warned = planned.notes.filter((note) => note.level === 'warn');
      const summary =
        `AI-DLC v2 installed for ${HARNESS_LABELS[harness] ?? harness} ` +
        `(${result.written.length} files, upstream ${fetched.commit}).`;
      if (warned.length > 0) {
        vscode.window.showInformationMessage(summary, { detail: warned.map((n) => n.text).join('\n\n') });
      } else {
        vscode.window.showInformationMessage(`${summary} Open the aidlc agent and run /aidlc.`);
      }
    }
  );
}

// The removal command.
async function removeV2(folderUri) {
  if (!folderUri) {
    vscode.window.showWarningMessage('Select a folder to watch first.');
    return;
  }
  const root = folderUri.fsPath;
  const state = readInstallState(root);
  const removal = planRemoval(state);

  if (removal.blocked) {
    // No receipt means no record of what was added. Guessing would target the two
    // directories a project keeps its own work in.
    vscode.window.showWarningMessage(
      'Nothing to remove automatically.',
      { modal: true, detail: removal.text }
    );
    return;
  }

  const detail = [
    `${removal.ops.length} file(s) and section(s) recorded by this extension will be removed.`,
    ...removal.notes.map((note) => note.text)
  ].join('\n\n');

  const removeLabel = 'Remove';
  const choice = await vscode.window.showWarningMessage(
    'Remove AI-DLC v2 from this project?',
    { modal: true, detail },
    removeLabel
  );
  if (choice !== removeLabel) return;

  const applied = applyRemoval({ root, ops: removal.ops });
  const kept = applied.kept.length;
  vscode.window.showInformationMessage(
    `Removed ${applied.removed.length} item(s).` +
      (kept > 0 ? ` ${kept} left in place; see the output for why.` : '') +
      ' Your aidlc/ directory was not touched.'
  );
}

// Whether this project has a v2 install this extension can remove. Drives the
// visibility of the removal command, so it never appears where it cannot work.
function hasRemovableInstall(folderUri) {
  if (!folderUri) return false;
  try {
    return Boolean(readInstallState(folderUri.fsPath).receipt);
  } catch {
    return false;
  }
}

module.exports = { setup, removeV2, hasRemovableInstall, RECEIPT_PATH };
