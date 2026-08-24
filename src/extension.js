const vscode = require('vscode');
const path = require('path');
const { buildJourney, checkpointIdForPath, CHECKPOINTS } = require('./aidlc/journey');
const { SupervisionViewProvider, VIEW_ID: SUPERVISION_VIEW_ID } = require('./supervision-view');
const { readProject } = require('./aidlc/index');
const { checkpointIndexForPath } = require('./aidlc/journey-v2');
const { detectGeneration } = require('./aidlc/detect');
const installCommands = require('./install-commands');

const STATE_KEY = 'markdownWatchViewer.watchedFolder';
const OPENED_KEY = 'markdownWatchViewer.openedFiles';
const KNOWN_KEY = 'markdownWatchViewer.knownFiles';
const NEW_KEY = 'markdownWatchViewer.newFiles';
// Tracks the last extension version we showed the "what's new" notice for.
const SETUP_NOTICE_KEY = 'markdownWatchViewer.aidlcSetupNoticeVersion';
// Set once we've offered to auto-watch a workspace containing aidlc-docs.
const AUTODETECT_ASKED_KEY = 'markdownWatchViewer.autoDetectAsked';

function activate(context) {
  const controller = new WatchController(context);

  const stageDecorationProvider = new StageDecorationProvider();

  const treeView = vscode.window.createTreeView('markdownWatchViewer.tree', {
    treeDataProvider: controller.treeDataProvider,
    showCollapseAll: true
  });
  controller.treeView = treeView;
  controller.updateBadge();

  // v2 supervision panel. It renders above the tree and only for a project that
  // has AI-DLC v2 installed: the view's `when` clause is driven by a context key
  // this provider sets, so a v1 project shows no new UI whatsoever.
  const supervision = new SupervisionViewProvider();
  controller.supervisionView = supervision;

  context.subscriptions.push(
    // Ensure watchers/timers are cleaned up when the extension is deactivated
    // (disposeWatcher was previously only called on folder re-selection).
    controller,
    treeView,
    vscode.window.registerWebviewViewProvider(SUPERVISION_VIEW_ID, supervision, {
      // The panel is cheap to rebuild from disk and holds no unsaved state, so
      // there is nothing to retain while it is hidden.
      webviewOptions: { retainContextWhenHidden: false }
    }),
    // Show the one-time "new setup feature" notice only when the user actually
    // opens the AI-DLC view, not on editor startup.
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        controller.maybeShowWelcomeGuide();
        controller.maybeShowSetupNotice();
      }
    }),
    vscode.window.registerFileDecorationProvider(stageDecorationProvider),
    vscode.commands.registerCommand('markdownWatchViewer.selectFolder', () => controller.selectFolder()),
    vscode.commands.registerCommand('markdownWatchViewer.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('markdownWatchViewer.openFile', (item) => controller.openFile(item)),
    vscode.commands.registerCommand('markdownWatchViewer.openInTextEditor', (item) => controller.openInTextEditor(item)),
    vscode.commands.registerCommand('markdownWatchViewer.showHelp', () => controller.showHelp()),
    // One setup button. It asks which generation, because it used to install v1
    // unconditionally and a second button for v2 beside it did not help: pressing
    // "Set up AI-DLC" still did what it had always done, and nothing said the
    // other icon was the v2 one. Every other entry point routes through the same
    // question, so no path can pick a generation the user was not asked about.
    vscode.commands.registerCommand('markdownWatchViewer.setupRules', () => controller.setupRules()),
    // Answers "I installed it and /aidlc is not there". Three separate causes are
    // indistinguishable from the chat, and each has a different fix.
    vscode.commands.registerCommand('markdownWatchViewer.checkV2', () =>
      installCommands.checkV2(controller.treeDataProvider.rootUri)
    ),
    vscode.commands.registerCommand('markdownWatchViewer.removeV2', async () => {
      await installCommands.removeV2(controller.treeDataProvider.rootUri);
      // The removal changed what is on disk, so the panel and tree must re-read
      // rather than keep showing an install that is gone.
      controller.refresh();
      controller.refreshSupervision();
    }),
    // Auto-refresh when the editor window regains focus (catches external changes from Finder)
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        controller.scheduleRefresh();
      }
    })
  );

  controller.restoreWatcher();
}

function deactivate() {
  // VS Code handles disposables registered via context.subscriptions
}

class WatchController {
  constructor(context) {
    this.context = context;
    this.treeDataProvider = new MarkdownTreeDataProvider(context.extensionUri);
    this.fileWatcher = undefined;
    this.previewPanels = new Map();
    this.suppressWatchOnce = new Set();
    this.openedFiles = new Set(context.workspaceState.get(OPENED_KEY, []));
    this.knownFiles = new Set(context.workspaceState.get(KNOWN_KEY, []));
    this.newFiles = new Set(context.workspaceState.get(NEW_KEY, []));
    this.treeDataProvider.setFileState(this.openedFiles, this.knownFiles, this.newFiles);
    this.updateBadge();
    this.refreshTimer = undefined;
  }

  // Activity-bar badge showing how many unread NEW artifacts are waiting.
  updateBadge() {
    if (!this.treeView) {
      return;
    }
    const count = this.newFiles.size;
    this.treeView.badge = count > 0
      ? { value: count, tooltip: `${count} new AI-DLC artifact${count === 1 ? '' : 's'}` }
      : undefined;
  }

  scheduleRefresh() {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.treeDataProvider.refresh();
      this.broadcastJourney();
      // Same debounce as the tree. Reading the v2 ledger is filesystem-only but
      // grows with the run (one observed project reached 1,182 events), so it
      // must not run per file-watcher event.
      this.refreshSupervision();
    }, 200);
  }

  // Hands the current watched folder to the v2 panel, which decides for itself
  // whether this is a v2 project and hides itself when it is not. Failures are
  // swallowed on purpose: nothing about the tree, the viewer or the v1 path may
  // depend on this succeeding.
  refreshSupervision() {
    if (!this.supervisionView) return;
    try {
      this.supervisionView.update(this.treeDataProvider.rootUri);
    } catch {
      // A panel that cannot render is a missing panel, not a broken extension.
    }
  }

  async restoreWatcher() {
    const storedFolder = this.context.workspaceState.get(STATE_KEY);
    if (!storedFolder) {
      // No popup on startup — the tree's viewsWelcome shows the "Select AI-DLC
      // Folder" call to action only when the user actually opens the view.
      this.treeDataProvider.setRootUri(undefined);
      this.refreshSupervision();
      // Except: if the open workspace already contains AI-DLC artifacts
      // (an aidlc-docs folder), offer to watch it — one prompt, once.
      await this.offerWorkspaceAutoDetect();
      return;
    }

    const uri = vscode.Uri.file(storedFolder);
    try {
      await vscode.workspace.fs.stat(uri);
      await this.setWatchedFolder(uri, { showMessage: false });
    } catch {
      // Stored folder is gone — reset to the welcome view without a popup.
      this.context.workspaceState.update(STATE_KEY, undefined);
      this.treeDataProvider.setRootUri(undefined);
      this.refreshSupervision();
    }
  }

  async promptForFolder(message) {
    const selectLabel = 'Select Folder';
    const helpLabel = 'Open Guide';
    const choice = await vscode.window.showInformationMessage(message, selectLabel, helpLabel);
    if (choice === selectLabel) {
      await this.selectFolder();
    } else if (choice === helpLabel) {
      this.showHelp();
    }
  }

  async selectFolder() {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Watch this folder'
    });

    if (!selection || !selection[0]) {
      return;
    }

    const folderUri = selection[0];
    await this.setWatchedFolder(folderUri, { showMessage: true });

    // Offer to set up AI-DLC rules right after the user explicitly picks a
    // folder via "Watch this folder". This runs only on an explicit pick,
    // never on watcher restore (F5 / window reload).
    await this.offerAidlcSetup(folderUri);
  }

  // Offered once, when a folder is picked explicitly. The prompt exists because
  // beginners were skipping the manual copy steps entirely, so it is worth asking.
  //
  // It routes through the same generation question the toolbar button asks. It used
  // to call the v1 installer directly, which meant this prompt silently decided
  // which AI-DLC generation the project would use -- and it always decided v1,
  // because that is the only thing it knew how to install.
  async offerAidlcSetup(folderUri) {
    try {
      if (!(await aidlcSetupNeeded(folderUri, this.context.extensionUri))) {
        return; // already set up, or bundle missing — stay quiet here
      }
      const yes = 'Choose a version';
      const choice = await vscode.window.showInformationMessage(
        'Set up the AI-DLC workflow for this folder?',
        yes,
        'Not now'
      );
      if (choice === yes) {
        await this.runSetup(folderUri);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`AI-DLC setup failed: ${err && err.message ? err.message : err}`);
    }
  }

  // The one place setup is decided. Every entry point goes through here so no path
  // can install a generation the user was never asked about.
  async runSetup(folderUri) {
    const target = folderUri ?? this.treeDataProvider.rootUri;
    await installCommands.setup(target, () => this.installV1(target));
    this.refresh();
    this.refreshSupervision();
  }

  // v1's installer, unchanged. Kept as a method so the generation chooser can call
  // it without knowing about the extension's bundle layout.
  async installV1(folderUri) {
    try {
      await ensureAidlcRules(folderUri, this.context.extensionUri);
    } catch (err) {
      vscode.window.showErrorMessage(`AI-DLC setup failed: ${err && err.message ? err.message : err}`);
    }
  }

  async setWatchedFolder(folderUri, options = { showMessage: true }) {
    this.disposeWatcher();
    this.treeDataProvider.setRootUri(folderUri);
    this.refreshSupervision();
    await this.context.workspaceState.update(STATE_KEY, folderUri.fsPath);
    await this.primeKnownFiles(folderUri);

    // Watch .md files for content updates & creations
    const mdPattern = new vscode.RelativePattern(folderUri, '**/*.md');
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(mdPattern);
    this.fileWatcher.onDidCreate((uri) => {
      if (isIgnoredEventPath(folderUri, uri)) return;
      this.handleCreate(uri);
      this.scheduleRefresh();
    });
    this.fileWatcher.onDidDelete((uri) => {
      if (isIgnoredEventPath(folderUri, uri)) return;
      this.scheduleRefresh();
    });
    this.fileWatcher.onDidChange((uri) => {
      if (isIgnoredEventPath(folderUri, uri)) return;
      this.scheduleRefresh();
      this.notifyOpenPreview(uri);
    });

    // Watch all paths (create/delete only) to catch new directories like operations/
    const dirPattern = new vscode.RelativePattern(folderUri, '**');
    this.dirWatcher = vscode.workspace.createFileSystemWatcher(dirPattern, false, true, false);
    this.dirWatcher.onDidCreate((uri) => {
      if (isIgnoredEventPath(folderUri, uri)) return;
      this.scheduleRefresh();
    });
    this.dirWatcher.onDidDelete((uri) => {
      if (isIgnoredEventPath(folderUri, uri)) return;
      this.scheduleRefresh();
    });

    // Polling fallback: catches external changes (Finder, git, CLI scripts) even if native watchers miss events
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.scheduleRefresh(), 15000);

    if (options.showMessage) {
      vscode.window.showInformationMessage(`Watching folder: ${folderUri.fsPath}`);
    }

    this.refresh();
  }

  // Setup from the toolbar button. Asks which generation, then routes.
  //
  // The folder check happens here rather than inside the chooser, because there is
  // nothing to ask about until a folder is being watched.
  async setupRules() {
    const folder = this.context.workspaceState.get(STATE_KEY);
    if (!folder) {
      await this.promptForFolder('Select an AI-DLC project folder first, then set up the rules.');
      return;
    }
    await this.runSetup(vscode.Uri.file(folder));
  }

  // When no folder is watched but the open workspace already contains an
  // aidlc-docs folder, offer to start watching that workspace folder.
  // Asked at most once per workspace (declining is remembered).
  async offerWorkspaceAutoDetect() {
    try {
      if (this.context.workspaceState.get(AUTODETECT_ASKED_KEY)) {
        return;
      }
      const wsFolders = vscode.workspace.workspaceFolders || [];
      let detected;
      for (const ws of wsFolders) {
        const docsUri = vscode.Uri.joinPath(ws.uri, 'aidlc-docs');
        try {
          const stat = await vscode.workspace.fs.stat(docsUri);
          if (stat.type === vscode.FileType.Directory) {
            detected = ws.uri;
            break;
          }
        } catch {
          // no aidlc-docs here
        }
      }
      if (!detected) {
        return; // nothing found — stay quiet, don't mark as asked
      }
      await this.context.workspaceState.update(AUTODETECT_ASKED_KEY, true);
      const watchLabel = 'Watch this workspace';
      const choice = await vscode.window.showInformationMessage(
        `AI-DLC artifacts detected (aidlc-docs) in ${path.basename(detected.fsPath)}. Watch this folder?`,
        watchLabel,
        'Not now'
      );
      if (choice === watchLabel) {
        await this.setWatchedFolder(detected, { showMessage: true });
      }
    } catch {
      // Non-critical convenience; never surface as an error.
    }
  }

  // First entry into the viewer with nothing being watched yet: open the
  // Viewer Guide so new users see what the extension does and how to start.
  // At most once per session; never again once a folder is being watched.
  maybeShowWelcomeGuide() {
    if (this.welcomeGuideShown) {
      return;
    }
    this.welcomeGuideShown = true;
    if (!this.context.workspaceState.get(STATE_KEY)) {
      this.showHelp();
    }
  }

  // Shows the "new setup feature" notice once per extension version, the first
  // time the user opens the AI-DLC view after updating.
  async maybeShowSetupNotice() {
    try {
      const version = (this.context.extension && this.context.extension.packageJSON && this.context.extension.packageJSON.version) || '';
      const shownFor = this.context.globalState.get(SETUP_NOTICE_KEY);
      if (!version || shownFor === version) {
        return;
      }
      // Record first so we never nag more than once per version, even if dismissed.
      await this.context.globalState.update(SETUP_NOTICE_KEY, version);

      const setupLabel = 'Set up AI-DLC';
      const guideLabel = 'Open Guide';
      const choice = await vscode.window.showInformationMessage(
        'AI-DLC Viewer: the new "Set up AI-DLC Rules" toolbar button installs the AI-DLC workflow (Kiro, Claude Code, and more) for your project in one click.',
        setupLabel,
        guideLabel
      );
      if (choice === setupLabel) {
        await this.setupRules();
      } else if (choice === guideLabel) {
        this.showHelp();
      }
    } catch {
      // Non-critical UI nicety; never let it surface as an error.
    }
  }

  refresh() {
    this.treeDataProvider.refresh();
  }

  async openFile(item) {
    if (!item || item.type !== 'file') {
      return;
    }

    await this.markFileOpened(item.resourceUri);

    // Highlight active file in the tree
    if (this.treeView) {
      try { this.treeView.reveal(item, { select: true, focus: false }); } catch {}
    }

    const key = item.resourceUri.toString();
    let panel = this.previewPanels.get(key);

    if (panel) {
      panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const extensionUri = this.context.extensionUri;
    panel = vscode.window.createWebviewPanel(
      'markdownWatchViewer.editor',
      path.basename(item.resourceUri.fsPath),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    this.previewPanels.set(key, panel);
    panel.onDidDispose(() => {
      this.previewPanels.delete(key);
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'save') {
        await this.saveMarkdown(item.resourceUri, message.content);
        return;
      }

      if (message.type === 'requestLatest') {
        await this.updatePreview(panel, item.resourceUri);
      }
    });

    await this.updatePreview(panel, item.resourceUri);
  }

  // Context-menu alternative to the custom split viewer: open the file in a
  // regular VS Code text editor. Counts as "read" the same way openFile does.
  async openInTextEditor(item) {
    if (!item || item.type !== 'file') {
      return;
    }
    await this.markFileOpened(item.resourceUri);
    await vscode.window.showTextDocument(item.resourceUri, { viewColumn: vscode.ViewColumn.One });
  }

  showHelp() {
    if (this.helpPanel) {
      this.helpPanel.reveal(vscode.ViewColumn.One);
      return;
    }
    this.helpPanel = vscode.window.createWebviewPanel(
      'markdownWatchViewer.help',
      'AI-DLC Viewer Guide',
      vscode.ViewColumn.One,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    this.helpPanel.webview.html = getHelpHtml();
    this.helpPanel.onDidDispose(() => {
      this.helpPanel = undefined;
    });
  }

  async updatePreview(panel, fileUri) {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const content = Buffer.from(bytes).toString('utf8');
    const journey = await this.getJourneyPayload(fileUri);
    panel.title = path.basename(fileUri.fsPath);
    if (!panel.webview.html) {
      panel.webview.html = getWebviewHtml(panel.webview, fileUri, content, this.context.extensionUri, journey);
    } else {
      panel.webview.postMessage({ type: 'setContent', content, path: fileUri.fsPath });
      panel.webview.postMessage({ type: 'setJourney', journey });
    }
  }

  // Journey model for the viewer's header strip, with the checkpoint of the file
  // being viewed resolved on top of the cached project-wide model.
  //
  // Returns undefined whenever the journey cannot be determined (no watched
  // folder, no artifacts, unreadable workspace). The webview then renders no strip
  // at all and behaves exactly as it did before this feature existed.
  async getJourneyPayload(fileUri) {
    try {
      const folder = this.context.workspaceState.get(STATE_KEY);
      if (!folder) {
        return undefined;
      }
      const summary = await this.treeDataProvider.getStageSummary(vscode.Uri.file(folder));
      const journey = summary && summary.journey;
      if (!journey || journey.currentIndex < 0) {
        return undefined; // nothing has run yet; a strip would be noise
      }

      let openIndex = -1;
      if (fileUri) {
        // Which checkpoint the open file belongs to, resolved differently per
        // generation because the two use different vocabularies for it. v1 maps
        // directory names to stage names through a table; v2 puts the stage's own
        // slug in the path, so membership against the compiled slug list answers
        // it without a table to keep in step.
        //
        // The root comes from `folder` above rather than from a `this.rootUri`
        // that does not exist on this class -- reaching for it threw, and the
        // catch below turned that into "no strip at all" rather than into a
        // missing position marker.
        if (summary.generation === 'v2') {
          const rel = path.relative(folder, fileUri.fsPath);
          if (rel && !rel.startsWith('..')) {
            openIndex = checkpointIndexForPath(journey, rel);
          }
        } else if (summary.stageRoot) {
          const relPath = toStageRootRelative(summary.stageRoot, fileUri);
          if (!relPath.startsWith('..')) {
            const id = checkpointIdForPath(relPath);
            if (id) {
              openIndex = CHECKPOINTS.findIndex((cp) => cp.id === id);
            }
          }
        }
      }

      return { ...journey, openIndex };
    } catch (err) {
      // The strip must never break the viewer, but a silent catch here hid a real
      // bug: a reference to a property that does not exist on this class threw, and
      // the strip vanished entirely rather than losing only its position marker.
      // So the reason goes to the log while the viewer still degrades quietly.
      console.error('[aidlc-viewer] journey strip payload failed:', err);
      return undefined;
    }
  }

  // External changes can move the project forward while viewers are open, and each
  // panel needs its own openIndex, so every panel is refreshed individually.
  broadcastJourney() {
    for (const [key, panel] of this.previewPanels) {
      this.getJourneyPayload(vscode.Uri.parse(key))
        .then((journey) => panel.webview.postMessage({ type: 'setJourney', journey }))
        .catch(() => {
          // a disposed panel or an unreadable workspace is not worth surfacing
        });
    }
  }

  async saveMarkdown(fileUri, content) {
    const key = fileUri.toString();
    this.suppressWatchOnce.add(key);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`Saved ${path.basename(fileUri.fsPath)}`);
  }

  async notifyOpenPreview(uri) {
    const key = uri.toString();
    if (this.suppressWatchOnce.has(key)) {
      this.suppressWatchOnce.delete(key);
      return;
    }
    const panel = this.previewPanels.get(key);
    if (!panel) {
      return;
    }
    await this.updatePreview(panel, uri);
  }

  // Called by VS Code via context.subscriptions on deactivation. Not invoked
  // during normal operation, so runtime behavior is unchanged.
  dispose() {
    this.disposeWatcher();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.revealTimer) {
      clearTimeout(this.revealTimer);
      this.revealTimer = undefined;
    }
  }

  disposeWatcher() {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
    if (this.dirWatcher) {
      this.dirWatcher.dispose();
      this.dirWatcher = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // Best-effort: reveal a newly created file so its ancestor folders expand
  // even when VS Code remembers them as collapsed. Debounced past the tree
  // refresh (200ms); only acts while the view is visible, never steals focus.
  scheduleReveal(uri) {
    this.pendingRevealUri = uri;
    if (this.revealTimer) {
      return;
    }
    this.revealTimer = setTimeout(async () => {
      this.revealTimer = undefined;
      const target = this.pendingRevealUri;
      this.pendingRevealUri = undefined;
      if (!target || !this.treeView || !this.treeView.visible) {
        return;
      }
      try {
        const item = await this.treeDataProvider.findItemByUri(target);
        if (item) {
          await this.treeView.reveal(item, { select: false, focus: false, expand: true });
        }
      } catch {
        // reveal is a convenience — never surface errors
      }
    }, 400);
  }

  async handleCreate(uri) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.File && uri.fsPath.toLowerCase().endsWith('.md')) {
        this.knownFiles.add(uri.toString());
        this.newFiles.add(uri.toString());
        this.treeDataProvider.setFileState(this.openedFiles, this.knownFiles, this.newFiles);
        this.updateBadge();
        await this.context.workspaceState.update(KNOWN_KEY, [...this.knownFiles]);
        await this.context.workspaceState.update(NEW_KEY, [...this.newFiles]);
        this.scheduleReveal(uri);
        return;
      }

      if (stat.type === vscode.FileType.Directory) {
        const files = await collectMarkdownFiles(uri);
        let changed = false;
        for (const file of files) {
          const key = file.toString();
          if (!this.knownFiles.has(key)) {
            this.knownFiles.add(key);
            this.newFiles.add(key);
            changed = true;
          }
        }
        if (changed) {
          this.treeDataProvider.setFileState(this.openedFiles, this.knownFiles, this.newFiles);
          this.updateBadge();
          await this.context.workspaceState.update(KNOWN_KEY, [...this.knownFiles]);
          await this.context.workspaceState.update(NEW_KEY, [...this.newFiles]);
        }
      }
    } catch {
      return;
    }
  }

  async markFileOpened(fileUri) {
    const key = fileUri.toString();
    if (!this.knownFiles.has(key)) {
      this.knownFiles.add(key);
      await this.context.workspaceState.update(KNOWN_KEY, [...this.knownFiles]);
    }

    if (!this.openedFiles.has(key)) {
      this.openedFiles.add(key);
    }

    if (this.newFiles.has(key)) {
      this.newFiles.delete(key);
    }

    this.treeDataProvider.setFileState(this.openedFiles, this.knownFiles, this.newFiles);
    this.updateBadge();
    await this.context.workspaceState.update(OPENED_KEY, [...this.openedFiles]);
    await this.context.workspaceState.update(NEW_KEY, [...this.newFiles]);
  }

  async primeKnownFiles(folderUri) {
    const existingFiles = await collectMarkdownFiles(folderUri);
    const existingSet = new Set(existingFiles.map((file) => file.toString()));

    this.openedFiles = new Set([...this.openedFiles].filter((key) => existingSet.has(key)));
    this.knownFiles = new Set([...existingSet, ...this.knownFiles].filter((key) => existingSet.has(key)));
    this.newFiles = new Set([...this.newFiles].filter((key) => existingSet.has(key) && !this.openedFiles.has(key)));

    this.treeDataProvider.setFileState(this.openedFiles, this.knownFiles, this.newFiles);
    this.updateBadge();
    await this.context.workspaceState.update(OPENED_KEY, [...this.openedFiles]);
    await this.context.workspaceState.update(KNOWN_KEY, [...this.knownFiles]);
    await this.context.workspaceState.update(NEW_KEY, [...this.newFiles]);
  }
}

class MarkdownTreeDataProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.rootUri = undefined;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.metadataCache = new Map();
    this.directoryStatsCache = new Map();
    this.stageSummaryCache = new Map();
    this.openedFiles = new Set();
    this.knownFiles = new Set();
    this.newFiles = new Set();
  }

  setFileState(openedFiles, knownFiles, newFiles) {
    this.openedFiles = new Set(openedFiles);
    this.knownFiles = new Set(knownFiles);
    this.newFiles = new Set(newFiles);
    this.refresh();
  }

  setRootUri(rootUri) {
    this.rootUri = rootUri;
    this.refresh();
  }

  refresh() {
    this.metadataCache.clear();
    this.directoryStatsCache.clear();
    this.stageSummaryCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    return element;
  }

  getParent(element) {
    return element.parent || null;
  }

  async getChildren(element) {
    if (!this.rootUri) {
      // Returning an empty array lets VS Code show the viewsWelcome panel
      return [];
    }

    if (!element) {
      const stageSummary = await this.getStageSummary(this.rootUri);
      const entries = await this.getDirectoryEntries(this.rootUri, null);
      return [
        new StageItem(stageSummary),
        new ProgressItem(stageSummary),
        ...entries
      ];
    }

    if (element.contextValue === 'progress') {
      const journey = element.summary.journey;
      if (!journey || !Array.isArray(journey.checkpoints)) {
        return [];
      }
      // Phase order comes from the order the checkpoints themselves are in,
      // taking each phase at its first appearance. That is the workflow order by
      // construction, so it needs no list to keep in step with the model.
      //
      // This replaces a hardcoded ['setup', 'inception', 'construction',
      // 'operations']. For v1 the result is identical, because the v1 checkpoint
      // list is already in exactly that order. For v2 it is the only thing that
      // works: that project declares five phases whose names the extension does
      // not know until it reads the project's own compiled stage graph.
      const byPhase = new Map();
      for (const cp of journey.checkpoints) {
        if (!byPhase.has(cp.phase)) {
          byPhase.set(cp.phase, []);
        }
        byPhase.get(cp.phase).push(cp);
      }
      return [...byPhase]
        // A phase the scope skipped in full has nothing to report: a row reading
        // "0/0, 7 skipped" invites the reader to wonder what is missing when the
        // answer is that this project was never going to run it. v1 never hits
        // this because it has no scope mechanism, so no v1 row disappears.
        .filter(([, nodes]) => nodes.some((cp) => cp.status !== 'skipped'))
        .map(([phase, nodes]) => new StageProgressChild(phase, nodes));
    }

    return this.getDirectoryEntries(element.resourceUri, element);
  }

  // Walks from the root to the given file URI through getChildren(), so the
  // returned item carries the parent chain treeView.reveal() needs. Returns
  // undefined when the URI is not under the root or not visible in the tree.
  async findItemByUri(targetUri) {
    if (!this.rootUri) {
      return undefined;
    }
    const rel = path.relative(this.rootUri.fsPath, targetUri.fsPath);
    if (!rel || rel.startsWith('..')) {
      return undefined;
    }

    const targetKey = targetUri.toString();
    let element = undefined; // undefined = root level
    while (true) {
      const children = await this.getChildren(element);
      const next = children.find((item) => {
        if (!item.resourceUri) {
          return false;
        }
        const key = item.resourceUri.toString();
        return key === targetKey || targetKey.startsWith(ensureTrailingSlash(key));
      });
      if (!next) {
        return undefined;
      }
      if (next.resourceUri.toString() === targetKey) {
        return next;
      }
      element = next;
    }
  }

  async getDirectoryEntries(targetUri, parentItem) {
    const entries = await vscode.workspace.fs.readDirectory(targetUri);

    const rawItems = await Promise.all(
      entries
        .filter(([name, fileType]) => {
          if (name.startsWith('.')) return false;
          if (fileType === vscode.FileType.Directory && shouldSkipDirectory(name)) return false;
          return true;
        })
        .map(async ([name, fileType]) => {
          const childUri = vscode.Uri.joinPath(targetUri, name);
          const isDirectory = fileType === vscode.FileType.Directory;
          if (isDirectory) {
            const stats = await this.getDirectoryStats(childUri);
            const isStageDir = !!detectStageFromResource(childUri);
            if (!stats.hasMarkdown && !isStageDir) {
              return undefined;
            }

            const dirItem = new DirectoryItem(
              childUri,
              stats,
              getDirectoryVisualState(childUri, this.openedFiles, this.knownFiles, this.newFiles)
            );
            dirItem.parent = parentItem;
            return dirItem;
          }

          const fileItem = createFileItem(
            childUri,
            fileType,
            await this.getMarkdownMetadata(childUri),
            getFileVisualState(childUri, this.openedFiles, this.knownFiles, this.newFiles)
          );
          if (fileItem) fileItem.parent = parentItem;
          return fileItem;
        })
    );

    const items = rawItems.filter(Boolean).sort(sortItems);

    return items;
  }

  async getStageSummary(rootUri) {
    const cacheKey = rootUri.toString();
    if (this.stageSummaryCache.has(cacheKey)) {
      return this.stageSummaryCache.get(cacheKey);
    }

    // Progress counts only artifacts under <stageRoot>/<stage>/, where
    // stageRoot is the aidlc-docs folder inside the watched root (or the
    // root itself when it has no aidlc-docs — e.g. aidlc-docs was selected
    // directly). Stray files whose path merely contains a stage word no
    // longer inflate the percentages.
    const stageRoot = await resolveStageRoot(rootUri);
    const counts = {
      inception: 0,
      construction: 0,
      operations: 0
    };
    let latest = undefined;
    // Artifact paths relative to the stage root, reused to build the journey model
    // below. Collected inside the walk that already happens, so the journey costs
    // no extra filesystem calls.
    const artifacts = [];

    for (const stage of ['inception', 'construction', 'operations']) {
      const stageDir = vscode.Uri.joinPath(stageRoot, stage);
      let files;
      try {
        files = await collectMarkdownFiles(stageDir);
      } catch {
        continue; // stage folder doesn't exist yet
      }

      counts[stage] = files.length;

      for (const fileUri of files) {
        let mtime = 0;
        try {
          const stat = await vscode.workspace.fs.stat(fileUri);
          mtime = stat.mtime;
          if (!latest || stat.mtime > latest.mtime) {
            latest = { stage, fileUri, mtime: stat.mtime };
          }
        } catch {
          // keep the artifact; only its mtime is unknown
        }
        artifacts.push({ relPath: toStageRootRelative(stageRoot, fileUri), mtime });
      }
    }

    // Layer 1 (accurate): aidlc-state.md checklist with bundled-rule step
    // counts as denominator. Layer 2 (estimated): artifact-count heuristic,
    // used when no parseable state file exists.
    const state = await readAidlcState(stageRoot);
    let progress;
    let inProgressLabel;
    let currentStage;
    if (state) {
      const stepCounts = await getBundledStageStepCounts(this.extensionUri);
      progress = computeProgressFromState(state, stepCounts);
      inProgressLabel = state.inProgressStep?.name;
      currentStage = state.inProgressStep?.stage || latest?.stage || inferStageFromCounts(counts);
    } else {
      progress = computeProgress(counts);
      currentStage = latest?.stage || inferStageFromCounts(counts);
    }

    const summary = {
      currentStage,
      counts,
      // No longer displayed anywhere: the percentage was replaced by reached-stage
      // counts derived from `journey`. Kept only until the layer-1/layer-2 progress
      // computation is removed in a follow-up, so nothing reads this field.
      progress,
      inProgressLabel,
      latestFile: latest?.fileUri,
      latestModifiedLabel: latest?.fileUri ? path.basename(latest.fileUri.fsPath) : undefined,
      latestMtime: latest?.mtime,
      stageRoot,
      // For the viewer's journey strip and the tree's progress rows.
      //
      // The v1 journey is built here from the artifact walk this method already
      // did, then handed to the adapter. The adapter returns it unchanged for a
      // v1 project, so that path cannot be altered by anything downstream; for a
      // v2 project it substitutes a journey read from the engine's own compiled
      // stage graph. Without this a v2 project showed every stage as pending,
      // because it has no aidlc-docs/ directory for the walk above to find.
      ...this.resolveJourney(rootUri, buildJourney({
        artifacts,
        rulesInstalled: await detectRulesInstalled(rootUri)
      }))
    };

    this.stageSummaryCache.set(cacheKey, summary);
    return summary;
  }

  // Routes a freshly built v1 journey through the generation adapter.
  //
  // For a v1 project the adapter hands back the very object passed in, so this is
  // a no-op on the path 3,000 existing users are on. For a v2 project it returns
  // a journey read from that project's compiled stage graph and runtime state.
  //
  // The generation comes back too, because the tree's summary row has to know
  // which one it is looking at: a v1 project's artifact counts are meaningful and
  // a v2 project's are all zero, so a row that fell back on "the journey said
  // something" would rewrite what v1 users see.
  //
  // Any failure falls back to the v1 journey rather than propagating: a tree that
  // renders v1-shaped progress is wrong on a v2 project, but a tree that throws
  // is wrong on every project.
  resolveJourney(rootUri, v1Journey) {
    try {
      const project = readProject(rootUri.fsPath, { v1Journey });
      return { journey: project.journey ?? v1Journey, generation: project.generation };
    } catch {
      return { journey: v1Journey, generation: undefined };
    }
  }

  async getMarkdownMetadata(resourceUri) {
    if (!resourceUri.fsPath.toLowerCase().endsWith('.md')) {
      return undefined;
    }

    const cacheKey = resourceUri.toString();
    if (this.metadataCache.has(cacheKey)) {
      return this.metadataCache.get(cacheKey);
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(resourceUri);
      const content = Buffer.from(bytes).toString('utf8');
      const lines = content.split(/\r?\n/);
      const heading = lines.find((line) => line.startsWith('# '))?.replace(/^#\s+/, '').trim();
      const summary = lines
        .find((line) => line.trim() && !line.startsWith('#') && !line.startsWith('```'))
        ?.trim();

      const metadata = { heading, summary };
      this.metadataCache.set(cacheKey, metadata);
      return metadata;
    } catch {
      const metadata = { heading: undefined, summary: undefined };
      this.metadataCache.set(cacheKey, metadata);
      return metadata;
    }
  }

  async getDirectoryStats(resourceUri) {
    const cacheKey = resourceUri.toString();
    if (this.directoryStatsCache.has(cacheKey)) {
      return this.directoryStatsCache.get(cacheKey);
    }

    try {
      const entries = await vscode.workspace.fs.readDirectory(resourceUri);
      let markdownCount = 0;
      let childDirectoryCount = 0;
      let hasMarkdown = false;

      for (const [name, fileType] of entries) {
        if (fileType === vscode.FileType.Directory && shouldSkipDirectory(name)) {
          continue;
        }
        if (name.startsWith('.')) {
          continue;
        }

        const childUri = vscode.Uri.joinPath(resourceUri, name);
        if (fileType === vscode.FileType.File && name.toLowerCase().endsWith('.md')) {
          markdownCount += 1;
          hasMarkdown = true;
          continue;
        }

        if (fileType === vscode.FileType.Directory) {
          const childStats = await this.getDirectoryStats(childUri);
          if (childStats.hasMarkdown) {
            hasMarkdown = true;
            childDirectoryCount += 1;
          }
        }
      }

      const stats = { hasMarkdown, markdownCount, childDirectoryCount };
      this.directoryStatsCache.set(cacheKey, stats);
      return stats;
    } catch {
      const stats = { hasMarkdown: false, markdownCount: 0, childDirectoryCount: 0 };
      this.directoryStatsCache.set(cacheKey, stats);
      return stats;
    }
  }
}

class StageDecorationProvider {
  constructor() {
    this._onDidChangeFileDecorations = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  }

  provideFileDecoration(uri) {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const stage = detectStageFromResource(uri);
    if (!stage) {
      return undefined;
    }
    const palette = {
      inception:    { color: 'charts.blue',   badge: 'I' },
      construction: { color: 'charts.purple', badge: 'C' },
      operations:   { color: 'charts.green',  badge: 'O' }
    }[stage];
    return {
      color: new vscode.ThemeColor(palette.color),
      badge: palette.badge,
      tooltip: `AIDLC: ${capitalize(stage)}`,
      propagate: true
    };
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(label, description) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'info';
  }
}

class ProgressItem extends vscode.TreeItem {
  constructor(summary) {
    // No percentage. AI-DLC is adaptive, so the denominator is not knowable: most
    // stages are CONDITIONAL, and Construction repeats per unit with a unit count
    // that does not exist until Units Generation has run. Counting reached stages is
    // defensible; the old weighted percentage was invented, and it reported 0% on
    // real projects full of artifacts.
    const journey = summary.journey;
    const current =
      journey && journey.currentIndex >= 0 ? journey.checkpoints[journey.currentIndex] : undefined;
    super(current ? current.label : 'Not started', vscode.TreeItemCollapsibleState.Collapsed);
    this.summary = summary;
    this.description = formatJourneyCounts(journey);
    this.tooltip = buildProgressTooltip(summary);
    this.contextValue = 'progress';
    this.iconPath = new vscode.ThemeIcon('pulse', getStageColor(summary.currentStage));
  }
}

// Skipped stages are excluded from the denominator: they are not work left to do.
function formatJourneyCounts(journey) {
  if (!journey || !Array.isArray(journey.checkpoints)) {
    return '';
  }
  const counts = journey.counts || {};
  const skipped = counts.skipped || 0;
  const parts = [`${counts.done || 0}/${journey.plannedTotal}`];
  if (counts.active) {
    parts.push(`${counts.active} in progress`);
  }
  if (skipped) {
    // v2 excludes a stage because the scope never included it; v1 excludes one
    // because the run went past it. Same count, different sentence, and the word
    // is chosen from the checkpoints rather than from the generation so v1's text
    // is unchanged by construction.
    const outOfScope = journey.checkpoints.filter((cp) => cp.outOfScope).length;
    parts.push(`${skipped} ${outOfScope === skipped ? 'not in scope' : 'skipped'}`);
  }
  return parts.join(' · ');
}

class StageProgressChild extends vscode.TreeItem {
  constructor(phase, checkpoints) {
    super(capitalize(phase), vscode.TreeItemCollapsibleState.None);
    const done = checkpoints.filter((cp) => cp.status === 'done').length;
    const skipped = checkpoints.filter((cp) => cp.status === 'skipped').length;
    const outOfScope = checkpoints.filter((cp) => cp.outOfScope).length;
    const planned = checkpoints.filter(
      (cp) => cp.status !== 'skipped' && !(cp.placeholder && cp.status !== 'done')
    ).length;
    const parts = [`${done}/${planned}`];
    if (skipped) {
      parts.push(`${skipped} ${outOfScope === skipped ? 'not in scope' : 'skipped'}`);
    }
    if (checkpoints.some((cp) => cp.placeholder && cp.status !== 'done')) {
      parts.push('placeholder');
    }
    this.description = parts.join(' · ');
    this.iconPath = new vscode.ThemeIcon('circle-small-filled', getStageColor(phase));
    this.contextValue = 'stageProgress';
  }
}

class StageItem extends vscode.TreeItem {
  constructor(summary) {
    super(formatStageLabel(summary), vscode.TreeItemCollapsibleState.None);
    // With a parseable aidlc-state.md, show the actual in-progress step name
    // (the most useful fact); otherwise keep the artifact-count summary.
    this.description = summary.inProgressLabel
      ? `▸ ${summary.inProgressLabel}`
      : formatStageDescription(summary);
    this.tooltip = buildStageTooltip(summary);
    this.contextValue = 'stageSummary';
    // The journey's phase when there is one, so a v2 project gets its own phase's
    // icon and tone rather than the grey question mark the v1 detection produces
    // on a tree with no aidlc-docs/ to count.
    const phase = currentPhaseFromJourney(summary) ?? summary.currentStage;
    this.iconPath = new vscode.ThemeIcon(getStageIcon(phase), getStageColor(phase));
  }
}

class DirectoryItem extends vscode.TreeItem {
  constructor(resourceUri, stats, visualState) {
    // Folders that contain unread NEW files below them start expanded so
    // freshly generated AI-DLC artifacts are visible without manual digging.
    // Once every file inside is opened (read), the folder collapses as before.
    super(
      path.basename(resourceUri.fsPath),
      visualState.hasNew
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    // The id must stay stable across NEW→READ transitions — a changing id
    // makes VS Code treat the folder as a fresh item and reset it to
    // Collapsed, snapping the expanded chain shut when a file is opened.
    // Expanded above covers brand-new folders (no remembered state); files
    // added to existing folders are surfaced via treeView.reveal() instead.
    this.id = resourceUri.toString();
    this.resourceUri = resourceUri;
    this.type = 'directory';
    this.contextValue = 'directory';
    this.description = formatDirectoryDescription(stats, visualState);
    this.tooltip = buildDirectoryTooltip(resourceUri, stats, visualState);
    this.iconPath = new vscode.ThemeIcon(
      getDirectoryIconName(resourceUri),
      getDirectoryColor(resourceUri, visualState)
    );
  }
}

class MarkdownFileItem extends vscode.TreeItem {
  constructor(resourceUri, metadata, visualState) {
    super(path.basename(resourceUri.fsPath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = resourceUri;
    this.id = resourceUri.toString();
    this.type = 'file';
    this.contextValue = 'markdownFile';
    this.description = formatFileDescription(metadata, visualState);
    this.tooltip = buildFileTooltip(resourceUri, metadata, visualState);
    this.iconPath = new vscode.ThemeIcon(
      visualState.isNew ? 'circle-filled' : visualState.isRead ? 'pass-filled' : 'file',
      visualState.isNew ? new vscode.ThemeColor('charts.green') : visualState.isRead ? new vscode.ThemeColor('disabledForeground') : undefined
    );
    this.command = {
      command: 'markdownWatchViewer.openFile',
      title: 'Open Markdown File',
      arguments: [this]
    };
  }
}

class OtherFileItem extends vscode.TreeItem {
  constructor(resourceUri) {
    super(path.basename(resourceUri.fsPath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = resourceUri;
    this.type = 'file';
    this.contextValue = 'file';
    this.description = path.extname(resourceUri.fsPath) || 'file';
  }
}

function createFileItem(resourceUri, fileType, metadata, visualState) {
  if (fileType !== vscode.FileType.File) {
    return undefined;
  }

  if (resourceUri.fsPath.toLowerCase().endsWith('.md')) {
    return new MarkdownFileItem(resourceUri, metadata, visualState);
  }

  return undefined;
}

function sortItems(left, right) {
  const leftRank = getItemSortRank(left);
  const rightRank = getItemSortRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.label.localeCompare(right.label);
}

function formatDirectoryDescription(stats, visualState) {
  const parts = [];
  if (visualState.newCount > 0) {
    parts.push(`${visualState.newCount} new`);
  }
  if (visualState.readCount > 0) {
    parts.push(`${visualState.readCount} read`);
  }
  if (stats.markdownCount > 0) {
    parts.push(`${stats.markdownCount} md`);
  }
  if (stats.childDirectoryCount > 0) {
    parts.push(`${stats.childDirectoryCount} dirs`);
  }
  return parts.join(' • ');
}

function buildDirectoryTooltip(resourceUri, stats, visualState) {
  const sectionHint = getDirectorySectionHint(resourceUri);
  return [
    resourceUri.fsPath,
    sectionHint,
    visualState.newCount > 0 ? `New markdown files below: ${visualState.newCount}` : 'No new markdown files',
    visualState.readCount > 0 ? `Read markdown files below: ${visualState.readCount}` : undefined,
    `Markdown files here: ${stats.markdownCount}`,
    `Child folders with markdown: ${stats.childDirectoryCount}`
  ]
    .filter(Boolean)
    .join('\n');
}

function formatFileDescription(metadata, visualState) {
  const stateLabel = visualState.isNew ? 'NEW' : visualState.isRead ? 'READ' : undefined;
  return [stateLabel, metadata?.heading].filter(Boolean).join(' • ');
}

function buildFileTooltip(resourceUri, metadata, visualState) {
  return [
    resourceUri.fsPath,
    visualState.isNew ? 'New file since watching started' : visualState.isRead ? 'Opened in the viewer' : 'Existing file in watched folder',
    metadata?.heading,
    metadata?.summary
  ]
    .filter(Boolean)
    .join('\n');
}

function getDirectoryIconName(resourceUri) {
  const name = path.basename(resourceUri.fsPath).toLowerCase();
  if (name === 'common') {
    return 'library';
  }
  if (name === 'inception') {
    return 'compass';
  }
  if (name === 'construction') {
    return 'tools';
  }
  if (name === 'operations') {
    return 'pulse';
  }
  if (name === 'extensions') {
    return 'extensions';
  }
  return 'folder';
}

function getDirectorySectionHint(resourceUri) {
  const name = path.basename(resourceUri.fsPath).toLowerCase();
  if (name === 'common') {
    return 'Shared workflow rules and standards';
  }
  if (name === 'inception') {
    return 'Planning and analysis stage rules';
  }
  if (name === 'construction') {
    return 'Implementation and build stage rules';
  }
  if (name === 'operations') {
    return 'Operations stage rules';
  }
  if (name === 'extensions') {
    return 'Optional extension rule packs';
  }
  return undefined;
}

function getDirectoryColor(resourceUri, visualState) {
  const stageColor = getStageColor(detectStageFromPath(`${resourceUri.fsPath}${path.sep}placeholder.md`));
  if (stageColor) {
    return stageColor;
  }

  if (visualState.hasNew) {
    return new vscode.ThemeColor('charts.green');
  }

  return undefined;
}

// AI-DLC generates artifacts under aidlc-docs/{inception,construction,operations}.
// If the watched root contains an aidlc-docs folder, stages are counted there;
// otherwise the root itself is treated as the stage root (covers users who
// select the aidlc-docs folder directly, matching the previous behavior).
async function resolveStageRoot(rootUri) {
  const docsUri = vscode.Uri.joinPath(rootUri, 'aidlc-docs');
  try {
    const stat = await vscode.workspace.fs.stat(docsUri);
    if (stat.type === vscode.FileType.Directory) {
      return docsUri;
    }
  } catch {
    // no aidlc-docs folder
  }
  return rootUri;
}

// Journey artifacts are addressed by their path relative to the stage root, e.g.
// 'construction/<unit>/code/code-summary.md'. Normalised to forward slashes so the
// pure journey model never sees a platform-specific separator.
function toStageRootRelative(stageRoot, fileUri) {
  return path.relative(stageRoot.fsPath, fileUri.fsPath).split(path.sep).join('/');
}

// Whether AI-DLC rules are installed in the project, checked in the same order
// core-workflow.md resolves the rule details directory. Only drives the journey's
// first checkpoint, so a miss is cosmetic.
async function detectRulesInstalled(rootUri) {
  const candidates = [
    ['.aidlc', 'aidlc-rules'],
    ['.aidlc-rule-details'],
    ['.kiro', 'aws-aidlc-rule-details'],
    ['.amazonq', 'aws-aidlc-rule-details']
  ];
  for (const segments of candidates) {
    if (await pathExists(vscode.Uri.joinPath(rootUri, ...segments))) {
      return true;
    }
  }
  return false;
}

function detectStageFromPath(filePath) {
  const normalized = filePath.toLowerCase();
  if (normalized.includes(`${path.sep}operations${path.sep}`)) {
    return 'operations';
  }
  if (normalized.includes(`${path.sep}construction${path.sep}`)) {
    return 'construction';
  }
  if (normalized.includes(`${path.sep}inception${path.sep}`)) {
    return 'inception';
  }
  return undefined;
}

function detectStageFromResource(uri) {
  const segments = uri.fsPath.toLowerCase().split(path.sep);
  if (segments.includes('operations')) return 'operations';
  if (segments.includes('construction')) return 'construction';
  if (segments.includes('inception')) return 'inception';
  return undefined;
}

function inferStageFromCounts(counts) {
  if (counts.operations > 0) {
    return 'operations';
  }
  if (counts.construction > 0) {
    return 'construction';
  }
  if (counts.inception > 0) {
    return 'inception';
  }
  return 'unknown';
}

// ========== Layer 1: accurate progress from aidlc-docs/aidlc-state.md ==========
//
// AI-DLC records its own progress as an incrementally-growing checklist:
//   ## Stage Progress
//   - [x] INCEPTION - Workspace Detection (COMPLETED)
//   - [ ] INCEPTION - Requirements Analysis (IN PROGRESS)
// Steps are appended one at a time, so the file tells us what's done and what's
// in progress — but not the total step count. The denominator comes from the
// bundled rule files per stage (getBundledStageStepCounts). Stage names are
// parsed dynamically (not hardcoded) so future AI-DLC versions with new stages
// (e.g. IDEATION in v2) still display.

// v2 uses singular OPERATION; map it onto the same bucket as v1's OPERATIONS.
function normalizeStageName(name) {
  const s = name.toLowerCase();
  return s === 'operation' ? 'operations' : s;
}

// Returns { steps, inProgressStep } or undefined when no parseable
// "## Stage Progress" checklist exists (→ caller falls back to layer 2).
function parseAidlcState(content) {
  const lines = content.split(/\r?\n/);
  const steps = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Stage Progress/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) {
      break; // next section
    }
    if (!inSection) {
      continue;
    }
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s*([A-Za-z]+)\s*-\s*(.+?)\s*(?:\(([^)]*)\))?\s*$/);
    if (!m) {
      continue;
    }
    steps.push({
      stage: normalizeStageName(m[2]),
      name: m[3].trim(),
      done: m[1].toLowerCase() === 'x',
      status: (m[4] || '').toUpperCase()
    });
  }
  if (steps.length === 0) {
    return undefined;
  }
  const inProgressStep =
    steps.find((s) => !s.done && s.status.includes('PROGRESS')) ||
    steps.find((s) => !s.done);
  return { steps, inProgressStep };
}

async function readAidlcState(stageRoot) {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(stageRoot, 'aidlc-state.md'));
    return parseAidlcState(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined; // missing or unreadable — fall back to artifact counts
  }
}

function computeProgressFromState(state, stepCounts) {
  const byStage = {};
  for (const step of state.steps) {
    const bucket = byStage[step.stage] || (byStage[step.stage] = { done: 0, listed: 0 });
    bucket.listed += 1;
    if (step.done) {
      bucket.done += 1;
    }
  }

  const stages = {};
  let overall = 0;
  for (const stage of ['inception', 'construction', 'operations']) {
    const info = byStage[stage] || { done: 0, listed: 0 };
    // Bundle step count is the denominator; if the state file already lists
    // more steps than the bundle has (custom workflow), trust the state file
    // so the percentage can never exceed 100.
    const expected = Math.max(stepCounts[stage] || 1, info.listed);
    const pct = Math.min(100, Math.round((info.done / expected) * 100));
    stages[stage] = { pct, count: info.done, expected };
    overall += pct * STAGE_WEIGHTS[stage];
  }

  return {
    overall: Math.min(100, Math.round(overall)),
    stages,
    source: 'state'
  };
}

const STAGE_EXPECTED_COUNTS = {
  inception: 8,
  construction: 12,
  operations: 3
};

const STAGE_WEIGHTS = {
  inception: 0.35,
  construction: 0.50,
  operations: 0.15
};

function computeProgress(counts) {
  const stages = {};
  let overall = 0;

  for (const stage of ['inception', 'construction', 'operations']) {
    const expected = STAGE_EXPECTED_COUNTS[stage];
    const actual = counts[stage] || 0;
    const pct = Math.min(100, Math.round((actual / expected) * 100));
    stages[stage] = { pct, count: actual, expected };
    overall += pct * STAGE_WEIGHTS[stage];
  }

  return {
    overall: Math.min(100, Math.round(overall)),
    stages
  };
}

function buildProgressTooltip(summary) {
  const journey = summary.journey;
  if (!journey || !Array.isArray(journey.checkpoints)) {
    return new vscode.MarkdownString('**AI-DLC Progress**\n\nNo artifacts detected yet.');
  }

  const MARK = { done: '●', active: '◐', pending: '○', skipped: '⌁' };
  const lines = ['**AI-DLC Progress**', '', '_Derived from the artifact tree, not from file contents._', ''];

  let lastPhase;
  for (const cp of journey.checkpoints) {
    if (cp.phase !== lastPhase) {
      lines.push(`**${capitalize(cp.phase)}**`);
      lastPhase = cp.phase;
    }
    const units =
      cp.unitProgress && cp.unitProgress.total > 1 ? ` (${cp.unitProgress.done}/${cp.unitProgress.total})` : '';
    const isCurrent = journey.checkpoints.indexOf(cp) === journey.currentIndex;
    lines.push(`${MARK[cp.status] || '·'} ${isCurrent ? `**${cp.label}**` : cp.label}${units}`);
  }

  lines.push('', `**Reached**: ${formatJourneyCounts(journey)}`);
  if (journey.units.length) {
    lines.push(`**Units**: ${journey.units.join(', ')}`);
  }
  if (journey.unattributed.length) {
    lines.push('', `⚠ ${journey.unattributed.length} artifact(s) not mapped to a stage`);
  }

  const md = new vscode.MarkdownString(lines.join('\n'));
  md.isTrusted = false;
  return md;
}

// The phase of the furthest checkpoint with evidence, for a v2 project only.
//
// Gating on the generation rather than on "does the journey say anything" matters:
// a v1 journey answers too. A first attempt keyed on the journey alone and changed
// what a v1 project shows in its label, description and tooltip, which is exactly
// the regression this whole layer is built to avoid. v1 keeps its artifact-count
// summary; only v2, which has no artifacts under those directories to count, falls
// back to the journey.
function currentPhaseFromJourney(summary) {
  if (!summary || summary.generation !== 'v2') return undefined;
  const journey = summary.journey;
  if (!journey || !Array.isArray(journey.checkpoints)) return undefined;
  const index = journey.currentIndex;
  if (typeof index !== 'number' || index < 0 || index >= journey.checkpoints.length) {
    return undefined;
  }
  return journey.checkpoints[index].phase;
}

function formatStageLabel(summary) {
  // v2 has no aidlc-docs/ to count artifacts in, so the v1 detection returns
  // 'unknown' and every count is zero. The journey has already been resolved
  // through the adapter by this point, so the phase of the furthest reached
  // checkpoint is both available and more accurate than the artifact heuristic
  // ever was.
  const fromJourney = currentPhaseFromJourney(summary);
  if (fromJourney) return capitalize(fromJourney);
  if (summary.currentStage === 'unknown') {
    return 'Unknown';
  }
  return capitalize(summary.currentStage);
}

function formatStageDescription(summary) {
  const parts = [];
  if (summary.counts.inception > 0) {
    parts.push(`I ${summary.counts.inception}`);
  }
  if (summary.counts.construction > 0) {
    parts.push(`C ${summary.counts.construction}`);
  }
  if (summary.counts.operations > 0) {
    parts.push(`O ${summary.counts.operations}`);
  }
  if (parts.length > 0) return parts.join(' • ');
  // A v2 project has no artifacts under the v1 stage directories, so the counts
  // above are all zero and "No stage files detected" would be a false negative on
  // a project that is plainly running. A v1 project with no artifacts genuinely
  // has none, and keeps the original wording.
  if (currentPhaseFromJourney(summary)) {
    const journey = summary.journey;
    const done = journey.counts ? journey.counts.done : 0;
    return `${done}/${journey.plannedTotal} stages`;
  }
  return 'No stage files detected';
}

function buildStageTooltip(summary) {
  const phase = currentPhaseFromJourney(summary);
  if (phase) {
    // A v2 project. The v1 artifact counts below would all read zero, which says
    // nothing true, so the journey's own numbers are reported instead.
    const journey = summary.journey;
    const at = journey.checkpoints[journey.currentIndex];
    const lines = [
      `Phase: ${capitalize(phase)}`,
      `Furthest stage reached: ${at.label} (${at.status})`,
      `In scope: ${journey.counts.done}/${journey.plannedTotal} done`
    ];
    if (journey.counts.skipped > 0) {
      // Wording matched to the strip and the phase rows. "Skipped" would claim the
      // run went past these, and this branch is v2-only where that is never what
      // the count means.
      lines.push(`Not in this scope: ${journey.counts.skipped}`);
    }
    if (journey.units.length > 0) {
      lines.push(`Units of work: ${journey.units.join(', ')}`);
    }
    return lines.join('\n');
  }
  return [
    `Detected stage: ${summary.currentStage === 'unknown' ? 'unknown' : capitalize(summary.currentStage)}`,
    `Inception files: ${summary.counts.inception}`,
    `Construction files: ${summary.counts.construction}`,
    `Operations files: ${summary.counts.operations}`,
    summary.latestFile ? `Latest stage file: ${summary.latestFile.fsPath}` : 'No stage file detected yet'
  ]
    .filter(Boolean)
    .join('\n');
}

function getStageIcon(stage) {
  if (stage === 'inception') {
    return 'compass';
  }
  if (stage === 'construction') {
    return 'tools';
  }
  if (stage === 'operations') {
    return 'pulse';
  }
  // v2 names two of its five phases differently, and a project can compile a
  // phase list this build has never seen. The two that map onto an existing idea
  // reuse its icon; anything else keeps the question mark, which is honest.
  if (stage === 'ideation') {
    return 'lightbulb';
  }
  if (stage === 'initialization') {
    return 'rocket';
  }
  if (stage === 'operation') {
    return 'pulse';
  }
  return 'question';
}

function getStageColor(stage) {
  if (stage === 'inception') {
    return new vscode.ThemeColor('charts.blue');
  }
  if (stage === 'construction') {
    return new vscode.ThemeColor('charts.purple');
  }
  if (stage === 'operations') {
    return new vscode.ThemeColor('charts.green');
  }
  // v2 names two of its five phases differently, and a project can compile a
  // phase list this extension has never seen. Rather than leaving those grey,
  // the two that map cleanly onto an existing tone reuse it, and anything else
  // falls through to no colour -- which is honest, and never wrong.
  if (stage === 'ideation') {
    return new vscode.ThemeColor('charts.blue');
  }
  if (stage === 'operation') {
    return new vscode.ThemeColor('charts.green');
  }
  return undefined;
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function getItemSortRank(item) {
  if (item.contextValue === 'stageSummary') {
    return -2;
  }
  if (item.contextValue === 'progress') {
    return -1;
  }

  if (item.type === 'directory') {
    const stageOrder = getStageDirectoryOrder(item.resourceUri);
    if (stageOrder !== undefined) {
      return stageOrder;
    }
    return 10;
  }

  return 20;
}

function getStageDirectoryOrder(resourceUri) {
  if (!resourceUri) {
    return undefined;
  }

  const name = path.basename(resourceUri.fsPath).toLowerCase();
  if (name === 'inception') {
    return 0;
  }
  if (name === 'construction') {
    return 1;
  }
  if (name === 'operations') {
    return 2;
  }
  return undefined;
}

function getFileVisualState(resourceUri, openedFiles, knownFiles, newFiles) {
  const key = resourceUri.toString();
  return {
    isNew: newFiles.has(key),
    isRead: openedFiles.has(key),
    isKnown: knownFiles.has(key)
  };
}

function getDirectoryVisualState(resourceUri, openedFiles, knownFiles, newFiles) {
  const prefix = ensureTrailingSlash(resourceUri.toString());
  let newCount = 0;
  let readCount = 0;
  for (const key of knownFiles) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    if (newFiles.has(key)) {
      newCount += 1;
    } else if (openedFiles.has(key)) {
      readCount += 1;
    }
  }

  return {
    hasNew: newCount > 0,
    newCount,
    readCount
  };
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

// Paths that carry v2's evidence, and which the tree does not show.
//
// v2 keeps everything the panel and the strip read inside dot-directories: the
// compiled graphs and runtime state under `.kiro/tools/data/`, and each sensor's
// findings under `.aidlc-sensors/` beside the artifacts they judge. The tree is right
// not to render those, but the reader depends on them, so an event there has to
// refresh even though nothing in the tree will change.
//
// Reported as "the agent said the sensors fired and re-ran, and the panel showed the
// same thing". It did, because these events were being dropped and nothing asked the
// reader to look again.
//
// Matched on a path segment rather than on a full path, so a layout that moves within
// the project still works, and expressed as a positive list so a new dot-directory
// upstream invents is ignored by default rather than silently steering refreshes.
const WATCHED_DOT_DIRS = new Set(['.kiro', '.aidlc-sensors']);

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage',
  '.git', '.svn', '.hg', '.vscode', '.idea',
  '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj'
]);

function shouldSkipDirectory(name) {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

// Watcher events under skipped directories (.git, node_modules, ...) would only
// trigger refreshes for paths the tree never shows, so drop them early. Uses the
// same shouldSkipDirectory() rules as tree rendering to stay consistent.
function isIgnoredEventPath(rootUri, uri) {
  const rel = path.relative(rootUri.fsPath, uri.fsPath);
  if (!rel || rel.startsWith('..')) {
    return false; // the watched root itself, or outside it — never ignore
  }
  // Only intermediate directory segments decide skipping. The last segment is
  // the file/dir the event is about — never filtered here, so events the tree
  // previously reacted to still trigger a refresh exactly as before.
  const parentSegments = rel.split(path.sep).slice(0, -1);
  // An event inside a directory v2 keeps its evidence in must refresh, even though
  // the tree will not render it. Checked before the skip rules, because these are
  // dot-directories and would otherwise be dropped by them.
  if (parentSegments.some((segment) => WATCHED_DOT_DIRS.has(segment))) {
    return false;
  }
  return parentSegments.some((segment) => shouldSkipDirectory(segment));
}

async function collectMarkdownFiles(rootUri) {
  const results = [];

  async function walk(currentUri) {
    const entries = await vscode.workspace.fs.readDirectory(currentUri);
    for (const [name, fileType] of entries) {
      if (fileType === vscode.FileType.Directory) {
        if (shouldSkipDirectory(name)) {
          continue;
        }
        await walk(vscode.Uri.joinPath(currentUri, name));
        continue;
      }

      if (fileType === vscode.FileType.File && name.toLowerCase().endsWith('.md')) {
        results.push(vscode.Uri.joinPath(currentUri, name));
      }
    }
  }

  await walk(rootUri);
  return results;
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function getWebviewHtml(webview, fileUri, markdown, extensionUri, journey) {
  const safeInitialValue = JSON.stringify(markdown);
  const safeJourney = JSON.stringify(journey || null);
  const title = escapeHtml(fileUri.fsPath);
  const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'mermaid.min.js'));
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: var(--vscode-editor-background);
        --panel: var(--vscode-sideBar-background);
        --border: var(--vscode-panel-border);
        --text: var(--vscode-editor-foreground);
        --muted: var(--vscode-descriptionForeground);
        --accent: var(--vscode-button-background);
        --accent-text: var(--vscode-button-foreground);
      }

      body {
        margin: 0;
        color: var(--text);
        background: linear-gradient(180deg, color-mix(in srgb, var(--bg) 92%, #8fb8ff 8%), var(--bg));
        font-family: var(--vscode-font-family);
        /* Column layout so the journey strip can sit above the split panes and
           the panes take the remaining height. */
        display: flex;
        flex-direction: column;
        height: 100vh;
      }

      .shell {
        display: grid;
        grid-template-columns: var(--split-left, 33%) 6px 1fr;
        flex: 1 1 auto;
        min-height: 0;
      }

      /* ---------- AI-DLC journey strip ----------
         Purple is the product's tone and the existing colour for the Construction
         phase (charts.purple, see getStageColor / StageDecorationProvider). Green is
         deliberately NOT used for progress: charts.green already means "unread NEW
         artifact" in the tree, so reusing it here would collide semantically.

         The band sits slightly lighter than the editor so the unfilled track and the
         hatched skipped segments are visible in a dark theme.

         The rail is continuous: every stage is a filled segment, so nothing can look
         like a missing tooth. Segments are 10px tall with a 9px floor so the hatch
         pattern on a skipped stage actually reads at realistic panel widths. */
      .journey {
        flex: none;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px 12px;
        border-bottom: 1px solid var(--border);
        background: color-mix(in srgb, var(--bg) 86%, var(--text) 14%);
        font-size: 11px;
        cursor: pointer;
        user-select: none;
        overflow: hidden;
      }
      .journey[hidden] { display: none; }
      .journey:hover { background: color-mix(in srgb, var(--bg) 80%, var(--text) 20%); }
      /* Plain focus drew a full-width browser outline around the whole band. */
      .journey:focus { outline: none; }
      .journey:focus-visible {
        outline: 1px solid var(--vscode-charts-purple, #b180d7);
        outline-offset: -2px;
      }

      .j-now { flex: none; font-weight: 600; color: var(--text); white-space: nowrap; }
      .j-now::before { content: '▸ '; color: var(--muted); }

      .j-rail {
        flex: 1 1 auto;
        min-width: 60px;
        display: flex;
        gap: 1px;
        align-items: center;
      }
      .j-rail .j-gap { flex: none; width: 6px; }
      .j-seg {
        height: 10px;
        border-radius: 2px;
        flex: 1 1 auto;
        min-width: 9px;
        background: color-mix(in srgb, var(--text) 16%, transparent);
      }
      .j-seg.done { background: var(--vscode-charts-purple, #b180d7); }
      .j-seg.active {
        background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 55%, transparent);
      }
      .j-seg.skipped {
        background: repeating-linear-gradient(
          125deg,
          color-mix(in srgb, var(--text) 34%, transparent) 0 2px,
          transparent 2px 5px
        );
      }
      .j-seg.current {
        background: var(--vscode-charts-purple, #b180d7);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 40%, transparent);
      }

      .j-frac { flex: none; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .j-chevron { flex: none; color: var(--muted); font-size: 10px; }

      /* ---------- expanded ----------
         Two-column grid so the phase label column stays put when the stage list
         wraps. A flex row lost the label on every wrapped line. */
      .journey.expanded { display: block; padding: 8px 12px 10px; }
      .j-expanded { display: none; }
      .journey.expanded .j-expanded { display: block; }
      .journey.expanded .j-collapsed { margin-bottom: 9px; }
      .j-collapsed { display: flex; align-items: center; gap: 12px; }

      .j-grid {
        display: grid;
        grid-template-columns: 92px 1fr;
        gap: 4px 10px;
        align-items: start;
      }
      .j-gname {
        font-size: 9px;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--muted);
        padding-top: 3px;
      }
      .j-cell { display: flex; flex-wrap: wrap; gap: 3px 12px; }

      /* Two signals per stage: a mark and a name. No numbers, no repeated DONE. */
      .j-item { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 11px; }
      .j-mark {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: none;
        background: var(--vscode-charts-purple, #b180d7);
      }
      .j-item.active .j-mark {
        background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 55%, transparent);
      }
      .j-item.pending .j-mark { background: color-mix(in srgb, var(--text) 22%, transparent); }
      /* A square swatch, not a dot: a hatch pattern is unreadable inside 8px of circle. */
      .j-item.skipped .j-mark {
        width: 14px;
        height: 8px;
        border-radius: 2px;
        background: repeating-linear-gradient(
          125deg,
          color-mix(in srgb, var(--text) 38%, transparent) 0 2px,
          transparent 2px 5px
        );
      }
      .j-item.skipped .j-label,
      .j-item.pending .j-label { color: var(--muted); }
      .j-item.current .j-label { font-weight: 700; }
      .j-tag { font-size: 9px; color: var(--muted); opacity: 0.85; }

      .j-legend { margin-top: 7px; color: var(--muted); font-size: 10px; }
      .j-warn { color: var(--vscode-charts-yellow, #e5c07b); }

      @media (prefers-reduced-motion: reduce) {
        .journey, .j-seg, .j-item { transition: none; }
      }

      .pane {
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .pane.raw {
        background: color-mix(in srgb, var(--bg) 86%, #000 14%);
      }

      .pane.preview-pane {
        background: color-mix(in srgb, var(--bg) 96%, #fff 4%);
      }

      .splitter {
        cursor: col-resize;
        background: var(--vscode-focusBorder, #569cd6);
        position: relative;
        user-select: none;
        transition: background 120ms ease;
      }

      .splitter::before {
        content: '';
        position: absolute;
        left: -4px;
        right: -4px;
        top: 0;
        bottom: 0;
      }

      .splitter::after {
        content: '';
        position: absolute;
        left: 50%;
        top: 50%;
        width: 2px;
        height: 40px;
        transform: translate(-50%, -50%);
        background: color-mix(in srgb, var(--bg) 40%, #fff 60%);
        border-radius: 2px;
        opacity: 0.7;
      }

      .splitter:hover,
      .splitter.dragging {
        background: color-mix(in srgb, var(--vscode-focusBorder, #569cd6) 80%, #fff 20%);
      }

      body.dragging {
        cursor: col-resize;
      }
      body.dragging * {
        user-select: none !important;
        pointer-events: none !important;
      }
      body.dragging .splitter {
        pointer-events: auto !important;
      }

      .header {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        border-bottom: 1px solid var(--border);
        background: color-mix(in srgb, var(--panel) 88%, transparent);
      }

      .title {
        font-size: 12px;
        color: var(--muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .actions {
        display: flex;
        gap: 8px;
        opacity: 0;
        pointer-events: none;
        transform: translateY(-2px);
        transition: opacity 140ms ease, transform 140ms ease;
      }

      .actions.visible {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
      }

      button {
        border: 0;
        padding: 7px 12px;
        border-radius: 8px;
        background: var(--accent);
        color: var(--accent-text);
        cursor: pointer;
      }

      button.secondary {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--border);
      }

      textarea {
        flex: 1;
        width: 100%;
        resize: none;
        border: 0;
        outline: none;
        padding: 16px;
        box-sizing: border-box;
        color: var(--text);
        background: transparent;
        font: 13px/1.6 var(--vscode-editor-font-family);
      }

      .preview-scroll {
        flex: 1;
        overflow: auto;
        position: relative;
      }

      .preview {
        padding: 20px;
        line-height: 1.65;
        transform-origin: 0 0;
        transition: transform 60ms ease-out;
        width: 100%;
        box-sizing: border-box;
      }

      .zoom-controls {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-left: auto;
      }

      .zoom-btn {
        width: 26px;
        height: 26px;
        padding: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--text);
        border: 1px solid var(--border);
        font-size: 14px;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }

      .zoom-btn:hover {
        background: color-mix(in srgb, var(--text) 10%, transparent);
      }

      .zoom-level {
        min-width: 44px;
        text-align: center;
        font-size: 11px;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 4px;
      }

      .zoom-level:hover {
        background: color-mix(in srgb, var(--text) 8%, transparent);
      }

      /* ========== Prettier Markdown Viewer ========== */
      .preview {
        font-family: -apple-system, "Segoe UI", "Pretendard", "Noto Sans KR", sans-serif;
        font-size: 14.5px;
        color: var(--text);
      }

      .preview > *:first-child { margin-top: 0; }
      .preview > *:last-child { margin-bottom: 0; }

      .preview h1, .preview h2, .preview h3,
      .preview h4, .preview h5, .preview h6 {
        line-height: 1.25;
        font-weight: 700;
        margin: 1.4em 0 0.6em;
        letter-spacing: -0.01em;
      }

      .preview h1 {
        font-size: 2em;
        color: #e06c75;
        border-bottom: 3px solid color-mix(in srgb, #e06c75 45%, transparent);
        padding-bottom: 0.3em;
        margin-top: 0.2em;
      }
      .preview h2 {
        font-size: 1.55em;
        color: #61afef;
        border-bottom: 2px solid color-mix(in srgb, #61afef 35%, transparent);
        padding-bottom: 0.25em;
      }
      .preview h3 {
        font-size: 1.28em;
        color: #c678dd;
      }
      .preview h3::before {
        content: '▸ ';
        color: color-mix(in srgb, #c678dd 70%, transparent);
      }
      .preview h4 {
        font-size: 1.1em;
        color: #d19a66;
      }
      .preview h5 {
        font-size: 1em;
        color: #98c379;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .preview h6 {
        font-size: 0.92em;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .preview p {
        margin: 0.7em 0;
      }

      .preview strong {
        color: #e5c07b;
        font-weight: 700;
      }
      .preview em {
        color: #56b6c2;
        font-style: italic;
      }

      .preview a {
        color: #61afef;
        text-decoration: none;
        border-bottom: 1px dashed color-mix(in srgb, #61afef 50%, transparent);
      }
      .preview a:hover {
        border-bottom-style: solid;
      }

      .preview ul, .preview ol {
        padding-left: 1.6em;
        margin: 0.6em 0;
      }
      .preview li {
        margin: 0.28em 0;
      }
      .preview ul > li::marker {
        color: #98c379;
      }
      .preview ol > li::marker {
        color: #d19a66;
        font-weight: 600;
      }

      .preview hr {
        border: 0;
        border-top: 2px dashed color-mix(in srgb, var(--border) 80%, #888 20%);
        margin: 2em 0;
      }

      .preview pre {
        overflow: auto;
        padding: 14px 16px;
        border-radius: 8px;
        background: color-mix(in srgb, var(--panel) 78%, #000 22%);
        border-left: 3px solid #98c379;
        font-size: 0.92em;
        line-height: 1.55;
        margin: 1em 0;
      }
      .preview pre code {
        background: transparent;
        padding: 0;
        color: color-mix(in srgb, var(--text) 92%, transparent);
      }

      .preview code {
        font-family: var(--vscode-editor-font-family, "SF Mono", Menlo, Consolas, monospace);
        background: color-mix(in srgb, var(--panel) 60%, #000 40%);
        color: #e06c75;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 0.88em;
        border: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
      }

      .preview blockquote {
        margin: 1em 0;
        padding: 8px 14px;
        border-left: 4px solid #c678dd;
        background: color-mix(in srgb, #c678dd 8%, transparent);
        color: color-mix(in srgb, var(--text) 88%, var(--muted) 12%);
        border-radius: 0 6px 6px 0;
      }
      .preview blockquote p { margin: 0.3em 0; }

      .preview table {
        border-collapse: collapse;
        width: 100%;
        margin: 1em 0;
        font-size: 0.94em;
      }
      .preview table th,
      .preview table td {
        border: 1px solid var(--border);
        padding: 8px 12px;
        text-align: left;
      }
      .preview table th {
        background: color-mix(in srgb, #61afef 15%, transparent);
        color: #61afef;
        font-weight: 600;
      }
      .preview table tr:nth-child(even) td {
        background: color-mix(in srgb, var(--panel) 40%, transparent);
      }

      .preview img { max-width: 100%; border-radius: 6px; }

      .preview pre.mermaid {
        background: transparent;
        border-left: none;
        padding: 8px 0;
        text-align: center;
      }
      .mermaid-rendered {
        display: flex;
        justify-content: center;
        padding: 16px 0;
        overflow-x: auto;
      }
      .mermaid-rendered svg {
        max-width: 100%;
        height: auto;
      }
      .mermaid-error {
        border-left-color: #e06c75 !important;
        color: #e06c75;
      }

      /* Task list checkboxes */
      .preview input[type="checkbox"] {
        accent-color: #98c379;
        margin-right: 6px;
      }

      .status {
        font-size: 12px;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <div class="journey" id="journey" role="group" aria-label="AI-DLC journey" tabindex="0" hidden>
      <div class="j-collapsed" id="jCollapsed"></div>
      <div class="j-expanded" id="jExpanded"></div>
    </div>
    <div class="shell">
      <section class="pane raw">
        <div class="header">
          <div class="title">${title}</div>
          <div class="actions">
            <button class="secondary" id="reload">Reload</button>
            <button id="save">Save</button>
          </div>
        </div>
        <textarea id="editor" spellcheck="false"></textarea>
      </section>
      <div class="splitter" id="splitter" role="separator" aria-orientation="vertical" title="Drag to resize"></div>
      <section class="pane preview-pane">
        <div class="header">
          <div class="title">Preview</div>
          <div class="zoom-controls">
            <button class="zoom-btn" id="zoomOut" title="Zoom out (Ctrl/Cmd + -)">−</button>
            <span class="zoom-level" id="zoomLevel" title="Click to reset (Ctrl/Cmd + 0)">100%</span>
            <button class="zoom-btn" id="zoomIn" title="Zoom in (Ctrl/Cmd + +)">+</button>
          </div>
          <div class="status" id="status">Ready</div>
        </div>
        <div class="preview-scroll" id="previewScroll">
          <div id="preview" class="preview"></div>
        </div>
      </section>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const initialValue = ${safeInitialValue};
      const editor = document.getElementById('editor');
      const preview = document.getElementById('preview');
      const status = document.getElementById('status');
      const actions = document.querySelector('.actions');

      const savedState = vscode.getState() || {};
      const restoredText = savedState.editorText;
      let cleanValue = initialValue;

      if (restoredText !== undefined && restoredText !== initialValue) {
        editor.value = restoredText;
        renderMarkdown(restoredText);
        status.textContent = 'Unsaved changes (restored)';
      } else {
        editor.value = initialValue;
        renderMarkdown(initialValue);
      }
      syncActionVisibility();

      let renderTimer;
      function scheduleRender(text) {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => renderMarkdown(text), 120);
      }

      // ---------- AI-DLC journey strip ----------
      // Collapsed by default: the current stage name, then a continuous rail of one
      // tick per checkpoint with a wider gap at each phase boundary. Click to expand
      // into phase groups of chips that WRAP, so the strip never runs off the panel.
      //
      // Only the furthest reached checkpoint is highlighted. The checkpoint of the
      // file being viewed is available in journey.openIndex but is deliberately not
      // rendered: it competed with the position marker for attention.
      //
      // Status is spelled out as a word in the expanded view rather than encoded in
      // colour alone, so skipped and pending stay distinguishable in any theme.
      let journey = ${safeJourney};
      const journeyEl = document.getElementById('journey');
      const jCollapsedEl = document.getElementById('jCollapsed');
      const jExpandedEl = document.getElementById('jExpanded');
      const PHASE_LABEL = { setup: 'Setup', inception: 'Inception', construction: 'Construction', operations: 'Operations' };
      const STATE_LABEL = { done: 'done', active: 'in progress', pending: 'not started', skipped: 'skipped' };

      function statusClass(cp, index) {
        return index === journey.currentIndex ? cp.status + ' current' : cp.status;
      }

      function tooltipFor(cp, index) {
        // Three reasons a stage has not happened, and the status alone tells them
        // apart for only one of them. EXECUTE in the scope grid means eligible
        // rather than certain, so a conditional stage in scope may still not run.
        const state = cp.outOfScope
          ? 'not in scope'
          : cp.status === 'pending' && cp.mayNotRun
            ? 'runs only if needed'
            : (STATE_LABEL[cp.status] || cp.status);
        const bits = [(index + 1) + '. ' + cp.label, state];
        bits.push(PHASE_LABEL[cp.phase] || cp.phase);
        if (cp.unitProgress && cp.unitProgress.total > 0) {
          bits.push(cp.unitProgress.done + '/' + cp.unitProgress.total + ' units');
        }
        if (cp.planned) bits.push('plan recorded');
        if (cp.placeholder) bits.push('placeholder in AI-DLC v1: the workflow ends after Build and test');
        if (index === journey.currentIndex) bits.push('furthest reached');
        return bits.join(' — ');
      }

      function phaseGroups() {
        const groups = [];
        let last;
        journey.checkpoints.forEach((cp, i) => {
          if (!last || last.phase !== cp.phase) {
            last = { phase: cp.phase, items: [] };
            groups.push(last);
          }
          last.items.push({ cp: cp, i: i });
        });
        return groups;
      }

      function renderCollapsed() {
        const frag = document.createDocumentFragment();

        const now = document.createElement('span');
        now.className = 'j-now';
        const cur = journey.checkpoints[journey.currentIndex];
        now.textContent = cur ? cur.label : 'Not started';
        now.title = cur ? tooltipFor(cur, journey.currentIndex) : '';
        frag.appendChild(now);

        const rail = document.createElement('span');
        rail.className = 'j-rail';
        phaseGroups().forEach((group, gi) => {
          if (gi > 0) {
            const gap = document.createElement('span');
            gap.className = 'j-gap';
            rail.appendChild(gap);
          }
          for (const entry of group.items) {
            const seg = document.createElement('span');
            seg.className = 'j-seg ' + statusClass(entry.cp, entry.i);
            seg.title = tooltipFor(entry.cp, entry.i);
            rail.appendChild(seg);
          }
        });
        frag.appendChild(rail);

        // The denominator comes from the model: skipped stages and the unreached
        // Operations placeholder are not work left to do.
        const c = journey.counts || {};
        const frac = document.createElement('span');
        frac.className = 'j-frac';
        frac.textContent = (c.done || 0) + '/' + journey.plannedTotal;
        frac.title = (c.done || 0) + ' done · ' + (c.active || 0) + ' in progress · ' +
          (c.pending || 0) + ' not started · ' + (c.skipped || 0) + ' skipped';
        frag.appendChild(frac);

        const chevron = document.createElement('span');
        chevron.className = 'j-chevron';
        chevron.textContent = journeyEl.classList.contains('expanded') ? '⌃' : '⌄';
        frag.appendChild(chevron);

        jCollapsedEl.replaceChildren(frag);
      }

      function renderExpanded() {
        const frag = document.createDocumentFragment();

        const grid = document.createElement('div');
        grid.className = 'j-grid';

        for (const group of phaseGroups()) {
          const name = document.createElement('div');
          name.className = 'j-gname';
          name.textContent = PHASE_LABEL[group.phase] || group.phase;
          grid.appendChild(name);

          const cell = document.createElement('div');
          cell.className = 'j-cell';
          for (const entry of group.items) {
            const item = document.createElement('span');
            item.className = 'j-item ' + statusClass(entry.cp, entry.i);
            item.title = tooltipFor(entry.cp, entry.i);

            const mark = document.createElement('i');
            mark.className = 'j-mark';
            item.appendChild(mark);

            const label = document.createElement('span');
            label.className = 'j-label';
            label.textContent = entry.cp.label;
            item.appendChild(label);

            // A tag only where the state is not obvious from the mark alone.
            //
            // Three different reasons a stage has not happened, and they were
            // collapsing into two words. Reported on a greenfield project where
            // Reverse Engineering read "not started", which promises it will run:
            //
            //   not in scope   the scope never included it, so it will not run
            //   if needed      the scope included it, but the stage declares
            //                  itself conditional, so whether it runs depends on
            //                  the project -- Reverse Engineering does not run
            //                  with no existing code to read
            //   not started    the scope included it and it always runs, so it is
            //                  waiting its turn
            //
            // The engine states all three. EXECUTE in the scope grid means
            // eligible, not certain, and the stage graph is what says which.
            let tag = '';
            if (entry.cp.placeholder && entry.cp.status !== 'done') tag = 'placeholder';
            else if (entry.cp.outOfScope) tag = 'not in scope';
            else if (entry.cp.status === 'skipped') tag = 'skipped';
            else if (entry.cp.status === 'pending') {
              tag = entry.cp.mayNotRun ? 'if needed' : 'not started';
            }
            else if (entry.cp.unitProgress && entry.cp.unitProgress.total > 1) {
              tag = entry.cp.unitProgress.done + '/' + entry.cp.unitProgress.total;
            }
            if (tag) {
              const tagEl = document.createElement('span');
              tagEl.className = 'j-tag';
              tagEl.textContent = tag;
              item.appendChild(tagEl);
            }

            cell.appendChild(item);
          }
          grid.appendChild(cell);
        }
        frag.appendChild(grid);

        if (journey.units && journey.units.length) {
          const legend = document.createElement('div');
          legend.className = 'j-legend';
          legend.textContent =
            journey.units.length + ' unit' + (journey.units.length === 1 ? '' : 's') + ' · ' + journey.units.join(', ');
          frag.appendChild(legend);
        }

        if (journey.unattributed && journey.unattributed.length) {
          const warn = document.createElement('div');
          warn.className = 'j-legend j-warn';
          warn.textContent =
            journey.unattributed.length +
            ' artifact' + (journey.unattributed.length === 1 ? '' : 's') +
            ' could not be mapped to a stage: ' + journey.unattributed.join(', ');
          frag.appendChild(warn);
        }

        jExpandedEl.replaceChildren(frag);
      }

      function renderJourney() {
        const usable = journey && Array.isArray(journey.checkpoints) && journey.checkpoints.length > 0;
        journeyEl.hidden = !usable;
        if (!usable) return;
        renderCollapsed();
        if (journeyEl.classList.contains('expanded')) renderExpanded();
      }

      function renderJourney() {
        const usable = journey && Array.isArray(journey.checkpoints) && journey.checkpoints.length > 0;
        journeyEl.hidden = !usable;
        if (!usable) return;
        renderCollapsed();
        if (journeyEl.classList.contains('expanded')) renderExpanded();
      }

      function toggleJourney() {
        if (journeyEl.hidden) return;
        journeyEl.classList.toggle('expanded');
        journeyEl.setAttribute('aria-expanded', journeyEl.classList.contains('expanded') ? 'true' : 'false');
        renderJourney();
      }

      journeyEl.addEventListener('click', toggleJourney);
      journeyEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleJourney();
        }
      });
      renderJourney();

      editor.addEventListener('input', () => {
        scheduleRender(editor.value);
        status.textContent = isDirty() ? 'Unsaved changes' : 'Ready';
        syncActionVisibility();
        vscode.setState(Object.assign({}, vscode.getState() || {}, { editorText: editor.value }));
      });

      // Handle incremental content updates from extension host
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'setJourney') {
          journey = msg.journey || null;
          renderJourney();
          return;
        }
        if (msg.type === 'setContent') {
          const incoming = msg.content || '';
          if (incoming === editor.value) return;
          cleanValue = incoming;
          editor.value = incoming;
          renderMarkdown(incoming);
          status.textContent = 'Ready';
          syncActionVisibility(false);
          const s = vscode.getState() || {};
          delete s.editorText;
          vscode.setState(s);
        }
      });

      function saveNow() {
        vscode.postMessage({
          type: 'save',
          content: editor.value
        });
        cleanValue = editor.value;
        status.textContent = 'Saved';
        syncActionVisibility(false);
        const s = vscode.getState() || {};
        delete s.editorText;
        vscode.setState(s);
      }

      document.getElementById('save').addEventListener('click', saveNow);

      // Ctrl/Cmd+S to save from anywhere inside the webview
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
          e.preventDefault();
          saveNow();
        }
      });

      document.getElementById('reload').addEventListener('click', () => {
        vscode.postMessage({ type: 'requestLatest' });
        cleanValue = initialValue;
        status.textContent = 'Ready';
        syncActionVisibility(false);
        const s = vscode.getState() || {};
        delete s.editorText;
        vscode.setState(s);
      });

      // Splitter: drag to resize raw/preview panes
      const splitter = document.getElementById('splitter');
      const shell = document.querySelector('.shell');
      const previousState = (typeof vscode.getState === 'function' ? vscode.getState() : null) || {};
      const savedSplit = typeof previousState.splitPct === 'number' ? previousState.splitPct : 33;
      let splitPct = Math.min(80, Math.max(15, savedSplit));
      shell.style.setProperty('--split-left', splitPct + '%');

      function setSplit(pct) {
        splitPct = Math.min(80, Math.max(15, pct));
        shell.style.setProperty('--split-left', splitPct + '%');
        if (typeof vscode.setState === 'function') {
          vscode.setState(Object.assign({}, vscode.getState() || {}, { splitPct: splitPct }));
        }
      }

      let dragging = false;
      splitter.addEventListener('pointerdown', (e) => {
        dragging = true;
        splitter.classList.add('dragging');
        document.body.classList.add('dragging');
        splitter.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      splitter.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const rect = shell.getBoundingClientRect();
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        setSplit(pct);
      });
      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove('dragging');
        document.body.classList.remove('dragging');
        if (e && e.pointerId !== undefined) {
          try { splitter.releasePointerCapture(e.pointerId); } catch {}
        }
      }
      splitter.addEventListener('pointerup', endDrag);
      splitter.addEventListener('pointercancel', endDrag);
      splitter.addEventListener('dblclick', () => setSplit(33));

      const ZOOM_MIN = 0.5;
      const ZOOM_MAX = 3.0;
      const ZOOM_STEP = 0.1;
      let zoom = 1.0;
      const zoomLevelEl = document.getElementById('zoomLevel');
      const previewScroll = document.getElementById('previewScroll');

      function applyZoom() {
        zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
        preview.style.transform = 'scale(' + zoom + ')';
        preview.style.width = (100 / zoom) + '%';
        zoomLevelEl.textContent = Math.round(zoom * 100) + '%';
      }
      function zoomBy(delta) {
        zoom = Math.round((zoom + delta) * 100) / 100;
        applyZoom();
      }
      function zoomReset() {
        zoom = 1.0;
        applyZoom();
      }

      document.getElementById('zoomIn').addEventListener('click', () => zoomBy(ZOOM_STEP));
      document.getElementById('zoomOut').addEventListener('click', () => zoomBy(-ZOOM_STEP));
      zoomLevelEl.addEventListener('click', zoomReset);

      // Ctrl/Cmd + wheel for zoom (includes trackpad pinch which is reported as wheel+ctrlKey)
      previewScroll.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const direction = e.deltaY < 0 ? 1 : -1;
          const magnitude = Math.min(0.3, Math.abs(e.deltaY) / 300);
          zoomBy(direction * Math.max(ZOOM_STEP * 0.5, magnitude));
        }
      }, { passive: false });

      // Keyboard shortcuts
      window.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(ZOOM_STEP); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(-ZOOM_STEP); }
        else if (e.key === '0') { e.preventDefault(); zoomReset(); }
      });

      // Trackpad pinch gesture (Safari-style gesturechange events on macOS)
      let gestureStartZoom = 1;
      previewScroll.addEventListener('gesturestart', (e) => {
        e.preventDefault();
        gestureStartZoom = zoom;
      });
      previewScroll.addEventListener('gesturechange', (e) => {
        e.preventDefault();
        zoom = gestureStartZoom * e.scale;
        applyZoom();
      });
      previewScroll.addEventListener('gestureend', (e) => e.preventDefault());

      // Bi-directional scroll sync between raw editor and preview
      let syncingFromEditor = false;
      let syncingFromPreview = false;

      function scrollRatio(el) {
        const max = el.scrollHeight - el.clientHeight;
        return max > 0 ? el.scrollTop / max : 0;
      }
      function setScrollRatio(el, ratio) {
        const max = el.scrollHeight - el.clientHeight;
        el.scrollTop = Math.max(0, Math.min(max, ratio * max));
      }

      editor.addEventListener('scroll', () => {
        if (syncingFromPreview) return;
        syncingFromEditor = true;
        setScrollRatio(previewScroll, scrollRatio(editor));
        requestAnimationFrame(() => { syncingFromEditor = false; });
      });

      previewScroll.addEventListener('scroll', () => {
        if (syncingFromEditor) return;
        syncingFromPreview = true;
        setScrollRatio(editor, scrollRatio(previewScroll));
        requestAnimationFrame(() => { syncingFromPreview = false; });
      });


      function renderMarkdown(source) {
        preview.innerHTML = markdownToHtml(source);
      }

      function isDirty() {
        return editor.value !== cleanValue;
      }

      function syncActionVisibility(forceVisible = isDirty()) {
        actions.classList.toggle('visible', forceVisible);
      }

      function markdownToHtml(source) {
        const codeBlocks = [];
        const inlineCodes = [];

        // 1) Extract fenced code blocks first so inner markdown is preserved
        let src = source.replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
          const idx = codeBlocks.length;
          codeBlocks.push({ lang: lang || '', code });
          return '\\u0000CODEBLOCK' + idx + '\\u0000';
        });

        // 2) Extract inline code
        src = src.replace(/\`([^\`\\n]+)\`/g, (_, code) => {
          const idx = inlineCodes.length;
          inlineCodes.push(code);
          return '\\u0000INLINECODE' + idx + '\\u0000';
        });

        // 3) Escape the rest
        let html = escapeHtml(src);

        // 4) Horizontal rule
        html = html.replace(/^\\s*(?:---|\\*\\*\\*|___)\\s*$/gm, '<hr>');

        // 5) Headings H1~H6
        html = html.replace(/^######\\s+(.*)$/gm, '<h6>$1</h6>');
        html = html.replace(/^#####\\s+(.*)$/gm, '<h5>$1</h5>');
        html = html.replace(/^####\\s+(.*)$/gm, '<h4>$1</h4>');
        html = html.replace(/^###\\s+(.*)$/gm, '<h3>$1</h3>');
        html = html.replace(/^##\\s+(.*)$/gm, '<h2>$1</h2>');
        html = html.replace(/^#\\s+(.*)$/gm, '<h1>$1</h1>');

        // 6) Blockquote
        html = html.replace(/^&gt;\\s?(.*)$/gm, '<blockquote>$1</blockquote>');

        // 7) Tables (| a | b | ... with --- divider row)
        html = html.replace(/((?:^\\|.+\\|\\s*\\n)+)/gm, (block) => {
          const lines = block.trim().split('\\n');
          if (lines.length < 2) return block;
          const sep = lines[1];
          if (!/^\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)+\\|?\\s*$/.test(sep)) return block;
          const split = (l) => l.replace(/^\\||\\|$/g, '').split('|').map(s => s.trim());
          const headers = split(lines[0]);
          const rows = lines.slice(2).map(split);
          let out = '<table><thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>';
          for (const row of rows) {
            out += '<tr>' + row.map(c => '<td>' + c + '</td>').join('') + '</tr>';
          }
          out += '</tbody></table>';
          return out + '\\n';
        });

        // 8) Task lists (- [ ] / - [x]) — must run before generic list rule
        html = html.replace(/^(\\s*)[-*]\\s+\\[\\s\\]\\s+(.*)$/gm, '$1<li class="task"><input type="checkbox" disabled> $2</li>');
        html = html.replace(/^(\\s*)[-*]\\s+\\[(x|X)\\]\\s+(.*)$/gm, '$1<li class="task"><input type="checkbox" checked disabled> $3</li>');

        // 9) Ordered & unordered lists
        html = html.replace(/^(\\s*)\\d+\\.\\s+(.*)$/gm, '$1<li data-ol="1">$2</li>');
        html = html.replace(/^(\\s*)[-*+]\\s+(.*)$/gm, '$1<li>$2</li>');

        // Wrap consecutive <li> groups, preferring <ol> when marked
        html = html.replace(/(?:^<li[^>]*>.*(?:\\n|$))+/gm, (block) => {
          const isOl = /data-ol="1"/.test(block);
          const cleaned = block.replace(/ data-ol="1"/g, '');
          return isOl ? '<ol>' + cleaned + '</ol>' : '<ul>' + cleaned + '</ul>';
        });

        // 10) Bold & Italic (bold first to avoid overlap)
        html = html.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
        html = html.replace(/__([^_\\n]+)__/g, '<strong>$1</strong>');
        html = html.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
        html = html.replace(/(^|[^_])_([^_\\n]+)_/g, '$1<em>$2</em>');

        // 11) Strikethrough
        html = html.replace(/~~([^~\\n]+)~~/g, '<del>$1</del>');

        // 12) Links & images  ![alt](url)  [text](url)
        html = html.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g, (_, alt, url) => '<img src="' + sanitizeUrl(url) + '" alt="' + alt + '">');
        html = html.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, (_, text, url) => '<a href="' + sanitizeUrl(url) + '">' + text + '</a>');

        // 13) Autolinks (bare URLs)
        html = html.replace(/(^|[\\s(])(https?:\\/\\/[^\\s<)]+)/g, '$1<a href="$2">$2</a>');

        // 14) Paragraphs: wrap remaining plain lines
        html = html.replace(/^(?!<h\\d|<ul|<ol|<li|<pre|<blockquote|<table|<hr|<img|\\s*$)([^\\n<].*)$/gm, '<p>$1</p>');

        // 15) Restore inline code then fenced code blocks
        html = html.replace(/\\u0000INLINECODE(\\d+)\\u0000/g, (_, i) => {
          return '<code>' + escapeHtml(inlineCodes[+i]) + '</code>';
        });
        html = html.replace(/\\u0000CODEBLOCK(\\d+)\\u0000/g, (_, i) => {
          const block = codeBlocks[+i];
          if (block.lang === 'mermaid') {
            return '<pre class="mermaid">' + block.code.replace(/\\n$/, '') + '</pre>';
          }
          const langClass = block.lang ? ' class="language-' + block.lang + '"' : '';
          return '<pre><code' + langClass + '>' + escapeHtml(block.code.replace(/\\n$/, '')) + '</code></pre>';
        });

        return html;
      }

      function escapeHtml(value) {
        return value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      // Allow only safe link/image destinations; anything else (javascript:,
      // vbscript:, data: pages, ...) renders as inert "#".
      function sanitizeUrl(url) {
        if (/^(https?:|mailto:|#)/i.test(url)) return url;
        if (/^[^:]*$/.test(url)) return url; // relative path, no scheme
        return '#';
      }
    </script>
    <script nonce="${nonce}" src="${mermaidUri}"></script>
    <script nonce="${nonce}">
      // 'antiscript' strips script tags/event handlers but keeps HTML labels
      // (e.g. <br/> in node text) rendering exactly as before — 'strict' would
      // encode those tags and visibly change existing diagrams.
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'antiscript' });
      function renderMermaidBlocks() {
        document.querySelectorAll('pre.mermaid').forEach(async (el, idx) => {
          const code = el.textContent;
          try {
            const { svg } = await mermaid.render('mermaid-' + Date.now() + '-' + idx, code);
            el.outerHTML = '<div class="mermaid-rendered">' + svg + '</div>';
          } catch (e) {
            el.classList.add('mermaid-error');
          }
        });
      }
      const origRender = renderMarkdown;
      renderMarkdown = function(source) {
        origRender(source);
        renderMermaidBlocks();
      };
      renderMermaidBlocks();
    </script>
  </body>
</html>`;
}

function getHelpHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>AI-DLC Viewer Guide</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    line-height: 1.7;
    padding: 32px 48px;
    max-width: 980px;
    margin: 0 auto;
  }
  h1 { font-size: 28px; margin-top: 0; border-bottom: 2px solid var(--vscode-focusBorder, #569cd6); padding-bottom: 8px; }
  h2 { font-size: 22px; margin-top: 32px; color: var(--vscode-textLink-activeForeground, #569cd6); }
  h3 { font-size: 17px; margin-top: 24px; }
  h4 { font-size: 14px; margin-top: 20px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; }
  .stage-card {
    border-left: 4px solid;
    padding: 12px 18px;
    margin: 16px 0;
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-editor-background) 88%, #000 12%);
  }
  .stage-card.inception { border-color: #4a9eff; }
  .stage-card.construction { border-color: #3ddc84; }
  .stage-card.operations { border-color: #f5a623; }
  /* v2's tone throughout the extension. Not green: green marks unread NEW. */
  .stage-card.supervision { border-color: #b180d7; }
  .stage-card h3 { margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 8px 12px; text-align: left; vertical-align: top; }
  th { background: color-mix(in srgb, var(--vscode-editor-background) 80%, #000 20%); font-weight: 600; }
  code { font-family: var(--vscode-editor-font-family); background: color-mix(in srgb, var(--vscode-editor-background) 80%, #000 20%); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre { background: color-mix(in srgb, var(--vscode-editor-background) 80%, #000 20%); padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; line-height: 1.5; }
  ul, ol { padding-left: 26px; }
  li { margin: 4px 0; }
  .callout {
    background: color-mix(in srgb, var(--vscode-editor-background) 85%, #569cd6 15%);
    border-left: 4px solid #569cd6;
    padding: 12px 16px;
    margin: 16px 0;
    border-radius: 4px;
  }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 16px 0; }
  .role-box {
    padding: 14px 18px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--vscode-editor-background) 90%, #000 10%);
    border: 1px solid var(--vscode-panel-border);
  }
  .role-box h4 { margin-top: 0; color: var(--vscode-textLink-activeForeground, #569cd6); letter-spacing: 0; text-transform: none; font-size: 15px; }
  hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 32px 0; }
</style>
</head>
<body>
<h1>AI-DLC Viewer Guide</h1>
<p>AI-DLC Viewer watches your <strong>AI-DLC workflow folder</strong>, visualizes stage progress, and lets you read and edit the generated Markdown artifacts — all inside VS Code.</p>

<div class="callout">
  <strong>Two generations of AI-DLC.</strong> <strong>v1</strong> is rule files your agent reads, with artifacts under <code>aidlc-docs/</code>. <strong>v2</strong> is an engine that drives the workflow itself, with enforced gates and an audit ledger. The viewer detects which one a project uses and shows the matching view — everything below about the tree, the strip and the editor applies to both. Only the <em>Supervision</em> section is v2-specific.
</div>

<h2>Getting Started</h2>
<ol>
  <li>Click <strong>Open Workspace</strong> (folder icon) in the VIEWER panel toolbar and select your AI-DLC project root.</li>
  <li>Optionally click <strong>Set up AI-DLC</strong> (cloud icon). It <strong>asks which generation</strong> you want. v1 is copied from a snapshot bundled with this extension, so it needs no network. v2 is downloaded from the current head of the upstream repository's v2 branch, with the commit it resolved to written into the install receipt so the project can say which engine it has. It needs <a href="https://bun.com/docs/installation">bun</a> — if bun is missing, setup stops and hands you the install command rather than leaving you a project whose gates never fire.</li>
  <li>Start your agent and say <code>"Using AI-DLC, ..."</code> — new artifacts appear in the tree automatically as they are generated.</li>
</ol>

<h2>Key Features</h2>

<div class="stage-card inception">
  <h3>📊 Journey &amp; Stage Tracking</h3>
  <p>The top of the tree names the <strong>furthest stage reached</strong> and how many stages are done, for example <code>Build and test</code> · <code>9/9</code>. Expand it for the same figure per phase.</p>
  <p>Opening a <code>.md</code> artifact also shows an <strong>AI-DLC journey strip</strong> across the top of the viewer, so the position stays visible while you read. Click the strip to expand it into the full stage list.</p>
  <ul>
    <li>Everything is derived from <strong>structure, not prose</strong>. In v1 that means which folders exist under <code>aidlc-docs/</code> plus the plan files under <code>plans/</code>; in v2 it means the engine's own compiled graph and runtime record. No file contents are parsed either way, so a state file in an unexpected format cannot make the position wrong.</li>
    <li><strong>There is no percentage.</strong> AI-DLC is adaptive: most stages are conditional, and Construction repeats per unit of work with a unit count that does not exist until units have been generated. A denominator would be guesswork, so reached stages are counted instead. Stages that repeat per unit also show their unit progress, for example <code>2/3</code>.</li>
    <li>A stage with no artifacts that the workflow has already moved past is marked <strong>skipped</strong> (hatched), not pending. That is normal: Reverse Engineering is skipped on a greenfield project, and design stages are skipped whenever the workflow decides they add nothing.</li>
    <li><strong>Operations is a placeholder in AI-DLC v1.</strong> The v1 rules state that the workflow ends after Build and Test in Construction, so an unreached Operations stage is excluded from the count and a project that finished Build and Test reads as complete. v2 declares its own phases, and the viewer takes them from the project rather than from a list built into this extension.</li>
    <li>Stage folders and files keep their badges: <strong>I</strong> (blue), <strong>C</strong> (purple), <strong>O</strong> (green). Progress itself uses purple, because green already marks unread <code>NEW</code> artifacts.</li>
    <li>An artifact that matches no known stage layout is reported at the bottom of the expanded strip rather than guessed into a stage.</li>
  </ul>
</div>

<div class="stage-card construction">
  <h3>🌲 Live Workflow Tree</h3>
  <ul>
    <li>Only Markdown artifacts are shown; build folders (<code>node_modules</code>, <code>.git</code>, …) are ignored.</li>
    <li>Files created after you started watching are marked <strong>NEW</strong> (green dot); opened files switch to <strong>READ</strong> (check mark).</li>
    <li>Folders containing NEW files are <strong>expanded automatically</strong>, so freshly generated artifacts are immediately visible.</li>
    <li>The tree refreshes on file changes, on window focus, and via periodic polling — external changes from Finder, git, or CLI tools are picked up too.</li>
  </ul>
</div>

<div class="stage-card operations">
  <h3>📝 Split Editor / Preview</h3>
  <ul>
    <li>Click any file to open a <strong>raw Markdown editor</strong> (left) with a <strong>styled live preview</strong> (right).</li>
    <li><strong>Save</strong> with the Save button or <code>Ctrl/Cmd + S</code>; <strong>Reload</strong> discards local edits and re-reads the file.</li>
    <li><strong>Mermaid diagrams</strong> render inline in the preview.</li>
    <li><strong>Zoom</strong> the preview: +/− buttons, <code>Ctrl/Cmd</code> + <code>+</code>/<code>−</code>/<code>0</code>, mouse wheel with <code>Ctrl/Cmd</code>, or trackpad pinch.</li>
    <li><strong>Drag the splitter</strong> to resize panes (double-click resets); editor and preview <strong>scroll in sync</strong>.</li>
  </ul>
</div>

<div class="stage-card supervision">
  <h3>🟣 Supervision — AI-DLC v2 only</h3>
  <p>In v2 the agent reads the artifacts and you approve a summary. A summary is useful because it leaves things out; this panel surfaces <strong>what it left out</strong>. It appears in the sidebar only when a v2 project is open.</p>
  <ul>
    <li><strong>Where the run stopped, and why.</strong> Refusals are listed by what the engine would not let through, newest first, with the events either side so a refusal reads as a sequence rather than a verdict.</li>
    <li><strong>What the engine's own sensors flagged</strong>, grouped per sensor with a count. These are the checks the workflow ran on itself; a link opens the finding.</li>
    <li><strong>The agent's claim next to the engine's check of it</strong> — <em>agent says</em> against <em>engine found</em>, per stage. The two are shown side by side and never reconciled, because a disagreement is the thing worth seeing.</li>
    <li><strong>Units of work</strong> and their dependency chain, including how many are still in flight.</li>
    <li>Nothing is inferred from Markdown. Every figure comes from the engine's own compiled graph, its runtime record and its audit ledger — so a stage, phase or sensor this build has never heard of still shows up correctly, and anything unrecognised is <strong>reported rather than guessed at</strong>.</li>
  </ul>
</div>

<h2>Toolbar Reference</h2>
<table>
  <tr><th>Button</th><th>Action</th></tr>
  <tr><td>📂 Open Workspace</td><td>Select the AI-DLC root folder to watch</td></tr>
  <tr><td>🔄 Refresh</td><td>Re-scan the folder and rebuild the tree</td></tr>
  <tr><td>☁️ Set up AI-DLC</td><td>Asks which generation, then installs it. v1 from the bundled snapshot; v2 from upstream's current head, recording the commit</td></tr>
  <tr><td>❓ Help / Guide</td><td>Open this guide</td></tr>
</table>
<p>Two more commands are in the Command Palette for v2 projects: <strong>AI-DLC v2: Check setup</strong> reports what is present and what is missing, and <strong>AI-DLC v2: Remove</strong> takes back only what the installer wrote — it refuses without an install receipt, and never touches the workflow's own <code>aidlc/</code> content.</p>

<div class="callout">
  <strong>Tip</strong>: v1 artifacts live under <code>aidlc-docs/</code> — <code>inception/</code> for requirements, stories and design; <code>construction/</code> for functional design and code docs; <code>operations/</code> for deployment and ops. v2 organises its own artifacts per intent and per unit of work, and the viewer reads that layout from the engine rather than assuming it.
</div>

<hr/>

<h1>AI-DLC 뷰어 가이드 (한국어)</h1>
<p>AI-DLC Viewer는 <strong>AI-DLC 워크플로우 폴더</strong>를 감시하며 단계별 진행 상황을 시각화하고, 생성된 Markdown 산출물을 VS Code 안에서 바로 읽고 편집할 수 있게 해줍니다.</p>

<div class="callout">
  <strong>AI-DLC에는 두 세대가 있습니다.</strong> <strong>v1</strong>은 에이전트가 읽는 룰 파일이고 산출물은 <code>aidlc-docs/</code> 아래에 생깁니다. <strong>v2</strong>는 워크플로우 자체를 구동하는 엔진이며 게이트를 강제하고 감사 원장을 남깁니다. 뷰어는 프로젝트가 어느 쪽인지 감지해 그에 맞는 화면을 보여줍니다. 아래 트리·스트립·에디터 설명은 <strong>양쪽 모두에 적용</strong>되고, <em>감독</em> 섹션만 v2 전용입니다.
</div>

<h2>시작하기</h2>
<ol>
  <li>VIEWER 패널 툴바에서 <strong>Open Workspace</strong>(폴더 아이콘)를 눌러 AI-DLC 프로젝트 루트를 선택합니다.</li>
  <li>필요하면 <strong>Set up AI-DLC</strong>(클라우드 아이콘)를 누릅니다. <strong>어느 세대를 설치할지 물어봅니다.</strong> v1은 익스텐션에 번들된 스냅샷에서 복사하므로 네트워크가 필요 없습니다. v2는 업스트림 v2 브랜치의 최신 커밋을 내려받고 받은 커밋을 설치 영수증에 기록하므로 프로젝트가 어느 엔진을 쓰는지 항상 말할 수 있습니다. 그리고 <a href="https://bun.com/docs/installation">bun</a>이 필요합니다. bun이 없으면 설치를 진행하지 않고 설치 명령을 건네줍니다. 게이트가 발화하지 않는 프로젝트를 만들어 두는 것보다 낫기 때문입니다.</li>
  <li>에이전트에게 <code>"Using AI-DLC, ..."</code>라고 말하면 — 생성되는 산출물이 트리에 자동으로 나타납니다.</li>
</ol>

<h2>주요 기능</h2>

<div class="stage-card inception">
  <h3>📊 여정(Journey) 및 단계 추적</h3>
  <p>트리 상단은 <strong>도달한 최종 단계</strong>와 완료 단계 수를 보여줍니다. 예를 들어 <code>Build and test</code> · <code>9/9</code> 형태입니다. 펼치면 phase별로 같은 수치를 봅니다.</p>
  <p><code>.md</code> 산출물을 열면 뷰어 상단에 <strong>AI-DLC 여정 스트립</strong>이 함께 나오므로, 문서를 읽는 동안에도 현재 위치가 계속 보입니다. 스트립을 클릭하면 전체 단계 목록으로 펼쳐집니다.</p>
  <ul>
    <li>모든 판정은 <strong>서술이 아니라 구조</strong>에서 나옵니다. v1에서는 <code>aidlc-docs/</code> 아래 어떤 폴더가 있는지와 <code>plans/</code>의 계획 파일이 근거이고, v2에서는 엔진이 컴파일한 그래프와 런타임 기록이 근거입니다. 어느 쪽이든 파일 내용은 파싱하지 않으므로 상태 파일 서식이 예상과 달라도 위치가 틀리지 않습니다.</li>
    <li><strong>퍼센트는 없습니다.</strong> AI-DLC는 적응형 워크플로우라 대부분의 단계가 조건부이고, Construction은 유닛별로 반복되는데 그 유닛 수는 유닛이 생성되기 전에는 존재하지 않습니다. 분모를 정할 수 없으니 도달한 단계 수를 셉니다. 유닛별로 반복되는 단계는 <code>2/3</code>처럼 유닛 진행도 함께 보여줍니다.</li>
    <li>산출물이 없는데 워크플로우가 이미 그 단계를 지나갔다면 <strong>skipped</strong>(빗살무늬)로 표시됩니다. 정상입니다. 그린필드에서는 Reverse Engineering이 생략되고, 설계 단계도 필요 없다고 판단되면 건너뜁니다.</li>
    <li><strong>Operations는 AI-DLC v1에서 placeholder입니다.</strong> v1 규칙이 워크플로우가 Construction의 Build and Test에서 끝난다고 명시하므로, 도달하지 않은 Operations는 분모에서 제외되고 Build and Test를 마쳤다면 완료로 표시됩니다. v2는 자기 phase를 스스로 선언하며, 뷰어는 그것을 익스텐션에 박아둔 목록이 아니라 프로젝트에서 읽어옵니다.</li>
    <li>단계 폴더와 파일의 배지는 그대로입니다: <strong>I</strong>(파랑), <strong>C</strong>(보라), <strong>O</strong>(초록). 진행 표시 자신은 보라를 씁니다. 초록은 아직 읽지 않은 <code>NEW</code> 산출물을 뜻하기 때문입니다.</li>
    <li>알려진 단계 구조에 맞지 않는 산출물은 짐작하지 않고 펼침 스트립 하단에 그대로 알려줍니다.</li>
  </ul>
</div>

<div class="stage-card construction">
  <h3>🌲 실시간 워크플로우 트리</h3>
  <ul>
    <li>Markdown 산출물만 표시되며, 빌드 폴더(<code>node_modules</code>, <code>.git</code> 등)는 무시됩니다.</li>
    <li>감시 시작 후 생성된 파일은 <strong>NEW</strong>(초록 점), 열어본 파일은 <strong>READ</strong>(체크)로 표시됩니다.</li>
    <li>NEW 파일이 있는 폴더는 <strong>자동으로 펼쳐져</strong>, 새로 생성된 산출물이 바로 보입니다.</li>
    <li>파일 변경·창 포커스·주기적 폴링으로 트리가 자동 갱신됩니다 — Finder, git, CLI 도구로 인한 외부 변경도 반영됩니다.</li>
  </ul>
</div>

<div class="stage-card operations">
  <h3>📝 분할 에디터 / 프리뷰</h3>
  <ul>
    <li>파일을 클릭하면 <strong>Markdown 원본 에디터</strong>(왼쪽)와 <strong>스타일 적용 실시간 프리뷰</strong>(오른쪽)가 열립니다.</li>
    <li>Save 버튼 또는 <code>Ctrl/Cmd + S</code>로 <strong>저장</strong>, <strong>Reload</strong>로 로컬 편집을 버리고 파일을 다시 읽습니다.</li>
    <li><strong>Mermaid 다이어그램</strong>이 프리뷰에 인라인 렌더링됩니다.</li>
    <li>프리뷰 <strong>줌</strong>: +/− 버튼, <code>Ctrl/Cmd</code> + <code>+</code>/<code>−</code>/<code>0</code>, <code>Ctrl/Cmd</code> + 휠, 트랙패드 핀치.</li>
    <li><strong>스플리터 드래그</strong>로 패널 크기 조절(더블클릭 시 초기화), 에디터와 프리뷰는 <strong>스크롤 동기화</strong>됩니다.</li>
  </ul>
</div>

<div class="stage-card supervision">
  <h3>🟣 감독(Supervision) — AI-DLC v2 전용</h3>
  <p>v2에서는 에이전트가 산출물을 읽고 사람은 요약을 받아 승인합니다. 요약은 무언가를 버리기 때문에 쓸모가 있고, 이 패널은 <strong>요약이 버린 것</strong>을 드러냅니다. v2 프로젝트를 열었을 때만 사이드바에 나타납니다.</p>
  <ul>
    <li><strong>어디서 멈췄고 왜 멈췄는지.</strong> 엔진이 통과시키지 않은 것을 최신 순으로 보여주며, 앞뒤 이벤트를 함께 실어 거부가 판결이 아니라 순서로 읽히게 합니다.</li>
    <li><strong>엔진의 센서가 무엇을 걸었는지</strong>를 센서별로 묶어 개수와 함께 보여줍니다. 워크플로우가 스스로를 검사한 결과이며, 링크를 누르면 해당 발견을 엽니다.</li>
    <li><strong>에이전트의 기록과 엔진의 판정을 나란히</strong> — 단계별로 <em>agent says</em>와 <em>engine found</em>를 함께 놓습니다. 둘을 화해시키지 않습니다. 어긋남 자체가 봐야 할 것이기 때문입니다.</li>
    <li><strong>작업 유닛</strong>과 의존 관계, 그리고 아직 진행 중인 유닛 수.</li>
    <li>Markdown에서 추론하는 것은 하나도 없습니다. 모든 수치는 엔진이 컴파일한 그래프, 런타임 기록, 감사 원장에서 나옵니다. 그래서 이 빌드가 한 번도 본 적 없는 단계·phase·센서도 정확히 표시되고, 알아볼 수 없는 것은 <strong>짐작하지 않고 그대로 알려줍니다</strong>.</li>
  </ul>
</div>

<h2>툴바 안내</h2>
<table>
  <tr><th>버튼</th><th>동작</th></tr>
  <tr><td>📂 Open Workspace</td><td>감시할 AI-DLC 루트 폴더 선택</td></tr>
  <tr><td>🔄 Refresh</td><td>폴더 재스캔 및 트리 갱신</td></tr>
  <tr><td>☁️ Set up AI-DLC</td><td>어느 세대인지 묻고 설치합니다. v1은 번들 스냅샷에서, v2는 업스트림 최신 커밋에서 받고 그 커밋을 기록</td></tr>
  <tr><td>❓ Help / Guide</td><td>이 가이드 열기</td></tr>
</table>
<p>v2 프로젝트에서는 명령 팔레트에 두 가지가 더 있습니다. <strong>AI-DLC v2: Check setup</strong>은 무엇이 있고 무엇이 없는지 알려주고, <strong>AI-DLC v2: Remove</strong>는 설치 프로그램이 쓴 것만 되돌립니다. 설치 영수증이 없으면 거부하며, 워크플로우가 만든 <code>aidlc/</code> 내용은 절대 지우지 않습니다.</p>

<div class="callout">
  <strong>팁</strong>: v1 산출물은 <code>aidlc-docs/</code> 아래에 생성됩니다 — 요구사항·스토리·설계는 <code>inception/</code>, 기능 설계와 코드 문서는 <code>construction/</code>, 배포·운영은 <code>operations/</code>. v2는 인텐트별·유닛별로 자기 구조를 만들고, 뷰어는 그 구조를 가정하지 않고 엔진에서 읽어옵니다.
</div>
</body>
</html>`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ========== AI-DLC rule bootstrapping ==========
//
// AI-DLC requires platform-specific rule/steering files in the project root before
// the "Using AI-DLC, ..." workflow can run. New users often struggle with the manual
// copy steps. When a project folder is selected, we detect which targets are missing
// and offer to copy the bundled rules into the correct per-platform layout.
//
// Bundled source (snapshot of awslabs/aidlc-workflows release):
//   rules/aidlc-rules/aws-aidlc-rules/core-workflow.md
//   rules/aidlc-rules/aws-aidlc-rule-details/**

const CURSOR_FRONTMATTER =
  '---\n' +
  'description: "AI-DLC (AI-Driven Development Life Cycle) adaptive workflow for software development"\n' +
  'alwaysApply: true\n' +
  '---\n\n';

// Maps vscode.env.appName -> an extra target key to set up in addition to the
// always-on Kiro + Claude Code targets. Kiro hosts are intentionally absent
// because the Kiro target is always created (dedupe).
function detectHostTargetKey() {
  const appName = (vscode.env.appName || '').toLowerCase();
  if (appName.includes('cursor')) {
    return 'cursor';
  }
  if (appName.includes('visual studio code') || appName.includes('vscodium')) {
    return 'copilot';
  }
  return undefined;
}

function getAidlcTargets(hostKey) {
  // Each target declares the files/dirs it needs and how to check whether it
  // is already set up (idempotency). `needsRuleDetails` means the shared
  // `.aidlc-rule-details/` folder must exist for this target.
  const targets = {
    kiro: {
      key: 'kiro',
      label: 'Kiro CLI / IDE',
      // core-workflow folder copied wholesale + dedicated rule-details path
      check: '.kiro/steering/aws-aidlc-rules',
      build: (ctx) => [
        { type: 'copyDir', from: ctx.coreDir, to: '.kiro/steering/aws-aidlc-rules' },
        { type: 'copyDir', from: ctx.ruleDetailsDir, to: '.kiro/aws-aidlc-rule-details' }
      ]
    },
    claude: {
      key: 'claude',
      label: 'Claude Code',
      check: 'CLAUDE.md',
      build: (ctx) => [
        { type: 'copyFile', from: ctx.coreFile, to: 'CLAUDE.md' },
        { type: 'copyDir', from: ctx.ruleDetailsDir, to: '.aidlc-rule-details' }
      ]
    },
    cursor: {
      key: 'cursor',
      label: 'Cursor',
      check: '.cursor/rules/ai-dlc-workflow.mdc',
      build: (ctx) => [
        { type: 'writeFileWithPrefix', prefix: CURSOR_FRONTMATTER, from: ctx.coreFile, to: '.cursor/rules/ai-dlc-workflow.mdc' },
        { type: 'copyDir', from: ctx.ruleDetailsDir, to: '.aidlc-rule-details' }
      ]
    },
    copilot: {
      key: 'copilot',
      label: 'GitHub Copilot',
      check: '.github/copilot-instructions.md',
      build: (ctx) => [
        { type: 'copyFile', from: ctx.coreFile, to: '.github/copilot-instructions.md' },
        { type: 'copyDir', from: ctx.ruleDetailsDir, to: '.aidlc-rule-details' }
      ]
    }
  };

  const selected = [targets.kiro, targets.claude];
  if (hostKey && targets[hostKey] && hostKey !== 'kiro' && hostKey !== 'claude') {
    selected.push(targets[hostKey]);
  }
  return selected;
}

// Single place that resolves the bundled AI-DLC rules root. When a v2 bundle
// is added, extend this with a version parameter (e.g. 'rules/aidlc-rules-v2')
// — every consumer (setup, step counting) resolves through here.
function getBundleRoot(extensionUri) {
  return vscode.Uri.joinPath(extensionUri, 'rules', 'aidlc-rules');
}

// Fallback when the bundled rules can't be read (matches the current bundle).
const BUNDLED_STAGE_STEP_FALLBACK = {
  inception: 7,
  construction: 6,
  operations: 1
};

// Number of workflow steps per stage = number of bundled rule files per stage.
// Used as the denominator for state-file-based progress. Read once per session
// (the bundle never changes at runtime).
let bundledStageStepCountsCache;
async function getBundledStageStepCounts(extensionUri) {
  if (bundledStageStepCountsCache) {
    return bundledStageStepCountsCache;
  }
  const counts = { ...BUNDLED_STAGE_STEP_FALLBACK };
  try {
    const detailsRoot = vscode.Uri.joinPath(getBundleRoot(extensionUri), 'aws-aidlc-rule-details');
    for (const stage of ['inception', 'construction', 'operations']) {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(detailsRoot, stage));
      const mdCount = entries.filter(
        ([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.md')
      ).length;
      if (mdCount > 0) {
        counts[stage] = mdCount;
      }
    }
  } catch {
    // bundle missing (dev checkout) — keep fallback values
  }
  bundledStageStepCountsCache = counts;
  return counts;
}

async function pathExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

// Returns true when at least one target is missing and the bundle is present.
// Used to decide whether to even offer setup (no dialogs / messages here).
async function aidlcSetupNeeded(folderUri, extensionUri) {
  const bundleRoot = getBundleRoot(extensionUri);
  const coreFile = vscode.Uri.joinPath(bundleRoot, 'aws-aidlc-rules', 'core-workflow.md');
  if (!(await pathExists(coreFile))) {
    return false; // no bundle — nothing to offer
  }
  // A project already running v2 must not be offered v1. Its v1 targets are all
  // absent, which is exactly what the loop below reads as "needs setup", so
  // without this guard opening a v2 project prompted to install the previous
  // generation into it.
  const { generation } = detectGeneration(folderUri.fsPath);
  if (generation === 'v2' || generation === 'both') {
    return false;
  }
  const targets = getAidlcTargets(detectHostTargetKey());
  for (const target of targets) {
    const checkUri = vscode.Uri.joinPath(folderUri, target.check);
    if (!(await pathExists(checkUri))) {
      return true;
    }
  }
  return false;
}

// options.confirm: when true, ask before installing (toolbar-button path).
// When false, the caller already obtained consent (folder-pick path).
// options.announceNoop: when true, show a message if everything is already set up.
async function ensureAidlcRules(folderUri, extensionUri, options = {}) {
  const { confirm = true, announceNoop = true } = options;
  const bundleRoot = getBundleRoot(extensionUri);
  const coreDir = vscode.Uri.joinPath(bundleRoot, 'aws-aidlc-rules');
  const coreFile = vscode.Uri.joinPath(coreDir, 'core-workflow.md');
  const ruleDetailsDir = vscode.Uri.joinPath(bundleRoot, 'aws-aidlc-rule-details');

  // If the bundle is missing (e.g. dev checkout without rules), report and stop.
  if (!(await pathExists(coreFile))) {
    vscode.window.showErrorMessage('AI-DLC rule bundle is missing from the extension. Cannot set up rules.');
    return;
  }

  const hostKey = detectHostTargetKey();
  const targets = getAidlcTargets(hostKey);

  // Determine which targets are not yet set up.
  const missing = [];
  for (const target of targets) {
    const checkUri = vscode.Uri.joinPath(folderUri, target.check);
    if (!(await pathExists(checkUri))) {
      missing.push(target);
    }
  }

  if (missing.length === 0) {
    if (announceNoop) {
      const labels = targets.map((t) => t.label).join(', ');
      vscode.window.showInformationMessage(`AI-DLC rules are already set up for: ${labels}.`);
    }
    return;
  }

  if (confirm) {
    const labels = missing.map((t) => t.label).join(', ');
    const setupLabel = 'Set up AI-DLC';
    const choice = await vscode.window.showInformationMessage(
      `Set up AI-DLC rules in this project? Missing: ${labels}.`,
      setupLabel,
      'Not now'
    );
    if (choice !== setupLabel) {
      return;
    }
  }

  const ctx = { coreDir, coreFile, ruleDetailsDir };
  const done = [];
  for (const target of missing) {
    const ops = target.build(ctx);
    for (const op of ops) {
      await runSetupOp(folderUri, op);
    }
    done.push(target.label);
  }

  vscode.window.showInformationMessage(
    `AI-DLC rules installed for: ${done.join(', ')}. Start your agent and say "Using AI-DLC, ...".`
  );
}

async function runSetupOp(folderUri, op) {
  if (op.type === 'copyFile') {
    const dest = vscode.Uri.joinPath(folderUri, op.to);
    await ensureParentDir(dest);
    // Skip if the destination already exists (idempotent at the file level too)
    if (await pathExists(dest)) {
      return;
    }
    const bytes = await vscode.workspace.fs.readFile(op.from);
    await vscode.workspace.fs.writeFile(dest, bytes);
    return;
  }

  if (op.type === 'writeFileWithPrefix') {
    const dest = vscode.Uri.joinPath(folderUri, op.to);
    await ensureParentDir(dest);
    if (await pathExists(dest)) {
      return;
    }
    const bytes = await vscode.workspace.fs.readFile(op.from);
    const body = Buffer.from(bytes).toString('utf8');
    const merged = Buffer.from(op.prefix + body, 'utf8');
    await vscode.workspace.fs.writeFile(dest, merged);
    return;
  }

  if (op.type === 'copyDir') {
    const dest = vscode.Uri.joinPath(folderUri, op.to);
    // Skip the whole copy if the directory already exists
    if (await pathExists(dest)) {
      return;
    }
    await copyDirectory(op.from, dest);
    return;
  }
}

async function ensureParentDir(fileUri) {
  const parent = vscode.Uri.joinPath(fileUri, '..');
  try {
    await vscode.workspace.fs.createDirectory(parent);
  } catch {
    // createDirectory is recursive and ignores existing dirs; swallow errors
  }
}

async function copyDirectory(fromUri, toUri) {
  await vscode.workspace.fs.createDirectory(toUri);
  const entries = await vscode.workspace.fs.readDirectory(fromUri);
  for (const [name, fileType] of entries) {
    const childFrom = vscode.Uri.joinPath(fromUri, name);
    const childTo = vscode.Uri.joinPath(toUri, name);
    if (fileType === vscode.FileType.Directory) {
      await copyDirectory(childFrom, childTo);
    } else if (fileType === vscode.FileType.File) {
      const bytes = await vscode.workspace.fs.readFile(childFrom);
      await vscode.workspace.fs.writeFile(childTo, bytes);
    }
  }
}

module.exports = {
  activate,
  deactivate
};
