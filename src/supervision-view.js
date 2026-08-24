'use strict';

// The v2 supervision panel: a webview view that sits above the tree and answers
// three questions without the user scrolling a chat transcript.
//
//   Where am I?          furthest stage reached, per-phase counts, unit progress
//   What is blocking?    engine refusals still in the way, with the event order
//   What did I not see?  sensor failures the engine logged and nobody was told
//
// Why this exists: in v2 the agent reads the artifacts and the human approves a
// summary. Across three observed runs the agent wrote 284KB of documents and the
// human answered 64 times, often with a single "1". Meanwhile the engine logged
// 103 sensor failures and 44 refusals, and the user was told about none of them.
// Everything on this panel is already on disk; none of it is on screen.
//
// Restraint is the design. A finished run carries dozens of refusals it recovered
// from long ago, so only the ones still in the way are shown; a panel that cried
// wolf over history would be scrolled past like the chat it replaces. When there
// is nothing to say, it says so in one line.
//
// This file may use `vscode`. The modules under src/aidlc/ may not.

const vscode = require('vscode');
const { readProject, GENERATION } = require('./aidlc/index');

const VIEW_ID = 'markdownWatchViewer.supervision';
// Drives the `when` clause on the view, so a v1 project never renders this at
// all. That is the no-regression guarantee: existing users see no new UI.
const CONTEXT_KEY = 'aidlcViewer.v2Detected';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nonce() {
  let out = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

class SupervisionViewProvider {
  constructor() {
    this.view = undefined;
    this.root = undefined;
    this.project = undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message && message.type === 'open' && typeof message.path === 'string') {
        // Opens in a plain editor rather than the extension's split viewer: the
        // targets here are sensor detail files and artifacts flagged by a sensor,
        // which are being inspected rather than read through.
        vscode.workspace
          .openTextDocument(vscode.Uri.file(message.path))
          .then((doc) => vscode.window.showTextDocument(doc, { preview: true }), () => {
            vscode.window.showWarningMessage(`Could not open ${message.path}`);
          });
      }
    });
    this.render();
  }

  // Called whenever the watched folder changes or its contents change.
  //
  // Reading is filesystem-only and cheap, but it is not free on a large ledger,
  // so a caller should debounce. Errors are swallowed into "not v2" rather than
  // surfaced as a broken panel: the tree must keep working regardless.
  update(rootUri) {
    this.root = rootUri;
    let project;
    try {
      project = rootUri ? readProject(rootUri.fsPath) : undefined;
    } catch {
      project = undefined;
    }
    this.project = project;
    const isV2 =
      Boolean(project) &&
      (project.generation === GENERATION.V2 || project.generation === GENERATION.BOTH);
    vscode.commands.executeCommand('setContext', CONTEXT_KEY, isV2);
    this.render();
  }

  render() {
    if (!this.view) return;
    const webview = this.view.webview;
    const n = nonce();
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';" />
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 8px 10px 12px;
    margin: 0;
  }
  .quiet { color: var(--vscode-descriptionForeground); }
  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .06em;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    margin: 14px 0 6px;
  }
  h2:first-of-type { margin-top: 2px; }
  .stage {
    font-weight: 600;
    font-size: 13px;
    /* Purple is the progress tone throughout this extension. Green is not used
       because it already means an unread NEW artifact in the tree. */
    color: var(--vscode-charts-purple, #b180d7);
  }
  /* The rail, matched to the viewer's journey strip so the two read the same.
     Three things make a skipped stage legible, and all three were learned by
     getting them wrong first:

     Segments are 10px tall with a 9px floor. At 8px and a 4px floor the hatch on
     a skipped stage had no room to repeat, so a 33-stage rail in a 300px sidebar
     showed scattered purple blocks separated by what looked like gaps.

     The unfilled track and the hatch are mixed from the foreground colour rather
     than taken from panel-border, which is nearly invisible against a dark
     sidebar background.

     The band sits slightly lighter than the sidebar for the same reason: an
     unfilled segment has to be visible as a segment, not as absence. */
  .rail {
    display: flex;
    flex-wrap: wrap;
    gap: 1px;
    align-items: center;
    margin: 7px 0 6px;
    padding: 5px 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 86%, var(--vscode-foreground) 14%);
  }
  /* Wrapping rather than shrinking. v2 declares 33 stages, which at the 9px floor
     needs ~329px while a default sidebar offers ~268px. Shrinking below the floor
     was the original mistake: the hatch stops repeating and a skipped stage turns
     back into a gap. Two rows of legible segments beat one row of illegible ones,
     and no stage is clipped out of sight. */
  .seg {
    height: 10px;
    flex: 1 1 auto;
    min-width: 9px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  }
  .seg.done { background: var(--vscode-charts-purple, #b180d7); }
  .seg.active {
    background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 55%, transparent);
    outline: 1px solid var(--vscode-charts-purple, #b180d7);
    outline-offset: -1px;
  }
  /* Hatched, not blank: a stage the scope chose not to run is a decision, not a
     gap, and a blank segment reads as a missing tooth. */
  .seg.skipped {
    background: repeating-linear-gradient(
      125deg,
      color-mix(in srgb, var(--vscode-foreground) 34%, transparent) 0 2px,
      transparent 2px 5px
    );
  }
  /* The furthest point reached, marked once. v1 established that highlighting the
     current position rather than the file being read is what a reader wants, and
     the ring is what makes it findable in a 33-segment rail. */
  .seg.current {
    background: var(--vscode-charts-purple, #b180d7);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 40%, transparent);
  }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 1px 0; vertical-align: top; }
  td.k { color: var(--vscode-descriptionForeground); padding-right: 8px; white-space: nowrap; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.indent { padding-left: 10px; }
  .warn { color: var(--vscode-charts-orange, #d18616); }
  /* Underway, in the product's purple rather than a warning colour: a stage being
     worked is progress, not a problem. Distinct from the plain done count so a
     phase in flight cannot read as untouched. */
  .live { color: var(--vscode-charts-purple, #b180d7); }
  .block {
    border-left: 2px solid var(--vscode-charts-orange, #d18616);
    padding: 4px 0 4px 8px;
    margin: 6px 0;
  }
  .msg { white-space: pre-wrap; word-break: break-word; }
  .seq { margin-top: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .seq div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .seq .hit { color: var(--vscode-charts-orange, #d18616); font-weight: 600; }
  /* Links are underlined always, not only on hover. The panel is full of purple
     text that is not clickable, so colour alone had stopped meaning "link". */
  a {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  a:hover { color: var(--vscode-textLink-activeForeground); }
  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
</style>
</head>
<body>
${this.body()}
<script nonce="${n}">
  const vscodeApi = acquireVsCodeApi();
  for (const link of document.querySelectorAll('a[data-path]')) {
    link.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'open', path: link.dataset.path });
    });
  }
</script>
</body>
</html>`;
  }

  body() {
    const project = this.project;
    if (!project || !project.v2) {
      return '<p class="quiet">No AI-DLC v2 project is being watched.</p>';
    }
    if (project.v2.ok === false) {
      // A v2 install whose compiled stage graph could not be read. Named, because
      // "nothing here" would be a lie.
      return `<p class="warn">v2 is installed but its compiled stage graph could not be read (${escapeHtml(
        project.v2.reason
      )}).</p><p class="quiet">Progress cannot be reported until that file is readable.</p>`;
    }
    const intent = project.v2.active;
    if (!intent) {
      return '<p class="quiet">v2 is installed; no intent has been started yet.</p>';
    }
    // Order is by urgency, not by time. That is stated because the first reading
    // of this panel assumed it was a timeline top to bottom, and nothing on screen
    // said otherwise.
    return [
      this.intro(intent),
      this.position(project, intent),
      // Above the refusals, because a gate waiting on the reader is the one thing in
      // this panel that only the reader can clear.
      this.awaiting(intent),
      this.blocking(intent),
      this.sensors(intent),
      this.contrast(intent),
      this.gaps(project)
    ]
      .filter(Boolean)
      .join('\n');
  }

  // What this panel is for, in one sentence, because none of what follows is
  // self-explanatory to someone who has not read the engine's source.
  //
  // The v2 workflow is run by an engine that checks its own output and records
  // every check. The person approving a stage sees the agent's summary in chat and
  // none of those records. So this panel exists to answer one question: is there
  // anything in what the engine recorded that should change my mind before I
  // approve.
  intro(intent) {
    const total =
      intent.diagnosis.live.length +
      intent.diagnosis.sensorFailureTotal +
      intent.contrast.rows.length;
    if (total === 0) {
      return '<p class="quiet">The engine recorded no unresolved findings for this run. Sections below are ordered by urgency, not by time.</p>';
    }
    return `<p class="quiet">What AI-DLC's engine recorded and the chat did not show you. Ordered by urgency, not by time.</p>`;
  }

  // Where am I. The one thing v2 prints once into the chat and then loses to
  // scrollback.
  position(project, intent) {
    const journey = intent.journey;
    const at = journey.currentIndex >= 0 ? journey.checkpoints[journey.currentIndex] : undefined;
    // Every stage gets a segment so the rail is continuous and nothing reads as a
    // missing tooth. The furthest reached is ringed, which is the only position
    // marker: v1 established that where the reader's open file sits is not what
    // they want to know.
    const rail = journey.checkpoints
      .map((node, index) => {
        const classes = ['seg', node.status];
        if (index === journey.currentIndex) classes.push('current');
        const number = index + 1;
        const unitPart =
          node.forEach && node.unitsPlanned > 0 ? ` — ${node.unitsDone}/${node.unitsPlanned} units` : '';
        // A stage the scope never included reads as "not in scope" rather than as
        // "skipped": the latter claims the run went past it, which for a stage in a
        // later phase is not true and made the rail look wrong. A conditional stage
        // that is in scope is not promised either -- the scope grid says eligible,
        // and the stage decides against the project.
        const state = node.outOfScope
          ? 'not in scope'
          : node.status === 'pending' && node.mayNotRun
            ? 'runs only if needed'
            : node.status;
        return `<span class="${classes.join(' ')}" title="${escapeHtml(
          `${number}. ${node.label} — ${state}${unitPart}`
        )}"></span>`;
      })
      .join('');

    // Per phase, done out of planned, and separately how many are underway.
    //
    // Counting only `done` made a phase that is actively being worked read as
    // untouched: on a real project the construction row said 0/3 while its first
    // stage had both units finished and was sitting at its gate. The count is
    // right and the impression is wrong, so the in-flight ones are named.
    const phaseRows = project.v2.phases
      .map((phase) => {
        const nodes = journey.checkpoints.filter((node) => node.phase === phase && node.planned);
        // A phase the scope skipped in full is not progress the reader is waiting
        // on, so it earns no row.
        if (nodes.length === 0) return '';
        const done = nodes.filter((node) => node.status === 'done').length;
        const active = nodes.filter((node) => node.status === 'active').length;
        const suffix = active > 0 ? ` <span class="live">+${active} underway</span>` : '';
        return `<tr><td class="k">${escapeHtml(phase)}</td><td class="n">${done}/${nodes.length}${suffix}</td></tr>`;
      })
      .join('');

    // Stages that repeat per unit of work. A single tick for such a stage is what
    // made the v1 percentage overstate progress, so each is broken out with its
    // own unit count.
    const unitRows = journey.checkpoints
      .filter((node) => node.forEach && node.planned)
      .map((node) => {
        const inFlight =
          node.unitsInFlight && node.unitsInFlight.length > 0
            ? ` <span class="quiet">(${escapeHtml(node.unitsInFlight.join(', '))})</span>`
            : '';
        return `<tr><td class="k">${escapeHtml(node.label)}</td><td class="n">${node.unitsDone}/${node.unitsPlanned} units${inFlight}</td></tr>`;
      })
      .join('');

    // Stages underway, named rather than counted. On a 33-stage workflow the
    // question a reader has is which stage is being worked, and the rail's ring
    // answers it only for the furthest one.
    const underway = journey.checkpoints.filter(
      (node) => node.planned && node.status === 'active'
    );

    return `<h2>Position</h2>
<div class="stage">${escapeHtml(at ? at.label : 'Not started')}</div>
<div class="rail">${rail}</div>
<table>
  <tr><td class="k">in scope</td><td class="n">${journey.counts.done}/${journey.plannedTotal} done${
    underway.length > 0 ? ` <span class="live">+${underway.length} underway</span>` : ''
  }</td></tr>
  ${
    underway.length > 0
      ? `<tr><td class="k">underway</td><td class="n live">${escapeHtml(
          underway.map((node) => node.label).join(', ')
        )}</td></tr>`
      : ''
  }
  <tr><td class="k">scope</td><td class="n">${escapeHtml(intent.scope ?? 'unrecorded')}</td></tr>
  ${phaseRows}
</table>
${
  journey.units.length > 0
    ? `<h2>Units of work</h2><table>${unitRows}</table>`
    : ''
}`;
  }

  // What is stopping the workflow right now.
  //
  // Only refusals with nothing after them for their stage: a completed run logs
  // dozens it recovered from within seconds, and listing those would make this
  // section noise. The sequence is included because the engine's message states
  // the remedy without stating how the workflow got there, and that is only
  // visible as an ordering.
  blocking(intent) {
    const live = intent.diagnosis.live;
    if (live.length === 0) {
      return `<h2>Anything stuck</h2><p class="quiet">No. The engine refused an action ${
        intent.diagnosis.refusals.length
      } time(s) during this run &mdash; usually a step running out of order &mdash; and every one was resolved. Nothing is waiting on you here.</p>`;
    }
    const blocks = live
      .map((entry) => {
        const sequence = entry.context
          .map((row) => {
            const isHit = row.event === 'ERROR_LOGGED' && row.timestamp === entry.timestamp;
            return `<div class="${isHit ? 'hit' : 'quiet'}">${escapeHtml(
              String(row.timestamp ?? '').slice(11, 19)
            )}  ${escapeHtml(row.event)}${row.unit ? `  ${escapeHtml(row.unit)}` : ''}</div>`;
          })
          .join('');
        return `<div class="block">
  <div class="msg">${escapeHtml(entry.message)}</div>
  ${entry.command ? `<div class="quiet" style="margin-top:4px"><code>${escapeHtml(entry.command)}</code></div>` : ''}
  <div class="quiet" style="margin-top:6px">What led here, oldest first:</div>
  <div class="seq">${sequence}</div>
</div>`;
      })
      .join('');
    // The sequence is the point. The engine's message states the remedy but not
    // how the workflow reached the state it refuses, and that is only visible as
    // an ordering of events.
    return `<h2 class="warn">Anything stuck</h2>
<p class="quiet">The engine is refusing an action. Its own words are below, with the events that led to it.</p>${blocks}`;
  }

  // What the agent said about its own coverage, next to what the engine's sensor
  // found in the same file. Two numbers, no verdict.
  //
  // The pairing is worth surfacing because only one side of it ever reached the
  // user: an agent recorded 45 of 46 requirements covered while the sensor
  // reported 89 findings in that same record, and the summary shown in chat was
  // the agent's. Which is right is not decided here -- the two answer slightly
  // different questions, and a computed difference would look authoritative
  // without being true.
  contrast(intent) {
    const { rows, faultedWithoutRecord } = intent.contrast;
    if (rows.length === 0 && faultedWithoutRecord.length === 0) return '';

    const body = rows
      .map((row) => {
        if (!row.readable) {
          return `<tr><td class="k">${escapeHtml(
            row.filePath.split('/').slice(-2).join('/')
          )}</td><td class="n warn">unreadable</td></tr>`;
        }
        const claim = [...row.byStatus]
          .map(([status, count]) => `${count} ${escapeHtml(status)}`)
          .join(', ');
        const detail = row.detailPaths[0]
          ? `<a data-path="${escapeHtml(this.absolute(row.detailPaths[0]))}">read what the engine could not account for</a>`
          : '<span class="quiet">no detail recorded</span>';
        return `<tr><td class="k">${escapeHtml(row.stage ?? '(stage unstated)')}</td><td class="n">${
          row.itemCount
        } requirement(s)${row.recordCount > 1 ? ` in ${row.recordCount} records` : ''}</td></tr>
<tr><td class="quiet indent">agent says</td><td class="n quiet">${claim || '&mdash;'}</td></tr>
<tr><td class="quiet indent">engine found</td><td class="n warn">${
          row.sensorFindings
        } unaccounted, over ${row.sensorFirings} check(s)</td></tr>
<tr><td colspan="2" class="indent" style="padding-bottom:6px">${detail}</td></tr>`;
      })
      .join('');

    const orphans = faultedWithoutRecord.length
      ? `<p class="quiet">Sensor faulted with no record found: ${escapeHtml(
          faultedWithoutRecord.join(', ')
        )}.</p>`
      : '';

    return `<h2 class="warn">The agent's claim, and the engine's check of it</h2>
<p class="quiet">At some stages the agent writes a record of which requirements it covered. The engine then reads that same file and reports what it could not account for. The chat showed you the agent's version. Both numbers are below and neither is corrected against the other &mdash; they answer slightly different questions, so the judgement is yours.</p>
<table>${body}</table>${orphans}`;
  }

  // What the engine's own checks flagged and nobody was told.
  //
  // "Sensor" is the engine's word for an automatic check it runs over each
  // artifact as it is written: whether the required sections are present, whether
  // every upstream requirement is accounted for, whether the traceability record
  // adds up, whether the code lints. They are advisory by design, so a failing one
  // never stops the workflow and never appears in chat.
  //
  // Findings are counted per sensor rather than listed one per row. A first
  // version repeated the sensor's name once per finding, so a stage with fifteen
  // findings from one check printed that check's name fifteen times, and the six
  // that fitted looked like an arbitrary subset.
  sensors(intent) {
    const byStage = intent.diagnosis.sensorFailures;
    if (byStage.size === 0) {
      return `<h2>Checks the engine ran</h2>
<p class="quiet">Nothing was flagged. The engine checks each artifact as it is written and records the result; none of those checks failed in this run.</p>`;
    }

    const rows = [...byStage]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([stage, failures]) => {
        // Group by sensor so a name appears once with its count, and keep the
        // first detail file per sensor as the thing to open.
        const bySensor = new Map();
        for (const failure of failures) {
          const key = failure.sensorId ?? 'unnamed check';
          if (!bySensor.has(key)) bySensor.set(key, { count: 0, detail: undefined });
          const entry = bySensor.get(key);
          entry.count += 1;
          entry.detail = entry.detail ?? failure.detailPath ?? failure.outputPath;
        }
        const detailRows = [...bySensor]
          .sort((a, b) => b[1].count - a[1].count)
          .map(([name, entry]) => {
            const label = `${escapeHtml(name)}${entry.count > 1 ? ` ×${entry.count}` : ''}`;
            // Every finding observed so far had a detail file, so a name without a
            // link means the engine did not record one — worth being able to tell
            // apart at a glance rather than guessing.
            const cell = entry.detail
              ? `<a data-path="${escapeHtml(this.absolute(entry.detail))}">${label}</a>`
              : `${label} <span class="quiet">(no detail recorded)</span>`;
            return `<tr><td colspan="2" class="indent">${cell}</td></tr>`;
          })
          .join('');
        return `<tr><td class="k">${escapeHtml(stage)}</td><td class="n warn">${failures.length}</td></tr>
${detailRows}`;
      })
      .join('');

    return `<h2 class="warn">Checks the engine ran</h2>
<p class="quiet">The engine checks each artifact as it is written &mdash; required sections, upstream coverage, traceability, linting. These are advisory, so the workflow continued and the chat said nothing. Click a check to read exactly what it found.</p>
<table>${rows}</table>`;
  }

  // Anything in this project the model could not account for. Shown because an
  // empty gap list is a claim, and a reader deserves to know when it fails.
  // Stages the engine finished and has not moved past.
  //
  // The panel's reason to exist. In v2 the agent reads and you approve, so a stage
  // here is not slow, it is stopped on you, and the chat said so once several hundred
  // lines ago.
  //
  // A row says how this was concluded, because the two are not equally certain. When
  // the engine emitted its own awaiting-approval record, that is quoted. When it did
  // not -- and the newer engine does not, for some gates -- the stage is here because
  // it finished its work, the graph does not have it as done, and nothing has moved it
  // since. Worth distinguishing on screen rather than presenting both as the engine's
  // word.
  //
  // Nothing waiting produces no section, not a reassuring line, which is the rule the
  // refusals section follows too.
  awaiting(intent) {
    const waiting = intent.diagnosis.waitingOnYou ?? [];
    if (waiting.length === 0) return '';

    const rows = waiting
      .map((entry) => {
        const stage = this.stageLabel(intent, entry.stage);
        const when = entry.timestamp
          ? ` <span class="quiet">since ${escapeHtml(entry.timestamp)}</span>`
          : '';
        const how = entry.stated
          ? '<div class="quiet">the engine recorded that it is waiting for approval</div>'
          : '<div class="quiet">finished its work and nothing has moved it since</div>';
        const detail = entry.detail ? `<div class="quiet">${escapeHtml(entry.detail)}</div>` : '';
        return `<div class="block"><strong>${escapeHtml(stage)}</strong>${when}${how}${detail}</div>`;
      })
      .join('');

    return `<h2 class="warn">Waiting for you</h2>
<p class="quiet">Nothing here moves until you approve it or ask for changes.</p>${rows}`;
  }

  // A stage's own name when the compiled graph has one, and its slug otherwise. The
  // slug is what the ledger records, and a slug this build has never seen still has
  // to render.
  stageLabel(intent, slug) {
    if (!slug) return '(stage not recorded)';
    const node = intent.journey.checkpoints.find((cp) => cp.id === slug);
    return node ? node.label : slug;
  }

  // The unknown-event list is no longer shown here.
  //
  // Reviewed across four projects and it printed a near-identical set every time:
  // the same five to eleven bookkeeping names, unchanged by anything the user does.
  // A section that cannot vary with the project says nothing about the project, and
  // an unchanging block trains a reader to skip the panel it sits in.
  //
  // It is not deleted. Under branch-tracking it is the only thing that notices
  // upstream growing a vocabulary this build has not met, so it moved to the
  // diagnostic command and `npm run probe`, where a maintainer looks. See
  // install-commands.js.
  //
  // Reviewing it also earned its keep: three of the names it was listing were
  // STAGE_AWAITING_APPROVAL, SUMMARY_CONFIRMATION_RECORDED and DECISION_RECORDED --
  // a panel about supervising delegation announcing it had no meaning for the event
  // that says the delegation is waiting on you. The first of those is now a section
  // of its own.
  gaps() {
    return '';
  }

  // Sensor paths in the ledger are relative to the project root.
  absolute(target) {
    if (!this.root) return target;
    return target.startsWith('/') ? target : vscode.Uri.joinPath(this.root, target).fsPath;
  }
}

module.exports = { SupervisionViewProvider, VIEW_ID, CONTEXT_KEY };
