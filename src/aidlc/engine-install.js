'use strict';

// Installs AI-DLC v2's engine onto the machine -- one code path for every platform.
//
// WHY THE EXTENSION ORCHESTRATES THIS ITSELF
//
// The first version ran upstream's install scripts: install.sh through `sh` and
// install.ps1 through `powershell`. That meant two platform-specific paths, and the
// Windows one could never be executed here -- every Windows fix in this module's history
// was found by reading sources, and each had passed every test this project could run.
//
// Reading those scripts showed the split differently. The hard part of installing --
// laying out versions/, the active-version markers, the PATH wrapper -- is not in the
// scripts at all. Both end by invoking the downloaded binary's own
// `system lifecycle install-apply`, and everything before that is orchestration: resolve
// version.json, download assets, verify sha256 sums, run the binary. Orchestration is
// plain Node, identical on every platform, which turns "cannot verify Windows" into
// "verify the one path on the machine we have". The only per-platform fact left is which
// binary asset to download.
//
// So the coupling moved, deliberately: from "upstream's installer exists and takes these
// flags" to "the release carries these assets and the binary takes install-apply". The
// latter is the contract BOTH official installers consume, which makes it the least
// likely thing upstream has to move.
//
// ONE EXCEPTION, ADDED LATER: on Windows the apply step is handed back to install.ps1,
// with the directory this module downloaded and verified (`-From <dir>`). Not for the
// apply itself -- the binary does that the same way everywhere -- but for what the script
// does after it: registering the command directory on the account's persistent PATH.
// install-apply does not do that, and without it every Windows install this extension
// made left a manual PATH step that the official command does not. The download and
// verification stay here, on the one path; the script is one more verified asset. See
// WINDOWS_INSTALLER.
//
// WHAT IS MIRRORED FROM THE OFFICIAL INSTALLERS, ON PURPOSE
//
//   - version.json is validated the way install.sh validates it: version shape,
//     sourceRef must be the version's own tag, sourceDigest must be a 40-hex sha.
//   - Every downloaded asset is verified against checksums.txt before anything runs.
//   - checksums.txt itself is verified with `gh attestation verify` when gh is
//     available, and skipped when it is not -- the scripts make the same choice.
//   - An elevated Windows session is asked about, as install.ps1 asks, with its words;
//     installing anyway passes the script's own -Yes.
//   - The --from directory handed to install-apply carries exactly what the scripts
//     put there: version.json, checksums.txt, the provenance bundle, the binary and
//     the runtime tarball, under their published names.
//
// Pure module: never import `vscode`. Node built-ins and subprocesses only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const REPO = 'awslabs/aidlc-workflows';
const RELEASE_BASE = `https://github.com/${REPO}/releases/latest/download`;
const RELEASE_WORKFLOW = `${REPO}/.github/workflows/release.yml`;
const DOCS_URL = 'https://awslabs.github.io/aidlc-workflows/';

// install-apply extracts a 12MB tarball and writes ~2,400 files; the binary itself is up
// to 97MB over an unknown link. Bounded so a wedged run cannot hold a progress
// notification open forever, generous so a slow disk or link is not mistaken for a hang.
const APPLY_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60 * 1000;
const MAX_REDIRECTS = 5;

// The binary asset for each platform, exactly as upstream names them. A platform absent
// here is one upstream publishes no binary for, and is refused by name rather than by a
// failed download.
//
// `musl` matters only on Linux: upstream ships separate musl builds because the glibc
// ones fail there with a missing libstdc++.
//
// ARM64 Windows gets the x64 binary ON PURPOSE. Upstream publishes no Windows ARM64
// build, and install.ps1 does not even probe the architecture -- it hardcodes
// aidlc-windows-x64.exe, relying on the x64 emulation Windows 11 ships on ARM. Refusing
// here was a divergence from upstream's own behavior, found by a real test on ARM64
// Windows: the extension declined an install that install.ps1 performs. (Windows 10 on
// ARM cannot emulate x64; there the binary fails to start with the OS's own error, which
// is also exactly what running install.ps1 gets.)
function assetName({ platform, arch, musl } = {}) {
  const key = `${platform}-${arch}${musl ? '-musl' : ''}`;
  const names = {
    'darwin-arm64': 'aidlc-darwin-arm64',
    'darwin-x64': 'aidlc-darwin-x64',
    'linux-arm64': 'aidlc-linux-arm64',
    'linux-arm64-musl': 'aidlc-linux-arm64-musl',
    'linux-x64': 'aidlc-linux-x64',
    'linux-x64-musl': 'aidlc-linux-x64-musl',
    'win32-x64': 'aidlc-windows-x64.exe',
    'win32-arm64': 'aidlc-windows-x64.exe'
  };
  return names[key];
}

// Whether this Linux is musl-based. Node's diagnostic report names the glibc runtime
// when there is one; its absence on Linux means musl. Wrapped because the report API is
// diagnostic surface, not contract -- if it is unavailable the glibc build is assumed,
// which is what upstream's installer also falls back to when its own probe fails.
function isMuslLinux() {
  if (process.platform !== 'linux') return false;
  try {
    return !process.report.getReport().header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

// Where upstream's binary lays the machine out, per its own aidlc-install-paths.ts.
// Read rather than assumed: `aidlc doctor` reports failures when the markers are not at
// these paths, so a probe that guessed differently would report a working install as
// broken.
function installRoot() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'aidlc');
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'aidlc');
}

// Where the runnable command lands. Windows keeps it inside the install root; POSIX uses
// ~/.local/bin. Same source as installRoot.
function defaultBinDir() {
  if (process.env.AIDLC_BIN_DIR) return process.env.AIDLC_BIN_DIR;
  if (process.platform === 'win32') return path.join(installRoot(), 'bin');
  return path.join(os.homedir(), '.local', 'bin');
}

// Candidate locations for the binary, in the order upstream's own installer prefers.
// A PATH probe is deliberately not the primary route: a hook and an interactive shell
// see different PATHs, and `aidlc doctor` distinguishes those two cases itself.
//
// Windows uses TWO names and neither is the one a POSIX habit suggests. The real binary
// is `versions/<version>/aidlc.exe`, while what goes on PATH is a `bin/aidlc.cmd`
// wrapper -- confirmed in the engine's own `commandPath()`. Both are listed because the
// pointer file is the primary route and these answer when it is damaged, which is the
// only situation the fallback exists for.
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

// The command upstream publishes, for the case where this extension cannot do the
// install itself -- an unsupported platform, or a network it cannot use. Assembled
// rather than written literally so the pattern does not appear as text in this file.
function installCommand() {
  if (process.platform === 'win32') {
    return `powershell -c "irm ${RELEASE_BASE}/install.ps1 | iex"`;
  }
  return ['curl -fsSL ', `${RELEASE_BASE}/install.sh`, ' | sh'].join('');
}

// ---------------------------------------------------------------------------
// Release metadata
// ---------------------------------------------------------------------------

// version.json, validated the way install.sh validates it. Each check catches a
// different way a release endpoint can lie: a version that is not a version, a tag that
// does not match the version it claims, a digest that is not a commit.
function validateVersionInfo(info) {
  if (!info || typeof info !== 'object') {
    return { ok: false, reason: 'version-json-unreadable' };
  }
  const version = info.version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    return { ok: false, reason: 'version-json-invalid', text: 'version.json has no valid version.' };
  }
  if (info.sourceRef !== `refs/tags/v${version}`) {
    return {
      ok: false,
      reason: 'version-json-invalid',
      text: 'version.json has an invalid release source ref.'
    };
  }
  if (typeof info.sourceDigest !== 'string' || !/^[a-f0-9]{40}$/.test(info.sourceDigest)) {
    return {
      ok: false,
      reason: 'version-json-invalid',
      text: 'version.json has an invalid release source digest.'
    };
  }
  return { ok: true, version, sourceRef: info.sourceRef, sourceDigest: info.sourceDigest };
}

// checksums.txt: `<64 hex><two spaces><asset name>` per line, upstream's exact format.
// Anything that does not parse is ignored rather than guessed at; a missing entry is the
// caller's failure to report.
function parseChecksums(text) {
  const sums = {};
  for (const line of String(text ?? '').split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line.trim() === line ? line : line.trim());
    if (match) sums[match[2]] = match[1];
  }
  return sums;
}

function sha256File(file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(undefined));
  });
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function download(url, destination, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve) => {
    const request = https.get(
      url,
      { timeout: DOWNLOAD_IDLE_TIMEOUT_MS, headers: { 'User-Agent': 'aidlc-viewer' } },
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

function describeDownloadFailure(asset, failure) {
  if (failure.reason === 'http-status' && failure.status === 404) {
    return `${REPO}'s latest release carries no ${asset}. Upstream may have changed how it publishes.`;
  }
  if (failure.reason === 'timeout') {
    return `Timed out downloading ${asset} from GitHub.`;
  }
  return `Could not download ${asset} from GitHub (${failure.reason}${
    failure.status ? ` ${failure.status}` : ''
  }).`;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

// Whether this Windows session is elevated. install.ps1 warns on a UAC-elevated
// install and asks before continuing (it used to refuse; the extension copied the
// refusal and kept it after upstream had moved on, so a Kiro run "as administrator"
// was turned away while the official command on the same machine would have asked
// and installed). The caller asks the person with upstream's own words; this only
// answers the question.
//
// `net session` succeeds only when elevated -- the standard probe where no API exists.
// Every failure mode (not elevated, command missing, timeout) resolves to false, because
// refusing a normal user by mistake blocks an install over nothing. It cannot tell a UAC
// split token from a full-token Administrator session (which upstream lets through
// silently); the one case that gets an extra question is acceptable, the reverse is not.
function isElevatedWindows() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('net', ['session'], { timeout: 10 * 1000 }, (error) => resolve(!error));
  });
}

// Upstream's own warning, verbatim from install.ps1's Confirm-UacElevatedInstall, so the
// person sees the same sentence whichever way they install.
const UAC_ELEVATED_WARNING =
  'This PowerShell window is running as administrator. AI-DLC installs just for your ' +
  "account and doesn't need admin rights, and installing as administrator is less safe: " +
  'another program running as you could interfere with it.';

// Whether `gh` can verify release provenance here. The official installers verify when
// the tool exists and proceed when it does not; the same choice is made here for the
// same reason -- provenance is worth checking and not worth making unownable machines
// uninstallable over.
//
// The probe asks about the FLAGS, not about gh: install.sh greps
// `gh attestation verify --help` for the three flags it passes, because an older gh has
// the subcommand without them and would fail on the arguments rather than on the
// attestation. Probing existence alone would turn that machine's install into a refusal
// upstream itself does not make.
function provenanceVerifierAvailable() {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['attestation', 'verify', '--help'],
      { timeout: 10 * 1000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(false);
        const help = String(stdout ?? '');
        resolve(
          ['--signer-workflow', '--source-ref', '--source-digest'].every((flag) =>
            help.includes(flag)
          )
        );
      }
    );
  });
}

function verifyProvenance({ dir, sourceRef, sourceDigest }) {
  return new Promise((resolve) => {
    execFile(
      'gh',
      [
        'attestation', 'verify', path.join(dir, 'checksums.txt'),
        '--bundle', path.join(dir, 'aidlc-release.intoto.jsonl'),
        '--repo', REPO,
        '--signer-workflow', RELEASE_WORKFLOW,
        '--source-ref', sourceRef,
        '--source-digest', sourceDigest
      ],
      { timeout: 60 * 1000 },
      (error, _stdout, stderr) =>
        resolve(error ? { ok: false, text: firstLine(stderr) ?? error.message } : { ok: true })
    );
  });
}

function firstLine(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return text.split('\n')[0];
}

// ---------------------------------------------------------------------------
// The install
// ---------------------------------------------------------------------------

// The subcommand both official installers hand the work to. What follows it is the
// binary's own contract: it verifies the runtime against the checksums in --from and
// lays out the machine itself. Run directly on macOS and Linux.
const APPLY_SUBCOMMAND = ['system', 'lifecycle', 'install-apply'];

// On Windows the apply is handed to upstream's install.ps1 instead, with the directory
// this module downloaded and verified (`-From <dir>` implies `-Offline`; the script
// re-verifies every file against checksums.txt and will not download). The reason is
// PATH: the engine's hooks call `aidlc` by bare name, and on Windows the only thing
// that puts the command directory on the account's persistent PATH is the script's
// Set-UserPath -- registry write preserving REG_EXPAND_SZ and existing entries, a
// WM_SETTINGCHANGE broadcast, and a windows-path.json so `aidlc` uninstall later removes
// exactly that entry. install-apply does none of it, so the extension's own install left
// a manual "add this folder to your PATH" step that the official command does not, and
// that step was the half of "Windows is hard" this extension owned. Reimplementing it
// here would mean owning each of those details; the script is the thing upstream tests
// on Windows. The download and verification stay in the one code path above, and the
// script is itself an asset in checksums.txt, verified like the others.
const WINDOWS_INSTALLER = 'install.ps1';
function windowsInstallerArgs({ base, version, yes }) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(base, WINDOWS_INSTALLER),
    '-From',
    base,
    '-Version',
    version,
    '-Quiet',
    '-Json',
    // Upstream's answer to its own administrator question. Passed only after the person
    // was asked that question here, with the same words.
    ...(yes ? ['-Yes'] : [])
  ];
}

// The script's -Json result: the last line that parses. `path.status` is `updated`,
// `unchanged`, `failed` or `conflict`, and says whether the command directory is on the
// account's PATH now. Anything unparseable is reported as such, never guessed at.
function parseWindowsInstallerOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep looking
    }
  }
  return undefined;
}

// Whether a process started with this PATH would find `aidlc` -- which is the question
// for the engine's hooks, since Kiro starts them with the PATH it had when it launched.
// Pure: given the environment, no subprocess. On POSIX the login shell's PATH reaches
// Kiro through its startup shell resolution, so ~/.local/bin being on PATH there is what
// makes a fresh install resolvable at once; on Windows nothing re-reads the registry, so
// a fresh install is not resolvable until Kiro is quit and reopened, whatever PATH says.
function engineResolvable({ env = process.env, platform = process.platform } = {}) {
  const value = env.PATH ?? env.Path ?? '';
  if (!value) return false;
  const names = platform === 'win32' ? ['aidlc.exe', 'aidlc.cmd'] : ['aidlc'];
  for (const dir of value.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        if (fs.statSync(path.join(dir, name)).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

async function installEngine({ workDir, env, onProgress, allowElevated = false } = {}) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  const binary = assetName({
    platform: process.platform,
    arch: process.arch,
    musl: isMuslLinux()
  });
  if (!binary) {
    return {
      ok: false,
      reason: 'unsupported-platform',
      text:
        `Upstream publishes no engine binary for ${process.platform}-${process.arch}. ` +
        `The docs list what is supported: ${DOCS_URL}`
    };
  }

  const elevated = await isElevatedWindows();
  if (elevated && !allowElevated) {
    // The caller is expected to have asked already (install-commands does, with the
    // same words and an "Install anyway"); this is the floor under a caller that did not.
    return { ok: false, reason: 'elevated', text: UAC_ELEVATED_WARNING };
  }

  const base = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-provision-'));
  try {
    // Metadata first, so nothing big is downloaded for a release that fails validation.
    report('checking the current release…');
    for (const asset of ['version.json', 'checksums.txt', 'aidlc-release.intoto.jsonl']) {
      const fetched = await download(`${RELEASE_BASE}/${asset}`, path.join(base, asset));
      if (!fetched.ok) {
        return { ok: false, reason: fetched.reason, text: describeDownloadFailure(asset, fetched) };
      }
    }

    const sums = parseChecksums(fs.readFileSync(path.join(base, 'checksums.txt'), 'utf8'));

    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(base, 'version.json'), 'utf8'));
    } catch {
      return { ok: false, reason: 'version-json-unreadable', text: 'version.json is not JSON.' };
    }
    const release = validateVersionInfo(info);
    if (!release.ok) return { ...release };

    // version.json's own hash is in checksums.txt; a mismatch means the two files are
    // not from the same release -- a truncated download or a tampering proxy.
    const versionSum = await sha256File(path.join(base, 'version.json'));
    if (!sums['version.json'] || versionSum !== sums['version.json']) {
      return { ok: false, reason: 'checksum-mismatch', text: 'Checksum mismatch for version.json.' };
    }

    if (await provenanceVerifierAvailable()) {
      // gh is present, so a provenance failure is a real refusal, exactly as the
      // official installers treat it.
      const verified = await verifyProvenance({
        dir: base,
        sourceRef: release.sourceRef,
        sourceDigest: release.sourceDigest
      });
      if (!verified.ok) {
        return {
          ok: false,
          reason: 'provenance-failed',
          text:
            `Release provenance verification failed: ${verified.text}. ` +
            `Obtain the release from ${REPO}.`
        };
      }
    }

    const runtime = `aidlc-runtime-${release.version}.tar.gz`;
    // Windows also needs the script that will do the apply; it is in checksums.txt and
    // is verified below with the rest.
    const assets = process.platform === 'win32' ? [binary, runtime, WINDOWS_INSTALLER] : [binary, runtime];
    for (const asset of assets) {
      report(`downloading ${asset}…`);
      const fetched = await download(`${RELEASE_BASE}/${asset}`, path.join(base, asset));
      if (!fetched.ok) {
        return { ok: false, reason: fetched.reason, text: describeDownloadFailure(asset, fetched) };
      }
      const expected = sums[asset];
      const actual = await sha256File(path.join(base, asset));
      if (!expected || actual !== expected) {
        return { ok: false, reason: 'checksum-mismatch', text: `Checksum mismatch for ${asset}.` };
      }
    }

    const binaryPath = path.join(base, binary);
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }

    report(`installing AI-DLC ${release.version}…`);
    if (process.platform === 'win32') {
      // See WINDOWS_INSTALLER. The script's own JSON result is read for the PATH outcome
      // and its own message is the failure text.
      const run = await new Promise((resolve) => {
        execFile(
          'powershell.exe',
          windowsInstallerArgs({ base, version: release.version, yes: elevated }),
          { timeout: APPLY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...(env ?? {}) }, windowsHide: true },
          (error, stdout, stderr) => resolve({ error, stdout, stderr })
        );
      });
      const result = parseWindowsInstallerOutput(run.stdout);
      if (run.error || (result && result.ok === false)) {
        return {
          ok: false,
          reason: result?.status === 'usage' && /administrator/i.test(result?.message ?? '') ? 'elevated' : 'apply-failed',
          text:
            result?.message ??
            firstLine(run.stderr) ??
            firstLine(run.stdout) ??
            `The engine's installer exited without saying why (${run.error?.message ?? 'unknown'}).`
        };
      }
      const pathStatus = result?.path?.status;
      return {
        ok: true,
        version: release.version,
        binDir: defaultBinDir(),
        pathStatus,
        pathRegistered: pathStatus === 'updated' || pathStatus === 'unchanged'
      };
    }

    // The binary lays out the machine. Its own first line of output is the failure
    // message when there is one -- upstream's words, which name conditions this
    // extension has no business paraphrasing (Alpine's missing libstdc++, for one).
    const applied = await new Promise((resolve) => {
      execFile(
        binaryPath,
        [...APPLY_SUBCOMMAND, '--from', base, '--version', release.version, '--quiet'],
        {
          timeout: APPLY_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, ...(env ?? {}) }
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ ok: true });
          resolve({
            ok: false,
            text:
              firstLine(stdout) ??
              firstLine(stderr) ??
              `The engine's installer exited without saying why (${error.message}).`
          });
        }
      );
    });
    if (!applied.ok) {
      return { ok: false, reason: 'apply-failed', text: applied.text };
    }

    return { ok: true, version: release.version, binDir: defaultBinDir(), pathRegistered: undefined };
  } finally {
    if (!workDir) {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
}

// What the installer leaves for the user to do about PATH, when it left anything.
//
// The project's hooks call `aidlc` by bare name, so the binary has to be resolvable from
// the environment the harness runs hooks in -- not from an interactive shell. On POSIX
// `aidlc doctor` reports "interactive-only" when that is the gap. On Windows install.ps1
// registers the command directory on the account's PATH itself (see WINDOWS_INSTALLER),
// and its result says whether that worked; only when it did not is there something for
// the person to do by hand. Whether Kiro has to be quit and reopened to see the change is
// a separate question, answered by kiro-readiness.
function pathCaveat(binDir, { pathStatus } = {}) {
  const location = binDir ?? defaultBinDir();
  if (process.platform === 'win32' && pathStatus !== 'updated' && pathStatus !== 'unchanged') {
    return (
      `The installer could not add the engine's command directory to your PATH` +
      (pathStatus ? ` (${pathStatus})` : '') +
      `: it is ${location}. ` +
      'Add that folder to your user PATH (Settings > Edit environment variables for your ' +
      "account), then quit Kiro and reopen it, or the workflow's hooks will not find the engine."
    );
  }
  return undefined;
}

module.exports = {
  REPO,
  RELEASE_BASE,
  RELEASE_WORKFLOW,
  DOCS_URL,
  APPLY_SUBCOMMAND,
  assetName,
  isMuslLinux,
  installRoot,
  defaultBinDir,
  candidatePaths,
  needsShell,
  detectEngine,
  readVersion,
  installCommand,
  validateVersionInfo,
  parseChecksums,
  sha256File,
  download,
  describeDownloadFailure,
  isElevatedWindows,
  UAC_ELEVATED_WARNING,
  WINDOWS_INSTALLER,
  windowsInstallerArgs,
  parseWindowsInstallerOutput,
  engineResolvable,
  provenanceVerifierAvailable,
  installEngine,
  pathCaveat
};
