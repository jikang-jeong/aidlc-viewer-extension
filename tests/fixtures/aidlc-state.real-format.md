# AI-DLC State Tracking

<!--
  SYNTHETIC FIXTURE. Do not put customer project files here.

  This reproduces the *format* that real AI-DLC agents actually emit, observed in
  two real v1 projects. It deliberately contains no customer content.

  The format differs from what src/extension.js parseAidlcState() expects:

    expected by the current regex:  - [x] INCEPTION - Workspace Detection (COMPLETED)
    what agents actually write:     ### 🔵 INCEPTION PHASE
                                    - [x] Workspace Detection

  Three differences break the current parser:
    1. The phase name lives in a `###` subheading, not inline on the item line.
    2. The separator is an em-dash (—), not an ASCII hyphen (-).
    3. Construction items nest one level deeper, one child per unit of work.

  Result on real files: zero steps parsed, silent fallback to the artifact-count
  estimate. Any replacement parser must satisfy the assertions in
  tests/state-format.test.js against this fixture.
-->

## Project Information

- **Project Name**: Example Project
- **Project Type**: Greenfield
- **Current Stage**: CONSTRUCTION - Build and Test

## Stage Progress

### 🔵 INCEPTION PHASE

- [x] Workspace Detection
- [ ] Reverse Engineering — SKIPPED (Greenfield)
- [x] Requirements Analysis — ✅ **APPROVED** (2026-01-02T06:35:38Z, 3 rounds)
- [x] User Stories — ✅ **APPROVED** (2026-01-02T12:27:09Z, 18 stories)
- [x] Workflow Planning — ✅ **APPROVED** (2026-01-03T01:41:23Z, 2 units)
- [x] Application Design — ✅ **APPROVED** (2026-01-03T02:22:42Z)
- [x] Units Generation — ✅ **APPROVED** (2026-01-03T04:00:46Z, 2 units)

### 🟢 CONSTRUCTION PHASE (per unit: unit-b → unit-a)

- [x] Functional Design — ✅ **COMPLETE** (per unit)
  - [x] U2 `example-backend` — ✅ APPROVED (2026-01-03T04:48:00Z)
  - [x] U1 `example-frontend` — ✅ APPROVED (2026-01-03T10:03:40Z)
- [x] NFR Requirements — ✅ **COMPLETE** (per unit)
  - [x] U2 `example-backend` — ✅ APPROVED (2026-01-03T05:20:21Z)
  - [x] U1 `example-frontend` — ✅ APPROVED (2026-01-03T10:17:45Z)
- [x] NFR Design — ✅ **COMPLETE** (per unit)
  - [x] U2 `example-backend` — ✅ APPROVED (2026-01-03T05:43:51Z)
  - [x] U1 `example-frontend` — ✅ APPROVED (2026-01-03T10:30:56Z)
- [x] Infrastructure Design — ✅ **COMPLETE** (per unit)
  - [x] U2 `example-backend` — ✅ APPROVED (2026-01-03T06:23:41Z)
  - [x] U1 `example-frontend` — ✅ APPROVED (2026-01-03T10:43:56Z)
- [x] Code Generation — ✅ **COMPLETE** (per unit, ALWAYS)
  - [x] U2 `example-backend` — ✅ **APPROVED** (2026-01-03T09:21:24Z)
  - [x] U1 `example-frontend` — ✅ **APPROVED** (2026-01-03T11:35:41Z)
- [x] Build and Test — ✅ **COMPLETE** (2026-01-03T12:06:00Z)

### 🟡 OPERATIONS PHASE

- [ ] Operations — PLACEHOLDER

## Current Status

- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: CONSTRUCTION — Build and Test complete, awaiting approval
- **Next Stage**: 🟡 OPERATIONS (placeholder)
