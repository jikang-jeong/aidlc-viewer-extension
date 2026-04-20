const vscode = require('vscode');
const path = require('path');

const STATE_KEY = 'markdownWatchViewer.watchedFolder';
const OPENED_KEY = 'markdownWatchViewer.openedFiles';
const KNOWN_KEY = 'markdownWatchViewer.knownFiles';
const NEW_KEY = 'markdownWatchViewer.newFiles';

function activate(context) {
  const controller = new WatchController(context);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('markdownWatchViewer.tree', controller.treeDataProvider),
    vscode.commands.registerCommand('markdownWatchViewer.selectFolder', () => controller.selectFolder()),
    vscode.commands.registerCommand('markdownWatchViewer.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('markdownWatchViewer.openFile', (item) => controller.openFile(item))
  );

  controller.restoreWatcher();
}

function deactivate() {}

class WatchController {
  constructor(context) {
    this.context = context;
    this.treeDataProvider = new MarkdownTreeDataProvider();
    this.fileWatcher = undefined;
    this.previewPanels = new Map();
    this.openedFiles = new Set(context.workspaceState.get(OPENED_KEY, []));
    this.knownFiles = new Set(context.workspaceState.get(KNOWN_KEY, []));
    this.newFiles = new Set(context.workspaceState.get(NEW_KEY, []));
    this.treeDataProvider.setFileState(this.openedFiles, this.knownFiles, this.newFiles);
  }

  async restoreWatcher() {
    const storedFolder = this.context.workspaceState.get(STATE_KEY);
    if (!storedFolder) {
      this.treeDataProvider.setRootUri(undefined);
      return;
    }

    const uri = vscode.Uri.file(storedFolder);
    try {
      await vscode.workspace.fs.stat(uri);
      await this.setWatchedFolder(uri, { showMessage: false });
    } catch {
      this.context.workspaceState.update(STATE_KEY, undefined);
      this.treeDataProvider.setRootUri(undefined);
      vscode.window.showWarningMessage('Previously watched folder was not found. Please select a new one.');
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

    const pattern = new vscode.RelativePattern(folderUri, '**/*');
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = () => this.refresh();
    this.fileWatcher.onDidCreate(async (uri) => {
      await this.handleCreate(uri);
      refresh();
    });
    this.fileWatcher.onDidDelete(refresh);
    this.fileWatcher.onDidChange((uri) => {
      refresh();
      this.notifyOpenPreview(uri);
    });

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

  async updatePreview(panel, fileUri) {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const content = Buffer.from(bytes).toString('utf8');
    panel.title = path.basename(fileUri.fsPath);
    panel.webview.html = getWebviewHtml(panel.webview, fileUri, content);
  }

  async saveMarkdown(fileUri, content) {
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`Saved ${path.basename(fileUri.fsPath)}`);
    this.refresh();
  }

  async notifyOpenPreview(uri) {
    const panel = this.previewPanels.get(uri.toString());
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
    this.refresh();
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
      return [
        new InfoItem('Select a folder to start watching', 'Run "Markdown Watch Viewer: Select Folder".')
      ];
    }

    if (!element) {
      const stageSummary = await this.getStageSummary(this.rootUri);
      const entries = await this.getDirectoryEntries(this.rootUri);
      return [new StageItem(stageSummary), ...entries];
    }

    return this.getDirectoryEntries(element.resourceUri);
  }

  async getDirectoryEntries(targetUri) {
    const entries = await vscode.workspace.fs.readDirectory(targetUri);

    const rawItems = await Promise.all(
      entries
        .filter(([name]) => !name.startsWith('.'))
        .map(async ([name, fileType]) => {
          const childUri = vscode.Uri.joinPath(targetUri, name);
          const isDirectory = fileType === vscode.FileType.Directory;
          if (isDirectory) {
            const stats = await this.getDirectoryStats(childUri);
            if (!stats.hasMarkdown) {
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
    const summary = {
      currentStage,
      counts,
      latestFile: latest?.fileUri,
      latestModifiedLabel: latest?.fileUri ? path.basename(latest.fileUri.fsPath) : undefined
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

class InfoItem extends vscode.TreeItem {
  constructor(label, description) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'info';
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
      visualState.hasNew ? new vscode.ThemeColor('charts.green') : undefined
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

  return new OtherFileItem(resourceUri);
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

function formatStageLabel(summary) {
  if (summary.currentStage === 'unknown') {
    return 'Current Stage: Unknown';
  }

  return `Current Stage: ${capitalize(summary.currentStage)}`;
}

function formatStageDescription(summary) {
  return summary.latestModifiedLabel ? `Last review: ${summary.latestModifiedLabel}` : 'Last review: none';
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
    return new vscode.ThemeColor('charts.orange');
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

async function collectMarkdownFiles(rootUri) {
  const results = [];

  async function walk(currentUri) {
    const entries = await vscode.workspace.fs.readDirectory(currentUri);
    for (const [name, fileType] of entries) {
      if (name.startsWith('.')) {
        continue;
      }

      const childUri = vscode.Uri.joinPath(currentUri, name);
      if (fileType === vscode.FileType.Directory) {
        await walk(childUri);
        continue;
      }

      if (fileType === vscode.FileType.File && name.toLowerCase().endsWith('.md')) {
        results.push(childUri);
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
        grid-template-columns: 1.1fr 1fr;
        height: 100vh;
      }

      .pane {
        min-width: 0;
        display: flex;
        flex-direction: column;
      }

      .pane + .pane {
        border-left: 1px solid var(--border);
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

      .preview {
        overflow: auto;
        padding: 20px;
        line-height: 1.65;
      }

      .preview h1,
      .preview h2,
      .preview h3 {
        line-height: 1.2;
      }

      .preview pre {
        overflow: auto;
        padding: 12px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--panel) 78%, transparent);
      }

      .preview code {
        font-family: var(--vscode-editor-font-family);
      }

      .preview blockquote {
        margin: 0;
        padding-left: 12px;
        border-left: 3px solid color-mix(in srgb, var(--accent) 55%, var(--border));
        color: var(--muted);
      }

      .status {
        font-size: 12px;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="pane">
        <div class="header">
          <div class="title">${title}</div>
          <div class="actions">
            <button class="secondary" id="reload">Reload</button>
            <button id="save">Save</button>
          </div>
        </div>
        <textarea id="editor" spellcheck="false"></textarea>
      </section>
      <section class="pane">
        <div class="header">
          <div class="title">Preview</div>
          <div class="status" id="status">Ready</div>
        </div>
        <div id="preview" class="preview"></div>
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

      editor.addEventListener('input', () => {
        renderMarkdown(editor.value);
        status.textContent = isDirty() ? 'Unsaved changes' : 'Ready';
        syncActionVisibility();
      });

      document.getElementById('save').addEventListener('click', () => {
        vscode.postMessage({
          type: 'save',
          content: editor.value
        });
        cleanValue = editor.value;
        status.textContent = 'Saved';
        syncActionVisibility(false);
      });

      document.getElementById('reload').addEventListener('click', () => {
        vscode.postMessage({ type: 'requestLatest' });
        cleanValue = initialValue;
        status.textContent = 'Ready';
        syncActionVisibility(false);
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
        let html = escapeHtml(source);

        html = html.replace(/^###\\s+(.*)$/gm, '<h3>$1</h3>');
        html = html.replace(/^##\\s+(.*)$/gm, '<h2>$1</h2>');
        html = html.replace(/^#\\s+(.*)$/gm, '<h1>$1</h1>');
        html = html.replace(/^>\\s?(.*)$/gm, '<blockquote>$1</blockquote>');
        html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
        html = html.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
        html = html.replace(/\\*(.*?)\\*/g, '<em>$1</em>');
        html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        html = html.replace(/^[-*]\\s+(.*)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\\/li>)/gs, '<ul>$1</ul>');
        html = html.replace(/^(?!<h\\d|<ul>|<li>|<pre>|<blockquote>)([^\\n<].+)$/gm, '<p>$1</p>');
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
