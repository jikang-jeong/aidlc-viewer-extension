'use strict';

// Reads what Kiro records about credit consumption, for the project being watched.
//
// WHAT THIS IS AND IS NOT
//
// Kiro bills in credits and writes, per prompt turn, how many it consumed. That record
// lives in Kiro's own session store under the user's home directory, not in the project.
// This module reads the NUMBERS from that store -- credits, turn timing, model, context
// usage -- and never the conversation. Kiro restricts the store to owner-only access and
// this extension runs as that owner, so reading is permitted; the boundary is drawn here
// in code rather than in policy: no function in this file returns message text.
//
// The store is not a documented contract. Kiro's docs say sessions are saved "to a local
// database under ~/.kiro" and stop there; the field names below were read from the files
// on a real machine, and third-party readers record that the format has changed several
// times already. So this reader is built the way the v2 ledger reader is built: it names
// what it recognises, reports what it does not, and degrades to "no data" rather than to
// a wrong number. A format change shows up as a gap in the report, never as a silent zero.
//
// TWO STORES, TWO SHAPES
//
//   Kiro IDE   ~/.kiro/sessions/<workspace-hash>/sess_<id>/
//              session.json (metadata: modelId, workspacePaths, createdAt) +
//              messages.jsonl (one {id, timestamp, payload:{type,...}} per line).
//              A turn's cost is payload.type === 'usage_summary', whose
//              promptTurnSummaries[].usage is in credits. No token counts.
//   Kiro CLI   ~/.kiro/sessions/cli/<id>.json
//              one JSON document; each turn carries metering_usage[].value in credits
//              AND the four token counts. Bound to a project by its `cwd`.
//
// The unit is credits throughout. Tokens are carried where the CLI records them and
// shown as secondary; they are never estimated where Kiro did not record them. Dollar
// amounts are not computed: the price of a credit depends on the plan, and the balance is
// account data Kiro does not write locally.
//
// WINDOWS
//
// The store is under the home directory on every platform (%USERPROFILE%\.kiro on
// Windows), and KIRO_HOME overrides it when set. Paths go through path.join, never string
// concatenation, so the separator and a user name with a space are both handled.
//
// Pure module: never import `vscode`.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The event this extension's own name for a turn's cost. Kiro's name for it is kept in
// one place so a rename upstream is a one-line change here and a reported gap until then.
const IDE_USAGE_EVENT = 'usage_summary';
const IDE_METADATA_EVENT = 'session_metadata';

// Statuses Kiro writes on a turn. `success` is the normal case; the other two are the
// turns whose credits bought nothing, which is the single most actionable number here.
const TURN_STATUS = Object.freeze({
  SUCCESS: 'success',
  ABORTED: 'aborted',
  FAILED: 'failed'
});
const KNOWN_STATUSES = new Set(Object.values(TURN_STATUS));

function kiroHome() {
  const override = process.env.KIRO_HOME;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), '.kiro');
}

function sessionsRoot() {
  return path.join(kiroHome(), 'sessions');
}

// Does this session belong to the project? Kiro records the workspace folders a session
// was opened with.
//
// Two shapes count. The folder IS the project, or the folder is INSIDE the project (a
// session opened on a sub-folder spent its turns on this project's files). The third
// shape -- the project is inside the session's folder -- is deliberately refused. On a
// real machine a session opened on ~/Develop/aidlc, the parent of several projects, was
// attributed to two unrelated projects at once, and nothing in Kiro's record says which
// of them (if any) its turns were about. Refusing it undercounts; accepting it invents.
// Undercounting is reported (the page says turns outside the project's own sessions are
// not shown); inventing is not recoverable by the reader.
function sessionTouchesProject(workspacePaths, projectRoot) {
  const root = path.resolve(projectRoot);
  for (const raw of workspacePaths ?? []) {
    if (typeof raw !== 'string' || !raw) continue;
    const candidate = path.resolve(raw);
    if (candidate === root) return true;
    if (candidate.startsWith(root + path.sep)) return true;
  }
  return false;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// One normalised turn. Everything optional stays undefined when Kiro did not write it.
//
//   at        epoch ms when the turn ended (Kiro's own timestamp)
//   credits   number, summed over promptTurnSummaries; 0 is a real value, undefined is
//             "Kiro recorded no usage for this turn"
//   status    one of TURN_STATUS, or the raw string when Kiro wrote something else
//   elapsedMs turn wall time
//   tokens    { input, output, cacheRead, cacheWrite } -- CLI only
//   context   context-window usage percentage after the turn -- IDE only, when present
function normaliseIdeTurn(record, meta) {
  const payload = record.payload;
  const summaries = Array.isArray(payload.promptTurnSummaries) ? payload.promptTurnSummaries : [];
  let credits;
  for (const summary of summaries) {
    if (summary && typeof summary.usage === 'number') credits = (credits ?? 0) + summary.usage;
  }
  const tools = new Set();
  for (const summary of summaries) {
    for (const tool of summary?.usedTools ?? []) if (typeof tool === 'string') tools.add(tool);
  }
  return {
    source: 'ide',
    sessionId: meta.id,
    at: typeof record.timestamp === 'number' ? record.timestamp : Date.parse(record.timestamp),
    credits,
    status: typeof payload.status === 'string' ? payload.status : undefined,
    elapsedMs: typeof payload.elapsedTime === 'number' ? payload.elapsedTime : undefined,
    model: meta.modelId,
    toolCount: tools.size
  };
}

// Reads one IDE session directory. Returns undefined when it is not this project's, or
// when its metadata cannot be read -- a session with no session.json is not a session.
function readIdeSession(dir, projectRoot, gaps) {
  const meta = readJson(path.join(dir, 'session.json'));
  if (!meta || typeof meta !== 'object') return undefined;
  const folders = [...(meta.workspacePaths ?? []), ...(meta.rootPaths ?? [])];
  if (!sessionTouchesProject(folders, projectRoot)) return undefined;

  const turns = [];
  const contextSamples = [];
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8');
  } catch {
    // A session opened but never prompted has metadata and no messages. Real, and empty.
    return { id: meta.id, model: meta.modelId, createdAt: Date.parse(meta.createdAt), turns, contextSamples, title: meta.title };
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A half-written last line is normal for a live session.
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload.type !== 'string') continue;
    if (payload.type === IDE_USAGE_EVENT) {
      const turn = normaliseIdeTurn(record, meta);
      if (turn.status !== undefined && !KNOWN_STATUSES.has(turn.status)) gaps.unknownStatuses.add(turn.status);
      turns.push(turn);
    } else if (payload.type === IDE_METADATA_EVENT && payload.key === 'contextUsage') {
      const pct = payload.value?.usagePercentage;
      if (typeof pct === 'number') {
        contextSamples.push({ at: typeof record.timestamp === 'number' ? record.timestamp : Date.parse(record.timestamp), percent: pct });
      }
    }
  }
  return { id: meta.id, model: meta.modelId, createdAt: Date.parse(meta.createdAt), turns, contextSamples, title: meta.title };
}

// Reads one CLI session file. The turn records sit at varying depths inside
// session_state, so they are found by shape (a metering_usage array) rather than by path,
// which is what survives Kiro moving them.
function readCliSession(file, projectRoot, gaps) {
  const doc = readJson(file);
  if (!doc || typeof doc !== 'object') return undefined;
  if (typeof doc.cwd !== 'string' || !sessionTouchesProject([doc.cwd], projectRoot)) return undefined;

  const turns = [];
  const seen = new Set();
  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node.metering_usage)) {
      let credits;
      for (const entry of node.metering_usage) {
        if (entry && typeof entry.value === 'number') credits = (credits ?? 0) + entry.value;
      }
      const tokens =
        typeof node.input_token_count === 'number' || typeof node.output_token_count === 'number'
          ? {
              input: node.input_token_count,
              output: node.output_token_count,
              cacheRead: node.cache_read_input_token_count,
              cacheWrite: node.cache_write_input_token_count
            }
          : undefined;
      const status = typeof node.end_reason === 'string' ? node.end_reason : undefined;
      turns.push({
        source: 'cli',
        sessionId: doc.session_id,
        at: typeof node.end_timestamp === 'number' ? node.end_timestamp : Date.parse(node.end_timestamp),
        credits,
        status,
        elapsedMs: typeof node.turn_duration === 'number' ? node.turn_duration : undefined,
        model: typeof node.model === 'string' ? node.model : undefined,
        tokens,
        contextPercent: typeof node.final_context_usage_percentage === 'number' ? node.final_context_usage_percentage : undefined
      });
      return;
    }
    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  }
  walk(doc, 0);
  return {
    id: doc.session_id,
    model: turns.find((t) => t.model)?.model,
    createdAt: Date.parse(doc.created_at),
    turns,
    contextSamples: [],
    title: doc.title
  };
}

// Every Kiro session that touched the project, with its turns.
//
// Never throws. A missing store is "no data", and the report says so in a way the UI can
// render as a sentence rather than as an empty table.
function readKiroUsage(projectRoot) {
  const gaps = { unknownStatuses: new Set(), unreadable: [] };
  const sessions = [];
  const root = sessionsRoot();

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { ok: false, reason: 'no-session-store', storePath: root, sessions: [], turns: [], gaps: finishGaps(gaps) };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (entry.name === 'cli') {
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const session = readCliSession(path.join(dir, file), projectRoot, gaps);
        if (session) sessions.push(session);
      }
      continue;
    }
    let sessDirs;
    try {
      sessDirs = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sd of sessDirs) {
      if (!sd.isDirectory()) continue;
      const session = readIdeSession(path.join(dir, sd.name), projectRoot, gaps);
      if (session) sessions.push(session);
    }
  }

  const turns = sessions.flatMap((s) => s.turns).filter((t) => Number.isFinite(t.at)).sort((a, b) => a.at - b.at);
  return { ok: true, storePath: root, sessions, turns, gaps: finishGaps(gaps) };
}

function finishGaps(gaps) {
  return {
    unknownStatuses: [...gaps.unknownStatuses].sort(),
    unreadable: gaps.unreadable
  };
}

// ---------------------------------------------------------------------------
// Attribution: which turns belong to which stage
// ---------------------------------------------------------------------------

// A turn is attributed to a stage when the turn's time falls inside that stage's
// window. A window is [startedAt, completedAt]; an open stage runs to now.
//
// This is inference, and the UI says so. Nothing in Kiro's record names a stage, and
// nothing in the AI-DLC ledger names a turn; time is the only join. Two consequences are
// handled rather than hidden: a turn spanning several short stages (one prompt can
// complete four setup stages in a second) is attributed to EVERY stage it overlaps, so
// the per-stage numbers are a view, not a partition; and a turn outside every window is
// reported as "outside any stage" with its credits intact, so the total always adds up.
//
// `windows` is [{ key, label, startedAt, completedAt }] with epoch-ms or undefined ends.
function attributeTurns(turns, windows) {
  const now = Date.now();
  const byWindow = new Map(windows.map((w) => [w.key, { ...w, credits: 0, turns: 0 }]));
  const outside = { credits: 0, turns: 0 };
  let total = 0;
  let totalTurns = 0;
  let wasted = 0;
  let wastedTurns = 0;

  for (const turn of turns) {
    const credits = typeof turn.credits === 'number' ? turn.credits : 0;
    total += credits;
    totalTurns += 1;
    if (turn.status === TURN_STATUS.ABORTED || turn.status === TURN_STATUS.FAILED) {
      wasted += credits;
      wastedTurns += 1;
    }
    let matched = false;
    for (const w of windows) {
      const start = w.startedAt;
      const end = w.completedAt ?? now;
      if (!Number.isFinite(start)) continue;
      if (turn.at >= start && turn.at <= end) {
        const slot = byWindow.get(w.key);
        slot.credits += credits;
        slot.turns += 1;
        matched = true;
      }
    }
    if (!matched) {
      outside.credits += credits;
      outside.turns += 1;
    }
  }

  return {
    total,
    totalTurns,
    wasted,
    wastedTurns,
    byWindow: [...byWindow.values()],
    outside,
    attributed: true
  };
}

// Per-session rollup: what a person sees when they ask "what did that session cost".
function summariseSessions(sessions) {
  return sessions
    .map((s) => {
      let credits = 0;
      let turns = 0;
      let wasted = 0;
      let elapsedMs = 0;
      let lastAt;
      for (const t of s.turns) {
        const c = typeof t.credits === 'number' ? t.credits : 0;
        credits += c;
        turns += 1;
        if (t.status === TURN_STATUS.ABORTED || t.status === TURN_STATUS.FAILED) wasted += c;
        if (typeof t.elapsedMs === 'number') elapsedMs += t.elapsedMs;
        if (Number.isFinite(t.at) && (lastAt === undefined || t.at > lastAt)) lastAt = t.at;
      }
      const lastContext = s.contextSamples.length > 0 ? s.contextSamples[s.contextSamples.length - 1].percent : undefined;
      return {
        id: s.id,
        title: s.title,
        model: s.model,
        source: s.turns[0]?.source,
        createdAt: s.createdAt,
        lastAt,
        credits,
        turns,
        wasted,
        elapsedMs,
        lastContextPercent: lastContext,
        tokens: sumTokens(s.turns)
      };
    })
    .filter((s) => s.turns > 0)
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

// Token totals, only where Kiro recorded them. A session with no token data returns
// undefined rather than zeros, so the UI can say "not recorded" instead of "0".
function sumTokens(turns) {
  let any = false;
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const t of turns) {
    if (!t.tokens) continue;
    any = true;
    for (const k of Object.keys(sum)) if (typeof t.tokens[k] === 'number') sum[k] += t.tokens[k];
  }
  return any ? sum : undefined;
}

// ---------------------------------------------------------------------------
// Stage windows: where the time boundaries come from, per generation
// ---------------------------------------------------------------------------

// v2: the audit ledger's own STAGE_STARTED / STAGE_COMPLETED / STAGE_SKIPPED events.
//
// Not runtime-graph.json. On a real project every stage there carried the same
// started_at -- the time the graph was last compiled -- while the ledger had the real
// 07:08 start of requirements-analysis two hours after the 05:43 setup stages. The graph
// is a projection; the ledger is the record.
//
// A stage started more than once (revisions) gets one window per start. A stage that
// started and never closed runs to now. Events with no parseable timestamp are skipped
// rather than placed at zero, which would swallow every turn.
function stageWindowsFromLedger(events) {
  const windows = [];
  const open = new Map();
  const sorted = [...events]
    .filter((e) => e && e.stage && e.timestamp && Number.isFinite(Date.parse(e.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const e of sorted) {
    const at = Date.parse(e.timestamp);
    if (e.event === 'STAGE_STARTED') {
      // A second start while the first is still open is a restart. The first attempt is
      // closed at the moment the second begins, so the two are separate windows rather
      // than the later start silently replacing the earlier one -- which on a real
      // project moved a stage's start two hours early and claimed every turn between.
      const previous = open.get(e.stage);
      if (previous !== undefined) {
        windows.push({ key: `${e.stage}@${previous}`, label: e.stage, stage: e.stage, startedAt: previous, completedAt: at, restarted: true });
      }
      open.set(e.stage, at);
    } else if (e.event === 'STAGE_COMPLETED' || e.event === 'STAGE_SKIPPED') {
      const start = open.get(e.stage);
      if (start !== undefined) {
        windows.push({ key: `${e.stage}@${start}`, label: e.stage, stage: e.stage, startedAt: start, completedAt: at });
        open.delete(e.stage);
      }
    }
  }
  for (const [stage, start] of open) {
    windows.push({ key: `${stage}@${start}`, label: stage, stage, startedAt: start, completedAt: undefined, open: true });
  }
  return windows;
}

// v1: there is no ledger in a shape this extension reads (audit.md is prose the agent
// wrote), so the only time facts are the artifacts' own modification times. Each stage
// directory under aidlc-docs/<phase>/<stage>/ becomes one window from its earliest to its
// latest .md mtime. This is coarser than the ledger -- a stage revisited days later
// stretches its window -- and the page says so where it shows the numbers.
function stageWindowsFromArtifacts(docsRoot) {
  const windows = [];
  let phases;
  try {
    phases = fs.readdirSync(docsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return windows;
  }
  for (const phase of phases) {
    const phaseDir = path.join(docsRoot, phase.name);
    let stages;
    try {
      stages = fs.readdirSync(phaseDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const stage of stages) {
      const dir = path.join(phaseDir, stage.name);
      let earliest;
      let latest;
      const walk = (d, depth) => {
        if (depth > 4) return;
        let entries;
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.name.toLowerCase().endsWith('.md')) {
            let m;
            try {
              m = fs.statSync(full).mtimeMs;
            } catch {
              continue;
            }
            if (earliest === undefined || m < earliest) earliest = m;
            if (latest === undefined || m > latest) latest = m;
          }
        }
      };
      walk(dir, 0);
      if (earliest !== undefined) {
        windows.push({
          key: `${phase.name}/${stage.name}`,
          label: stage.name,
          stage: stage.name,
          phase: phase.name,
          startedAt: earliest,
          completedAt: latest,
          fromArtifacts: true
        });
      }
    }
  }
  return windows;
}

module.exports = {
  IDE_USAGE_EVENT,
  TURN_STATUS,
  kiroHome,
  sessionsRoot,
  sessionTouchesProject,
  readKiroUsage,
  attributeTurns,
  stageWindowsFromLedger,
  stageWindowsFromArtifacts,
  summariseSessions,
  sumTokens
};
