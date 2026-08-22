# AIDLC-VIEWER

![AIDLC-VIEWER demo](https://github.com/jikang-jeong/aidlc-viewer-extension/raw/main/media/merged.gif)

## What's New

### 0.0.20

**AI-DLC v2 support.** v2 replaces rule files your agent reads with an engine that drives the workflow itself — enforced gates, an audit ledger, and stages compiled from the project rather than described in prose. The viewer detects which generation a project uses and shows the matching view. **Nothing about v1 changes:** its journey module is byte-identical to 0.0.19, and v1 labels, tooltips, icons and counts were checked against the 0.0.19 build for equality rather than for looking right.

- **Supervision panel (v2 only)** — in v2 the agent reads the artifacts and you approve a summary. A summary is useful because it leaves things out, so this panel surfaces what it left out: where the run was refused and the events either side of it, what the engine's own sensors flagged grouped per sensor, the units of work and their dependency chain, and the agent's self-report placed next to the engine's check of it. The two are never reconciled — a disagreement is the thing worth seeing.
- **The journey strip works on v2**, including unit progress like `2/3` on stages that repeat per unit of work, and the position marker for the file you have open. Same strip, same shape, no v2-specific UI to learn.
- **One setup button that asks which generation.** Two buttons were tried and immediately produced the wrong install, because pressing *Set up AI-DLC* had always meant v1 and nothing on screen said the other icon was for v2. v1 is listed first — most people are on it, and the first row is what Enter picks.
- **v2 needs bun, and setup says so instead of working around it.** The engine is invoked as `bun <file>` throughout, so installing without it produces a project whose gates never fire and which reports no error. Setup stops and hands over the platform's official install command — plus what it needs (`unzip` on Linux, Windows 10 1809), and a second route (npm, brew, scoop) for a machine or a policy the one-liner cannot get past. It never runs the command itself.
- **The upstream commit is pinned in source**, so an install matches what this build was verified against rather than tracking a moving branch.
- **Removal takes back only what the installer wrote.** It refuses without an install receipt, never touches the workflow's own `aidlc/` content — which the workflow grows from 9 seed files to 140-odd, including one the workflow overwrites with learned rules — and preserves v1's rules where the two generations share `.kiro/`.
- **Nothing is parsed out of Markdown, and nothing is enumerated.** Stage slugs, phase names, sensor ids, scope names, outcome values and event names are all read from the project, so a v2 build this extension has never seen still reads correctly, and anything unrecognised is reported rather than guessed at. Adversarial-input tests assert that no input throws.
- **Viewer guide updated** for both generations, in English and Korean.
- **213 tests** on `node:test` with no added dependencies.

### 0.0.19

- **AI-DLC journey strip in the viewer** — opening a `.md` artifact now shows a strip across the top of the editor/preview split: the furthest stage reached, a continuous rail with one segment per stage, and how many stages are done. Click it to expand into the full stage list grouped by phase. The position stays visible while you read instead of having to go look for it.
- **The progress percentage is gone.** It could not be computed honestly. AI-DLC is adaptive, so most stages are conditional, and Construction repeats per unit of work with a unit count that does not exist until Units Generation has run. The old weighted figure reported **0% on real projects full of artifacts**; reached-stage counts replaced it in both the tree and the strip.
- **Progress is derived from the artifact tree, not from file contents.** Which folders exist under `aidlc-docs/`, plus the plan files under `plans/`. Nothing is parsed out of markdown, so a state file in an unexpected format can no longer make the position wrong. Status comes from three kinds of evidence, because absence of a stage's own artifact is not absence of the stage: its artifacts exist, its mandated plan file exists, or a later stage has already produced artifacts.
- **Skipped stages are shown as skipped**, hatched rather than blank, instead of looking like a gap. A stage the workflow moved past without producing anything was skipped, not left pending — normal on greenfield projects and whenever the workflow decides a design stage adds nothing.
- **Operations is treated as the v1 placeholder it is.** The rules state the workflow ends after Build and Test in Construction, so an unreached Operations stage is excluded from the count and a project that finished Build and Test now reads as complete.
- **Unrecognised artifacts are reported, not guessed at.** An artifact that matches no known stage layout is listed at the bottom of the expanded strip.
- **Purple is the progress colour**, matching the existing Construction badge. Green was avoided on purpose: it already marks unread `NEW` artifacts.
- **Viewer guide rewritten** for the journey strip, in English and Korean.
- **Test harness and CI** — 58 tests on `node:test` with no added dependencies, plus a GitHub Actions workflow that runs them on Node 20 and 22, builds the vsix, and fails if a runtime asset (`media/mermaid.min.js`, the bundled rules, the Persona Proxy extension) went missing from the package.

### 0.0.18

- **Persona Proxy: position-bias mitigation** — persona recommendations were skewing toward option A (LLM position bias). Two rules added: (1) the persona must evaluate every option on its content before choosing, and the rationale must state why at least one non-chosen option was rejected — praising only the chosen option is a violation; (2) recommendations must be position-independent — option order carries no meaning, and a recommendation must hold if the options were presented in any other order.

### 0.0.17

- **Persona Proxy: Deliberation Points** — each persona recommendation block now includes 2–4 points the mob should weigh before deciding (trade-offs, hard-to-reverse consequences, facts to verify first), independent of whether they follow the recommendation. At least one point must state when a *different* option would be the better choice, so the block supports the team's own judgment instead of selling the recommendation.
- **Persona Proxy: unambiguous combined recommendations** — when a persona recommends a combination of options (e.g., "A primary, C secondary"), the rationale must state when each option applies, so adopting it verbatim doesn't trigger the core workflow's ambiguity follow-up questions.

### 0.0.16

- **Persona Proxy extension (bundled rules)** — new AI-DLC rule extension at `aws-aidlc-rule-details/extensions/collaboration/persona-proxy/`. When your team (mob) is missing a professional role, an AI persona adds an advisory recommendation block (suggested option + rationale + confidence) to question files in that role's domain, while every `[Answer]:` tag is still left for the human to fill — human approval gates are never bypassed.
- **7 personas selectable at opt-in** — Product Owner, Software Architect, Backend Engineer, Frontend Engineer, DevOps Engineer, Security Engineer, QA Engineer. The opt-in question (asked during Requirements Analysis, multi-select) describes what each persona represents; selections are recorded in `aidlc-state.md`.
- **Stage activation matrix** — each persona only comments on workflow stages in its domain (e.g., User Stories is owned by Product Owner; Infrastructure Design by DevOps/Security), with primary/secondary participation levels.
- **Extension cross-check** — if the Security Baseline or Resiliency Baseline extension is enabled while the matching persona is inactive, the workflow suggests activating it.
- **Audit trail for proxy quality** — human answers are logged as `persona-aligned` or `human-override` in `audit.md`, so proxy recommendation quality can be reviewed retrospectively.

### 0.0.15

- **Accurate stage progress** — Inception/Construction/Operations percentages are now counted from `.md` artifacts under the `aidlc-docs/` folder inside the watched root (`aidlc-docs/inception/`, `aidlc-docs/construction/`, `aidlc-docs/operations/`), instead of any path that merely contains a stage word. Selecting the `aidlc-docs` folder directly still works.
- **State-file-based progress** — when `aidlc-docs/aidlc-state.md` exists, progress is read from its `## Stage Progress` checklist (the workflow's own record): completed steps count against the number of bundled rule files per stage, and the current **in-progress step name** is shown next to the stage row. Falls back to the artifact-count estimate when no state file is present (tooltip indicates which source is used).
- **Auto-expand new artifacts** — folders containing unread `NEW` files (including newly created folders) start expanded in the tree, so freshly generated artifacts are visible without manual digging.
- **Viewer guide rewritten** — the help panel is now the "AI-DLC Viewer Guide": an English walkthrough of the viewer's features (progress tracking, live tree, split editor/preview, toolbar) with a Korean version below. It also **opens automatically** the first time you enter the viewer with no folder being watched.
- **Workspace auto-detect** — if the open workspace already contains an `aidlc-docs/` folder, the extension offers to watch it (asked once per workspace).
- **Open in Text Editor** — right-click a file in the tree to open it in a regular VS Code editor instead of the split viewer.
- **Unread badge** — the activity-bar icon shows how many `NEW` artifacts are waiting to be read.
- **Less refresh churn** — file-watcher events from ignored directories (`.git`, `node_modules`, build output, …) no longer trigger tree refreshes.
- **Webview hardening** — added a Content-Security-Policy to the Markdown viewer, sanitized link/image URLs (blocks `javascript:` / `data:` schemes), tightened HTML attribute escaping, and switched Mermaid to `antiscript` security level.
- **Cleanup on deactivate** — watchers and polling timers are now disposed when the extension is deactivated.

### 0.0.14

- **One-click AI-DLC rule setup** — click the **Set up AI-DLC Rules** button in the view toolbar and the extension installs the AI-DLC rule files into your project, so beginners can skip the manual download/copy steps from the [aidlc-workflows](https://github.com/awslabs/aidlc-workflows) README.
- Rules are **bundled with the extension** (snapshot of the `awslabs/aidlc-workflows` v1.0.0 release) and copied locally — no network access or AI agent required.
- Generates the **real per-platform files** (not pointers) following each tool's convention:
  - **Kiro** (always): `.kiro/steering/aws-aidlc-rules/` + `.kiro/aws-aidlc-rule-details/`
  - **Claude Code** (always): `CLAUDE.md` + `.aidlc-rule-details/`
  - **Cursor** (when host is Cursor): `.cursor/rules/ai-dlc-workflow.mdc` (with frontmatter) + `.aidlc-rule-details/`
  - **GitHub Copilot** (when host is VS Code): `.github/copilot-instructions.md` + `.aidlc-rule-details/`
- The extra target is chosen automatically from the host IDE (`vscode.env.appName`); Kiro and Claude Code are always set up.
- **Two ways to trigger** — press the **Set up AI-DLC Rules** toolbar button anytime, or just pick a folder via **Watch this folder** and confirm the "Set up the AI-DLC workflow for this folder?" prompt. Setup never runs while you are still browsing folders, nor on window reload.
- **Idempotent & safe** — existing files/folders are detected and skipped, never overwritten.
- New ghost-themed extension icon.

## Key Features

AI-DLC generates Markdown artifacts as an agent works through the lifecycle. This extension is purpose-built to track and consume them, in **both generations**: v1's rule files with artifacts under `aidlc-docs/`, and v2's engine-driven workflow with its own compiled stage graph, gates and audit ledger. The generation is detected from the project; there is no setting to get wrong.

- **Stage-aware artifact tracking** — only detects files produced by the AI-DLC workflow, ignoring unrelated files and directories. In v1 that is the `inception/`, `construction/` and `operations/` layout; in v2 the layout is read from the engine rather than assumed.
- **Furthest stage reached, and how many are done** — shown at the top of the tree and in the journey strip across the viewer, with one segment per stage and skipped stages hatched rather than blank. There is deliberately **no percentage**: most stages are conditional and Construction repeats per unit of work, so a denominator would be guesswork. Stages that repeat per unit show their unit progress instead, like `2/3`.
- **Supervision panel (v2)** — surfaces what the summary you approve left out: refusals with the events either side, the engine's own sensor findings grouped per sensor, the units of work and their dependency chain, and the agent's self-report next to the engine's check of it, never reconciled.
- **One setup button that asks which generation** — v1 from a snapshot bundled with the extension (no network), or v2 from upstream at a commit pinned in source. v2 needs bun, and setup says so and stops rather than producing a project whose gates never fire.
- **Readable Markdown viewer** — opens each `.md` artifact in a split editor with a syntax-colored, prettier-styled preview (color-coded headings, tables, task lists, code blocks) for high readability. Mermaid diagrams render inline.
- **In-place editing** — edit and save changes back to the original `.md` file directly from the viewer, with a resizable splitter, synced scrolling and zoom controls.
- **Live change detection** — automatically picks up new files and folders created by your agent (or any external process) via file watchers and focus-based refresh, marking them `NEW` until read.
- **Nothing is parsed out of Markdown** — progress comes from structure, so an artifact or state file in an unexpected format cannot make the position wrong, and anything unrecognised is reported rather than guessed at.
- **Built-in viewer guide** — a help panel covering both generations, in English and Korean, accessible from the view toolbar.

## How it works

Minimal VS Code extension prototype for AI-DLC workflow folders:

1. Select a folder to watch.
2. Show live file and directory changes in a tree view.
3. Click a Markdown file to open an editable split viewer.
4. Save changes back to the original `.md` file.

## Run locally

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the new window, open the `AIDLC` activity bar icon.
4. Run `AIDLC-VIEWER: Open Workspace`.
5. Choose the AI-DLC project folder your agent is writing into (the one containing `aidlc-docs/`).

## Current scope

- Watches one selected root folder.
- Refreshes tree items when files or directories change.
- Opens `.md` files in a custom webview with editor + preview.
- Saves edits directly to disk.
- Shows the first Markdown heading in the tree as a quick description.
- Hides folders that do not contain any Markdown files.
- Adds section-friendly directory labels for rule repositories.
- Marks newly created Markdown files with a green `NEW` indicator.
- Marks opened Markdown files as `READ` and rolls counts up to parent folders.
- Shows a compact stage summary at the top of the tree with the current stage and stage counts.

## Good fit for rule repositories

This works well for AI-DLC repositories and assets such as:

- [awslabs/aidlc-workflows assets/images](https://github.com/awslabs/aidlc-workflows/tree/main/assets/images)
- `../aidlc-workflows/aidlc-rules`

That repository has a nested rules structure such as:

- `aws-aidlc-rules/core-workflow.md`
- `aws-aidlc-rule-details/common/*.md`
- `aws-aidlc-rule-details/inception/*.md`
- `aws-aidlc-rule-details/construction/*.md`
- `aws-aidlc-rule-details/operations/*.md`
- `aws-aidlc-rule-details/extensions/**/*.md`

The extension will show that structure as a live tree and display each Markdown file with an editable preview panel.
Directories such as `common`, `inception`, `construction`, `operations`, and `extensions` also get clearer icons and summaries in the tree.

## Suggested test flow

1. Start the extension with `F5`.
2. Select an AI-DLC project folder (or any folder with `aidlc-docs/inception|construction|operations` subfolders containing `.md` files).
3. Confirm the top row shows the current stage.
4. Open `inception/requirements-analysis.md` and confirm it becomes `READ`.
5. Create a new file such as `construction/new-task.md` and confirm it appears as green `NEW`.
6. Open that new file and confirm `NEW` changes to `READ`.
7. Edit `operations/review-checklist.md`, save it, and confirm the stage row moves to `Operations`.
8. Edit `construction/functional-design.md`, save it, and confirm the stage row moves back to `Construction`.
 