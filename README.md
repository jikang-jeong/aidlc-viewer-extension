# AIDLC-VIEWER

A companion tool for **[AI-DLC](https://github.com/awslabs/aidlc-workflows)**, the AWS AI-Driven Development Lifecycle workflow.

![AIDLC-VIEWER demo](https://github.com/jikang-jeong/aidlc-viewer-extension/raw/main/media/merged.gif)

AI-DLC has your agent work through a lifecycle, producing Markdown artifacts as it goes. This extension does two things for you while that happens.

**It sets AI-DLC up in one click.** Starting AI-DLC otherwise means cloning a repository and copying rule files into the right place for your editor. Press one button, answer which generation you want, and it is set up.

**It shows you where the workflow actually is.** The furthest stage reached, which file needs you next, and each artifact opened in a readable split view, so you are not digging through folders to find out what your agent has been doing.

Works in **Kiro** and in VS Code and its forks. AI-DLC v2's engine ships agent definitions for Kiro only, so v2 setup targets Kiro IDE or Kiro CLI; v1 works with Kiro, Claude Code and your editor's own convention.

## Getting started

1. Install the extension and click the **AIDLC** icon in the activity bar.
2. **Choose the project folder** to watch. Everything below acts on that folder, so this comes first.
3. Press **Set up AI-DLC Rules** and pick a generation. AI-DLC comes in two: v1 is rule files your agent reads, v2 is an engine that drives the workflow itself. If your project already has AI-DLC, the extension detects which one and you can skip this step.
4. Start the workflow. **On v1**, tell your agent *"Using AI-DLC, build ..."*. **On v2**, type `/aidlc` — it installs a conductor agent plus a set of role agents, so `/aidlc` starts or resumes a workflow and `/aidlc-mvp` and the rest are there when you want a specific one.

New artifacts appear in the tree as they are created.

Two things to know about v2 before you start. It needs [bun](https://bun.com/docs/installation), and setup will stop and hand you the install command rather than leave you a project whose gates never fire. And Kiro reads `/aidlc` from the **workspace root**, so if you installed into a folder that is not the root of your window, open that folder and `/aidlc` will be there. **AI-DLC v2: Check setup** in the Command Palette tells you which of these is missing.

Setup does not overwrite anything. Existing files are detected and left alone.

## What it shows you

### Where the workflow is

The top of the tree names the furthest stage reached and how many stages are done. Opening any artifact adds a strip across the top of the viewer, so your position stays visible while you read. Click it to see the whole stage list grouped by phase.

**There is no percentage, on purpose.** AI-DLC adapts to the work: most stages are conditional, and Construction repeats once per unit of work with a unit count that does not exist until units have been generated. Any denominator would be guesswork, so reached stages are counted instead, and stages that repeat show their own progress like `2/3`.

A stage the workflow moved past without producing anything is shown as skipped rather than left blank, and one your scope never included says so. Both are normal.
### Which file needs you

New artifacts are marked `NEW` until you open them, then `READ`, with counts rolled up to their folders. Folders containing new files open themselves, so you are not hunting for what just appeared. Changes are picked up whether they came from your agent, from git, or from anything else.

### The artifact itself

Each `.md` file opens with the source on the left and a styled preview on the right. Mermaid diagrams render inline. You can edit and save back to the file, resize or reset the split, sync the scrolling, and zoom the preview.

### Supervision, on AI-DLC v2

In v2 your agent reads the artifacts and you approve a summary, and the workflow continues whether or not you read anything yourself. A summary is useful precisely because it leaves things out, so this panel shows you what it left out:

- **which stage is waiting on you**, because a stage at its approval gate is not slow, it is stopped, and the chat said so once and scrolled away
- **what the engine's own checks flagged**, grouped per check, with a link to read each finding
- **the agent's record beside the engine's check of it**, per stage, never reconciled — the two answer slightly different questions, so the judgement stays yours
- **the units of work** and what depends on what

The panel appears only on v2 projects. Nothing about v1 changes.

## Toolbar

| Button | What it does |
| --- | --- |
| 📂 Open Workspace | Choose the project folder to watch |
| 🔄 Refresh | Re-scan the folder |
| ☁️ Set up AI-DLC Rules | Asks which generation, then sets it up |
| ❓ Guide | Open the built-in guide, in English and Korean |

Two more commands are in the Command Palette for v2 projects. **AI-DLC v2: Check setup** reports what is present and what is missing when `/aidlc` does not appear. **AI-DLC v2: Remove** takes back only what the extension installed, and refuses if it has no record of installing anything.

## Notes

**AI-DLC v2 needs [bun](https://bun.com/docs/installation).** Its engine runs through bun, so setup stops and hands you the install command rather than leaving you a project whose gates never fire. v1 needs nothing and works offline.

**v1 is installed from a snapshot inside the extension. v2 is downloaded** from the `v2` branch of [awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows), and the commit it resolved to is recorded in the project so you can always tell which engine you have.

**Nothing is read out of your Markdown.** Progress comes from the project's structure, so an artifact in an unexpected format cannot put your position wrong, and anything the extension does not recognise is reported rather than guessed at.
## What's New

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

- **Supervision panel for v2** — which stage is waiting on you, what the engine's checks flagged, the units of work, and the agent's own record placed beside the engine's check of it.
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
- **Open in Text Editor** from the right-click menu, for a regular editor instead of the split viewer.
- **Unread badge** on the activity bar icon.
- **Viewer guide** rewritten, in English and Korean, and it opens automatically the first time.
- **Webview hardening** — a content security policy, sanitised link and image URLs, and Mermaid restricted to its safe mode.

### 0.0.14

- **One-click AI-DLC rule setup** — install the workflow rules for your agent from the toolbar, skipping the manual download and copy steps.
- Rules are **bundled with the extension**, so no network access is needed.
- Generates the **real per-platform files** for Kiro, Claude Code, and your current editor's own convention.
- **Idempotent** — existing files are detected and never overwritten.
