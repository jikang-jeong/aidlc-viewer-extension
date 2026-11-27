# Test Results: inventory-api

Run: 2026-11-10 (UTC 11:27 to 11:28), macOS, Node v23.11.0, npm 11.6.2, branch `feat/cognito-auth-build` at `0bee842`. DynamoDB Local `amazon/dynamodb-local:3.1.0` ran through `finch compose` on 127.0.0.1:8000 and was stopped after the run. `AWS_PROFILE` was unset.

## Build

| Command | Exit | Result |
|---|---|---|
| `npm run build` | 0 | `dist/lambda.mjs` 763.0 KB |
| `npm run lint` | 0 | 0 errors, 3 warnings (`security/detect-object-injection`) |
| `npm run format:check` | 0 | All matched files use Prettier code style |
| `npm run typecheck` | 0 | No errors |
| `npm run synth` | 0 | Synthesized `InventoryApiData-staging`, `InventoryApiAuth-staging` and `InventoryApiCompute-staging`; cdk-nag passed |

## Tests

Each distinct command from `inventory-api/code-generation/unit-test-instructions.md` ran once.

| Command | Exit | Files | Tests (total / passed / failed / skipped) |
|---|---|---|---|
| `npx vitest run --project inventory-api-unit` | 0 | 13 | 102 / 102 / 0 / 0 |
| `npx vitest run --project inventory-api-integration` | 0 | 6 | 45 / 45 / 0 / 0 |
| `npx vitest run --project inventory-api-infra` | 0 | 4 | 29 / 29 / 0 / 0 |
| `npx vitest run --project inventory-api-unit --project inventory-api-integration --project inventory-api-infra --coverage` (the full suite for the project-wide floor) | 0 | 23 | 176 / 176 / 0 / 0 |
| `npm run smoke` | not run | n/a | Needs a staging deployment; this plan has no deployment stage |

Failures: none. No test failed or errored.

## Coverage (full-suite run, v8, `thresholds.lines: 80`)

| Metric | Value |
|---|---|
| Lines | 96.12% |
| Statements | 96.26% |
| Branches | 86.75% |
| Functions | 98.07% |

The floor of 80% lines is met. The command exited 0, so the threshold did not trip.

## Final target verdicts

The full matrix is in `build-and-test-summary.md`, under `## Target Verification Matrix`.

- Met: TC-COV, TC-VOL, TEAM-GATES, TEAM-RACE, TEAM-INT-REAL, NFR1.1, NFR1.2, NFR1.3, NFR1.4, NFR1.6, NFR1.7, NFR1.8, NFR1.12, NFR1.13, NFR1.14, NFR1.15, NFR2.1, NFR2.2, NFR2.3, NFR2.4, NFR2.5, NFR3.1/NFR3.5, NFR3.2, NFR3.3, NFR3.4, NFR3.6, NFR3.7, NFR4.1
- Not Met: NFR1.9. The COUNT scan for `total` grows with table size; this was accepted at NFR Design.
- Unverified: TC-SMOKE (no staging deployment) and NFR1.11 (99.9% over 30 days needs production traffic).
- N/A: TC-CI and NFR4.2. CI Pipeline, later in this plan, sets up CI to run these tests and scans before merge.

## Failure handling

The stage's rule counts this run as failed, because NFR1.9 is Not Met and TC-SMOKE and NFR1.11 are Unverified. Every command passed.

- Rung 1, in-stage fix: not applicable. No test configuration, build script or environment setup is at fault. TC-SMOKE would need a real AWS staging deployment, which changes live infrastructure and needs the person's go-ahead. NFR1.11 cannot be measured before launch.
- Rung 2, classification: NFR1.9 traces to an approach chosen at design and code generation (the COUNT scan in `src/items/item-repository.ts`). The candidate fix is a maintained item-count record updated in the same `TransactWriteItems` as create and delete; `total` then reads one item. Estimated impact:
  - Effort: about half a day, including changes to the repository and its tests.
  - Cost: negligible (one extra write unit per create or delete).
  - Risk: medium. Create and delete become transactions, and the counter must stay correct under concurrent writes; a race test would be needed.
  - TC-SMOKE and NFR1.11 have no fix in code.
- Rung 3, autonomous loop-back: not taken. Construction Autonomy Mode is not set, so the mode is gated.
- Rung 4, halt-and-ask: presented to the person on 2026-11-10. **Decision: Accept failure.** The gaps below are accepted as known for this release, and the stage goes to its approval gate:
  - NFR1.9 is Not Met. The upgrade path is a maintained count item plus cursor paging.
  - TC-SMOKE is Unverified. It runs once staging is deployed (the CI/CD design runs it after each staging deploy).
  - NFR1.11 is Unverified. It needs production traffic to measure.

  No quality target was lowered or removed.

## Loop-Back Log

None so far.
