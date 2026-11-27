# Quality Gates: inventory-api

The pass/fail rules the GitLab CI pipeline (`.gitlab-ci.yml`) enforces before a
merge to `main`. Every gate is blocking: a failed job fails the pipeline. The
gates are additive to the org and team floors and never weaken them.

## Sources

- `team.md`, Testing Posture: the blocking CI gate set (unit and integration
  tests, the 80% line floor that fails the job, ESLint, Prettier `--check`,
  `tsc --noEmit`) and the mandatory concurrency race test.
- `project.md`, Mandated: gitleaks and dependency scanning in CI; no
  hardcoded secrets.
- `org.md`, Testing Posture: mvp scope adds the 80% line floor and CI
  execution before merge.
- `construction/inventory-api/code-generation/code-summary.md` (code-summary):
  the scripts and test projects each gate runs, and the cdk-nag
  acknowledgments (COG2, COG8, and APIG4 on the health route only).
- `construction/build-and-test/build-and-test-summary.md`
  (build-and-test-summary): TC-CI and NFR4.2, which this stage owns.
- `construction/build-and-test/test-results.md` (build-test-results): the
  passing baseline each gate was checked against.
- `construction/ci-pipeline/ci-pipeline-questions.md`: Q4 (the dependency scan
  bar) and Q5 (zero ESLint warnings).

## Gates

| # | Gate | Job | Pass criterion | Fails the pipeline when | Baseline (local, 2026-11-13) | Serves |
|---|---|---|---|---|---|---|
| G1 | Secret scan | `secret-scan` | gitleaks finds no secret in the full git history (`.gitleaks.toml`, default ruleset, no secret allowlisted) | any finding | no leaks found | project.md Mandated, NFR4.1, NFR4.2 |
| G2 | Dependency scan | `dependency-scan` | `npm audit --audit-level=high` reports no High or Critical advisory | any High or Critical advisory, in runtime or dev dependencies | exit 0; 9 moderate advisories (below the bar) | project.md Mandated, NFR4.2 |
| G3 | Lint | `lint` | ESLint (type-aware, eslint-plugin-security, eslint-config-prettier) reports 0 errors and 0 warnings (`--max-warnings 0`) | any error or warning | 0 errors, 0 warnings (the 3 race-test warnings are justified inline, Q5) | team.md Code Style |
| G4 | Format | `format-check` | `prettier --check .` reports no drift | any unformatted file | all files formatted | team.md Code Style |
| G5 | Type-check | `typecheck` | `tsc --noEmit` (strict) reports no error | any type error | no errors | team.md Code Style |
| G6 | Tests | `test` | all unit, integration and infra tests pass, including the 4 concurrency race scenarios, against DynamoDB Local | any failing or erroring test | 176 of 176 at Build and Test; all pass again after this stage's changes | team.md Testing Posture, TEAM-RACE, TEAM-INT-REAL |
| G7 | Coverage floor | `test` | line coverage of at least 80% (`thresholds.lines: 80` in `vitest.config.ts`) | lines below 80% | 96.12% lines | team.md and org.md floor, TC-COV |
| G8 | IaC synth and cdk-nag | `synth` | the three staging stacks synthesize with no unacknowledged cdk-nag AwsSolutions error | synth error or unacknowledged cdk-nag error | passed at Build and Test (cdk-nag clean) | security-design, NFR2.3 |
| G9 | Bundle | `build` | the esbuild bundle `dist/lambda.mjs` builds | build error | passed at Build and Test (763.0 KB) | traceable artifact |
| G10 | Merge rule | GitLab project setting | the merge request's pipeline succeeded | "Pipelines must succeed" is off, so a red pipeline could still merge | to be turned on in the project settings | team.md blocking gates |

G6 and G7 run in one job (`npm run test:coverage`), so the job fails on
either a test failure or a coverage drop. The floor is never lowered to make
the job pass, and the coverage `include` set is never narrowed (the rule is
written in `vitest.config.ts`).

## Gate integrity rules

- A gate is changed only by a reviewed merge request that says why. Lowering
  the 80% floor, raising `--max-warnings` above 0, raising the audit level
  above `high`, or adding a gitleaks allowlist entry for a real secret is
  treated as removing a gate, not as a fix.
- A new ESLint warning is fixed or, when it is a false positive, disabled on
  that one line with a reason (`-- why it is safe`), never by turning the rule
  off.
- A new cdk-nag error is fixed in the resource. An acknowledgment needs a
  written reason in code, as COG2, COG8 and the health-route APIG4 have.
- A High or Critical advisory is fixed by upgrading the dependency to an exact,
  pinned version. When no fix exists yet, the team records the decision in the
  merge request before any exception is added.

## Coverage of the stage's targets

| Target | Before this stage | After this stage |
|---|---|---|
| TC-CI: tests run in CI before merge | N/A (owned by CI Pipeline) | Met by configuration (G6, G7, G10); proven when the first merge-request pipeline passes |
| NFR4.2: gitleaks and dependency scanning in CI as blocking gates | N/A (owned by CI Pipeline) | Met by configuration (G1, G2); Dependabot replaced by `npm audit` (Q4) |
| TEAM-GATES: ESLint, Prettier and `tsc` block merges | Met locally | Now enforced in CI (G3 to G5), with ESLint stricter than before (0 warnings) |
| TC-SMOKE: staging smoke test | Unverified | Still Unverified: no deploy or smoke job in this release (Q2) |

## Gates intentionally not in this release

- Deploy to staging and the post-deploy smoke test (design stages 12 and 13):
  left out by decision Q2 until the AWS deploy role exists.
- Production manual approval: production is not provisioned (team.md
  Deployment).
- Performance or load testing: deferred by the team (no numeric target).
