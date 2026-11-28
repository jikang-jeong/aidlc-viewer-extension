# Cross-Unit Traceability: inventory-api

Source: `aidlc engine sensor-traceability --stage build-and-test` (run 2026-11-10). One Unit: `inventory-api`.

**Verdict: FAIL.** 2 of 64 traced IDs are uncovered: NFR1 and NFR3. In both cases the parent group is uncovered only because some of its children were Deferred at NFR Requirements and are not built. Every functional requirement and every acceptance criterion is covered.

## Uncovered

| ID | Owning stage / Unit | Not built | Why |
|---|---|---|---|
| NFR1 | nfr-requirements / inventory-api | NFR1.5 (latency and throughput SLO), NFR1.10 (capacity numbers), NFR1.16 (numeric RTO, RPO and MTTR) | Deferred at NFR Requirements: no numeric target at MVP; performance testing is deferred by the team |
| NFR3 | nfr-requirements / inventory-api | NFR3.8 (emitted metrics baseline), NFR3.9 (distributed tracing) | Deferred at NFR Requirements: latency is in the logs; single service with no downstream calls |

## Functional requirements (all covered)

| ID | Covered through |
|---|---|
| FR1.1, FR1.2 | AC1.1.1 to AC1.1.5 |
| FR1.3 | AC1.2.1, AC1.2.2 |
| FR1.4 | AC1.3.1 to AC1.3.3 |
| FR1.5 | AC1.4.1 to AC1.4.3 |
| FR1.6 | AC1.5.1, AC1.5.2 |
| FR2.1, FR2.3, FR2.4, FR2.5 | AC2.1.1 to AC2.1.6 |
| FR2.2 | AC2.2.1, AC2.2.2 |
| FR3.1, FR3.2 | AC3.1.1 to AC3.1.3 |

## Non-functional groups

| ID | Covered | Through (inventory-api) |
|---|---|---|
| NFR1 | No | NFR1.1 to NFR1.16. Not built: NFR1.5, NFR1.10, NFR1.16 |
| NFR2 | Yes | NFR2.1 to NFR2.5 |
| NFR3 | No | NFR3.1 to NFR3.9. Not built: NFR3.8, NFR3.9 |
| NFR4 | Yes | NFR4.1, NFR4.2 |

## Acceptance criteria and target files (all covered, Unit inventory-api)

| AC | Built in |
|---|---|
| AC1.1.1 | `src/items/item-handlers.ts` |
| AC1.1.2 | `src/items/item-repository.ts` |
| AC1.1.3, AC1.1.4, AC1.1.5 | `src/items/item-validation.ts` |
| AC1.2.1, AC1.2.2 | `src/items/item-service.ts` |
| AC1.3.1 | `src/items/item-repository.ts` |
| AC1.3.2 | `src/items/item-validation.ts` |
| AC1.3.3 | `src/items/item-repository.int.test.ts` |
| AC1.4.1, AC1.4.2 | `src/items/item-repository.ts` |
| AC1.4.3 | `src/items/item-validation.ts` |
| AC1.5.1 | `src/items/item-repository.ts` |
| AC1.5.2 | `src/items/items-api.int.test.ts` |
| AC2.1.1 to AC2.1.4 | `src/stock/stock-repository.ts` |
| AC2.1.5 | `src/stock/stock-validation.ts` |
| AC2.1.6 | `src/stock/stock-api.int.test.ts` |
| AC2.2.1, AC2.2.2 | `src/stock/stock-adjustment.race.int.test.ts` |
| AC3.1.1, AC3.1.2 | `src/shared/http/error-envelope.ts` |
| AC3.1.3 | `src/shared/http/error-envelope.test.ts` |
| AC4.1.1 | `src/shared/validation.ts` |
| AC4.2.1 | `src/health/health-handler.ts` |
| AC4.2.2 | `src/shared/logging/request-logger.ts` |

NFR1.9 counts as covered here because code generation built it (`src/items/item-repository.ts`). At runtime it is still Not Met in the Target Verification Matrix: the COUNT scan grows with the table.
