const vscode = require('vscode');
const path = require('path');

const STATE_KEY = 'markdownWatchViewer.watchedFolder';
const OPENED_KEY = 'markdownWatchViewer.openedFiles';
const KNOWN_KEY = 'markdownWatchViewer.knownFiles';
const NEW_KEY = 'markdownWatchViewer.newFiles';

function activate(context) {
  const controller = new WatchController(context);

  const stageDecorationProvider = new StageDecorationProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('markdownWatchViewer.tree', controller.treeDataProvider),
    vscode.window.registerFileDecorationProvider(stageDecorationProvider),
    vscode.commands.registerCommand('markdownWatchViewer.selectFolder', () => controller.selectFolder()),
    vscode.commands.registerCommand('markdownWatchViewer.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('markdownWatchViewer.openFile', (item) => controller.openFile(item)),
    vscode.commands.registerCommand('markdownWatchViewer.showHelp', () => controller.showHelp()),
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
    this.treeDataProvider = new MarkdownTreeDataProvider();
    this.fileWatcher = undefined;
    this.previewPanels = new Map();
    this.suppressWatchOnce = new Set();
    this.openedFiles = new Set(context.workspaceState.get(OPENED_KEY, []));
    this.knownFiles = new Set(context.workspaceState.get(KNOWN_KEY, []));
    this.newFiles = new Set(context.workspaceState.get(NEW_KEY, []));
    this.treeDataProvider.setFileState(this.openedFiles, this.knownFiles, this.newFiles);
    this.refreshTimer = undefined;
  }

  scheduleRefresh() {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.treeDataProvider.refresh();
    }, 200);
  }

  async restoreWatcher() {
    const storedFolder = this.context.workspaceState.get(STATE_KEY);
    if (!storedFolder) {
      this.treeDataProvider.setRootUri(undefined);
      this.promptForFolder('Welcome to AIDLC-VIEWER. Select the root folder of your AI-DLC project to start watching.');
      return;
    }

    const uri = vscode.Uri.file(storedFolder);
    try {
      await vscode.workspace.fs.stat(uri);
      await this.setWatchedFolder(uri, { showMessage: false });
    } catch {
      this.context.workspaceState.update(STATE_KEY, undefined);
      this.treeDataProvider.setRootUri(undefined);
      this.promptForFolder('Previously watched folder was not found. Please select a new AI-DLC root folder.');
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

    await this.setWatchedFolder(selection[0], { showMessage: true });
  }

  async setWatchedFolder(folderUri, options = { showMessage: true }) {
    this.disposeWatcher();
    this.treeDataProvider.setRootUri(folderUri);
    await this.context.workspaceState.update(STATE_KEY, folderUri.fsPath);
    await this.primeKnownFiles(folderUri);

    // Watch .md files for content updates & creations
    const mdPattern = new vscode.RelativePattern(folderUri, '**/*.md');
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(mdPattern);
    this.fileWatcher.onDidCreate((uri) => {
      this.handleCreate(uri);
      this.scheduleRefresh();
    });
    this.fileWatcher.onDidDelete(() => this.scheduleRefresh());
    this.fileWatcher.onDidChange((uri) => {
      this.scheduleRefresh();
      this.notifyOpenPreview(uri);
    });

    // Watch all paths (create/delete only) to catch new directories like operations/
    const dirPattern = new vscode.RelativePattern(folderUri, '**');
    this.dirWatcher = vscode.workspace.createFileSystemWatcher(dirPattern, false, true, false);
    this.dirWatcher.onDidCreate(() => this.scheduleRefresh());
    this.dirWatcher.onDidDelete(() => this.scheduleRefresh());

    // Polling fallback: catches external changes (Finder, git, CLI scripts) even if native watchers miss events
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.scheduleRefresh(), 15000);

    if (options.showMessage) {
      vscode.window.showInformationMessage(`Watching folder: ${folderUri.fsPath}`);
    }

    this.refresh();
  }

  refresh() {
    this.treeDataProvider.refresh();
  }

  async openFile(item) {
    if (!item || item.type !== 'file') {
      return;
    }

    await this.markFileOpened(item.resourceUri);

    const key = item.resourceUri.toString();
    let panel = this.previewPanels.get(key);

    if (panel) {
      panel.reveal(vscode.ViewColumn.One);
      await this.updatePreview(panel, item.resourceUri);
      return;
    }

    panel = vscode.window.createWebviewPanel(
      'markdownWatchViewer.editor',
      path.basename(item.resourceUri.fsPath),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
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

  showHelp() {
    if (this.helpPanel) {
      this.helpPanel.reveal(vscode.ViewColumn.One);
      return;
    }
    this.helpPanel = vscode.window.createWebviewPanel(
      'markdownWatchViewer.help',
      'AI-DLC Guide',
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
    panel.title = path.basename(fileUri.fsPath);
    if (!panel.webview.html) {
      panel.webview.html = getWebviewHtml(panel.webview, fileUri, content);
    } else {
      panel.webview.postMessage({ type: 'setContent', content, path: fileUri.fsPath });
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

  async handleCreate(uri) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.File && uri.fsPath.toLowerCase().endsWith('.md')) {
        this.knownFiles.add(uri.toString());
        this.newFiles.add(uri.toString());
        this.treeDataProvider.setFileState(this.openedFiles, this.knownFiles, this.newFiles);
        await this.context.workspaceState.update(KNOWN_KEY, [...this.knownFiles]);
        await this.context.workspaceState.update(NEW_KEY, [...this.newFiles]);
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
    await this.context.workspaceState.update(OPENED_KEY, [...this.openedFiles]);
    await this.context.workspaceState.update(KNOWN_KEY, [...this.knownFiles]);
    await this.context.workspaceState.update(NEW_KEY, [...this.newFiles]);
  }
}

class MarkdownTreeDataProvider {
  constructor() {
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

  async getChildren(element) {
    if (!this.rootUri) {
      // Returning an empty array lets VS Code show the viewsWelcome panel
      return [];
    }

    if (!element) {
      const stageSummary = await this.getStageSummary(this.rootUri);
      const entries = await this.getDirectoryEntries(this.rootUri);
      return [
        new StageItem(stageSummary),
        new ProgressItem(stageSummary),
        ...entries
      ];
    }

    return this.getDirectoryEntries(element.resourceUri);
  }

  async getDirectoryEntries(targetUri) {
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

            return new DirectoryItem(
              childUri,
              stats,
              getDirectoryVisualState(childUri, this.openedFiles, this.knownFiles, this.newFiles)
            );
          }

          return createFileItem(
            childUri,
            fileType,
            await this.getMarkdownMetadata(childUri),
            getFileVisualState(childUri, this.openedFiles, this.knownFiles, this.newFiles)
          );
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

    const markdownFiles = await collectMarkdownFiles(rootUri);
    const counts = {
      inception: 0,
      construction: 0,
      operations: 0
    };
    let latest = undefined;

    for (const fileUri of markdownFiles) {
      const stage = detectStageFromPath(fileUri.fsPath);
      if (!stage) {
        continue;
      }

      counts[stage] += 1;

      try {
        const stat = await vscode.workspace.fs.stat(fileUri);
        const candidate = {
          stage,
          fileUri,
          mtime: stat.mtime
        };
        if (!latest || candidate.mtime > latest.mtime) {
          latest = candidate;
        }
      } catch {
        continue;
      }
    }

    const currentStage = latest?.stage || inferStageFromCounts(counts);
    const progress = computeProgress(counts);
    const summary = {
      currentStage,
      counts,
      progress,
      latestFile: latest?.fileUri,
      latestModifiedLabel: latest?.fileUri ? path.basename(latest.fileUri.fsPath) : undefined,
      latestMtime: latest?.mtime
    };

    this.stageSummaryCache.set(cacheKey, summary);
    return summary;
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
    const progress = summary.progress;
    const bar = renderProgressBar(progress.overall, 13);
    super(`${bar} ${progress.overall}%`, vscode.TreeItemCollapsibleState.None);
    this.description = summary.latestModifiedLabel
      ? `Latest: ${summary.latestModifiedLabel}`
      : 'No artifacts yet';
    this.tooltip = buildProgressTooltip(summary);
    this.contextValue = 'progress';
    this.iconPath = new vscode.ThemeIcon('pulse', getStageColor(summary.currentStage));
  }
}

class StageItem extends vscode.TreeItem {
  constructor(summary) {
    super(formatStageLabel(summary), vscode.TreeItemCollapsibleState.None);
    this.description = formatStageDescription(summary);
    this.tooltip = buildStageTooltip(summary);
    this.contextValue = 'stageSummary';
    this.iconPath = new vscode.ThemeIcon(getStageIcon(summary.currentStage), getStageColor(summary.currentStage));
  }
}

class DirectoryItem extends vscode.TreeItem {
  constructor(resourceUri, stats, visualState) {
    super(path.basename(resourceUri.fsPath), vscode.TreeItemCollapsibleState.Collapsed);
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

function renderProgressBar(pct, width) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function buildProgressTooltip(summary) {
  const progress = summary.progress;
  const lines = ['**AI-DLC Progress**', ''];

  for (const stage of ['inception', 'construction', 'operations']) {
    const s = progress.stages[stage];
    const bar = renderProgressBar(s.pct, 12);
    const icon = stage === 'inception' ? '🔵' : stage === 'construction' ? '🟢' : '🟡';
    lines.push(`${icon} **${capitalize(stage)}** \`${bar}\` ${s.pct}%  (${s.count}/${s.expected})`);
  }

  lines.push('', `**Overall**: ${progress.overall}%`);
  if (summary.currentStage && summary.currentStage !== 'unknown') {
    lines.push(`**Current stage**: ${capitalize(summary.currentStage)}`);
  }
  if (summary.latestFile) {
    lines.push(`**Latest file**: \`${summary.latestFile.fsPath}\``);
  }

  const md = new vscode.MarkdownString(lines.join('\n'));
  md.isTrusted = false;
  return md;
}

function formatStageLabel(summary) {
  if (summary.currentStage === 'unknown') {
    return 'Current Stage: Unknown';
  }

  return `Current Stage: ${capitalize(summary.currentStage)}`;
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
  return parts.join(' • ') || 'No stage files detected';
}

function buildStageTooltip(summary) {
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

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage',
  '.git', '.svn', '.hg', '.vscode', '.idea',
  '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj'
]);

function shouldSkipDirectory(name) {
  return name.startsWith('.') || SKIP_DIRS.has(name);
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

function getWebviewHtml(webview, fileUri, markdown) {
  const safeInitialValue = JSON.stringify(markdown);
  const title = escapeHtml(fileUri.fsPath);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
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
      }

      .shell {
        display: grid;
        grid-template-columns: var(--split-left, 33%) 6px 1fr;
        height: 100vh;
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

    <script>
      const vscode = acquireVsCodeApi();
      const initialValue = ${safeInitialValue};
      const editor = document.getElementById('editor');
      const preview = document.getElementById('preview');
      const status = document.getElementById('status');
      const actions = document.querySelector('.actions');
      let cleanValue = initialValue;

      editor.value = initialValue;
      renderMarkdown(initialValue);
      syncActionVisibility();

      let renderTimer;
      function scheduleRender(text) {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => renderMarkdown(text), 120);
      }

      editor.addEventListener('input', () => {
        scheduleRender(editor.value);
        status.textContent = isDirty() ? 'Unsaved changes' : 'Ready';
        syncActionVisibility();
      });

      // Handle incremental content updates from extension host
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'setContent') {
          const incoming = msg.content || '';
          if (incoming === editor.value) return;
          cleanValue = incoming;
          editor.value = incoming;
          renderMarkdown(incoming);
          status.textContent = 'Ready';
          syncActionVisibility(false);
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
          vscode.setState(Object.assign({}, previousState, { splitPct: splitPct }));
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
        html = html.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g, '<img src="$2" alt="$1">');
        html = html.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2">$1</a>');

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
          const langClass = block.lang ? ' class="language-' + block.lang + '"' : '';
          return '<pre><code' + langClass + '>' + escapeHtml(block.code.replace(/\\n$/, '')) + '</code></pre>';
        });

        return html;
      }

      function escapeHtml(value) {
        return value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }
    </script>
  </body>
</html>`;
}

function getHelpHtml() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<title>AI-DLC Guide</title>
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
<h1>AI-DLC 코어 프레임워크</h1>
<p>AI-DLC는 <strong>AI와 사람의 협업이 만드는 새로운 개발 표준</strong>입니다. AI의 속도와 인간의 판단이 균형을 이루는 체계적인 프레임워크입니다.</p>

<h2>AI와 사람의 협업 방식</h2>
<div class="two-col">
  <div class="role-box">
    <h4>🤖 AI의 역할</h4>
    <ul>
      <li><strong>계획 수립</strong>: 요구사항 분석 및 작업 분해</li>
      <li><strong>아키텍처 제안</strong>: 최적 설계와 기술 스택 제안</li>
      <li><strong>개발 프로세스 조율</strong>: 단계별 실행 계획 수립</li>
      <li><strong>코드 생성</strong>: 설계 기반 실제 코드 작성</li>
    </ul>
  </div>
  <div class="role-box">
    <h4>👤 사람의 역할</h4>
    <ul>
      <li><strong>검증</strong>: AI 제안 계획·설계 검토</li>
      <li><strong>의사결정</strong>: 비즈니스 목표에 맞는 최종 결정</li>
      <li><strong>감독</strong>: 품질·방향성 최종 책임</li>
      <li><strong>승인</strong>: 각 단계 산출물 확인·승인</li>
    </ul>
  </div>
</div>

<hr/>

<h2>3단계 개발 라이프사이클</h2>
<div class="stage-card inception">
  <h3>🔵 INCEPTION: 프로젝트 정의</h3>
  <p><strong>목표</strong>: 비즈니스 의도를 실행 가능한 개발 계획으로 변환</p>
  <ul><li>도메인 컨텍스트 구축</li><li>사용자 스토리로 의도 구체화</li><li>작업 단위로 계획 수립</li></ul>
</div>
<div class="stage-card construction">
  <h3>🟢 CONSTRUCTION: 구축</h3>
  <p><strong>목표</strong>: 설계를 프로덕션 품질의 코드로 구현</p>
  <ul><li>도메인 모델 (컴포넌트 모델)</li><li>아키텍처 컴포넌트 추가</li><li>코드 생성 및 테스트</li></ul>
</div>
<div class="stage-card operations">
  <h3>🟡 OPERATIONS: 운영</h3>
  <p><strong>목표</strong>: 안정적인 프로덕션 환경 구축</p>
  <ul><li>배포 파이프라인 생성</li><li>IaC로 프로덕션 배포</li></ul>
</div>

<hr/>

<h2>AI-DLC Rules: 체계화된 프롬프트 체인</h2>
<h3>INCEPTION 단계</h3>
<table>
  <tr><th>Rules 파일</th><th>역할</th><th>주요 산출물</th></tr>
  <tr><td><code>requirements-analysis.md</code></td><td>시스템 요구사항 정의</td><td>requirements.md</td></tr>
  <tr><td><code>user-stories.md</code></td><td>사용자 관점 기능 정의</td><td>personas.md, stories.md</td></tr>
  <tr><td><code>application-design.md</code></td><td>시스템 구조 설계</td><td>components.md, services.md, component-dependency.md</td></tr>
  <tr><td><code>units-generation.md</code></td><td>개발 단위 구성</td><td>unit-of-work.md, unit-of-work-story-map.md</td></tr>
</table>
<h3>CONSTRUCTION 단계</h3>
<table>
  <tr><th>Rules 파일</th><th>역할</th><th>주요 산출물</th></tr>
  <tr><td><code>functional-design.md</code></td><td>비즈니스 로직 모델링</td><td>domain-entities.md, business-rules.md</td></tr>
  <tr><td><code>nfr-requirements.md</code></td><td>비기능 요구사항</td><td>nfr-requirements.md, tech-stack-decisions.md</td></tr>
  <tr><td><code>nfr-design.md</code></td><td>품질 속성 설계</td><td>nfr-design-patterns.md, logical-components.md</td></tr>
  <tr><td><code>infrastructure-design.md</code></td><td>인프라 구성</td><td>infrastructure-design.md, deployment-architecture.md</td></tr>
  <tr><td><code>code-generation.md</code></td><td>코드 생성</td><td>실제 코드, 테스트, 배포 아티팩트</td></tr>
  <tr><td><code>build-and-test.md</code></td><td>품질 검증</td><td>build-instructions.md, *-test-instructions.md</td></tr>
</table>
<h3>OPERATIONS 단계</h3>
<table>
  <tr><th>Rules 파일</th><th>역할</th><th>주요 산출물</th></tr>
  <tr><td><code>operations.md</code></td><td>운영 체계 수립</td><td>(추후 업데이트 예정)</td></tr>
</table>

<hr/>

<h2>산출물 전체 구조</h2>
<pre>aidlc-docs/
├── audit.md                                  # 모든 결정의 감사 추적
├── aidlc-state.md                            # 현재 진행 상태
│
├── inception/                                # 🔵 INCEPTION
│   ├── requirements/
│   │   ├── requirement-verification-questions.md
│   │   └── requirements.md                   ⭐ 요구사항
│   ├── user-stories/
│   │   ├── personas.md                       ⭐ 페르소나
│   │   └── stories.md                        ⭐ 스토리
│   ├── application-design/
│   │   ├── components.md                     ⭐ 컴포넌트
│   │   ├── component-methods.md              ⭐ 메서드 시그니처
│   │   ├── services.md                       ⭐ 서비스 레이어
│   │   └── component-dependency.md           ⭐ 의존성 매트릭스
│   └── plans/
│       ├── story-generation-plan.md
│       └── application-design-plan.md
│
└── construction/                             # 🟢 CONSTRUCTION
    └── {unit-name}/
        └── functional-design/
            ├── domain-entities.md            ⭐ 도메인 엔티티 (DDD)
            ├── business-rules.md             ⭐ 비즈니스 규칙
            └── business-logic-model.md       ⭐ 비즈니스 로직
</pre>

<hr/>

<h2>1단계: 프로젝트 정의 (Inception)</h2>
<p>비즈니스 목적을 실행 가능한 개발 유닛으로 변환. <strong>몹 엘라보레이션(Mob Elaboration)</strong> 방식으로 제품 책임자·개발자·AI가 협업합니다.</p>
<table>
  <tr><th>스테이지</th><th>실행 조건</th><th>주요 산출물</th></tr>
  <tr><td>Workspace Detection</td><td>항상</td><td>aidlc-state.md</td></tr>
  <tr><td>Requirements Analysis</td><td>항상</td><td>requirements.md</td></tr>
  <tr><td>Workflow Planning</td><td>항상</td><td>execution-plan.md</td></tr>
  <tr><td>Reverse Engineering</td><td>기존 프로젝트만</td><td>architecture.md</td></tr>
  <tr><td>User Stories</td><td>사용자 영향 기능</td><td>personas.md, stories.md</td></tr>
  <tr><td>Application Design</td><td>새 컴포넌트 필요시</td><td>components.md, services.md</td></tr>
  <tr><td>Units Generation</td><td>복잡한 프로젝트</td><td>unit-of-work.md</td></tr>
</table>
<div class="callout">
  <strong>핵심 원칙</strong>: AI는 <code>requirement-verification-questions.md</code>를 만들고, 여러분은 <code>[Answer]:</code> 태그를 채웁니다. 채팅이 아닌 <strong>문서 기반 협업</strong>.
</div>
<h3>User Stories - INVEST</h3>
<ul>
  <li><strong>I</strong>ndependent · <strong>N</strong>egotiable · <strong>V</strong>aluable · <strong>E</strong>stimable · <strong>S</strong>mall · <strong>T</strong>estable</li>
</ul>

<hr/>

<h2>2단계: 구축 (Construction)</h2>
<table>
  <tr><th>#</th><th>스테이지</th><th>설명</th><th>실행 조건</th></tr>
  <tr><td>1</td><td>Functional Design</td><td>기술 독립적 비즈니스 로직 설계</td><td>조건부 (유닛별)</td></tr>
  <tr><td>2</td><td>NFR Requirements</td><td>비기능 요구사항 및 기술 스택</td><td>조건부</td></tr>
  <tr><td>3</td><td>NFR Design</td><td>NFR 패턴·논리적 컴포넌트</td><td>조건부</td></tr>
  <tr><td>4</td><td>Infrastructure Design</td><td>논리적 컴포넌트 → 인프라</td><td>조건부</td></tr>
  <tr><td>5</td><td>Code Planning</td><td>코드 생성 상세 계획</td><td>항상</td></tr>
  <tr><td>6</td><td>Code Generation</td><td>실제 코드 생성</td><td>항상</td></tr>
  <tr><td>7</td><td>Build and Test</td><td>빌드·포괄적 테스트</td><td>항상</td></tr>
</table>
<div class="callout">
  <strong>생성 위치 규칙</strong>:<br>
  • 실제 코드: <code>workspace root</code> (src/, tests/)<br>
  • 코드 문서: <code>aidlc-docs/construction/</code>
</div>

<hr/>

<h2>3단계: 운영 (Operations)</h2>
<table>
  <tr><th>축</th><th>핵심 요소</th><th>AI의 역할</th></tr>
  <tr><td><strong>안정성</strong></td><td>HA·DR·Fault Tolerance·SLA</td><td>가용성 추적, 장애 예측, 자동 복구</td></tr>
  <tr><td><strong>보안</strong></td><td>취약점 평가·규정 준수·액세스 제어</td><td>위협 감지, 취약점 스캔, 규정 검증</td></tr>
  <tr><td><strong>성능</strong></td><td>모니터링·최적화·용량 계획</td><td>병목 감지, 최적화 제안, 수요 예측</td></tr>
</table>

<hr/>

<h2>AS-IS vs TO-BE</h2>
<div class="two-col">
  <div class="role-box">
    <h4>AS-IS: 사람 주도 개발</h4>
    <ul><li>전문 영역별 분리 (사일로)</li><li>주/월 단위 긴 사이클</li><li>사람이 모든 프로세스 주도</li></ul>
  </div>
  <div class="role-box">
    <h4>TO-BE: AI 주도 개발</h4>
    <ul><li>통합된 개발 영역</li><li>시간/일 단위 빠른 사이클</li><li>AI가 주도·사람이 검증</li></ul>
  </div>
</div>

<h2>주요 이점</h2>
<ul>
  <li><strong>개발 속도</strong>: 주/월 → 시간/일 (최대 10배 생산성)</li>
  <li><strong>종단간 품질</strong>: DDD/BDD/TDD 통합 Best Practice</li>
  <li><strong>개발자 역량 강화</strong>: 고부가가치 의사결정에 집중</li>
  <li><strong>비즈니스 민첩성</strong>: 빠른 기능 구현·시장 대응</li>
</ul>
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

module.exports = {
  activate,
  deactivate
};
