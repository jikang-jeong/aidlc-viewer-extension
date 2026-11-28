# Contract Summary — Inventory Management REST API (MVP)

> The formal contracts the system must honour before Code Generation. This
> system is a single Unit (`inventory-api`, U1) with no inter-unit edges per the
> dependency DAG, so there are no inter-unit contracts. The one contract to pin is
> the **public/external REST API** that internal integrating developers consume —
> and this stage owns that external API specification because no other stage does.

## Sources

- `unit-of-work` (Units Generation) — the single Unit U1 (`inventory-api`, kind
  `service`) that owns and exposes this API.
- `unit-of-work-dependency` (Units Generation) — the dependency DAG: a single node
  with `depends_on: []`, confirming there are no inter-unit boundaries, only the
  external API boundary.
- `components` (Domain Design) — the `Item` entity shape (`sku`, `name`,
  `description`, `quantity`) and the typed domain errors (`ItemNotFound`,
  `DuplicateSku`, `InsufficientStock`) that the payloads and error envelope carry.
- `requirements` (Requirements Analysis) — FR1–FR3, NFR1–NFR3 shaping the
  endpoints, the single error envelope, and the deferred decisions resolved here
  (OQ1 pagination, OQ2 concurrency-conflict visibility, OQ3 auth).
- `contract-design-questions.md` (this stage) — answers [Q1]–[Q11]. [Q7]–[Q11]
  are the authentication revision the person decided on 2026-11-09: OQ3 is now
  resolved as Cognito JWT bearer auth [Q7], replacing the earlier "no auth at
  MVP" answer [Q5] and requirements assumption A1 for this contract.

## Contracts

| # | Provider Unit | Consumer | Mechanism | Owner |
|---|---------------|----------|-----------|-------|
| 1 | `inventory-api` (U1) | External: internal integrating developers (persona P1) | Synchronous REST/HTTP + JSON (OpenAPI), Cognito JWT bearer auth | `inventory-api` (U1) |

There are no inter-unit contracts — the DAG has a single node with no edges.

## Contract 1 — Public Inventory REST API (OpenAPI)

Resolved contract decisions:

- Offset/limit pagination: `limit` default 20, max 100; `offset` max 10000
  [Q2] [Q11].
- `InsufficientStock` → 409 [Q3]; `ConcurrencyConflict` handled transparently,
  not caller-visible at MVP [Q4].
- Authentication: every item route requires `Authorization: Bearer <token>`
  issued by one Cognito user pool (self sign-up off, users created by an admin,
  one app client with no secret); `/health` stays open [Q7].
- A missing or invalid token gets 401 from the API Gateway JWT check before the
  request reaches the service, with the gateway's own body
  `{"message":"Unauthorized"}`, not the standard error envelope [Q8].
- An increment whose result would exceed 9007199254740991 (the largest safe
  integer) is rejected with 400 `ValidationError`, quantity unchanged [Q10].
- Stays on `/v1`: nothing is released yet, so this is a revision of the
  unreleased `/v1` contract, `info.version` 1.0.0 to 1.1.0 [Q9] [Q6].
- `description` is optional on create and defaults to `""`, so every returned
  `Item` carries it.

```yaml
openapi: 3.0.3
info:
  title: Inventory Management API
  version: 1.1.0
  description: >
    REST API for single-location inventory management (MVP). Item CRUD plus
    concurrency-safe, relative-delta stock adjustments. Every item route needs a
    Cognito user pool JWT as a bearer token; the health check is open. A missing
    or invalid token is rejected by the API Gateway JWT check with 401 and the
    gateway's own body {"message":"Unauthorized"}, not the standard Error
    envelope.
servers:
  - url: /v1
security:
  - cognitoJwt: []
paths:
  /items:
    get:
      summary: List items (paginated)
      operationId: listItems
      parameters:
        - name: limit
          in: query
          required: false
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
          description: Max items per page. Above 100 is rejected with a 400.
        - name: offset
          in: query
          required: false
          schema: { type: integer, minimum: 0, maximum: 10000, default: 0 }
          description: Items to skip. Above 10000 is rejected with a 400.
      responses:
        '200':
          description: A bounded page of items.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ItemPage' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '400':
          description: Invalid pagination parameter.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
    post:
      summary: Create an item
      operationId: createItem
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateItemRequest' }
      responses:
        '201':
          description: Item created.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Item' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '400':
          description: Validation error (missing/invalid field, negative/non-integer quantity, malformed/over-length SKU).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
        '409':
          description: A duplicate SKU already exists (code DuplicateSku); no item is created.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
  /items/{sku}:
    parameters:
      - name: sku
        in: path
        required: true
        schema: { type: string, minLength: 1, maxLength: 64 }
    get:
      summary: Get an item by SKU
      operationId: getItem
      responses:
        '200':
          description: The item.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Item' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404':
          description: No item with that SKU (code ItemNotFound).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
    put:
      summary: Update an item's descriptive fields (name, description)
      operationId: updateItem
      description: >
        Updates name and/or description only. Quantity is NOT settable here —
        it is changed exclusively via the stock-adjustment endpoint. A payload
        attempting to set quantity is rejected with a validation error guiding
        the caller to POST /items/{sku}/adjustments.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateItemRequest' }
      responses:
        '200':
          description: Updated item.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Item' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '400':
          description: Validation error (including an attempt to set quantity via update).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
        '404':
          description: No item with that SKU (code ItemNotFound).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
    delete:
      summary: Hard-delete an item by SKU
      operationId: deleteItem
      responses:
        '204':
          description: Item deleted; a subsequent GET returns 404.
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404':
          description: No item with that SKU (code ItemNotFound).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
  /items/{sku}/adjustments:
    parameters:
      - name: sku
        in: path
        required: true
        schema: { type: string, minLength: 1, maxLength: 64 }
    post:
      summary: Adjust stock by a signed relative delta
      operationId: adjustStock
      description: >
        Applies a signed integer delta atomically and concurrency-safely.
        Concurrent adjustments never lose updates (FR2.2). A decrement that
        would drop quantity below zero is rejected (InsufficientStock) and the
        stored quantity is unchanged. An increment whose result would exceed
        9007199254740991 (the largest safe integer) is rejected as a
        ValidationError and the stored quantity is unchanged. Concurrency
        conflicts are resolved internally and are never surfaced to the caller
        at MVP.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AdjustStockRequest' }
      responses:
        '200':
          description: Adjustment applied; returns the item with its new quantity (read-after-write consistent).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Item' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '400':
          description: Validation error (zero/non-integer/missing delta, or an increment that would push quantity above 9007199254740991); quantity unchanged.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
        '404':
          description: No item with that SKU (code ItemNotFound).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
        '409':
          description: The decrement would drive quantity below zero (code InsufficientStock); quantity unchanged.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
  /health:
    get:
      summary: Health check (readiness/liveness probe)
      operationId: health
      security: []
      description: Open route; no token required.
      responses:
        '200':
          description: Service is healthy.
          content:
            application/json:
              schema:
                type: object
                properties:
                  status: { type: string, example: ok }
                required: [status]
components:
  securitySchemes:
    cognitoJwt:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: >
        Token issued by the service's single Cognito user pool (self sign-up
        off, users created by an admin, one app client with no secret). Checked
        by the API Gateway JWT check before the request reaches the service.
  responses:
    Unauthorized:
      description: >
        Missing or invalid bearer token. Returned by the API Gateway JWT check,
        so the body is the gateway's own shape, not the standard Error envelope.
      content:
        application/json:
          schema: { $ref: '#/components/schemas/GatewayUnauthorized' }
  schemas:
    GatewayUnauthorized:
      type: object
      description: The gateway's fixed 401 body, exactly {"message":"Unauthorized"}.
      properties:
        message: { type: string, enum: [Unauthorized] }
      required: [message]
    Item:
      type: object
      properties:
        sku: { type: string, minLength: 1, maxLength: 64 }
        name: { type: string }
        description: { type: string }
        quantity: { type: integer, minimum: 0, maximum: 9007199254740991 }
      required: [sku, name, description, quantity]
    CreateItemRequest:
      type: object
      properties:
        sku: { type: string, minLength: 1, maxLength: 64 }
        name: { type: string, minLength: 1 }
        description: { type: string, default: '', description: Optional; stored as an empty string when omitted. }
        quantity: { type: integer, minimum: 0, maximum: 9007199254740991, description: Initial quantity; zero is allowed, negative is rejected. }
      required: [sku, name, quantity]
    UpdateItemRequest:
      type: object
      description: Only name and description are mutable here; quantity is rejected.
      properties:
        name: { type: string, minLength: 1 }
        description: { type: string }
      minProperties: 1
      additionalProperties: false
    AdjustStockRequest:
      type: object
      properties:
        delta:
          type: integer
          description: Signed non-zero integer delta (e.g. 10 or -3). Zero is rejected.
      required: [delta]
    ItemPage:
      type: object
      properties:
        items:
          type: array
          items: { $ref: '#/components/schemas/Item' }
        total: { type: integer, minimum: 0, description: Total item count across all pages. }
        limit: { type: integer }
        offset: { type: integer }
      required: [items, total, limit, offset]
    Error:
      type: object
      description: The single consistent error envelope for every failure (FR3.1).
      properties:
        code:
          type: string
          description: Machine-readable code from a closed set.
          enum: [ValidationError, ItemNotFound, DuplicateSku, InsufficientStock, InternalError]
        message: { type: string, description: Human-readable description. }
        requestId: { type: string, description: Correlates with the structured log entry. }
        fields:
          type: array
          description: Present on ValidationError — one entry per offending field.
          items:
            type: object
            properties:
              field: { type: string }
              reason: { type: string }
            required: [field, reason]
      required: [code, message, requestId]
```

### Status-code mapping (consistent across every endpoint — FR3.2 / AC3.1.2/AC3.1.3)

| Domain condition | Code | HTTP |
|------------------|------|------|
| Missing or invalid bearer token (item routes only; answered by the gateway with `{"message":"Unauthorized"}`, not the envelope) | — | 401 |
| Invalid input / malformed request (including `offset` above 10000, and an increment that would push quantity above 9007199254740991) | `ValidationError` | 400 |
| Unknown SKU (get/update/delete/adjust) | `ItemNotFound` | 404 |
| SKU already exists on create | `DuplicateSku` | 409 |
| Decrement below zero | `InsufficientStock` | 409 |
| Unexpected failure (logged) | `InternalError` | 500 |

`ConcurrencyConflict` is deliberately absent from the public error set: conflicts
are resolved transparently at MVP (OQ2 → transparent).

## Contract Ownership Rules

- **Owner:** `inventory-api` (U1) owns the single OpenAPI spec. It is the only
  unit, so there is no cross-team negotiation at MVP.
- **Versioning:** the API is served under a `/v1` URI prefix. The `info.version`
  tracks the spec revision. Until the first release to consumers, `/v1` may be
  revised in place (1.0.0 to 1.1.0 added authentication, the `offset` cap and the
  overflow rejection); the breaking-change rule below applies from the first
  release onward.
- **Additive changes are backward-compatible:** new optional fields and new
  endpoints may be added within `/v1`; consumers MUST ignore unknown response
  fields so additive changes never break them.
- **Breaking changes require a new version prefix** (`/v2`): removing/renaming a
  field, tightening validation, or changing a status mapping is breaking and is
  never shipped silently under `/v1`.
- **Error envelope is part of the contract:** the `Error` shape and the closed
  `code` enum are stable; adding a new code is additive only if consumers treat
  unknown codes as a generic failure.

## Open Questions

| Contract | Question | Blocks |
|----------|----------|--------|
| Public API (Contract 1) | The concurrency *mechanism* behind the transparent-conflict guarantee (atomic conditional update vs optimistic version + bounded retry) is a functional/infrastructure-design decision once the datastore is chosen; it does not change this contract's observable surface. | Functional Design / Infrastructure Design (not Code Generation of the contract itself) |
| Public API (Contract 1) | How consumers obtain a token from the Cognito user pool (which auth flow the no-secret app client enables, token lifetime) and how admins create users. Does not change the contract's observable surface (bearer JWT, 401 body). | Infrastructure Design |

## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-10-02T10:49:00Z
**Iteration:** 1

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Major | `components.schemas` — `CreateItemRequest.required` vs `Item.required` | `Item` declares `required: [sku, name, description, quantity]`, but `CreateItemRequest` declares `required: [sku, name, quantity]` — `description` is optional on create yet mandatory on the `Item` returned by every read/create/update/adjust response. A valid create that omits `description` either must be rejected (contradicting the schema that allows it) or must return an `Item` that violates its own `required` contract. A developer implementing strictly cannot satisfy both schemas. Requirements/components do not resolve this: FR1.1 lists `description` as a create field and `components.md` lists `description` among `Item` attributes without pinning its optionality. | Make the two schemas consistent: either add `description` to `CreateItemRequest.required` (description mandatory on create), or drop `description` from `Item.required` / give it a server default of `""` so an item created without a description still satisfies the response schema. Pick one and state it so the create and read contracts agree. |
| 2 | Minor | `/items/{sku}` `put` description vs `UpdateItemRequest.additionalProperties: false` | The `put` prose promises a quantity-setting attempt is "rejected with a validation error guiding the caller to POST /items/{sku}/adjustments." With `additionalProperties: false`, a `quantity` field is rejected as a generic unknown-property validation error; the schema alone does not carry the guided "use adjustments" message. The 400 outcome is correct and US1.4/AC1.4.3 (quantity not settable via update) is honoured; only the helpful-message promise is not expressed by the contract. | Non-blocking. Either soften the prose to "rejected as a validation error" or have the handler special-case a present-but-forbidden `quantity` key to emit the guiding message. The invariant itself is correctly enforced by `additionalProperties: false`. |
| 3 | Minor | OpenAPI `/items` `get` — `ItemPage` has no `nextCursor`; prose fixes offset/limit | Pagination resolves to offset/limit per Q2→A and FR1.4/OQ1; `ItemPage` carries `items`, `total`, `limit`, `offset` — sufficient for a client to compute the next page. This is correct and consistent, flagged only so the human notes FR1.4's "information needed to request the next page" is satisfied implicitly (client derives `offset + limit`) rather than via an explicit next-page token. | Non-blocking. No action needed for MVP. If a future client wants an explicit affordance, add an optional `hasMore` boolean within `/v1` (additive-safe per the stated ownership rules). |
| 4 | Minor | Contract 1 ownership rules — "unknown codes as a generic failure" | The ownership rules state the `Error.code` enum is a closed set yet also say adding a new code is "additive only if consumers treat unknown codes as a generic failure." The OpenAPI `Error.code` is a hard `enum` of five values, so a sixth code would fail strict response validation on a conforming consumer — the additive claim depends on consumers NOT validating against the enum. This is a sound forward-compat stance but is in mild tension with publishing a closed `enum` in the spec. | Non-blocking. Note for a future revision: if codes are meant to be forward-extensible, document the enum as "known codes; consumers must tolerate unknown values" (or drop the strict `enum` in favour of a documented list) so additive evolution does not break enum-validating clients. No MVP change required. |

### Validation Tool Results

| Check | Result | Interpretation |
|---|---|---|
| OpenAPI YAML parses (`yaml.parse`) | PASS | The inline block is well-formed YAML; `openapi: 3.0.3`; 4 paths, 6 schemas parsed cleanly. |
| `$ref` resolution | PASS | All six `#/components/schemas/*` refs (`Item`, `CreateItemRequest`, `UpdateItemRequest`, `AdjustStockRequest`, `ItemPage`, `Error`) resolve to defined schemas; no broken references. |
| Endpoint ↔ requirement coverage | PASS | FR1.1 POST /items; FR1.2 409 DuplicateSku; FR1.3 GET /items/{sku}+404; FR1.4 GET /items limit/offset+ItemPage; FR1.5 PUT /items/{sku}; FR1.6 DELETE 204+404; FR2.1–2.5 POST /items/{sku}/adjustments (409 InsufficientStock, 404, read-after-write noted); FR3.1 single Error envelope; NFR3 /health. Every required endpoint present. |
| Status-code mapping vs AC3.1.2/AC3.1.3 | PASS | ValidationError 400, ItemNotFound 404, DuplicateSku 409, InsufficientStock 409 (Q3→A), InternalError 500 — matches the acceptance mapping exactly. |
| Error enum closed; ConcurrencyConflict excluded | PASS | `code` enum = `[ValidationError, ItemNotFound, DuplicateSku, InsufficientStock, InternalError]`; `ConcurrencyConflict` correctly absent (Q4→A transparent). |
| Quantity-not-via-update (US1.4/AC1.4.3) | PASS | `UpdateItemRequest` exposes only `name`/`description` with `additionalProperties: false`; quantity cannot be set via update. |
| Boundary table vs single-node DAG | PASS | `unit-of-work-dependency` is one node `depends_on: []`; the contracts table has exactly one row (public REST API, U1 owner), no invented inter-unit contracts. |
| Scope fidelity (single location, deferred auth) | PASS | No location dimension (C3); no auth at MVP (A1/Q5→A), documented as a future `/v1`-additive-or-new-version revision; no over-reach beyond MVP endpoints. |

### Summary

This advisory pass reaches READY: the public REST API contract is well-formed, fully resolves against upstream, and a developer could implement from it. The inline OpenAPI parses as valid YAML with all six `$ref` targets resolving, every requirement endpoint is present (item CRUD FR1.1–FR1.6, stock adjustment FR2.1–FR2.5, pagination FR1.4, the single error envelope FR3.1–FR3.2, and the NFR3 health check), the status-code mapping matches AC3.1.2/AC3.1.3 exactly, the `Error.code` enum is a closed five-value set with `ConcurrencyConflict` correctly held transparent (Q4→A), quantity-not-settable-via-update is enforced by `UpdateItemRequest.additionalProperties: false` (US1.4/AC1.4.3), and the single-row contracts table correctly reflects the single-node DAG without inventing inter-unit contracts. Ownership/versioning (U1 owns the spec, `/v1` prefix, additive-safe evolution, breaking changes require `/v2`) is present and sound, and MVP scope (single location, deferred auth) is respected. The one Major finding is a genuine, machine-checkable schema inconsistency the human should weigh before approving: `description` is optional on `CreateItemRequest` but required on the `Item` returned to callers, so a create omitting description cannot satisfy both schemas — a one-line decision (make it required on create, or optional/defaulted on `Item`) closes it. The three Minor findings are a prose-vs-schema gap on the quantity-reject message, an implicit (but sufficient) next-page affordance in `ItemPage`, and a mild closed-enum-vs-forward-compat tension in the ownership rules — none blocks approval. Zero Critical, one Major.

---
