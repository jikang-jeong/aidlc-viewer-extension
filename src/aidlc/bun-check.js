'use strict';

// Whether bun is present, and where.
//
// v2's engine is bun/TypeScript: its hooks and tools are invoked as `bun <file>`
// at hundreds of call sites, so an install without bun produces a project whose
// every gate silently fails to fire.
//
// The detection deliberately does NOT rely on `command -v bun`. On a real machine
// bun was installed at ~/.bun/bin/bun and `zsh -c 'command -v bun'` found nothing,
// because the installer writes PATH into ~/.zshrc while a non-interactive shell
// reads ~/.zshenv -- and yet Kiro ran the hooks perfectly, resolving bun by some
// other route. A PATH probe would therefore have told that user to install
// something they already had. Checking the install location answers the question
// the user actually has.
//
// This never installs anything. It reports, and the caller shows the official
// command for the platform so the user runs it themselves.
//
// Pure module: never import `vscode`.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Where each platform's official installer puts the binary. More than one entry
// per platform because a user may have used a package manager instead.
function candidatePaths() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(home, '.bun', 'bin', 'bun.exe'),
      path.join(local, 'Microsoft', 'WindowsApps', 'bun.exe')
    ];
  }
  return [
    path.join(home, '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    '/usr/bin/bun'
  ];
}

// The command each platform's documentation gives. Shown for the user to run, so
// it has to match what upstream and bun's own site publish rather than something
// equivalent-but-different that would not match a search result.
function installCommand() {
  if (process.platform === 'win32') return 'powershell -c "irm bun.sh/install.ps1 | iex"';
  return 'curl -fsSL https://bun.sh/install | bash';
}

function detectBun() {
  const checked = candidatePaths();
  for (const candidate of checked) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { found: true, path: candidate, checked };
    } catch {
      // Not here, or not executable. Try the next location.
    }
  }
  return {
    found: false,
    checked,
    installCommand: installCommand(),
    // The trap worth naming, because it is what makes a present bun look absent
    // to anything that asks the shell.
    pathNote:
      process.platform === 'win32'
        ? 'Open a new terminal after installing so the updated PATH is picked up.'
        : 'The installer adds bun to ~/.zshrc or ~/.bashrc, which a non-interactive ' +
          'shell does not read. If a tool still cannot find bun after installing, ' +
          'add the same line to ~/.zshenv.'
  };
}

module.exports = { candidatePaths, installCommand, detectBun };
