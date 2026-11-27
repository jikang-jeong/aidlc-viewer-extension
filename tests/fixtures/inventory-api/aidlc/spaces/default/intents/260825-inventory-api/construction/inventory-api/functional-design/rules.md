# Business Rules — inventory-api (U1)

> The business rules the service enforces. The fenced `yaml` block is the
> **source of truth**; the summary table beneath it is derived. Each rule is
> `BR{group}.{seq}` so the traceability sensor can resolve `rules.md` targets.
> Rule groups: BR1 item lifecycle/CRUD, BR2 stock adjustment, BR3 error contract,
> BR4 input validation, BR5 observability.

## Sources

- `requirements` (Requirements Analysis) — FR1.1–FR1.6, FR2.1–FR2.5, FR3.1–FR3.2,
  NFR1–NFR4.
- `components` (Domain Design) — typed domain errors `ItemNotFound`,
  `DuplicateSku`, `InsufficientStock`; quantity-only-via-adjustment invariant.
- `contract-summary` (Contract Design) — status-code mapping, offset/limit
  pagination (offset cap 10000), transparent concurrency conflict, overflow
  rejection, and Cognito JWT bearer auth with the gateway's own 401 body
  (contract Q7, Q8, Q10, Q11).
- `functional-design-questions.md` (this stage) — Q1–Q5.

Rule groups add BR6 authentication.

## Rules (source of truth)

```yaml
rules:
  # --- BR1: item lifecycle / CRUD ---
  - id: BR1.1
    statement: Creating an item requires a unique, non-empty, well-formed SKU; a duplicate SKU is rejected and no item is written.
    category: constraint
    applies_to: Item (create)
    trigger: POST /items
    logic: >
      IF an item with the request SKU already exists THEN reject with DuplicateSku
      (409) and write nothing ELSE create the item with the supplied sku, name,
      description (defaulting to "" when omitted), and initial quantity.
    violation_behaviour: Reject with DuplicateSku (HTTP 409); store nothing.
    source: FR1.1, FR1.2
  - id: BR1.2
    statement: An item is retrieved, updated, deleted, or adjusted by its SKU; an unknown SKU is a not-found error.
    category: constraint
    applies_to: Item (get/update/delete/adjust)
    trigger: GET/PUT/DELETE /items/{sku}, POST /items/{sku}/adjustments
    logic: IF no item exists for the SKU THEN reject with ItemNotFound (404) ELSE perform the operation.
    violation_behaviour: Reject with ItemNotFound (HTTP 404).
    source: FR1.3, FR1.5, FR1.6, FR2.4
  - id: BR1.3
    statement: Item update may change only name and description; quantity is never settable via update.
    category: constraint
    applies_to: Item (update)
    trigger: PUT /items/{sku}
    logic: >
      IF the update payload is empty, or contains any field other than
      name/description (including quantity), THEN reject with ValidationError
      (400); a quantity field gets a fields[] entry for quantity whose reason
      says quantity changes only via POST /items/{sku}/adjustments. ELSE apply
      the provided name and/or description and leave quantity unchanged.
    violation_behaviour: Reject with ValidationError (HTTP 400); no field changes.
    source: FR1.5, US1.4
  - id: BR1.4
    statement: Listing items returns a bounded page using offset/limit paging.
    category: policy
    applies_to: Item (list)
    trigger: GET /items
    logic: >
      Apply limit (default 20, maximum 100) and offset (default 0, minimum 0,
      maximum 10000); a limit outside 1-100 or an offset outside 0-10000 is a
      ValidationError. Return the page of items plus total, limit, and offset so
      the caller can request the next page (offset + limit).
    violation_behaviour: Reject an out-of-range pagination parameter with ValidationError (HTTP 400).
    source: FR1.4, OQ1, contract Q11
  - id: BR1.5
    statement: Delete is a hard delete; after deletion the SKU is not found.
    category: policy
    applies_to: Item (delete)
    trigger: DELETE /items/{sku}
    logic: IF the item exists THEN remove it permanently (204) and a later read returns ItemNotFound ELSE return ItemNotFound (404).
    violation_behaviour: n/a (idempotent effect — absent item yields 404).
    source: FR1.6

  # --- BR2: stock adjustment ---
  - id: BR2.1
    statement: A stock adjustment applies a signed non-zero integer delta to an item's quantity.
    category: validation
    applies_to: Item.quantity (adjust)
    trigger: POST /items/{sku}/adjustments
    logic: >
      IF delta is missing, zero, not an integer, or outside
      -9007199254740991..9007199254740991 THEN reject with ValidationError (400).
      ELSE IF current_quantity + delta > 9007199254740991 (the largest safe
      integer) THEN reject with ValidationError (400) and leave quantity
      unchanged. ELSE apply the delta to the current quantity.
    violation_behaviour: Reject with ValidationError (HTTP 400); quantity unchanged.
    source: FR2.1, contract Q10
  - id: BR2.2
    statement: An adjustment that would drive quantity below zero is rejected and leaves the stored quantity unchanged.
    category: constraint
    applies_to: Item.quantity (adjust)
    trigger: POST /items/{sku}/adjustments
    logic: IF current_quantity + delta < 0 THEN reject with InsufficientStock (409) and do not change quantity ELSE set quantity = current_quantity + delta.
    violation_behaviour: Reject with InsufficientStock (HTTP 409); quantity unchanged.
    source: FR2.3
  - id: BR2.3
    statement: Concurrent adjustments to the same item never lose updates and the conflict is never surfaced to the caller.
    category: constraint
    applies_to: Item.quantity (concurrent adjust)
    trigger: Two or more overlapping POST /items/{sku}/adjustments on one SKU
    logic: >
      The adjustment is logically atomic: for N concurrent adjustments the final
      quantity equals the initial quantity plus the sum of all successfully
      applied deltas. A transient internal write conflict is retried internally a
      bounded number of times and is NEVER returned to the caller; only a genuine
      business rejection (InsufficientStock, ItemNotFound, ValidationError) is
      ever returned. The concrete concurrency mechanism (atomic conditional
      update vs optimistic version + retry) is an infrastructure-design decision
      and does not change this observable rule.
    violation_behaviour: >
      A lost update is a defect, verified by the mandatory concurrent-adjustment
      race test (NFR1); ConcurrencyConflict is deliberately absent from the public
      error set.
    source: FR2.2, NFR1, OQ2
  - id: BR2.4
    statement: After a successful adjustment, any subsequent read reflects the new quantity (read-after-write).
    category: constraint
    applies_to: Item.quantity (adjust then read)
    trigger: A read following a successful adjustment of the same SKU
    logic: IF an adjustment succeeded THEN a subsequent GET of that SKU returns the post-adjustment quantity with no staleness window.
    violation_behaviour: A stale read after a successful adjustment is a correctness defect (NFR1 / A3).
    source: FR2.5, NFR1

  # --- BR3: error contract ---
  - id: BR3.1
    statement: Every failure the service itself returns uses the single consistent JSON error envelope.
    category: policy
    applies_to: All endpoints (failure path)
    trigger: Any request that fails inside the service
    logic: >
      Return an envelope with code (machine-readable, from the closed set
      ValidationError|ItemNotFound|DuplicateSku|InsufficientStock|InternalError),
      message (human-readable), requestId (correlates with the structured log),
      and fields[] present only on ValidationError (one entry per offending field).
      The one exception is 401: a missing or invalid token is rejected by the
      API Gateway JWT check before the service runs, with the gateway's own body
      {"message":"Unauthorized"} (BR6.1).
    violation_behaviour: n/a (this rule defines the failure shape).
    source: FR3.1, contract Q8
  - id: BR3.2
    statement: Typed domain errors map to fixed HTTP status codes; unexpected failures are 500 and logged.
    category: policy
    applies_to: All endpoints (failure path)
    trigger: A typed domain error or an unexpected failure
    logic: >
      MAP ValidationError->400, ItemNotFound->404, DuplicateSku->409,
      InsufficientStock->409, and any unexpected/unhandled failure->InternalError
      500 (logged). The mapping is identical across every endpoint.
    violation_behaviour: An inconsistent status mapping is a contract violation (FR3.2).
    source: FR3.2

  # --- BR4: input validation ---
  - id: BR4.1
    statement: All inputs are validated and sanitized at the API boundary before any domain or datastore logic runs.
    category: validation
    applies_to: All request bodies and path/query parameters
    trigger: Any request
    logic: >
      Validate presence, type, range, and format at the boundary: SKU (body and
      path alike) trimmed of surrounding whitespace first, then required
      non-empty and length 1-64, and the trimmed value is what is stored and
      looked up; name non-empty after trim, at most 200 characters; description
      at most 2000 characters; quantity an integer 0-9007199254740991;
      delta a non-zero integer within -9007199254740991..9007199254740991;
      limit 1-100; offset 0-10000; update payload restricted to name/description.
      Invalid input returns a ValidationError (400) envelope and NEVER reaches
      persistence.
    violation_behaviour: Reject with ValidationError (HTTP 400) at the boundary; nothing persisted.
    source: NFR2, US4.1
  - id: BR4.2
    statement: No configuration secret is hardcoded; secrets come from the environment or a secrets manager.
    category: constraint
    applies_to: Service configuration
    trigger: Service startup / any secret access
    logic: IF a secret (datastore credential, etc.) is needed THEN read it from an environment variable or secrets manager; NEVER a hardcoded literal.
    violation_behaviour: A hardcoded secret is a security defect (NFR4; project Forbidden rule).
    source: NFR4

  # --- BR5: observability ---
  - id: BR5.1
    statement: Every request emits one structured log entry with a fixed minimum field set.
    category: policy
    applies_to: All endpoints
    trigger: Each request (on completion)
    logic: >
      Emit a structured (JSON) log line per request that reaches the service,
      carrying requestId, timestamp, method, route, statusCode, latencyMs, and
      outcome (success or the typed error code). Never log request/response
      bodies or secrets. The requestId matches the one in the error envelope
      (BR3.1). A request rejected with 401 by the token check (BR6.1) never
      reaches the service; it is recorded instead in the gateway access log
      (requestId, timestamp, method, route, statusCode), whose exact setup is an
      infrastructure-design decision.
    violation_behaviour: A missing or unstructured request log is an observability defect (NFR3).
    source: NFR3
  - id: BR5.2
    statement: A health-check endpoint reports service readiness/liveness.
    category: policy
    applies_to: Service (health)
    trigger: GET /health
    logic: >
      Return 200 with a small status body, status equal to "ok", when the
      service is able to serve requests. No token is required (BR6.1).
    violation_behaviour: n/a (defines the health contract).
    source: NFR3

  # --- BR6: authentication ---
  - id: BR6.1
    statement: Every item route requires a valid Cognito user pool JWT bearer token; the health check is open.
    category: authorization
    applies_to: All /items routes
    trigger: Any request to GET/POST /items, GET/PUT/DELETE /items/{sku}, POST /items/{sku}/adjustments
    logic: >
      IF the request has no Authorization bearer token, or the token is not a
      valid JWT from the service's single identity provider user pool, THEN the
      edge token check rejects it with 401 and body {"message":"Unauthorized"}
      before any service logic, validation, or persistence runs ELSE the request
      proceeds. GET /health needs no token. There are no roles: any valid user
      may call every item route. The contract names the provider (a Cognito user
      pool checked at an API Gateway JWT authorizer); infrastructure design
      places it.
    violation_behaviour: Reject with HTTP 401 and the gateway body; nothing reaches the service.
    source: contract Q7, contract Q8
```

## Rules Summary (derived)

| ID | Statement | Category | Source |
|----|-----------|----------|--------|
| BR1.1 | Unique, well-formed SKU on create; duplicate rejected | constraint | FR1.1, FR1.2 |
| BR1.2 | Operate by SKU; unknown SKU → not found | constraint | FR1.3/1.5/1.6, FR2.4 |
| BR1.3 | Update changes only name/description; never quantity | constraint | FR1.5, US1.4 |
| BR1.4 | List uses offset/limit (limit default 20, max 100; offset max 10000) | policy | FR1.4, OQ1, contract Q11 |
| BR1.5 | Hard delete; later read is not-found | policy | FR1.6 |
| BR2.1 | Adjustment delta is a signed non-zero integer; result above the largest safe integer rejected | validation | FR2.1, contract Q10 |
| BR2.2 | Below-zero adjustment rejected, quantity unchanged | constraint | FR2.3 |
| BR2.3 | Concurrent adjustments lossless; conflict never surfaced | constraint | FR2.2, NFR1, OQ2 |
| BR2.4 | Read-after-write consistency after adjustment | constraint | FR2.5, NFR1 |
| BR3.1 | Single consistent error envelope (401 excepted: gateway body) | policy | FR3.1, contract Q8 |
| BR3.2 | Typed-error → HTTP status mapping; unexpected → 500 | policy | FR3.2 |
| BR4.1 | Validate/sanitize all inputs at the boundary | validation | NFR2, US4.1 |
| BR4.2 | No hardcoded secrets | constraint | NFR4 |
| BR5.1 | Structured per-request log with fixed field set | policy | NFR3 |
| BR5.2 | Health-check endpoint (open) | policy | NFR3 |
| BR6.1 | Cognito JWT required on every item route; 401 from the gateway | authorization | contract Q7, Q8 |
