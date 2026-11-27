# Scalability Requirements — inventory-api (U1)

> Detailed scalability NFRs for the single-location Inventory Management API
> (MVP). The service is a stateless HTTP API over single-item datastore
> operations; the posture is horizontal scale-out with no capacity numbers at
> MVP (deferred with performance per Q5).

## Sources

- `requirements` (Requirements Analysis) — NFR1 (atomic/concurrency-safe), C3
  (single location — no location dimension), performance deferral.
- `functional-spec` (this phase) — stateless workflows WF1–WF7, single-item
  adjustment WF6.
- `rules` (this phase) — BR2.3 (lossless concurrent adjustments), BR1.4
  (bounded pagination).
- `contract-summary` (Contract Design) — synchronous REST, single-node unit DAG.
- `nfr-requirements-questions.md` (this stage) — Q1 (DynamoDB single-item),
  Q5 (stateless horizontal scaling, no capacity numbers at MVP).

## Requirements

| ID | Requirement | Detail | Status |
|----|-------------|--------|--------|
| NFR1.6 | The service is stateless and scales horizontally. | No per-instance session state; any instance can serve any request. Scale out behind a load balancer / managed concurrency; the datastore holds all state. | Binding (MVP) |
| NFR1.7 | Per-item concurrency is handled at the datastore, not by application coordination. | The atomic conditional update (NFR1 / BR2.3) makes concurrent adjustments to the same SKU correct regardless of how many application instances run — horizontal scale does not weaken the lossless-update guarantee. | Binding (MVP) |
| NFR1.8 | No hot-partition / data-skew concern at MVP scale. | Single location, item-keyed by SKU; access is spread across many SKUs. If a future high-write single-SKU hotspot appears, revisit partition/sharding strategy. | Binding (MVP) |
| NFR1.9 | List operations are bounded and do not scale cost with total item count per request. | Offset/limit paging (limit ≤ 100, BR1.4) bounds per-request work; total growth handled by paging, not by larger responses. | Binding (MVP) |
| NFR1.10 | Concrete capacity targets (RPS, item-count projections, growth model, cost-at-scale). | **Deferred** at MVP alongside performance; the scaling MECHANISM is fixed (stateless horizontal + datastore concurrency), the NUMBERS are not. Revisit when a real volume target surfaces. | Deferred |

## Capacity planning note

| Dimension | MVP posture | Scaling mechanism |
|-----------|-------------|-------------------|
| Concurrent requests | No fixed target | Stateless horizontal scale-out behind LB / managed concurrency |
| Item count | Single location, unbounded by design | Datastore handles storage growth; paging bounds reads |
| Per-SKU write contention | Correct under concurrency (NFR1.7) | Atomic conditional update + bounded retry |
| Cost at scale | Not projected at MVP | Revisit with NFR1.10 when volume is known |

## Deferral rationale

As with performance, concrete scalability numbers would be invented rather than
grounded at MVP. The design is explicitly chosen to scale (stateless + atomic
datastore updates) so no architectural change is needed to grow; only the
operational numbers wait for real data.
