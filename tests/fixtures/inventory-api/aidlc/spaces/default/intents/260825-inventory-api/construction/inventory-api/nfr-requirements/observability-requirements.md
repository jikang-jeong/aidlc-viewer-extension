# Observability Requirements — inventory-api (U1)

> Detailed observability NFRs for the single-location Inventory Management API
> (MVP). Log-based observability with a locked structured-log field set
> (Q4), the `/health` endpoint, and basic error-rate alerting; metrics and
> distributed tracing deferred.

## Sources

- `requirements` (Requirements Analysis) — NFR3 (structured logs per request +
  health check), NFR1 (correctness verified by the mandatory race test).
- `functional-spec` (this phase) — cross-cutting per-request logging, WF7 health
  check, WF-ERR requestId correlation.
- `rules` (this phase) — BR5.1 (structured per-request log, fixed field set),
  BR5.2 (health endpoint), BR3.1 (requestId in envelope).
- `contract-summary` (Contract Design) — `requestId` in the Error envelope,
  `/health` 200 contract.
- `nfr-requirements-questions.md` (this stage) — Q4 (lock field set, defer
  metrics/tracing).

## Requirements

| ID | Requirement | Detail | Status |
|----|-------------|--------|--------|
| NFR3.2 | Every request emits exactly one structured (JSON) log entry on completion. | Mandated field set: `requestId`, `timestamp`, `method`, `route`, `statusCode`, `latencyMs`, `outcome` (success or the typed error code). This is the locked log contract (BR5.1). | Binding (MVP) |
| NFR3.3 | `requestId` correlates the log entry with the response error envelope. | The `requestId` in a failure's `Error` envelope (BR3.1) equals the one in that request's log entry, so a client-reported id locates the server log. | Binding (MVP) |
| NFR3.4 | No sensitive data in logs. | Never log request/response bodies, secrets, or credentials (BR5.1); only the fixed field set above. | Binding (MVP) |
| NFR3.5 | Health-check endpoint for observability/probes. | `GET /health` → 200 `{status:"ok"}` (BR5.2); scraped by the platform for liveness/readiness. | Binding (MVP) |
| NFR3.6 | Basic error-rate alerting. | Alert on elevated 5xx (`InternalError`) rate over a short window (symptom-based, not cause-based), routed to the team. Threshold tuned at Infrastructure/Operations design; the requirement to HAVE one is binding at MVP. | Binding (MVP) |
| NFR3.7 | Logs shipped to centralized, queryable storage. | Structured logs collected centrally (e.g. CloudWatch Logs) so an operator can query by `requestId`, `statusCode`, or `outcome`. Retention policy set at Infrastructure Design. | Binding (MVP) |
| NFR3.8 | Metrics baseline (request count, error rate, p95 latency as emitted metrics). | **Deferred** at MVP — latency/outcome are captured in logs (NFR3.2) and derivable from them; dedicated metrics emission revisited with performance. | Deferred |
| NFR3.9 | Distributed tracing (W3C trace context propagation). | **Deferred** — single service, no inter-unit calls at MVP; add when a downstream dependency or multi-service topology appears. | Deferred |

## SLI/SLO linkage

- **Availability SLI** = successful requests / total requests, derived from the
  `statusCode` / `outcome` log fields (NFR3.2); feeds the 99.9% SLO
  (reliability NFR1.11).
- **Latency SLI** = `latencyMs` distribution from logs (performance NFR1.3);
  no SLO yet (deferred), but the data is captured for a future target.

## Anti-patterns explicitly avoided

- No logging of bodies or secrets (NFR3.4).
- No cause-based alerting (e.g. alert on CPU) at MVP — error-rate symptom alert
  only (NFR3.6).
- No metrics/dashboard sprawl: the field set is fixed and minimal (NFR3.2).
