# Reliability Requirements — inventory-api (U1)

> Detailed reliability NFRs for the single-location Inventory Management API
> (MVP). Availability SLO set at 99.9% (Q3); correctness is the primary bar
> (NFR1); recovery objectives stated qualitatively at MVP.

## Sources

- `requirements` (Requirements Analysis) — NFR1 (correctness/consistency is the
  primary acceptance bar), NFR3 (health check), performance deferral.
- `functional-spec` (this phase) — WF7 health check, WF-ERR error envelope,
  WF6 atomic adjustment.
- `rules` (this phase) — BR2.3 (lossless adjustments), BR2.4 (read-after-write),
  BR5.2 (health endpoint).
- `contract-summary` (Contract Design) — `/health` endpoint, InternalError 500
  mapping.
- `nfr-requirements-questions.md` (this stage) — Q1 (DynamoDB durability),
  Q3 (99.9% SLO).

## Requirements

| ID | Requirement | Target | Status |
|----|-------------|--------|--------|
| NFR1.11 | Service availability SLO. | **99.9%** successful-request rate over a 30-day rolling window (three nines ≈ 43.8 min/month budget). | Binding (MVP) |
| NFR1.12 | Correctness under failure takes precedence over availability. | A failed adjustment leaves stored quantity unchanged (BR2.2); a transient datastore write conflict is retried internally and never corrupts or surfaces (BR2.3). No partial/torn adjustment is ever persisted. | Binding (MVP) |
| NFR3.1 | Health-check endpoint for readiness/liveness probes. | `GET /health` → 200 `{status:"ok"}` when able to serve (BR5.2); used by the platform to restart/replace unhealthy instances. | Binding (MVP) |
| NFR1.13 | Fault tolerance via stateless auto-restart. | Stateless instances (NFR1.6) are replaceable; an unhealthy instance is restarted/replaced automatically (health-check driven). No in-instance state is lost. | Binding (MVP) |
| NFR1.14 | Data durability. | Stock data persisted in a managed datastore (DynamoDB per Q1) with its managed replication/durability; no application-side durability mechanism required at MVP. Point-in-time recovery configuration is an Infrastructure Design decision. | Binding (MVP) |
| NFR1.15 | Graceful failure. | Unexpected failures return `InternalError` 500 via the single envelope (BR3.2) and are logged (BR5.1); the service does not crash the process on a handled request error. | Binding (MVP) |
| NFR1.16 | Recovery objectives (RTO/RPO/MTTR as numeric targets). | **Qualitative at MVP**: RTO bounded by auto-restart (seconds–minutes); RPO bounded by the managed datastore's durability (no app-side data loss window); numeric MTTR/RTO/RPO deferred with performance. | Deferred (numeric) |

## SLO rationale

99.9% is the standard target for a single internal service with health checks,
auto-restart, and alerting — achievable without multi-region cost, and
appropriate for an internal MVP where correctness (NFR1), not maximal uptime, is
the headline requirement. A stricter target (99.95%+) would require multi-AZ
active failover and is explicitly out of MVP scope; it can be raised later
without redesign.

## Degradation posture

- Datastore unavailable → requests fail with `InternalError` 500 (logged); no
  stale/incorrect data served (correctness over availability, NFR1.12).
- No cached fallback or read-only mode at MVP (would risk serving stale stock,
  contradicting NFR1). Deferred unless a real availability need surfaces.
