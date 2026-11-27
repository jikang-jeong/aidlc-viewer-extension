# Contract Design — Plan & Questions

Inventory Management REST API — `mvp` scope. One Unit (`inventory-api`, U1) with
no inter-unit edges, so there is exactly one contract to pin: the **public/external
REST API** that internal integrating developers (persona P1 "Alex") consume. This
stage owns that external API specification before Code Generation — no other stage
does. Fill each `[Answer]:` tag; every question offers `X. Other (please specify)`.

These questions resolve the three design-stage open threads carried in from upstream:
OQ1 (pagination mechanism), OQ2 (`ConcurrencyConflict` caller visibility), OQ3
(API key over the internal-network boundary), plus the `InsufficientStock` status
code (stories OQ1).

## Q1 — Integration mechanism for the public API.

A. **Synchronous REST/HTTP with JSON** — the API is a plain HTTP+JSON REST
   service; the contract is an OpenAPI spec. Matches the requirements (REST API,
   JSON error envelope) and the Node.js/TypeScript stack.
B. Something else (GraphQL, gRPC, async events).
X. Other (please specify)

[Answer]: A

---

## Q2 — Pagination mechanism for `GET /items` (resolves OQ1).

Requirements FR1.4 / US1.3 require bounded pages with a way to request the next
page; the exact mechanism was deferred to this stage.

A. **Offset/limit** — `?limit=&offset=` with a default limit (e.g. 20) and a max
   (e.g. 100); response carries `items`, `total`, and `limit`/`offset` echoes.
   Simplest; fine for a single-location MVP catalogue.
B. **Cursor-based** — `?limit=&cursor=`; response carries `items` and a
   `nextCursor` (null on the last page). More robust under churn, slightly more
   work.
X. Other (please specify)

[Answer]: A

---

## Q3 — HTTP status for `InsufficientStock` (resolves stories OQ1 / AC3.1.2).

A. **409 Conflict** — the request conflicts with current stock state. Groups it
   with the duplicate-SKU 409 as a state-conflict family.
B. **422 Unprocessable Entity** — the request was well-formed but semantically
   rejected.
X. Other (please specify)

[Answer]: A

---

## Q4 — Is `ConcurrencyConflict` caller-visible? (resolves OQ2).

FR2.2 requires no lost updates under concurrency. The question is whether a
concurrency conflict ever surfaces to the caller or is resolved transparently.

A. **Transparent (not caller-visible) at MVP** — the service resolves conflicts
   internally (atomic conditional update, bounded internal retry); the caller
   only ever sees success, `InsufficientStock`, or an unexpected 5xx. Keeps the
   public error set closed and simplest for consumers. (Mechanism itself stays an
   infrastructure/functional-design decision.)
B. **Caller-visible** — a dedicated `ConcurrencyConflict` code (e.g. 409) with
   retry guidance is part of the public contract.
X. Other (please specify)

[Answer]: A

---

## Q5 — Authentication on the public API (resolves OQ3).

Assumption A1 defers auth; the API trusts its internal network boundary at MVP.

A. **No auth at MVP** — the contract documents the API as unauthenticated,
   trusting the internal network boundary; auth is a documented future revision.
   Matches A1 and the deferred-auth scope decision.
B. **Simple API key** — add an `X-Api-Key` header to the contract now.
X. Other (please specify)

[Answer]: A

---

## Q6 — Contract ownership, versioning, and breaking-change policy.

A. **U1 (`inventory-api`) owns the single OpenAPI spec**; version the API with a
   URI prefix (`/v1`); additive changes are backward-compatible (consumers ignore
   unknown fields), breaking changes require a new version prefix. Standard and
   low-ceremony for one owning unit.
B. Something else.
X. Other (please specify)

[Answer]: A

---

## Consolidated Summary Confirmation

> Interaction mode: self-guided — the human authorized the agent to make these
> stage decisions for this simple project; recommended answers (A) stand. No
> ambiguities or contradictions found across the six answers.

- **Q1 — Mechanism:** synchronous REST/HTTP with JSON; the contract is a single OpenAPI spec.
- **Q2 — Pagination (OQ1):** offset/limit on `GET /items` — default limit 20, max 100; response echoes `limit`/`offset` and a `total`.
- **Q3 — `InsufficientStock` status (stories OQ1):** 409 Conflict.
- **Q4 — `ConcurrencyConflict` (OQ2):** transparent / not caller-visible at MVP; the caller sees only success, `InsufficientStock` (409), validation (400), not-found (404), duplicate-SKU (409), or an unexpected 500. The concurrency mechanism itself stays a functional/infrastructure-design decision.
- **Q5 — Auth (OQ3):** no auth at MVP; the contract documents the API as unauthenticated behind the trusted internal network boundary; auth is a documented future revision.
- **Q6 — Ownership/versioning:** U1 (`inventory-api`) owns the single OpenAPI spec; `/v1` URI prefix; additive changes are backward-compatible (consumers ignore unknown fields); breaking changes require a new version prefix.
- **Artifact:** `contract-summary.md` — a contracts table (one public API boundary) plus the inline OpenAPI spec covering all endpoints and the shared error envelope, ownership rules, and remaining open questions.

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]:

---

## Q7. [Product owner] Authentication on the public API (revisits Q5).

You decided on 2026-11-09 to make API requests authenticated, using the simplest
approach for an MVP. This replaces Q5's "no auth at MVP" answer.

A. **Cognito User Pool JWT bearer token** - every `/v1` route requires
   `Authorization: Bearer <token>` from one Cognito user pool (self sign-up off,
   users created by an admin, one app client with no secret). `/health` stays
   open. A missing or invalid token gets 401 before the request reaches the API.
B. Simple API key (`X-Api-Key` header).
X. Other (please specify)

[Answer]: A

---

## Q8. [Architect] Shape of the 401 response body.

API Gateway's built-in JWT check rejects a bad token before our code runs, so it
answers with its own body, `{"message":"Unauthorized"}`, not our error envelope
(`code`, `message`, `requestId`). Making it match our envelope needs a custom
Lambda authorizer, which adds code and latency.

A. **Document the gateway's own body for 401** (Recommended) - the contract
   states that 401 responses use `{"message":"Unauthorized"}`; every other error
   keeps the standard envelope. No extra code.
B. **Custom Lambda authorizer** that returns our envelope with a new
   `Unauthorized` code. Consistent bodies, more code to build and test.
X. Other (please specify)

[Answer]: A

---

## Q9. [Architect] API version after adding authentication.

The ownership rules (Q6) say a breaking change needs a new version prefix.
Requiring a token, capping `offset`, and rejecting an overflowing increment all
tighten the contract. Nothing has been released to consumers yet.

A. **Stay on `/v1`** (Recommended) - the API has no consumers yet, so this is a
   revision of the unreleased `/v1` contract (`info.version` 1.0.0 to 1.1.0).
   The breaking-change rule applies from the first release onward.
B. **Move to `/v2`** - treat it as a breaking change now.
X. Other (please specify)

[Answer]: A

---

## Q10. [Architect] Stock increase that would overflow the stored quantity (review finding R-01).

You asked on 2026-11-09 to reject this. An increment whose result would exceed
the largest safe integer (9007199254740991) is a validation failure.

A. **400 `ValidationError`** on `POST /items/{sku}/adjustments`, quantity
   unchanged. No new error code.
B. 409 with a new code.
X. Other (please specify)

[Answer]: A

---

## Q11. [Architect] Maximum `offset` on `GET /items` (review finding R-05).

You asked on 2026-11-09 to cap it, so a single request cannot read the whole
table.

A. **`offset` maximum 10000**; above that is rejected with 400
   `ValidationError`.
B. No cap.
X. Other (please specify)

[Answer]: A
