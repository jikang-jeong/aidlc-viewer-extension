'use strict';

// Configures a project for AI-DLC v2, by running the engine's own `aidlc config`.
//
// WHY THIS REPLACED COPYING FILES
//
// Copying `dist/<harness>/` into a project used to be the whole install. It no longer
// is, and the gap is not only the missing binary. `aidlc config` writes one file that
// copying cannot produce: `.kiro/tools/data/aidlc-manifest.json`, an inventory of every
// installed file with its sha256. The engine reads that to tell its own files from the
// user's, which is how a later `aidlc config` knows to preserve 323 files and update 1
// rather than overwriting a project.
//
// A copied-in project is missing that inventory. Measured: our copy produced 322 of the
// 323 files, byte-identical except the two this extension merges by marker, and the one
// missing file was the manifest.
//
// WHAT THE ENGINE'S OWN INSTALLER GETS RIGHT THAT A COPY DOES NOT
//
// Verified by running it against a project the workflow had already used: a re-run
// preserved a `project.md` the workflow had rewritten, an artifact under `intents/`, and
// a hand-written steering rule. Its plan is reported before it acts -- `create=323
// update=0 merge=0 preserve=0 remove=0 conflict=0` on an empty project -- and `--dry-run`
// makes that available without writing, which is a better preview than this extension
// could compute for itself.
//
// WHAT REMAINS THIS EXTENSION'S JOB
//
// Choosing the harness, keeping v1's rules alive where the two generations share
// `.kiro/`, and reporting what happened. The harness must be passed explicitly: the
// release installs all seven runtimes, so a bare `aidlc config` refuses with
// "multiple harnesses are installed" rather than picking one.
//
// Pure module: never import `vscode`. Node built-ins and subprocesses only.

const { execFile } = require('child_process');
const { needsShell } = require('./engine-install');

// Long enough to write 323 files on a slow disk, short enough that a wedged run does
// not hold a progress notification open indefinitely.
const CONFIG_TIMEOUT_MS = 5 * 60 * 1000;

// Harness ids the engine accepts, mapped from the ids this extension has always used.
// The extension's `kiro-cli` is the engine's `kiro`. The extension-side key is kept
// because install receipts already on disk record it, and renaming it would make those
// unreadable.
const HARNESS_IDS = {
  'kiro-ide': 'kiro-ide',
  'kiro-cli': 'kiro'
};

// Run `aidlc config` for one project.
//
// `--yes` confirms the choices passed explicitly; upstream documents that it never
// chooses a value on the user's behalf, so this cannot silently accept a default the
// user did not ask for. `--dry-run` returns the plan without writing.
function configureProject({ binary, root, harness, dryRun = false, env } = {}) {
  const id = HARNESS_IDS[harness];
  if (!id) {
    return Promise.resolve({
      ok: false,
      reason: 'unknown-harness',
      text: `No engine harness id known for "${harness}".`
    });
  }

  const args = ['config', '--harness', id, '--yes'];
  if (dryRun) args.push('--dry-run');

  // A `.cmd` cannot be handed to execFile directly on Windows -- Node has refused that
  // since its 2024 argument-injection fix -- so it goes through a shell. The `.exe` reached
  // through the engine's own pointer file does not, which is why this asks about the
  // resolved path rather than about the platform. Without it, a machine whose pointer is
  // damaged fails with EINVAL and no mention of AI-DLC.
  //
  // Under a shell, Node concatenates rather than quotes, so the path is quoted here: the
  // wrapper lives under %LOCALAPPDATA%, and Windows user names carry spaces routinely
  // ("C:\Users\Jane Doe\..."). The arguments need no such treatment because every one of
  // them is a fixed token of this function's own -- nothing user-supplied is ever
  // concatenated into a shell line.
  const shell = needsShell(binary);
  const file = shell ? `"${binary}"` : binary;

  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: root,
        timeout: CONFIG_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        shell,
        env: { ...process.env, ...(env ?? {}) }
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '').trim();
        const err = String(stderr ?? '').trim();

        // The engine reports a refusal on stdout with a zero exit code -- an unknown
        // harness, a project it will not touch -- so the exit code alone does not
        // decide this. A line starting `error:` is upstream's own failure marker.
        const refused = /^error:/m.test(out) || /^error:/m.test(err);
        if (error || refused) {
          return resolve({
            ok: false,
            reason: refused ? 'engine-refused' : 'config-failed',
            text: firstMeaningfulLine(out) ?? firstMeaningfulLine(err) ?? (error ? error.message : 'The engine exited without saying why.'),
            plan: parsePlan(out),
            stdout: out,
            stderr: err
          });
        }

        resolve({
          ok: true,
          dryRun,
          plan: parsePlan(out),
          // Upstream reports remaining work under "Outstanding actions:" -- most often
          // that the binary resolves only on an interactive PATH, which affects whether
          // hooks can find it. Carried through rather than dropped, because it is the
          // difference between a configured project and a working one.
          outstanding: parseOutstanding(out),
          message: firstMeaningfulLine(out),
          stdout: out
        });
      }
    );
  });
}

// The counts the engine reports for what it will do. Parsed for display only; nothing
// branches on the numbers, so a changed format degrades to "no plan shown" rather than
// to a wrong claim about what is about to happen.
function parsePlan(text) {
  const match = /create=(\d+) update=(\d+) merge=(\d+) preserve=(\d+) remove=(\d+) conflict=(\d+)/.exec(
    String(text ?? '')
  );
  if (!match) return undefined;
  const [, create, update, merge, preserve, remove, conflict] = match.map(Number);
  return { create, update, merge, preserve, remove, conflict };
}

// Lines the engine listed under "Outstanding actions:". Returned verbatim: they name
// machine conditions this extension cannot fix and should not paraphrase.
function parseOutstanding(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((line) => /^Outstanding actions:/.test(line.trim()));
  if (start === -1) return [];
  const collected = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line) || !line.trim()) break;
    collected.push(line.trim());
  }
  return collected;
}

function firstMeaningfulLine(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const error = lines.find((line) => line.startsWith('error:'));
  return error ?? lines[0];
}

module.exports = {
  HARNESS_IDS,
  configureProject,
  parsePlan,
  parseOutstanding
};
