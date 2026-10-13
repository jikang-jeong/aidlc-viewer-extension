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
      assert.ok(s.includes('Tokens (Credits)'));
    }
  ));

test('v2 puts Waiting for you first, because it is the one thing only the reader can clear', () =>
  withKiroHome(
    ({ home, project }) => ideSession(home, project, [{ at: T, credits: 5 }]),
    ({ project }) => {
      const v2 = {
        generation: 'v2',
        v2: { active: { dir: path.join(project, 'aidlc/spaces/default/intents/i'), diagnosis: { waitingOnYou: [{ kind: 'guard-refusal', stated: true, stage: 'intent-capture', code: 'REQUIRED_ARTIFACTS_MISSING', message: 'Cannot present.', remedies: [{ op: 'request-changes', label: 'Request changes', requiresHuman: true }] }], live: [], refusals: [], sensorFailures: new Map(), sensorFailureTotal: 0 }, contrast: { rows: [], faultedWithoutRecord: [] } } }
      };
      const html = page.renderCreditsPage({ webview, root: project, project: v2 });
      const s = sections(html);
      assert.equal(s[0], 'Waiting for you');
      assert.match(html, /engine says/);
      assert.match(html, /REQUIRED_ARTIFACTS_MISSING/);
      assert.match(html, /Request changes/);
      // Engine records are present but folded.
      assert.match(html, /<details class="records">/);
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
      assert.match(html, /not token counts/);
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
