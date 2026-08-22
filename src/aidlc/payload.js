'use strict';

// Fetches the upstream v2 payload into a temporary directory.
//
// The payload is one subdirectory of a large repository: dist/kiro-ide is 293
// files and 4.5MB, while the repository is 3,177 files. GitHub serves a tarball
// per commit, so the whole archive is downloaded once (13MB, ~2s measured) and
// only that subtree is extracted (~0.24s). The alternative -- a request per file
// through the contents API -- would be 293 round trips against a rate limit.
//
// The commit is pinned by the caller and never resolved from a branch name. v2 is
// GA but still moving, so a floating ref would mean two users installing on
// different days get engines that behave differently while both believe they
// installed "v2".
//
// Two things this deliberately does NOT do. It does not bundle the payload into
// the extension, because a snapshot of an actively changing engine goes stale
// between releases. And it adds no runtime dependency: extraction uses the `tar`
// binary that ships with macOS, Linux and Windows 10 1803 and later, so the
// extension keeps its zero-dependency footprint rather than taking on a tar
// implementation to save one subprocess.
//
// Pure module: never import `vscode`. Node built-ins and one subprocess only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

// Upstream coordinates. The repository is public and the path within it is part of
// the upstream layout rather than a guess: dist/<harness> is how upstream ships
// per-harness installs.
const REPO = 'awslabs/aidlc-workflows';
const PAYLOAD_PREFIX = 'dist';

// The commit this build installs.
//
// Pinned in source rather than resolved from the v2 branch at install time. v2 is
// GA but still moving, and a floating ref would mean two people installing on
// different days get engines that behave differently while both believe they
// installed "v2" -- and neither could be told which one they have.
//
// This is the head of the v2 branch at the time this support was written and
// verified: every observation the v2 reader relies on (the stage graph's fields,
// the audit event shapes, bolt_dag, the per-unit recording differences between
// inline and subagent stages) was made against a project installed from exactly
// this commit. Moving it means re-verifying those, so it is a deliberate edit
// paired with a run of the probe against a fresh sample, not a routine bump.
const PINNED_COMMIT = '4d0968fc';

// Only harnesses this extension has actually verified against a real run. A name
// not on this list is refused rather than attempted, because a wrong path yields
// an empty extraction that would look like a successful install of nothing.
const HARNESSES = { 'kiro-ide': 'kiro-ide', 'kiro-cli': 'kiro-cli' };

// A commit has to look like one. Rejecting anything else keeps a branch name, a
// tag, or a shell fragment out of a URL and out of an archive path.
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

// Ceilings, so a redirect loop or an unexpectedly huge archive fails with a
// reason instead of filling the disk or hanging a session.
const MAX_REDIRECTS = 5;
const MAX_BYTES = 80 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 120_000;

function tarballUrl(commit) {
  return `https://codeload.github.com/${REPO}/tar.gz/${commit}`;
}

// Download to a path, following redirects.
//
// Every failure resolves rather than throws, and carries a reason a person can
// act on: an install offer that says "GitHub returned 404 for that commit" is
// useful, while one that says "install failed" is not.
function download(url, destination, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve) => {
    const request = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, (response) => {
      const status = response.statusCode ?? 0;

      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          resolve({ ok: false, reason: 'too-many-redirects' });
          return;
        }
        const next = new URL(response.headers.location, url).toString();
        download(next, destination, redirectsLeft - 1).then(resolve);
        return;
      }

      if (status !== 200) {
        response.resume();
        resolve({
          ok: false,
          reason: 'http-status',
          status,
          // 404 on a well-formed commit means the commit is not in this
          // repository, which is a different problem from being offline.
          text:
            status === 404
              ? 'GitHub has no archive for that commit in this repository.'
              : `GitHub returned HTTP ${status}.`
        });
        return;
      }

      let written = 0;
      let aborted = false;
      const file = fs.createWriteStream(destination);
      response.on('data', (chunk) => {
        written += chunk.length;
        if (written > MAX_BYTES && !aborted) {
          aborted = true;
          response.destroy();
          file.destroy();
          resolve({ ok: false, reason: 'too-large', bytes: written });
        }
      });
      response.pipe(file);
      file.on('finish', () => {
        if (!aborted) resolve({ ok: true, bytes: written });
      });
      file.on('error', (error) => {
        if (!aborted) resolve({ ok: false, reason: 'write-failed', text: String(error.message) });
      });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    // Covers offline, DNS failure and a proxy refusing the connection, all of
    // which a user can act on once told which one it was.
    request.on('error', (error) => {
      resolve({ ok: false, reason: 'network', text: String(error.message) });
    });
  });
}

// Extract one subtree of the archive.
//
// GitHub archives carry a single top-level directory named `<repo>-<commit>`, so
// the wanted subtree sits at `*/dist/<harness>/`. `--strip-components=3` removes
// that wrapper plus `dist/<harness>`, leaving the payload at the destination root.
//
// bsdtar (macOS, Windows) and GNU tar (Linux) differ on wildcard flags, so the
// pattern is passed in a form both accept and a failure reports tar's own stderr
// rather than a guess about which implementation was in play.
function extract(archivePath, destination, harness) {
  const subdir = HARNESSES[harness];
  return new Promise((resolve) => {
    execFile(
      'tar',
      [
        '-xzf', archivePath,
        '-C', destination,
        '--strip-components=3',
        `*/${PAYLOAD_PREFIX}/${subdir}/*`
      ],
      { timeout: EXTRACT_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            reason: 'extract-failed',
            // Named separately because a missing tar is a machine problem the user
            // can fix, while a tar that ran and complained is a payload problem.
            text: error.code === 'ENOENT'
              ? 'No `tar` command found on PATH.'
              : String(stderr || error.message).trim()
          });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

function topLevelEntries(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// Fetch a payload and report what arrived.
//
// The caller gets a directory and its top-level listing, which is exactly what
// planInstall consumes. An extraction that produced nothing is reported as such
// rather than passed on: a plan built from an empty listing would install nothing
// and call it done.
async function fetchPayload({ commit, harness, workDir }) {
  // Defaults to the pinned commit, so a caller that does not care gets the one
  // this build was verified against rather than whatever is current.
  const target = commit ?? PINNED_COMMIT;
  if (!HARNESSES[harness]) {
    return { ok: false, reason: 'unknown-harness', text: `No payload path known for "${harness}".` };
  }
  if (typeof target !== 'string' || !COMMIT_PATTERN.test(target)) {
    return {
      ok: false,
      reason: 'bad-commit',
      text: 'A full or short commit sha is required; a branch or tag would float.'
    };
  }

  const base = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-payload-'));
  const archive = path.join(base, 'upstream.tar.gz');
  const out = path.join(base, 'payload');
  fs.mkdirSync(out, { recursive: true });

  const downloaded = await download(tarballUrl(target), archive);
  if (!downloaded.ok) return { ...downloaded, workDir: base };

  const extracted = await extract(archive, out, harness);
  if (!extracted.ok) return { ...extracted, workDir: base };

  const entries = topLevelEntries(out);
  if (entries.length === 0) {
    return {
      ok: false,
      reason: 'empty-payload',
      text: `The archive contained no ${PAYLOAD_PREFIX}/${HARNESSES[harness]} directory at ${target}.`,
      workDir: base
    };
  }

  return {
    ok: true,
    workDir: base,
    payloadDir: out,
    entries,
    bytes: downloaded.bytes,
    commit: target,
    harness
  };
}

module.exports = {
  REPO,
  PAYLOAD_PREFIX,
  PINNED_COMMIT,
  HARNESSES,
  COMMIT_PATTERN,
  MAX_BYTES,
  tarballUrl,
  download,
  extract,
  topLevelEntries,
  fetchPayload
};
