'use strict';

// Fetches the upstream v2 payload into a temporary directory.
//
// The payload comes from a GitHub RELEASE asset, not from the repository tree.
// Upstream restructured on 2026-09-08: `dist/<harness>/`, which held ready-to-copy
// installs, is gone. The repository now carries sources (`core/`, `harness/`) and the
// compiled artefacts this extension reads -- stage-graph.json and scope-grid.json --
// are not committed at all. They are built, and shipped in the release tarball.
//
// So a repository tarball no longer contains anything installable, and the previous
// approach failed with `tar: */dist/kiro-ide/*: Not found in archive`. Fetching the
// release asset is now the only way to get a payload without running upstream's build.
//
// The asset is `aidlc-runtime-<version>.tar.gz`, 12MB, laid out as
// `runtime/<harness>/`, so extraction is the same shape of operation as before.
//
// Two things this deliberately does NOT do. It does not bundle the payload into the
// extension, because a snapshot of an actively changing engine goes stale between
// releases. And it adds no runtime dependency: extraction uses the `tar` binary that
// ships with macOS, Linux and Windows 10 1803 and later, so the extension keeps its
// zero-dependency footprint rather than taking on a tar implementation to save one
// subprocess.
//
// Pure module: never import `vscode`. Node built-ins and one subprocess only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

// Upstream coordinates. The prefix is the release tarball's own top-level directory,
// which is part of upstream's published layout rather than a guess.
const REPO = 'awslabs/aidlc-workflows';
const PAYLOAD_PREFIX = 'runtime';

// Where the release metadata lives. `latest` follows upstream's own notion of the
// current release rather than this build's guess at one.
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

// The asset carrying the harness payloads. Matched on shape rather than on an exact
// name, because the version is in it and upstream bumps that on every release.
const RUNTIME_ASSET = /^aidlc-runtime-.*\.tar\.gz$/;


// Harnesses this extension installs, mapped to their directory under `runtime/`.
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

// Ceilings, so a redirect loop or an unexpectedly huge archive fails with a
// reason instead of filling the disk or hanging a session.
const MAX_REDIRECTS = 5;
const MAX_BYTES = 80 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 120_000;

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
// bsdtar (macOS, Windows) and GNU tar (Linux) differ on wildcard flags, so the
// pattern is passed in a form both accept and a failure reports tar's own stderr
// rather than a guess about which implementation was in play.
// Extract one harness's subtree from the release archive.
//
// The release tarball has NO wrapper directory: its first entry is `plugins/...`, so
// the wanted subtree sits at `runtime/<harness>/` from the root. A repository tarball
// does wrap everything in `<repo>-<ref>/`, which is why the pattern and the strip
// count were one deeper before and why they had to change with the source.
// `--strip-components=2` removes `runtime/<harness>`, leaving the payload at the
// destination root.
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
        '--strip-components=2',
        `${PAYLOAD_PREFIX}/${subdir}/*`
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

// Which release to install, and where its payload lives.
//
// Returns the tag and the asset URL, so the caller records what a project got. The
// tag replaces the commit sha as the thing written into the receipt: upstream now
// publishes versioned releases, and a version is a better answer to "which engine do
// I have" than a sha was.
//
// Every failure resolves rather than throwing, and carries a reason a person can act
// on. An install that cannot reach the release API is a different problem from one
// whose release carries no runtime asset.
function resolveRelease(redirectsLeft = MAX_REDIRECTS) {
  return readJsonFrom(RELEASE_API, redirectsLeft).then((release) => {
    if (!release) {
      return { ok: false, reason: 'release-unreadable' };
    }
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((entry) => entry && RUNTIME_ASSET.test(String(entry.name)));
    if (!asset || typeof asset.browser_download_url !== 'string') {
      // Named separately because a release that exists but ships no runtime tarball
      // means upstream changed how it publishes, not that the network is broken.
      return {
        ok: false,
        reason: 'no-runtime-asset',
        text:
          `Release ${release.tag_name ?? '(untagged)'} of ${REPO} carries no ` +
          'aidlc-runtime tarball. Upstream may have changed how it publishes the engine.'
      };
    }
    return {
      ok: true,
      tag: typeof release.tag_name === 'string' ? release.tag_name : undefined,
      url: asset.browser_download_url,
      bytes: asset.size
    };
  });
}

// A JSON body from the API, following redirects, resolving to undefined on anything
// that is not a 200 with parseable JSON. Redirects are followed because a repository
// rename answers with one, and a rename should cost nothing.
function readJsonFrom(url, redirectsLeft) {
  return new Promise((resolve) => {
    const request = https.get(
      url,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/vnd.github+json',
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
          readJsonFrom(new URL(response.headers.location, url).toString(), redirectsLeft - 1)
            .then(resolve);
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
          // A release body is a few KB. A megabyte means something else answered.
          if (body.length > 1024 * 1024) {
            response.destroy();
            resolve(undefined);
          }
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(undefined);
          }
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
async function fetchPayload({ release, harness, workDir }) {
  if (!HARNESSES[harness]) {
    return { ok: false, reason: 'unknown-harness', text: `No payload path known for "${harness}".` };
  }

  // `release` lets a caller install an exact published version, for reproducing a
  // report without a second code path through this module. Without it, upstream's
  // own latest is used.
  const found = release ?? (await resolveRelease());
  if (!found.ok) return { ...found };

  const base = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-payload-'));
  const archive = path.join(base, 'upstream.tar.gz');
  const out = path.join(base, 'payload');
  fs.mkdirSync(out, { recursive: true });

  const downloaded = await download(found.url, archive);
  if (!downloaded.ok) {
    return {
      ...downloaded,
      text: describeFetchFailure(downloaded, { target: found.tag, pinned: true }),
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
      text:
        `Release ${found.tag ?? '(untagged)'} carries no ` +
        `${PAYLOAD_PREFIX}/${HARNESSES[harness]} directory. Upstream may have renamed it.`,
      workDir: base
    };
  }

  return {
    ok: true,
    workDir: base,
    payloadDir: out,
    entries,
    bytes: downloaded.bytes,
    // The published version, which is what goes into the receipt. It replaces the
    // commit sha: upstream publishes versioned releases now, and a version answers
    // "which engine do I have" better than a sha did.
    release: found.tag,
    commit: found.tag,
    identified: Boolean(found.tag),
    harness
  };
}

module.exports = {
  REPO,
  PAYLOAD_PREFIX,
  RELEASE_API,
  RUNTIME_ASSET,
  resolveRelease,
  HARNESSES,
  MAX_BYTES,
  download,
  extract,
  describeFetchFailure,
  topLevelEntries,
  fetchPayload
};
