# Trace data model

Owner: the data reader. Module: `extension-source/src/aidlc/trace-data.js`.
Tests: `extension-source/tests/trace-data.test.js`.

```js
const { readTraceData } = require('./aidlc/trace-data');
const data = readTraceData(projectRoot, { intent: '260825-inventory-api' }); // intent and space are optional
```

`readTraceData` is a pure Node function that only reads files and never throws. It returns
`{ meta, repo, nodes[], edges[], reviews[], jump|null, drift[] }`. The JSDoc typedefs at the top
of the module (`TraceNode`, `TraceEdge`, `Review`, `Jump`, `Drift`, `TraceMeta`, `TraceData`) are
the contract. The engine's files are the source of truth. The design-spec HTML was used only to
compare results (see the last section).

General rules:

- **Paths** are project-relative POSIX paths, for `node.path`, `edge.origin`, `review.file`,
  `jump.*` and `meta.sources`. The host can open any of them after checking the path stays
  inside the root. `repo` is the absolute project root.
- **Missing or malformed input** produces a partial result and a line in `meta.warnings`. A
  coverage row with status `GAP`, or an `upstream_ids` entry with no coverage row, goes into
  `meta.gaps` and creates no edge.
- **Omitted fields** are listed in `meta.omitted[]` with a reason (see the end of the matrix).
- **Intent selection.** The reader uses `options.intent` (matched against the directory name or
  slug). If none is given it uses the only intent, or the last one by name with a warning. Spaces
  and intents are listed with `runtime.js`.

## 1. Graph merge logic (the 8 `traceability.json` files)

Every `traceability.json` under the intent is read in path order, skipping dot folders and
`audit/`. All files have the same shape, but what `target` means depends on the stage, as set
out in the stage specs under `.kiro/aidlc-common/stages/`. The reader encodes this in
`STAGE_RULES`:

| Stage (file) | Source ID | `OK` target means (stage spec) | Edge relation | Target node |
|---|---|---|---|---|
| user-stories | FR / NFR | one or more `USx.y`, comma-separated | `realized_by_story` | user_story |
| domain-design | US | component name(s) | `owned_by_component` | component |
| units-generation | US | Unit ID or construction dir | `built_in_unit` | unit |
| functional-design (per unit) | AC | one or more `BRx.y` | `refined_by_rule` | business_rule |
| nfr-requirements (per unit) | NFR | `NFRx.y` list | `refined_by` | nfr_detail |
| nfr-design (per unit) | NFRx.y | free-text design (any status) | `designed_as` | design_decision `design:<stage>:<id>` |
| infrastructure-design (per unit) | NFRx.y | free-text design (any status) | `designed_as` | design_decision `design:<stage>:<id>` |
| code-generation (per unit) | AC / NFRx.y / BR | one existing workspace-relative file | `implemented_in`, or `verified_by_test` when the file matches `*.test.*` / `*.spec.*` | code / test (id = path) |

Rows that are not `OK`:

- `Deferred` whose target is a known stage slug becomes a `deferred_to` edge to `stage:<slug>`.
  Known slugs come from the stage spec file names and from `runtime-graph.json`.
- Any other `Deferred` or `N/A` text becomes a note node `note:<id>:<stage>`, linked by
  `deferral_note` or `na_note`.
- For ID, name and path stages, an `OK` row whose target does not parse is shown as a note and
  produces a warning.
- An unknown status is kept as written and treated like a non-OK row.
- An unknown stage produces a warning and its targets are read as free text (`traces_to`).

Merging:

- **Nodes** are keyed by ID across all files. The type comes from the ID pattern (`FR`, `NFR`
  without a dot, `NFRx.y`, `US`, `AC`, `BR`, `Un`) or, failing that, from the stage rule.
- **Edges** are deduplicated on `(source, target, relation, origin)`. The same link stated by two
  files is kept twice, once per origin.
- **Design decisions and notes** that two units write for the same `(stage, id)` get a `:<unit>`
  suffix, so they never collide.
- **`reverse` rows** are attached to existing nodes as `notes[]`. They are not edges and they never
  create nodes.

Every edge carries `origin`, which is either the traceability file or `derived:<rule>`. Edges from
a file also carry `stage` and `unit`.

**Convention rules** (`meta.derived_edge_rules`; edges also carry `derived: true`):

1. `derived:id-convention`: `USx.y -has_acceptance_criterion-> ACx.y.z` when both nodes exist.
2. `derived:file-name-convention`: code `dir/x.ext -tested_by->` a test file at one of
   `dir/x.test.ext`, `dir/x.int.test.ext`, `dir/x.spec.ext`, `dir/__tests__/x.test.ext`,
   `../test/x.test.ext` or `../tests/x.test.ext`, if that file exists.

**Test nodes** are the code-generation test targets plus every `*.test.*` / `*.spec.*` file in
the project tree. The walk skips dot folders, `node_modules`, `aidlc`, `dist`, `build`, `out`,
`coverage` and `cdk.out`, and stops after 20k files. Untraced tests are therefore visible, with
degree 0. **Code nodes** come only from traceability targets, and `exists` flags targets that are
not on disk (`.github/dependabot.yml` in the fixture).

## 2. Derivability matrix

| Field | Source file | Rule | When it cannot be derived |
|---|---|---|---|
| `nodes[].id`, `type` | `**/traceability.json` | coverage `id` and parsed targets; type from the ID pattern or the stage rule | type `unknown` + warning |
| `nodes[].label`, `text`, `path`: FR | `inception/requirements-analysis/requirements.md` | `- **FRx.y** text` bullet, citations `[..]` stripped | label/text = ID, path = first traceability file |
| NFR (group) | same | `- **NFRn — Title.** text`: label = Title, text = body | same |
| user_story | `inception/user-stories/stories.md` | `### USx.y — Title (Priority) — refs`: label = Title, `priority`, text = first paragraph | same |
| acceptance_criterion | same | `- **ACx.y.z** text` | same |
| business_rule | `construction/<unit>/functional-design/rules.md` | yaml block `statement`, `category` → `kind`; label from the "Rules Summary" table | same, + warning if there is no yaml block |
| nfr_detail | `construction/<unit>/nfr-requirements/*-requirements.md` | table row whose first cell is the ID; `category` = file prefix | same |
| component | `inception/domain-design/components.md` | first table keyed by `Component`: text = Purpose | same |
| unit | `inception/units-generation/unit-of-work.md` | `Unit ID` table: label = Name, `kind` = Kind | same |
| design_decision / note | the traceability file | label = text = coverage `target`; `stage`, `unit` | n/a |
| code / test | the target path / project tree | label = basename; `exists` | n/a |
| `nodes[].verdict`: FR, AC, NFR group | `construction/build-and-test/cross-unit-traceability.md` | ID cell (ranges `AC1.1.1 to AC1.1.5` and lists expanded) in a "covered" section → `Covered`; "Uncovered" section, or `Covered = No`, → `Not covered` | absent |
| `nodes[].verdict`: NFR detail | `construction/build-and-test/test-results.md` "Final target verdicts" | `- <Verdict>: id, id/id, …` → verdict as written (`Met`, `Not Met`, `Unverified`, `N/A`) | falls back to the next rule |
| | `nfr-requirements/traceability.json` `reverse` | status `Deferred` → `Deferred` | absent |
| `nodes[].verdict`: superseded by a later stage | `construction/<stage>/*.md` (not build-and-test), tables with `Before this stage` / `After this stage` columns (`ci-pipeline/quality-gates.md`) | applied only when the Before cell starts with the node's current verdict. The verdict becomes the After cell up to the first `(` or `;`, and `verdictPrior` keeps the old one | unchanged |
| `nodes[].verdictSource` | whichever of the above set it last | | absent |
| `nodes[].verdictNote` | test-results.md (the text after the ID in its bullet, parentheses removed), or the full After cell | | absent |
| `nodes[].verdictAccepted` | test-results.md: bullets under `**Decision: Accept failure.**` | `true` for each ID listed there | absent |
| `nodes[].why`: FR, NFR | `requirements.md` + `requirements-analysis-questions.md` | each `[Qn]` in the bullet → `{ref, stage, q: heading, a: [Answer]:}`; a single-letter answer is expanded to its option text; other `[slug]` → `{ref, stage:'upstream artifact'}` | `q`/`a` absent if the question is not found; `why` absent if there are no citations |
| `nodes[].why`: BR | `rules.md` yaml `source:` | `contract Qn` → `inception/contract-design/contract-design-questions.md`; bare `Qn` → the unit's `functional-design-questions.md`; `OQn` → `requirements.md` Open Questions text | same |
| `nodes[].notes` | traceability `reverse` rows | attached to an existing node | absent |
| `nodes[].rework` | audit `STAGE_JUMPED` | `true` when `node.path` is in `jump.invalidated` | `false` |
| `edges[]` | traceability `coverage` + 2 convention rules | §1 | row skipped + warning/gap |
| `reviews[]` (engine) | `.aidlc-engine/reviews/<stage>/{units/<unit>,stage}/<attempt>/<n>.json` (not `briefs/`) | verdict, iteration, reviewer, attempt, findings; `date` = `**Date:**` in `body`, else `recorded_at`; severity counts from `findings`; `open` = New/Unresolved | record skipped + warning |
| `reviews[].file` | `<stage>/reviews/review-NN.md` | the markdown mirror whose `**Date:**` equals the JSON's | the JSON path |
| `reviews[].line` | the markdown in `file` | 1-based line of the `## Review` heading (1 for engine mirrors) | absent |
| `reviews[]` (markdown) | any intent `*.md` with a `## Review` section | used only when no engine JSON exists for the same `(stage, date)`. Verdict/Date/Iteration/Reviewer from `**X:**` lines; severity counts from Findings tables with a Severity column; `open: null` | not listed |
| `jump` | `audit/*.md` | latest `STAGE_JUMPED` with `Direction: BACKWARD`; `changed`, `invalidated`, `invalidated_reviews` parsed from the JSON arrays; `reason` = title of the latest `## Change Request` record before it, else `**Details**`; `request`, `impact` from the same record | `null`; a warning if there is more than one jump |
| `drift[]` | engine review JSON | findings with status `New`/`Unresolved` in the **final** review of each `(stage, unit)` by `recorded_at`. `ids` = graph IDs named in `location`, else in `finding`; `file` = first path in `location` that exists | `[]` |
| `meta.sources` | | every file whose contents were read, including the intent's `runtime-graph.json` | |
| `meta.listedDirs` | `.kiro/aidlc-common/stages/` | directories whose entry names were used, with a trailing `/`. The stage specs are listed for their file names (known stage slugs), not read, so they are not in `sources` | `[]` |
| `meta.stageOrder` | `<intent>/runtime-graph.json` | `stages[].stage_slug` in file order; entries that are not strings and duplicates are dropped. Views use it to order stages instead of hard-coding them | `[]` when the file is missing or malformed (+ warning if malformed) |
| `meta.omitted` | | see below | |

### Deliberately omitted (`meta.omitted`)

| Field | Reason |
|---|---|
| `gitlab` | No git remote is recorded in the project files, and the reader does not run git. |
| `nodes[].gitref` | Needs git history. |
| `why` on US, AC, NFR detail, component, unit, design decision, code, test | These artifacts have no citation the reader can resolve. |
| `verdict` on US, BR, component, unit, design decision, note, code, test | Build-and-test gives verdicts only for FR, AC, NFR groups and NFR details. Test results are aggregate per command, not per file. |
| drift as "documentation drift" | The engine keeps no drift record. `drift[]` is the deterministic proxy, open findings at approval. Deciding which of them are stale documents is a human reading. |
| edge `rework` | The jump invalidates files, not links. |

## 3. Comparison with the design spec's `DATA` (inventory-api)

| Measure | HTML `DATA` | `readTraceData` | Note |
|---|---|---|---|
| nodes | 216 | 216 | same ID set |
| by type | FR 13, nfr 4, nfr_detail 32, US 10, AC 29, BR 16, component 2, unit 1, design_decision 64, stage 1, note 5, code 16, test 23 | identical | |
| edges | 286 | 286 | identical `(source, target, relation, status)` set |
| by relation | realized_by_story 16, deferred_to 1, owned_by_component 10, built_in_unit 10, refined_by_rule 35, refined_by 32, designed_as 64, implemented_in 63, verified_by_test 9, deferral_note 5, has_acceptance_criterion 29, tested_by 12 | identical | |
| edge status | OK 261, Deferred 17, N/A 8 | identical | |
| reviews | 21 | 21 (10 engine JSON + 11 markdown) | severity counts identical for every review |
| jump | 1 | 1 | same files |
| drift | 3 | 37 | see below |

Every remaining difference, and why:

1. **`edge.origin`.** The HTML uses a stage name (`code-generation`) or a free label
   (`ID convention (derived)`). The reader uses the project-relative file, or
   `derived:id-convention` / `derived:file-name-convention`, as the contract requires. The stage
   is in `edge.stage`.
2. **Paths.** HTML `review.file` is intent-relative and `repo` points at the author's machine.
   The reader's paths are project-relative and `repo` is the opened root.
3. **Labels.** In six nodes the HTML normalised characters (`≤` → `<=`, `→` → `->`, backticks
   dropped). The reader keeps the source text.
4. **U1 label.** The HTML has "inventory-api (single unit)". The reader takes `Name` from the
   unit table ("inventory-api") and adds `kind: service`.
5. **NFR group verdicts.** The HTML has "See sub-NFRs" for all four. The reader gives
   `cross-unit-traceability.md`'s verdict: NFR1 and NFR3 `Not covered` (because children are
   deferred), NFR2 and NFR4 `Covered`.
6. **NFR detail verdict wording.** The HTML has `Not met (accepted)` and `Unverified (needs
   production traffic)`. The reader keeps the verdict word exactly as test-results.md writes it
   (`Not Met`, `Unverified`), so badges stay a small fixed vocabulary. The qualifier goes into
   separate fields, both from test-results.md:
   - NFR1.9: `verdictNote` = "The COUNT scan for `total` grows with table size; this was
     accepted at NFR Design.", `verdictAccepted: true` (it is listed under "Decision: Accept
     failure").
   - NFR1.11: `verdictNote` = "99.9% over 30 days needs production traffic",
     `verdictAccepted: true`.

   A view can render "Not Met (accepted)" from these fields without making any text up.
7. **NFR4.2.** The HTML has "Met (first GitLab pipeline run, 2026-11-16)". test-results.md says
   `N/A` (owned by CI Pipeline). `construction/ci-pipeline/quality-gates.md` ("Coverage of the
   stage's targets") then takes the target over: Before "N/A (owned by CI Pipeline)", After "Met
   by configuration (G1, G2); Dependabot replaced by `npm audit` (Q4)". So the reader shows
   `Met by configuration`, with that file as `verdictSource`, the After cell as `verdictNote`, and
   `verdictPrior: {verdict: 'N/A', …}`. No file records a real pipeline run or the date
   2026-11-16. `ci-config.md` says the opposite ("No real pipeline run yet … met by configuration
   only until the first merge-request pipeline passes"), and `verification/phase-check-construction.md`
   agrees. The HTML's wording seems to come from a later conversation, outside the engine record
   (the person's chat mentions a CI probe pipeline in a throwaway branch), so the reader does not
   use it.
8. **`why` on BR1.4.** The reader keeps the source order (`OQ1, Q11`). **BR6.1** gets `Q7, Q8`
   because rules.md says `source: contract Q7, contract Q8`; the HTML lists Q7 only. Reader `why`
   entries may also carry `path`, and OQ entries carry the open-question text as `q`.
9. **Review fields.** `iteration` is a number, not a string. `date` is the ISO timestamp, not
   `YYYY-MM-DD HH:MM`. The reader adds `unit`, `reviewer`, `attempt`, `source`, `sourceKind`,
   `open` and `findings[]`.
10. **Jump.** `ts` is ISO. `reason` is the change-request title ("Cognito auth plus review fixes,
    back to Contract Design"); the HTML's sentence is a paraphrase written by another tool. The
    reader adds `direction`, `details`, `request`, `impact` and `origin`.
11. **Drift (3 vs 37).** The HTML's three entries were picked by hand from nfr-requirements
    finding R-01, which the reader also returns, with `ids: [NFR2.3, NFR2.4]` and the
    `security-requirements.md` file. The reader lists all 37 findings left New or Unresolved in
    each stage's final review: code-generation 5, contract-design 7, functional-design 7,
    infrastructure-design 7, nfr-requirements 5, nfr-design 6. Each entry carries `severity`, so
    the view can filter. The list includes engine bookkeeping findings such as "findings table
    could not be read" (R-00). The view should title the section "Open findings at approval"
    rather than claim they are all drift.
12. **`gitref`** on `.github/dependabot.yml` is omitted (no git). The reader flags the node
    `exists: false` because the file is not in the fixture.
13. **Fields the reader adds:** `nodes[].verdictSource`, `verdictNote`, `verdictAccepted`,
    `verdictPrior`, `notes`, `exists`, `unit`; `reviews[].line`;
    `meta.warnings`, `gaps`, `omitted`, `counts`, `intentPath`, `space`, `stageOrder`, `listedDirs`.

On the fixture the reader produces no warnings and no gaps. It reads 51 files (`meta.sources`) and lists 1 directory and takes about
100 ms.
