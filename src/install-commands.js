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
//   both as supported-but-untested. So a project that already has AI-DLC, of either
//   generation, is not set up again by this extension at all (the gate is in
//   extension.js runSetup); changing the harness is `aidlc config` in a terminal.
//
//   bun is never installed for the user. It is checked, and if absent the official
//   command for their platform is offered to copy. Installing a language runtime
//   behind a confirmation dialog is not a thing an editor extension should do.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { readInstallState, RECEIPT_PATH } = require('./aidlc/install-state');
const { planRemoval } = require('./aidlc/install-plan');
const { applyRemoval } = require('./aidlc/install-apply');

const {
  detectEngine,
  installEngine,
  installCommand,
  pathCaveat,
  isElevatedWindows,
  UAC_ELEVATED_WARNING,
  engineResolvable,
  REPO
} = require('./aidlc/engine-install');

// Harnesses this extension sets up. The release ships seven; these two are the ones
// verified against a real run, and the keys are the ids receipts already on disk record.
const HARNESSES = { 'kiro-ide': 'kiro-ide', 'kiro-cli': 'kiro' };
const { configureProject } = require('./aidlc/engine-config');
const { readProject } = require('./aidlc/index');
const { kiroReadiness } = require('./aidlc/kiro-readiness');

// Dialogs that carry a sentence carry it in English with a Korean line beneath. The
// English is what the engine, the docs and the issue tracker speak; the Korean is for
// the workshops where most of this extension's installs happen. `detail` is where the
// second language goes, which is why these are modal dialogs: a non-modal toast never
// renders `detail` at all (the VS Code API says so), and that is how the completion
// message's next step and the engine's own notices went unseen for every release before
// this one.
function bilingual(en, ko) {
  return `${en}\n\n${ko}`;
}

const HARNESS_LABELS = {
  'kiro-ide': 'Kiro IDE, or Kiro CLI 3.x',
  'kiro-cli': 'Kiro CLI 2.x (v2 engine)'
};
// What each one is, in the engine's terms. The first is the engine's `kiro-ide`
// harness, which covers the editor AND Kiro CLI on its v3 engine (`kiro-cli --v3`, the
// default since Kiro CLI 3.0). The second is the legacy v2-engine CLI (`kiro-cli --v2`).
const HARNESS_DETAILS = {
  'kiro-ide': 'The Kiro editor, and Kiro CLI 3.x (its v3 engine). Choose this unless you run an older Kiro CLI.',
  'kiro-cli': 'Kiro CLI 2.x only, on its v2 engine. On Kiro CLI 3.x this ends in "agent aidlc needs upgrading".'
};

// The engine could not be installed, so setup stops here with the official command.
//
// This replaced a bun gate, and the reason is worth keeping. Until 2026-09-08 the engine
// was bun/TypeScript running from inside the project, so bun was the prerequisite and a
// project without it was files that did nothing. The engine is now a compiled binary
// installed on the machine, its hooks run `aidlc engine adapter <harness>`, and the
// engine reports `bun: not-required` itself. Gating on bun would now block an install
// over something the engine does not use.
//
// Reached only when this extension could not run the install itself -- most often a
// policy that blocks piping a downloaded script into a shell. Never runs the command it
// shows, and never installs anything.
async function handleEngineInstallFailure(text) {
  const command = installCommand();
  const copyLabel = 'Copy the install command';
  const docsLabel = "Open AI-DLC's docs";

  const detail = [
    text,
    '',
    'Run this in a terminal, then set up AI-DLC v2 again:',
    command,
    '',
    'It installs into your home directory and needs no administrator rights.'
  ];

  const choice = await vscode.window.showWarningMessage(
    'AI-DLC v2 needs its engine installed on this machine, and that could not be done ' +
      'automatically.',
    { modal: true, detail: detail.join('\n') },
    copyLabel,
    docsLabel
  );
  if (choice === copyLabel) {
    await vscode.env.clipboard.writeText(command);
    vscode.window.showInformationMessage(
      'Command copied. Run it in a terminal, then set up AI-DLC v2 again.'
    );
  } else if (choice === docsLabel) {
    await vscode.env.openExternal(vscode.Uri.parse(require('./aidlc/engine-install').DOCS_URL));
  }
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
async function chooseGeneration() {

  // v1 is listed first, deliberately. Three thousand people are on it, so it is the
  // answer most people opening this list are looking for, and a list whose first row
  // is the uncommon answer makes the common one read as a fallback. The first row is
  // also what Enter picks.
  //
  // Order carries no recommendation. Each row says what it is and the reader decides;
  // nothing here nudges toward the newer one for being newer.
  //
  // What each generation is, not where its files come from.
  //
  // These lines used to lead with delivery -- a bundled snapshot versus an upstream
  // download. That is the installer's concern, not the reader's. Someone choosing
  // between two generations of a workflow needs to know how the workflow behaves,
  // and the difference that matters is not a feature list: it is who reads the
  // artifacts and what happens when nobody does.
  //
  // Deliberately no stage or phase counts. v2 declared 33 stages when this was
  // written, and the install now follows the branch rather than a fixed commit, so
  // a number here would eventually be a confident lie. Behaviour does not go stale.
  //
  // What survives from the old text is bun, because it is not plumbing: without it
  // the v2 choice cannot be completed, and knowing that in advance saves the trip.
  const picked = await vscode.window.showQuickPick(
    [
      {
        key: 'v1',
        label: 'AI-DLC v1',
        description: 'you read and answer',
        detail:
          'Rule files your agent works from. Each step waits for you to read the ' +
          'artifacts and fill in the answers, so the workflow stops where you stop. ' +
          'Works offline.'
      },
      {
        key: 'v2',
        label: 'AI-DLC v2',
        description: 'you review and approve',
        detail:
          'An engine drives the workflow, enforces the gates and keeps an audit ' +
          'ledger. The agent reads the artifacts and you approve a summary; the run ' +
          'continues whether or not you read them yourself. Installs its engine on this machine.'
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

async function chooseHarness() {
  const picked = await vscode.window.showQuickPick(
    Object.keys(HARNESSES).map((key) => ({
      label: HARNESS_LABELS[key],
      description: `--harness ${HARNESSES[key]}`,
      detail: HARNESS_DETAILS[key],
      key
    })),
    {
      title: 'AI-DLC v2: which Kiro will run it?',
      placeHolder: 'Chosen once. To change it later, run aidlc config in a terminal.',
      ignoreFocusOut: true
    }
  );
  return picked ? picked.key : undefined;
}

// Show the consequences and get a decision. Returns true to proceed.
// What this install is about to do, as one line for the progress notification.
//
// Not a confirmation. Picking v2 and picking a harness were the decisions; asking
// again after both is friction, and a modal that only ever has one button is a
// dialog pretending to be a question. So this says what is being installed while
// it happens, and the completion message says what was installed.
//
// The notes previewInstall produced are not dropped. The ones that matter after
// the fact -- the workflow's own directory left alone, a missing git repository --
// are carried by the completion message, where they can be read without standing
// between the user and the thing they asked for.
function installHeadline(harness) {
  return `installing for ${HARNESS_LABELS[harness] ?? harness} from the latest ${REPO} release`;
}

// The setup command. Asks which generation, then routes.
//
// `installV1` is passed in rather than imported, because the v1 installer lives in
// extension.js and depends on the extension's own bundle path. Keeping the call
// here means one button covers both generations without this file knowing how v1
// works.
// `preselected` lets a caller that has ALREADY asked the generation question skip it.
//
// The auto-detect toast asked "Set up the AI-DLC workflow for this folder?" with one
// "Choose a version" button, which then opened the generation list somewhere else on
// screen, which then came back here. Two decisions, three surfaces. The toast now
// carries the two generations as its own buttons, so a person answers once where the
// question was asked. Anything that cannot say which generation it wants -- the toolbar
// button, the command palette -- still gets the full list with its explanations.
//
// The value is checked rather than trusted: a caller passing something that is not a
// generation falls back to asking, never to installing a guess.
async function setup(folderUri, installV1, preselected) {
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

  // `preselected` is 'v1', 'v2', or 'v2:<harness>' when the toast already carried the
  // harness as a button. Anything else asks. The toast used to offer v1 and v2, and
  // picking v2 opened the harness list in the centre of the screen -- the same one
  // decision spread over two surfaces that the generation buttons had just removed.
  const pre = parsePreselection(preselected);
  const generation = pre ? pre.generation : await chooseGeneration();
  if (!generation) return;
  if (generation === 'v1') {
    // Unchanged from what it has always done, including its own confirmation.
    await installV1();
    return {};
  }
  return (await installV2(root, state, pre ? pre.harness : undefined)) ?? {};
}

function parsePreselection(value) {
  if (value === 'v1') return { generation: 'v1' };
  if (value === 'v2') return { generation: 'v2' };
  if (typeof value === 'string' && value.startsWith('v2:')) {
    const harness = value.slice(3);
    if (Object.prototype.hasOwnProperty.call(HARNESSES, harness)) return { generation: 'v2', harness };
  }
  return undefined;
}

async function installV2(root, state, preselectedHarness) {
  // No recorded-harness guard here any more. There was one, reading the extension's
  // own receipt, and it had been dead since 0.0.25 moved the install to the engine,
  // which writes no such receipt: every v2 project answered "none recorded", the
  // harness was asked again, and the other answer switched the project's harness
  // (the `/aidlc` agent file deleted, hooks replaced). Nothing tested it. The guard
  // that replaces it is in runSetup and is not about the harness: a project with any
  // AI-DLC in it is not set up again, so there is no second answer to give.
  const harness = preselectedHarness ?? (await chooseHarness());
  if (!harness) return;

  // Kiro running "as administrator" on Windows. Upstream's install.ps1 warns and asks
  // before installing from an elevated window; the extension used to refuse outright,
  // with wording upstream no longer uses, so a person who could have installed with the
  // official command was turned away by this one. Same words, same choice, asked before
  // the 80MB download rather than after.
  let allowElevated = false;
  if (!detectEngine().found && (await isElevatedWindows())) {
    const installAnyway = 'Install anyway';
    const choice = await vscode.window.showWarningMessage(
      'Kiro is running as administrator.',
      {
        modal: true,
        detail: bilingual(
          `${UAC_ELEVATED_WARNING} The safest path is to close Kiro, open it normally, and set up AI-DLC again.`,
          'Kiro가 관리자 권한으로 실행 중입니다. AI-DLC는 사용자 계정에만 설치되어 관리자 권한이 필요 ' +
            '없고, 관리자로 설치하면 덜 안전합니다. 가장 안전한 방법은 Kiro를 닫고 일반 사용자로 다시 ' +
            '열어 Set up을 다시 누르는 것입니다.'
        )
      },
      installAnyway
    );
    if (choice !== installAnyway) return;
    allowElevated = true;
  }

  // The progress notification covers the work and nothing else.
  //
  // It used to also contain the completion message, and awaiting that message meant
  // awaiting the user: showInformationMessage resolves when the toast is dismissed
  // or clicked, so the callback never returned and "Setting up AI-DLC v2: writing
  // files…" sat on screen after the install had finished. Reported from a
  // screenshot, and the giveaway is that it said "writing files" -- a stage already
  // over.
  //
  // So this returns what happened and reports afterwards. Nothing that waits on a
  // person may run inside a progress scope.
  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Setting up AI-DLC v2',
      cancellable: false
    },
    async (progress) => {
      let freshInstallCaveat;
      let freshInstall;
      // Two steps now, and they are different in kind. The engine is installed once per
      // MACHINE; the project is configured once per PROJECT. Separating them means a
      // second project costs seconds rather than a 111MB download.
      let engine = detectEngine();
      if (!engine.found) {
        // Upstream's own installer does the work: it resolves the platform target
        // including musl, verifies every asset against checksums.txt, verifies release
        // provenance when the tooling for that is present, and lets the verified binary
        // lay out the machine. Reimplementing that would mean owning a security boundary
        // to save a subprocess.
        // The engine names its own steps: metadata, each download, the apply. Passed
        // through so a person watching a 75MB download sees which part is slow.
        progress.report({ message: 'installing the AI-DLC engine (about 80MB)…' });
        const installed = await installEngine({
          allowElevated,
          onProgress: (message) => progress.report({ message })
        });
        if (!installed.ok) {
          return { engineFailed: installed.text ?? installed.reason };
        }
        freshInstall = installed;
        // Only after an install this run. A machine that already had the engine has
        // whatever PATH arrangement it has been working with, and repeating the caveat
        // there would be noise.
        freshInstallCaveat = pathCaveat(installed.binDir, { pathStatus: installed.pathStatus });
        engine = detectEngine();
        if (!engine.found) {
          // The installer said it succeeded and the binary is not where it should be.
          // Reported rather than pressed on with, because the next step would fail in a
          // way that named the project instead of the machine.
          return {
            engineFailed:
              `The engine reported a successful install of ${installed.version ?? 'AI-DLC'} ` +
              'but its binary was not found afterwards.'
          };
        }
      }

      progress.report({ message: installHeadline(harness) });
      const configured = await configureProject({ binary: engine.path, root, harness });
      if (!configured.ok) {
        return {
          failed:
            `AI-DLC v2 setup failed: ${configured.text ?? configured.reason}`
        };
      }

      return { configured, engine, freshInstallCaveat, freshInstall };
    }
  );

  if (outcome.engineFailed) {
    await handleEngineInstallFailure(outcome.engineFailed);
    return;
  }
  if (outcome.failed) {
    vscode.window.showErrorMessage(outcome.failed);
    return;
  }
  const { configured, engine, freshInstallCaveat, freshInstall } = outcome;

  // What to say, said once, after the fact.
  //
  // The engine reports its own plan counts and its own outstanding actions, and both are
  // carried through rather than summarised. `preserve` is the engine saying how many
  // files already in the folder it left alone.
  const plan = configured.plan;
  const counts = plan
    ? `${plan.create} written` +
      (plan.preserve > 0 ? `, ${plan.preserve} left alone` : '') +
      (plan.update > 0 ? `, ${plan.update} updated` : '') +
      (plan.conflict > 0 ? `, ${plan.conflict} in conflict` : '')
    : undefined;

  const summary =
    `AI-DLC v2 ${engine.version ?? ''} set up for ${HARNESS_LABELS[harness] ?? harness}` +
    (counts ? ` (${counts}).` : '.');

  // Whatever the engine said still needs doing. Left in its own words: these name
  // machine conditions -- most often that the binary resolves only on an interactive
  // PATH, which decides whether the workflow's hooks can find it at all -- and this
  // extension neither fixes nor paraphrases them.
  const notices = (configured.outstanding ?? []).slice();
  // Platform-specific, and it decides whether the hooks can find the engine at all, so it
  // goes with what the engine itself flagged rather than in place of it.
  if (freshInstallCaveat) notices.push(freshInstallCaveat);

  // The step that is easy to miss and blocks everything after it. Kiro reads its
  // agent definitions from the WORKSPACE ROOT's .kiro/agents/, and this install goes
  // into the folder the extension watches, which is frequently not that root -- one
  // observed case installed four levels down inside another project. Without Kiro
  // having this exact folder open, /aidlc simply is not there, which reads as a
  // failed install rather than a missing step.
  const isWorkspaceRoot = (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.fsPath === root
  );

  if (!isWorkspaceRoot) {
    const openLabel = 'Open folder in new window';
    const choice = await vscode.window.showInformationMessage(
      summary,
      {
        modal: true,
        detail: [
          ...notices,
          bilingual(
            'Kiro reads /aidlc from .kiro/agents/ in the WORKSPACE ROOT, and this folder is not ' +
              'the root of the current window. Open it with File > Open Folder in a new window, ' +
              'then type /aidlc.',
            'Kiro는 워크스페이스 루트의 .kiro/agents/에서 /aidlc를 읽는데, 이 폴더는 현재 창의 ' +
              '루트가 아닙니다. 새 창에서 이 폴더를 열고 /aidlc를 입력하세요.'
          )
        ].join('\n\n')
      },
      openLabel
    );
    if (choice === openLabel) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true });
    }
    return {};
  }

  // The window that has this folder open still has to pick up what was written. The
  // engine's own completion line says `Developer: Reload Window`; the extension used to
  // drop that line and say the agent was "already available in this window". Which restart
  // is needed, and why, is kiro-readiness's one decision; the dialog carries its words and
  // one button for it. "Later" is honoured: nothing asks again, the Start page opens now,
  // and Check setup carries the same sentence for whoever comes back to it.
  const readiness = kiroReadiness({
    freshEngineInstall: Boolean(freshInstall),
    pathStatus: freshInstall ? freshInstall.pathStatus : undefined
  });
  const later = 'Later';
  const choice = await vscode.window.showInformationMessage(
    summary,
    {
      modal: true,
      detail: [...notices, bilingual(readiness.en, readiness.ko)].join('\n\n')
    },
    readiness.label,
    later
  );
  // The caller performs the restart, because the Start page that should follow it has to
  // be scheduled in the extension's own state first.
  return { restart: choice === readiness.label ? readiness.action : undefined };
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

// Answers "I installed it and /aidlc is not there".
//
// There are three separate reasons for that and they are indistinguishable from
// the chat: the folder has v1 rather than v2, the engine files are there but Kiro
// does not have the folder open as a workspace, or the engine is missing so the hooks
// cannot run. Each has a different fix, so the check names which one it is rather
// than reporting a generic problem.
// The vocabulary this build met and had no meaning for, as display lines.
//
// Kept out of checkV2 so the command stays a sequence of statements about the
// project, and so this can fail without taking the report with it: a project whose
// data cannot be read still deserves the rest of the answer.
function unrecognisedVocabulary(root) {
  try {
    const project = readProject(root, {});
    if (!project.v2 || !project.v2.ok) return [];
    const gaps = project.v2.gaps ?? {};
    const lines = [];
    // Not enumerated by name. Whatever the reader chose to report as a gap is
    // reported here, so a new kind of gap needs no change in this function.
    for (const [kind, values] of Object.entries(gaps)) {
      if (!Array.isArray(values) || values.length === 0) continue;
      lines.push(`${kind}: ${values.join(', ')}`);
    }
    return lines;
  } catch {
    return [];
  }
}

async function checkV2(folderUri) {
  if (!folderUri) {
    vscode.window.showWarningMessage('Select a folder to watch first.');
    return;
  }
  const root = folderUri.fsPath;
  const state = readInstallState(root);
  const lines = [];
  const engine = detectEngine();

  // Either spelling counts. The engine shipped `.kiro/agents/aidlc.json`, then
  // `aidlc.md`, and 2.11.3 ships `aidlc-aidlc.md`; a diagnostic that only knew the old
  // names reported MISSING on a correctly installed current project, which is worse than
  // saying nothing. (The third name was found while adding the PATH check below: Check
  // setup had been wrong on every 2.11.3 project.)
  const agentCandidates = [
    path.join(root, '.kiro', 'agents', 'aidlc-aidlc.md'),
    path.join(root, '.kiro', 'agents', 'aidlc.md'),
    path.join(root, '.kiro', 'agents', 'aidlc.json')
  ];
  const agentFile = agentCandidates.find((candidate) => fs.existsSync(candidate));
  const hasAgent = Boolean(agentFile);
  const isWorkspace = (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.fsPath === root
  );
  // Whether Kiro's own PATH resolves `aidlc`: the question for the hooks, which Kiro
  // starts with the PATH it launched with. The engine can be on disk and this still be
  // NO -- a Windows install this session, or a Mac whose shell profile lacks
  // ~/.local/bin -- and then /aidlc appears and nothing behind it runs.
  const resolvable = engineResolvable();

  lines.push(`Folder: ${root}`);
  lines.push(`Generation detected: ${state.ok ? state.generation : 'unreadable'}`);
  lines.push(
    `.kiro/agents/aidlc*.{md,json}: ${hasAgent ? `present (${path.basename(agentFile)})` : 'MISSING'}`
  );
  lines.push(`Open as a Kiro workspace: ${isWorkspace ? 'yes' : 'NO'}`);
  // The engine, which is what the project's hooks call. bun is deliberately not reported:
  // the engine states `bun: not-required` itself, and naming it here would send someone to
  // install something the workflow does not use.
  lines.push(
    `AI-DLC engine: ${engine.found ? `${engine.version ?? 'installed'} at ${engine.path}` : 'NOT INSTALLED'}`
  );
  if (!engine.found) {
    lines.push(
      "  The project's hooks run `aidlc engine adapter <harness>`, so without this the " +
        'workflow cannot advance. Run "Set up AI-DLC" and pick v2, which installs it.'
    );
  }
  lines.push(`Kiro can run \`aidlc\` from its PATH: ${resolvable ? 'yes' : 'NO'}`);
  if (engine.found && !resolvable) {
    const readiness = kiroReadiness({ resolvable: false });
    lines.push(`  ${readiness.en}`);
    lines.push(`  ${readiness.ko}`);
  }
  lines.push('');

  if (!hasAgent) {
    lines.push(
      'The /aidlc agent comes from that file, so it cannot appear until v2 is ' +
        'installed here. Use "Set up AI-DLC" and pick v2.'
    );
    if (state.generation === 'v1') {
      lines.push(
        'This folder currently has v1 rule files. They are left alone by a v2 ' +
          'install, but the two generations are different products and mixing them ' +
          'in one project is not something upstream supports.'
      );
    }
  } else if (!isWorkspace) {
    lines.push(
      'The engine files are here, but Kiro reads agent definitions from the ' +
        'workspace root. Open this folder with File > Open Folder, in a new ' +
        'window, and /aidlc will be there.'
    );
  } else if (!engine.found) {
    // The hooks call the engine by name. Without it, /aidlc appears and nothing
    // behind it runs -- the same silent failure the old bun gate guarded against,
    // now attached to the thing that actually matters.
    lines.push(
      'Everything is in place except the AI-DLC engine, which the project\'s hooks ' +
        'run through. /aidlc will appear but its gates will not fire. Run "Set up ' +
        'AI-DLC" and pick v2 to install it.'
    );
  } else if (!resolvable) {
    lines.push(
      'The engine is installed and the agent is here, but Kiro cannot find `aidlc` on its ' +
        'PATH, so /aidlc will appear and its hooks will not run. See the line above for what ' +
        'to do; most often it is quitting Kiro and opening it again.'
    );
  } else {
    lines.push('Everything needed is in place. /aidlc should be available.');
  }

  // What this build does not recognise in the engine it just read.
  //
  // This used to sit in the supervision panel, where it printed a near-identical set
  // of bookkeeping names on every project: unchanging, and nothing a user could act
  // on. It is useful here instead, because the install follows the v2 branch rather
  // than a fixed commit, so this is the only thing that notices upstream growing a
  // vocabulary this build has never met. A maintainer reads this command; a user does
  // not.
  //
  // Read through the same reader the panel uses, so what is reported is what the
  // extension actually acted on rather than a separate scan of its own.
  if (hasAgent) {
    const unknown = unrecognisedVocabulary(root);
    if (unknown.length > 0) {
      lines.push('');
      lines.push('Read but not understood by this build:');
      for (const entry of unknown) lines.push(`  ${entry}`);
      lines.push(
        '  Nothing above depends on these. They are named so that a change upstream ' +
          'is visible rather than silent.'
      );
    }
  }

  const copyLabel = 'Copy this report';
  const ready = hasAgent && isWorkspace && engine.found && resolvable;
  const choice = await vscode.window.showInformationMessage(
    ready ? 'AI-DLC v2 looks ready.' : 'AI-DLC v2 is not ready yet.',
    { modal: true, detail: lines.join('\n') },
    copyLabel
  );
  if (choice === copyLabel) {
    await vscode.env.clipboard.writeText(lines.join('\n'));
  }
}

module.exports = { setup, removeV2, checkV2, hasRemovableInstall, RECEIPT_PATH };
