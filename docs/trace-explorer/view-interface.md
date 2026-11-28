# View interface 

How the four view modules plug into the panel.

- **Signature:** `renderX(data, indexes, state) → string` (HTML), exported through the wrapper in
  `this document` as `AidlcTrace.renderTrace / renderCoverage / renderReviews / renderAbout`.
- **state:** `{ tab, selected, covMode: 'fr'|'nfr'|'br', query }` (a copy; views never mutate it).
- **indexes:** from `AidlcTrace.buildIndexes(data)`: `{ byId, out, in, nodes, edges }` (null-prototype
  objects). Graph helpers in `media/trace-explorer/lib/graph.js`: `bfs`, `subgraph(indexes, id) →
  {selectedId, up, down, nodeIds, edges, lanes[{key,label,types,nodes}]}` (null for unknown id),
  `downstreamCounts`, `natural`, `shortId`, `shortLabel`, `verdictClass`, `isDerived`, `esc`, `LANES`, `laneOf`.
- **Events (handled by main.js; views only emit attributes):** `data-select="<id>"` select and stay;
  `data-go="<id>"` select and switch to Trace; `data-open="<path>"` (+ optional `data-line`) open a file;
  `data-mode="fr|nfr|br"` coverage mode; `data-query` on the picker input. Non-button elements with an
  action need `tabindex="0"` (Enter/Space trigger them).
- **After-render hook (optional):** `AidlcTrace.afterRenderTrace(container, data, indexes, state)` etc.,
  run after the HTML is inserted, for DOM-measured work such as SVG edge paths. main.js adds no resize
  listener; the trace view adds its own if needed and must not leak listeners across renders.
- **Styling:** class names and utilities in `css-mapping.md` (lane stripes `ln-*`,
  `path.edge[.hot][.derived][.deferred]`, width buckets `w0..w100`, `.banner`). No `style=` attributes.
- **Data:** shape and caveats in `data-model.md` (edges carry `origin`, `stage`;
  `meta.omitted`, `meta.warnings`, `meta.gaps`; drift = open findings at approval, 37 entries).
- **Preview:** `cd extension-source && node tools/trace-preview.js ../tests/fixtures/inventory-api/`
  (add `?theme=dark` or `?theme=hc`). Headless Chrome is available for screenshots.
