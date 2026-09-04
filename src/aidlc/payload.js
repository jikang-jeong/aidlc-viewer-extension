'use strict';

// Fetches the upstream v2 payload into a temporary directory.
//
// The payload is one subdirectory of a large repository: dist/kiro-ide is 293
// files and 4.5MB, while the repository is 3,177 files. GitHub serves a tarball
// per commit, so the whole archive is downloaded once (13MB, ~2s measured) and
// only that subtree is extracted (~0.24s). The alternative -- a request per file
// through the contents API -- would be 293 round trips against a rate limit.
//
// The commit is resolved from a branch at install time, and reported.
//
// This tracks upstream rather than pinning, so a person installing today gets the
// engine as it is today. The cost is real and is the reason this is not silent:
// two people installing on different days can get engines that behave
// differently. So the sha the archive actually carried is read back out of it and
// written into the install receipt, which means a project can always answer which
// engine it has even though nothing chose that engine in advance.
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

// The branch this build installs from.
//
// Upstream renamed `v2` to `main` on 2026-09-04: the engine that was on a side
// branch is now the repository's default. GitHub keeps a redirect for the old
// branch name in its API, but `codeload.github.com/.../tar.gz/v2` returns 404, and
// the API's commits endpoint answers 422 rather than redirecting — so every install
// failed with "GitHub has no archive for that commit", which named the wrong thing.
//
// Following the branch rather than pinning still holds: an install gets the engine
// as it is today, and the sha it resolved to is recorded in the receipt so a project
// can always say which engine it has. The reader survives upstream moving because
// nothing here enumerates stage slugs, phase names, sensor ids or event names, and
// anything unrecognised is reported rather than guessed at.
const UPSTREAM_REF = 'main';

// A ref goes into a URL and into an archive path, so it is constrained to what a
// git ref can legitimately be. This keeps a path traversal, a flag-looking string
// and a shell fragment out of both.
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

// Harnesses this extension installs, mapped to their directory under `dist/`.
//
// A name not on this list is refused rather than attempted, because a wrong path
// yields an empty extraction that would look like a successful install of nothing.
//
// The CLI's directory was renamed `kiro-cli` to `kiro` when the engine moved to
// main, so the old mapping produced exactly that empty extraction. The key is left
// as `kiro-cli` because it is written into install receipts that already exist on
// disk, and changing it would make those unreadable; only the path it points at
// moved.
//
// Upstream now ships five more harnesses (claude, codex, copilot, cursor,
// opencode). They are deliberately absent: each writes a different layout, and this
// extension only offers what it has verified against a real run. Their existence
// does mean the documented claim that v2 targets Kiro alone is no longer true of
// upstream, which is a documentation matter rather than a code one.
const HARNESSES = { 'kiro-ide': 'kiro-ide', 'kiro-cli': 'kiro' };

// A commit has to look like one. Used to check the sha read back out of the
// archive, and to accept an explicit commit from a caller that wants a fixed one.
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

// Which commit a ref points at right now.
//
// Needed because GitHub does NOT put the sha in the archive when the download is
// by branch name: asking for `main` yields a root directory named
// `aidlc-workflows-main`, so the archive cannot say which engine it is. Asking the API
// first, then downloading that exact sha, makes the install accountable and also
// removes the window where upstream could push between learning the sha and
// fetching the code.
//
// Redirects are followed, which is not a nicety. When upstream renamed `v2` to
// `main` the API answered the old name with a redirect while codeload 404'd the
// tarball outright — so a build that followed the redirect here would have resolved
// a sha and installed correctly, and this one did not. A rename should cost nothing.
//
// `Accept: application/vnd.github.sha` returns the sha as plain text rather than a
// commit object, so there is no JSON to parse and nothing large to buffer.
//
// Every failure resolves to undefined rather than throwing. This request is a
// nicety: unauthenticated API calls are rate limited, a proxy may allow codeload
// while blocking api.github.com, and none of that is a reason to refuse an
// install. The caller falls back to downloading the ref directly.
function resolveRefCommit(ref, redirectsLeft = MAX_REDIRECTS) {
  const url = `https://api.github.com/repos/${REPO}/commits/${ref}`;
  return resolveShaFrom(url, redirectsLeft);
}

function resolveShaFrom(url, redirectsLeft) {
  return new Promise((resolve) => {
    const request = https.get(
      url,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/vnd.github.sha',
          // GitHub rejects API requests without one.
          'User-Agent': 'aidlc-viewer'
        }
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            resolve(undefined);
            return;
          }
          const next = new URL(response.headers.location, url).toString();
          resolveShaFrom(next, redirectsLeft - 1).then(resolve);
          return;
        }
        if (status !== 200) {
          response.resume();
          resolve(undefined);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          // A sha is 40 characters. Anything longer is not the answer, and is not
          // worth accumulating.
          if (body.length > 200) {
            response.destroy();
            resolve(undefined);
          }
        });
        response.on('end', () => {
          const sha = body.trim().toLowerCase();
          resolve(COMMIT_PATTERN.test(sha) ? sha : undefined);
        });
      }
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(undefined);
    });
    request.on('error', () => resolve(undefined));
  });
}

// Which commit the archive carried, when it can say.
//
// GitHub names the top-level directory `<repo>-<sha>` for a download by sha, so
// this confirms what arrived without a second network call. For a download by
// branch the directory is named after the ref instead, and this returns undefined.
function resolveArchiveCommit(archivePath) {
  return new Promise((resolve) => {
    execFile(
      'tar',
      ['-tzf', archivePath],
      { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const first = String(stdout).split('\n', 1)[0] ?? '';
        const root = first.split('/', 1)[0] ?? '';
        // Take the trailing segment rather than assuming the repository name, so a
        // rename upstream does not break this.
        const sha = root.slice(root.lastIndexOf('-') + 1).toLowerCase();
        resolve(COMMIT_PATTERN.test(sha) ? sha : undefined);
      }
    );
  });
}

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
          // A 404 on a well-formed request means the thing asked for is not in this
          // repository, which is a different problem from being offline. The wording
          // is left to the caller, which knows whether it asked for a branch or a
          // commit: this said "no archive for that commit" when upstream renamed a
          // branch, and sent the reader looking for a commit problem that did not
          // exist.
          text: status === 404 ? undefined : `GitHub returned HTTP ${status}.`
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

// How a failed fetch reads to a person.
//
// Separated from download() because only the caller knows whether it asked for a
// branch or for a commit, and separated from fetchPayload so it can be checked
// without a network. A 404 said "no archive for that commit" when upstream renamed a
// branch, which sent the reader looking for a commit problem that did not exist.
function describeFetchFailure(failure, { target, pinned }) {
  if (failure.reason === 'http-status' && failure.status === 404) {
    return pinned
      ? `GitHub has no archive for commit ${target} in ${REPO}.`
      : `GitHub has no archive for the branch "${target}" in ${REPO}. It may have been ` +
        'renamed or removed upstream.';
  }
  return failure.text;
}

// Fetch a payload and report what arrived.
//
// The caller gets a directory and its top-level listing, which is exactly what
// planInstall consumes. An extraction that produced nothing is reported as such
// rather than passed on: a plan built from an empty listing would install nothing
// and call it done.
//
// `ref` selects what to download and defaults to the v2 branch, so a caller that
// does not care gets the current engine. `commit` still works and takes
// precedence, which keeps a reproducible install available for a bug report or a
// bisect without a second code path.
async function fetchPayload({ ref, commit, harness, workDir }) {
  if (!HARNESSES[harness]) {
    return { ok: false, reason: 'unknown-harness', text: `No payload path known for "${harness}".` };
  }

  let target;
  let requestedRef;
  let pinned = false;
  if (commit !== undefined) {
    if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
      return {
        ok: false,
        reason: 'bad-commit',
        text: 'A full or short commit sha is required when a commit is given.'
      };
    }
    target = commit;
    pinned = true;
  } else {
    requestedRef = ref ?? UPSTREAM_REF;
    if (typeof requestedRef !== 'string' || !REF_PATTERN.test(requestedRef)) {
      return {
        ok: false,
        reason: 'bad-ref',
        text: 'A branch or tag name is required, and this one is not usable in a URL.'
      };
    }
    // Resolve the ref to a sha and download that, so the install can name the
    // engine it got. When resolution is unavailable the ref is downloaded directly
    // rather than the install being refused.
    target = (await resolveRefCommit(requestedRef)) ?? requestedRef;
  }

  const base = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-payload-'));
  const archive = path.join(base, 'upstream.tar.gz');
  const out = path.join(base, 'payload');
  fs.mkdirSync(out, { recursive: true });

  const downloaded = await download(tarballUrl(target), archive);
  if (!downloaded.ok) {
    return {
      ...downloaded,
      text: describeFetchFailure(downloaded, { target, pinned }),
      workDir: base
    };
  }

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

  // Prefer what the archive itself says, then what was downloaded, so the recorded
  // commit is a fact about the bytes on disk rather than about the request.
  const resolved =
    (COMMIT_PATTERN.test(target) ? target : undefined) ??
    (await resolveArchiveCommit(archive)) ??
    target;

  return {
    ok: true,
    workDir: base,
    payloadDir: out,
    entries,
    bytes: downloaded.bytes,
    ref: requestedRef,
    commit: resolved,
    // True when the commit was chosen by the caller rather than followed from a
    // ref. Also true in effect when a ref resolved, but this reports intent.
    pinned,
    // The install has a sha to record, rather than only a branch name.
    identified: COMMIT_PATTERN.test(resolved),
    harness
  };
}

module.exports = {
  REPO,
  PAYLOAD_PREFIX,
  UPSTREAM_REF,
  HARNESSES,
  COMMIT_PATTERN,
  REF_PATTERN,
  MAX_BYTES,
  tarballUrl,
  download,
  extract,
  resolveRefCommit,
  resolveArchiveCommit,
  describeFetchFailure,
  topLevelEntries,
  fetchPayload
};
