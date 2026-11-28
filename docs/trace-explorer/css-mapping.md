# Trace Explorer CSS mapping

Stylesheet: `extension-source/media/trace-explorer/trace-explorer.css` (owner: the stylesheet).
Source: the application `<style>` block of `the design spec (tests/fixtures/design-spec/)` (lines 549-636).
The exported `qw-theme` block (lines 3-538) is dropped.

## Loading it

The panel loads the file with a `<link rel="stylesheet">` whose `href` comes from
`webview.asWebviewUri(...)`. The CSP from `src/credits-page.js` allows that through
`style-src ${webview.cspSource} 'nonce-…'`. Views must never emit `style="…"`, because the CSP drops it
silently. Every dynamic value in the spec has a class below.

VS Code sets one of `vscode-light`, `vscode-dark`, `vscode-high-contrast` or
`vscode-high-contrast-light` on `<body>`, and the stylesheet keys its per-theme overrides on those
classes. The standalone preview (`tools/trace-preview.js`) should put `class="vscode-light"` on `<body>`.
Outside VS Code, every token falls back to the design's light-mode hex.

## Variable mapping

Each design variable keeps its name, so the spec's CSS rules port unchanged. It is redefined on
`:root` in terms of a `--vscode-*` variable.

| Design var | Design value | Maps to | Fallback | Notes |
| ---------- | ------------ | ------- | -------- | ----- |
| `--bg` | `#F7F8FA` | `--vscode-editor-background` | `#F7F8FA` | Page background |
| `--card` | `#FFFFFF` | `--vscode-editorWidget-background` | `#FFFFFF` | Panels, nodes, table. HC: editor background |
| `--bg3` | `#EEF1F5` | `color-mix(--text 7%, --card)` | derived | Opaque on purpose, so the sticky `th` does not let rows show through |
| `--text` | `#1A2230` | `--vscode-foreground` | `#1A2230` | Body text (native workbench colour) |
| (new) `--strong` | | `--vscode-editor-foreground` | `--text` | Mix target for secondary text, ink and edges. Light+ `#000`, Dark+ `#D4D4D4` |
| `--muted` | `#4E5A6B` | `color-mix(--vscode-descriptionForeground 70%, --strong)` | `#4E5A6B` base | Pulled toward `--strong`; the raw description colour is below AA on tints |
| `--dim` | `#7A8597` | `color-mix(--muted 90%, --card)` | derived | One small step lighter than `--muted`. HC: equals `--muted` |
| `--line` | `#D9DEE5` | `--vscode-panel-border`, then `--vscode-widget-border` | `#D9DEE5` | HC: `--vscode-contrastBorder` |
| `--slate` | `#5A6478` | `color-mix(--text 55%, --card)` | derived | Default node stripe, design lane |
| `--violet` | `#6B46E0` | `--vscode-charts-purple` | `#6B46E0` | Fills, stripes, borders, strokes. Same token credits-page uses |
| `--violet-soft` | `#EFEBFC` | `color-mix(--violet 14%, --card)` | derived | Dark: 16%. HC: transparent |
| `--teal` | `#0E8C82` | `--vscode-terminal-ansiCyan` | `#0E8C82` | Criterion and rule lane stripes |
| `--teal-soft` | `#E3F3F1` | `color-mix(--teal 14%, --card)` | derived | |
| `--green` | `#1F9D55` | `--vscode-charts-green` | `#1F9D55` | Fills and stripes for Met, READY, counts |
| `--green-soft` | `#E4F4EA` | `color-mix(--green 15%, --card)` | derived | Dark: 18% |
| `--amber` | `#A87A00` | `--vscode-editorWarning-foreground` | `#A87A00` | Deferred, jump and warning stripes. Same token credits-page uses |
| `--amber-soft` | `#FBF3DC` | `color-mix(--amber 15%, --card)` | derived | Dark: 18% |
| `--red` | `#C2410C` | `--vscode-charts-red` | `#C2410C` | Not met, NOT-READY fills |
| `--red-soft` | `#FDE9DF` | `color-mix(--red 14%, --card)` | derived | Dark: 16% |
| `--sans` | Calibri, Segoe UI, … | `--vscode-font-family` | spec stack | |
| `--mono` | SF Mono, Consolas, … | `--vscode-editor-font-family` | spec stack | |
| (new) `--violet-ink` | | `color-mix(--violet 65%, --strong)` | derived | Violet **text**: rework badge, why ref, why-card links, link-row IDs, active tab, selected pick |
| (new) `--teal-ink` | | `color-mix(--teal 65%, --strong)` | derived | Kicker text |
| (new) `--green-ink` | | `color-mix(--green 60%, --strong)` | derived | `.bdg.ok`, `.v.R`, `.cellN` text |
| (new) `--amber-ink` | | `color-mix(--amber 55%, --strong)` | derived | `.bdg.def` text |
| (new) `--red-ink` | | `color-mix(--red 55%, --strong)` | derived | `.bdg.bad`, `.v.N` text |
| (new) `--link` | spec used teal | `--vscode-textLink-foreground` | `#126C69` (darkened teal) | Source-file links on cards. Inside `.why`, links use `--violet-ink` instead |
| (new) `--link-hover` | | `--vscode-textLink-activeForeground` | `--link` | |
| (new) `--on-accent` | `#fff` | `#FFFFFF` | | Text on the solid violet chip. Dark and HC: editor background, because white on light violet is too faint |
| (new) `--edge` | `#9AA4B5` @ .75 | `color-mix(--strong 50%, --card)`, opacity 1 | derived | Default SVG edge. HC: `--text` |
| (new) `--edge-hot` | `#6B46E0` | `--violet` | | Edge touching the selected node |
| (new) `--edge-deferred` | `#A87A00` | `color-mix(--amber 80%, --strong)` | derived | Deferred edge and legend swatch |
| (new) `--hover` | `#F4F1FD` / `--bg3` | `--vscode-list-hoverBackground` | `--bg3` | Picker and table row hover |
| (new) `--focus` | | `--vscode-focusBorder` | `#6B46E0` | Keyboard focus ring |
| (new) `--shadow` | `rgba(20,30,50,.12)` | `--vscode-widget-shadow` | spec value | Node hover lift |
| (new) `--hc-border` | | `transparent`; HC: `--vscode-contrastBorder` | | Adds borders to tinted boxes in high contrast |
| (input) | | `--vscode-input-background`, `-foreground`, `-border`, `-placeholderForeground` | `--card`, `--text`, `--line`, `--dim` | Picker search box |

**Why `--strong`.** VS Code's workbench `--vscode-foreground` is soft (Light+ `#616161`), so
mixing toward it barely moves a colour. Secondary text (`--muted`, `--dim`), accent text (`*-ink`)
and edges are mixed toward the editor foreground instead. On light themes that darkens them, and
on dark themes it lightens them, so contrast rises in both. Accent tokens draw fills, stripes and
borders. New coloured text should use the `*-ink` tokens.

**Contrast targets.** Text must reach 4.5:1 and graphics (edges) 3:1, against the surface they sit
on. Measured the following with realistic Light+ and Dark+ variables;
the tokens were then changed as listed. The new ratios are not re-measured yet.

| Failing before the fix | Change |
| ----------------- | ------ |
| `--dim` text, light 3.07 (`.grp`, `.legend`, `.laneHead`, `.detail .ty`, `.detail h4`, `.lk .rel`, `.lk .org`, `.stamp`, `.empty`) | `--dim` now derives from the strengthened `--muted` and mixes toward `--card` only 10%. It no longer mixes toward `--bg` |
| `--muted` text: `.sev` 3.48 / 4.26, `.note` 3.91, plain `.bdg` 3.91, `.pick .mono` / `.node .lb` 4.40 / 4.22 | `--muted` = description colour 70% + `--strong` 30% |
| `.bdg.def` light 3.99 | `--amber-ink` amber share 60% to 55%, mixed toward `--strong` |
| `--violet-ink` dark 4.22 (`.why b`, `.pick.on`, `.bdg.rw`) | violet share 80% to 65%, mixed toward `--strong`; dark `--violet-soft` 20% to 16% |
| `.bdg.bad` dark 4.48 | `--red-ink` 55% toward `--strong`; dark `--red-soft` 18% to 16% |
| `.src button.open` on why-card, 4.05 / 3.59 | `.why a, .why button.open` use `--violet-ink` |
| Default edge light 2.95 | `--edge` = `--strong` 50% into `--card` |
| Deferred edge light 2.81 | `--edge-deferred` = amber 80% + `--strong` 20% |

`.edge.dim` (opacity .35) is intentionally below 3:1. It is an optional fade and must never be
the only way an edge is shown.

**High contrast.** Tints are removed (all `*-soft` become `transparent`). Badges, verdict pills,
why-cards, callouts and count cells get a `currentColor` or contrast border instead. Hover and
selection use `--vscode-contrastActiveBorder`: dashed for hover, solid for selection. Focus is a
2px dashed outline. High contrast measures as passing everywhere.

## Class inventory

Names match the spec. **Bold** marks names that are new or changed in the port.

### Shell, header and tabs (the panel shell, `main.js`)

| Class | Element / use |
| ----- | ------------- |
| `.wrap` | Page container, max 1400px |
| `.kicker`, `h1 .accent`, `.sub`, `.stamp`, `.dot` | Header. `.dot` is the amber snapshot dot |
| **`.banner`**, **`.banner.warn`**, **`.banner.err`** | Host messages: loading, `meta.warnings[]`, errors |
| `.bannerHead`, `.warnings` (+ `.collapsed`), `.wpath`, `.wmsg` | The warning list inside the banner: count and fold button on one row; folded, the first two warnings clipped to one line each (`li:nth-child(n+3)` hidden), the path dimmed and shortened to its tail |
| `.tabs` > `.tab` (+ `.active` or **`[aria-selected="true"]`**) | Tab bar. Use `role="tablist"` and `role="tab"` |
| `.view` (+ `.active`) | Tab panels; only `.active` is shown. `[hidden]` also works |

### Shared (all views)

| Class | Use |
| ----- | --- |
| `.panel` | Card wrapper (border, radius, card background) |
| `.box` | Padded panel body; `.box h3` is its title. **`.box + .box`** adds 14px gap (replaces the spec's inline `margin-top:14px`) |
| `.badges` | Flex row of badges inside a node |
| `.bdg` + `.ok` / `.def` / `.bad` / `.rw` | Pills: green Met/Covered, amber Deferred/Unverified, red Not met, violet Reworked. Plain `.bdg` is neutral |
| `.sev` | Small muted text (stage, counts, captions) |
| `.empty` | Empty-state message |
| `.note` | Neutral callout. **`.note.drift`** (alias **`.note.amber`**) replaces the spec's inline `background:var(--amber-soft)` |
| `.jump` | Amber backward-jump card |
| `.warn` | Amber warning callout (About page) |
| `.flist` | Monospace file list (`<ul>`) |
| `.lk` > `.rel`, `button`, `.bdg`, `.org` | Link row: relation, clickable ID, status, origin |
| **`.lk > details`** (+ `summary`) | A disclosure inside a link row always takes its own full-width line (`flex: 1 1 100%`). Used by the drift rows |
| `.chipBtn` (+ `.on` or **`[aria-pressed="true"]`**) | Toggle chip; on = solid violet |

### Trace view (the Trace view)

| Class | Use |
| ----- | --- |
| `.trace` | 3-column grid `230px / 1fr / 340px`, one column below 1100px |
| `.picker` | Left panel (sticky). `.picker input` is the search box |
| `.grp` | Picker group heading |
| `.pick` (+ `.on` or **`[aria-selected]`**) > `.mono` | Picker item button |
| `.canvasWrap` | Centre scroll container |
| `.canvasHead` > `.t`, `.legend` | Graph header. `.legend i` = edge swatch; `i.d` dashed, `i.a` amber, **`i.s`** violet (selected) |
| `.canvas` | Flex row of lanes; must be `position:relative`, because the SVG is absolutely placed inside it |
| `.lane` > `.laneHead` | Swim lane column and its heading |
| `.node` (+ `.sel` or **`[aria-current="true"]`**) > `.id`, `.lb`, `.badges` | Node card button |
| **`.ln-req` `.ln-nfrd` `.ln-us` `.ln-ac` `.ln-br` `.ln-des` `.ln-code` `.ln-test`** | Node stripe colour per lane. Replaces the spec's inline `border-left-color`. Keys match the spec's `LANES[i][0]` |
| `svg.links` | Absolute SVG overlay inside `.canvas` |
| `svg.links path` or **`.edge`** | Default edge: `--edge`, width 1.2, full opacity |
| **`.hot`** (alias **`.sel`**) | Edge touching the selected node: violet, width 2 |
| **`.derived`** | Dashed `5 4` (origin `derived:*`) |
| **`.deferred`** | Amber stroke. Wins the colour over `.hot`; the width from `.hot` stays |
| **`.dim`** | Optional fade (opacity .35); below 3:1 by design |
| `.detail` > `h3`, `.ty`, `.txt`, `h4` | Right panel (sticky) |
| `.why` > `b`, `.sev`, `.q`, `.a` | Why-it-exists card (ref, stage, question, answer). Links and `button.open` inside it use `--violet-ink` |
| `.src` > `a` or **`button.open`** | Source file link. In the extension, use `button.open data-open="path"`, which the host opens in an editor; the GitLab `<a>` is not ported. Breaks anywhere (`word-break: break-all`), for long paths |

Edge markup example (geometry as attributes, look as classes, no `stroke=` attributes needed):
```html
<path class="edge hot derived" d="M… C…"/>
```

### Coverage view (the Coverage view)

| Class | Use |
| ----- | --- |
| `.cov` | View wrapper; scopes `.idlink`. It has no rules of its own |
| `.covTools` | Chip bar (`.chipBtn` children) |
| `.tableWrap` | Scroll box, max 70vh; the `th` stays sticky inside it |
| `table`, `th`, `td` | Element styles; `th` is sticky with an opaque background |
| `tr.row` | Clickable row (add `tabindex="0"` for keyboard use; the focus ring is styled) |
| `td.c`, **`th.c`** | Centred count column. `th.c` replaces the spec's inline `text-align:center` |
| `.cell0`, `.cellN` | Zero or non-zero count chip. Padding is now in the class (the spec had inline `padding:1px 7px`) |
| `td.mono` > **`button.idlink`** | ID cell: `<td class="mono"><button type="button" class="idlink" data-go="FR2.2">FR2.2</button></td>`. Looks like the spec's bold mono ID: inherited font and colour, no wrap, `word-break: normal`. Underlined only on hover or keyboard focus. Styled as `.cov .idlink` |

### Reviews & rework view (the Reviews view)

| Class | Use |
| ----- | --- |
| `.grid2` | 2-column grid, one column below 1100px |
| `.rev` > `.d`, (stage), `.v`, `.sev` | Verdict row: date, stage, pill, finding counts. At 640px or less: two columns, the pill keeps its own width (`justify-self: start`), and the counts wrap to their own line |
| `.rev .src button.open` / `a` | Stage link inside a review row. Wraps at word boundaries (`word-break: normal; overflow-wrap: anywhere`), overriding the break-anywhere rule `.src` uses for paths |
| `.v.R`, `.v.N` | READY (green) and NOT-READY (red) pill |
| `.jump`, `.flist`, `.note`, `.sev` + **`.mt8`** | Backward-jump card. `.mt8` replaces the inline `margin-top:8px` |
| `.lk` > `button`, `.sev`, **`details`** | Drift rows; the `<details>` takes its own full-width line |

### About view (the Reviews view)

| Class | Use |
| ----- | --- |
| `.about` (+ `h3`, `ul`, `li`) | Prose panel, max 980px |
| `.warn` | The "FOR AI AGENTS" callout |
| `.sev` | Footer line |

## Utility classes (for values the spec wrote inline)

| Class | Effect | Replaces |
| ----- | ------ | -------- |
| `.w0` … `.w100` | `width: N%` (whole percents) | `style="width:N%"`. Round with `Math.round`, then clamp to 0..100, as `credits-page.js` `bar()` does |
| `.bar` > `.bar-fill.wNN` (+ `.ok` / `.def` / `.bad`) | Proportion bar, the same pattern as credits-page | Inline-width bars (optional; the spec has none) |
| `.mt0` `.mt4` `.mt8` `.mt14` `.mb0` | Margins | `style="margin-top:…"` on `.stamp` and `.sev` |
| `.ta-c` `.ta-r` | Text alignment | Inline `text-align` |
| `.nowrap` | `white-space: nowrap` | |
| `.sr-only` | Visually hidden, still read by screen readers | |
| `.ln-*` | Lane stripe colours | Inline `border-left-color` |
| `.edge` modifiers | SVG stroke colour, width, dash, opacity | `stroke=`, `stroke-width=`, `stroke-dasharray=`, `opacity=` attributes |

Each inline style in the spec, and the class that replaces it:

| Spec inline style | Replacement |
| ----------------- | ----------- |
| `.node style="border-left-color:…"` | `.ln-<lane>` |
| `<path stroke=… stroke-width=… stroke-dasharray=… opacity=…>` | `class="edge [hot] [derived] [deferred]"` |
| `<th style="text-align:center">` | `th.c` |
| `<span class="cellN" style="padding:1px 7px">` | `.cellN` / `.cell0` (padding built in) |
| `<p class="stamp" style="margin-top:8px">` | `.stamp.mt8` |
| `<div class="sev" style="margin-top:8px">` | `.sev.mt8` |
| `<div class="panel box" style="margin-top:14px">` | `.box + .box`, or `.mt14` |
| `<div class="note" style="background:var(--amber-soft)">` | `.note.drift` |

SVG attributes (`d`, `width`, `height`) are not styles, so the CSP allows them. Only geometry
should go there.

## Accessibility and motion

- Every interactive element uses `:focus-visible` with a `--vscode-focusBorder` ring. Node cards get
  a 2px ring with an offset, and tabs an inset ring. High contrast uses a 2px dashed
  `--vscode-contrastActiveBorder` ring.
- The ARIA state attributes (`aria-selected`, `aria-pressed`, `aria-current`) are styled the same
  as the spec's classes, so views can use either.
- `prefers-reduced-motion: reduce` turns off all transitions and animations and the node hover lift.
- Secondary and accent-coloured text, and edges, are mixed toward `--strong` to meet the targets
  above.

## Design decisions

1. **Card vs background.** `--card` maps to `editorWidget-background`, so in the light theme the
   cards are slightly grey on a white editor. That is the reverse of the spec (white on grey), but
   the cards look native next to VS Code's own widgets, and in dark themes they are lifted above
   the editor.
2. **Opaque tints.** The `*-soft` colours and `--bg3` mix into `--card` rather than `transparent`,
   so the sticky table header and the nodes drawn over SVG edges never let content show through.
3. **Teal** has no `charts-*` token, so it uses `terminal-ansiCyan`. Links use `textLink-foreground`
   instead of teal, to match the rest of the editor; the fallback is a darkened teal.
4. **Red** uses `charts-red` rather than `errorForeground`. A "Not met" verdict is a data value,
   not an editor error, and `charts-red` sits closer to the spec's burnt orange.
5. **`--strong` as mix target.** Contrast is fixed by mixing toward the editor foreground rather
   than by per-theme hex values, so one rule works in light, dark and custom themes. The cost is
   that `--muted` and `--dim` sit closer together than in the spec, so hierarchy leans more on
   size and weight.
6. **Body font size** is 13px (VS Code's default); the spec's explicit pixel sizes are kept for
   every component.
7. **`.canvasHead`** is `position: sticky; left: 0`, so the title and legend stay visible while
   the lanes scroll sideways.
8. An extra breakpoint at 640px stacks the review rows for narrow editor groups.
