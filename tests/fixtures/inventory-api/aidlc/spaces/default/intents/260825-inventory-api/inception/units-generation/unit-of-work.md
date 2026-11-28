# Units of Work — Inventory Management REST API (MVP)

> Groups the domain-design components into implementable Units of Work.
> Topology only — the build order and critical path are decided later in
> Delivery Planning (Stage 2.9), not here.

## Sources

- `components` (Domain Design) — the two components `ApiEdge` and
  `InventoryItem` and the `Item` entity grouped into this Unit.
- `decisions` (Domain Design) — ADR-001 (single `InventoryItem` domain
  component), ADR-002 (separate thin `ApiEdge`), ADR-003 (datastore as a generic
  external dependency) constrain the grouping: both components deploy together
  behind one boundary and share one datastore, so they belong in one Unit.
- `requirements` (Requirements Analysis) — FR1–FR3, NFR1–NFR4 and constraints
  C1–C3 that the Unit must realize.
- `stories` (User Stories) — US1.1–US4.2 mapped to this Unit (see
  `unit-of-work-story-map.md`).

## Unit Overview

The MVP is a single, single-location REST API deployed as one service over one
datastore. Per the decomposition heuristics — fewer than five story groups, all
sharing the same two components and the one datastore, no independent
deploy/test boundary, and the team's walking-skeleton-first practice (one
end-to-end slice) — the system decomposes into **one Unit of Work**.

| Unit ID | Directory | Name | Kind | Complexity | Deployment |
|---------|-----------|------|------|------------|------------|
| U1 | `u1-inventory-api` | inventory-api | `service` | M | standalone (monolithic deploy) |

## Unit Definitions

### U1 — `inventory-api` (`u1-inventory-api`)

**Description:** The complete inventory management REST API as a single
deployable service. It bundles the two domain-design components — the `ApiEdge`
HTTP boundary and the `InventoryItem` domain — behind one service process,
persisting to one `InventoryStore` datastore.

**Boundaries:** Everything from the HTTP request boundary through domain logic to
persistence lives inside this Unit. The internal layering (handler/route →
service → repository) affirmed in team practices is an *intra-Unit* structure,
not a Unit boundary. The datastore is an external dependency of the Unit, not a
separate Unit.

**Kind:** `service` — a deployed executable (the REST API). Receives the full
Construction design-artifact matrix (functional design, NFR requirements, NFR
design, infrastructure design).

**Responsibilities (what the Unit owns and delivers):**

- Item CRUD keyed by client-supplied SKU, with duplicate-SKU rejection (FR1).
- Concurrency-safe, atomic relative-delta stock adjustments with a zero floor and
  read-after-write consistency (FR2, NFR1 — the one substantive technical risk).
- The single consistent JSON error envelope and typed-domain-error → HTTP status
  mapping (FR3).
- Boundary input validation and sanitization (NFR2).
- Structured per-request logging and a health-check endpoint (NFR3).
- Secret sourcing from environment/secrets manager, never hardcoded (NFR4).

**Deployment model:** standalone — one deployable service (monolithic deploy).
Both components ship together; there is no independent deploy boundary within the
Unit.

**Relative complexity:** **M (Medium)**. The CRUD surface is straightforward, but
the concurrency-safe adjustment path (NFR1 + the mandatory race test) and the
consistent error contract raise it above a trivial CRUD service while staying
well short of a distributed/multi-integration system.

**Implementation notes and constraints:**

- AWS target platform; the concrete compute and managed datastore are chosen in
  later design stages (C1). The datastore must support atomic conditional updates
  for the adjustment path (ADR-003, requirements OQ2).
- Node.js/TypeScript stack with handler → service → repository layering,
  dependencies injected so the adjustment logic is unit-testable without live AWS
  (C2, team practices).
- The atomic-adjustment invariant must stay inside the `InventoryItem` domain
  boundary; quantity is mutable only via the adjustment path, never via item
  update (ADR-001, US1.4/AC1.4.3).
- Open threads deferred to design: pagination mechanism (OQ1), concurrency
  mechanism and whether `ConcurrencyConflict` is caller-visible (OQ2), and whether
  an API key is added over the internal-network trust boundary (OQ3).

## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-10-02T10:12:20Z
**Iteration:** 1

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Minor | unit-of-work-story-map.md "Story Implementation Order Within U1" | The section ranks US2.2 as "the highest-risk behaviour" and orders stories by intra-Unit dependency. The stage spec Step 5 explicitly requires "Story implementation order within each unit," so an intra-Unit topological ordering is in-scope and the section is correctly disclaimed ("not a committed build order — Delivery Planning owns sequencing"). The *risk ranking* phrasing, however, leans toward the economic prioritisation that belongs to Stage 2.9. It is a factual restatement of US2.2's risk framing from stories.md/team-practices, not a build-order recommendation, so it does not cross the 2.7/2.9 line — but the human should confirm the intent is topology, not a priority call. | Non-blocking. Optionally soften "highest-risk behaviour" to a neutral dependency statement (US2.2 depends on the US2.1 adjust path) and leave risk-weighted sequencing to Delivery Planning. No structural change needed. |
| 2 | Minor | unit-of-work.md US3.1 realization vs story-map Cross-Cutting Stories | Consistent with the upstream components.md review, US3.1 (error contract) is co-realized by `ApiEdge` (envelope/status mapping) and `InventoryItem` (raising the typed domain errors). traceability.json maps US3.1 `OK → U1`, which is correct at Unit granularity (both components live in U1), so the single-Unit decomposition absorbs the split cleanly — no trace gap at this stage. Flagged only so the human sees the error contract is a two-component collaboration carried entirely inside U1. | Non-blocking. No action — the single-Unit target is accurate; the co-realization detail is already documented in the story-map Cross-Cutting Stories section and surfaces again in Functional Design. |
| 3 | Minor | unit-of-work.md "Implementation notes" — OQ1/OQ2/OQ3 | The Unit carries forward three unresolved open threads (pagination mechanism, concurrency mechanism / `ConcurrencyConflict` visibility, optional API key). These are correctly deferred to design per requirements OQ1/OQ2 and ADR-003, so they are noted open threads rather than omissions, but they mean the Unit's contract surface is not fully closed at hand-off to Construction. | Non-blocking. The human should note these three threads must be settled in Functional/Contract and Infrastructure Design before build; they are legitimately out of scope for a topology stage. |

### Validation Tool Results

| Check | Result | Interpretation |
|---|---|---|
| Edge block well-formed (unit-of-work-dependency.md) | PASS | One unit `inventory-api`, `kind: service` (valid enum), `depends_on: []`; named once; no self-dependency; a single node is trivially acyclic. |
| Unit kinds valid | PASS | `service` is in `service \| spec \| ui \| packaging \| library`. |
| traceability.json completeness | PASS | All 10 stories (US1.1–US1.5, US2.1, US2.2, US3.1, US4.1, US4.2) enumerated; every `OK` target `U1` appears on that story's row in the story map; no GAP/orphan. Story set matches stories.md exactly. |
| Story/Unit coverage | PASS | Every story assigned to U1; U1 has stories; no orphan stories, no empty/orphan Units. |
| ADR consistency (ADR-001/002/003) | PASS | Bundling both components into one Unit does not contradict any ADR — the ADRs assert component boundaries and a deferred datastore, not independent deployability; both components deploy together behind one boundary over one datastore. Consistent with single-location MVP scope. |
| Topology-only (no build order / critical path) | PASS (with Finding #1) | No critical path identified anywhere; DAG prose repeatedly disclaims build order. The intra-Unit story-order section is sanctioned by Step 5 and disclaimed; only its risk-ranking phrasing is flagged. |

### Summary

The decomposition is sound and implementable, so this advisory pass reaches READY. The single-Unit `inventory-api` (U1, `service`) grouping is the correct call for a single-location, single-service, single-datastore MVP and is fully consistent with ADR-001/002/003 and the Q&A-confirmed plan (Q1→A one Unit, Q2→A service, Q3→A monolithic). All structural checks pass: the required fenced yaml edge block is present, well-formed, single-node, and acyclic; the unit kind is a valid enum; traceability.json enumerates all ten user stories with `OK` targets that resolve to U1 on every story-map row; and every story is assigned with no orphan stories or empty Units. I found no broken cross-references and no contradiction across unit-of-work.md, the dependency and story-map artifacts, and the upstream components/decisions/stories contracts. The three findings are all Minor and non-blocking: a story-order section whose "highest-risk" phrasing brushes against 2.9's economic sequencing (though it stays topology-side and is sanctioned by the stage spec), the ApiEdge↔InventoryItem co-realization of the error contract that the single-Unit target legitimately absorbs, and three design-stage open threads (OQ1/OQ2/OQ3) carried forward. Zero Critical, zero Major — none blocks approval.

---
