'use strict';

// What the extension tells a machine without bun.
//
// The subject is a report, not an installer: nothing here may run a command, and
// the commands reported have to be the ones bun's own site publishes, because a
// user who searches the string needs to land on that page rather than on nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = require.resolve('../src/aidlc/bun-check');

// The module reads process.platform at call time, so each platform is exercised by
// swapping it and reloading. Restored afterwards regardless of outcome.
function onPlatform(platform, fn) {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  delete require.cache[MODULE];
  try {
    return fn(require(MODULE));
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
    delete require.cache[MODULE];
  }
}

const PLATFORMS = ['darwin', 'linux', 'win32'];

// ---------------------------------------------------------------------------
// It never installs
// ---------------------------------------------------------------------------

test('the module never executes anything', () => {
  // The whole point of reporting rather than installing. A require of
  // child_process here would be the first step toward piping a downloaded script
  // into a shell on the user's behalf.
  const source = fs.readFileSync(MODULE, 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const forbidden of ['child_process', 'execSync', 'execFile', 'spawn']) {
    assert.ok(!code.includes(forbidden), `bun-check must not reach for ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// The commands are the published ones
// ---------------------------------------------------------------------------

test('Windows is told to use PowerShell, and is never told to use curl', () => {
  // Asked directly: what if Windows has no curl? It is not a case that arises,
  // because curl is never offered there. `irm` is Invoke-RestMethod, built into
  // PowerShell since 3.0.
  onPlatform('win32', ({ installCommand }) => {
    const command = installCommand();
    assert.ok(command.startsWith('powershell'), command);
    assert.ok(command.includes('irm'), command);
    assert.ok(!command.includes('curl'), 'Windows must not be told to use curl');
  });
});

test('macOS and Linux get the shell installer', () => {
  for (const platform of ['darwin', 'linux']) {
    onPlatform(platform, ({ installCommand }) => {
      const command = installCommand();
      assert.ok(command.startsWith('curl '), command);
      assert.ok(command.includes('| bash'), command);
    });
  }
});

test('every platform reports a command, and none is empty', () => {
  for (const platform of PLATFORMS) {
    onPlatform(platform, ({ installCommand }) => {
      assert.ok(installCommand().trim().length > 10, platform);
    });
  }
});

// ---------------------------------------------------------------------------
// What the one-liner needs, and what to do when it cannot run
// ---------------------------------------------------------------------------

test('Linux is told it needs unzip', () => {
  // bun's own docs call this out, and without it the installer fails partway --
  // which reads as "bun is broken" rather than as a missing package.
  onPlatform('linux', ({ prerequisite }) => {
    assert.match(prerequisite(), /unzip/);
  });
});

test('Windows is told which version it needs', () => {
  onPlatform('win32', ({ prerequisite }) => {
    assert.match(prerequisite(), /Windows 10/);
  });
});

test('every platform offers a way in that is not the one-liner', () => {
  // For a policy that blocks piping a downloaded script into a shell, a machine
  // missing the prerequisite, or no route to bun's domain.
  for (const platform of PLATFORMS) {
    onPlatform(platform, ({ alternatives, installCommand }) => {
      const list = alternatives();
      assert.ok(list.length >= 1, platform);
      for (const alternative of list) {
        assert.ok(alternative.trim().length > 0, platform);
        assert.notEqual(alternative, installCommand(), 'an alternative must differ');
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test('a machine with no bun reports not found, with everything needed to fix it', () => {
  const { detectBun } = require(MODULE);
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bunless-'));
  const realHomedir = os.homedir;
  const realAccess = fs.accessSync;
  os.homedir = () => emptyHome;
  // The system-wide locations are real paths on the machine running the test, so
  // the probe is refused for anything ending in the binary's name.
  fs.accessSync = (candidate, mode) => {
    if (/[/\\]bun(\.exe)?$/.test(String(candidate))) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return realAccess(candidate, mode);
  };
  try {
    const bun = detectBun();
    assert.equal(bun.found, false);
    assert.ok(bun.checked.length >= 2, 'reports where it looked');
    assert.ok(bun.installCommand);
    assert.ok(bun.pathNote);
    assert.ok(bun.docsUrl.startsWith('https://'));
    assert.ok(Array.isArray(bun.alternatives));
    assert.equal('path' in bun, false, 'no path when not found');
  } finally {
    os.homedir = realHomedir;
    fs.accessSync = realAccess;
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('a found bun reports where, and nothing about installing', () => {
  const { detectBun } = require(MODULE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-'));
  const binary = path.join(home, '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\n');
  fs.chmodSync(binary, 0o755);
  const realHomedir = os.homedir;
  os.homedir = () => home;
  try {
    const bun = detectBun();
    assert.equal(bun.found, true);
    assert.equal(bun.path, binary);
    // Nothing to advise when there is nothing to fix.
    assert.equal(bun.installCommand, undefined);
    assert.equal(bun.alternatives, undefined);
  } finally {
    os.homedir = realHomedir;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detection does not consult PATH', () => {
  // Deliberate. On a real machine bun was at ~/.bun/bin/bun and a non-interactive
  // shell could not find it, because the installer writes PATH into ~/.zshrc while
  // such a shell reads ~/.zshenv -- and yet the hooks ran fine. A PATH probe would
  // have told that user to install something they already had.
  const source = fs.readFileSync(MODULE, 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!code.includes('process.env.PATH'), 'must not read PATH');
  assert.ok(!code.includes('command -v'), 'must not shell out to find bun');
});

test('no input makes detection throw', () => {
  const { detectBun, candidatePaths } = require(MODULE);
  for (const platform of PLATFORMS) {
    onPlatform(platform, (mod) => {
      assert.doesNotThrow(() => mod.detectBun());
      assert.doesNotThrow(() => mod.candidatePaths());
    });
  }
  assert.doesNotThrow(() => detectBun());
  assert.doesNotThrow(() => candidatePaths());
});
