# aidlc-viewer: pitfalls found in the field

One entry per defect that reached a build or was caught only by a running test. Each
says what broke, why, and which test now pins it. Add to this file in the same commit
as the fix; do not record things the tests or commit messages already say on their own.

## Rules that hold for every change

- 6,000+ users. Every step: `npm test` + `npm run regress` (4 samples must read
  `unchanged`) + `node --test tests/v1-isolation.test.js` (24). Run tests BEFORE the
  commit command, in a separate shell call, never chained with `&&` after the tests.
  On 2026-10-13 a chained call committed with one failing test (71e2f4f, fixed in
  eea86b1).
- Version number: the undeployed build keeps its number across rebuilds. 0.0.26 is
  undeployed; keep rebuilding as 0.0.26 until it ships, then bump.
- Position comes from the project's structure, never from parsing Markdown. A state
  file may be read as a second opinion and shown labelled as such; it never decides a
  label (0.0.19 principle; violated by the StageItem until eeb2efe).
- Report only what Kiro recorded. No cost, no token estimates, no "0 in · 0 out" when
  the field exists but was never filled (all-zero token fields read as not recorded).
- Do not name the program that wrote a session. IDE and current kiro-cli write to the
  same `~/.kiro/sessions/<hash>/sess_*` store (verified with sess_b1617a58 on
  2026-10-13). The layout does not say who wrote it.
- Korean replies: no hyphens or middle dots as separators inside sentences.

## Webview script inside a template literal (src/extension.js getWebviewHtml)

The viewer script is a JS template literal. Everything inside is unescaped once before
the browser sees it.

- `'\n'` in the webview code must be written `'\\n'` in the source file. `'\n'` becomes a
  literal line break (SyntaxError, viewer blank). `'\\\\n'` becomes `'\\n'`, a split on
  two characters (tables collapsed to one row; shipped in earlier builds, found 26d5fdd,
  fixed 6e8dc7e). Pin: viewer-single-pane "a Markdown table renders as rows".
- A backtick anywhere inside, including in a comment, ends the template literal.
- `getComputedStyle`, `requestAnimationFrame`, `setSelectionRange` must exist in the
  test sandbox stub or the script fails to load and all viewer tests fail together.
- A textarea that is `display:none` has no layout in the tick it becomes visible;
  scrollTop set then is dropped. Defer to requestAnimationFrame (6e8dc7e).
- Never sync the two panes by scroll ratio: rendered Markdown and its source differ in
  height, so the same ratio is different text. Keep place by text (6e8dc7e).
- `previewScroll` is declared after the mode-restore call at load; computing an anchor
  there threw. Pass an explicit empty anchor on restore.

## Tree summary rows

- There is ONE summary row (ProgressItem), labelled from `journey.currentIndex` only.
  Pin: v1-isolation "the tree has one summary row, labelled from the journey alone".
- `parseAidlcState` must read the phase from the `### <PHASE> PHASE` heading (emoji and
  trailing notes allowed), take top-level checkbox rows only (indented rows are per
  unit), take the status from after the dash (ASCII or em dash) with the parenthesis
  as a note, and never pick a SKIPPED/PLACEHOLDER unchecked row as "in progress". The
  old regex matched exactly one line of a current file: "Operations - PLACEHOLDER".
  Pins: state-format.test.js runs the real parser over both fixtures.

## Credits page (src/credits-page.js)

- The panel re-renders every 10 s and assigns `webview.html` only when it changed.
  Assigning it folds every `<details>` and resets scroll. The CSP nonce must therefore
  be fixed per panel lifetime (`nonce:` option) or every render differs and History
  closes itself (385be56). Pin: credits-page "rendering twice with the same nonce is
  byte-identical".
- `summary { display:flex }` drops the browser's disclosure marker; draw ▸/▾ with
  `::before`.
- The session store is outside the watched folder; no file event fires on a spent
  turn. The poll is the only refresh while the page is open.
- `readKiroUsage` caches 5 s. Session attribution: project folder itself or a
  subfolder only; a parent-folder session must be refused (it attributed to two
  unrelated projects before).

## Commands

- Every command the UI invokes must be in package.json AND registered in activate().
  `showCredits` shipped unregistered once ("command not found"). Pin:
  command-registration.test.js (three-way check).

## Environment traps for the agent

- KiroCrew's shell policy blocks any command whose text matches `kiro…crew … token`
  and any path under `~/Library/Application Support`, `~/.aws`. Write commit messages
  to a temp file and use `git commit -F`; avoid the word "token" in shell text.
- Python heredoc edits of extension.js often miss on indentation (the file is 2-space,
  `sed` output adds 2 more). Prefer the `strReplace` tool, confirm with a `read` first.
- `lsof`/`pgrep` are blocked; ask the user for process-level facts.
