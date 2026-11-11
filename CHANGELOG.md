# Changelog

The same notes as the README's What's New section, kept identical by a test
(tests/changelog.test.js). Edit both, or the suite fails. Newest first.

## 0.1.4

- **The viewer renders like Kiro's own Markdown preview.** It now uses the same engine
  (markdown-it) and follows the same typography. The hand-written renderer it replaces
  could not nest: on 423 real AI-DLC artifacts, half came out with broken structure, every
  code block wrapped in a paragraph, hard-wrapped paragraphs split per line, nested lists
  spilling out of their list, `snake_case` names italicised. Those read correctly now.
  Headings are the text colour rather than one colour per level; links and inline code
  keep their accents. Dimmed HTML comments, Mermaid, and double-click to edit are unchanged.
- **The v2 Engine Log row and page are gone.** Refusals and parked plans that need you
  were already on **Waiting for you**; the rest (sensor findings, the agent's coverage
  claim beside the engine's check) read the same on every project and nobody acted on it.

## 0.1.3

- **Unit-major runs show where they are.** With `Construction Iteration: unit-major`, the
  engine walks one unit through every per-unit stage before the next unit begins, and the
  later stages leave only unit rows in the ledger. The viewer read none of them, so a
  project two units in showed those stages as **not started** and the row looked stuck
  while `aidlc --status` moved. Every stage a unit has touched is now in progress with
  its unit count, and the position is the stage the latest unit row names, shown as
  **· on u3-…** beside the counts, which is what the engine's own status reports. Thanks
  to [@protzetter](https://github.com/protzetter) for the report and to
  [@wyptaotao](https://github.com/wyptaotao) for the diagnosis and a tested patch
  ([#2](https://github.com/jikang-jeong/aidlc-viewer-extension/issues/2)). 👍
- **Other extensions' settings register again.** An invalid language-override key in this
  extension's `configurationDefaults` could stop Kiro from registering settings contributed
  by other extensions (`git.enabled` "not a registered configuration", Volar failing to
  activate). The key never had any effect and is gone. Thanks to
  [@wyptaotao](https://github.com/wyptaotao) for finding and verifying it
  ([#3](https://github.com/jikang-jeong/aidlc-viewer-extension/issues/3)). 👍
- A changelog now ships with the extension, so the marketplace's Changes tab carries the
  same notes as this section.

## 0.1.2

- **The viewer follows the folder open in Kiro.** Open your project and it is watched;
  nothing to pick. With no folder open, **Open Workspace** opens one in Kiro. A watched
  folder with no AI-DLC in it shows a **Set up AI-DLC** panel in place of the tree, and
  its button asks the same two questions in the corner as before.
- **Setup never writes into a project that already has AI-DLC**, of either generation,
  from any button, decided at the moment you press it. Seen in a workshop: the setup
  toast was still on screen after the project had been configured by hand in a terminal,
  and pressing its v2 button asked Kiro IDE or CLI again; the other answer switched the
  project's harness and `/aidlc` disappeared. Upgrades and harness changes are
  `aidlc config` in a terminal, and the message now says so.
- **The position map reads the engine's audit ledger as well as its runtime graph.** A
  project whose `runtime-graph.json` was missing or behind (hooks that did not run, an
  untrusted workspace) read **Not started** with eleven stages completed; the ledger now
  fills in, and the tooltip says when it did. A conditional stage the engine declined
  reads **skipped** instead of in progress.
- **Usage lists stages in the order the run reached them**, not largest first.

## 0.1.1

- Minor bug fixes.

## 0.0.26

- **The viewer is one pane.** It opens rendered; press **Edit**, double-click the text you
  want to change, or `Ctrl/Cmd+E` to swap the same space for the Markdown source, and
  **Save** brings the view back. The split view with
  the source on one side showed everything twice and left room for neither. What you
  type is exactly what is saved — the view never rewrites your Markdown from the
  rendering, which is the one way a viewer could silently alter a file.
- **Usage.** A new row at the top of the tree opens a page with what Kiro spent on this
  project: total credits, the credits spent on aborted or failed turns, a breakdown by
  stage and by session, context-window usage per session, and token counts where Kiro CLI
  recorded them. Every number is Kiro's own record. Nothing is estimated and no money is
  shown. Works on v1 and v2 alike.
- **One sidebar for both generations, with two v2 rows.** The v2-only Supervision panel
  under the tree is gone. **Waiting for you** is a row with its count beside it and a page
  that reads what the engine wrote: unanswered questions files, refusals that need you,
  parked plans. **v2 Engine Log** is a row and a page with the engine's own account of
  the run. Both appear only on v2.
- **Setup asks where it asks.** The "Set up the AI-DLC workflow for this folder?" prompt
  carries **v1** and **v2** as its own buttons, and for v2 a second prompt in the same
  place asks **Kiro IDE** or **Kiro CLI**. It used to be a "Choose a version" step that
  opened a list elsewhere on screen and came back; and for a day it was three buttons in a
  row, where the generation was not told apart from the harness. A project that already
  recorded a harness is not asked again.
- **Setup ends on what to do next.** When setup finishes, a page opens in the editor with
  the one thing to type, large: `/aidlc` on v2, `"Using AI-DLC, build …"` on v1, and a
  button that opens Kiro's chat with it already typed. The completion toast used to
  lead with which files were written and say this in a trailing sentence that was gone in
  seconds. Until the first stage is reached, the row at the top of the tree and the strip
  above an open file read **Not started** with the same command beside it, instead of v1's
  stage list on a v2 project.
- **One row says where the workflow is.** The tree used to open with two: one parsed
  from `aidlc-state.md`, one from the artifact tree. Upstream changed the state file's
  checklist wording, and the parsed row read **Operations** on a project in Inception
  while the row below it was right. The parsed row is gone; what the state file says is
  in the remaining row's tooltip as a second opinion, and the parser reads the current
  wording as well as the old.
- Fixes: the setup list no longer claims v2 needs bun (the engine has not needed it since
  2.8.0), and **Check setup** no longer fails on a machine where bun is absent.

## 0.0.25

- **v2 setup works again, and now installs the engine.** AI-DLC v2 changed shape: its
  engine used to be files copied into your project and is now a program installed on
  your machine, which the project's hooks call by name. Copying files alone would have
  produced a project that looked complete and never advanced. Setup downloads the engine
  from the official release, checks every file against the release's published
  checksums, and lets the engine set your project up itself — one button still does the
  whole thing. The same setup runs on macOS, Windows and Linux.
- **bun is no longer required.** The engine reports that itself now. Setup used to stop
  without bun, which would have blocked people over something v2 does not use.
- **Your files are the engine's to keep, not ours to guess at.** Setting up over a
  project the workflow has already grown goes through the engine's own configuration,
  which reports what it left alone. Verified against a real project: accumulated rules,
  generated artifacts and hand-written steering all survive, and so do v1's rules where
  the two generations share a folder.
- **Removal works on projects the engine installed**, by reading the engine's own record
  of what it wrote rather than requiring one of ours.
- **v2 is recognised in more projects.** Detection knew only the older name for the
  agent file, so a project carrying only the newer one could be missed. Both count now,
  and **Check setup** no longer reports a correctly installed project as missing a file.
- **The number on the activity-bar icon matches the tree again.** Files the engine keeps
  for itself were being counted as new artifacts you had to read, so the badge said more
  than the folder showed and nothing you could open would clear it.

## 0.0.23

- **v2 setup works again.** Upstream renamed its `v2` branch to `main`, and every v2
  install failed with a message about a missing commit, which was not what had
  happened. The extension follows the default branch now, and a 404 says whether a
  branch or a commit is missing.
- **Kiro CLI setup works again.** Upstream also renamed that harness's directory, and
  the old path extracted nothing, which read as a broken download rather than a wrong
  path.
- Verified against the current engine end to end: install, reinstall over a project
  the workflow has grown, and removal. Your accumulated rules and the workflow's own
  files are still left alone.

## 0.0.21

- **The panel tells you when a stage is waiting on your approval.** In v2 a stage at its
  gate is stopped, not slow, and the chat says so once and scrolls away. It says whether
  the engine recorded the wait itself or the extension concluded it from the stage's own
  state, so the two are not presented as equally certain.
- **v2 installs from the current head of the upstream branch**, and records the commit it
  resolved to, so a project can always say which engine it has.
- **Three states instead of one word.** A stage your scope never included reads *not in
  scope*, a conditional stage that may decline to run reads *if needed*, and one simply
  awaiting its turn reads *not started*. All three used to read *skipped*, which claimed
  the run had passed stages it had not reached.
- **Setup no longer asks twice.** Choosing a generation and a harness were the decisions;
  the confirmation after them was a dialog with one button. It now reports what it
  installed instead.
- **The generation picker describes what each generation is**, rather than where its files
  come from.
- Fixes: changes to v2's own data now refresh the view, the progress notification no
  longer lingers after setup finishes, and the journey strip appears on v2 projects.

## 0.0.20

**AI-DLC v2 support.** The extension detects which generation your project uses and shows the matching view. Nothing about v1 changes.

- **Supervision panel for v2** — which stage is waiting on you, what the engine's checks flagged, the units of work, and the agent's own record placed beside the engine's check of it. (Became the Waiting for you and v2 Engine Log rows in 0.0.26.)
- **The journey strip works on v2**, including per-unit progress and the marker for the file you have open. Same strip, nothing new to learn.
- **One setup button that asks which generation**, with v1 listed first.
- **v2 setup tells you it needs bun** instead of producing a project whose gates silently never fire.
- **Removal takes back only what was installed**, never the workflow's own files, and preserves v1's rules where the two generations share a directory.
- **Guide updated** for both generations, in English and Korean.

## 0.0.19

- **A journey strip in the viewer** — the furthest stage reached and a rail with one segment per stage, across the top of the editor and preview, so your position stays visible while you read.
- **The progress percentage is gone.** It could not be computed honestly and reported 0% on real projects full of artifacts. Reached-stage counts replaced it.
- **Skipped stages are shown as skipped** rather than as gaps, which is normal on greenfield projects and whenever the workflow decides a design stage adds nothing.
- **Progress comes from the artifact tree**, not from file contents, so a state file in an unexpected format can no longer put your position wrong.
- **Unrecognised artifacts are listed** rather than guessed into a stage.

## 0.0.18

- **Persona Proxy: position-bias mitigation** — persona recommendations were skewing toward the first option. A persona must now evaluate every option on its content and say why at least one it did not choose was rejected, and a recommendation must hold regardless of the order options were presented in.

## 0.0.17

- **Persona Proxy: Deliberation Points** — each recommendation now includes 2–4 points to weigh before deciding, independent of whether you follow it, and at least one must say when a different option would be the better choice.
- **Unambiguous combined recommendations** — a persona recommending a combination must say when each part applies.

## 0.0.16

- **Persona Proxy** — when your team is missing a professional role, an AI persona adds an advisory recommendation to question files in that role's domain. Every `[Answer]:` is still left for a human, so approval gates are never bypassed.
- **7 personas** selectable at opt-in: Product Owner, Software Architect, Backend, Frontend, DevOps, Security and QA Engineer. Each comments only on stages in its own domain.
- **Answers are logged** as persona-aligned or human-override, so recommendation quality can be reviewed later.

## 0.0.15

- **State-file-based progress** — when the workflow keeps its own state file, progress is read from it and the in-progress step is named.
- **Auto-expand new artifacts**, so freshly generated files are visible without digging.
- **Workspace auto-detect** — if the open workspace already contains AI-DLC artifacts, the extension offers to watch it.
- **Open in Text Editor** from the right-click menu, for a regular editor instead of this viewer.
- **Unread badge** on the activity bar icon.
- **Viewer guide** rewritten, in English and Korean, and it opens automatically the first time.
- **Webview hardening** — a content security policy, sanitised link and image URLs, and Mermaid restricted to its safe mode.

## 0.0.14

- **One-click AI-DLC rule setup** — install the workflow rules for your agent from the toolbar, skipping the manual download and copy steps.
- Rules are **bundled with the extension**, so no network access is needed.
- Generates the **real per-platform files** for Kiro, Claude Code, and your current editor's own convention.
- **Idempotent** — existing files are detected and never overwritten.
