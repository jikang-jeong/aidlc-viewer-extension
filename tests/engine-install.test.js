'use strict';

// Pins how v2's engine is installed, and what a project gets afterwards.
//
// Upstream restructured on 2026-09-08 in a way that changed the KIND of install, not
// just its location. Copying `dist/<harness>/` into a project used to produce a working
// project; now the engine is a compiled binary on the machine and a project's hooks call
// it by name. Copying files therefore produces a project whose gates never fire, which
// is exactly what the old bun gate existed to prevent.
//
// These tests exist because that failure is SILENT. Nothing errors: the files are all
// there, the reader reports 33 stages, and the workflow simply never advances. So the
// facts that distinguish a working install from a convincing-looking one are asserted
// here rather than left to be noticed in the field.
//
// Nothing here reaches the network or installs anything. The end-to-end install was
// verified by hand against release v2.8.0 in an isolated root; what is pinned here is
// the reasoning that verification established.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const engineInstall = require('../src/aidlc/engine-install');
const engineConfig = require('../src/aidlc/engine-config');
const engineManifest = require('../src/aidlc/engine-manifest');

// ---------------------------------------------------------------------------
// What is installed, and from where
// ---------------------------------------------------------------------------


test('the published install command is offered, not an equivalent of our own', () => {
  // A person who cannot let the extension run the install has to run something, and it
  // has to be the command upstream documents -- otherwise it does not match their docs
  // or any search result, and there is no way to tell a typo from a real difference.
  const command = engineInstall.installCommand();
  assert.match(command, /awslabs\/aidlc-workflows\/releases\/latest\/download\/install\.(sh|ps1)/);
  // And it is a single command, not a script the user has to assemble.
  assert.equal(command.split('\n').length, 1);
});

test('the engine is looked for where upstream puts it, not only on PATH', () => {
  // A hook and an interactive shell see different PATHs. That difference is the whole
  // reason `aidlc doctor` distinguishes "absent" from "interactive-only", and a probe
  // that only asked the shell would call a working install broken -- the same mistake
  // the bun check was written to avoid.
  const checked = engineInstall.candidatePaths();
  assert.ok(checked.length >= 2);
  assert.ok(
    checked.some((candidate) => candidate.endsWith('active-executable')),
    'must consult the engine\'s own active-version pointer'
  );
  for (const candidate of checked) {
    assert.ok(path.isAbsolute(candidate), `not absolute: ${candidate}`);
  }
});

test('a missing engine is reported with a way forward, never as a thrown error', () => {
  // Called on the UI path. An exception here would surface as an extension error rather
  // than as the one actionable sentence the user needs.
  const result = engineInstall.detectEngine();
  assert.equal(typeof result.found, 'boolean');
  if (!result.found) {
    assert.ok(result.installCommand);
    assert.ok(result.docsUrl);
  }
});

test('detection never throws on a broken or hostile pointer file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  try {
    for (const contents of ['', '   ', '/nonexistent/aidlc', '\0', 'a'.repeat(10000)]) {
      fs.mkdirSync(path.join(root, 'aidlc'), { recursive: true });
      fs.writeFileSync(path.join(root, 'aidlc', 'active-executable'), contents);
      const previous = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = root;
      try {
        assert.doesNotThrow(() => engineInstall.detectEngine());
      } finally {
        if (previous === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previous;
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});




// ---------------------------------------------------------------------------
// What the project gets
// ---------------------------------------------------------------------------

test('the harness is always passed explicitly, because the release installs all seven', () => {
  // A bare `aidlc config` refuses with "multiple harnesses are installed" once the
  // release is on the machine, so omitting it would fail on every real install while
  // passing against any fixture that only had one.
  assert.deepEqual(engineConfig.HARNESS_IDS, { 'kiro-ide': 'kiro-ide', 'kiro-cli': 'kiro' });
});

test("the extension's harness ids are translated, not renamed", () => {
  // Receipts already on disk record `kiro-cli`. Renaming the key would make them
  // unreadable; only the engine-side value moved when upstream renamed the directory.
  assert.ok('kiro-cli' in engineConfig.HARNESS_IDS);
  assert.equal(engineConfig.HARNESS_IDS['kiro-cli'], 'kiro');
});

test('an unknown harness is refused before the engine is invoked', async () => {
  for (const harness of ['claude', 'codex', '', undefined, '../..']) {
    const result = await engineConfig.configureProject({ binary: '/bin/false', root: '/tmp', harness });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown-harness');
  }
});

test("the engine's plan counts are read for display, and nothing branches on them", () => {
  const plan = engineConfig.parsePlan(
    'config plan for /x: create=323 update=0 merge=0 preserve=0 remove=0 conflict=0'
  );
  assert.deepEqual(plan, { create: 323, update: 0, merge: 0, preserve: 0, remove: 0, conflict: 0 });
  // A changed format degrades to "no plan shown" rather than to a wrong claim about what
  // is about to happen.
  for (const text of ['', 'something else', 'create=1', undefined]) {
    assert.equal(engineConfig.parsePlan(text), undefined, String(text));
  }
});

test("what the engine says still needs doing is carried through verbatim", () => {
  // The common one is that the binary resolves only on an interactive PATH, which decides
  // whether the workflow's hooks can find it at all. Dropping it would leave a project
  // that looks configured and does not run.
  const outstanding = engineConfig.parseOutstanding(
    [
      'configured /x for Kiro IDE 2.8.0',
      'Outstanding actions:',
      '  runtime/runtime-aidlc-missing: aidlc is absent from the non-interactive hook PATH',
      '  another: thing',
      '',
      'unrelated trailing line'
    ].join('\n')
  );
  assert.equal(outstanding.length, 2);
  assert.match(outstanding[0], /non-interactive hook PATH/);
});

test('no outstanding section means an empty list, not a crash', () => {
  for (const text of ['configured /x', '', undefined]) {
    assert.deepEqual(engineConfig.parseOutstanding(text), []);
  }
});

// ---------------------------------------------------------------------------
// Removal, from the engine's own inventory
// ---------------------------------------------------------------------------

test("the engine's manifest is read as the record of what removal may take back", () => {
  // Without this, removal would refuse on every project the extension had just set up:
  // the engine performs the install and writes its own inventory, not our receipt.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'man-'));
  try {
    const dir = path.join(root, '.kiro', 'tools', 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'aidlc-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        frameworkVersion: '2.8.0',
        distribution: 'kiro-ide',
        harnessDir: '.kiro',
        files: { '.kiro/agents/a.md': 'sha256:aa', '.kiro/tools/aidlc.ts': 'sha256:bb' },
        rootContributions: {
          '.gitignore': { policy: 'managed-block', marker: 'gitignore' },
          'AGENTS.md': { policy: 'managed-block', marker: 'agents' },
          '.vscode/settings.json': { policy: 'json-array' }
        }
      })
    );

    const manifest = engineManifest.readEngineManifest(root);
    assert.equal(manifest.ok, true);
    assert.equal(manifest.version, '2.8.0');
    assert.equal(manifest.files.length, 2);

    const receipt = engineManifest.receiptFromManifest(manifest, { harness: 'kiro-ide' });
    assert.equal(receipt.files.length, 2);
    // Only the marker-merged files are taken back as sections. A file the engine merges
    // by another policy is not a file we know how to un-merge, so it is left alone
    // rather than deleted.
    assert.deepEqual(receipt.appended, ['.gitignore', 'AGENTS.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest-derived removal never claims the seed directory', () => {
  // `aidlc/spaces/default/memory/project.md` is where the workflow appends every learned
  // correction, and no backup covers it. The engine does not claim those files; a
  // removal derived from its manifest must not invent the claim.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'man2-'));
  try {
    const dir = path.join(root, '.kiro', 'tools', 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'aidlc-manifest.json'),
      JSON.stringify({
        files: { '.kiro/a': 'sha256:aa', 'aidlc/spaces/default/memory/project.md': 'sha256:bb' },
        rootContributions: {}
      })
    );
    const receipt = engineManifest.receiptFromManifest(engineManifest.readEngineManifest(root));
    assert.deepEqual(receipt.seeded, []);
    // The manifest is reported as read; protecting `aidlc/` is the removal planner's job
    // and is asserted there. What matters here is that nothing is silently dropped: the
    // planner must SEE the entry in order to refuse it.
    assert.ok(receipt.files.includes('aidlc/spaces/default/memory/project.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt manifest is distinguished from an absent one', () => {
  // "The engine installed this and its own record is corrupt" needs a different answer
  // from "never installed" -- treating the first as the second would offer to remove
  // nothing from a project full of engine files.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'man3-'));
  try {
    assert.equal(engineManifest.readEngineManifest(root), undefined);

    const dir = path.join(root, '.kiro', 'tools', 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'aidlc-manifest.json'), '{not json');
    assert.equal(engineManifest.readEngineManifest(root).reason, 'manifest-unreadable');

    fs.writeFileSync(path.join(dir, 'aidlc-manifest.json'), '[]');
    assert.equal(engineManifest.readEngineManifest(root).reason, 'manifest-unexpected-shape');

    // And neither yields a receipt, so nothing is ever deleted on the strength of one.
    for (const bad of ['{not json', '[]', '{"files":null}']) {
      fs.writeFileSync(path.join(dir, 'aidlc-manifest.json'), bad);
      const derived = engineManifest.receiptFromManifest(engineManifest.readEngineManifest(root));
      assert.equal(derived, undefined, bad);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v1 is untouched
// ---------------------------------------------------------------------------

test('nothing in the engine install path can run for a v1 project', () => {
  // The two generations share `.kiro/`, and a v2 install once deleted v1's rules while
  // promising not to. These modules are reachable only from the v2 branch of setup, and
  // none of them names a v1 path.
  for (const source of [
    fs.readFileSync(path.join(__dirname, '..', 'src', 'aidlc', 'engine-install.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'aidlc', 'engine-config.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'aidlc', 'engine-manifest.js'), 'utf8')
  ]) {
    assert.equal(/aws-aidlc-rule/.test(source), false);
    assert.equal(/aws-aidlc-rules/.test(source), false);
    // And none of them imports vscode, so none can be the thing that breaks the v1 view.
    assert.equal(/require\('vscode'\)/.test(source), false);
  }
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
//
// Verified by reading upstream's install.ps1 and the engine's own aidlc-install-paths.ts,
// not by running Windows. Each assertion below records a fact taken from one of those two
// sources, because every one of them was wrong in the first version of this module and
// none would have failed a test written on macOS by inspection alone.

test('a .cmd is run through a shell, and a .exe is not', () => {
  // The engine's commandPath() is `bin/aidlc.cmd` on Windows while the real binary is
  // `versions/<v>/aidlc.exe`. Node has refused to execFile a .cmd directly since its 2024
  // argument-injection fix, so the wrapper needs a shell and the binary must not get one.
  // Asserted as a property of the path rather than of the platform, which is what makes it
  // testable off Windows.
  const { needsShell } = engineInstall;
  if (process.platform === 'win32') {
    assert.equal(needsShell('C:\\x\\bin\\aidlc.cmd'), true);
    assert.equal(needsShell('C:\\x\\bin\\AIDLC.CMD'), true, 'must not be case-sensitive');
    assert.equal(needsShell('C:\\x\\aidlc.bat'), true);
    assert.equal(needsShell('C:\\x\\versions\\2.8.0\\aidlc.exe'), false);
  } else {
    // Off Windows nothing needs a shell, including a path that merely looks like one.
    assert.equal(needsShell('/x/aidlc.cmd'), false);
  }
  for (const value of [undefined, null, '', 42]) {
    assert.doesNotThrow(() => needsShell(value));
  }
});

test('both Windows executable names are looked for, not the POSIX habit', () => {
  // The first version of this module looked for `bin/aidlc.exe`, which upstream never
  // creates: the wrapper is `.cmd` and the `.exe` lives under versions/. Detection still
  // worked through the pointer file, so the bug was invisible until the pointer was
  // damaged -- exactly when the fallback is the only thing left.
  const candidates = engineInstall.candidatePaths();
  assert.ok(candidates[0].endsWith('active-executable'), 'the pointer must be tried first');
  if (process.platform === 'win32') {
    const names = candidates.map((candidate) => path.basename(candidate).toLowerCase());
    assert.ok(names.includes('aidlc.cmd'), `no .cmd among ${names.join(', ')}`);
  }
});





test('Windows is told its PATH change is not permanent, because nothing else will say so', () => {
  // install.sh can write a shell rc file with --profile. install.ps1 has no such flag: it
  // prepends to PATH for its own process and prints "For each new PowerShell session,
  // run: ...". Since the project's hooks call `aidlc` by bare name, a successful install
  // can otherwise leave a project that looks complete and cannot run.
  const caveat = engineInstall.pathCaveat('C:\\Users\\jane\\AppData\\Local\\aidlc\\bin');
  if (process.platform === 'win32') {
    assert.ok(caveat, 'Windows must be warned');
    assert.match(caveat, /PATH/);
    assert.match(caveat, /C:\\Users\\jane/, 'must name the folder to add');
  } else {
    assert.equal(caveat, undefined, 'other platforms must not get a Windows caveat');
  }
  assert.doesNotThrow(() => engineInstall.pathCaveat(undefined));
});

test('the install root follows the platform upstream documents', () => {
  // %LOCALAPPDATA%\aidlc on Windows, $XDG_DATA_HOME|~/.local/share/aidlc elsewhere --
  // read from the engine's aidlc-install-paths.ts rather than chosen. A root that
  // disagreed would report a working install as absent.
  const root = engineInstall.installRoot();
  assert.ok(path.isAbsolute(root));
  assert.equal(path.basename(root), 'aidlc');
});


test('a .cmd path with a space survives the shell it is forced through', async () => {
  // Under shell:true Node concatenates rather than quotes, and the wrapper lives beneath
  // %LOCALAPPDATA% -- a path that carries the user's name, which on Windows routinely has
  // a space ("C:\Users\Jane Doe\..."). Found by walking the forged-platform flow, where
  // the unquoted command visibly split at the space.
  //
  // Verified by principle on this host: an executable in a directory with a space fails
  // under shell:true unquoted and runs quoted. Here the quoting decision is pinned: the
  // command is quoted exactly when a shell is involved, and left alone otherwise, because
  // quotes handed to execFile WITHOUT a shell become part of the filename.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'aidlc', 'engine-config.js'),
    'utf8'
  );
  assert.match(source, /shell \? `"\$\{binary\}"` : binary/, 'the quoting must follow the shell decision');
});

// ---------------------------------------------------------------------------
// The single-path install: what the scripts did, done here, testable here
// ---------------------------------------------------------------------------
//
// The install no longer runs upstream's install.sh or install.ps1. Reading them showed
// the machine layout was never theirs: both end by handing the downloaded binary its own
// `system lifecycle install-apply`. Everything before that is orchestration, which is the
// part reimplemented here -- identical code on every platform, so verifying it on this
// machine verifies what a Windows machine will run, down to the asset name.

test('every platform maps to the asset upstream actually publishes', () => {
  // Names taken from the release's own checksums.txt, not invented. An unsupported
  // platform maps to nothing and is refused by name before any download.
  const { assetName } = engineInstall;
  assert.equal(assetName({ platform: 'darwin', arch: 'arm64' }), 'aidlc-darwin-arm64');
  assert.equal(assetName({ platform: 'darwin', arch: 'x64' }), 'aidlc-darwin-x64');
  assert.equal(assetName({ platform: 'linux', arch: 'x64' }), 'aidlc-linux-x64');
  assert.equal(assetName({ platform: 'linux', arch: 'x64', musl: true }), 'aidlc-linux-x64-musl');
  assert.equal(assetName({ platform: 'linux', arch: 'arm64', musl: true }), 'aidlc-linux-arm64-musl');
  assert.equal(assetName({ platform: 'win32', arch: 'x64' }), 'aidlc-windows-x64.exe');
  // musl must never leak outside Linux: there is no darwin-musl and inventing one would
  // turn a working Mac into a 404.
  assert.equal(assetName({ platform: 'darwin', arch: 'arm64', musl: true }), undefined);
  for (const unsupported of [
    { platform: 'win32', arch: 'arm64' },
    { platform: 'linux', arch: 'ia32' },
    {},
    undefined
  ]) {
    assert.equal(assetName(unsupported), undefined, JSON.stringify(unsupported));
  }
});

test('version.json is validated the way install.sh validates it', () => {
  // Each check catches a different way a release endpoint can lie. The shapes and the
  // rejected values mirror the sh script's own regexes.
  const { validateVersionInfo } = engineInstall;
  const good = {
    version: '2.8.0',
    sourceRef: 'refs/tags/v2.8.0',
    sourceDigest: '0d399dd828b59e84d90f7cc198c69fab9ad8f1a7'
  };
  assert.equal(validateVersionInfo(good).ok, true);
  assert.equal(validateVersionInfo(good).version, '2.8.0');

  // A version that is not a version.
  for (const version of ['2.8', '02.8.0', 'v2.8.0', '2.8.0-rc1', '', undefined]) {
    assert.equal(validateVersionInfo({ ...good, version }).ok, false, String(version));
  }
  // A tag that does not match the version it claims.
  assert.equal(validateVersionInfo({ ...good, sourceRef: 'refs/tags/v9.9.9' }).ok, false);
  assert.equal(validateVersionInfo({ ...good, sourceRef: 'refs/heads/main' }).ok, false);
  // A digest that is not a commit.
  for (const sourceDigest of ['abc', 'Z'.repeat(40), '', undefined]) {
    assert.equal(validateVersionInfo({ ...good, sourceDigest }).ok, false, String(sourceDigest));
  }
  // And garbage in, refusal out -- never a throw on the UI path.
  for (const junk of [undefined, null, [], 'text', 42]) {
    assert.equal(validateVersionInfo(junk).ok, false, String(junk));
  }
});

test("checksums.txt is parsed in upstream's exact format, and only that", () => {
  // `<64 hex><two spaces><name>`. One space is a different format and ignoring it is the
  // point: a checksum matched loosely is a checksum that can be spoofed by a lookalike
  // line.
  const { parseChecksums } = engineInstall;
  const hex = 'c2d21dcb5afb4fee673892029422a2537cc2fa010dfe9056d67b5d71c80a3232';
  const sums = parseChecksums(
    [
      `${hex}  version.json`,
      `${hex}  aidlc-windows-x64.exe`,
      `${hex} single-space.txt`,
      'not a checksum line',
      ''
    ].join('\n')
  );
  assert.equal(sums['version.json'], hex);
  assert.equal(sums['aidlc-windows-x64.exe'], hex);
  assert.equal(sums['single-space.txt'], undefined);
  assert.deepEqual(parseChecksums(''), {});
  assert.deepEqual(parseChecksums(undefined), {});
});

test('a corrupted download is refused by its hash, before anything runs', async () => {
  // The one security property this module now owns. Exercised with a real hash rather
  // than a mock: the file's actual sha256 must match the expectation, and one flipped
  // byte must not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sum-'));
  try {
    const file = path.join(dir, 'asset');
    fs.writeFileSync(file, 'the engine binary');
    const actual = await engineInstall.sha256File(file);
    assert.match(actual, /^[a-f0-9]{64}$/);
    fs.writeFileSync(file, 'the engine binarY');
    assert.notEqual(await engineInstall.sha256File(file), actual);
    // A missing file hashes to nothing rather than throwing.
    assert.equal(await engineInstall.sha256File(path.join(dir, 'absent')), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install-apply is what runs, because it is the contract both official installers use', () => {
  // The scripts differ in language, schema and flags, but both end at
  // `<binary> system lifecycle install-apply --from <dir> --version <v>`. Coupling to
  // that subcommand rather than to either script is the design decision this test pins.
  assert.deepEqual(engineInstall.APPLY_SUBCOMMAND, ['system', 'lifecycle', 'install-apply']);
});

test('a failed download names the asset and the condition, not just "failed"', () => {
  const { describeDownloadFailure } = engineInstall;
  assert.match(
    describeDownloadFailure('aidlc-windows-x64.exe', { reason: 'http-status', status: 404 }),
    /aidlc-windows-x64\.exe/
  );
  assert.match(
    describeDownloadFailure('version.json', { reason: 'http-status', status: 404 }),
    /publishes/i
  );
  assert.match(describeDownloadFailure('x', { reason: 'timeout' }), /Timed out/);
  assert.ok(describeDownloadFailure('x', { reason: 'request-failed' }));
});

test('the elevation guard cannot refuse anyone off Windows', async () => {
  // install.ps1 refuses an Administrator install and this module keeps that guard. But
  // `net session` exists only on Windows, so everywhere else the probe must resolve
  // false immediately -- a thrown error or a hang here would block every install.
  assert.equal(await engineInstall.isElevatedWindows(), false);
});

test('musl detection is a Linux question, answered no everywhere else', () => {
  if (process.platform !== 'linux') {
    assert.equal(engineInstall.isMuslLinux(), false);
  } else {
    assert.equal(typeof engineInstall.isMuslLinux(), 'boolean');
  }
});
