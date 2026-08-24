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
// v2 is where upstream ships the engine. Following the branch means an install
// gets the current engine rather than the one that was current when this support
// was written, which is what was asked for and is right for a workflow still
// moving. The trade is that the reader modules in this directory were verified
// against an earlier head, so a change upstream can produce a field or an event
// this build has not seen. That is survivable by construction rather than by luck:
// nothing here enumerates stage slugs, phase names, sensor ids or event names, and
// anything unrecognised is reported under "Not understood by this extension"
// instead of being guessed at or throwing.
const UPSTREAM_REF = 'v2';

// A ref goes into a URL and into an archive path, so it is constrained to what a
// git ref can legitimately be. This keeps a path traversal, a flag-looking string
// and a shell fragment out of both.
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

// Only harnesses this extension has actually verified against a real run. A name
// not on this list is refused rather than attempted, because a wrong path yields
// an empty extraction that would look like a successful install of nothing.
const HARNESSES = { 'kiro-ide': 'kiro-ide', 'kiro-cli': 'kiro-cli' };

// A commit has to look like one. Used to check the sha read back out of the
// archive, and to accept an explicit commit from a caller that wants a fixed one.
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

// Which commit a ref points at right now.
//
// Needed because GitHub does NOT put the sha in the archive when the download is
// by branch name: asking for `v2` yields a root directory named
// `aidlc-workflows-2`, so the archive cannot say which engine it is. Asking the API
// first, then downloading that exact sha, makes the install accountable and also
// removes the window where upstream could push between learning the sha and
// fetching the code.
//
// `Accept: application/vnd.github.sha` returns the sha as plain text rather than a
// commit object, so there is no JSON to parse and nothing large to buffer.
//
// Every failure resolves to undefined rather than throwing. This request is a
// nicety: unauthenticated API calls are rate limited, a proxy may allow codeload
// while blocking api.github.com, and none of that is a reason to refuse an
// install. The caller falls back to downloading the ref directly.
function resolveRefCommit(ref) {
  const url = `https://api.github.com/repos/${REPO}/commits/${ref}`;
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
        if (response.statusCode !== 200) {
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
  topLevelEntries,
  fetchPayload
};
