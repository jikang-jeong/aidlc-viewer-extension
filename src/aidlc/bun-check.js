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
// it has to match what bun's own site publishes rather than something
// equivalent-but-different that would not match a search result.
//
// Note the domains differ between the two, and that is not a mistake: bun's
// install page publishes the shell script under bun.com and the PowerShell script
// under bun.sh. Copied as published.
//
// Windows never involves curl. `irm` is Invoke-RestMethod, built into PowerShell
// since 3.0 and present on every supported Windows, so "what if there is no curl"
// is not a case that arises there.
function installCommand() {
  if (process.platform === 'win32') return 'powershell -c "irm bun.sh/install.ps1|iex"';
  return 'curl -fsSL https://bun.com/install | bash';
}

// What the one-line install needs that the machine may not have. Named because a
// failure here reads as "bun is broken" rather than as a missing package.
function prerequisite() {
  if (process.platform === 'win32') return 'Requires Windows 10 version 1809 or later.';
  if (process.platform === 'linux') {
    return 'Needs the unzip package (sudo apt install unzip), or the installer fails partway.';
  }
  return undefined; // macOS ships everything the script needs.
}

// Other ways in, for when the one-liner cannot run: a policy that blocks piping a
// downloaded script into a shell, a machine without the prerequisite above, or no
// route to bun's domain. Offered rather than argued with -- a person who cannot run
// the first command needs a second one, not an explanation of why the first is fine.
function alternatives() {
  if (process.platform === 'win32') {
    return ['npm install -g bun', 'scoop install bun'];
  }
  if (process.platform === 'darwin') {
    return ['npm install -g bun', 'brew install oven-sh/bun/bun'];
  }
  return ['npm install -g bun'];
}

// Where to read the rest. The extension does not attempt to reproduce bun's
// installation matrix -- musl builds, CPU requirements, Docker images, older
// versions -- so the page that does is one click away.
const DOCS_URL = 'https://bun.com/docs/installation';

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
    prerequisite: prerequisite(),
    alternatives: alternatives(),
    docsUrl: DOCS_URL,
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

module.exports = {
  candidatePaths,
  installCommand,
  prerequisite,
  alternatives,
  detectBun,
  DOCS_URL
};
