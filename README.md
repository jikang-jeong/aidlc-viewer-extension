# AIDLC-VIEWER

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
6. For a ready-made test fixture, choose `/Users/jikjeong/Develop/aidlc-test/sample-workflow`.

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
- Shows a compact stage summary at the top of the tree with `Current Stage` and `Last review`.

## Good fit for rule repositories

This works well for repositories like:

- `/Users/jikjeong/Develop/aidlc-workflows/aidlc-rules`

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
2. Select `/Users/jikjeong/Develop/aidlc-test/sample-workflow`.
3. Confirm the top row shows the current stage and latest stage file.
4. Open `inception/requirements-analysis.md` and confirm it becomes `READ`.
5. Create a new file such as `construction/new-task.md` and confirm it appears as green `NEW`.
6. Open that new file and confirm `NEW` changes to `READ`.
7. Edit `operations/review-checklist.md`, save it, and confirm the stage row moves to `Operations`.
8. Edit `construction/functional-design.md`, save it, and confirm the stage row moves back to `Construction`.

## Packaging and install

To package the extension for distribution:

1. Install VS Code packaging tooling: `npm install -g @vscode/vsce`
2. From this folder, run: `vsce package`
3. This produces a `.vsix` file in the project root.
4. In VS Code, install it with `Extensions: Install from VSIX...`

For customer distribution:

- Send the `.vsix` file directly, or
- Publish to the Visual Studio Marketplace if you want in-editor discovery and updates

## Marketplace publish

Before publishing, update the extension metadata in [package.json](/Users/jikjeong/Documents/Codex/2026-04-18-youtube-mp3/package.json):

- Set a real `publisher`
- Add `repository`
- Add `homepage`
- Add `bugs`
- Add a square extension `icon`
- Review `description`, `displayName`, `version`, and keywords

Recommended publish flow:

1. Create a publisher in the Visual Studio Marketplace publisher portal
2. Create a Personal Access Token with Marketplace publish rights
3. Log in once from your machine: `vsce login <publisher-name>`
4. Package locally to verify: `vsce package`
5. Publish the first release: `vsce publish`
6. Publish later updates with semver bumps such as `vsce publish patch`

Practical notes:

- The `publisher` field in `package.json` must exactly match your Marketplace publisher name
- The extension name becomes the Marketplace identifier, so `aidlc-viewer` is what users will install
- A good README and icon matter because they are shown directly in the Marketplace listing
- If you want private/internal distribution only, `.vsix` delivery is usually simpler than Marketplace publishing

## Release checklist

- Confirm the Marketplace publisher really is `jikang-jeong`
- Verify the listing icon in [media/marketplace-icon.png](/Users/jikjeong/Documents/Codex/2026-04-18-youtube-mp3/media/marketplace-icon.png)
- Run `vsce package` and confirm there are no packaging warnings
- Install the generated `.vsix` locally once before publishing
- Publish with `vsce publish` when the package looks correct

## Next useful additions

- Auto-run a follow-up Claude CLI command after save.
- Show status badges for `waiting`, `editing`, `ready`, `done`.
- Filter tree to Markdown-only mode.
- Prompt before overwriting externally changed content.
