'use strict';

// The Credits page: one place for what Kiro spent on this project and, on v2, what the
// engine is waiting on you for.
//
// WHY A PAGE AND NOT A PANEL
//
// v2 had a Supervision panel under the tree; v1 had nothing there. Two generations, two
// sidebars. The page is opened from one row in the tree that both generations have, so
// the sidebar is the same shape for everyone and the detail lives where there is room
// for it. On v1 the page is Credits; on v2 it is Credits, then Waiting for you, then the
// engine's other records folded below.
//
// WHAT IS SHOWN, AND WHAT IS REFUSED
//
// Every number here is one Kiro or the engine recorded. Credits are summed from Kiro's
// per-turn record; the price of a credit depends on the plan, so no dollar amount is
// computed. Tokens appear only where Kiro wrote them (the CLI store) and are never
// estimated. Attribution of turns to stages is by time and is labelled as such. A turn
// that falls outside every stage window is shown with its credits, not hidden, so the
// total adds up on the page the way it does on the bill.
//
// The figure a person can act on is the credits spent on turns Kiro marked aborted or
// failed -- work that was paid for and produced nothing -- and it is the first number.

const path = require('path');
const { readKiroUsage, attributeTurns, summariseSessions, stageWindowsFromLedger, stageWindowsFromArtifacts } = require('./aidlc/kiro-usage');
const auditReader = require('./aidlc/audit');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nonce() {
  let out = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function fmtCredits(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

// A proportion drawn as a bar, beside the number it belongs to. Pure CSS: the page
// runs no script, so this is the whole of the visual language -- length, and one colour
// for credits that bought nothing. Widths are rounded to whole percents so an unchanged
// report renders byte-identical.
function bar(value, max, { wasted = 0, label } = {}) {
  if (!(max > 0) || !(value >= 0)) return '';
  const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  const wastedPct = Math.max(0, Math.min(pct, Math.round((wasted / max) * 100)));
  // The bar's meaning is in its title: "41% of the project's credits". Without the
  // number a full bar on a one-session project read as "a lot", which it is not.
  const title = ` title="${escapeHtml(label ? `${pct}% of the project\u2019s credits \u00b7 ${label}` : `${pct}% of the project\u2019s credits`)}"`;
  // Widths are classes, not inline styles: the page's CSP allows only the nonce'd
  // <style> block, so style="width:60%" is dropped and the bar renders as an empty
  // track. Seen in a screenshot. One class per whole percent, defined once in the CSS.
  return `<div class="bar"${title}><span class="bar-fill w${pct}"></span>${wastedPct > 0 ? `<span class="bar-wasted w${wastedPct}"></span>` : ''}</div>`;
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtWhen(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Gathers everything the page needs for one project. Pure data, so it is testable
// without a webview and the page body is a function of it.
function collectCreditsModel(root, project) {
  const usage = readKiroUsage(root);
  const sessions = summariseSessions(usage.sessions);

  let windows = [];
  let windowSource;
  const isV2 = project && project.generation === 'v2' || project?.generation === 'both';
  if (isV2 && project.v2?.active?.dir) {
    windows = stageWindowsFromLedger(auditReader.readEvents(project.v2.active.dir));
    windowSource = 'ledger';
  } else if (project && (project.generation === 'v1' || project.generation === 'both')) {
    windows = stageWindowsFromArtifacts(path.join(root, 'aidlc-docs'));
    windowSource = 'artifacts';
  }
  const attribution = attributeTurns(usage.turns, windows);

  // Per stage, merged across restarts of the same stage so the table has one row per
  // stage name. The per-attempt windows are kept in the model for anyone who needs them.
  const byStage = new Map();
  for (const w of attribution.byWindow) {
    const slot =
      byStage.get(w.label) ?? { stage: w.label, phase: w.phase, credits: 0, turns: 0, open: false, firstStartedAt: Infinity };
    slot.credits += w.credits;
    slot.turns += w.turns;
    slot.open = slot.open || w.open === true;
    if (Number.isFinite(w.startedAt) && w.startedAt < slot.firstStartedAt) slot.firstStartedAt = w.startedAt;
    byStage.set(w.label, slot);
  }

  // Every turn, newest first, with the stage(s) its time fell in. The tables above are
  // rollups; this is the record they were rolled up from, so a number in a table can be
  // traced to the turns that made it.
  const sessionTitle = new Map(sessions.map((s) => [s.id, s.title || s.id]));
  const history = [...usage.turns]
    .sort((a, b) => b.at - a.at)
    .map((t) => {
      const stages = windows
        .filter((w) => Number.isFinite(w.startedAt) && t.at >= w.startedAt && t.at <= (w.completedAt ?? Date.now()))
        .map((w) => w.label);
      return {
        at: t.at,
        credits: t.credits,
        status: t.status,
        elapsedMs: t.elapsedMs,
        model: t.model,
        source: t.source,
        session: sessionTitle.get(t.sessionId) ?? t.sessionId,
        tokens: t.tokens,
        contextPercent: t.contextPercent,
        stages: [...new Set(stages)]
      };
    });

  return {
    ok: usage.ok,
    reason: usage.reason,
    storePath: usage.storePath,
    generation: project?.generation,
    sessions,
    attribution,
    // In the order the run reached them, from each stage's first window in the engine's
    // ledger (v1: its artifacts' earliest time). The table used to be sorted by credits,
    // largest first, which put functional-design above intent-capture and made the
    // reader re-find the workflow in a list that had shuffled it; asked to match the
    // order the stages are gone through. A stage never started sorts last.
    byStage: [...byStage.values()]
      .filter((s) => s.turns > 0)
      .sort((a, b) => a.firstStartedAt - b.firstStartedAt),
    windowSource,
    gaps: usage.gaps,
    hasTokens: sessions.some((s) => s.tokens),
    history
  };
}


// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function creditsHeadline(model) {
  if (!model.ok) {
    return `<section><h2>Usage</h2><p class="quiet">Kiro's session store was not found at <code>${escapeHtml(model.storePath)}</code>. Kiro writes credit usage there per prompt turn; until it exists there is nothing to show.</p></section>`;
  }
  const a = model.attribution;
  if (a.totalTurns === 0) {
    return `<section><h2>Usage</h2><p class="quiet">No Kiro session has been opened on this folder yet. Sessions opened on a parent folder are not counted, because nothing in Kiro's record says which project their turns were about.</p></section>`;
  }
  const wastedPct = a.total > 0 ? Math.round((a.wasted / a.total) * 100) : 0;
  return `<section>
  <h2>Usage</h2>
  <div class="tiles">
    <div class="tile"><div class="big">${fmtCredits(a.total)}</div><div class="label">credits on this project</div><div class="sub">${a.totalTurns} prompt turn${a.totalTurns === 1 ? '' : 's'} across ${model.sessions.length} session${model.sessions.length === 1 ? '' : 's'}</div></div>
    <div class="tile ${a.wasted > 0 ? 'warn' : ''}"><div class="big">${fmtCredits(a.wasted)}</div><div class="label">spent on turns that were aborted or failed</div><div class="sub">${a.wastedTurns} turn${a.wastedTurns === 1 ? '' : 's'}${a.total > 0 ? `, ${wastedPct}% of the total` : ''}</div></div>
  </div>
  ${a.total > 0 ? `<div class="split" title="${wastedPct}% of credits bought nothing"><span class="split-ok w${100 - wastedPct}"></span><span class="split-wasted w${wastedPct}"></span></div><div class="split-legend"><span><i class="sw ok"></i>completed</span><span><i class="sw wasted"></i>aborted or failed</span></div>` : ''}
  <p class="quiet">Credits are what Kiro recorded for each turn. The price of a credit depends on your plan, so no amount in money is shown. ${model.hasTokens ? 'Token counts appear where Kiro recorded them.' : 'Kiro recorded credits but no token counts for these sessions, so none are shown.'}</p>
</section>`;
}

function creditsByStage(model) {
  if (!model.ok || model.attribution.totalTurns === 0) return '';
  const rows = model.byStage;
  const outside = model.attribution.outside;
  if (rows.length === 0 && outside.turns === 0) return '';
  const note =
    model.windowSource === 'ledger'
      ? 'A turn is placed in a stage when its time falls inside that stage\u2019s window in the engine\u2019s audit ledger. A turn that spans several short stages is counted in each, so this column is a view, not a split of the total.'
      : model.windowSource === 'artifacts'
        ? 'v1 keeps no ledger this extension reads, so a stage\u2019s window is the span of its artifacts\u2019 modification times. That is coarse: a stage revisited later stretches its window.'
        : '';
  // Bars are the share of the PROJECT'S total credits, not of the largest row. The
  // first version scaled to the largest row, so on a project with one session or one
  // stage the bar was always full: 89 credits looked the same as 200 would. Asked, from
  // a screenshot, what "full" meant. Against the total, a full bar means "this is all
  // of it", a half bar "half of it", and the same bar on a bigger project is shorter.
  // Stage shares can sum past 100% because a turn spanning two stages counts in both;
  // the note under the table already says this column is a view, not a split.
  const max = model.attribution.total;
  const body = rows
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.stage)}${s.open ? ' <span class="pill">in progress</span>' : ''}</td><td class="viz">${bar(s.credits, max)}</td><td class="num">${fmtCredits(s.credits)}</td><td class="num">${s.turns}</td></tr>`
    )
    .join('');
  const outsideRow =
    outside.turns > 0
      ? `<tr class="outside"><td>Outside any stage window</td><td class="viz">${bar(outside.credits, max)}</td><td class="num">${fmtCredits(outside.credits)}</td><td class="num">${outside.turns}</td></tr>`
      : '';
  return `<section>
  <h2>By stage</h2>
  <table><thead><tr><th>Stage</th><th class="viz sub">share of total</th><th class="num">Credits</th><th class="num">Turns</th></tr></thead><tbody>${body}${outsideRow}</tbody></table>
  <p class="quiet">${note}${outside.turns > 0 ? ' Turns outside every window are shown, not hidden, so the total still adds up.' : ''}</p>
</section>`;
}

function creditsBySession(model) {
  if (!model.ok || model.sessions.length === 0) return '';
  // Share of the project's total, as in By stage. Sessions do not overlap, so these
  // do sum to the total.
  const max = model.attribution.total;
  const rows = model.sessions
    .map((s) => {
      // Where Kiro CLI recorded tokens, the four counts are shown in full on hover and
      // as in/out in the cell. Cache reads are the part of the input the model did not
      // have to re-read; a high share means context is being reused well.
      const tokens = s.tokens
        ? `<span title="input ${s.tokens.input.toLocaleString()} · output ${s.tokens.output.toLocaleString()} · cache read ${s.tokens.cacheRead.toLocaleString()} · cache write ${s.tokens.cacheWrite.toLocaleString()}">${fmtTokens(s.tokens.input)} in · ${fmtTokens(s.tokens.output)} out</span>`
        : '';
      const ctx = typeof s.lastContextPercent === 'number' ? `${Math.round(s.lastContextPercent)}%` : '—';
      const wasted = s.wasted > 0 ? `<span class="warn-text">${fmtCredits(s.wasted)} lost</span>` : '';
      return `<tr>
        <td><div>${escapeHtml(s.title || s.id)}</div><div class="sub">${escapeHtml(s.model ?? 'model not recorded')}</div></td>
        <td class="viz">${bar(s.credits, max, { wasted: s.wasted, label: s.wasted > 0 ? `${fmtCredits(s.wasted)} of ${fmtCredits(s.credits)} on aborted or failed turns` : undefined })}</td>
        <td class="num">${fmtCredits(s.credits)}${wasted ? `<div class="sub">${wasted}</div>` : ''}</td>
        <td class="num">${s.turns}</td>
        <td class="num">${fmtDuration(s.elapsedMs)}</td>
        <td class="num">${ctx}</td>
        <td class="num">${tokens}</td>
        <td class="when">${fmtWhen(s.lastAt)}</td>
      </tr>`;
    })
    .join('');
  return `<section>
  <h2>By session</h2>
  <table><thead><tr><th>Session</th><th class="viz sub">share of total</th><th class="num">Credits</th><th class="num">Turns</th><th class="num">Time</th><th class="num" title="Context window in use after the last turn">Context</th><th class="num">Tokens</th><th>Last turn</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="quiet">Context is how much of the model\u2019s window the session was using after its last turn; a session near full is one to start fresh. Tokens are shown only where Kiro recorded them.</p>
</section>`;
}

function waitingSection(project) {
  const intent = project?.v2?.active;
  if (!intent) return `<section><h2>Waiting for you</h2><p class="quiet">No AI-DLC v2 intent has started on this folder.</p></section>`;
  const waits = intent.diagnosis?.waitingOnYou ?? [];
  if (waits.length === 0) {
    const stop = intent.diagnosis?.lastStop;
    const why = intent.diagnosis?.agentBusy
      ? 'The agent is working on this project right now (a turn is open in Kiro), so the next question has not been asked yet.'
      : stop && stop.kind === 'conversational' && !stop.stale
        ? 'The agent\u2019s last turn ended with a message and no workflow step, and nothing has happened since. Read its last message in the chat: it may be telling you what to type next.'
        : 'The engine recorded no unanswered question, no refusal that needs you, no parked plan, and no gate left open.';
    return `<section><h2>Waiting for you</h2><p class="quiet">Nothing is waiting on your decision. ${why}</p></section>`;
  }
  const items = waits
    .map((w) => {
      const who = w.stated ? '<span class="pill stated">engine says</span>' : '<span class="pill inferred">inferred from the ledger</span>';
      const remedies = (w.remedies ?? [])
        .map((m) => `<li>${escapeHtml(m.label ?? m.op ?? '')}${m.action ? ` <span class="sub">${escapeHtml(m.action)}</span>` : ''}</li>`)
        .join('');
      const head =
        w.kind === 'plan-approval'
          ? `Plan approval${w.unit ? ` · unit ${escapeHtml(w.unit)}` : ''}`
          : w.kind === 'questions'
            ? `Questions to answer · ${escapeHtml(w.stage ?? 'unknown stage')}`
            : w.kind === 'chat'
              ? `The agent is asking you in the chat${w.session ? ` · ${escapeHtml(w.session)}` : ''}`
              : w.kind === 'engine-stop'
                ? `The engine stopped for you${w.stage ? ` · ${escapeHtml(w.stage)}` : ''}`
                : `${escapeHtml(w.stage ?? 'unknown stage')}${w.code ? ` · ${escapeHtml(w.code)}` : ''}`;
      const how = w.kind === 'questions'
        ? `<div class="sub">Open the file from the tree and fill in each empty <code>[Answer]:</code>, then tell the agent to continue.</div>`
        : w.kind === 'chat'
          ? `<div class="sub">Answer in Kiro\u2019s chat.${w.options && w.options.length ? ` Options the agent offered: ${w.options.map((o) => `<code>${escapeHtml(o)}</code>`).join(' ')}` : ''}</div>`
          : w.kind === 'engine-stop'
            ? `<div class="sub">The engine\u2019s hook wrote, when the agent stopped: <code>${escapeHtml(w.detail ?? '')}</code></div>`
            : '';
      return `<li class="wait">
        <div class="wait-head">${head} ${who}${typeof w.count === 'number' && w.count > 1 ? ` <span class="sub">×${w.count}</span>` : ''}</div>
        ${w.message ? `<div class="wait-msg">${escapeHtml(w.message)}</div>` : ''}
        ${how}
        ${remedies ? `<ul class="remedies">${remedies}</ul>` : ''}
      </li>`;
    })
    .join('');
  return `<section class="urgent"><h2>Waiting for you</h2><ul class="waits">${items}</ul><p class="quiet">A stage waiting on you is stopped, not slow. "Engine says" is the engine\u2019s own record (a file it wrote); "inferred" is this extension\u2019s reading of the ledger\u2019s order.</p></section>`;
}

const PAGE_TITLE = { credits: 'Usage', waiting: 'Waiting for you' };
const HISTORY_LIMIT = 200;
function historySection(model) {
  if (!model.ok || !model.history || model.history.length === 0) return '';
  const rows = model.history
    .slice(0, HISTORY_LIMIT)
    .map((t) => {
      const wasted = t.status === 'aborted' || t.status === 'failed';
      return `<tr class="${wasted ? 'wasted' : ''}">
        <td class="when">${fmtWhen(t.at)}</td>
        <td class="num">${fmtCredits(t.credits)}</td>
        <td>${escapeHtml(t.status ?? '')}</td>
        <td>${t.stages.length ? escapeHtml(t.stages.join(', ')) : '<span class="sub">outside any stage</span>'}</td>
        <td><div>${escapeHtml(t.session)}</div><div class="sub">${escapeHtml(t.model ?? '')}</div></td>
        <td class="num">${fmtDuration(t.elapsedMs)}</td>
      </tr>`;
    })
    .join('');
  const capped = model.history.length > HISTORY_LIMIT ? ` Showing the most recent ${HISTORY_LIMIT} of ${model.history.length}.` : '';
  return `<details class="history"><summary><h2>History</h2><span class="sub">${model.history.length} turn${model.history.length === 1 ? '' : 's'}, newest first</span></summary>
  <table><thead><tr><th>When</th><th class="num">Credits</th><th>Status</th><th>Stage</th><th>Session</th><th class="num">Time</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="quiet">Each row is one prompt turn as Kiro recorded it. The stage column is the same time-based attribution the By stage table uses.${capped}</p>
</details>`;
}

function gapsSection(model) {
  const gaps = [];
  if (model.gaps?.unknownStatuses?.length) gaps.push(`turn status not recognised: ${model.gaps.unknownStatuses.join(', ')}`);
  if (gaps.length === 0) return '';
  return `<p class="quiet gaps">Read but not understood by this build: ${escapeHtml(gaps.join('; '))}. Counted in totals, named so a change in Kiro is visible rather than silent.</p>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// `nonce` may be supplied so that re-rendering the same panel yields byte-identical
// HTML when nothing changed. The panel re-renders on a timer and assigns the HTML only
// when it differs; a fresh nonce on every call made every render differ, and every
// assignment folds the page's <details> and resets its scroll -- reported as "History
// closes by itself after a moment".
// Three pages share one shell and one stylesheet. They used to be one page, with
// "Waiting for you" at the top of a page called Credits and the former Supervision panel
// folded at its bottom. Separate things on separate pages: the Credits page starts and
// ends with credits, what is waiting on you is its own row in the tree (where its count
// is visible without opening anything), and the engine's records are their own page.
function renderCreditsPage({ webview, root, project, nonce: fixedNonce }) {
  const model = collectCreditsModel(root, project);
  return shell({ webview, root, project, nonce: fixedNonce, title: PAGE_TITLE.credits }, [
    creditsHeadline(model),
    creditsByStage(model),
    creditsBySession(model),
    historySection(model),
    gapsSection(model)
  ]);
}

function renderWaitingPage({ webview, root, project, nonce: fixedNonce }) {
  return shell({ webview, root, project, nonce: fixedNonce, title: PAGE_TITLE.waiting }, [waitingSection(project)]);
}

function renderStartPage({ webview, root, project, nonce: fixedNonce, generation, installed = [], notices = [] }) {
  const gen = generation === 'both' ? 'v2' : generation;
  const isV2 = gen === 'v2';
  const chatHref = `command:markdownWatchViewer.openChatToStart?${encodeURIComponent(JSON.stringify([isV2 ? 'v2' : 'v1']))}`;
  const guideHref = 'command:markdownWatchViewer.showHelp';
  const what = isV2
    ? `<p class="lead">Type <code class="big">/aidlc</code> in Kiro\u2019s chat, followed by what you want to build.</p>
       <p class="quiet">Setup installed a conductor agent and a set of role agents, so <code>/aidlc</code> starts or resumes the workflow; the others are there when you want a specific one.</p>`
    : `<p class="lead">Tell your agent: <code class="big">Using AI-DLC, build \u2026</code> and describe what you want.</p>
       <p class="quiet">The rules your agent reads are in the project now. Any agent that reads them works: Kiro, Claude Code, or your editor\u2019s own.</p>`;
  // One button that opens Kiro's chat with the start phrase already typed: /aidlc on
  // v2, "Using AI-DLC, build " on v1. v1's rules are read by any agent, but the person
  // who set this up from inside Kiro is in Kiro, and the button is for them.
  const buttons = `<a class="btn primary" href="${chatHref}">${isV2 ? 'Open chat with /aidlc' : 'Open chat with the phrase'}</a><a class="btn" href="${guideHref}">Guide</a>`;
  const installedList = installed.length
    ? `<section><h2>What was set up</h2><ul class="plain">${installed.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></section>`
    : '';
  const noticeList = notices.length
    ? `<section><h2>Before you start</h2><ul class="plain">${notices.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></section>`
    : '';
  return shell({ webview, root, project, nonce: fixedNonce, title: 'Ready to start' }, [
    `<section class="start">
      <h2>AI-DLC ${escapeHtml(gen ?? '')} is set up. Start it:</h2>
      ${what}
      <div class="btns">${buttons}</div>
      <p class="quiet">This page opens once, after setup. The row at the top of the tree reads <strong>Not started</strong> with the same command until the first stage is reached.</p>
    </section>`,
    noticeList,
    installedList
  ]);
}

// What the tree row says beside "Waiting for you" without the page being open.
function waitingSummary(project) {
  const intent = project?.v2?.active;
  if (!intent) return undefined;
  const waits = intent.diagnosis?.waitingOnYou ?? [];
  const stages = [...new Set(waits.map((w) => w.stage).filter(Boolean))];
  if (waits.some((w) => w.kind === 'chat')) stages.unshift('in the chat');
  const lastStop = intent.diagnosis?.lastStop;
  return {
    count: waits.length,
    stages,
    agentBusy: Boolean(intent.diagnosis?.agentBusy),
    // The agent's last turn ended with a message and no engine call, and nothing has
    // happened since. Not a wait the engine recorded -- but the agent said something and
    // stopped, and the person should read it.
    endedInChat: Boolean(lastStop && lastStop.kind === 'conversational' && !lastStop.stale)
  };
}

function shell({ webview, root, project, nonce: fixedNonce, title }, sections) {
  const n = fixedNonce || nonce();
  const folder = path.basename(root);
  const body = [
    `<h1>${escapeHtml(folder)} <span class="gen">${escapeHtml(project?.generation === 'both' ? 'v2' : project?.generation ?? '')}</span></h1>`,
    ...sections
  ]
    .filter(Boolean)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${n}'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style nonce="${n}">
  :root { --purple: var(--vscode-charts-purple, #a371f7); --warn: var(--vscode-editorWarning-foreground, #cca700); --muted: var(--vscode-descriptionForeground); }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px 28px 40px; max-width: 980px; margin: 0 auto; line-height: 1.5; }
  h1 { font-size: 20px; margin: 0 0 18px; display: flex; align-items: baseline; gap: 10px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 26px 0 10px; }
  .gen { font-size: 12px; color: var(--purple); border: 1px solid var(--purple); border-radius: 10px; padding: 0 8px; }
  .quiet { color: var(--vscode-descriptionForeground); font-size: 12.5px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .tile { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px 16px; background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--purple) 6%); }
  .tile.warn { background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--warn) 8%); }
  .big { font-size: 30px; font-weight: 600; line-height: 1.1; }
  .label { margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 500; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .when { white-space: nowrap; color: var(--vscode-descriptionForeground); }
  tr.outside td { color: var(--vscode-descriptionForeground); font-style: italic; }
  .pill { font-size: 11px; border-radius: 9px; padding: 0 7px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
  .pill.stated { border-color: var(--purple); color: var(--purple); }
  .warn-text { color: var(--warn); }
  section.urgent { border-left: 3px solid var(--purple); padding-left: 14px; }
  .waits { list-style: none; padding: 0; margin: 0; }
  .wait { padding: 10px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .wait-head { font-weight: 600; }
  .wait-msg { margin: 4px 0; }
  .remedies { margin: 6px 0 0 16px; padding: 0; font-size: 13px; }
  .viz { width: 26%; min-width: 110px; }
  .w0{width:0%} .w1{width:1%} .w2{width:2%} .w3{width:3%} .w4{width:4%} .w5{width:5%} .w6{width:6%} .w7{width:7%} .w8{width:8%} .w9{width:9%} .w10{width:10%} .w11{width:11%} .w12{width:12%} .w13{width:13%} .w14{width:14%} .w15{width:15%} .w16{width:16%} .w17{width:17%} .w18{width:18%} .w19{width:19%} .w20{width:20%} .w21{width:21%} .w22{width:22%} .w23{width:23%} .w24{width:24%} .w25{width:25%} .w26{width:26%} .w27{width:27%} .w28{width:28%} .w29{width:29%} .w30{width:30%} .w31{width:31%} .w32{width:32%} .w33{width:33%} .w34{width:34%} .w35{width:35%} .w36{width:36%} .w37{width:37%} .w38{width:38%} .w39{width:39%} .w40{width:40%} .w41{width:41%} .w42{width:42%} .w43{width:43%} .w44{width:44%} .w45{width:45%} .w46{width:46%} .w47{width:47%} .w48{width:48%} .w49{width:49%} .w50{width:50%} .w51{width:51%} .w52{width:52%} .w53{width:53%} .w54{width:54%} .w55{width:55%} .w56{width:56%} .w57{width:57%} .w58{width:58%} .w59{width:59%} .w60{width:60%} .w61{width:61%} .w62{width:62%} .w63{width:63%} .w64{width:64%} .w65{width:65%} .w66{width:66%} .w67{width:67%} .w68{width:68%} .w69{width:69%} .w70{width:70%} .w71{width:71%} .w72{width:72%} .w73{width:73%} .w74{width:74%} .w75{width:75%} .w76{width:76%} .w77{width:77%} .w78{width:78%} .w79{width:79%} .w80{width:80%} .w81{width:81%} .w82{width:82%} .w83{width:83%} .w84{width:84%} .w85{width:85%} .w86{width:86%} .w87{width:87%} .w88{width:88%} .w89{width:89%} .w90{width:90%} .w91{width:91%} .w92{width:92%} .w93{width:93%} .w94{width:94%} .w95{width:95%} .w96{width:96%} .w97{width:97%} .w98{width:98%} .w99{width:99%} .w100{width:100%}
  .bar { position: relative; height: 8px; background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); border-radius: 4px; overflow: hidden; }
  .bar-fill, .bar-wasted { position: absolute; left: 0; top: 0; bottom: 0; }
  .bar-fill { background: var(--purple); opacity: 0.8; }
  .bar-wasted { background: var(--warn); }
  .split { display: flex; height: 10px; border-radius: 5px; overflow: hidden; margin: 14px 0 6px; background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
  .split > span { flex: none; }
  .split-ok { background: var(--purple); opacity: 0.8; }
  .split-wasted { background: var(--warn); }
  .split-legend { display: flex; gap: 18px; color: var(--muted); font-size: 12px; }
  .split-legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
  .sw.ok { background: var(--purple); opacity: 0.8; }
  .sw.wasted { background: var(--warn); }
  .start .lead { font-size: 18px; line-height: 1.5; margin: 10px 0 6px; }
  code.big { font-size: 20px; padding: 3px 10px; border-radius: 6px; background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--purple) 15%); border: 1px solid var(--purple); }
  .btns { display: flex; gap: 10px; margin: 16px 0 8px; flex-wrap: wrap; }
  .btn { display: inline-block; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); text-decoration: none; font-size: 13px; }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn:hover { filter: brightness(1.1); }
  ul.plain { margin: 6px 0 0 18px; padding: 0; }
  details.records, details.history { margin-top: 26px; }
  details.history summary { cursor: pointer; display: flex; align-items: baseline; gap: 10px; list-style: none; }
  details.history summary::-webkit-details-marker { display: none; }
  details.history summary h2 { margin: 0; display: inline; }
  details.history summary::before, details.records summary::before { content: '\u25B8'; color: var(--muted); font-size: 0.9em; width: 1em; flex: none; }
  details.history[open] summary::before, details.records[open] summary::before { content: '\u25BE'; }
  tr.wasted td { color: var(--warn); }
  details.records summary { cursor: pointer; display: flex; align-items: baseline; gap: 10px; list-style: none; }
  details.records summary::-webkit-details-marker { display: none; }
  details.records summary h2 { margin: 0; display: inline; }
  .gaps { margin-top: 30px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

module.exports = { collectCreditsModel, renderCreditsPage, renderWaitingPage, renderStartPage, waitingSummary, PAGE_TITLE, nonce, fmtCredits, fmtDuration, fmtTokens, HISTORY_LIMIT };
