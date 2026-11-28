# Requirements Analysis — Clarifying Questions

Inventory Management REST API — `mvp` scope. These questions close the gaps that
block writing testable requirements, building on the approved intent statement
and scope document. Answer each by filling the `[Answer]:` tag. Every question
offers `X. Other (please specify)` if none of the options fit.

---

## Q1 — Item data model: what fields define an inventory item?

The MVP covers product/item CRUD. To write field-level validation requirements,
I need the item shape.

A. Minimal — SKU (unique identifier), name, and current quantity only.
B. Minimal + description — SKU, name, description, quantity.
C. Richer — SKU, name, description, quantity, unit price, and category/tags.
D. Richer + reorder metadata — all of C plus a reorder threshold field (stored
   now even though low-stock alerting is out of scope).
X. Other (please specify)

[Answer]: B. Minimal + description — SKU, name, description, quantity.

---

## Q2 — SKU ownership: who assigns the item's unique identifier?

A. Client-supplied — the caller provides the SKU on create; the API rejects
   duplicates.
B. Server-generated — the API generates a unique id; SKU is a separate optional
   human-facing field.
C. Both — the API generates an internal id AND requires a client-supplied unique
   SKU.
X. Other (please specify)

[Answer]: A. Client-supplied SKU is the unique identifier; the API rejects duplicates on create.

---

## Q3 — Stock adjustment semantics: how do callers change quantity?

The scope calls out concurrency-safe increment/decrement adjustments as a Must.

A. Relative delta only — callers send a signed delta (e.g. +10 / -3); the API
   applies it atomically. Absolute quantity is never set directly.
B. Absolute set only — callers send the new absolute quantity; the API overwrites
   atomically.
C. Both — a relative-adjust endpoint (delta) and an absolute-set path, both
   atomic.
X. Other (please specify)

[Answer]: A. Relative delta only — callers send a signed delta (+/-) applied atomically; no direct absolute-set path.

---

## Q4 — Negative stock: what happens when a decrement would drop quantity below zero?

A. Reject — the adjustment fails with a domain error (e.g. `InsufficientStock`,
   mapped to a 4xx); quantity is unchanged.
B. Allow — quantity may go negative (e.g. to represent backorders); no floor.
C. Clamp — quantity floors at zero and the API reports how much was applied.
X. Other (please specify)

[Answer]: A. Reject — a decrement that would drop below zero fails with an InsufficientStock domain error (4xx) and leaves quantity unchanged.

---

## Q5 — "Accurate, real-time stock levels": what measurable target makes this testable?

The intent's single success metric is data correctness, flagged at intent-capture
as needing quantification before requirements can test it.

A. Strict read-after-write consistency — any read issued after a successful
   adjustment reflects it immediately; correctness is the pass/fail bar, no
   separate latency target. (Performance/load testing stays deferred per team
   practice.)
B. Read-after-write consistency PLUS a response-time target (e.g. reads p95 under
   a stated millisecond bound).
C. Eventual consistency acceptable within a stated freshness window (e.g. reads
   reflect writes within N seconds).
X. Other (please specify)

[Answer]: A. Strict read-after-write consistency — any read after a successful adjustment reflects it immediately; correctness is the pass/fail bar, no separate latency target. Performance/load testing stays deferred per team practice.

---

## Q6 — Listing items: what does the "read" side of CRUD need beyond fetch-by-id?

A. Get-by-id plus a list-all endpoint with pagination (the completeness checklist
   default for list views).
B. A + filtering (e.g. by name/category) and sorting on the list endpoint.
C. Get-by-id only — no list endpoint in the MVP.
X. Other (please specify)

[Answer]: A. Get-by-id plus a list-all endpoint with pagination; no filtering/sorting in the MVP.

---

## Q7 — Delete semantics for items.

A. Hard delete — the item record is removed; subsequent reads return not-found.
B. Soft delete — the item is marked inactive/archived and excluded from default
   listings, but the record is retained.
C. Block delete when stock is non-zero — deletion is refused for items that still
   hold quantity.
X. Other (please specify)

[Answer]: A. Hard delete — the item record is removed and subsequent reads return not-found.

---

## Q8 — Authentication/authorization for the MVP.

Scope defers auth to design, but requirements should state the MVP's assumption
explicitly so it is testable rather than silent.

A. None in the MVP — the API trusts its network boundary (internal-only); auth is
   deferred to design, stated as an assumption.
B. A simple shared API key / token checked at the boundary.
C. Full identity integration (e.g. OAuth/OIDC) — pull auth into the MVP scope.
X. Other (please specify)

[Answer]: A. None in the MVP — the API trusts its internal network boundary; auth is deferred to design and stated as an explicit assumption.

---

## Q9 — Beyond correctness, which non-functional concerns should carry a stated requirement in the MVP?

Select the ones that should appear as NFRs now (performance/load testing itself
stays deferred per team practice).

A. Observability only — structured logging + a health-check endpoint.
B. Observability + input validation/sanitization at the API boundary (already a
   project mandate) stated as a verifiable NFR.
C. B plus a documented API contract (e.g. OpenAPI/Swagger) as a deliverable NFR.
D. Correctness/concurrency only — defer all other NFRs to the NFR stages.
X. Other (please specify)

[Answer]: B. Observability (structured logging + health-check endpoint) plus input validation/sanitization at the API boundary stated as a verifiable NFR.

---

## Consolidated Summary Confirmation

- **Item model (Q1):** SKU, name, description, quantity — minimal shape.
- **Identifier (Q2):** client-supplied SKU is the unique id; duplicates rejected on create.
- **Adjustments (Q3):** relative signed-delta only, applied atomically; no absolute-set path.
- **Negative stock (Q4):** reject a below-zero decrement with an `InsufficientStock` 4xx error; quantity unchanged.
- **Success metric (Q5):** strict read-after-write consistency is the correctness bar; no latency target; load testing deferred.
- **Listing (Q6):** get-by-id plus a paginated list-all; no filtering/sorting in the MVP.
- **Delete (Q7):** hard delete; subsequent reads return not-found.
- **Auth (Q8):** none in the MVP — trusts the internal network boundary; deferred to design as an explicit assumption.
- **NFRs now (Q9):** observability (structured logging + health check) plus boundary input validation stated as a verifiable NFR; OpenAPI/broader NFRs deferred.

Does this all look correct before I generate the requirements artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
