'use strict';

// The /aidlc command, drawn: what to type, which plan each scope is, what the two dials
// and the switches change, and which command fits which situation. Shown on the Start
// page under "What was set up", because that is where a person sits with a configured
// project and the one question "what do I type".
//
// What is READ and what is WRITTEN here:
//
//   - The scope rows come from the project's own engine files: `scope-grid.json` for
//     which stages each scope runs (counted the way `aidlc --help` counts, without the
//     three Initialization stages) and `.kiro/scopes/aidlc-<name>.md` frontmatter for
//     the description, depth, test strategy and defaults. So the table is the installed
//     engine's, not this build's memory of it; a new or renamed scope appears without a
//     release here. A project without those files shows no scope table rather than an
//     old one.
//   - The dials, switches and examples are the engine's own definitions, copied from
//     `aidlc engine orchestrate help` and `stage-protocol.md` (2.11.3) with the numbers
//     they give. These change rarely and are not in a data file the project carries, so
//     they are text here and the footer says where the authoritative list is.
//
// Pure: paths in, HTML out. No vscode.

const fs = require('fs');
const path = require('path');

const INITIALIZATION_PHASE = 'initialization';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// `key: value` lines of a scope file's frontmatter. Lists (`keywords:` with `- item`
// lines) are skipped: nothing here needs them.
function readScopeFrontmatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return undefined;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '' || value === '[]') continue;
    value = value.replace(/^"(.*)"$/, '$1');
    out[kv[1]] = value;
  }
  return out;
}

// One row per scope the project's grid knows, sorted lightest first.
function readScopeCatalogue(root, { readStageGraph, readScopeGrid } = require('./graph')) {
  const graph = readStageGraph(root);
  const grid = readScopeGrid(root);
  if (!graph || !grid) return [];
  const counted = graph.stages.filter((s) => s.phase !== INITIALIZATION_PHASE);
  const total = counted.length;
  const rows = [];
  for (const [name, entry] of Object.entries(grid.scopes)) {
    const run = counted.filter((s) => entry.inScope.has(s.slug)).length;
    const meta = readScopeFrontmatter(path.join(root, '.kiro', 'scopes', `aidlc-${name}.md`)) ?? {};
    rows.push({
      name,
      run,
      total,
      description: meta.description,
      depth: (meta.depth ?? '').toLowerCase() || undefined,
      testStrategy: (meta.testStrategy ?? meta.test_strategy ?? '').toLowerCase() || undefined,
      reviewCap: meta.review_cap,
      guardPolicy: meta.guard_policy,
      planApproval: meta.plan_approval
    });
  }
  rows.sort((a, b) => a.run - b.run || a.name.localeCompare(b.name));
  return rows;
}

// The widths the shell's stylesheet has classes for (.w0 … .w100), so the bar is CSS
// under the page's CSP rather than an inline style the CSP drops.
function widthClass(part, whole) {
  if (!whole) return 'w0';
  return `w${Math.max(0, Math.min(100, Math.round((100 * part) / whole)))}`;
}

function scopeTable(rows) {
  if (rows.length === 0) {
    return `<p class="quiet">The scope list comes from this project's engine files, which are not readable here. Type <code>/aidlc --help</code> in the chat for it.</p>`;
  }
  const body = rows
    .map((r) => {
      const dials = [r.depth, r.testStrategy && r.testStrategy !== r.depth ? `tests ${r.testStrategy}` : null].filter(Boolean).join(' · ');
      const note = [
        r.guardPolicy && r.guardPolicy !== 'off' ? `guard ${r.guardPolicy}` : null,
        r.planApproval === 'off' ? 'no plan approval' : null,
        r.reviewCap === 'none' ? 'no reviews' : null
      ]
        .filter(Boolean)
        .join(', ');
      return `<tr>
<td class="k"><code>${esc(r.name)}</code></td>
<td class="viz"><div class="bar"><div class="bar-fill ${widthClass(r.run, r.total)}"></div></div></td>
<td class="num">${r.run}/${r.total}</td>
<td class="quiet nowrap">${esc(dials)}</td>
<td>${esc(r.description ?? '')}${note ? ` <span class="quiet">(${esc(note)})</span>` : ''}</td>
</tr>`;
    })
    .join('\n');
  return `<table class="scopes">
<thead><tr><th>scope</th><th colspan="2">stages it runs</th><th>depth</th><th>for</th></tr></thead>
<tbody>${body}</tbody>
</table>
<p class="quiet">Stages counted as <code>/aidlc --help</code> counts them, without the three Initialization stages every run performs. Depth is how much each stage writes and asks; where tests differ from depth it says so.</p>`;
}

// A three-step scale: the levels of --depth and --test-strategy, with the engine's own
// numbers for each. Marked cells are the defaults the scopes above use most.
function scale(name, steps) {
  const cells = steps
    .map(
      (s) => `<div class="step"><div class="step-name"><code>${esc(s.level)}</code></div><div class="step-what">${esc(s.what)}</div></div>`
    )
    .join('');
  return `<div class="dial"><div class="dial-name"><code>${esc(name)}</code></div><div class="steps">${cells}</div></div>`;
}

function renderCommandGuide({ root, catalogue }) {
  const rows = catalogue ?? readScopeCatalogue(root);
  return `<section class="guide">
<h2>How to start /aidlc</h2>
<div class="tiles ways">
  <div class="tile">
    <div class="way-cmd"><code>/aidlc</code> <span class="arg">what you want to build</span></div>
    <div class="way-what">Describe it in a sentence. The agent picks a plan from the list below and asks you to confirm it.</div>
    <div class="way-eg">/aidlc Fix the login timeout bug</div>
  </div>
  <div class="tile">
    <div class="way-cmd"><code>/aidlc --scope</code> <span class="arg">name</span> <span class="arg">"task"</span></div>
    <div class="way-what">You name the plan. Fixed stage list, one confirmation, then it runs.</div>
    <div class="way-eg">/aidlc --scope workshop "Add a review mode to WordBook"</div>
  </div>
  <div class="tile">
    <div class="way-cmd"><code>/aidlc compose</code> <span class="arg">"task"</span></div>
    <div class="way-what">A plan tailored to this task. The composer scans the code, proposes stages and says why; Approve, Edit or Reject.</div>
    <div class="way-eg">/aidlc compose "Add a review mode, following CHANGE.md"</div>
  </div>
  <div class="tile">
    <div class="way-cmd"><code>/aidlc</code></div>
    <div class="way-what">Nothing after it: resume the running workflow, or start fresh if there is none.</div>
    <div class="way-eg">/aidlc --status &nbsp;·&nbsp; where it is, read-only</div>
  </div>
</div>

<h3>The plans (scopes)</h3>
${scopeTable(rows)}

<h3>Two dials, on any plan</h3>
<div class="dials">
${scale('--depth', [
    { level: 'minimal', what: '2–4 questions per stage, brief artifacts' },
    { level: 'standard', what: '5–8 questions per stage, full artifacts' },
    { level: 'comprehensive', what: '8–12+ questions, deep analysis, every stage' }
  ])}
${scale('--test-strategy', [
    { level: 'minimal', what: '1 test per requirement, a happy-path test per component (5–15 total)' },
    { level: 'standard', what: '5–8 tests per component, unit + integration' },
    { level: 'comprehensive', what: '10–15 per component, plus E2E, performance, security' }
  ])}
</div>
<p class="quiet">Depth sets how much is written and asked; it does not change which stages run (the plan does). Test strategy follows depth unless set on its own.</p>

<h3>Switches</h3>
<table class="switches">
<tr><td class="k"><code>--project-type</code></td><td><code>greenfield</code> | <code>brownfield</code></td><td>Say so instead of letting the scan guess. Brownfield runs Reverse Engineering on the existing code first.</td></tr>
<tr><td class="k"><code>--review</code></td><td><code>adversarial</code> | <code>advisory</code> | <code>none</code></td><td>How each stage is reviewed before its gate.</td></tr>
<tr><td class="k"><code>--guard-policy</code></td><td><code>strict</code> | <code>relaxed</code> | <code>off</code></td><td>When an approved input changes: re-approve, record and announce, or ignore.</td></tr>
<tr><td class="k"><code>--sensors</code> <code>--learnings</code><br><code>--summary-confirmation</code> <code>--collaborators</code></td><td><code>on</code> | <code>off</code></td><td>The engine's checks on each artifact; the learnings ritual; confirming a summary before each gate; support agents beside the lead.</td></tr>
<tr><td class="k"><code>--stage</code> <code>--phase</code></td><td>a slug or number</td><td>Jump: <code>/aidlc --stage code-generation</code>, <code>/aidlc --phase construction</code>.</td></tr>
</table>

<h3>By situation</h3>
<table class="examples">
<tr><td class="k">First time, not sure</td><td><code>/aidlc</code> <span class="quiet">then describe the work when asked</span></td></tr>
<tr><td class="k">A workshop, time-boxed</td><td><code>/aidlc --scope workshop "…"</code> <span class="quiet">standard documents, minimal tests, every gate</span></td></tr>
<tr><td class="k">Existing code, requirements already written</td><td><code>/aidlc compose --project-type brownfield --depth minimal --test-strategy minimal "… follow CHANGE.md …"</code></td></tr>
<tr><td class="k">One bug</td><td><code>/aidlc --scope bugfix "…"</code></td></tr>
<tr><td class="k">Prove an idea fast</td><td><code>/aidlc --scope poc "…"</code> <span class="quiet">or lighter still, <code>express</code></span></td></tr>
<tr><td class="k">Change course mid-run</td><td><code>/aidlc --depth minimal</code> · <code>/aidlc --review advisory</code> · <code>/aidlc compose "what to cut"</code> <span class="quiet">adjusts only the stages not yet run</span></td></tr>
<tr><td class="k">Where is it</td><td><code>/aidlc --status</code> <span class="quiet">the same answer as the tree above</span></td></tr>
</table>
<p class="quiet">The full list, with every verb: <code>/aidlc --help</code> in the chat. Scope rows above are read from this project's engine files; the rest is from the engine's own help and protocol text.</p>
</section>`;
}

module.exports = { readScopeCatalogue, readScopeFrontmatter, renderCommandGuide, widthClass };
