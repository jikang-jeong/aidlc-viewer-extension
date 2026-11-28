# inventory-api reference fixture

This folder is a small AI-DLC v2 project layout used by the Trace Explorer tests
(`tests/trace-data.test.js`, `tests/inventory-fixture.test.js`, and the view, panel and wiring tests).
It holds one completed intent, `aidlc/spaces/default/intents/260825-inventory-api/`, for a demo
inventory REST API.

It is **trimmed** from a full project run and **scrubbed** for publication.

- **Trimmed.** The folder keeps only the files the Trace Explorer reader (`src/aidlc/trace-data.js`)
  reads, plus the files the tests open directly:
  - the 8 `traceability.json` files and the markdown files that define the IDs
  - `runtime-graph.json`, `aidlc-state.md` and `intents.json`
  - the engine review records under `.aidlc-engine/reviews/` and the `reviews/review-NN.md` files
  - `package.json` and `AGENTS.md`

  The audit shard under `audit/` keeps its file name but holds only the two records the reader uses:
  the "Change Request" record and the STAGE_JUMPED record that follows it.
- **Scrubbed.** Personal names, local paths, internal hosts, account ids and email addresses are
  removed or replaced with neutral placeholders such as `<user>` and `example.com`. Free-text human
  input is replaced with short neutral summaries:
  - the change request's Request, Impact Assessment and Confirmation fields
  - the project line in `aidlc-state.md`
  - the rationale after each answer in the requirements questions file

  IDs, statuses, timestamps and file structure are unchanged.
- **Empty placeholders.** These files are empty and exist only so their names and paths can be found:
  - the code and test files under `src/`, `infra/` and `test-support/`
  - the stage specs under `.kiro/aidlc-common/stages/`
  - the sensor reports under `.aidlc-sensors/`
  - some design markdown that review findings point at

  The reader lists these files by name (for code, test and stage nodes, and for `exists` checks) and
  never reads their contents.

`tests/fixtures/inventory-api-expected.json` holds the facts computed from this folder by
`tests/helpers/inventory-fixture.js`. Run `node tests/helpers/inventory-fixture.js --write` after
a deliberate change, then review the diff.
