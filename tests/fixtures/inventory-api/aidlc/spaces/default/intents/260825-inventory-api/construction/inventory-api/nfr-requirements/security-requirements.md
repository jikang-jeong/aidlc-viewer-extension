# Security Requirements — inventory-api (U1)

> Detailed security NFRs for the single-location Inventory Management API (MVP).
> Grounded in the affirmed project rules (input validation at the boundary, no
> hardcoded secrets, secret/dependency scanning in CI) and the deferred-auth
> decision (A1 / OQ3 → no application-layer auth at MVP, internal network
> boundary trusted).

## Sources

- `requirements` (Requirements Analysis) — NFR2 (input validation at boundary),
  NFR4 (no hardcoded secrets), A1 (no auth at MVP), OQ3 (API-key question).
- `rules` (this phase) — BR4.1 (validate/sanitize at the boundary), BR4.2 (no
  hardcoded secrets), BR3.1/BR3.2 (error envelope — no internal detail leakage).
- `functional-spec` (this phase) — WF1–WF6 validation steps, WF-ERR envelope.
- `contract-summary` (Contract Design) — closed error-code enum, additive
  `X-Api-Key`/401 future-auth path.
- `nfr-requirements-questions.md` (this stage) — Q1 (datastore secret handling),
  Q2 (auth posture = internal network boundary at MVP).
- Project `## Forbidden` / `## Mandated` — no hardcoded secrets; validate at the
  boundary; gitleaks + Dependabot in CI.

## Requirements

| ID | Requirement | Detail | Status |
|----|-------------|--------|--------|
| NFR2.1 | Validate and sanitize ALL inputs at the API boundary before any domain or datastore logic. | SKU trimmed/non-empty/1–64; name non-empty; quantity non-negative integer; delta non-zero integer; limit 1–100; offset ≥ 0; update payload restricted to name/description (BR4.1). Invalid → `ValidationError` (400), never persisted. | Binding |
| NFR2.2 | Error responses leak no internal detail. | Single envelope (BR3.1): machine code from the closed set, human message, requestId, optional field list on ValidationError. Unexpected failures → `InternalError` 500, logged server-side; stack traces/SQL/datastore errors never returned (BR3.2). | Binding |
| NFR4.1 | No configuration secret is hardcoded. | Datastore credentials / connection config sourced from environment variables or a secrets manager (BR4.2); never a literal in source. | Binding |
| NFR4.2 | Secret scanning and dependency scanning enforced in CI. | gitleaks (secret scan) and Dependabot (dependency scan) run in CI so the no-hardcoded-secrets rule is actively enforced (project Mandated rule). | Binding |
| NFR2.3 | Authentication/authorization at MVP. | **No application-layer auth** (A1 / Q2→A): the API trusts the internal network boundary (security group / private subnet / VPC). Documented as a consciously accepted deferral, NOT an oversight. | Accepted deferral |
| NFR2.4 | Future auth is an additive change. | When auth is introduced it adds an `X-Api-Key` header + `401` response (additive-safe within `/v1` if optional; a new version if enforced) per the contract. No design decision locks it out. | Future revision |
| NFR2.5 | Transport security. | All traffic served over HTTPS/TLS 1.2+ (terminated at the load balancer / API gateway). No plaintext HTTP in any deployed environment. | Binding |

## Threat considerations (STRIDE, scoped to MVP)

| Category | Exposure | MVP mitigation |
|----------|----------|----------------|
| **S**poofing | No per-caller identity at MVP (deferred auth). | Internal network boundary trusted (A1); documented residual risk; API-key path reserved. |
| **T**ampering | Request payloads, stored quantity. | Boundary validation (NFR2.1); atomic conditional update prevents lost-update tampering (NFR1 / BR2.3); TLS in transit (NFR2.5). |
| **R**epudiation | Who changed stock. | Per-request structured log with `requestId` + outcome (BR5.1) gives a basic action trail (no auth identity at MVP — a known limitation). |
| **I**nformation disclosure | Error detail, secrets. | Envelope hides internals (NFR2.2); no secrets in code/logs (NFR4.1, BR5.1 "no bodies/secrets"); TLS. |
| **D**enial of service | Unbounded list, flood. | Pagination bound (NFR1.4); platform/gateway throttling recommended at Infrastructure Design (not an application requirement at MVP). |
| **E**levation of privilege | No roles at MVP. | Not applicable — no auth/role model at MVP; revisit with NFR2.4. |

## Residual-risk note

The single substantive residual security risk at MVP is the **absence of
caller authentication** (NFR2.3). This is an explicit, accepted MVP scope
decision (A1), bounded by the trusted internal network boundary and reversible
via the reserved additive API-key path (NFR2.4). It is recorded here so a
reviewer and the human approver can weigh it rather than discover it later.
