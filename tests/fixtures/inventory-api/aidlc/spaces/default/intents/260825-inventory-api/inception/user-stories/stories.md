# User Stories — Inventory Management REST API (MVP)

## Sources

- `requirements` (Requirements Analysis) — FR1–FR3, NFR1–NFR4 that these stories
  realize.
- `team-practices` (Practices Discovery) — BDD-style testable criteria and the
  mandatory concurrency test shaping US3.2.
- `personas.md` (this stage) — P1 Integrating Developer, P2 Operator.

Format: "As a [persona], I want [goal], so that [benefit]" with Given/When/Then
acceptance criteria. IDs (`US{group}.{seq}`, `AC{group}.{seq}.{n}`) are permanent
traceability keys.

> Finalized after mob elaboration and consolidated-summary confirmation.

## Group 1 — Item CRUD (FR1)

### US1.1 — Create an item (Must) — FR1.1, FR1.2

As Alex the Integrating Developer, I want to create an inventory item with a SKU,
name, description, and initial quantity, so that it exists as a programmatic
record I can read and adjust.

- **AC1.1.1** Given a valid new item payload, When I POST it, Then the item is
  created and returned with its fields and the initial quantity.
- **AC1.1.2** Given a SKU that already exists, When I POST an item with that SKU,
  Then the request is rejected with a duplicate-conflict error (4xx) and no item
  is created.
- **AC1.1.3** Given a payload missing a required field or with an invalid
  quantity, When I POST it, Then the request is rejected with a validation error
  (4xx) and no item is created.
- **AC1.1.4** Given a payload whose initial quantity is negative, When I POST it,
  Then it is rejected with a validation error (4xx); an initial quantity of zero
  is accepted.
- **AC1.1.5** Given a malformed, empty, or over-length SKU, When I POST it, Then
  it is rejected with a validation error (4xx) and no item is created.

### US1.2 — Get an item by SKU (Must) — FR1.3

As Alex, I want to retrieve a single item by its SKU, so that my application can
read its current data.

- **AC1.2.1** Given an existing SKU, When I GET it, Then the item's current fields
  and quantity are returned.
- **AC1.2.2** Given an unknown SKU, When I GET it, Then a not-found error (4xx) is
  returned.

### US1.3 — List items with pagination (Must) — FR1.4

As Alex, I want to list items in bounded pages, so that I can enumerate inventory
without unbounded responses.

- **AC1.3.1** Given more items than one page holds, When I request the list, Then
  a bounded page is returned with the information needed to fetch the next page.
- **AC1.3.2** Given an invalid pagination parameter, When I request the list, Then
  a validation error (4xx) is returned.
- **AC1.3.3** Given no items (or the final page), When I request that page, Then
  an empty-or-final page is returned with no next-page token, and a page-size
  above the maximum is clamped or rejected consistently.

### US1.4 — Update an item's descriptive fields (Must) — FR1.5

As Alex, I want to update an item's name and description by SKU, so that item
metadata stays correct.

- **AC1.4.1** Given an existing SKU, When I update its name/description, Then the
  changes are persisted and returned.
- **AC1.4.2** Given an unknown SKU, When I update it, Then a not-found error (4xx)
  is returned.
- **AC1.4.3** Given an update payload that attempts to set quantity directly, When
  I submit it, Then quantity is not changed via this path and the error guides the
  caller to the stock-adjustment endpoint (US2.1) as the way to change quantity.

### US1.5 — Delete an item (Must) — FR1.6

As Alex, I want to hard-delete an item by SKU, so that obsolete items are removed.

- **AC1.5.1** Given an existing SKU, When I delete it, Then the item is removed
  and a subsequent GET returns not-found (4xx).
- **AC1.5.2** Given an unknown SKU, When I delete it, Then a not-found error (4xx)
  is returned.

## Group 2 — Stock adjustments (FR2)

### US2.1 — Adjust stock by a relative delta (Must) — FR2.1, FR2.3, FR2.4, FR2.5

As Alex, I want to adjust an item's quantity by a signed delta, so that stock
levels stay accurate as goods move.

- **AC2.1.1** Given an existing item, When I apply a positive delta, Then the
  quantity increases by that amount and a subsequent read reflects it immediately.
- **AC2.1.2** Given an item with sufficient stock, When I apply a negative delta
  within stock, Then the quantity decreases by that amount and a subsequent read
  reflects the decrease immediately.
- **AC2.1.3** Given a negative delta that would drop quantity below zero, When I
  apply it, Then the request is rejected with an `InsufficientStock` error (4xx)
  and the stored quantity is unchanged.
- **AC2.1.4** Given a decrement exactly equal to the current quantity, When I
  apply it, Then it succeeds and the quantity becomes exactly zero (the zero
  floor is inclusive).
- **AC2.1.5** Given a zero (`+0`) or non-integer/missing delta, When I submit it,
  Then the request is rejected with a validation error (4xx) and the quantity is
  unchanged.
- **AC2.1.6** Given an unknown SKU, When I apply an adjustment, Then a not-found
  error (4xx) is returned.

### US2.2 — Concurrent adjustments do not lose updates (Must) — FR2.2

As Alex, I want concurrent adjustments to the same item to be applied atomically,
so that no update is silently lost under load.

- **AC2.2.1** Given N concurrent adjustments to one item (N large, e.g. >= 50,
  issued with no client-side serialization), When they all stay within stock and
  succeed, Then for every possible interleaving the final quantity equals the
  initial quantity plus the sum of all applied deltas (no lost updates). This
  invariant must fail against a naive read-modify-write implementation.
- **AC2.2.2** Given concurrent adjustments where some would breach the zero
  floor, When they are applied, Then (regardless of ordering) the final quantity
  is never negative, every request resolves as either success or
  `InsufficientStock`, and the count of successes plus rejections equals N. The
  specific set of winners is not asserted (it is interleaving-dependent).

## Group 3 — Error contract (FR3)

### US3.1 — Consistent, machine-readable errors (Should) — FR3.1, FR3.2

As Alex, I want every failure to return one consistent error shape, so that my
application can handle errors programmatically.

- **AC3.1.1** Given any failing request, When it returns an error, Then the body
  carries a machine-readable code (from a closed, enumerable set), a
  human-readable message, and a request id; validation failures additionally
  include field-level detail identifying each offending field.
- **AC3.1.2** Given an expected domain failure, When it occurs, Then the response
  uses a consistent status mapping across every endpoint: `ItemNotFound` -> 404,
  duplicate-SKU conflict -> 409, `InsufficientStock` -> 4xx (exact code confirmed
  in design, see OQ1), validation failure -> 400; an unexpected failure -> 5xx and
  is logged.
- **AC3.1.3** Given the same domain condition reached through different endpoints
  (e.g. an unknown SKU on get, update, delete, or adjust), When it occurs, Then
  the error code and body shape are identical across those endpoints.

## Group 4 — Cross-cutting NFR stories

### US4.1 — Input validation at the boundary (Must) — NFR2

As Alex, I want all inputs validated at the API boundary, so that malformed data
never reaches the datastore and I get a clear error.

- **AC4.1.1** Given a request with an invalid body or path/query parameter, When
  it is received, Then it is rejected with a validation-error envelope (4xx) and
  no item is created, updated, deleted, or adjusted (no observable state change).

### US4.2 — Health check and structured logging (Should) — NFR1-adjacent, NFR3

As Sam the Operator, I want a health-check endpoint and structured request logs,
so that I can gate deploys and diagnose issues.

- **AC4.2.1** Given the service is running, When I call the health endpoint, Then
  it returns a success status suitable for a readiness/liveness probe.
- **AC4.2.2** Given any request, When it is processed, Then a structured log entry
  is emitted carrying at minimum the request id (from AC3.1.1), the method and
  route, and the outcome status.

## MoSCoW Summary

- **Must:** US1.1–US1.5, US2.1, US2.2, US4.1
- **Should:** US3.1, US4.2
- **Could / Won't (this release):** none drafted — out-of-scope items (multi-location,
  history, alerts, auth) are excluded per the scope document and are not stories.

## Dependencies & INVEST notes

- US1.1 (create) is the foundation; US1.2–US1.5, US2.1 operate on created items.
- US2.2 depends on the US2.1 adjust path existing; it isolates the concurrency
  invariant so it is independently testable (the mandatory race test).
- US3.1 and US4.1 are cross-cutting; their criteria are observable per-endpoint.
- All stories are small, independently testable, and carry a clear value
  statement (INVEST).

## Open Questions (for design / contract stages)

- **OQ1** The exact HTTP status for `InsufficientStock` (409 Conflict vs 422
  Unprocessable) — fixed in contract design; AC3.1.2 pins the mapping for the
  others. (Surfaced by the quality and developer participants.)
- **OQ2** Whether `ConcurrencyConflict` is caller-visible (its own code in the
  error contract) or handled transparently via retry — a design decision that
  affects US3.1's error set. (Surfaced by the developer and quality participants;
  aligns with requirements OQ2 on the concurrency mechanism.)
- **OQ3** The concurrency mechanism itself (atomic conditional update vs
  optimistic version check) remains deferred to design once the datastore is
  chosen; US2.2 asserts the observable invariant regardless of mechanism.

## Review

**Verdict:** READY
**Reviewer:** aidlc-product-lead-agent
**Date:** 2026-10-01T14:30:52Z
**Iteration:** 1

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Minor | stories.md `## Sources` | The Sources note says the mandatory concurrency test shapes **"US3.2"**, and the Q&A Consolidated Summary also calls it "a dedicated US2.2 concurrency story" in one line while the plan prose elsewhere implies a US3.x. The actual story is **US2.2** and traceability.json correctly maps FR2.2 → US2.2. The `US3.2` reference is stale — there is no US3.2 story (Group 3 has only US3.1). | Correct the Sources line to read `US2.2`. Pure documentation drift; traceability and the story body are internally consistent, so this does not affect implementability. |
| 2 | Minor | traceability.json NFR1 row | NFR1 bundles two obligations — atomic/concurrency-safe adjustment AND strict read-after-write. It is mapped `OK → US2.2` only. The read-after-write half is actually realized by US2.1 (AC2.1.1/AC2.1.2 "a subsequent read reflects it immediately") and US1.2, which the single-target row does not surface. | Optionally widen the NFR1 target to `US2.2, US2.1` so both halves of NFR1 are visibly covered. Coverage exists in the stories; only the trace row is narrower than the requirement. Non-blocking. |
| 3 | Minor | US4.2 heading | US4.2 is labelled `NFR1-adjacent, NFR3`. NFR1 is the correctness/concurrency NFR; a health-check + structured-logging story is not NFR1-adjacent. traceability.json maps NFR3 → US4.2 (correct) and does not claim NFR1 here. | Drop "NFR1-adjacent" from the US4.2 title to avoid implying the health/logging story bears on concurrency correctness. Cosmetic. |
| 4 | Minor | US3.1 / OQ2 | The error contract (US3.1 / AC3.1.1) enumerates a "closed, enumerable set" of codes but `ConcurrencyConflict` (named as a typed domain error in team-practices) is not resolved as caller-visible or transparent — OQ2 correctly defers this. No story asserts its surfacing. | Acceptable to defer to contract design (OQ2 is explicit). The human should note that the error set is not fully closed until OQ1/OQ2 are settled downstream. Non-blocking. |

### Summary

The story set is implementable and the human can approve: every FR1.1–FR3.2 and NFR1–NFR4 is accounted for in traceability.json (16 `OK`, NFR4 justifiably `Deferred` to infrastructure-design), all stories follow the "As a [persona], I want…, so that…" form with testable Given/When/Then criteria, IDs are well-formed, and scope is respected — single location, CRUD + relative-delta adjustments, deferred auth, with multi-location/history/alerts correctly excluded and nothing silently added (US1.4/AC1.4.3 even closes the quantity-via-update gap flagged upstream). The highest-risk behaviour, the US2.2 concurrency invariant, is first-class and sharply testable (order-independent no-lost-updates, must fail a naive read-modify-write), directly feeding the team's mandatory race test. The four findings are all Minor: one stale `US3.2` reference in the Sources note, a narrow NFR1 trace row, a loose "NFR1-adjacent" label, and the expected `ConcurrencyConflict`/status-code questions already deferred as OQ1/OQ2. Zero Critical, zero Major — none blocks approval.
