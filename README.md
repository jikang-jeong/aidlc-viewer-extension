# AIDLC-VIEWER

![AIDLC-VIEWER demo](https://github.com/jikang-jeong/aidlc-viewer-extension/raw/main/media/merged.gif)

Minimal VS Code extension prototype for AI-DLC workflow folders:

1. Select a folder to watch.
2. Show live file and directory changes in a tree view.
3. Click a Markdown file to open an editable split viewer.
4. Save changes back to the original `.md` file.

## Run locally

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the new window, open the `AIDLC` activity bar icon.
4. Run `AIDLC-VIEWER: Select Folder`.
5. Choose the folder that Claude CLI is writing into.
6. For a ready-made test fixture, choose `../aidlc-test/sample-workflow`.

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
2. Select `../aidlc-test/sample-workflow`.
3. Confirm the top row shows the current stage.
4. Open `inception/requirements-analysis.md` and confirm it becomes `READ`.
5. Create a new file such as `construction/new-task.md` and confirm it appears as green `NEW`.
6. Open that new file and confirm `NEW` changes to `READ`.
7. Edit `operations/review-checklist.md`, save it, and confirm the stage row moves to `Operations`.
8. Edit `construction/functional-design.md`, save it, and confirm the stage row moves back to `Construction`.
 
