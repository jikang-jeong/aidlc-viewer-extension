'use strict';

// Trace data for the Trace Explorer panel.
//
// `readTraceData(projectRoot, { intent, space })` reads one intent of an AI-DLC
// v2 project and returns the TraceData object the Trace, Coverage and Reviews
// views render. The shape follows the design spec's `DATA` object; the content
// comes only from engine records on disk:
//
//   - the graph is built from every `traceability.json` under the intent
//     (one per traceability-bearing stage, same shape everywhere: `stage`,
//     optional `unit`, `upstream_ids`, `coverage[{id,status,target}]`,
//     optional `reverse`). What a `target` means differs by stage; the table in
//     STAGE_RULES encodes what each stage spec under the harness directory's
//     `aidlc-common/stages/` (`.kiro/` on Kiro) says its targets are.
//   - two convention rules add edges the files imply but do not write down:
//     ACx.y.z belongs to USx.y, and x.ts is tested by x.test.ts.
//   - labels and text come from the markdown each ID is defined in; verdicts
//     from the build-and-test records; `why` chains from `[Qn]` citations and
//     the `[Answer]:` blocks of the stage's questions file; reviews from the
//     engine's review JSON (markdown `## Review` sections only where no JSON
//     exists); the backward jump from the audit ledger's STAGE_JUMPED row.
//
// Anything without a deterministic source is left out and named in
// `meta.omitted`. A missing or malformed file yields a partial result plus a
// `meta.warnings` entry. This function never throws.
//
// The design-spec HTML is a visual reference, never a source. See
// docs/trace-explorer/data-model.md for the derivability matrix.
//
// Pure module: never import `vscode` here. Filesystem reads only.

const fs = require('fs');
const path = require('path');
const { listSpaces, listIntents, isBookkeeping } = require('./runtime');
const { field, listShardPaths } = require('./audit');
const { harnessDir } = require('./harness-dirs');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {'functional_requirement'|'nfr'|'nfr_detail'|'user_story'|'acceptance_criterion'|
 *   'business_rule'|'component'|'unit'|'design_decision'|'stage'|'note'|'code'|'test'|'unknown'} NodeType
 */

/**
 * @typedef {Object} WhyEntry
 * @property {string} ref     Citation as written, e.g. "Q1", "OQ2", "team-practices".
 * @property {string} stage   Stage whose questions file answers it, or "upstream artifact" /
 *                            "open question from requirements".
 * @property {string} [q]     Question title (or open-question text).
 * @property {string} [a]     The recorded `[Answer]:`, expanded to the option text when it is a letter.
 * @property {string} [path]  Project-relative file the entry was read from.
 */

/**
 * @typedef {Object} NodeNote
 * @property {string} stage
 * @property {string} status  Status of the `reverse` row.
 * @property {string} text    The row's target text.
 * @property {string} origin  Project-relative traceability.json.
 */

/**
 * @typedef {Object} TraceNode
 * @property {string} id
 * @property {NodeType} type
 * @property {string} label
 * @property {string} text
 * @property {string} path            Project-relative file the node is defined in (or first seen in).
 * @property {boolean} rework         True when `path` is in the backward jump's invalidated list.
 * @property {string} [verdict]       Build-and-test verdict, e.g. "Met", "Covered", "Deferred".
 * @property {string} [verdictSource] Project-relative file the verdict came from.
 * @property {string} [verdictNote]   Qualifier written next to the verdict in that file.
 * @property {boolean} [verdictAccepted] Listed under test-results.md "Decision: Accept failure".
 * @property {{verdict:string, source:string}} [verdictPrior] Verdict a later stage superseded.
 * @property {WhyEntry[]} [why]
 * @property {string} [priority]      user_story: MoSCoW from the story heading.
 * @property {string} [kind]          business_rule: `category`; unit: `Kind`.
 * @property {string} [category]      nfr_detail: from the file name (`observability-requirements.md`).
 * @property {string} [stage]         design_decision / note: the stage that wrote it.
 * @property {string} [unit]          design_decision / note: unit of the traceability file.
 * @property {boolean} [exists]       code / test: whether the file exists in the project.
 * @property {NodeNote[]} [notes]     `reverse` rows naming this ID.
 */

/**
 * @typedef {Object} TraceEdge
 * @property {string} source
 * @property {string} target
 * @property {string} relation  realized_by_story | owned_by_component | built_in_unit | refined_by_rule |
 *                              refined_by | designed_as | implemented_in | verified_by_test | deferred_to |
 *                              deferral_note | na_note | has_acceptance_criterion | tested_by
 * @property {'OK'|'Deferred'|'N/A'|string} status
 * @property {string} origin    Project-relative traceability.json, or `derived:<rule>`.
 * @property {string} [stage]   Stage of the traceability file (absent on derived edges).
 * @property {string} [unit]
 * @property {boolean} [derived]
 */

/**
 * @typedef {Object} ReviewFinding
 * @property {string} [id]
 * @property {string} severity
 * @property {string} [status]
 * @property {string} [location]
 * @property {string} [finding]
 * @property {string} [requiredAction]
 */

/**
 * @typedef {Object} Review
 * @property {string} id
 * @property {string} stage
 * @property {string} [unit]
 * @property {string} verdict          READY | NOT-READY | as written
 * @property {string} [date]           ISO timestamp from the review body's `**Date:**`.
 * @property {number} [iteration]
 * @property {string} [reviewer]
 * @property {string} [attempt]
 * @property {string} file             Project-relative markdown a person would open.
 * @property {number} [line]           1-based line of `## Review` in `file`, when `file` is markdown.
 * @property {string} source           Project-relative file the record was read from.
 * @property {'engine-json'|'markdown'} sourceKind
 * @property {number} critical
 * @property {number} major
 * @property {number} minor
 * @property {number|null} open        Findings with status New/Unresolved (JSON only).
 * @property {ReviewFinding[]} findings
 */

/**
 * @typedef {Object} Jump
 * @property {string} ts
 * @property {string} direction
 * @property {string} source
 * @property {string} target
 * @property {string[]} changed
 * @property {string[]} invalidated
 * @property {string[]} invalidated_reviews
 * @property {string} reason           Title of the preceding `## Change Request` record, else `**Details**`.
 * @property {string} [details]
 * @property {string} [request]
 * @property {string} [impact]
 * @property {string} origin           Project-relative audit shard.
 */

/**
 * @typedef {Object} Drift
 * @property {string|null} id          First graph ID named in the finding's location (or text).
 * @property {string[]} ids
 * @property {string|null} file        Project-relative file named in the location, when it exists.
 * @property {string} note             The finding text.
 * @property {string} [location]
 * @property {string} stage
 * @property {string} [unit]
 * @property {string} severity
 * @property {string} findingId
 * @property {string} status           New | Unresolved
 * @property {string} review           Review id.
 * @property {string} [requiredAction]
 */

/**
 * @typedef {Object} TraceMeta
 * @property {string} intent
 * @property {string} [space]
 * @property {string} intentPath       Project-relative intent folder.
 * @property {string} generated        ISO time of this read.
 * @property {string} generator
 * @property {string[]} sources        Project-relative files actually read.
 * @property {string[]} listedDirs     Project-relative directories whose entry names were used (trailing `/`).
 * @property {string[]} stageOrder     runtime-graph.json `stages[].stage_slug`, in file order, duplicates dropped;
 *                                     [] when the file is missing or malformed.
 * @property {string[]} derived_edge_rules
 * @property {{field:string, reason:string}[]} omitted
 * @property {string[]} warnings
 * @property {{id:string, stage:string, unit?:string, origin:string, reason:string}[]} gaps
 * @property {{nodesByType:Object<string,number>, edgesByRelation:Object<string,number>}} counts
 */

/**
 * @typedef {Object} TraceData
 * @property {TraceMeta} meta
 * @property {string} repo             Absolute project root.
 * @property {TraceNode[]} nodes
 * @property {TraceEdge[]} edges
 * @property {Review[]} reviews
 * @property {Jump|null} jump
 * @property {Drift[]} drift
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERATOR = 'aidlc-viewer trace-data';

// What each stage's coverage `target` is, per its stage spec.
//   ids   - one or more IDs, comma separated (user-stories: USx.y; functional-design: BRx.y;
//           nfr-requirements: NFRx.y). Deferred names a later stage; N/A carries a reason.
//   names - one or more names (domain-design: component; units-generation: Unit ID).
//   text  - a free-text design decision (nfr-design, infrastructure-design), whatever the status.
//   path  - one workspace-relative file (code-generation); Deferred/N/A carry the person's words.
const STAGE_RULES = {
  'user-stories': { kind: 'ids', relation: 'realized_by_story', targetType: 'user_story' },
  'domain-design': { kind: 'names', relation: 'owned_by_component', targetType: 'component' },
  'units-generation': { kind: 'names', relation: 'built_in_unit', targetType: 'unit' },
  'functional-design': { kind: 'ids', relation: 'refined_by_rule', targetType: 'business_rule' },
  'nfr-requirements': { kind: 'ids', relation: 'refined_by', targetType: 'nfr_detail' },
  'nfr-design': { kind: 'text', relation: 'designed_as', targetType: 'design_decision' },
  'infrastructure-design': { kind: 'text', relation: 'designed_as', targetType: 'design_decision' },
  'code-generation': { kind: 'path', relation: 'implemented_in', targetType: 'code' }
};

const DERIVED_AC_RULE = 'derived:id-convention';
const DERIVED_TEST_RULE = 'derived:file-name-convention';
const DERIVED_EDGE_RULES = [
  'US -> AC from the ID convention ACx.y.z belongs to USx.y (origin "derived:id-convention")',
  'code -> test from the file-name convention x.ts -> x.test.ts / x.int.test.ts / x.spec.ts, in the same folder or a sibling test/ folder (origin "derived:file-name-convention")'
];

const STATUSES = new Set(['OK', 'Deferred', 'N/A', 'GAP']);
const OPEN_FINDING = new Set(['New', 'Unresolved']);

const ID_TYPE_RULES = [
  [/^FR\d+(?:\.\d+)*$/, 'functional_requirement'],
  [/^NFR\d+$/, 'nfr'],
  [/^NFR\d+(?:\.\d+)+$/, 'nfr_detail'],
  [/^US\d+(?:\.\d+)+$/, 'user_story'],
  [/^AC\d+(?:\.\d+)+$/, 'acceptance_criterion'],
  [/^BR\d+(?:\.\d+)+$/, 'business_rule'],
  [/^U\d+$/, 'unit']
];
const ID_TOKEN = /^[A-Z]+\d+(?:\.\d+)*$/;
const ID_IN_TEXT = /\b(?:FR|NFR|US|AC|BR)\d+(?:\.\d+)*\b/g;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CODE_EXT = /\.([cm]?[jt]sx?)$/;
const WALK_SKIP = new Set(['node_modules', 'aidlc', 'dist', 'build', 'out', 'coverage', 'cdk.out']);
const WALK_LIMIT = 20000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toPosix = (p) => p.split(path.sep).join('/');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function listEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function typeFromId(id) {
  for (const [re, type] of ID_TYPE_RULES) if (re.test(id)) return type;
  return undefined;
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// Drop `[Q1]`, `[team-practices]` style citations from requirement text.
function stripCitations(text) {
  return collapse(String(text).replace(/\s*\[[A-Za-z0-9][\w.\-]*\]/g, ''));
}

function citationsOf(text) {
  return [...String(text).matchAll(/\[([A-Za-z0-9][\w.\-]*)\]/g)].map((m) => m[1]);
}

function splitList(text) {
  return String(text).split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
}

// Markdown table rows -> arrays of trimmed cells. Separator rows are dropped.
function tableRows(lines) {
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

// Consecutive table blocks in a chunk of lines: [{ header, rows }].
function tables(lines) {
  const out = [];
  let block = [];
  const flush = () => {
    const rows = tableRows(block);
    if (rows.length) out.push({ header: rows[0], rows: rows.slice(1) });
    block = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith('|')) block.push(line);
    else if (block.length) flush();
  }
  if (block.length) flush();
  return out;
}

// Split markdown into sections by heading level `level` (2 -> `## `).
function sections(text, level) {
  const marker = '#'.repeat(level) + ' ';
  const out = [];
  let current = { heading: '', lines: [] };
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith(marker)) {
      out.push(current);
      current = { heading: line.slice(marker.length).trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  out.push(current);
  return out;
}

const stripMd = (s) => collapse(String(s).replace(/\*\*/g, '').replace(/`/g, ''));

// "AC1.1.1 to AC1.1.5" -> AC1.1.1..AC1.1.5; "FR1.1, FR1.2" -> both; "NFR3.1 / NFR3.5" -> both.
function expandIds(cell) {
  const ids = [];
  for (const part of String(cell).replace(/`/g, '').split(/\s*(?:,|\/)\s*/)) {
    const range = part.match(/^([A-Z]+(?:\d+\.)*)(\d+)\s+to\s+([A-Z]+(?:\d+\.)*)(\d+)$/);
    if (range && range[1] === range[3]) {
      const from = Number(range[2]);
      const to = Number(range[4]);
      for (let n = from; n <= to && n - from < 1000; n++) ids.push(range[1] + n);
      continue;
    }
    const single = part.match(/^[A-Z]+\d+(?:\.\d+)*/);
    if (single) ids.push(single[0]);
  }
  return ids;
}

function safeJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Read context
// ---------------------------------------------------------------------------

function createContext(root, intentDir) {
  return {
    root,
    intentDir,
    nodes: new Map(),
    edges: [],
    edgeKeys: new Set(),
    warnings: [],
    gaps: [],
    sources: new Set(),
    listedDirs: new Set(),
    stageSlugs: new Set(),
    stageOrder: [],
    rel(abs) {
      return toPosix(path.relative(root, abs));
    },
    read(abs) {
      const text = readText(abs);
      if (text !== undefined) this.sources.add(this.rel(abs));
      return text;
    },
    warn(message) {
      this.warnings.push(message);
    }
  };
}

function ensureNode(ctx, id, type, attrs = {}) {
  let node = ctx.nodes.get(id);
  if (!node) {
    node = { id, type: type || 'unknown', label: id, text: id, path: '', rework: false };
    ctx.nodes.set(id, node);
  } else if (node.type === 'unknown' && type) {
    node.type = type;
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && (node[key] === undefined || node[key] === '' || node[key] === node.id)) {
      node[key] = value;
    }
  }
  return node;
}

function addEdge(ctx, edge) {
  const key = `${edge.source}|${edge.target}|${edge.relation}|${edge.origin}`;
  if (ctx.edgeKeys.has(key)) return;
  ctx.edgeKeys.add(key);
  ctx.edges.push(edge);
}

// Known stage slugs: the project's stage specs plus the intent's runtime graph. The specs
// sit under the harness directory (`.kiro/aidlc-common/stages/` on Kiro, `.claude/...` on
// Claude Code; see harness-dirs.js), the same directory the stage graph is read from.
function collectStageSlugs(ctx) {
  const stagesDir = path.join(ctx.root, harnessDir(ctx.root) ?? '.kiro', 'aidlc-common', 'stages');
  // Only file NAMES are used here, so this is a directory listing, not a file read:
  // it goes into meta.listedDirs rather than meta.sources.
  const phases = listEntries(stagesDir);
  if (phases.length) ctx.listedDirs.add(`${ctx.rel(stagesDir)}/`);
  for (const phase of phases) {
    if (!phase.isDirectory()) continue;
    for (const spec of listEntries(path.join(stagesDir, phase.name))) {
      if (spec.isFile() && spec.name.endsWith('.md')) ctx.stageSlugs.add(spec.name.slice(0, -3));
    }
  }
  const runtimeText = ctx.read(path.join(ctx.intentDir, 'runtime-graph.json'));
  if (runtimeText) {
    try {
      const raw = JSON.parse(runtimeText);
      for (const s of Array.isArray(raw.stages) ? raw.stages : []) {
        if (s && typeof s.stage_slug === 'string') {
          ctx.stageSlugs.add(s.stage_slug);
          if (!ctx.stageOrder.includes(s.stage_slug)) ctx.stageOrder.push(s.stage_slug);
        }
      }
    } catch {
      ctx.warn('runtime-graph.json is not valid JSON; stage names come from the stage specs only');
    }
  }
  for (const slug of Object.keys(STAGE_RULES)) ctx.stageSlugs.add(slug);
}

// Every traceability.json under the intent, skipping bookkeeping (dot) folders.
function findTraceabilityFiles(intentDir) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const entry of listEntries(dir)) {
      if (isBookkeeping(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'audit') walk(full, depth + 1);
      } else if (entry.isFile() && entry.name === 'traceability.json') {
        found.push(full);
      }
    }
  };
  walk(intentDir, 0);
  return found.sort();
}

// A design decision or note id, made unique across units when two units write
// the same (stage, id) pair.
function scopedId(ctx, base, unit) {
  if (!ctx.nodes.has(base)) return base;
  const existing = ctx.nodes.get(base);
  if (!unit || existing.unit === unit) return base;
  return `${base}:${unit}`;
}

function textNode(ctx, { prefix, id, stage, unit, text, type, origin }) {
  const base = prefix === 'design' ? `design:${stage}:${id}` : `note:${id}:${stage}`;
  const nodeId = scopedId(ctx, base, unit);
  ensureNode(ctx, nodeId, type, { label: text, text, path: origin, stage, unit });
  return nodeId;
}

function nonOkTarget(ctx, row, info) {
  const { id, status, target, stage, unit, origin } = info;
  if (status === 'Deferred' && ctx.stageSlugs.has(target)) {
    const stageId = `stage:${target}`;
    ensureNode(ctx, stageId, 'stage', { label: target, text: target, path: origin });
    addEdge(ctx, { source: id, target: stageId, relation: 'deferred_to', status, origin, stage, unit });
    return;
  }
  const noteId = textNode(ctx, { prefix: 'note', id, stage, unit, text: target, type: 'note', origin });
  addEdge(ctx, {
    source: id,
    target: noteId,
    relation: status === 'N/A' ? 'na_note' : 'deferral_note',
    status,
    origin,
    stage,
    unit
  });
}

function readTraceabilityFile(ctx, file) {
  const origin = ctx.rel(file);
  const text = ctx.read(file);
  if (text === undefined) {
    ctx.warn(`${origin}: could not be read`);
    return;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    ctx.warn(`${origin}: not valid JSON (${err.message})`);
    return;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.coverage)) {
    ctx.warn(`${origin}: no coverage array; file skipped`);
    return;
  }
  const stage = typeof data.stage === 'string' ? data.stage : path.basename(path.dirname(file));
  const unit = typeof data.unit === 'string' ? data.unit : undefined;
  let rule = STAGE_RULES[stage];
  if (!rule) {
    ctx.warn(`${origin}: stage "${stage}" has no known target meaning; its targets are read as free text`);
    rule = { kind: 'text', relation: 'traces_to', targetType: 'note' };
  }

  const covered = new Set();
  for (const row of data.coverage) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) {
      ctx.warn(`${origin}: coverage row without an id skipped`);
      continue;
    }
    const id = row.id.trim();
    covered.add(id);
    let status = typeof row.status === 'string' ? row.status.trim() : '';
    if (!STATUSES.has(status)) {
      ctx.warn(`${origin}: ${id} has unknown status "${row.status}"; kept as written`);
    }
    ensureNode(ctx, id, typeFromId(id) || 'unknown', { path: origin });
    if (status === 'GAP') {
      ctx.gaps.push({ id, stage, unit, origin, reason: 'coverage row is GAP' });
      continue;
    }
    const target = typeof row.target === 'string' ? collapse(row.target) : '';
    if (!target) {
      ctx.warn(`${origin}: ${id} (${status}) has no target`);
      continue;
    }
    const info = { id, status, target, stage, unit, origin };
    applyRow(ctx, rule, info);
  }

  for (const upstream of Array.isArray(data.upstream_ids) ? data.upstream_ids : []) {
    if (typeof upstream === 'string' && !covered.has(upstream)) {
      ctx.gaps.push({ id: upstream, stage, unit, origin, reason: 'listed in upstream_ids with no coverage row' });
    }
  }

  for (const row of Array.isArray(data.reverse) ? data.reverse : []) {
    if (!row || typeof row.id !== 'string') continue;
    const node = ctx.nodes.get(row.id);
    if (!node) continue;
    (node.notes ||= []).push({ stage, status: String(row.status ?? ''), text: collapse(row.target), origin });
  }
}

function applyRow(ctx, rule, info) {
  const { id, status, target, stage, unit, origin } = info;
  if (rule.kind === 'text') {
    const nodeId = textNode(ctx, { prefix: 'design', id, stage, unit, text: target, type: rule.targetType, origin });
    addEdge(ctx, { source: id, target: nodeId, relation: rule.relation, status, origin, stage, unit });
    return;
  }
  if (rule.kind === 'path') {
    const looksLikePath = !/\s/.test(target) && /\.[A-Za-z0-9]+$/.test(target);
    if (status === 'OK' && looksLikePath) {
      const isTest = TEST_FILE.test(target);
      ensureNode(ctx, target, isTest ? 'test' : 'code', {
        label: path.posix.basename(target),
        text: target,
        path: target,
        exists: exists(path.join(ctx.root, target))
      });
      addEdge(ctx, {
        source: id,
        target,
        relation: isTest ? 'verified_by_test' : rule.relation,
        status,
        origin,
        stage,
        unit
      });
      return;
    }
    if (status === 'OK') ctx.warn(`${origin}: ${id} is OK but its target is not a file path; shown as a note`);
    nonOkTarget(ctx, null, info);
    return;
  }
  // ids / names
  const tokens = splitList(target);
  const resolvable =
    status === 'OK' &&
    tokens.length > 0 &&
    (rule.kind === 'names' ? tokens.every((t) => !/\s/.test(t)) : tokens.every((t) => ID_TOKEN.test(t)));
  if (resolvable) {
    for (const token of tokens) {
      ensureNode(ctx, token, typeFromId(token) || rule.targetType, { path: origin });
      addEdge(ctx, { source: id, target: token, relation: rule.relation, status, origin, stage, unit });
    }
    return;
  }
  if (status === 'OK') ctx.warn(`${origin}: ${id} is OK but "${target}" does not name ${rule.targetType} ids; shown as a note`);
  nonOkTarget(ctx, null, info);
}

// ---------------------------------------------------------------------------
// Convention edges
// ---------------------------------------------------------------------------

function deriveAcceptanceCriteria(ctx) {
  for (const node of [...ctx.nodes.values()]) {
    if (node.type !== 'acceptance_criterion') continue;
    const m = node.id.match(/^AC(\d+\.\d+)\.\d+$/);
    if (!m) continue;
    const story = `US${m[1]}`;
    if (!ctx.nodes.has(story)) continue;
    addEdge(ctx, {
      source: story,
      target: node.id,
      relation: 'has_acceptance_criterion',
      status: 'OK',
      origin: DERIVED_AC_RULE,
      derived: true
    });
  }
}

// Test files anywhere in the project tree (outside dot folders and build output).
function findTestFiles(ctx) {
  const found = [];
  let seen = 0;
  const walk = (dir) => {
    for (const entry of listEntries(dir)) {
      if (seen > WALK_LIMIT) return;
      if (entry.name.startsWith('.') || WALK_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        seen++;
        if (TEST_FILE.test(entry.name)) found.push(ctx.rel(full));
      }
    }
  };
  walk(ctx.root);
  if (seen > WALK_LIMIT) ctx.warn(`project tree has more than ${WALK_LIMIT} files; test file listing is partial`);
  return found.sort();
}

function deriveTests(ctx, testFiles) {
  const testSet = new Set(testFiles);
  for (const file of testFiles) {
    ensureNode(ctx, file, 'test', { label: path.posix.basename(file), text: file, path: file, exists: true });
  }
  for (const node of [...ctx.nodes.values()]) {
    if (node.type !== 'code') continue;
    const m = node.id.match(CODE_EXT);
    if (!m) continue;
    const ext = m[1];
    const dir = path.posix.dirname(node.id);
    const base = path.posix.basename(node.id, `.${ext}`);
    const parent = path.posix.dirname(dir);
    const candidates = [
      `${dir}/${base}.test.${ext}`,
      `${dir}/${base}.int.test.${ext}`,
      `${dir}/${base}.spec.${ext}`,
      `${dir}/__tests__/${base}.test.${ext}`,
      `${parent}/test/${base}.test.${ext}`,
      `${parent}/tests/${base}.test.${ext}`
    ].map((p) => path.posix.normalize(p));
    for (const candidate of candidates) {
      if (!testSet.has(candidate)) continue;
      addEdge(ctx, {
        source: node.id,
        target: candidate,
        relation: 'tested_by',
        status: 'OK',
        origin: DERIVED_TEST_RULE,
        derived: true
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Labels and text from the markdown each ID is defined in
// ---------------------------------------------------------------------------

// `- **ID** text` / `- **NFR1 — Title.** text` bullets, continuation lines joined.
function definitionBullets(text) {
  const out = [];
  let current;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+\*\*([A-Z]+\d+(?:\.\d+)*)(?:\s+[—–-]\s+([^*]+?))?\*\*\s*(.*)$/);
    if (m) {
      if (current) out.push(current);
      current = { id: m[1], title: m[2] ? m[2].replace(/\.\s*$/, '').trim() : undefined, body: m[3] };
      continue;
    }
    if (current && line.trim() && !/^\s*[-#|]/.test(line) && /^\s+/.test(line)) {
      current.body += ' ' + line.trim();
    } else if (current) {
      out.push(current);
      current = undefined;
    }
  }
  if (current) out.push(current);
  return out;
}

// Units contributing per-unit records: construction/<unit>/ folders that hold stage folders.
function unitDirs(ctx) {
  const construction = path.join(ctx.intentDir, 'construction');
  return listEntries(construction)
    .filter((e) => e.isDirectory() && !isBookkeeping(e.name) && !ctx.stageSlugs.has(e.name))
    .map((e) => path.join(construction, e.name));
}

function enrichRequirements(ctx) {
  const file = path.join(ctx.intentDir, 'inception', 'requirements-analysis', 'requirements.md');
  const text = ctx.read(file);
  if (text === undefined) return { cites: new Map(), openQuestions: new Map() };
  const rel = ctx.rel(file);
  const cites = new Map();
  const openQuestions = new Map();
  for (const b of definitionBullets(text)) {
    if (/^OQ\d+$/.test(b.id)) openQuestions.set(b.id, stripCitations(b.body));
    const node = ctx.nodes.get(b.id);
    if (!node) {
      if (/^(FR|NFR)\d/.test(b.id)) ctx.warn(`${rel}: ${b.id} is defined but appears in no traceability.json`);
      continue;
    }
    const body = stripCitations(b.body);
    node.label = b.title || body;
    node.text = body || b.title || node.id;
    node.path = rel;
    cites.set(b.id, citationsOf(b.body));
  }
  return { cites, openQuestions, rel };
}

function enrichStories(ctx) {
  const file = path.join(ctx.intentDir, 'inception', 'user-stories', 'stories.md');
  const text = ctx.read(file);
  if (text === undefined) return;
  const rel = ctx.rel(file);
  for (const sec of sections(text, 3)) {
    const h = sec.heading.match(/^(US\d+(?:\.\d+)+)\s+[—–-]\s+(.+?)(?:\s+\((Must|Should|Could|Won't)\))?(?:\s+[—–-]\s+.*)?$/);
    if (!h) continue;
    const node = ctx.nodes.get(h[1]);
    if (node) {
      const para = [];
      for (const line of sec.lines) {
        if (!line.trim()) {
          if (para.length) break;
          continue;
        }
        if (/^\s*-\s/.test(line)) break;
        para.push(line.trim());
      }
      node.label = h[2].trim();
      node.text = collapse(para.join(' ')) || node.label;
      node.path = rel;
      if (h[3]) node.priority = h[3];
    }
  }
  for (const b of definitionBullets(text)) {
    if (!/^AC/.test(b.id)) continue;
    const node = ctx.nodes.get(b.id);
    if (!node) continue;
    node.label = node.text = collapse(b.body);
    node.path = rel;
  }
}

// The fenced yaml rule list in rules.md: flat mappings, `>` folded scalars.
function parseRuleYaml(text) {
  const block = String(text).match(/```yaml\r?\n([\s\S]*?)```/);
  if (!block) return [];
  const rules = [];
  let rule;
  let foldKey;
  for (const line of block[1].split(/\r?\n/)) {
    const start = line.match(/^\s*-\s+id:\s*(\S+)/);
    if (start) {
      rule = { id: start[1] };
      rules.push(rule);
      foldKey = undefined;
      continue;
    }
    if (!rule) continue;
    const kv = line.match(/^\s{4}([a-z_]+):\s*(.*)$/);
    if (kv) {
      foldKey = kv[2].trim() === '>' || kv[2].trim() === '|' ? kv[1] : undefined;
      rule[kv[1]] = foldKey ? '' : kv[2].trim();
      continue;
    }
    if (foldKey && line.trim()) rule[foldKey] = collapse(`${rule[foldKey]} ${line.trim()}`);
  }
  return rules;
}

function enrichRules(ctx) {
  const out = new Map();
  for (const dir of unitDirs(ctx)) {
    const file = path.join(dir, 'functional-design', 'rules.md');
    const text = ctx.read(file);
    if (text === undefined) continue;
    const rel = ctx.rel(file);
    const summary = new Map();
    for (const sec of sections(text, 2)) {
      if (!/Rules Summary/i.test(sec.heading)) continue;
      for (const t of tables(sec.lines)) for (const row of t.rows) summary.set(row[0], row[1]);
    }
    const parsed = parseRuleYaml(text);
    if (!parsed.length) ctx.warn(`${rel}: no rule yaml block found; business rules keep their IDs as labels`);
    for (const r of parsed) {
      const node = ctx.nodes.get(r.id);
      if (!node) continue;
      node.label = stripMd(summary.get(r.id) || r.statement || r.id);
      node.text = collapse(r.statement || node.label);
      if (r.category) node.kind = r.category;
      node.path = rel;
      out.set(r.id, { source: r.source || '', unitDir: dir });
    }
  }
  return out;
}

function enrichNfrDetails(ctx) {
  for (const dir of unitDirs(ctx)) {
    const nfrDir = path.join(dir, 'nfr-requirements');
    for (const entry of listEntries(nfrDir)) {
      if (!entry.isFile() || !entry.name.endsWith('-requirements.md')) continue;
      const file = path.join(nfrDir, entry.name);
      const text = ctx.read(file);
      if (text === undefined) continue;
      const category = entry.name.replace(/-requirements\.md$/, '');
      for (const t of tables(text.split(/\r?\n/))) {
        if (!/^ID$/i.test(t.header[0] || '')) continue;
        for (const row of t.rows) {
          const node = ctx.nodes.get(row[0]);
          if (!node || node.type !== 'nfr_detail') continue;
          node.label = node.text = stripMd(row[1] || node.id);
          node.category = category;
          node.path = ctx.rel(file);
        }
      }
    }
  }
}

function enrichComponentsAndUnits(ctx) {
  const comp = path.join(ctx.intentDir, 'inception', 'domain-design', 'components.md');
  const ctext = ctx.read(comp);
  if (ctext !== undefined) {
    // The first table keyed by Component is the summary; later ones (rationale) are not labels.
    const done = new Set();
    for (const t of tables(ctext.split(/\r?\n/))) {
      if (!/^Component$/i.test(t.header[0] || '')) continue;
      for (const row of t.rows) {
        const node = ctx.nodes.get(row[0]);
        if (!node || node.type !== 'component' || done.has(row[0])) continue;
        done.add(row[0]);
        node.label = row[0];
        node.text = stripMd(row[1] || row[0]);
        node.path = ctx.rel(comp);
      }
    }
  }
  const uow = path.join(ctx.intentDir, 'inception', 'units-generation', 'unit-of-work.md');
  const utext = ctx.read(uow);
  if (utext !== undefined) {
    for (const t of tables(utext.split(/\r?\n/))) {
      const h = t.header.map((c) => c.toLowerCase());
      if (h[0] !== 'unit id') continue;
      const nameAt = h.indexOf('name');
      const kindAt = h.indexOf('kind');
      for (const row of t.rows) {
        const node = ctx.nodes.get(row[0]);
        if (!node) continue;
        if (nameAt >= 0) node.label = stripMd(row[nameAt]);
        node.text = node.label;
        if (kindAt >= 0) node.kind = stripMd(row[kindAt]);
        node.path = ctx.rel(uow);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Why chains: [Answer]: blocks in <stage>-questions.md
// ---------------------------------------------------------------------------

function parseQuestions(text) {
  const out = new Map();
  for (const sec of sections(text, 2)) {
    const h = sec.heading.match(/^(Q\d+)\s*(?:[—–-]|\.)\s*(.+)$/);
    if (!h) continue;
    const title = h[2].replace(/[.?]?\s*$/, (m) => (m.includes('?') ? '?' : '')).replace(/`/g, '').trim();
    const options = new Map();
    let answer;
    let lastOption;
    for (const line of sec.lines) {
      const opt = line.match(/^([A-Z])\.\s+(.*)$/);
      if (opt) {
        lastOption = opt[1];
        options.set(opt[1], opt[2]);
        continue;
      }
      const ans = line.match(/^\[Answer\]:\s*(.*)$/);
      if (ans) {
        answer = ans[1].trim();
        lastOption = undefined;
        continue;
      }
      if (lastOption && /^\s+\S/.test(line)) options.set(lastOption, `${options.get(lastOption)} ${line.trim()}`);
      else lastOption = undefined;
    }
    if (answer && /^[A-Z](?:\s*,\s*[A-Z])*$/.test(answer)) {
      answer = answer
        .split(/\s*,\s*/)
        .map((letter) => (options.has(letter) ? `${letter}. ${stripMd(options.get(letter))}` : letter))
        .join('; ');
    }
    out.set(h[1], { q: title, a: answer ? collapse(answer) : undefined });
  }
  return out;
}

function questionsFor(ctx, cache, stageDir, stage) {
  if (cache.has(stageDir)) return cache.get(stageDir);
  const file = path.join(stageDir, `${stage}-questions.md`);
  const text = ctx.read(file);
  const value = { map: text === undefined ? new Map() : parseQuestions(text), rel: ctx.rel(file) };
  cache.set(stageDir, value);
  return value;
}

function buildWhy(ctx, requirements, rules) {
  const cache = new Map();
  const reqStageDir = path.join(ctx.intentDir, 'inception', 'requirements-analysis');
  const contractDir = path.join(ctx.intentDir, 'inception', 'contract-design');
  const qEntry = (ref, stage, stageDir) => {
    const qs = questionsFor(ctx, cache, stageDir, stage);
    const hit = qs.map.get(ref);
    if (!hit) return { ref, stage };
    return { ref, stage, q: hit.q, a: hit.a, path: qs.rel };
  };

  for (const [id, refs] of requirements.cites || []) {
    const why = [];
    for (const ref of refs) {
      if (/^Q\d+$/.test(ref)) why.push(qEntry(ref, 'requirements-analysis', reqStageDir));
      else if (!ID_TOKEN.test(ref)) why.push({ ref, stage: 'upstream artifact' });
    }
    if (why.length) ctx.nodes.get(id).why = why;
  }

  for (const [id, { source, unitDir }] of rules) {
    const why = [];
    let contract = false;
    for (const token of splitList(source)) {
      const m = token.match(/^(contract\s+)?(O?Q\d+)$/i);
      if (!m) {
        contract = false;
        continue;
      }
      if (m[1]) contract = true;
      const ref = m[2].toUpperCase();
      if (ref.startsWith('OQ')) {
        const text = requirements.openQuestions && requirements.openQuestions.get(ref);
        why.push({ ref, stage: 'open question from requirements', q: text, path: text ? requirements.rel : undefined });
      } else if (contract) {
        why.push(qEntry(ref, 'contract-design', contractDir));
      } else {
        why.push(qEntry(ref, 'functional-design', path.join(unitDir, 'functional-design')));
      }
    }
    if (why.length) ctx.nodes.get(id).why = why.map((w) => Object.fromEntries(Object.entries(w).filter(([, v]) => v !== undefined)));
  }
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

function setVerdict(ctx, id, verdict, source, override) {
  const node = ctx.nodes.get(id);
  if (!node) return;
  if (node.verdict && !override) return;
  node.verdict = verdict;
  node.verdictSource = source;
}

function readVerdicts(ctx) {
  const bt = path.join(ctx.intentDir, 'construction', 'build-and-test');

  // test-results.md "Final target verdicts": `- Met: NFR1.1, NFR3.1/NFR3.5, ...`
  const results = path.join(bt, 'test-results.md');
  const rtext = ctx.read(results);
  if (rtext !== undefined) {
    const rel = ctx.rel(results);
    for (const sec of sections(rtext, 2)) {
      if (!/final target verdicts/i.test(sec.heading)) continue;
      for (const line of sec.lines) {
        const m = line.match(/^\s*-\s+([^:]+):\s*(.+)$/);
        if (!m) continue;
        const verdict = m[1].trim();
        for (const piece of m[2].split(/\s*,\s*|\s+and\s+/)) {
          const tok = piece.match(/^[A-Z][A-Z0-9-]*(?:\.\d+)*(?:\/[A-Z][A-Z0-9-]*(?:\.\d+)*)*/);
          if (!tok) continue;
          // What follows the ID on its own piece: "(99.9% over 30 days needs production
          // traffic)" or ". The COUNT scan ... accepted at NFR Design."
          const rest = collapse(piece.slice(tok[0].length).trim().replace(/^\s*[.:]\s*/, '').replace(/^\((.*)\)\.?$/, '$1'));
          for (const id of tok[0].split('/')) {
            setVerdict(ctx, id, verdict, rel, true);
            const node = ctx.nodes.get(id);
            if (node && rest && /^[A-Z0-9(]/.test(rest)) node.verdictNote = rest;
          }
        }
      }
    }
    // "**Decision: Accept failure.**" followed by bullets naming the accepted IDs.
    let accepting = false;
    for (const line of rtext.split(/\r?\n/)) {
      if (/Decision:\s*Accept failure/i.test(line)) {
        accepting = true;
        continue;
      }
      if (!accepting) continue;
      const b = line.match(/^\s+-\s+([A-Z][A-Z0-9-]*(?:\.\d+)*)\b/);
      if (b) {
        const node = ctx.nodes.get(b[1]);
        if (node && node.verdict) node.verdictAccepted = true;
      } else if (line.trim() && !/^\s/.test(line)) {
        accepting = false;
      }
    }
  }

  // A later stage that took over a target: tables with "Before this stage" /
  // "After this stage" columns (ci-pipeline/quality-gates.md). Applied only when
  // the Before cell starts with the verdict the node already has, so the later
  // record supersedes exactly the verdict it says it started from.
  const construction = path.join(ctx.intentDir, 'construction');
  for (const stageDir of listEntries(construction)) {
    if (!stageDir.isDirectory() || stageDir.name === 'build-and-test' || !ctx.stageSlugs.has(stageDir.name)) continue;
    for (const entry of listEntries(path.join(construction, stageDir.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = path.join(construction, stageDir.name, entry.name);
      const text = readText(file);
      if (!text || !/After this stage/i.test(text)) continue;
      for (const t of tables(text.split(/\r?\n/))) {
        const h = t.header.map((c) => c.toLowerCase());
        const before = h.findIndex((c) => c.startsWith('before'));
        const after = h.findIndex((c) => c.startsWith('after'));
        if (before < 0 || after < 0) continue;
        for (const row of t.rows) {
          const id = (stripMd(row[0]).match(/^[A-Z][A-Z0-9-]*(?:\.\d+)*/) || [])[0];
          const node = id && ctx.nodes.get(id);
          if (!node || !node.verdict) continue;
          const was = stripMd(row[before] || '');
          if (!was.toLowerCase().startsWith(node.verdict.toLowerCase())) continue;
          const now = stripMd(row[after] || '');
          const verdict = now.split(/\s*[(;]/)[0].trim();
          if (!verdict) continue;
          ctx.sources.add(ctx.rel(file));
          node.verdictPrior = { verdict: node.verdict, source: node.verdictSource };
          node.verdict = verdict;
          node.verdictSource = ctx.rel(file);
          node.verdictNote = now;
          delete node.verdictAccepted;
        }
      }
    }
  }

  // cross-unit-traceability.md: covered / uncovered tables.
  const cross = path.join(bt, 'cross-unit-traceability.md');
  const ctext = ctx.read(cross);
  if (ctext !== undefined) {
    const rel = ctx.rel(cross);
    for (const sec of sections(ctext, 2)) {
      const uncovered = /^uncovered/i.test(sec.heading);
      const coveredHeading = /covered/i.test(sec.heading) && !uncovered;
      for (const t of tables(sec.lines)) {
        const coveredCol = t.header.findIndex((c) => /^covered$/i.test(c));
        for (const row of t.rows) {
          let verdict;
          if (uncovered) verdict = 'Not covered';
          else if (coveredCol >= 0) verdict = /^yes/i.test(row[coveredCol] || '') ? 'Covered' : 'Not covered';
          else if (coveredHeading) verdict = 'Covered';
          if (!verdict) continue;
          for (const id of expandIds(row[0])) setVerdict(ctx, id, verdict, rel, uncovered);
        }
      }
    }
  }

  // Deferred NFR details: nfr-requirements `reverse` rows with status Deferred.
  for (const node of ctx.nodes.values()) {
    if (node.verdict || !node.notes) continue;
    const deferred = node.notes.find((n) => n.stage === 'nfr-requirements' && n.status === 'Deferred');
    if (deferred) {
      node.verdict = 'Deferred';
      node.verdictSource = deferred.origin;
    }
  }
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

function boldField(text, name) {
  const m = String(text).match(new RegExp(`^\\*\\*${name}:?\\*\\*:?[ \\t]*(.+)$`, 'm'));
  return m ? m[1].trim() : undefined;
}

function severityCounts(findings) {
  const counts = { critical: 0, major: 0, minor: 0 };
  for (const f of findings) {
    const s = String(f.severity || '').toLowerCase();
    if (s in counts) counts[s]++;
  }
  return counts;
}

// Findings rows of a markdown `## Review` section: every table under
// `### Findings` that has a Severity column.
function markdownFindings(reviewText) {
  const findings = [];
  for (const sec of sections(reviewText, 3)) {
    if (!/^findings/i.test(sec.heading)) continue;
    for (const t of tables(sec.lines)) {
      const h = t.header.map((c) => c.toLowerCase());
      const sev = h.indexOf('severity');
      if (sev < 0) continue;
      const col = (name) => h.indexOf(name);
      for (const row of t.rows) {
        findings.push({
          id: col('id') >= 0 ? row[col('id')] : row[0],
          severity: row[sev],
          status: col('status') >= 0 ? row[col('status')] : undefined,
          location: col('location') >= 0 ? row[col('location')] : undefined,
          finding: col('finding') >= 0 ? row[col('finding')] : undefined
        });
      }
    }
  }
  return findings;
}

// The `## Review` section of a markdown file, if it has one.
function reviewLine(text) {
  const lines = String(text).split(/\r?\n/);
  const at = lines.findIndex((l) => /^## Review\b/.test(l));
  return at >= 0 ? at + 1 : undefined;
}

function reviewSection(text) {
  const sec = sections(text, 2).find((s) => /^Review\b/.test(s.heading));
  return sec ? sec.lines.join('\n') : undefined;
}

function walkFiles(dir, accept, depth = 0, out = []) {
  if (depth > 8) return out;
  for (const entry of listEntries(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, accept, depth + 1, out);
    else if (entry.isFile() && accept(full, entry.name)) out.push(full);
  }
  return out;
}

function readEngineReviews(ctx) {
  const root = path.join(ctx.intentDir, '.aidlc-engine', 'reviews');
  const reviews = [];
  const files = walkFiles(root, (full, name) => name.endsWith('.json') && name !== 'latest.json' && !full.includes(`${path.sep}briefs${path.sep}`));
  for (const file of files.sort()) {
    const rel = ctx.rel(file);
    const text = ctx.read(file);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      ctx.warn(`${rel}: review record is not valid JSON; skipped`);
      continue;
    }
    if (!data || typeof data.verdict !== 'string') {
      ctx.warn(`${rel}: review record has no verdict; skipped`);
      continue;
    }
    const parts = toPosix(path.relative(root, file)).split('/');
    const stage = typeof data.stage === 'string' ? data.stage : parts[0];
    const unit = typeof data.unit === 'string' ? data.unit : parts[1] === 'units' ? parts[2] : undefined;
    const findings = (Array.isArray(data.findings) ? data.findings : []).filter(Boolean).map((f) => ({
      id: f.id,
      severity: f.severity,
      status: f.status,
      location: f.location,
      finding: f.finding,
      requiredAction: f.required_action
    }));
    const body = typeof data.body === 'string' ? data.body : '';
    const iteration = Number(data.iteration);
    reviews.push({
      id: `review:${stage}:${unit || 'stage'}:${data.attempt || parts[parts.length - 2]}:${Number.isFinite(iteration) ? iteration : parts[parts.length - 1]}`,
      stage,
      unit,
      verdict: data.verdict,
      date: boldField(body, 'Date') || data.recorded_at,
      recordedAt: data.recorded_at,
      iteration: Number.isFinite(iteration) ? iteration : undefined,
      reviewer: data.reviewer,
      attempt: data.attempt,
      file: rel,
      source: rel,
      sourceKind: 'engine-json',
      ...severityCounts(findings),
      open: findings.filter((f) => OPEN_FINDING.has(f.status)).length,
      findings
    });
  }
  return reviews;
}

function readMarkdownReviews(ctx, engineReviews) {
  const engineByDate = new Map(engineReviews.filter((r) => r.date).map((r) => [`${r.stage}|${r.date}`, r]));
  const out = [];
  const files = walkFiles(ctx.intentDir, (full, name) => {
    if (!name.endsWith('.md')) return false;
    const relToIntent = toPosix(path.relative(ctx.intentDir, full));
    return !relToIntent.split('/').some((seg) => seg.startsWith('.')) && !relToIntent.startsWith('audit/');
  });
  for (const file of files.sort()) {
    const text = readText(file);
    if (!text || !/^## Review\b/m.test(text)) continue;
    const section = reviewSection(text);
    const verdict = section && boldField(section, 'Verdict');
    if (!verdict) continue;
    ctx.sources.add(ctx.rel(file));
    const date = boldField(section, 'Date');
    const relToIntent = toPosix(path.relative(ctx.intentDir, file)).split('/');
    // <phase>/<stage>/... or construction/<unit>/<stage>/...
    let stage = relToIntent[1];
    let unit;
    if (relToIntent[0] === 'construction' && !ctx.stageSlugs.has(relToIntent[1]) && relToIntent.length > 3) {
      unit = relToIntent[1];
      stage = relToIntent[2];
    }
    const mirror = engineByDate.get(`${stage}|${date}`);
    if (mirror) {
      // The engine wrote this file from its JSON record: point the record at it.
      if (path.basename(path.dirname(file)) === 'reviews') {
        mirror.file = ctx.rel(file);
        mirror.line = reviewLine(text);
      }
      continue;
    }
    const findings = markdownFindings(section);
    const iteration = Number(boldField(section, 'Iteration'));
    out.push({
      id: `review:md:${ctx.rel(file)}`,
      stage,
      unit,
      verdict,
      date,
      iteration: Number.isFinite(iteration) ? iteration : undefined,
      reviewer: boldField(section, 'Reviewer'),
      file: ctx.rel(file),
      line: reviewLine(text),
      source: ctx.rel(file),
      sourceKind: 'markdown',
      ...severityCounts(findings),
      open: null,
      findings
    });
  }
  return out;
}

function readReviews(ctx) {
  const engine = readEngineReviews(ctx);
  const markdown = readMarkdownReviews(ctx, engine);
  return [...engine, ...markdown].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
}

// ---------------------------------------------------------------------------
// Backward jump (audit ledger)
// ---------------------------------------------------------------------------

function readJump(ctx) {
  const jumps = [];
  for (const shard of listShardPaths(ctx.intentDir)) {
    const text = ctx.read(shard);
    if (!text) continue;
    let changeRequest;
    for (const record of text.split(/\r?\n---\r?\n/)) {
      const heading = (record.match(/^## (.+)$/m) || [])[1];
      if (heading && /^Change Request\b/.test(heading)) {
        changeRequest = {
          title: heading.replace(/^Change Request:?\s*/, '').trim(),
          request: field(record, 'Request'),
          impact: field(record, 'Impact Assessment')
        };
        continue;
      }
      if (field(record, 'Event') !== 'STAGE_JUMPED') continue;
      const direction = field(record, 'Direction') || '';
      const details = field(record, 'Details');
      const cr = changeRequest;
      changeRequest = undefined;
      if (direction.toUpperCase() !== 'BACKWARD') continue;
      jumps.push({
        ts: field(record, 'Timestamp'),
        direction,
        source: field(record, 'Source'),
        target: field(record, 'Target'),
        changed: safeJsonArray(field(record, 'Changed Upstream Artifacts')),
        invalidated: safeJsonArray(field(record, 'Invalidated Downstream Artifacts')),
        invalidated_reviews: safeJsonArray(field(record, 'Invalidated Downstream Reviews')),
        reason: (cr && cr.title) || details || '',
        details,
        request: cr && cr.request,
        impact: cr && cr.impact,
        origin: ctx.rel(shard)
      });
    }
  }
  if (jumps.length > 1) ctx.warn(`audit records ${jumps.length} backward jumps; the latest is shown`);
  jumps.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  return jumps.length ? jumps[jumps.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Drift: findings still open in each stage's final engine review
// ---------------------------------------------------------------------------

function readDrift(ctx, reviews) {
  const finalReview = new Map();
  for (const r of reviews) {
    if (r.sourceKind !== 'engine-json') continue;
    const key = `${r.stage}|${r.unit || ''}`;
    const prev = finalReview.get(key);
    const stamp = (x) => String(x.recordedAt || x.date || '');
    if (!prev || stamp(r) >= stamp(prev)) finalReview.set(key, r);
  }
  const drift = [];
  for (const r of finalReview.values()) {
    for (const f of r.findings) {
      if (!OPEN_FINDING.has(f.status)) continue;
      const location = f.location || '';
      const idsIn = (s) => [...new Set(String(s).match(ID_IN_TEXT) || [])].filter((id) => ctx.nodes.has(id));
      let ids = idsIn(location);
      if (!ids.length) ids = idsIn(f.finding);
      const fileMatch = location.match(/(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+/);
      const file = fileMatch && exists(path.join(ctx.root, fileMatch[0])) ? fileMatch[0] : null;
      drift.push({
        id: ids[0] || null,
        ids,
        file,
        note: collapse(f.finding),
        location,
        stage: r.stage,
        unit: r.unit,
        severity: f.severity,
        findingId: f.id,
        status: f.status,
        review: r.id,
        requiredAction: f.requiredAction
      });
    }
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const OMITTED = [
  { field: 'gitlab', reason: 'No git remote is recorded in the project files, and this reader does not run git.' },
  { field: 'nodes[].gitref', reason: 'Needs git history; the reader does not run git.' },
  { field: 'nodes[].why (user_story, acceptance_criterion, nfr_detail, component, unit, design_decision, code, test)', reason: 'These artifacts carry no [Qn] citation the reader can resolve; only requirements.md bullets and rules.md `source:` cite questions.' },
  { field: 'nodes[].verdict (user_story, business_rule, component, unit, design_decision, note, code, test)', reason: 'Build-and-test records verdicts only for FR, AC, NFR groups and NFR details; per-file test results are aggregate only.' },
  { field: 'drift as "documentation drift"', reason: 'The engine has no drift record. drift[] lists findings left New/Unresolved in each stage\'s final engine review; which of them are stale documents is a human reading.' },
  { field: 'edge rework flags', reason: 'The jump invalidates files, not links; rework is set on nodes whose defining file was invalidated.' }
];

function resolveIntent(root, options, warn) {
  const spaces = options.space ? [options.space] : listSpaces(root);
  const all = [];
  for (const space of spaces) {
    for (const intent of listIntents(root, space).intents) all.push({ space, ...intent });
  }
  if (options.intent) {
    const hit = all.find((i) => i.id === options.intent || i.slug === options.intent);
    if (hit) return hit;
    warn(`intent "${options.intent}" not found`);
    return undefined;
  }
  if (all.length === 0) {
    warn('no intents found under aidlc/spaces');
    return undefined;
  }
  all.sort((a, b) => a.id.localeCompare(b.id));
  if (all.length > 1) warn(`several intents found; showing ${all[all.length - 1].id}`);
  return all[all.length - 1];
}

function countBy(list, key) {
  const out = {};
  for (const item of list) out[item[key]] = (out[item[key]] || 0) + 1;
  return out;
}

function emptyData(root, warnings, intent = '') {
  return {
    meta: {
      intent,
      intentPath: '',
      generated: new Date().toISOString(),
      generator: GENERATOR,
      sources: [],
      listedDirs: [],
      stageOrder: [],
      derived_edge_rules: DERIVED_EDGE_RULES.slice(),
      omitted: OMITTED.map((o) => ({ ...o })),
      warnings,
      gaps: [],
      counts: { nodesByType: {}, edgesByRelation: {} }
    },
    repo: root,
    nodes: [],
    edges: [],
    reviews: [],
    jump: null,
    drift: []
  };
}

/**
 * Read the trace data of one intent.
 * @param {string} projectRoot  Absolute path of the opened project.
 * @param {{intent?: string, space?: string}} [options]
 * @returns {TraceData}
 */
function readTraceData(projectRoot, options = {}) {
  const warnings = [];
  const root = path.resolve(String(projectRoot || '.'));
  let intent;
  try {
    intent = resolveIntent(root, options || {}, (m) => warnings.push(m));
  } catch (err) {
    warnings.push(`could not list intents: ${err.message}`);
  }
  if (!intent) return emptyData(root, warnings, (options && options.intent) || '');

  const ctx = createContext(root, intent.dir);
  ctx.warnings = warnings;
  const step = (name, fn, fallback) => {
    try {
      return fn();
    } catch (err) {
      ctx.warn(`${name} failed: ${err.message}`);
      return fallback;
    }
  };

  step('stage list', () => collectStageSlugs(ctx));
  const files = step('traceability search', () => findTraceabilityFiles(intent.dir), []);
  if (files.length === 0) ctx.warn('no traceability.json found under the intent; the graph is empty');
  for (const file of files) step(ctx.rel(file), () => readTraceabilityFile(ctx, file));

  const testFiles = step('test file listing', () => findTestFiles(ctx), []);
  step('test convention', () => deriveTests(ctx, testFiles));
  step('acceptance-criteria convention', () => deriveAcceptanceCriteria(ctx));

  const requirements = step('requirements.md', () => enrichRequirements(ctx), { cites: new Map(), openQuestions: new Map() });
  step('stories.md', () => enrichStories(ctx));
  const rules = step('rules.md', () => enrichRules(ctx), new Map());
  step('nfr requirements', () => enrichNfrDetails(ctx));
  step('components and units', () => enrichComponentsAndUnits(ctx));
  step('why chains', () => buildWhy(ctx, requirements, rules));
  step('verdicts', () => readVerdicts(ctx));

  const reviews = step('reviews', () => readReviews(ctx), []);
  const jump = step('backward jump', () => readJump(ctx), null);
  if (jump) {
    const invalidated = new Set(jump.invalidated);
    for (const node of ctx.nodes.values()) if (invalidated.has(node.path)) node.rework = true;
  }
  const drift = step('drift', () => readDrift(ctx, reviews), []);

  for (const node of ctx.nodes.values()) {
    if (node.type === 'unknown') ctx.warn(`${node.id}: type could not be inferred`);
  }
  const nodes = [...ctx.nodes.values()];
  return {
    meta: {
      intent: intent.id,
      space: intent.space,
      intentPath: ctx.rel(intent.dir),
      generated: new Date().toISOString(),
      generator: GENERATOR,
      sources: [...ctx.sources].sort(),
      listedDirs: [...ctx.listedDirs].sort(),
      stageOrder: ctx.stageOrder.slice(),
      derived_edge_rules: DERIVED_EDGE_RULES.slice(),
      omitted: OMITTED.map((o) => ({ ...o })),
      warnings: ctx.warnings,
      gaps: ctx.gaps,
      counts: { nodesByType: countBy(nodes, 'type'), edgesByRelation: countBy(ctx.edges, 'relation') }
    },
    repo: root,
    nodes,
    edges: ctx.edges,
    reviews,
    jump,
    drift
  };
}

module.exports = {
  readTraceData,
  STAGE_RULES,
  DERIVED_AC_RULE,
  DERIVED_TEST_RULE,
  // exposed for tests
  _internal: { expandIds, parseQuestions, parseRuleYaml, definitionBullets, typeFromId }
};
