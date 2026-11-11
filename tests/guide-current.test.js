'use strict';

// The built-in guide (EN + KO) describes the current build, not the one before it.
//
// The guide is prose inside getHelpHtml, and prose does not fail a test when the
// behaviour it describes changes. Asked for twice in one day: "the guide too". So the
// facts a user would act on are pinned here, in both languages, against the strings the
// code itself uses where there is one (PAGE_TITLE) and against the wording where there is
// not. When a feature changes, this fails and names the sentence to rewrite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { PAGE_TITLE } = require('../src/credits-page');

function helpHtml() {
  const file = path.join(__dirname, '..', 'src', 'extension.js');
  const realLoad = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (request !== 'vscode') return realLoad.call(this, request, ...rest);
    return {
      Uri: { file: (p) => ({ fsPath: p }), from: (c) => c, joinPath: (b, ...a) => ({ fsPath: path.join(b.fsPath, ...a), toString: () => 'x' }) },
      workspace: { fs: {} }, window: {}, commands: {},
      EventEmitter: class { constructor() { this.event = () => {}; this.fire = () => {}; } },
      TreeItem: class {}, TreeItemCollapsibleState: {}, ThemeIcon: class {}, ThemeColor: class {},
      MarkdownString: class {}, FileType: {}, RelativePattern: class {}, ProgressLocation: {}
    };
  };
  try {
    const m = new Module(file);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(`${fs.readFileSync(file, 'utf8')}\nmodule.exports = { getHelpHtml };`, file);
    return m.exports.getHelpHtml({ cspSource: 'x', asWebviewUri: (u) => u }, { fsPath: '/ext' });
  } finally {
    Module._load = realLoad;
  }
}

const html = helpHtml();

// Each entry: what the guide must say, in EN and KO. A missing one names the feature.
const MUST_SAY = {
  'the two pages are named as the code names them': [PAGE_TITLE.credits, PAGE_TITLE.waiting],
  'setup asks the generation first, then the harness in the same place': ['a second prompt in the same place', '같은 자리에 두 번째 알림'],
  'a project that has not run says Not started': ['Not started'],
  'the viewer has View and Edit, with double-click': ['✎ Edit', '🔍 View'],
  'HTML comments are shown dimmed': ['Things agents must never do'],
  'scope-skipped phases read not in scope': ['not in scope'],
  'bars are the share of the total (EN)': ['share of the project'],
  'bars are the share of the total (KO)': ['프로젝트 전체에서 차지하는 비율'],
  'the Waiting row changes colour (EN)': ['changes colour'],
  'the Waiting row changes colour (KO)': ['색이 바뀌는 행'],
  'the Waiting row has an agent-is-working state': ['agent is working'],
  'chat questions are a source (EN, KO)': ['A question in the chat', '채팅의 질문'],
  'the engine stop reason is a source (EN, KO)': ['The engine stopped for you', '엔진이 당신 때문에 멈춤'],
  'the see-the-chat state': ['see the agent'],
  'Usage re-reads while open (EN)': ['re-reads every few seconds'],
  'start commands per generation': ['Using AI-DLC', '/aidlc'],
  'a start page opens after setup (EN)': ['a page opens in the editor'],
  'a start page opens after setup (KO)': ['페이지가 열리고']
};

for (const [what, needles] of Object.entries(MUST_SAY)) {
  test(`guide says: ${what}`, () => {
    for (const n of needles) assert.ok(html.includes(n), `guide lacks "${n}"`);
  });
}

// Wording that described a previous build and must not come back.
const MUST_NOT_SAY = {
  'bars scaled to the largest row': ['relative to the costliest', '가장 비싼 단계'],
  'the old page names': ['Credits (Tokens)', 'Engine records', 'AI-DLC Engine Log', 'v2 Engine Log', 'Supervision panel'],
  'the old Read button': ['>Read<'],
  'a claim that the IDE records no tokens, which blamed the wrong thing': ['Kiro IDE records credits only'],
  'the folded engine records inside the Usage page': ['folded below']
};

for (const [what, needles] of Object.entries(MUST_NOT_SAY)) {
  test(`guide no longer says: ${what}`, () => {
    for (const n of needles) assert.ok(!html.includes(n), `guide still says "${n}"`);
  });
}

test('the guide is in both languages, and each v2 row has a card in each', () => {
  for (const title of [PAGE_TITLE.waiting]) {
    const count = html.split(title).length - 1;
    assert.ok(count >= 2, `${title} appears ${count} time(s); expected a card in EN and in KO`);
  }
  assert.ok(html.includes('시작하기'), 'KO section present');
  assert.ok(html.includes('Getting Started'), 'EN section present');
});
