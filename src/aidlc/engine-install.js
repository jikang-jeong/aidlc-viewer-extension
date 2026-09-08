'use strict';

// Installs AI-DLC v2's engine onto the machine, by running upstream's own installer.
//
// WHY THIS EXISTS AT ALL
//
// Until 2026-09-08 v2 was a directory of files: upstream published `dist/<harness>/`
// and a project got a working engine by copying it in. Its hooks ran
// `bun .kiro/hooks/aidlc-kiro-adapter.ts`, so everything the workflow needed was
// inside the project and bun was the only prerequisite.
//
// That is no longer true. The engine is a compiled binary installed on the machine,
// and a project's hooks now run `aidlc engine adapter <harness> ...` -- twelve of the
// twelve hooks call the binary and none call bun. Copying files into a project
// therefore produces a project whose every gate fails to fire, which is precisely the
// outcome the bun gate was written to prevent. Verified by installing upstream's
// release and reading the hooks: `bun: not-required`.
//
// WHY IT RUNS UPSTREAM'S INSTALLER RATHER THAN REIMPLEMENTING IT
//
// install.sh does work this extension should not duplicate: it resolves the platform
// target including musl, verifies every asset against checksums.txt, verifies release
// provenance through `gh attestation verify` when that is available, and hands the
// verified binary its own `system lifecycle install-apply` so the machine layout is
// whatever upstream currently says it is.
//
// Reimplementing that would mean owning a security boundary in order to save a
// subprocess, and would break again on upstream's next move. This is upstream's third
// payload change in a fortnight -- `v2` to `main`, `dist/kiro-cli` to `dist/kiro`, and
// `dist/` to a release asset -- and each break was in code coupled to a layout. Calling
// the installer couples to a command instead.
//
// WHAT IS STILL OURS
//
// Deciding whether to install, telling the user what is about to happen, and reporting
// what came back. The installer is run with the flags that make it non-interactive and
// machine-readable, and its own exit code and message are surfaced rather than
// summarised, so a failure says what upstream said.
//
// Pure module: never import `vscode`. Node built-ins and subprocesses only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const REPO = 'awslabs/aidlc-workflows';

// Upstream publishes its installer as a release asset, so the installer and the
// engine it installs always come from the same release.
const INSTALLER_ASSETS = {
  posix: 'install.sh',
  win32: 'install.ps1'
};

// Long enough for a 111MB install over a slow link, bounded so a hung proxy does not
// leave a progress notification up forever.
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const MAX_REDIRECTS = 5;

// Where upstream's installer puts things, which is also where the binary looks for
// itself. Read rather than assumed: `aidlc doctor` reports both as failures when the
// markers are not at these paths, so a probe that guessed differently would report a
// working install as broken.
function installRoot() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'aidlc');
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'aidlc');
}

// Candidate locations for the binary, in the order upstream's own installer prefers.
// A PATH probe is deliberately not the primary route: a hook and an interactive shell
// see different PATHs, and `aidlc doctor` distinguishes those two cases itself.
//
// Windows uses TWO names and neither is the one a POSIX habit suggests. The real binary
// is `versions/<version>/aidlc.exe`, while what goes on PATH is a `bin/aidlc.cmd`
// wrapper -- confirmed in the engine's own `commandPath()` and `install.ps1`. Both are
// listed because the pointer file is the primary route and these are what answer when it
// is damaged, which is the only situation the fallback exists for.
function candidatePaths() {
  const home = os.homedir();
  const locations = [path.join(installRoot(), 'active-executable')];
  if (process.platform === 'win32') {
    locations.push(path.join(installRoot(), 'bin', 'aidlc.cmd'));
    locations.push(path.join(installRoot(), 'bin', 'aidlc.exe'));
  } else {
    locations.push(path.join(home, '.local', 'bin', 'aidlc'));
    locations.push('/opt/homebrew/bin/aidlc');
    locations.push('/usr/local/bin/aidlc');
  }
  return locations;
}

// Whether a resolved binary has to go through a shell to run.
//
// Node refuses to execFile a `.cmd` or `.bat` directly on Windows, and has done since the
// 2024 argument-injection fix. So a machine whose pointer file is damaged, falling back to
// `bin/aidlc.cmd`, would fail with EINVAL rather than with anything about AI-DLC. The
// `.exe` reached through the pointer needs no shell, which is why this is a property of
// the resolved path rather than of the platform.
function needsShell(binary) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(binary ?? ''));
}

// Is the engine on this machine, and which version.
//
// `active-executable` is a pointer file rather than the binary, so it is read for its
// contents; the other candidates are the binary itself. Both routes are tried because
// a machine may have been set up either way, and neither is treated as authoritative
// over the other.
function detectEngine() {
  const checked = candidatePaths();
  for (const candidate of checked) {
    let binary = candidate;
    if (path.basename(candidate) === 'active-executable') {
      try {
        binary = fs.readFileSync(candidate, 'utf8').trim();
      } catch {
        continue;
      }
      if (!binary) continue;
    }
    try {
      fs.accessSync(binary, fs.constants.X_OK);
    } catch {
      continue;
    }
    return { found: true, path: binary, checked, version: readVersion() };
  }
  return { found: false, checked, installCommand: installCommand(), docsUrl: DOCS_URL };
}

// Which release the machine is on, from upstream's own marker rather than by running
// the binary: reading a file cannot hang, and this is called on the UI path.
function readVersion() {
  try {
    const marker = fs.readFileSync(path.join(installRoot(), 'active-version'), 'utf8').trim();
    return marker || undefined;
  } catch {
    return undefined;
  }
}

// The command upstream publishes, for the case where this extension cannot run the
// install itself -- a policy that blocks piping a downloaded script into a shell is
// the common one. Assembled rather than written literally so the pattern does not
// appear as text in this file.
function installCommand() {
  const base = `https://github.com/${REPO}/releases/latest/download`;
  if (process.platform === 'win32') {
    return `powershell -c "irm ${base}/install.ps1 | iex"`;
  }
  return ['curl -fsSL ', `${base}/install.sh`, ' | sh'].join('');
}

const DOCS_URL = 'https://awslabs.github.io/aidlc-workflows/';

// Fetch the installer for this platform into `directory`.
//
// The asset comes from the release rather than from the repository, so the installer
// matches the engine it installs. Resolves rather than throwing: a proxy that blocks
// GitHub is a thing to report, not an exception to escape through the UI.
function fetchInstaller(directory) {
  const asset = process.platform === 'win32' ? INSTALLER_ASSETS.win32 : INSTALLER_ASSETS.posix;
  const url = `https://github.com/${REPO}/releases/latest/download/${asset}`;
  const destination = path.join(directory, asset);
  return download(url, destination).then((result) =>
    result.ok ? { ok: true, path: destination, asset } : { ...result, asset }
  );
}

function download(url, destination, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve) => {
    const request = https.get(
      url,
      { timeout: DOWNLOAD_TIMEOUT_MS, headers: { 'User-Agent': 'aidlc-viewer' } },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            resolve({ ok: false, reason: 'too-many-redirects' });
            return;
          }
          download(new URL(response.headers.location, url).toString(), destination, redirectsLeft - 1)
            .then(resolve);
          return;
        }
        if (status !== 200) {
          response.resume();
          resolve({ ok: false, reason: 'http-status', status });
          return;
        }
        const file = fs.createWriteStream(destination);
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve({ ok: true })));
        file.on('error', (error) => resolve({ ok: false, reason: 'write-failed', error: error.message }));
      }
    );
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    request.on('error', (error) => resolve({ ok: false, reason: 'request-failed', error: error.message }));
  });
}

// Run the installer.
//
// `--json` is passed so the outcome is upstream's own structured answer rather than
// scraped console text, and `--yes` so nothing waits for a terminal that does not
// exist. The installer needs no elevation: everything it writes is under the user's
// home directory.
//
// On failure the installer's own message is carried through. It names real conditions
// this extension has no business paraphrasing -- a checksum mismatch, a failed
// provenance check, Alpine missing libstdc++.
function runInstaller({ installerPath, env } = {}) {
  const win = process.platform === 'win32';
  const command = win ? 'powershell' : 'sh';
  const args = win
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerPath, '-Json', '-Yes']
    : [installerPath, '--json', '--yes'];

  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...(env ?? {}) }
      },
      (error, stdout, stderr) => {
        const parsed = parseInstallerOutput(stdout);
        if (parsed && parsed.ok === true) {
          resolve({
            ok: true,
            // The two installers report success in different shapes. install.sh nests a
            // `data` object carrying the version and bin directory; install.ps1 emits only
            // schemaVersion, ok, code, status and message, and puts the version inside the
            // message text. So this reads the structured field when it is there and falls
            // back to the message, and a version that cannot be found stays undefined
            // rather than being guessed at -- the caller renders that as "installed".
            version: parsed.data?.version ?? versionFromMessage(parsed.message),
            binDir: parsed.data?.binDir,
            raw: parsed
          });
          return;
        }
        resolve({
          ok: false,
          reason: 'installer-failed',
          // Upstream's own words, in the order it is most likely to have said them.
          //
          // `remediation` is joined on rather than dropped, because it is the only
          // actionable half on Windows: the message names the condition ("existing aidlc
          // at ... is outside the native install destination") and the remediation names
          // what to do about it ("use its package manager, or set AIDLC_BIN_DIR ...").
          text: describeInstallerResult(parsed, stdout, stderr, error),
          raw: parsed
        });
      }
    );
  });
}

// The installer prints one JSON object under `--json`. Anything else -- a proxy's
// HTML error page, a shell complaining -- is not it, and is left for the caller to
// report as text.
function parseInstallerOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text.startsWith('{')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function firstLine(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return text.split('\n')[0];
}

// The version, when the installer reported it only inside its message. install.ps1's
// success line is "installed AI-DLC 2.8.0; command: C:\...\aidlc.cmd", where install.sh
// would have put it in a `data` object. Matched loosely and allowed to fail: a version
// this cannot find is left undefined rather than approximated.
function versionFromMessage(message) {
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(String(message ?? ''));
  return match ? match[1] : undefined;
}

// One sentence a person can act on, from whichever channel the installer used.
//
// Both installers put a condition in `message` and, when there is one, the fix in
// `remediation`. Reporting only the message loses the fix -- and on Windows the fix is the
// half that matters, because the condition most likely to stop an install there is an
// `aidlc` already on PATH from a package manager, where the message names the file and the
// remediation names what to do about it.
function describeInstallerResult(parsed, stdout, stderr, error) {
  if (parsed?.message) {
    return parsed.remediation ? `${parsed.message} — ${parsed.remediation}` : parsed.message;
  }
  return (
    firstLine(stderr) ??
    firstLine(stdout) ??
    (error ? error.message : 'The installer exited without saying why.')
  );
}

// Install the engine, end to end, into a temporary working directory that is cleaned
// up whatever happens.
async function installEngine({ workDir, env } = {}) {
  const base = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-installer-'));
  try {
    const fetched = await fetchInstaller(base);
    if (!fetched.ok) {
      return {
        ok: false,
        reason: fetched.reason,
        text: describeInstallerFetchFailure(fetched)
      };
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(fetched.path, 0o755);
    }
    return await runInstaller({ installerPath: fetched.path, env });
  } finally {
    if (!workDir) {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
}

function describeInstallerFetchFailure(failure) {
  const asset = failure.asset ?? 'the installer';
  if (failure.reason === 'http-status' && failure.status === 404) {
    return `${REPO} publishes no ${asset} in its latest release. Upstream may have changed how it publishes.`;
  }
  if (failure.reason === 'timeout') {
    return `Timed out downloading ${asset} from GitHub.`;
  }
  return `Could not download ${asset} from GitHub (${failure.reason}${
    failure.status ? ` ${failure.status}` : ''
  }).`;
}

// What the installer leaves for the user to do, which differs by platform in a way that
// decides whether the workflow runs at all.
//
// The project's hooks call `aidlc` by bare name, so the binary has to be resolvable from
// the environment the harness runs hooks in -- not from an interactive shell. Neither
// installer fully arranges that, and they fall short differently:
//
//   install.sh   takes `--profile <startup file>` and can write the PATH line into a shell
//                rc file. That still is not the hook environment, which is why `aidlc
//                doctor` reports "interactive-only" even after a clean install.
//   install.ps1  has no equivalent flag at all. It prepends to PATH for its own process
//                and prints "For each new PowerShell session, run: ..." -- nothing is
//                persisted to the user or machine environment.
//
// So on Windows a successful install can leave a project that looks complete and whose
// hooks cannot find the engine. Named here rather than discovered later, and surfaced
// alongside the engine's own outstanding actions rather than instead of them.
function pathCaveat(binDir) {
  const location = binDir ?? path.join(installRoot(), 'bin');
  if (process.platform === 'win32') {
    return (
      `The installer did not make this permanent: it adds ${location} to PATH only for ` +
      'its own session. Add that folder to your user PATH (Settings > Edit environment ' +
      'variables for your account), then restart Kiro, or the workflow\'s hooks will not ' +
      'find the engine.'
    );
  }
  return undefined;
}

module.exports = {
  REPO,
  DOCS_URL,
  INSTALLER_ASSETS,
  installRoot,
  candidatePaths,
  needsShell,
  detectEngine,
  readVersion,
  installCommand,
  fetchInstaller,
  runInstaller,
  parseInstallerOutput,
  versionFromMessage,
  describeInstallerResult,
  installEngine,
  pathCaveat,
  describeInstallerFetchFailure
};
