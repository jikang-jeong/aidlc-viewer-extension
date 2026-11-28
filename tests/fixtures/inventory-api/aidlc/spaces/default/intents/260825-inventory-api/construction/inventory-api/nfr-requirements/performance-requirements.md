# Performance Requirements — inventory-api (U1)

> Detailed performance NFRs for the single-location Inventory Management API
> (MVP). Numeric latency/throughput targets are **deliberately deferred** at MVP
> per the affirmed team practice and requirements (NFR — "performance testing
> deferred"); this document records that deferral explicitly rather than
> inventing targets, and pins the correctness-timing requirement that IS binding
> (read-after-write).

## Sources

- `requirements` (Requirements Analysis) — NFR1 (correctness/consistency,
  read-after-write), the explicit statement that performance/throughput targets
  are not set at MVP and load testing is deferred.
- `functional-spec` (this phase) — WF6 adjust-stock workflow, read-after-write
  (BR2.4), per-request logging latency field (`latencyMs`).
- `rules` (this phase) — BR2.3 (atomic adjustment), BR2.4 (read-after-write).
- `contract-summary` (Contract Design) — synchronous REST, offset/limit paging
  (bounded page cost).
- `nfr-requirements-questions.md` (this stage) — Q4 (log latency field), Q5
  (deferred capacity numbers).

## Requirements

| ID | Requirement | Target | Status |
|----|-------------|--------|--------|
| NFR1.1 | Read-after-write timing: after a successful adjustment (WF6) or create/update, a subsequent read of the same SKU reflects the change with no staleness window. | Strict read-after-write (correctness, not a latency percentile). | Binding (MVP) |
| NFR1.2 | Adjustment path is logically atomic (single-item conditional update + bounded internal retry); the retry budget must not materially inflate perceived latency under normal (non-pathological) contention. | Bounded retry (small, e.g. ≤ 3 internal attempts); conflict never surfaced. | Binding (MVP) |
| NFR1.3 | Per-request latency is **measured and logged** (`latencyMs` on every structured log entry, BR5.1) even though no latency SLO is set — so a target can be derived from real data later. | Latency observed on 100% of requests. | Binding (MVP) |
| NFR1.4 | List endpoint cost is bounded by pagination (limit ≤ 100, default 20); no unbounded scans. | Bounded page per request (BR1.4). | Binding (MVP) |
| NFR1.5 | Response-time / throughput SLO (e.g. p95/p99 latency, target RPS). | **Deferred** — no numeric target at MVP; revisit when a real NFR surfaces. Load/perf testing deferred (team practice). | Deferred |

## Deferral rationale

Performance targets are deferred, not forgotten. The initiative's success bar is
**data correctness** (NFR1), not speed, and the team explicitly deferred
load/performance testing until a real target surfaces. NFR1.3 ensures latency is
captured in logs from day one, so a measured p95/p99 baseline exists to set a
real SLO against when the need arises — avoiding a silent, un-grounded target
now.

## Measurement method

- Latency captured per request as `latencyMs` in the structured log (BR5.1);
  no separate performance harness at MVP.
- When a performance SLO is later adopted, validate via load testing per the
  quality guidance (ramp-up / steady-state / spike / soak), measuring
  percentiles (not averages) against the then-defined target.

## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-10-13T09:46:55Z
**Iteration:** 1

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Minor | tech-stack-decisions.md — `## Sources` | `tech-stack-decisions.md` is the only one of the six NFR deliverables that does NOT reference the `functional-spec` consumed artifact (it cites `rules`, `requirements`, `contract-summary`, `team.md`/`project.md`, and the questions file). This is NOT an upstream-coverage sensor failure: the sensor scopes coverage to the union of the stage's deliverables ("Coverage is a property of the stage's whole output, not of each file"), and `functional-spec` is cited in the other five deliverables (and in the primary performance-requirements.md). Flagged only as a readability asymmetry — a reader auditing provenance from the tech-stack file alone would not see the functional-spec linkage. | Non-blocking. Optionally add `functional-spec` to the tech-stack `## Sources` list (e.g. "WF6 adjust-stock workflow informs the concurrency-primitive choice") to make the provenance symmetric. Coverage is already satisfied stage-wide. |
| 2 | Minor | performance-requirements.md — ID numbering scheme | Performance, scalability, reliability, and observability requirements are numbered under the inception parent of their *topic* (performance/scalability/reliability all roll up under `NFR1`; observability under `NFR3`) rather than under a dedicated per-category parent. This is internally consistent (traceability.json enumerates NFR1→NFR1.1…NFR1.16 and NFR3→NFR3.1…NFR3.9, every target resolves) and faithful to the inception set (NFR1 = correctness/consistency, NFR3 = observability), so it is correct — but it means `NFR1.*` spans four NFR categories, which a reader may initially read as "all performance." | Non-blocking. No change required; the stage prose mandates inheriting the inception NFR id, and the mapping is unambiguous in traceability.json. Flagged only so the human notes the deliberate topic-to-parent rollup. |

### Validation Tool Results

| Tool / Check | Result | Interpretation |
|---|---|---|
| traceability (JSON well-formedness) | PASS | `traceability.json` parses as valid JSON (python `json.load`): 4 upstream_ids, 4 coverage rows, 5 reverse rows. |
| traceability (inception NFR enumeration) | PASS | `upstream_ids` = `[NFR1, NFR2, NFR3, NFR4]` = all four inception NFRs; `coverage[].id` set is identical. Every inception NFR enumerated and covered (`status: OK`). No NFR enumerated-but-uncovered or covered-but-unenumerated. |
| traceability (derived NFRx.y internal consistency) | PASS | The 32 `NFRx.y` targets declared across `coverage[].target` are byte-identical to the 32 `NFRx.y` IDs actually defined across the five requirement artifacts (bidirectional diff: zero dangling targets, zero orphan IDs). |
| traceability (deferred items justified in reverse[]) | PASS | The five rows whose Status column literally reads `Deferred` — NFR1.5, NFR1.10, NFR1.16, NFR3.8, NFR3.9 — are exactly the five `reverse[]` entries, each with a non-empty justification. (NFR3.2 is `Binding`; its appearance near "Deferred" is only a cross-reference from NFR3.8's rationale, not a status.) |
| required-sections (≥2 H2 + `## Sources`) | PASS | All six .md deliverables carry 4 H2 headings and exactly one `## Sources` section (floor is ≥2 H2; framework ships no template override for these artifacts). |
| upstream-coverage (consumes referenced stage-wide) | PASS | Union of deliverables references all four consumed artifacts (`functional-spec`, `rules`, `requirements`, `contract-summary`); primary artifact references all four. Per-file gap on tech-stack `functional-spec` is Finding #1, not a sensor failure. |
| Consistency — DynamoDB atomic conditional update vs BR2.3/NFR1 | PASS | tech-stack-decisions NFR primitive = atomic conditional `UpdateItem` + bounded internal retry; stated lossless + transparent-conflict (BR2.3), zero-floor on the same condition (BR2.2). `ConcurrencyConflict` absent from every NFR artifact and from the contract's closed error enum (`grep` → no mention). Matches contract OQ2→transparent. |
| Consistency — no-auth-at-MVP vs A1/OQ3 + additive X-Api-Key | PASS | security NFR2.3 = no app-layer auth, internal network boundary (A1/Q2→A); NFR2.4 reserves additive `X-Api-Key` + 401. Matches contract-summary lines 313 (`X-Api-Key`/401, additive within `/v1` or new version). |
| Consistency — 99.9% SLO coherence | PASS | reliability NFR1.11 = 99.9% successful-request rate / 30-day rolling window, ≈43.8 min/month budget (arithmetic correct); single-service posture, no multi-region, matches Q3→A. MTTR/RTO/RPO qualitative (NFR1.16 Deferred-numeric) — coherent with performance deferral. |
| Consistency — performance/scalability deferral vs team practice | PASS | NFR1.5 (perf SLO) and NFR1.10 (capacity numbers) Deferred with explicit "team practice / revisit when a real target surfaces" rationale; matches requirements.md "performance testing deferred at MVP" and the Q5 answer. Scaling MECHANISM fixed, NUMBERS deferred — no silent invented target. |
| Consistency — locked log field set vs functional-spec | PASS | observability NFR3.2 mandated set = `requestId, timestamp, method, route, statusCode, latencyMs, outcome` — byte-identical to the functional-spec cross-cutting per-request logging field set and BR5.1. No body/secret logging (NFR3.4 / BR5.1). |

### Summary

This adversarial pass reaches READY after failing to break the artifacts. I attacked the traceability chain, the derived-ID consistency, the concurrency invariant, the SLO arithmetic, the auth posture, and the deferral justifications, and every machine-checkable claim held. `traceability.json` is well-formed and enumerates all four inception NFRs (NFR1–NFR4), each covered; the 32 derived `NFRx.y` targets declared in `coverage[]` are byte-for-byte identical to the 32 IDs actually defined across the five requirement artifacts (zero dangling targets, zero orphans), and the five `Deferred`-status rows are exactly the five justified `reverse[]` entries. The three highest-risk consistency claims are all sound against the handed contracts: the DynamoDB atomic-conditional-update decision is lossless and transparent-conflict (BR2.3/NFR1) with `ConcurrencyConflict` correctly absent from every artifact and the contract's closed error enum; the no-auth-at-MVP posture matches A1/OQ3 and reserves the additive `X-Api-Key`/401 path per the contract; and the 99.9%/30-day SLO is arithmetically and architecturally coherent for a single internal service. The locked structured-log field set matches the functional-spec cross-cutting fields exactly, and the performance/scalability deferral matches the affirmed team practice (mechanism fixed, numbers deferred — no invented target). The two findings are both Minor and non-blocking: a provenance asymmetry (tech-stack-decisions omits a `functional-spec` citation, but stage-wide upstream-coverage still passes per the sensor's union semantics) and the deliberate topic-to-parent ID rollup under NFR1/NFR3. Zero Critical, zero Major — nothing blocks approval.

---