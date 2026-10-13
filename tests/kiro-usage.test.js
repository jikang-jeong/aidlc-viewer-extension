'use strict';

// Pins the Kiro usage reader: what it reads, what it refuses to invent, and how turns are
// attributed to stages.
//
// The session store is Kiro's, not ours, and undocumented beyond "a local database under
// ~/.kiro". Field names here were read from a real machine. So every fixture is hand-built
// to that shape, KIRO_HOME points the reader at it, and the one property under test
// throughout is the same one the ledger reader holds: recognise what you can, report what
// you cannot, never produce a confident wrong number.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const usage = require('../src/aidlc/kiro-usage');

function withStore(build, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const previous = process.env.KIRO_HOME;
  process.env.KIRO_HOME = home;
  try {
    build({ home, project, sessions: path.join(home, 'sessions') });
    return run({ home, project });
  } finally {
    if (previous === undefined) delete process.env.KIRO_HOME;
    else process.env.KIRO_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

function ideSession(sessions, { id, workspace, model = 'claude-opus-4.8', turns = [], context = [] }) {
  const dir = path.join(sessions, 'wshash', `sess_${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    JSON.stringify({ id: `sess_${id}`, modelId: model, workspacePaths: [workspace], createdAt: '2026-10-06T05:00:00.000Z', title: id })
  );
  const lines = [];
  for (const t of turns) {
    lines.push(
      JSON.stringify({
        id: `m-${lines.length}`,
        timestamp: t.at,
        payload: {
          type: 'usage_summary',
          status: t.status ?? 'success',
          elapsedTime: t.elapsedMs ?? 1000,
          promptTurnSummaries: t.credits === undefined ? [] : [{ unit: 'credit', unitPlural: 'credits', usage: t.credits, usedTools: t.tools ?? [] }]
        }
      })
    );
  }
  for (const c of context) {
    lines.push(JSON.stringify({ id: `c-${lines.length}`, timestamp: c.at, payload: { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: c.percent } } }));
  }
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.join('\n') + '\n');
}

function cliSession(sessions, { id, cwd, turns = [] }) {
  const dir = path.join(sessions, 'cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      session_id: id,
      cwd,
      created_at: '2026-10-06T05:00:00Z',
      title: id,
      session_state: {
        history: turns.map((t) => ({
          turn: {
            end_timestamp: t.at,
            end_reason: t.status ?? 'completed',
            turn_duration: t.elapsedMs ?? 1000,
            model: t.model ?? 'claude-opus-4.8',
            input_token_count: t.input ?? 100,
            output_token_count: t.output ?? 50,
            cache_read_input_token_count: 0,
            cache_write_input_token_count: 0,
            metering_usage: [{ value: t.credits, unit: 'credit', unitPlural: 'credits' }]
          }
        }))
      }
    })
  );
}

const T0 = Date.parse('2026-10-06T06:00:00Z');
const min = (n) => T0 + n * 60 * 1000;

// ---------------------------------------------------------------------------
// Which sessions belong to the project
// ---------------------------------------------------------------------------

test('a session opened on the project, or on a folder inside it, belongs to the project', () =>
  withStore(
    ({ sessions, project }) => {
      ideSession(sessions, { id: 'exact', workspace: project, turns: [{ at: min(1), credits: 1 }] });
      ideSession(sessions, { id: 'inside', workspace: path.join(project, 'sub'), turns: [{ at: min(2), credits: 2 }] });
    },
    ({ project }) => {
      const u = usage.readKiroUsage(project);
      assert.equal(u.ok, true);
      assert.equal(u.sessions.length, 2);
      assert.equal(u.turns.reduce((a, t) => a + t.credits, 0), 3);
    }
  ));

test('a session opened on a PARENT of the project is refused, because its turns may be about anything', () =>
  withStore(
    ({ sessions, project }) => {
      // On a real machine a session opened on ~/Develop/aidlc -- parent of several
      // projects -- was attributed to two unrelated projects at once. Undercounting is
      // reported; inventing is not recoverable.
      ideSession(sessions, { id: 'parent', workspace: path.dirname(project), turns: [{ at: min(1), credits: 99 }] });
      ideSession(sessions, { id: 'sibling', workspace: path.join(path.dirname(project), 'other'), turns: [{ at: min(1), credits: 99 }] });
    },
    ({ project }) => {
      const u = usage.readKiroUsage(project);
      assert.equal(u.sessions.length, 0);
    }
  ));

test('a prefix that is not a path boundary does not match', () => {
  assert.equal(usage.sessionTouchesProject(['/a/proj-other'], '/a/proj'), false);
  assert.equal(usage.sessionTouchesProject(['/a/proj/x'], '/a/proj'), true);
  assert.equal(usage.sessionTouchesProject([42, null, ''], '/a/proj'), false);
});

// ---------------------------------------------------------------------------
// What is read, and what is refused
// ---------------------------------------------------------------------------

test('credits come from Kiro, never estimated, and an IDE session has no token counts', () =>
  withStore(
    ({ sessions, project }) => {
      ideSession(sessions, { id: 'a', workspace: project, turns: [{ at: min(1), credits: 6.74 }, { at: min(2), credits: 0 }] });
    },
    ({ project }) => {
      const u = usage.readKiroUsage(project);
      const [s] = usage.summariseSessions(u.sessions);
      assert.equal(s.credits, 6.74);
      assert.equal(s.turns, 2);
      // 0 is a real recorded value, not an absence.
      assert.equal(u.turns[1].credits, 0);
      // No tokens on IDE: undefined, so the UI says "not recorded" rather than "0".
      assert.equal(s.tokens, undefined);
    }
  ));

test('a CLI session carries token counts, and they are summed only where present', () =>
  withStore(
    ({ sessions, project }) => {
      cliSession(sessions, { id: 'c1', cwd: project, turns: [{ at: min(1), credits: 0.07, input: 1000, output: 200 }, { at: min(2), credits: 0.03, input: 500, output: 100 }] });
    },
    ({ project }) => {
      const u = usage.readKiroUsage(project);
      const [s] = usage.summariseSessions(u.sessions);
      assert.equal(s.source, 'cli');
      assert.deepEqual(s.tokens, { input: 1500, output: 300, cacheRead: 0, cacheWrite: 0 });
      assert.ok(Math.abs(s.credits - 0.1) < 1e-9);
    }
  ));

test('aborted and failed turns are counted as wasted, because that is the number a person can act on', () =>
  withStore(
    ({ sessions, project }) => {
      ideSession(sessions, {
        id: 'w',
        workspace: project,
        turns: [
          { at: min(1), credits: 10, status: 'success' },
          { at: min(2), credits: 40, status: 'aborted' },
          { at: min(3), credits: 5, status: 'failed' }
        ]
      });
    },
    ({ project }) => {
      const u = usage.readKiroUsage(project);
      const a = usage.attributeTurns(u.turns, []);
      assert.equal(a.total, 55);
      assert.equal(a.wasted, 45);
      assert.equal(a.wastedTurns, 2);
      assert.deepEqual(u.gaps.unknownStatuses, []);
    }
  ));

test('a status Kiro has not used before is reported, not dropped or mislabelled', () =>
  withStore(
    ({ sessions, project }) => {
      ideSession(sessions, { id: 's', workspace: project, turns: [{ at: min(1), credits: 1, status: 'throttled' }] });
    },
    ({ project }) => {
      const u = usage.readKiroUsage(project);
      assert.deepEqual(u.gaps.unknownStatuses, ['throttled']);
      // Still counted in the total -- it cost credits -- just not as wasted.
      assert.equal(usage.attributeTurns(u.turns, []).total, 1);
      assert.equal(usage.attributeTurns(u.turns, []).wasted, 0);
    }
  ));

test('a half-written last line, a session with no messages, and junk files are all survived', () =>
  withStore(
    ({ sessions, project }) => {
      ideSession(sessions, { id: 'ok', workspace: project, turns: [{ at: min(1), credits: 2 }] });
      fs.appendFileSync(path.join(sessions, 'wshash', 'sess_ok', 'messages.jsonl'), '{"id":"partial","timestamp":1');
      // Opened, never prompted.
      const empty = path.join(sessions, 'wshash', 'sess_empty');
      fs.mkdirSync(empty);
      fs.writeFileSync(path.join(empty, 'session.json'), JSON.stringify({ id: 'sess_empty', modelId: 'x', workspacePaths: [project], createdAt: '2026-10-06T05:00:00Z' }));
      // Not a session at all.
      fs.writeFileSync(path.join(sessions, 'wshash', 'stray.txt'), 'x');
      fs.mkdirSync(path.join(sessions, 'cli'), { recursive: true });
      fs.writeFileSync(path.join(sessions, 'cli', 'bad.json'), '{not json');
    },
    ({ project }) => {
      let u;
      assert.doesNotThrow(() => { u = usage.readKiroUsage(project); });
      assert.equal(u.turns.length, 1);
      assert.equal(u.turns[0].credits, 2);
      // The empty session is real and empty; the summary drops it because it has no turns.
      assert.equal(usage.summariseSessions(u.sessions).length, 1);
    }
  ));

test('no session store at all is "no data", said in a way the UI can render', () =>
  withStore(
    () => {},
    ({ project }) => {
      const u = usage.readKiroUsage(project);
      assert.equal(u.ok, false);
      assert.equal(u.reason, 'no-session-store');
      assert.ok(u.storePath);
      assert.deepEqual(u.turns, []);
    }
  ));

test('KIRO_HOME overrides the home directory, and the default is ~/.kiro', () => {
  const previous = process.env.KIRO_HOME;
  try {
    process.env.KIRO_HOME = '/custom/kiro';
    assert.equal(usage.kiroHome(), '/custom/kiro');
    assert.equal(usage.sessionsRoot(), path.join('/custom/kiro', 'sessions'));
    delete process.env.KIRO_HOME;
    assert.equal(usage.kiroHome(), path.join(os.homedir(), '.kiro'));
  } finally {
    if (previous === undefined) delete process.env.KIRO_HOME;
    else process.env.KIRO_HOME = previous;
  }
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test('a turn inside a stage window is attributed to it; one outside every window is reported, not hidden', () => {
  const turns = [
    { at: min(5), credits: 10, status: 'success' },
    { at: min(50), credits: 7, status: 'success' }
  ];
  const windows = [{ key: 'req', label: 'requirements-analysis', startedAt: min(0), completedAt: min(10) }];
  const a = usage.attributeTurns(turns, windows);
  assert.equal(a.byWindow[0].credits, 10);
  assert.equal(a.outside.credits, 7);
  assert.equal(a.outside.turns, 1);
  // The total always adds up: attributed + outside == total.
  assert.equal(a.byWindow[0].credits + a.outside.credits, a.total);
});

test('a turn spanning several short stages is attributed to each, so per-stage is a view not a partition', () => {
  // One prompt can complete four setup stages inside a second. Picking one would be a
  // guess; attributing to all is honest, and the page labels the column as overlapping.
  const turns = [{ at: min(1), credits: 12, status: 'success' }];
  const windows = [
    { key: 'a', label: 'a', startedAt: min(0), completedAt: min(2) },
    { key: 'b', label: 'b', startedAt: min(0), completedAt: min(2) }
  ];
  const a = usage.attributeTurns(turns, windows);
  assert.equal(a.byWindow[0].credits, 12);
  assert.equal(a.byWindow[1].credits, 12);
  assert.equal(a.total, 12);
  assert.equal(a.outside.credits, 0);
});

test('an open stage runs to now, so turns after its start still count', () => {
  const turns = [{ at: Date.now() - 1000, credits: 3, status: 'success' }];
  const windows = [{ key: 'open', label: 'open', startedAt: min(0), completedAt: undefined, open: true }];
  assert.equal(usage.attributeTurns(turns, windows).byWindow[0].credits, 3);
});

test('stage windows come from the ledger events, with a restart closing the earlier attempt', () => {
  // runtime-graph.json stamps every stage with the compile time; the ledger carries the
  // real starts. And a second STAGE_STARTED is a restart, not a replacement.
  const events = [
    { event: 'STAGE_STARTED', stage: 'req', timestamp: '2026-10-06T05:00:00Z' },
    { event: 'STAGE_COMPLETED', stage: 'req', timestamp: '2026-10-06T05:10:00Z' },
    { event: 'STAGE_STARTED', stage: 'design', timestamp: '2026-10-06T05:10:00Z' },
    { event: 'STAGE_STARTED', stage: 'design', timestamp: '2026-10-06T07:00:00Z' },
    { event: 'QUESTION_ANSWERED', stage: 'design', timestamp: '2026-10-06T07:30:00Z' },
    { event: 'STAGE_STARTED', stage: 'nots', timestamp: 'not a time' }
  ];
  const w = usage.stageWindowsFromLedger(events);
  const byKey = Object.fromEntries(w.map((x) => [x.key, x]));
  assert.equal(w.length, 3, 'req once, design twice; the unparseable one is skipped');
  assert.equal(byKey[`req@${Date.parse('2026-10-06T05:00:00Z')}`].completedAt, Date.parse('2026-10-06T05:10:00Z'));
  const first = byKey[`design@${Date.parse('2026-10-06T05:10:00Z')}`];
  assert.equal(first.restarted, true);
  assert.equal(first.completedAt, Date.parse('2026-10-06T07:00:00Z'));
  const second = byKey[`design@${Date.parse('2026-10-06T07:00:00Z')}`];
  assert.equal(second.open, true);
});

test('v1 windows come from artifact mtimes, one per stage directory, and say so', () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  try {
    const stage = path.join(docs, 'inception', 'requirements');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'a.md'), 'x');
    fs.writeFileSync(path.join(stage, 'b.md'), 'y');
    fs.writeFileSync(path.join(stage, 'notes.txt'), 'ignored');
    fs.mkdirSync(path.join(docs, 'inception', 'empty'));
    const w = usage.stageWindowsFromArtifacts(docs);
    assert.equal(w.length, 1, 'a stage directory with no .md has no window');
    assert.equal(w[0].stage, 'requirements');
    assert.equal(w[0].phase, 'inception');
    assert.equal(w[0].fromArtifacts, true);
    assert.ok(w[0].startedAt <= w[0].completedAt);
    assert.deepEqual(usage.stageWindowsFromArtifacts('/nonexistent'), []);
  } finally {
    fs.rmSync(docs, { recursive: true, force: true });
  }
});

test('nothing in the reader returns conversation text', () => {
  // The store is owner-only and this extension reads NUMBERS from it. The boundary is
  // asserted at the source: no function reads a message body. `promptTurnSummaries` is
  // Kiro's name for the per-turn CREDIT record and carries no text; the fields that
  // would are the ones listed here.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'aidlc', 'kiro-usage.js'), 'utf8');
  const code = source.split('\n').filter((l) => !l.trim().startsWith('//'));
  for (const forbidden of ['.content', '.text', '.message', '.body', 'payload.user', 'payload.assistant', 'user_prompt\b', 'assistant_response\b']) {
    const re = new RegExp(forbidden.replace(/\./g, '\\.'));
    const hits = code.filter((l) => re.test(l) && !/user_prompt_length|assistant_response_length/.test(l));
    assert.deepEqual(hits, [], `reader must not touch ${forbidden}`);
  }
});

test('all-zero token fields read as "not recorded", because that is what they are', () =>
  withStore(
    ({ sessions, project }) => {
      // On a real machine every one of 930 CLI turns had the four token fields present
      // and all zero, while consuming credits. The field exists; the value is not filled.
      cliSession(sessions, { id: 'z', cwd: project, turns: [{ at: min(1), credits: 0.5, input: 0, output: 0 }] });
    },
    ({ project }) => {
      const u = usage.readKiroUsage(project);
      assert.equal(u.turns[0].tokens, undefined, 'zeros across the board are not a recording');
      assert.equal(u.turns[0].credits, 0.5, 'the credits are still real');
      const [s] = usage.summariseSessions(u.sessions);
      assert.equal(s.tokens, undefined);
    }
  ));
