'use strict';

// Independent oracle for the inventory-api reference project.
//
// This module deliberately does NOT use anything under src/. It reads the raw
// engine files of tests/fixtures/inventory-api/ with the simplest code
// that can answer each question, so that tests of the real data layer
// (src/aidlc/trace-data.js) can be checked against numbers that were computed
// a second, unrelated way.
//
// Exports:
//   PROJECT_ROOT       absolute path of the fixture project (what the extension opens)
//   INTENT_ID          '260825-inventory-api'
//   INTENT_REL         intent folder relative to PROJECT_ROOT
//   INTENT_ROOT        absolute path of the intent folder
//   EXPECTED_PATH      absolute path of tests/fixtures/inventory-api-expected.json
//   loadExpected()     parsed expected JSON (fresh object every call)
//   computeFacts(root) recompute every fact from the raw files (root defaults to PROJECT_ROOT)
//
// Run `node tests/helpers/inventory-fixture.js --write` to regenerate the
// expected JSON after a deliberate fixture change. Review the diff by hand:
// the point of the file is that a human has looked at the numbers.
//
// See tests/fixtures/inventory-api/README.md for what the fixture contains.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', 'fixtures', 'inventory-api');
const INTENT_ID = '260825-inventory-api';
const INTENT_REL = `aidlc/spaces/default/intents/${INTENT_ID}`;
const INTENT_ROOT = path.join(PROJECT_ROOT, INTENT_REL);
const EXPECTED_PATH = path.resolve(__dirname, '..', 'fixtures', 'inventory-api-expected.json');

// Requirement-style IDs: a known prefix followed by dotted numbers.
const ID_RE = /^(FR|NFR|US|AC|BR|U)(\d+(?:\.\d+)*)$/;
const PREFIXES = ['FR', 'NFR', 'US', 'AC', 'BR', 'U'];
const STATUSES = ['OK', 'Deferred', 'N/A', 'GAP'];
// A target that is a single repo-relative file path (has an extension, no spaces).
const FILE_RE = /^[\w.\-]+(?:\/[\w.\-]+)*\.[A-Za-z0-9]+$/;

function loadExpected() {
  return JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
}

// ---------- small utilities ----------

const toPosix = (p) => p.split(path.sep).join('/');

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function tally(values, keys) {
  const t = {};
  for (const k of keys || []) t[k] = 0;
  for (const v of values) t[v] = (t[v] || 0) + 1;
  return t;
}

// Natural sort: prefix alphabetically, then numeric parts (AC1.10 after AC1.9).
function idCompare(a, b) {
  const ma = ID_RE.exec(a);
  const mb = ID_RE.exec(b);
  if (!ma || !mb) return a < b ? -1 : a > b ? 1 : 0;
  if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
  const pa = ma[2].split('.').map(Number);
  const pb = mb[2].split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] === undefined ? -1 : pa[i];
    const y = pb[i] === undefined ? -1 : pb[i];
    if (x !== y) return x - y;
  }
  return 0;
}

const sortIds = (ids) => [...ids].sort(idCompare);

// Split a coverage target into tokens and classify it.
//   ids  - every comma-separated token is a requirement ID
//   file - one repo-relative file path
//   text - anything else (prose, component names, stage names)
function classifyTarget(target) {
  const t = String(target).trim();
  const tokens = t.split(/\s*,\s*/).filter(Boolean);
  if (tokens.length && tokens.every((x) => ID_RE.test(x))) return { kind: 'ids', tokens };
  if (FILE_RE.test(t) && t.includes('/')) return { kind: 'file', tokens: [t] };
  return { kind: 'text', tokens: [] };
}

// ---------- traceability.json ----------

function findTraceabilityFiles(intentRoot) {
  return walk(intentRoot)
    .filter((f) => path.basename(f) === 'traceability.json')
    .map((f) => toPosix(path.relative(intentRoot, f)))
    .sort();
}

function traceabilityFacts(intentRoot) {
  const files = findTraceabilityFiles(intentRoot);
  const perFile = [];
  const allCov = [];
  const allRev = [];
  const allUp = [];
  for (const rel of files) {
    const j = readJson(path.join(intentRoot, rel));
    const cov = Array.isArray(j.coverage) ? j.coverage : [];
    const rev = Array.isArray(j.reverse) ? j.reverse : [];
    const up = Array.isArray(j.upstream_ids) ? j.upstream_ids : [];
    const covIds = new Set(cov.map((c) => c.id));
    const kinds = tally(cov.map((c) => classifyTarget(c.target).kind), ['ids', 'file', 'text']);
    perFile.push({
      path: rel,
      stage: j.stage,
      unit: j.unit === undefined ? null : j.unit,
      topLevelKeys: Object.keys(j).sort(),
      upstreamCount: up.length,
      coverageCount: cov.length,
      reverseCount: rev.length,
      coverageByStatus: tally(cov.map((c) => c.status), STATUSES),
      reverseByStatus: tally(rev.map((c) => c.status), STATUSES),
      targetKinds: kinds,
      upstreamNotCovered: sortIds(up.filter((id) => !covIds.has(id))),
      coveredNotUpstream: sortIds([...covIds].filter((id) => !up.includes(id))),
    });
    allUp.push(...up);
    for (const c of cov) allCov.push({ file: rel, stage: j.stage, ...c });
    for (const c of rev) allRev.push({ file: rel, stage: j.stage, ...c });
  }
  return { files, perFile, allCov, allRev, allUp };
}

// ---------- IDs ----------

function idFacts(tr) {
  const seen = new Set();
  const nonPrefixed = new Set();
  const add = (id) => {
    if (ID_RE.test(id)) seen.add(id);
    else nonPrefixed.add(id);
  };
  for (const id of tr.allUp) add(id);
  for (const c of tr.allCov) {
    add(c.id);
    for (const tok of classifyTarget(c.target).tokens) if (ID_RE.test(tok)) seen.add(tok);
  }
  for (const c of tr.allRev) add(c.id);

  const byPrefix = {};
  for (const p of PREFIXES) {
    const ids = sortIds([...seen].filter((id) => ID_RE.exec(id)[1] === p));
    byPrefix[p] = { count: ids.length, ids };
  }
  // NFR splits into parents (NFR1..NFR4) and children (NFR1.1 ...).
  const nfr = byPrefix.NFR.ids;
  return {
    total: seen.size,
    byPrefix,
    nfrParents: nfr.filter((id) => !id.includes('.')),
    nfrChildCount: nfr.filter((id) => id.includes('.')).length,
    nonPrefixedIds: [...nonPrefixed].sort(),
  };
}

// ---------- links (what edges could be built from coverage) ----------

function linkFacts(tr, projectRoot) {
  let idToId = 0;
  let idToFile = 0;
  let idToText = 0;
  const multiTarget = [];
  const fileTargets = new Map();
  for (const c of tr.allCov) {
    const k = classifyTarget(c.target);
    if (k.kind === 'ids') {
      idToId += k.tokens.length;
      if (k.tokens.length > 1) multiTarget.push({ stage: c.stage, id: c.id, targets: k.tokens });
    } else if (k.kind === 'file') {
      idToFile += 1;
      const p = k.tokens[0];
      if (!fileTargets.has(p)) fileTargets.set(p, []);
      fileTargets.get(p).push(c.id);
    } else idToText += 1;
  }
  const targetFiles = [...fileTargets.keys()].sort().map((p) => ({
    path: p,
    exists: fs.existsSync(path.join(projectRoot, p)),
    ids: sortIds(fileTargets.get(p)),
  }));
  return {
    idToIdLinks: idToId,
    idToFileLinks: idToFile,
    idToTextEntries: idToText,
    multiTargetEntries: multiTarget,
    distinctTargetFiles: targetFiles.length,
    targetFiles,
    missingTargetFiles: targetFiles.filter((f) => !f.exists).map((f) => f.path),
  };
}

// IDs covered by more than one traceability file whose status differs between files.
function statusConflicts(tr) {
  const byId = new Map();
  for (const c of tr.allCov) {
    if (!byId.has(c.id)) byId.set(c.id, {});
    byId.get(c.id)[c.stage] = c.status;
  }
  const out = [];
  for (const id of sortIds([...byId.keys()])) {
    const m = byId.get(id);
    if (new Set(Object.values(m)).size > 1) out.push({ id, statusByStage: m });
  }
  return out;
}

// ---------- runtime-graph.json ----------

function runtimeFacts(intentRoot, projectRoot) {
  const g = readJson(path.join(intentRoot, 'runtime-graph.json'));
  const stages = g.stages || [];
  const firings = [];
  for (const s of stages) for (const f of s.sensor_firings || []) firings.push({ stage: s.stage_slug, ...f });
  const withDetail = firings.filter((f) => f.detail_path);
  return {
    topLevelKeys: Object.keys(g).sort(),
    workflow_id: g.workflow_id,
    scope: g.scope,
    started_at: g.started_at,
    stageCount: stages.length,
    stages: stages.map((s) => ({
      slug: s.stage_slug,
      agent: s.agent,
      outcome: s.outcome,
      started_at: s.started_at,
      completed_at: s.completed_at,
      sensorFirings: (s.sensor_firings || []).length,
      sensorFailed: (s.sensor_firings || []).filter((f) => f.result !== 'passed').length,
    })),
    outcomes: tally(stages.map((s) => s.outcome)),
    agents: tally(stages.map((s) => s.agent)),
    sensors: {
      total: firings.length,
      byResult: tally(firings.map((f) => f.result)),
      bySensor: tally(firings.map((f) => f.id)),
      failed: firings
        .filter((f) => f.result !== 'passed')
        .map((f) => ({ stage: f.stage, id: f.id, fire_id: f.fire_id, detail_path: f.detail_path || null })),
      withDetailPath: withDetail.length,
      missingDetailFiles: withDetail
        .filter((f) => !fs.existsSync(path.join(projectRoot, f.detail_path)))
        .map((f) => f.detail_path),
    },
    bolt_dag: g.bolt_dag || null,
  };
}

// ---------- aidlc-state.md ----------

function section(md, heading) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

function boldFields(lines) {
  const o = {};
  for (const l of lines) {
    const m = /^- \*\*(.+?)\*\*:\s*(.*)$/.exec(l.trim());
    if (m) o[m[1]] = m[2].trim();
  }
  return o;
}

function stateFacts(intentRoot) {
  const md = fs.readFileSync(path.join(intentRoot, 'aidlc-state.md'), 'utf8');
  const stageLines = section(md, 'Stage Progress')
    .map((l) => /^- \[(.)\] ([\w-]+) — (\w+)/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ mark: m[1], slug: m[2], plan: m[3] }));
  const info = boldFields(section(md, 'Project Information'));
  return {
    project: info.Project,
    scope: info.Scope,
    phaseProgress: boldFields(section(md, 'Phase Progress')),
    stageLineCount: stageLines.length,
    stagesByMark: tally(stageLines.map((s) => s.mark)),
    stagesByPlan: tally(stageLines.map((s) => s.plan)),
    executed: stageLines.filter((s) => s.plan === 'EXECUTE').map((s) => s.slug),
    skipped: stageLines.filter((s) => s.plan === 'SKIP').map((s) => s.slug),
    currentStatus: boldFields(section(md, 'Current Status')),
  };
}

// ---------- reviews ----------

function reviewFacts(intentRoot) {
  const base = path.join(intentRoot, '.aidlc-engine', 'reviews');
  // Iteration records are <n>.json; briefs/latest.json pointers are excluded.
  const files = walk(base)
    .map((f) => toPosix(path.relative(intentRoot, f)))
    .filter((f) => /\/\d+\.json$/.test(f) && !f.includes('/briefs/'))
    .sort();
  const records = files.map((rel) => {
    const j = readJson(path.join(intentRoot, rel));
    const parts = rel.split('/'); // .aidlc-engine/reviews/<stage>/<stage|units>/[<unit>/]<attempt>/<n>.json
    const findings = Array.isArray(j.findings) ? j.findings : [];
    return {
      path: rel,
      stage: j.stage,
      scope: parts[3],
      unit: j.unit,
      attempt: j.attempt,
      iteration: j.iteration,
      verdict: j.verdict,
      reviewer: j.reviewer,
      recorded_at: j.recorded_at,
      findingCount: findings.length,
      derivedFindingCount: Array.isArray(j.derived_findings) ? j.derived_findings.length : null,
      findingsBySeverity: tally(findings.map((f) => f.severity)),
      findingsByStatus: tally(findings.map((f) => f.status)),
    };
  });
  const markdownReviews = walk(intentRoot)
    .map((f) => toPosix(path.relative(intentRoot, f)))
    .filter((f) => /\/reviews\/review-\d+\.md$/.test(f) && !f.startsWith('.aidlc-engine/'))
    .sort();
  const attempts = new Set(records.map((r) => `${r.stage}/${r.attempt}`));
  return {
    recordCount: records.length,
    byVerdict: tally(records.map((r) => r.verdict)),
    byStage: tally(records.map((r) => r.stage)),
    attemptCount: attempts.size,
    totalFindings: records.reduce((a, r) => a + r.findingCount, 0),
    records,
    markdownReviewFiles: markdownReviews,
  };
}

// ---------- project source tree ----------

function sourceTreeFacts(projectRoot) {
  const src = walk(path.join(projectRoot, 'src')).map((f) => toPosix(path.relative(projectRoot, f))).sort();
  const isTest = (f) => /\.test\.[jt]sx?$/.test(f);
  const tests = src.filter(isTest);
  return {
    srcTotal: src.length,
    srcSourceFiles: src.length - tests.length,
    srcTestFiles: tests.length,
    srcIntegrationTestFiles: tests.filter((f) => /\.int\.test\./.test(f)).length,
    srcByExtension: tally(src.map((f) => path.extname(f))),
    infraFiles: walk(path.join(projectRoot, 'infra')).length,
    testSupportFiles: walk(path.join(projectRoot, 'test-support')).length,
  };
}

// ---------- audit ----------

function auditFacts(intentRoot) {
  const dir = path.join(intentRoot, 'audit');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
  const events = [];
  let headings = 0;
  for (const f of files) {
    const md = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const l of md.split(/\r?\n/)) {
      if (/^## /.test(l)) headings++;
      const m = /^\*\*Event\*\*:\s*(\S+)/.exec(l);
      if (m) events.push(m[1]);
    }
  }
  const byEvent = tally(events);
  const pick = ['WORKFLOW_STARTED', 'STAGE_STARTED', 'STAGE_COMPLETED', 'GATE_APPROVED', 'REVIEW_COMPLETED', 'SENSOR_FAILED', 'STAGE_JUMPED'];
  const keyEvents = {};
  for (const k of pick) keyEvents[k] = byEvent[k] || 0;
  return { files, headingCount: headings, eventLineCount: events.length, keyEvents };
}

// ---------- spot checks ----------

function spotChecks(tr) {
  const targetsOf = (id) => {
    const out = {};
    for (const c of tr.allCov) if (c.id === id) out[c.stage] = { status: c.status, target: c.target };
    return out;
  };
  const reverseOf = (id) => {
    const out = {};
    for (const c of tr.allRev) if (c.id === id) out[c.stage] = { status: c.status, target: c.target };
    return out;
  };
  return {
    'AC1.1.1': targetsOf('AC1.1.1'),
    'FR1.1': targetsOf('FR1.1'),
    'NFR4': targetsOf('NFR4'),
    'US3.1': targetsOf('US3.1'),
    'AC2.1.1': targetsOf('AC2.1.1'),
    'NFR1.9': targetsOf('NFR1.9'),
    'NFR4.2': targetsOf('NFR4.2'),
    'BR4.2': targetsOf('BR4.2'),
    reverse: {
      'US4.2': reverseOf('US4.2'),
      'BR4.2': reverseOf('BR4.2'),
      'NFR1.5': reverseOf('NFR1.5'),
    },
  };
}

// ---------- assemble ----------

function computeFacts(projectRoot) {
  const root = projectRoot || PROJECT_ROOT;
  const intentRoot = path.join(root, INTENT_REL);
  const tr = traceabilityFacts(intentRoot);
  const totals = {
    coverageEntries: tr.allCov.length,
    reverseEntries: tr.allRev.length,
    upstreamEntries: tr.perFile.reduce((a, f) => a + f.upstreamCount, 0),
    coverageByStatus: tally(tr.allCov.map((c) => c.status), STATUSES),
    reverseByStatus: tally(tr.allRev.map((c) => c.status), STATUSES),
  };
  return {
    $comment:
      'Ground truth for tests/fixtures/inventory-api, computed by tests/helpers/inventory-fixture.js from raw engine files. See tests/fixtures/inventory-api/README.md.',
    schemaVersion: 1,
    intent: { id: INTENT_ID, path: INTENT_REL },
    traceability: { fileCount: tr.files.length, files: tr.perFile, totals },
    ids: idFacts(tr),
    links: linkFacts(tr, root),
    statusConflicts: statusConflicts(tr),
    runtimeGraph: runtimeFacts(intentRoot, root),
    state: stateFacts(intentRoot),
    reviews: reviewFacts(intentRoot),
    sourceTree: sourceTreeFacts(root),
    audit: auditFacts(intentRoot),
    spotChecks: spotChecks(tr),
  };
}

module.exports = {
  PROJECT_ROOT,
  INTENT_ID,
  INTENT_REL,
  INTENT_ROOT,
  EXPECTED_PATH,
  loadExpected,
  computeFacts,
  classifyTarget,
  ID_RE,
};

if (require.main === module) {
  const facts = computeFacts();
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(EXPECTED_PATH), { recursive: true });
    fs.writeFileSync(EXPECTED_PATH, JSON.stringify(facts, null, 2) + '\n');
    console.log(`wrote ${EXPECTED_PATH}`);
  } else {
    process.stdout.write(JSON.stringify(facts, null, 2) + '\n');
  }
}
