'use strict';

// The /aidlc command builder on the Start page: pick, and the command grows.
//
// Why a builder and not a yes/no quiz. The question that decides the plan is "what kind
// of work is this", a single choice, not a chain of binaries; the five lightest scopes
// are all 5-7 stages at minimal depth and differ in kind, not size, so "is it a simple
// app?" cannot tell them apart. And the engine already owns the judgement: `/aidlc
// <description>` has the agent propose a plan, and `compose` scans the code and scores
// its uncertainty before proposing stages with reasons. A quiz that produced a finished
// command from the extension's own heuristics would be a worse version of that, and
// would hide why the command is what it is. So each row here is one parameter, every
// option shows the flag it adds, and the command at the top is rebuilt from the choices
// as they are made. The default state composes `/aidlc` alone, which is the engine's
// own recommended start, so a person who picks nothing is told the right thing.
//
// What the builder does NOT do: no scoring, no inference from the project, no
// --review / --guard-policy / --sensors (the scope's defaults are right; the switches
// table in the guide below covers them). It turns choices into flags, and that is all.
//
// `composeCommand` is pure and is ALSO the function the page's script runs: its source
// is embedded verbatim (Function.prototype.toString), so the command a test sees here is
// the command the page shows. Keep it free of closures and of anything Node-only.

const INPUT_LIMIT = 2000;

// The forms the engine documents for naming a plan with a task: `--scope <name> "task"`
// (orchestrate.ts: `/aidlc --scope feature "build the auth service"`). A bare scope
// word before free text is ambiguous when the word is also ordinary English ("feature
// flags for billing"), and the engine stops to ask; the flag form never does.
function composeCommand(choices) {
  const c = choices || {};
  const kind = c.kind || 'propose';
  const q = (text) => '"' + String(text).replace(/"/g, '\\"') + '"';
  const description = String(c.description || '').replace(/\s+/g, ' ').trim();
  const flags = [];
  let projectType = c.projectType && c.projectType !== 'default' ? c.projectType : undefined;
  // "Existing code with a spec written" is compose on brownfield; the person's own
  // explicit answer to "new or existing" still wins.
  if (kind === 'compose-brownfield' && !projectType) projectType = 'brownfield';
  if (projectType) flags.push('--project-type ' + projectType);
  if (c.depth && c.depth !== 'default') flags.push('--depth ' + c.depth);
  if (c.testStrategy && c.testStrategy !== 'default') flags.push('--test-strategy ' + c.testStrategy);

  const presets = { workshop: 'workshop', bugfix: 'bugfix', poc: 'poc' };
  let head;
  let quoted = true;
  if (kind === 'compose' || kind === 'compose-brownfield') {
    head = '/aidlc compose';
  } else if (presets[kind]) {
    head = '/aidlc --scope ' + presets[kind];
  } else if (kind === 'scope') {
    head = c.scope ? '/aidlc --scope ' + String(c.scope).replace(/[^a-z0-9-]/g, '') : '/aidlc';
  } else {
    // propose: the engine reads free text and proposes a plan; no quotes, as in its help.
    head = '/aidlc';
    quoted = false;
  }
  const parts = [head].concat(flags);
  let placeholder = false;
  if (description) {
    parts.push(quoted ? q(description) : description);
  } else if (quoted) {
    placeholder = true;
  }
  return { text: parts.join(' '), placeholder, prompt: parts.join(' ') + ' ' };
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function radio(name, value, label, flag, checked) {
  const id = `${name}-${value}`;
  return `<label class="opt" for="${id}"><input type="radio" id="${id}" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''}><span class="opt-label">${esc(label)}</span>${flag ? `<span class="opt-flag">${esc(flag)}</span>` : ''}</label>`;
}

// `catalogue` is readScopeCatalogue's rows (command-guide.js), so the preset rows and
// the scope list are the installed engine's. A preset whose scope the engine lacks is
// not offered; with no catalogue at all (engine files unreadable) the presets are shown
// and the picker is not, because the engine's own help lists these three on 2.11.x.
function renderCommandBuilder({ catalogue = [], nonce, guideHref }) {
  const names = new Set(catalogue.map((r) => r.name));
  const has = (name) => catalogue.length === 0 || names.has(name);
  const kindRow = [
    radio('kind', 'propose', 'Let AI-DLC propose a plan', 'describe it; the agent picks', true),
    has('workshop') ? radio('kind', 'workshop', 'A workshop, time-boxed', '--scope workshop') : '',
    has('bugfix') ? radio('kind', 'bugfix', 'One bug', '--scope bugfix') : '',
    has('poc') ? radio('kind', 'poc', 'Prove an idea fast', '--scope poc') : '',
    radio('kind', 'compose-brownfield', 'Existing code, spec written', 'compose --project-type brownfield'),
    catalogue.length
      ? `<label class="opt" for="kind-scope"><input type="radio" id="kind-scope" name="kind" value="scope"><span class="opt-label">Pick a plan</span><select id="scopePick" class="pick">${catalogue
          .map((r) => `<option value="${esc(r.name)}">${esc(r.name)} · ${r.run}/${r.total}${r.depth ? ` · ${esc(r.depth)}` : ''}</option>`)
          .join('')}</select><span class="opt-flag">--scope …</span></label>`
      : ''
  ].join('');
  const three = (name, flag) =>
    [
      radio(name, 'default', name === 'depth' ? "The plan's own" : 'Follows depth', '', true),
      radio(name, 'minimal', 'minimal', `${flag} minimal`),
      radio(name, 'standard', 'standard', `${flag} standard`),
      radio(name, 'comprehensive', 'comprehensive', `${flag} comprehensive`)
    ].join('');
  const ptypeRow = [
    radio('ptype', 'default', 'Let the scan decide', '', true),
    radio('ptype', 'greenfield', 'New project', '--project-type greenfield'),
    radio('ptype', 'brownfield', 'Existing code', '--project-type brownfield')
  ].join('');

  return `<div class="builder">
  <div class="composed"><code class="big" id="cmd">/aidlc</code><span class="ph" id="ph" hidden>"…"</span></div>
  <p class="quiet" id="cmdHint">Describe what you want to build after it, or choose below and the command grows.</p>
  <div class="btns"><button class="btn primary" id="openChat" type="button">Open chat with this command</button><a class="btn" href="${guideHref}">Guide</a></div>
  <div class="rows">
    <div class="row"><div class="row-q">What kind of work?</div><div class="row-opts">${kindRow}</div></div>
    <div class="row"><div class="row-q">New or existing code?</div><div class="row-opts">${ptypeRow}</div></div>
    <div class="row"><div class="row-q">How much to write and ask?</div><div class="row-opts">${three('depth', '--depth')}</div></div>
    <div class="row"><div class="row-q">How many tests?</div><div class="row-opts">${three('tests', '--test-strategy')}</div></div>
    <div class="row"><div class="row-q">Describe the work</div><div class="row-opts"><input type="text" id="desc" class="desc" maxlength="${INPUT_LIMIT}" placeholder="what you want to build, in a sentence"></div></div>
  </div>
  <p class="quiet">Nothing here decides for you: each choice adds the flag shown beside it, and the engine still confirms the plan before anything runs. Pick nothing and <code>/aidlc</code> alone is the right start.</p>
</div>
<script nonce="${nonce}">
(function () {
  const compose = ${composeCommand.toString()};
  const vscode = acquireVsCodeApi();
  const cmd = document.getElementById('cmd');
  const ph = document.getElementById('ph');
  const hint = document.getElementById('cmdHint');
  const pick = document.getElementById('scopePick');
  const desc = document.getElementById('desc');
  function checked(name) {
    const el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : undefined;
  }
  function choices() {
    return {
      kind: checked('kind'),
      scope: pick ? pick.value : undefined,
      projectType: checked('ptype'),
      depth: checked('depth'),
      testStrategy: checked('tests'),
      description: desc.value
    };
  }
  let current = compose(choices());
  function render() {
    current = compose(choices());
    cmd.textContent = current.text;
    ph.hidden = !current.placeholder;
    if (pick) pick.disabled = checked('kind') !== 'scope';
    hint.textContent = checked('kind') === 'propose' && !desc.value.trim()
      ? 'Describe what you want to build after it, or choose below and the command grows.'
      : 'The button opens Kiro\\u2019s chat with this in the input. Nothing runs until you press Enter there.';
  }
  document.querySelectorAll('.builder input, .builder select').forEach((el) => {
    el.addEventListener('change', render);
    el.addEventListener('input', render);
  });
  if (pick) pick.addEventListener('change', () => { document.getElementById('kind-scope').checked = true; render(); });
  document.getElementById('openChat').addEventListener('click', () => {
    vscode.postMessage({ type: 'openChat', prompt: current.prompt });
  });
  render();
})();
</script>`;
}

// What the extension accepts back from the page: a string the builder could have made.
// Anything else is dropped rather than typed into the chat.
function acceptablePrompt(value) {
  return typeof value === 'string' && value.length <= INPUT_LIMIT + 200 && /^\/aidlc( |$)/.test(value) && !/[\r\n]/.test(value);
}

module.exports = { composeCommand, renderCommandBuilder, acceptablePrompt, INPUT_LIMIT };
