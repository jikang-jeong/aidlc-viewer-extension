# Trace Explorer message protocol

Owner: the protocol module. Code: `extension-source/src/trace-explorer-protocol.js`.
Tests: `extension-source/tests/trace-explorer-protocol.test.js`.

The Trace Explorer webview runs script, so everything it posts is treated as untrusted input.
The feature is read-only (`this document`). The host does two things for the webview:

1. Open a file in an editor, if the path resolves to a regular file inside the opened project root.
2. Re-read the project and send the data again.

The host never runs a command, opens a chat, writes a file or starts a process because of a
message. Every validator builds a fresh object that holds only the fields named below, so extra
fields such as `command`, `prompt` or `args` are never passed on. Unknown types are dropped. This
includes the types the other panels use (`openChat`, `save`, `requestLatest`). It is the
`acceptablePrompt()` idea from `src/aidlc/command-builder.js` ("accept back only what the page
could have made"), applied to every message.

Transport follows the existing panels: `panel.webview.postMessage(msg)` from host to webview,
`vscode.postMessage(msg)` from webview to host, and `panel.webview.onDidReceiveMessage(handler)`
on the host side. All payloads are JSON (no functions, cycles or BigInt).

Every host → webview message carries `protocol: 1` (`PROTOCOL_VERSION`).

## Webview → host

| type | payload | sent when | host handling |
| ---- | ------- | --------- | ------------- |
| `ready` | `{ protocol?: int ≥ 1 }` | `main.js` has loaded and wired its listeners (once per page load, including when a hidden panel is re-created) | Read the project and post `setData` (`reason: 'initial'`), or `dataError`. If a selection was remembered, post `navigateTo` after it. |
| `openFile` | `{ path: string, line?: int 1..10^7 }` | User clicks a source-file link (detail panel, coverage cell, drift entry) | Validate it against the project root, then open the cleaned `absPath` in a text editor (`vscode.window.showTextDocument(vscode.Uri.file(absPath), { preview: true })`, revealing `line` if given). If validation fails, nothing happens. |
| `refresh` | `{}` | User clicks Refresh | Re-read the project and post `setData` (`reason: 'refresh'`) or `dataError`. Shares the 200 ms debounce with the watcher. |
| `selectionChanged` | `{ nodeId: string \| null, tab?: 'trace'\|'cov'\|'rev'\|'about' }` | Selected node or active tab changes | Store it in memory as the panel's last selection, so it can be sent back as `navigateTo` after a reload. Nothing else. |

### Validation (`validateWebviewMessage(raw, { projectRoot })`)

The function returns a cleaned message or `null`. It returns `null` when:

- the input is not a plain object, or `type` is not a string or not one of the four types above;
- `ready.protocol` is present but is not an integer ≥ 1;
- `selectionChanged.nodeId` is not `null`/absent and is not a 1–256 char string without control
  characters, or `tab` is present but is not a known tab;
- `openFile` has no `projectRoot` in its context, `line` is present but out of range, or the path
  fails `resolveProjectFile`.

The cleaned `openFile` message is `{ type, path: <project-relative POSIX>, absPath: <real path>, line? }`.

### `resolveProjectFile(projectRoot, requested)` rules

All of these must pass:

1. `requested` is a non-empty string of at most 1024 chars with no control characters (this blocks NUL and newlines).
2. It has no colon. This rejects `command:`, `file:`, `vscode:`, `https:`, `foo.md:12` and Windows
   alternate data streams. The one exception is a leading drive letter (`C:\`), and only under the
   win32 path module.
3. It has no UNC or protocol-relative prefix (`//host`, `\\host`).
4. On POSIX it has no backslash. On POSIX a backslash is part of a file name, but readers take it
   as a separator, so the path is refused rather than given one meaning.
5. It has no `..` segment, even one that would land back inside the root.
6. After `path.resolve(root, requested)` it is lexically inside the root and is not the root itself.
   Absolute paths are allowed only when they point inside the root. Sibling folders that share
   the root's name as a prefix (`/proj-evil`) are refused.
7. `fs.realpathSync(target)` is inside `fs.realpathSync(root)`. This refuses a symlink in the project
   that points outside it, and a linked folder. The real target is a regular file (checked with
   `statSync().isFile()`), so folders, missing files and dangling links are refused.

`absPath` is the resolved real path, so the host opens the file that was checked and not a link
that could be re-pointed afterwards. The validator only reads the filesystem. Tests pass a fake
`{ realpathSync, statSync }` and `path.posix` / `path.win32`. The host must use the default
(real `fs`) and never `fs: null`.

## Host → webview

| type | payload | sent when |
| ---- | ------- | --------- |
| `setData` | `{ protocol, seq: int ≥ 0, reason: 'initial'\|'refresh'\|'file-change', data: TraceData }` | After `ready`, after `refresh`, and after the watcher's debounced change |
| `dataError` | `{ protocol, seq, code, message: string ≤ 500 }` | Whenever there is no `setData` to send instead (see codes) |
| `navigateTo` | `{ protocol, nodeId: string, tab: 'trace'\|'cov'\|'rev'\|'about' }` (tab defaults to `trace`) | A command such as "Show in Trace Explorer" with a node id, or restoring the last selection after `ready` |

`dataError.code` values:

| code | meaning |
| ---- | ------- |
| `no-project` | No folder is being watched, or it has no AI-DLC v2 intent |
| `read-failed` | `readTraceData` threw. This should not happen, because its contract is "partial result plus warnings". Also the fallback for any unknown code. |
| `bad-shape` | The result has no `nodes[]` / `edges[]` arrays |
| `not-serializable` | `JSON.stringify` threw (a cycle or a BigInt) |
| `too-large` | The serialised payload is over `LIMITS.SET_DATA_MAX_BYTES` (8 MiB, measured in UTF-8 bytes) |

`setData.data` always replaces the previous data. There is no incremental `updateData`: the
reference project is about 128 nodes and 200 edges, so a full payload is cheap. A full payload
also cannot drift from disk, and the views are pure functions of `(data, indexes, state)`.
Partial problems are not errors. They arrive inside `setData` as `data.meta.warnings[]` /
`data.meta.omitted[]`.

### Message builders

- `buildSetDataMessage(data, { seq, reason, maxBytes })` returns `{ ok: true, message, bytes }` or
  `{ ok: false, message: <dataError>, bytes? }`. It serialises once: this checks the data is
  JSON-safe, applies the size guard, and the parsed copy is what gets posted, so the webview
  receives exactly what was measured. A wrong `seq`, `reason` or `maxBytes` is a host bug and
  throws `TypeError`.
- `buildDataErrorMessage(code, message, { seq })` maps unknown codes to `read-failed` and truncates the message to 500 characters.
- `buildNavigateToMessage(nodeId, tab = 'trace')` returns the message, or `null` for a bad id or tab.
- `validateHostMessage(raw)` is the host → webview check. The host can use it as a self-check,
  and `main.js` mirrors its rules.

### Sequencing (`seq`)

The panel keeps one counter. It increments the counter for every read and stamps the result
(`setData` or `dataError`) with it. The webview remembers the highest `seq` it has applied and
ignores any `setData` / `dataError` with a lower `seq`. This handles a slow read that finishes
after a newer one. `navigateTo` has no `seq` and applies to whatever data is current. If
`nodeId` is not in the current data, the webview ignores it.

## Sequences

### Open → ready → setData

```
User / command          Host (trace-explorer-panel.js)             Webview (main.js)
──────────────          ──────────────────────────────             ─────────────────
"Open Trace Explorer" ─▶ createWebviewPanel (enableScripts,
                          no enableCommandUris), set html with CSP
                                                           ──load──▶ wire listeners
                                                       ◀── ready ── postMessage({type:'ready', protocol:1})
                         validateWebviewMessage → {type:'ready'}
                         seq += 1; data = readTraceData(root)
                         buildSetDataMessage(data,{seq,reason:'initial'})
                           ok  ── setData ─────────────────────────▶ build indexes, render active tab
                           !ok ── dataError ───────────────────────▶ render error state
                         if lastSelection: navigateTo ─────────────▶ select node, switch tab
```

If the panel is hidden and re-created (no `retainContextWhenHidden`), the page reloads and posts
`ready` again. The host answers the same way. The page should also keep its own UI state with
`vscode.setState`.

### File change → setData

```
FS watcher / poll ─▶ WatchController.scheduleRefresh (200 ms debounce)
                     └▶ traceExplorerPanel.reload('file-change')    (only if the panel exists)
                          seq += 1; readTraceData(root)
                          setData {reason:'file-change', seq} ───────▶ replace data, keep selection
                                                                       if the node still exists,
                                                                       else clear it
```

The Refresh button is the same flow: `refresh` → `reload('refresh')`. If a refresh and a watcher
event arrive inside one debounce window, they are one read.

### Errors

```
webview ── openFile {path:'../../etc/passwd'} ─▶ validate → null → dropped (no reply, no toast)
webview ── openChat / save / anything unknown ─▶ validate → null → dropped
host: no watched folder        ─▶ dataError {code:'no-project'}
host: readTraceData throws     ─▶ dataError {code:'read-failed', message: err.message}
host: payload > 8 MiB          ─▶ dataError {code:'too-large'}
host: cycle / BigInt in data   ─▶ dataError {code:'not-serializable'}
```

Dropped webview messages get no reply. Each one is either a page bug or an attempt to make the
host do something, and neither should get feedback. If the host can log to an output channel, it
may record `type` only, never the payload.

A later successful read (file change or Refresh) replaces the error state with `setData`.

## Host handler sketch (for the panel shell / the extension wiring)

```js
const P = require('./trace-explorer-protocol');
panel.webview.onDidReceiveMessage((raw) => {
  const msg = P.validateWebviewMessage(raw, { projectRoot });
  if (!msg) return;
  switch (msg.type) {
    case P.TO_HOST.READY: return this.reload('initial');
    case P.TO_HOST.REFRESH: return this.scheduleReload('refresh');
    case P.TO_HOST.SELECTION_CHANGED: this.lastSelection = msg; return;
    case P.TO_HOST.OPEN_FILE: return openInEditor(msg.absPath, msg.line); // showTextDocument only
  }
});
```

The panel must not set `enableCommandUris`. This keeps `command:` links in rendered content from
working even if one escaped the views' HTML escaping.
