# Refined Mockups — API Endpoint Sketches (developer-experience form)

> This is an API-only initiative with no user-facing UI, so (per the established
> project rule) the refined "mockups" are concrete endpoint sketches and
> request/response examples — the developer experience — rather than screen
> wireframes. These sketches refine the upstream rough-mockups system-context
> diagram ([wireframes]) and interaction flows ([user-flow]) into per-operation
> request/response shapes, and realize the user stories ([stories]) and
> requirements ([requirements]). Conventions follow the team's organize-by-feature
> and single-error-envelope practices ([team-practices]).

## Sources

- `wireframes` (Rough Mockups) — the system-context diagram these sketches detail.
- `user-flow` (Rough Mockups) — the CRUD and stock-adjustment interaction flows.
- `stories` (User Stories) — US1.1–US4.2, the behavior each endpoint realizes.
- `requirements` (Requirements Analysis) — FR1–FR3, NFR1–NFR3.
- `team-practices` (Practices Discovery) — feature-organized routes, single error
  envelope, typed domain errors.

These are illustrative shapes, not a binding contract; the formal contract is
produced in Contract Design. Exact `InsufficientStock` status (409 vs 422) and
`ConcurrencyConflict` visibility remain open ([stories] OQ1/OQ2); shown here as
409 provisionally.

## Resource Model

One primary resource — the inventory **item**, keyed by a client-supplied `sku`
([stories] US1.1, US1.2) with `name`, `description`, and `quantity`
([requirements] FR1.1). Quantity changes only through the adjustments sub-resource
([stories] US1.4 AC1.4.3, US2.1).

## Endpoint Sketches

### POST /items — create an item (US1.1 / FR1.1, FR1.2)

Request:
```json
{ "sku": "WIDGET-001", "name": "Blue Widget", "description": "Standard blue widget", "quantity": 20 }
```
Success `201 Created`:
```json
{ "sku": "WIDGET-001", "name": "Blue Widget", "description": "Standard blue widget", "quantity": 20 }
```
Errors: `409` duplicate SKU (AC1.1.2); `400` validation — missing field, negative
quantity, malformed SKU (AC1.1.3–AC1.1.5).

### GET /items/{sku} — get one item (US1.2 / FR1.3)

Success `200 OK`: the item object (as above).
Errors: `404` not-found (AC1.2.2).

### GET /items — list items, paginated (US1.3 / FR1.4)

Request: `GET /items?limit=20&cursor=<token>`
Success `200 OK`:
```json
{ "items": [ { "sku": "WIDGET-001", "name": "Blue Widget", "description": "...", "quantity": 20 } ],
  "nextCursor": "<token-or-null>" }
```
Errors: `400` invalid pagination param (AC1.3.2). Empty/last page returns an empty
`items` array and `nextCursor: null` (AC1.3.3).

### PUT /items/{sku} — update descriptive fields (US1.4 / FR1.5)

Request:
```json
{ "name": "Blue Widget v2", "description": "Updated description" }
```
Success `200 OK`: the updated item.
Errors: `404` not-found (AC1.4.2); `400` if the payload tries to set `quantity`
directly, with a message pointing to the adjustments endpoint (AC1.4.3).

### DELETE /items/{sku} — hard delete (US1.5 / FR1.6)

Success `204 No Content`; a subsequent `GET` returns `404` (AC1.5.1).
Errors: `404` not-found (AC1.5.2).

### POST /items/{sku}/adjustments — adjust stock by a relative delta (US2.1, US2.2 / FR2.1–FR2.5)

Request:
```json
{ "delta": -3 }
```
Success `200 OK`:
```json
{ "sku": "WIDGET-001", "name": "Blue Widget", "description": "...", "quantity": 17 }
```
Errors: `409` `InsufficientStock` when the delta would drop below zero, quantity
unchanged (AC2.1.3, provisional status per OQ1); `400` zero/non-integer/missing
delta (AC2.1.5); `404` unknown SKU (AC2.1.6). Concurrent adjustments are applied
atomically with no lost updates (US2.2 / NFR1).

### GET /health — readiness/liveness (US4.2 / NFR3)

Success `200 OK`: `{ "status": "ok" }`. Suitable for a deploy readiness probe.

## Error Envelope (all failures) — US3.1 / FR3.1, FR3.2

```json
{ "error": { "code": "InsufficientStock", "message": "Adjustment would drop stock below zero",
  "fields": [ { "field": "delta", "detail": "resulting quantity -1 is below the zero floor" } ],
  "requestId": "req-7f3a..." } }
```
`code` is drawn from a closed set (`ItemNotFound`, `DuplicateSku`,
`InsufficientStock`, `ValidationError`); `fields` is required on validation
errors (US3.1 AC3.1.1). Status mapping: `ItemNotFound`→404, `DuplicateSku`→409,
`InsufficientStock`→4xx (OQ1), `ValidationError`→400, unexpected→500 (AC3.1.2).

## Review

**Verdict:** READY
**Reviewer:** aidlc-product-lead-agent
**Date:** 2026-10-01T14:41:09Z
**Iteration:** 1
**Review class:** Advisory (single pass — findings inform the human at the approval gate; no fix-and-re-review loop)

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Minor | mockups.md Error Envelope + design-system-mapping.md Error codes | The closed error-code set is `ItemNotFound, DuplicateSku, InsufficientStock, ValidationError`. `ConcurrencyConflict` — a typed domain error named in [team-practices] Code Style — is silently absent from the set. This is the *correct* MVP position (OQ2 defers whether concurrency conflict is caller-visible, and US2.2 can be satisfied by transparent retry), but no artifact states the omission is deliberate-pending-OQ2 rather than an oversight. | Add a one-line note next to the closed set: "`ConcurrencyConflict` is intentionally omitted pending OQ2; conflicts are resolved transparently at MVP." Makes the deferral explicit instead of inferred. Non-blocking — OQ2 is already carried forward in all four artifacts. |
| 2 | Minor | mockups.md POST /items/{sku}/adjustments + interaction-spec.md Adjust Stock | `InsufficientStock` is rendered as `409` in the endpoint example and the interaction-spec table. Both label it "provisional per OQ1", so OQ1 is correctly deferred — but showing a concrete `409` risks a reader treating it as decided, especially since `DuplicateSku` is also `409` and the status is genuinely open (409 vs 422). | Keep the provisional label, but consider rendering as `4xx (409 or 422 — OQ1)` in the example bodies so the openness is visible at the point of use, not only in the preamble. Cosmetic; the deferral is honored in substance. |
| 3 | Minor | design-system-mapping.md Resource routing vs [team-practices] Code Style | [team-practices] Code Style gives the feature-organization example as `/items/*, /stock/*`, whereas these artifacts route adjustments under `/items/{sku}/adjustments` (no `/stock/*`). This is a deliberate, Q2-confirmed choice (Q2 → A explicitly selected `/items/{sku}/adjustments`) and still satisfies "organize by feature", so it is not a contradiction — but a reader comparing to team-practices may notice the `/stock/*` example is unused. | No change required; the Q2 answer is the authoritative source and the sub-resource form is a valid feature organization. Flagged only so the human notes the `/stock/*` practice example was consciously not taken. |
| 4 | Minor | accessibility-checklist.md A2 / mockups.md validation errors | A2 asserts validation failures identify offending field(s) via `fields[]`, and the error-envelope example carries `fields`. The envelope marks `fields` as "required on validation errors" but optional otherwise — correctly. One edge is unspecified: a multi-field validation failure (e.g. missing field AND negative quantity on the same POST) is not shown returning multiple `fields[]` entries. The `fields` array shape supports it; no artifact confirms the API returns all violations vs first-fail. | Confirm all-violations-vs-first-fail in Contract/Functional Design. Low impact — the array shape already permits multiple entries and US3.1 AC3.1.1 only requires field-level detail, not exhaustiveness. |

### Summary

The four artifacts faithfully run Refined Mockups in its non-UI developer-experience form, which is the correct output for this API-only `mvp` initiative, and the human can approve. Every user story US1.1–US4.2 has a corresponding endpoint sketch and per-operation state table, and every FR1–FR3 / NFR1–NFR3 is realized (NFR4 "no hardcoded secrets" is legitimately a code/infra concern outside a developer-experience sketch, not a gap here); the API conventions are internally consistent across all four files — one canonical `Item` representation, one error envelope, one closed code vocabulary, and a single documented status mapping — with no contradictions between mockups, interaction-spec, design-system-mapping, and the consumer-accessibility checklist. The three genuinely open items are all correctly deferred rather than silently decided: `InsufficientStock` status is labelled provisional per OQ1, the pagination mechanism is explicitly handed to Contract Design, and `ConcurrencyConflict` visibility is left to OQ2 (its absence from the closed code set is the right MVP stance). Scope is respected — no auth, single location/one `Item` resource, and no OpenAPI deliverable (explicitly deferred to Contract Design). All four findings are Minor documentation/clarity notes that make already-correct deferrals more explicit; zero Critical, zero Major — none blocks approval.
