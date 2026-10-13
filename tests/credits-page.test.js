'use strict';

// Pins the Credits page: what it shows, in what order, and what it refuses to show.
//
// The page replaced the v2-only Supervision panel so that both generations share one
// sidebar. Its numbers are Kiro's and the engine's; nothing is estimated. These tests
// drive the page builder with hand-built project models and a temporary KIRO_HOME, and
// read the resulting HTML for structure, not pixels.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const page = require('../src/credits-page');

function sections(html) {
  return [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
}

function withKiroHome(build, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const previous = process.env.KIRO_HOME;
  process.env.KIRO_HOME = home;
  try {
    build({ home, project });
    return run({ home, project });
  } finally {
    if (previous === undefined) delete process.env.KIRO_HOME;
    else process.env.KIRO_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

function ideSession(home, project, turns) {
  const dir = path.join(home, 'sessions', 'ws', 'sess_1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id: 'sess_1', modelId: 'claude-opus-4.8', workspacePaths: [project], createdAt: '2026-10-06T05:00:00Z', title: 'Demo' }));
  fs.writeFileSync(
    path.join(dir, 'messages.jsonl'),
    turns.map((t) => JSON.stringify({ id: 'x', timestamp: t.at, payload: { type: 'usage_summary', status: t.status ?? 'success', elapsedTime: 60000, promptTurnSummaries: [{ unit: 'credit', usage: t.credits }] } })).join('\n') + '\n'
  );
}

const webview = { cspSource: 'vscode-resource:' };
const T = Date.parse('2026-10-06T06:00:00Z');

test('v1 shows Credits only -- no Waiting, no engine records -- so its page matches its sidebar', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 5 }]),
    ({ project }) => {
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      const s = sections(html);
      assert.deepEqual(s.filter((x) => /Waiting|Engine records|stuck|Checks/.test(x)), []);
      assert.ok(s.includes('Credits (Tokens)'));
    }
  ));

const V2_WAITING = (project) => ({
  generation: 'v2',
  v2: {
    active: {
      dir: path.join(project, 'aidlc/spaces/default/intents/i'),
      diagnosis: {
        waitingOnYou: [
          { kind: 'guard-refusal', stated: true, stage: 'intent-capture', code: 'REQUIRED_ARTIFACTS_MISSING', message: 'Cannot present.', remedies: [{ op: 'request-changes', label: 'Request changes', requiresHuman: true }] },
          { kind: 'questions', stated: true, stage: 'requirements-analysis', message: '2 of 5 questions unanswered in inception/requirements-analysis/q.md', open: 2, total: 5 }
        ],
        live: [], refusals: [], sensorFailures: new Map(), sensorFailureTotal: 0
      },
      contrast: { rows: [], faultedWithoutRecord: [] }
    }
  }
});

test('three pages: Credits starts and ends with credits; Waiting and Engine records are their own', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 5 }]),
    ({ project }) => {
      // They used to be one page, with "Waiting for you" above the credits and the
      // engine's records folded below them. Asked for as separate rows in the tree.
      const v2 = V2_WAITING(project);
      const credits = page.renderCreditsPage({ webview, root: project, project: v2 });
      const s = sections(credits);
      assert.equal(s[0], 'Credits (' + 'Tokens)');
      assert.ok(!s.includes('Waiting for you'), 'not on the Credits page any more');
      assert.doesNotMatch(credits, /<details class="records">/, 'nor the engine records');

      const waiting = page.renderWaitingPage({ webview, root: project, project: v2 });
      assert.deepEqual(sections(waiting), ['Waiting for you']);
      assert.match(waiting, /engine says/);
      assert.match(waiting, /REQUIRED_ARTIFACTS_MISSING/);
      assert.match(waiting, /Request changes/);
      // Open questions name the file and say what to do.
      assert.match(waiting, /Questions to answer · requirements-analysis/);
      assert.match(waiting, /2 of 5 questions unanswered in inception\/requirements-analysis\/q\.md/);
      assert.match(waiting, /fill in each empty <code>\[Answer\]:<\/code>/);

      const records = page.renderEngineRecordsPage({ webview, root: project, project: v2 });
      assert.match(records, /<title>Engine records<\/title>/);
      assert.doesNotMatch(records, /<details class="records">/, 'unfolded: it is the whole page now');
    }
  ));

test('the Waiting row summary carries the count and the stages, and says nothing on v1', () =>
  withKiroHome(
    () => {},
    ({ project }) => {
      assert.deepEqual(page.waitingSummary(V2_WAITING(project)), { count: 2, stages: ['intent-capture', 'requirements-analysis'] });
      assert.equal(page.waitingSummary({ generation: 'v1' }), undefined);
      assert.deepEqual(page.waitingSummary({ generation: 'v2', v2: { active: { diagnosis: { waitingOnYou: [] } } } }), { count: 0, stages: [] });
    }
  ));

test('each page says so when no v2 intent has started, rather than rendering an empty body', () =>
  withKiroHome(
    () => {},
    ({ project }) => {
      const none = { generation: 'v2', v2: { active: undefined } };
      assert.match(page.renderWaitingPage({ webview, root: project, project: none }), /No AI-DLC v2 intent has started/);
      assert.match(page.renderEngineRecordsPage({ webview, root: project, project: none }), /No AI-DLC v2 intent has started/);
    }
  ));

test('the wasted figure is the first number after the total, and says what it is', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 10 }, { at: T + 1, credits: 40, status: 'aborted' }]),
    ({ project }) => {
      const m = page.collectCreditsModel(project, { generation: 'v1' });
      assert.equal(m.attribution.total, 50);
      assert.equal(m.attribution.wasted, 40);
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      assert.match(html, /aborted or failed/);
      assert.match(html, /80% of the total/);
    }
  ));

test('no money is ever shown, and tokens are not shown where Kiro did not record them', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 5 }]),
    ({ project }) => {
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      assert.equal(/\$\s?\d|USD|dollar/i.test(html), false, 'no currency');
      assert.match(html, /no token counts for these sessions/);
      assert.equal(/\d+ tok\b/.test(html), false, 'no token figure for an IDE session');
    }
  ));

test('a turn outside every stage window is shown with its credits, so the total adds up', () =>
  withKiroHome(
    ({ home, project }) => {
      ideSession(home, project, [{ at: T, credits: 7 }]);
      // A v1 stage directory whose artifacts are from a different time.
      const stage = path.join(project, 'aidlc-docs', 'inception', 'requirements');
      fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(path.join(stage, 'a.md'), 'x');
      const old = new Date('2026-01-01T00:00:00Z');
      fs.utimesSync(path.join(stage, 'a.md'), old, old);
    },
    ({ project }) => {
      const m = page.collectCreditsModel(project, { generation: 'v1' });
      assert.equal(m.windowSource, 'artifacts');
      assert.equal(m.attribution.outside.credits, 7);
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      assert.match(html, /Outside any stage window/);
      assert.match(html, /shown, not hidden/);
    }
  ));

test('a missing session store is one sentence naming the path, not an empty table', () =>
  withKiroHome(
    () => {},
    ({ project }) => {
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      assert.match(html, /session store was not found/);
      assert.equal(/<table>/.test(html), false);
    }
  ));

test('the page runs no scripts and declares a CSP that forbids them', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 1 }]),
    ({ project }) => {
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      assert.equal(/<script/.test(html), false);
      assert.match(html, /Content-Security-Policy/);
      assert.match(html, /default-src 'none'/);
    }
  ));

test('a session title is escaped, because it is text a person typed into Kiro', () =>
  withKiroHome(
    ({ home, project }) => {
      ideSession(home, project, [{ at: T, credits: 1 }]);
      const sj = path.join(home, 'sessions', 'ws', 'sess_1', 'session.json');
      const meta = JSON.parse(fs.readFileSync(sj, 'utf8'));
      meta.title = '<img src=x onerror=alert(1)>';
      fs.writeFileSync(sj, JSON.stringify(meta));
    },
    ({ project }) => {
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      assert.equal(/<img src=x/.test(html), false);
      assert.match(html, /&lt;img src=x/);
    }
  ));

test('the history lists every turn newest first, with its stage attribution and status', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 10 }, { at: T + 60000, credits: 40, status: 'aborted' }, { at: T + 120000, credits: 5 }]),
    ({ project }) => {
      const m = page.collectCreditsModel(project, { generation: 'v1' });
      assert.equal(m.history.length, 3);
      assert.equal(m.history[0].credits, 5, 'newest first');
      assert.equal(m.history[1].status, 'aborted');
      assert.deepEqual(m.history[0].stages, [], 'no windows on a bare project');
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      assert.match(html, /<details class="history">/);
      assert.match(html, /3 turns, newest first/);
      // The aborted turn is marked so it can be found in a long list.
      assert.match(html, /<tr class="wasted">/);
      // History is below the rollups and above the engine's records.
      const order = sections(html);
      assert.ok(order.indexOf('History') > order.indexOf('By session'));
    }
  ));

test('the history is capped and says so, so a long-lived project does not render thousands of rows', () =>
  withKiroHome(
    ({ home, project }) => {
      const turns = [];
      for (let i = 0; i < page.HISTORY_LIMIT + 25; i += 1) turns.push({ at: T + i * 1000, credits: 1 });
      ideSession(home, project, turns);
    },
    ({ project }) => {
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      const rows = (html.match(/<details class="history">[\s\S]*?<\/details>/)[0].match(/<tr class=/g) || []).length;
      assert.equal(rows, page.HISTORY_LIMIT);
      assert.match(html, new RegExp(`most recent ${page.HISTORY_LIMIT} of ${page.HISTORY_LIMIT + 25}`));
    }
  ));

test('token detail appears only where Kiro recorded non-zero tokens, as in/out with the four counts on hover', () => {
  // fmtTokens is the display rule; the recording rule (zeros are "not recorded") is
  // pinned in kiro-usage.test.js.
  assert.equal(page.fmtTokens(950), '950');
  assert.equal(page.fmtTokens(1500), '1.5k');
  assert.equal(page.fmtTokens(45000), '45k');
  assert.equal(page.fmtTokens(2_300_000), '2.3M');
  assert.equal(page.fmtTokens(undefined), '—');
});

test('the session table names the model and nothing about where the session was read from', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 10 }]),
    ({ project }) => {
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      // Neither the store nor a program name: the layout does not say which program
      // wrote a session, and the store path meant nothing to the reader. Model only.
      assert.doesNotMatch(html, /sessions\/&lt;workspace&gt;|sessions\/cli|Kiro IDE<\/div>|Kiro CLI<\/div>/);
      assert.match(html, /claude-opus-4\.8<\/div>/);
    }
  ));


test('rendering twice with the same nonce is byte-identical, so the poll leaves an unchanged page alone', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 10 }]),
    ({ project }) => {
      // The panel assigns webview.html only when it differs from the last render, because
      // assigning it folds every <details> and resets the scroll. A fresh nonce per call
      // made every render differ, and History closed itself every ten seconds.
      const opts = { webview, root: project, project: { generation: 'v1' }, nonce: 'n0nce' };
      assert.equal(page.renderCreditsPage(opts), page.renderCreditsPage(opts));
      assert.notEqual(page.renderCreditsPage({ ...opts, nonce: undefined }), page.renderCreditsPage({ ...opts, nonce: undefined }), 'without a fixed nonce each render is distinct, as before');
    }
  ));

test('the folded sections draw their own disclosure marker', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 10 }]),
    ({ project }) => {
      // summary is display:flex, which drops the browser's default triangle.
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      assert.match(html, /details\.history summary::before[^}]*content: '\u25B8'/);
      assert.match(html, /details\.history\[open\] summary::before[^}]*content: '\u25BE'/);
    }
  ));

test('the rollups carry bars drawn in CSS, relative to the largest row, with the wasted share marked', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 60 }, { at: T + 1000, credits: 40, status: 'aborted' }]),
    ({ project }) => {
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      // Headline: one split bar, 60/40, with a legend.
      // Widths are classes: the CSP allows no inline style, and style="width:60%" rendered
      // as an empty track. Reported from a screenshot.
      assert.match(html, /<div class="split" title="40% of credits bought nothing"><span class="split-ok w60"><\/span><span class="split-wasted w40">/);
      assert.doesNotMatch(html, /style="width/, 'no inline style survives the CSP');
      assert.match(html, /\.w60\{width:60%\}/, 'the width class is defined in the nonce\u2019d stylesheet');
      // By session: the only session is the max, so its bar is full, with 40% marked wasted.
      assert.match(html, /<div class="bar" title="40\.0 of 100 on aborted or failed turns"><span class="bar-fill w100"><\/span><span class="bar-wasted w40">/);
      // No script was added to draw any of it.
      assert.doesNotMatch(html, /<script/);
    }
  ));

test('the history has no context or token columns', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 1 }]),
    ({ project }) => {
      const html = page.renderCreditsPage({ webview, root: project, project: { generation: 'v1' } });
      const head = /<details class="history">[\s\S]*?<thead>(.*?)<\/thead>/.exec(html)[1].replace(/<[^>]+>/g, '|');
      assert.equal(head, '||When||Credits||Status||Stage||Session||Time||');
    }
  ));
