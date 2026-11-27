# Requirements — Inventory Management REST API (MVP)

## Sources

- `intent-statement` (Intent Capture) — problem, target customer, success metric,
  MVP capability signal.
- `scope-document` (Scope Definition) — in/out scope boundary, sequencing, value
  stream.
- `team-practices` (Practices Discovery) — testing posture, code-style layering,
  error-envelope and typed-domain-error conventions.
- `requirements-analysis-questions.md` (this stage) — the nine answered
  clarifying questions [Q1]–[Q9] that resolved the gaps below.

## Intent Analysis

The organization is replacing a manual, spreadsheet-based inventory process with
a programmatic REST API that internal developers integrate against
[intent-statement]. The goal is a **trustworthy, current source of inventory
data** for a single location — not a feature-rich inventory suite. Success is
defined by **data correctness**: a read issued after a successful stock change
reflects that change [intent-statement] [Q5].

The MVP delivers two capability areas from the scope document: **item CRUD** and
**concurrency-safe stock-level tracking & adjustments** [scope-document]. The one
substantive technical risk — concurrent adjustments racing — is addressed as a
first-class functional requirement with a mandatory concurrency test
[team-practices].

## Functional Requirements

### FR1 — Item CRUD

- **FR1.1** The system shall create an inventory item from a request carrying a
  client-supplied SKU, name, description, and initial quantity [Q1] [Q2].
- **FR1.2** The system shall reject creation when the SKU already exists,
  returning a conflict domain error (4xx) and creating no item [Q2].
- **FR1.3** The system shall retrieve a single item by its SKU, returning the
  item's current fields; a request for an unknown SKU returns a not-found domain
  error (4xx) [Q1] [Q6].
- **FR1.4** The system shall list items with pagination (page/limit or
  cursor-style), returning a bounded page plus the information needed to request
  the next page [Q6].
- **FR1.5** The system shall update an existing item's mutable descriptive fields
  (name, description) by SKU; an update to an unknown SKU returns a not-found
  domain error (4xx) [Q1] [Q6].
- **FR1.6** The system shall hard-delete an item by SKU; after deletion a read of
  that SKU returns a not-found domain error (4xx) [Q7].

### FR2 — Stock-level tracking & adjustments

- **FR2.1** The system shall apply a stock adjustment expressed as a signed
  relative delta (e.g. `+10`, `-3`) to an item identified by SKU, updating the
  item's quantity atomically [Q3] [scope-document].
- **FR2.2** The system shall apply concurrent adjustments to the same item
  without lost updates: given N concurrent adjustments, the resulting quantity
  equals the initial quantity plus the sum of all successfully applied deltas
  [Q3] [team-practices].
- **FR2.3** The system shall reject an adjustment that would drive quantity below
  zero, returning an `InsufficientStock` domain error (4xx) and leaving the
  stored quantity unchanged [Q4].
- **FR2.4** The system shall reject an adjustment targeting an unknown SKU with a
  not-found domain error (4xx) [Q3] [Q6].
- **FR2.5** After a successful adjustment, any subsequent read of that item shall
  reflect the new quantity (read-after-write consistency) [Q5].

### FR3 — Error handling contract

- **FR3.1** The system shall return a single consistent JSON error envelope for
  all failures — a machine-readable code, a human-readable message, optional
  field detail, and a request id [team-practices].
- **FR3.2** The system shall map typed domain errors to HTTP status: expected
  domain failures (`ItemNotFound`, `InsufficientStock`, duplicate-SKU conflict)
  to 4xx; unexpected failures to 5xx, logged [team-practices].

## Non-Functional Requirements

- **NFR1 — Correctness/consistency.** Stock adjustments shall be atomic and
  concurrency-safe; a read after a successful adjustment reflects it immediately
  (strict read-after-write). This is the primary acceptance bar and is verified
  by a mandatory concurrent-adjustment race test that fails against a naive
  read-modify-write [Q5] [team-practices].
- **NFR2 — Input validation.** The system shall validate and sanitize all inputs
  at the API boundary (request bodies, path/query params) before they reach
  domain or datastore logic; invalid input returns a 4xx envelope and never
  reaches persistence [Q9] [team-practices].
- **NFR3 — Observability.** The system shall emit structured logs for each request
  (including the request id from FR3.1) and expose a health-check endpoint
  suitable for a deployment readiness/liveness probe [Q9].
- **NFR4 — No hardcoded secrets.** The system shall source any configuration
  secret from environment variables or a secrets manager, never hardcoded
  [team-practices].

Performance/throughput targets are intentionally not stated at MVP; load testing
is deferred until a real target surfaces [Q5] [team-practices].

## Constraints

- **C1** Target platform is AWS; the specific compute and managed datastore are
  chosen in later design stages [scope-document].
- **C2** Node.js/TypeScript stack with the team's layering (handler → service →
  repository), Prettier/ESLint, and `strict` TypeScript [team-practices]. Treated
  as the working assumption; a stack change in design would revise this.
- **C3** Single inventory location; the data model does not carry a location
  dimension [intent-statement] [scope-document].

## Assumptions

- **A1** No authentication/authorization in the MVP; the API trusts its internal
  network boundary, and auth is deferred to design [Q8] [scope-document].
- **A2** The item identifier is the client-supplied SKU; there is no separate
  server-generated id [Q2].
- **A3** "Real-time" is satisfied by strict read-after-write consistency rather
  than a numeric freshness/latency window [Q5].

## Out of Scope (this release)

- Multi-location / warehouse support [scope-document].
- Stock-movement history / audit trail [scope-document].
- Low-stock alerts / thresholds, and any reorder metadata [scope-document] [Q1].
- Absolute stock-set path (adjustments are relative-delta only) [Q3].
- Filtering/sorting on the list endpoint [Q6].
- Soft delete / archival [Q7].
- External system integrations and identity/auth integration [scope-document]
  [Q8].
- A published OpenAPI/Swagger contract as a deliverable (may be revisited in the
  NFR stages) [Q9].

## Open Questions

- **OQ1** Pagination mechanism (offset/limit vs cursor) and default/maximum page
  size — to be fixed in functional/contract design [Q6].
- **OQ2** Concurrency mechanism for atomic adjustments (e.g. conditional/atomic
  update vs optimistic version check) — a design decision, to be settled once the
  datastore is chosen [Q3] [team-practices].
- **OQ3** Whether an internal network boundary alone is sufficient, or a simple
  API key should be added in design [Q8] [team-practices].

## Review

**Verdict:** READY
**Reviewer:** aidlc-product-lead-agent
**Date:** 2026-10-01T13:57:02Z
**Iteration:** 1

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Minor | FR1.5 vs FR2 | Update (FR1.5) is scoped to "mutable descriptive fields (name, description)" and the stock path (FR2) owns quantity, but the artifact never states that quantity is NOT settable via the item-update endpoint. The intent is clear from Q3→A (relative-delta only, no absolute-set) and the Out-of-Scope "Absolute stock-set path" line, so this is implicit, not contradictory. | Optionally add one explicit clause to FR1.5 ("quantity is not mutable via update; see FR2") so a developer cannot infer an absolute-set path. Non-blocking — the boundary is already derivable from Q3 and Out of Scope. |
| 2 | Minor | FR3.2 / NFR1 | team-practices lists `ConcurrencyConflict` as a typed domain error alongside `ItemNotFound`/`InsufficientStock`, but no requirement names how a concurrency conflict surfaces to the caller (FR3.2 enumerates not-found, insufficient-stock, duplicate-SKU). FR2.2 mandates lost-update-free behaviour, so a conflict may be handled internally (retry) rather than surfaced — but the requirements do not say which. | Clarify in functional/contract design whether `ConcurrencyConflict` is caller-visible (4xx with retry guidance) or resolved transparently. OQ2 already defers the mechanism; a one-line note that conflicts are not caller-visible at MVP would remove the ambiguity. Non-blocking. |
| 3 | Minor | NFR3 / Open Questions | Observability (NFR3) requires "structured logs for each request" but does not state a minimum field set beyond the request id (e.g., method, route, status, latency, outcome). Testable as written (logs emitted + health endpoint responds), but QA cannot assert log *content* completeness. | Consider stating the minimum structured-log field set in NFR design, or note it as deferred. Low impact at MVP; the pass/fail bar for "emits structured logs + health check" is already testable. |

### Summary

The requirements are implementable, internally consistent, and fully traceable: every FR/FR{n}.{m} and NFR{n} is well-formed and cites a permitted upstream source ([intent-statement], [scope-document], [team-practices]) or an answered question [Q1]–[Q9], with no orphans and no contradictions. The intent-capture "accurate/real-time" success-metric gap is now closed and testable (NFR1 + A3 pin it to strict read-after-write consistency with load testing explicitly deferred, grounded in Q5), the concurrency risk is a first-class requirement (FR2.2) backed by the mandatory race test (NFR1), and the scope boundary (single location C3, item CRUD + relative-delta adjustments, deferred auth A1) is respected with an Out-of-Scope list that matches the scope document — nothing silently added or dropped. The three findings are all Minor clarifications for downstream design (implicit no-quantity-via-update, concurrency-conflict visibility, structured-log field set); none blocks approval. Zero Critical, zero Major.
