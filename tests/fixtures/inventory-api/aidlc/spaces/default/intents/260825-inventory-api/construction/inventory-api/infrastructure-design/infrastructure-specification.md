# Infrastructure Specification — inventory-api (U1)

> The concrete AWS realization of the NFR Design mechanisms for the single
> `inventory-api` service. Design-stage artifact: it names resources, their roles,
> and their configuration intent — not implementation-ready IaC. The CDK
> constructs, IAM policy documents, and Lambda handler wiring are written in Code
> Generation (3.5). Snippets here are illustrative (≤15 lines), never deployable.

## Sources

- `performance-design` (NFR Design) — NFR1.1–1.5: read-after-write via conditional `UpdateItem` `ReturnValues: ALL_NEW`, bounded retry, no cache tier, bounded pagination.
- `security-design` (NFR Design) — NFR2.1–2.5, NFR4.1–4.2: boundary validation, leak-proof error envelope, TLS 1.2+, no-auth-at-MVP network posture, additive `X-Api-Key` seam, injected secrets, CI scanning.
- `scalability-design` (NFR Design) — NFR1.6–1.10: stateless horizontal scale, datastore-owned per-item concurrency, `sku` partition key, DynamoDB on-demand capacity.
- `reliability-design` (NFR Design) — NFR1.11–1.16, NFR3.1: 99.9%/30-day target, `/health`-gated routing, auto-restart/replace, DynamoDB durability + PITR, correctness-over-availability.
- `observability-design` (NFR Design) — NFR3.2–3.9: structured JSON logs to CloudWatch Logs, requestId correlation, 5xx metric-filter alarm.
- `logical-components` (NFR Design) — the component inventory and the explicit handoff to this stage (compute placement, table config, LB/API-GW, network boundary, IAM grants, logs + alarm).
- `components` (Domain Design) — the `Item` entity (`sku`, `name`, `description`, `quantity`) and the `InventoryStore` external dependency.
- `functional-spec` (Functional Design) — WF-AUTH, WF1–WF7 and WF-ERR: the token check on every item route, the endpoints, the open `/health`, the atomic adjustment, the error envelope, and 401 logging at the gateway (BR5.1, BR6.1).
- `contract-summary` (Contract Design) — the `/v1` REST surface, status-code mapping, Cognito JWT bearer auth with the gateway's own 401 body (Q7, Q8), and the open token-flow question resolved here.
- `infrastructure-design-questions.md` (this stage) — Q1–Q6 confirmed decisions (Lambda+API Gateway, scaling bounds, 30-day retention, 5xx alarm, single staging environment, CDK/TypeScript).

## Deployment

| Facet | Choice | Rationale |
|-------|--------|-----------|
| Compute model | **AWS Lambda** (Node.js/TypeScript runtime, `arm64`/Graviton), one function fronting the service, behind **API Gateway HTTP API** (Q1→A) | Serverless matches the MVP's unknown/spiky load and the "no capacity numbers" posture: scales to zero, no instances to patch, pairs naturally with DynamoDB on-demand. `arm64` is the Well-Architected cost/sustainability default. The stateless-horizontal mechanism (NFR1.6) is realized by Lambda's per-request concurrency rather than LB replicas. |
| Networking topology | API Gateway HTTP API is the single public ingress; it terminates **TLS 1.2+**, runs the JWT authorizer on `/v1/*`, and routes all `/v1/*` paths to the Lambda's `live` alias. The health check is `GET /v1/health` (the contract's `servers: /v1` plus `/health`), a more specific route with no authorizer, which HTTP API matches ahead of `/v1/{proxy+}`. The Lambda holds no inbound network surface of its own. Egress to DynamoDB stays on the AWS network (a **VPC is not required** for the MVP — Lambda reaches DynamoDB over the AWS backbone via its service endpoint; a Gateway VPC endpoint is added only if the function is later placed in a VPC). | Realizes NFR2.5 (TLS at the edge): there is no path to the compute except through the gateway and its token check. Keeping the function out of a VPC avoids NAT/ENI cost and cold-start penalty with no security loss, since DynamoDB access is IAM-controlled, not network-controlled. |
| Network boundary / auth posture | **Cognito JWT bearer auth at the edge** (contract Q7, Q8; functional-design BR6.1). An **API Gateway HTTP API JWT authorizer** is attached to every `/v1/*` item route; `GET /v1/health` has no authorizer. A missing or invalid token is rejected by the gateway with **401** and its own body `{"message":"Unauthorized"}` before the Lambda is invoked. The API endpoint itself stays reachable over TLS from the internet; the token check, not network placement, is the access control. | Supersedes the NFR-design "trusted internal boundary, no app auth" posture (NFR2.3) and the reserved `X-Api-Key` seam (NFR2.4), after the person's Contract Design auth decision. It also closes the earlier review concern that a default HTTP API is internet-facing with no auth: every item route now requires a valid token. Doing the check at the gateway means no auth code in the handlers and no Lambda cost for rejected calls. |
| Storage strategy | All state in **DynamoDB** (see Infrastructure Services). No filesystem, no block storage, no in-memory authoritative state. | Realizes NFR1.6 (stateless) and NFR1.14 (managed durability); the compute tier is fully replaceable. |
| Environments | **Single `staging` environment** at this stage (Q5→C); production is added later as an identical-topology, scale-differentiated environment. Per-PR/CI validation is ephemeral and torn down after each run. | Deliberately the smallest footprint that proves the walking skeleton end-to-end (team deploy-on-merge-to-staging practice). The deploy-on-merge-to-staging cadence applies now; the gated-production promotion path is defined in `cicd-pipeline.md` and wired when the production environment is provisioned. Environment parity is preserved by construction: the same CDK app parameterized by environment, so adding production changes scale/config, never topology. |
| IaC approach | **AWS CDK (TypeScript)** (Q6→A), one CDK app, environment selected by context (`-c env=staging`). Stacks split by lifecycle: a **data stack** (DynamoDB) and an **auth stack** (Cognito user pool + app client), both stateful and rarely changed, separate from a **compute stack** (Lambda + API Gateway + JWT authorizer + logs + alarm). | Same language as the service; L2 constructs encode the security defaults (encryption, least-privilege `grant*`, log retention); cdk-nag runs as compliance-as-code in CI; CDK assertion tests fit the team's 80% coverage + CI-gate posture. Splitting the stateful data stack from the stateless compute stack lets the frequently-redeployed compute change without touching the durable table. |
| Resource sizing | Lambda memory start **512 MB** (tune later with Lambda Power Tuning; memory also scales CPU), timeout **10 s** (well above a bounded single-item DynamoDB op + ≤3 retries, well below the API Gateway 30 s integration limit). DynamoDB on-demand (no sizing). | No performance SLO at MVP (NFR1.5 deferred), so sizing is a sane starting point chosen for correctness headroom (the bounded-retry adjustment path must never time out mid-retry) rather than a tuned target. |

### Compute ↔ datastore access (illustrative, ≤15 lines)

```
// pseudocode — CDK intent, NOT the generated construct
const table = Table(dataStack, "Item", {
  partitionKey: { name: "sku", type: STRING },
  billingMode: ON_DEMAND,                 // NFR1.10 scalability
  pointInTimeRecovery: true,              // NFR1.14 durability
  deletionProtection: true,
  encryption: AWS_MANAGED,                // NFR2 / data-at-rest
});
const fn = Function(computeStack, "InventoryApi", { runtime: NODEJS_ARM64, memory: 512, timeout: 10s });
const live = fn.addAlias("live");         // API integrates the alias, so rollback is an alias move
table.grantReadWriteData(live);           // this table only, no wildcard
const pool = UserPool(authStack, "Users", { selfSignUpEnabled: false });
const client = pool.addClient("Api", { generateSecret: false });
const jwt = HttpJwtAuthorizer(issuer: pool.issuerUrl, audience: [client.id]);
httpApi.addRoutes({ path: "/v1/{proxy+}", integration: LambdaProxy(live), authorizer: jwt });
httpApi.addRoutes({ path: "/v1/health", methods: [GET], integration: LambdaProxy(live) });  // open; more specific route wins
```

## Infrastructure Services

| Service | Role | Configuration | Notes |
|---------|------|---------------|-------|
| **DynamoDB table `Item`** | database (the `InventoryStore` external dependency) | Partition key `sku` (string); **on-demand** billing (NFR1.10); **point-in-time recovery enabled** (NFR1.14); **encryption at rest** (AWS-managed key at MVP, upgradeable to a customer-managed KMS key without data migration); **deletion protection on**; single-item strongly-consistent reads/writes; the **atomic conditional `UpdateItem`** (`SET quantity = quantity + :delta` with condition `attribute_exists(sku) AND quantity >= :minCurrent AND quantity <= :maxCurrent`, where the handler precomputes `:minCurrent = max(0, -delta)` and `:maxCurrent = 9007199254740991 - max(0, delta)`, because a condition expression cannot do arithmetic; `ReturnValues: ALL_NEW`, `ReturnValuesOnConditionCheckFailure: ALL_OLD`) is the per-item concurrency mechanism (NFR1.7, BR2.1/BR2.2/BR2.3). Because the update is a single atomic `quantity + :delta`, a failed condition is never contention: it is a real business outcome, classified from the `ALL_OLD` item returned with the failure (no item → `ItemNotFound`; quantity below `:minCurrent` → `InsufficientStock`; above `:maxCurrent` → overflow `ValidationError`) with no second read and no retry. The bounded ≤3 jittered retry (performance-design NFR1.2) applies only to transient SDK errors (throttling, 5xx, timeouts, connection resets); this narrows performance-design's "retry on condition failure", which assumed a read-then-write update. | **Every access by key is by `sku`; listing uses a `Scan`.** No secondary index at MVP. `GET /v1/items` pages through a `Scan` with `Limit` and `ExclusiveStartKey`, skipping `offset` items; the 10000 `offset` cap bounds one request to reading at most 10100 items. `total` comes from a `Scan` with `Select: COUNT`, so its cost grows with the table. Both are accepted for a single-location MVP catalogue with no performance target (NFR1.5 deferred); a maintained count item and a cursor-based list are the upgrade path. On-demand removes capacity planning; `sku`-keyed load spreads across partitions (NFR1.8), with write-sharding noted but not built for a future single-SKU hotspot. |
| **API Gateway HTTP API** | load balancer / ingress / TLS termination / token check | TLS 1.2+ minimum; routes `/v1/{proxy+}` (with the JWT authorizer) and `GET /v1/health` (no authorizer) to the Lambda's `live` alias; default throttling left at account defaults at MVP (a per-route throttle is the first lever if abuse appears); access logging to CloudWatch Logs with `requestId`, timestamp, method, route, status and authorizer error, so 401s (which never reach the Lambda) are still logged (functional-design BR5.1; see monitoring-design). | HTTP API (not REST API) for lower cost/latency, native proxy integration, and a built-in JWT authorizer; it is both the "load balancer" and the TLS edge in the reliability/security designs. `GET /v1/health` is the target of a CloudWatch Synthetics canary (see monitoring-design) for uptime (NFR3.1/3.5); API Gateway itself does no health checks on a Lambda integration. Gateway-generated errors (401, 429 throttling, 5xx integration failures) carry the gateway's own `{"message": ...}` body, not the service envelope. |
| **HTTP API JWT authorizer** | access control (BR6.1) | Identity source `Authorization` header; issuer = the user pool's issuer URL; audience = the app client id. Validates signature, `iss`, `exp`, and the client id claim; no scopes required at MVP (any valid user may call every item route). | One authorizer, attached to `/v1/{proxy+}` only. |
| **Cognito user pool `inventory-api-users`** | identity provider | Self sign-up **off**; users created by an admin (console or `admin-create-user`, then `admin-set-user-password --permanent` so the first sign-in returns tokens rather than a password-change challenge); one **app client with no secret**, auth flows `ALLOW_USER_PASSWORD_AUTH` (scripted callers and the smoke test) and `ALLOW_REFRESH_TOKEN_AUTH`; access-token lifetime **1 hour**, refresh-token lifetime **30 days**; deletion protection on. A dedicated smoke-test user's password lives in Secrets Manager. | In its own small **auth stack**, stateful like the data stack, so compute redeploys never touch it. Resolves the contract's open token-flow question: callers get an access token with `initiate-auth` (`USER_PASSWORD_AUTH`) and send it as `Authorization: Bearer <token>`. |
| **AWS Lambda `InventoryApi`** | compute (stateless service: handler → service → repository layers) | `arm64`, 512 MB, 10 s timeout; scales per request on demand with no provisioned floor (scale-to-zero) and **reserved concurrency 50** as the hard cap (NFR1.6/1.10, Q2→A); no concurrency target tracking, which applies only to provisioned concurrency; a `live` alias is what API Gateway invokes; module-scoped AWS SDK client with HTTP keep-alive reused across warm invocations (performance-design connection-reuse). | SIGTERM graceful-shutdown (reliability-design) maps to Lambda's execution-environment shutdown hook; in-flight work is a single bounded request, so draining is inherently short. Correctness-over-availability: on DynamoDB unavailability the handler returns `InternalError` 500, never stale data (NFR1.12). |
| **CloudWatch Synthetics canary** | uptime probe | Calls `GET /v1/health` every 5 minutes from outside the service; a failed or non-200 run is a failed probe. | Gives the "Health failing" alert something to measure; Lambda has no readiness/liveness probes. |
| **CloudWatch Logs** | centralized log store | One log group per environment; **30-day retention** (Q3→A); receives the one-JSON-line-per-request structured logs (NFR3.2/3.7) and API Gateway access logs. | The 5xx metric filter + alarm live here — see `monitoring-design.md`. |
| **AWS Secrets Manager / SSM Parameter Store** | secrets & config injection | The config module reads datastore/config values at startup from Parameter Store (non-secret config) and Secrets Manager (any secret); never a literal in source (NFR4.1). At MVP the only "config" is the table name and region, injected as Lambda environment variables from CDK; Secrets Manager is wired as the injection point for when a real secret (e.g. a future API key) appears. | Realizes the single-injection-point design; the Lambda's execution role is granted read only to the specific parameter/secret paths, not `*`. |
| **IAM execution role** | least-privilege identity | One role for the Lambda: `dynamodb:GetItem/PutItem/UpdateItem/DeleteItem/Scan` scoped to the **`Item` table ARN only** (via CDK `table.grantReadWriteData(fn)`), CloudWatch Logs write to its own log group, and read on the specific Secrets Manager/SSM paths. No wildcards (NFR2 least-privilege). | The adjustment needs `UpdateItem` with a condition expression; `Scan` serves list paging and the `total` count (NFR1.4, bounded by the offset cap); `DeleteItem` serves the hard delete (WF5). No `dynamodb:*`, no `Resource: *`. |

## Shared Infrastructure

Not applicable. The dependency DAG is a single node (`inventory-api`, U1,
`depends_on: []`) with no inter-unit boundaries (`contract-summary`,
`logical-components`), so there are no resources shared across units. The
DynamoDB table is owned and consumed solely by this one service. This section is
CONDITIONAL and intentionally empty for a single-unit system.

## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-10-21T11:18:00Z
**Iteration:** 1

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Major | infrastructure-specification.md "Networking topology" / "Network boundary / auth posture" rows; traceability.json NFR2.3 | NFR2.3's security-design control is a **network boundary that admits only internal callers / no public ingress** (security-design.md "Authentication" row: "private subnet / behind a security group that admits only internal callers"; trust-boundary text: "no public ingress"). The infra realizes the *compute* placement (Lambda has no inbound surface) but names **no resource that restricts the ingress itself**. API Gateway HTTP API is called "the single **public** ingress" and asserted "reachable only by internal callers," yet no mechanism (resource policy, WAF/IP allow-list, private API Gateway + VPC endpoint, mTLS) is specified. A default HTTP API is internet-facing; with no app auth (NFR2.3) **and** no ingress restriction, the MVP is a publicly reachable unauthenticated API. The rationale shifts the security-design claim from "no public ingress" to "no public path *to the compute*" — a weaker guarantee that does not realize the boundary NFR2.3 depends on. A developer cannot build the "internal callers only" boundary from this doc because the mechanism is unstated. | Name the ingress-restriction resource that realizes the trusted-internal boundary (e.g. API Gateway resource policy scoped to a corporate CIDR / VPC-source, or a private API Gateway fronted by a VPC endpoint, or AWS WAF IP set), OR explicitly restate NFR2.3 as an accepted residual (public ingress + no auth at MVP) with the security-design's STRIDE owner, so the deviation from "private subnet / no public ingress" is a documented decision rather than a silent weakening. Update the NFR2.3 traceability target to the chosen concrete resource. |
| 2 | Minor | traceability.json NFR1.10 target | Target reads "Lambda concurrency target-tracking (min 2 / max 10 equivalent, ~50 max-concurrency cap)", but the spec's Lambda row and Q2→A decided **scale-to-zero, no reserved floor**, max-concurrency cap ~50. "min 2" is leftover generic Q2 option text and contradicts the chosen serverless posture. | Drop "min 2 / max 10 equivalent"; state "DynamoDB on-demand + Lambda scale-to-zero, reserved/max-concurrency cap ~50". |
| 3 | Minor | cicd-pipeline.md "Deployment strategy" | Staging deploy offers both a CodeDeploy canary/linear alias shift and "a straight all-at-once alias update is acceptable" for earliest MVP. The default is ambiguous for the implementer. | State the MVP default explicitly (e.g. all-at-once now, canary as first hardening step) so code-generation has one target. |

### Validation Tool Results

| Tool / check | Result | Interpretation |
|---|---|---|
| traceability.json well-formed JSON | PASS (bun parse OK) | Valid JSON. |
| upstream_ids == coverage id set | PASS (20 == 20, no asymmetry) | Every declared upstream id is covered; no stray coverage id. |
| reverse[] N/A/Deferred carry justification | PASS (12/12 have non-empty target) | NFR1.3/1.12/1.15/2.1/2.2/3.2/3.3/3.4 (N/A) and NFR1.5/1.16/3.8/3.9 (Deferred) each justified as application-code vs infra, or SLO-deferred — defensible. |
| coverage[].target = concrete AWS resource/config | PASS with 1 exception | All OK targets name concrete resources (DynamoDB config, API Gateway, Lambda, CloudWatch metric filter/alarm, Secrets Manager, IAM grant). Exception: NFR2.3 target ("trusted internal boundary ... no inbound surface") describes a *posture*, not an ingress-restriction resource — see finding #1. |
| ≥2 H2 headings per produced .md | PASS (infra-spec 4, monitoring 5, cicd 6) | All satisfy required-sections. `## Sources` present for claim-sources. |
| specs reference every consumes artifact | PASS | infra-spec `## Sources` cites performance/security/scalability/reliability/observability-design, logical-components, components, functional-spec, contract-summary. upstream-coverage satisfied. |
| CI/CD gates vs team.md + project.md | PASS | gitleaks (stage 2), ESLint type-aware+security (3), Prettier --check (4), tsc --noEmit (5), mandatory concurrency race test (6), 80% line-coverage blocking (8), Dependabot/npm audit (9) all present and marked blocking. No required gate missing. |
| Gated-production path preserved | PASS | cicd-pipeline.md keeps deploy-on-merge-to-staging now and the manual-approval (tech lead + product owner) production gate "defined and dormant" — practice preserved under the Q5→C human-directed single-staging decision. |
| Least-privilege IAM (no wildcards) | PASS | IAM role scoped to the `Item` table ARN via `grantReadWriteData`, enumerated DynamoDB actions, log-group-scoped Logs write, path-scoped Secrets/SSM read; explicit "No `dynamodb:*`, no `Resource: *`" — consistent with project.md. |
| Scope discipline (design-stage, snippets ≤15 lines) | PASS | Two pseudocode snippets (CDK intent, repository), each ≤15 lines and labelled non-deployable; no full IaC/handlers. |

### Summary

The design soundly realizes the NFR-design mechanisms on Lambda + API Gateway + DynamoDB + CloudWatch: stateless horizontal (NFR1.6), datastore-owned atomic concurrency (NFR1.7), TLS at the edge (NFR2.5), `/health` (NFR3.1), durability via on-demand + PITR + encryption (NFR1.14), least-privilege table-scoped IAM, and a complete CI/CD gate set matching team/project practices; traceability is structurally clean and the gated-production path is preserved. The one Major finding is that NFR2.3's load-bearing control — a network boundary admitting only internal callers — is asserted but not realized by any named ingress-restriction resource, shifting the security-design's "no public ingress" to a weaker "no public path to the compute"; this should be either mechanized or explicitly re-accepted as a residual before code-generation. One Major and two Minors do not block READY (zero Critical, ≤2 Major); the Major is the item to resolve at the approval gate or in code-generation.
