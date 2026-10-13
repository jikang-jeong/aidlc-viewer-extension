# AIDLC-VIEWER

A companion tool for **[AI-DLC](https://github.com/awslabs/aidlc-workflows)**, the AWS AI-Driven Development Lifecycle workflow.

![AIDLC-VIEWER demo](https://github.com/jikang-jeong/aidlc-viewer-extension/raw/main/media/merged.gif)

AI-DLC has your agent work through a lifecycle, producing Markdown artifacts as it goes. This extension sits beside that run and answers the questions you would otherwise dig through folders or scroll back through chat to answer.

| | What you get |
| --- | --- |
| **One-click setup** | Press one button, pick v1 or v2 (and for v2, Kiro IDE or Kiro CLI) on the same prompt, and the project is set up. v2's engine is installed for you from the official release. Nothing you already have is overwritten. When it is done, a page opens with the one thing to type to start. |
| **Where the workflow is** | The furthest stage reached, at the top of the tree and in a strip above every open file. Not a percentage: AI-DLC decides its own stage list as it goes, so reached stages are counted and the list is shown. |
| **Which file needs you** | New artifacts are marked and their folders open themselves, so what the agent just wrote is in front of you. |
| **The artifact, rendered** | Markdown with Mermaid diagrams inline. Double-click to edit at that spot; Save returns you to the view. What you type is exactly what is saved. |
| **Usage** | What Kiro spent on this project, in the credits Kiro itself recorded: total, the share that bought nothing, by stage, by session, and every turn. No estimates, no money. |
| **Waiting for you** (v2) | A row with its count: the questions the engine wrote and you have not answered, the refusals only you can clear, the plans parked for your approval. A stage waiting on you is stopped, not slow. |
| **v2 Engine Log** (v2) | The engine's own account of the run, as written. |

Works in **Kiro** and in VS Code and its forks. v2 setup targets Kiro IDE or Kiro CLI, the two it has verified against a real run; upstream also ships definitions for other agents, which you can install yourself. v1 works with Kiro, Claude Code and your editor's own convention.

## Getting started

1. Install the extension and click the **AIDLC** icon in the activity bar.
2. **Choose the project folder** to watch. Everything below acts on that folder, so this comes first.
3. Press **Set up AI-DLC Rules** and pick a generation. AI-DLC comes in two: v1 is rule files your agent reads, v2 is an engine that drives the workflow itself. If your project already has AI-DLC, the extension detects which one and you can skip this step.
4. Start the workflow. **On v1**, tell your agent *"Using AI-DLC, build ..."*. **On v2**, type `/aidlc` — it installs a conductor agent plus a set of role agents, so `/aidlc` starts or resumes a workflow and `/aidlc-mvp` and the rest are there when you want a specific one.

New artifacts appear in the tree as they are created.

Two things to know about v2 before you start. Its engine is a program installed on your machine, so the first v2 setup downloads about 110MB and takes a minute; every project after that is seconds. And Kiro reads `/aidlc` from the **workspace root**, so if you set up a folder that is not the root of your window, open that folder and `/aidlc` will be there. **AI-DLC v2: Check setup** in the Command Palette tells you which of these is missing.

Setup does not overwrite anything. Existing files are detected and left alone.

## What it shows you

### Where the workflow is

The top of the tree names the furthest stage reached and how many stages are done. Opening any artifact adds a strip across the top of the viewer, so your position stays visible while you read. Click it to see the whole stage list grouped by phase.

**There is no percentage, on purpose.** AI-DLC adapts to the work: most stages are conditional, and Construction repeats once per unit of work with a unit count that does not exist until units have been generated. Any denominator would be guesswork, so reached stages are counted instead, and stages that repeat show their own progress like `2/3`.

A stage the workflow moved past without producing anything is shown as skipped rather than left blank, and one your scope never included says so. Both are normal.
### Which file needs you

New artifacts are marked `NEW` until you open them, then `READ`, with counts rolled up to their folders. Folders containing new files open themselves, so you are not hunting for what just appeared. Changes are picked up whether they came from your agent, from git, or from anything else.

### The artifact itself

Each `.md` file opens rendered, with Mermaid diagrams drawn inline. Press **Edit**, or double-click the text you want to change, to swap the same pane for the Markdown source with the cursor near that spot; **Save** returns you to the view. The view never rewrites your Markdown from the rendering, so what you type is exactly what is saved. Zoom works in both modes. HTML comments, which AI-DLC uses to instruct the agent, are shown dimmed rather than dropped.

### What Kiro spent

The **Usage** row at the top of the tree opens a page. Every number on it is one Kiro recorded; nothing is estimated and no amount in money is shown, because the price of a credit depends on your plan.

- **Total credits on this project**, and beside it the credits spent on turns Kiro marked **aborted or failed**: work that was paid for and produced nothing. That second number is the one to act on.
- **By stage**, each with a bar relative to the costliest stage, and by session with the aborted share marked on the bar. A turn is placed in a stage when its time falls inside that stage's window, from the engine's audit ledger on v2 and from the artifacts' modification times on v1. A turn outside every window is shown as such, so the total always adds up.
- **By session**: credits, turns, time, how full the context window was after the last turn, and token counts where Kiro recorded them. Each session names the store it was read from; Kiro IDE and current `kiro-cli` write to the same one, so the page does not guess which program it was. The page re-reads every few seconds while it is open.
- **History**: every prompt turn, newest first, with its credits, status, stage and session, so any figure in the tables above can be traced to the turns that made it.

### What is waiting on you, and what the engine recorded (v2)

**Waiting for you** carries its count in the tree, so you know without opening anything; the page lists each item with the engine's own words: questions it wrote for you and has not had answered (the file and how many), refusals with the remedies it marked as yours, and plans parked for your approval, each labelled as the engine's word or this extension's inference from the ledger. A stage waiting on you is not slow, it is stopped, and the chat said so once and scrolled away. **v2 Engine Log** is the engine's own account: refusals, what its checks flagged, and the agent's claim beside the engine's check of it.

v1 has neither row, because it has no engine to wait on or to record.

## Toolbar

| Button | What it does |
| --- | --- |
| 📂 Open Workspace | Choose the project folder to watch |
| 🔄 Refresh | Re-scan the folder |
| ☁️ Set up AI-DLC Rules | Asks which generation (and harness, for v2), then sets it up |
| ❓ Guide | Open the built-in guide, in English and Korean |

Two more commands are in the Command Palette for v2 projects. **AI-DLC v2: Check setup** reports what is present and what is missing when `/aidlc` does not appear. **AI-DLC v2: Remove** takes back only what the extension installed, and refuses if it has no record of installing anything.

## Notes

**AI-DLC v2's engine is installed on your machine, and this extension installs it for you.** It runs the installer AWS publishes with each release, which verifies what it downloads and puts everything under your home directory, so no administrator rights are needed. If that cannot run where you are, setup hands you the same command to run yourself rather than leaving you a project whose gates never fire. v1 needs nothing and works offline.

**v1 is installed from a snapshot inside the extension. v2 comes from the latest published release** of [awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows), and the version you have is recorded in the project so you can always tell which engine it is.

**Nothing is read out of your Markdown.** Progress comes from the project's structure, so an artifact in an unexpected format cannot put your position wrong, and anything the extension does not recognise is reported rather than guessed at.
## What's New

### 0.0.26

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
- **On v2, the page leads with what is waiting on you**, read from what the engine itself
  wrote down: each refusal with its code and the remedies the engine marked as yours, and
  each code-generation plan parked for your approval. Where the engine said nothing and
  the wait is inferred from the ledger, the page says so.
- **One sidebar for both generations, with two v2 rows.** The v2-only Supervision panel
  under the tree is gone. **Waiting for you** is a row with its count beside it and a page
  that reads what the engine wrote: unanswered questions files, refusals that need you,
  parked plans. **v2 Engine Log** is a row and a page with the engine's own account of
  the run. Both appear only on v2.
- **Setup asks once, where it asks.** The "Set up the AI-DLC workflow for this folder?"
  prompt now carries **v1**, **v2 · Kiro IDE** and **v2 · Kiro CLI** as its own buttons
  instead of a "Choose a version" step that opened a list elsewhere and came back, and a
  second list for the harness after that. A project that already recorded a harness keeps it.
- **Setup ends on what to do next.** When setup finishes, a page opens in the editor with
  the one thing to type, large: `/aidlc` on v2, `"Using AI-DLC, build …"` on v1, and, on v2,
  a button that opens Kiro's chat with `/aidlc` already typed. The completion toast used to
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

### 0.0.25

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

### 0.0.23

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

### 0.0.21

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

### 0.0.20

**AI-DLC v2 support.** The extension detects which generation your project uses and shows the matching view. Nothing about v1 changes.

- **Supervision panel for v2** — which stage is waiting on you, what the engine's checks flagged, the units of work, and the agent's own record placed beside the engine's check of it. (Became the Waiting for you and v2 Engine Log rows in 0.0.26.)
- **The journey strip works on v2**, including per-unit progress and the marker for the file you have open. Same strip, nothing new to learn.
- **One setup button that asks which generation**, with v1 listed first.
- **v2 setup tells you it needs bun** instead of producing a project whose gates silently never fire.
- **Removal takes back only what was installed**, never the workflow's own files, and preserves v1's rules where the two generations share a directory.
- **Guide updated** for both generations, in English and Korean.

### 0.0.19

- **A journey strip in the viewer** — the furthest stage reached and a rail with one segment per stage, across the top of the editor and preview, so your position stays visible while you read.
- **The progress percentage is gone.** It could not be computed honestly and reported 0% on real projects full of artifacts. Reached-stage counts replaced it.
- **Skipped stages are shown as skipped** rather than as gaps, which is normal on greenfield projects and whenever the workflow decides a design stage adds nothing.
- **Progress comes from the artifact tree**, not from file contents, so a state file in an unexpected format can no longer put your position wrong.
- **Unrecognised artifacts are listed** rather than guessed into a stage.

### 0.0.18

- **Persona Proxy: position-bias mitigation** — persona recommendations were skewing toward the first option. A persona must now evaluate every option on its content and say why at least one it did not choose was rejected, and a recommendation must hold regardless of the order options were presented in.

### 0.0.17

- **Persona Proxy: Deliberation Points** — each recommendation now includes 2–4 points to weigh before deciding, independent of whether you follow it, and at least one must say when a different option would be the better choice.
- **Unambiguous combined recommendations** — a persona recommending a combination must say when each part applies.

### 0.0.16

- **Persona Proxy** — when your team is missing a professional role, an AI persona adds an advisory recommendation to question files in that role's domain. Every `[Answer]:` is still left for a human, so approval gates are never bypassed.
- **7 personas** selectable at opt-in: Product Owner, Software Architect, Backend, Frontend, DevOps, Security and QA Engineer. Each comments only on stages in its own domain.
- **Answers are logged** as persona-aligned or human-override, so recommendation quality can be reviewed later.

### 0.0.15

- **State-file-based progress** — when the workflow keeps its own state file, progress is read from it and the in-progress step is named.
- **Auto-expand new artifacts**, so freshly generated files are visible without digging.
- **Workspace auto-detect** — if the open workspace already contains AI-DLC artifacts, the extension offers to watch it.
- **Open in Text Editor** from the right-click menu, for a regular editor instead of this viewer.
- **Unread badge** on the activity bar icon.
- **Viewer guide** rewritten, in English and Korean, and it opens automatically the first time.
- **Webview hardening** — a content security policy, sanitised link and image URLs, and Mermaid restricted to its safe mode.

### 0.0.14

- **One-click AI-DLC rule setup** — install the workflow rules for your agent from the toolbar, skipping the manual download and copy steps.
- Rules are **bundled with the extension**, so no network access is needed.
- Generates the **real per-platform files** for Kiro, Claude Code, and your current editor's own convention.
- **Idempotent** — existing files are detected and never overwritten.
