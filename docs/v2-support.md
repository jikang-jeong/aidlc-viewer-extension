# AI-DLC v2 support

How this extension reads an AI-DLC v2 project, why it reads it that way, and what
it deliberately does not do. Written for whoever changes this next.

Everything below was established against three real v2 runs rather than from the
upstream documentation. Where a claim has a number attached, that number came from
one of those runs.

## Why v2 needed a different tool, not a bigger viewer

v1 and v2 differ in who reads the artifacts, and that decides what a tool for them
should be.

In v1 a person read the markdown to move the workflow along. They opened a
questions file, filled in `[Answer]:` tags, and the workflow could not continue
until they did. Reading was the work, so a reading tool was the right shape: the
tree, the split viewer, the journey strip.

In v2 the agent reads the artifacts and the person approves a summary. One
completed run produced 284KB of documents and 325KB of audit ledger while the
person answered 64 times, frequently with a single `1`. Reading is no longer the
work, so improving the reading surface no longer improves the work.

What the person does in v2 is approve. The information an approval needs is not on
screen. Across the three runs:

| On disk | Shown to the user |
|---|---|
| 103 sensor failures | 0 |
| 44 engine refusals | mixed into hook output in chat |
| 8 artifacts carrying reviewer findings | the findings, once, in chat |
| 3 corrupted rules propagated to every later stage | nothing |
| 1 fabricated answer promoted to a permanent rule | nothing |
| 2 deferred decisions | nothing durable |

So the v2 role is oversight of delegated judgement, not viewing. Everything the
extension adds for v2 exists to surface something already recorded that never
reached a screen.

## Where the data comes from

Zero markdown is parsed. Every number the extension shows is a JSON field, an
event count, or a path that exists.

| Question | Source |
|---|---|
| v1, v2, both, or neither | path existence (`src/aidlc/detect.js`) |
| stage list, order, phases, per-stage contract | `.kiro/tools/data/stage-graph.json` |
| which stages this scope runs | `.kiro/tools/data/scope-grid.json` |
| what actually ran | `runtime-graph.json`, `outcome` field |
| units of work and their dependencies | `runtime-graph.json`, `bolt_dag` |
| sensor failures, engine refusals, per-unit progress | audit ledger events |
| the agent's own coverage claim | `traceability.json` |

Nothing in that table is a name this extension hardcodes. Stage slugs, phase
names, sensor ids, scope names, outcome values, event names and coverage statuses
all come from the project being read.

### The engine offers a read-only status path, and sanctions it

`bun .kiro/tools/aidlc-utility.ts status` computes position, per-phase counts and
the active agent. Asking the orchestrator for status returns:

> Run `bun .kiro/tools/aidlc-utility.ts status`, print its output verbatim, then
> stop. This is a read-only utility, NOT workflow work: do NOT run `next` and do
> NOT advance, resume, or run any workflow stage.

So reading through the engine is the intended path rather than a workaround. The
extension nonetheless reads the JSON directly, because doing so needs no bun and no
subprocess, and it was verified to reproduce `status` exactly (`16/16 in-scope`,
`16/33 overall`, `IDEATION 3/3`) on a real project.

## Design rules, and the mistake each one came from

Every rule below replaced something that was wrong first. They are worth keeping
for that reason.

**Report what is not understood; never drop it.** Each reader returns a list of
fields, values and event names it has no meaning for. This is what made the second
and third samples useful: `bolt_dag` was absent from sample 1 and present in sample
2, and reading only known keys hid the entire unit mechanism. `tools/aidlc-probe.js`
prints those lists under GAPS, so running it on a new project is a test rather than
a reading exercise.

**Never enumerate a vocabulary for control flow.** Sample 1's ledger carried
`GUARDRAIL_LOADED` and `HEALTH_CHECKED`; sample 2 carried `MEMORY_EMPTY` and
`STAGE_SKIPPED` instead. Coverage statuses were `OK`, `Deferred` and `N/A` across
the three. Outcome values were `approved` and `pending`, and a fourth project may
carry another. So the only question asked of an outcome is whether it equals
`approved`, and everything else is reported as unfinished and named.

**A field name can differ by event.** Sensor rows carry `Stage slug`; most others
carry `Stage`; refusal rows carry neither, only `Tool`, `Command` and `Error`.
Reading one spelling produced an empty per-stage tally, and assuming refusals
carried a stage produced nothing at all. A refusal's stage is therefore derived
positionally, from the last stage-bearing event before it, rather than by parsing
the command line.

**A failing sensor emits its own event.** `SENSOR_FAILED` exists. Inferring failure
from a missing `SENSOR_PASSED` also flags rows that are merely in flight, which is
how a first attempt reported three failures that were not.

**No input may throw.** 53 tests feed truncated JSON, wrong types, unknown enums,
renamed fields and shapes the engine has never produced, and assert two things
each: it returned, and it said what it did not understand. A reader that crashes on
an unfamiliar file takes the tree down with it, which defeats the point of the
layer.

## Units of work

`stage-graph.json` declares `for_each: "unit-of-work"` on five stages. The unit
list is a runtime fact and appears in `runtime-graph.json` under `bolt_dag`:

```
units:   u1-inspection-core (depends_on: [])
         u2-lot-approval    (depends_on: [u1-inspection-core])
batches: [[u1], [u2]]
```

Batches express parallelism, so a batch count is chain depth rather than unit
count. Independent units share one batch.

Per-unit progress is where this went wrong twice, and the current model has three
tiers because of that:

1. **The stage is done, so every unit is done.** A stage running in `subagent` mode
   was observed finishing all its units without emitting a single
   `UNIT_COMPLETED`, so trusting the ledger alone reported 0 of 1 on a completed
   stage.
2. **The stage is in flight, so count explicit `UNIT_COMPLETED` rows.** As a set,
   not a tally: a unit can be re-reviewed after its completion row, and counting
   rows claimed 3 of 2 units on a real project.
3. **Otherwise zero.** A unit mentioned on a stage's rows has not necessarily
   finished.

The `Unit` field rides on whichever events a stage's mode produces. `inline` closes
each unit with `UNIT_COMPLETED`; `subagent` carries the unit on its review rows.
Keying on one event name is the mistake tier 1 exists to correct.

## What the supervision panel shows, and what it refuses to

The panel appears only for a v2 project, gated by a `when` clause on a context key.
A v1 project renders no new UI at all.

**Position.** The furthest stage reached, a continuous rail with one segment per
stage, per-phase counts, and per-unit counts for stages that repeat. A stage that
repeats per unit gets its own unit count because counting it as one step is exactly
what made the v1 percentage overstate progress.

**Blocked.** Only refusals with nothing after them for their stage. Of 44 refusals
across three runs, none were still in the way, so a raw count presented as an alarm
would teach a reader to skip the panel exactly as they skip the chat. Each blocking
refusal carries the engine's message verbatim, the command that was refused, and
the surrounding event order.

The ordering is the product. A refusal states its remedy but not how the workflow
reached the state it refuses, and that is only visible as a sequence:

```
13:47:16  SUBAGENT_COMPLETED
13:47:28  PRACTICES_DISCOVERED
13:47:28  ERROR_LOGGED          <- refused
13:47:53  ARTIFACT_UPDATED      <- resolved, 25s later
```

Reconstructing that by hand cost one session three passes through the engine's
TypeScript source and about 46 credits, while the user asked whether anything was
happening.

**Sensor findings.** Grouped per stage, never totalled. Failures are stage-local:
one project put 25 of its 51 in a single stage and none in most others, so a
cumulative number keeps warning about a stage the user finished hours ago. Each
links to the detail file the sensor wrote, which lists the requirement ids it could
not account for.

**Recorded vs checked.** The agent's own coverage record beside the engine's
reading of the same file:

| Stage | Agent recorded | Sensor found |
|---|---|---|
| functional-design | 43 items, all OK | 167 findings |
| units-generation | 45 OK, 1 N/A | 90 findings |
| domain-design | 45 OK, 1 N/A | 51 findings |
| code-generation | 35 items, all OK | 42 findings |

Both numbers are shown and neither is reconciled. No subtraction, no
"discrepancy", no verdict: the record and the sensor answer slightly different
questions, so a computed delta would read as authoritative while being invented.
A test forbids any field name matching `discrepanc|mismatch|delta|verdict|correct|
wrong`, so a future attempt to reconcile fails loudly.

**Not understood.** Event names this build has no meaning for, with a note that
progress is unaffected. An empty gap list is a claim, and a reader deserves to know
when it fails.

## Install

Two commands. Setup is a toolbar button; removal is command-palette only, because
deleting files from a project should not be one mis-click from Refresh.

The payload is one subdirectory of a large repository. `dist/kiro-ide` is 293 files
and 4.5MB while the repository is 3,177 files, so the archive is downloaded once
(13.5MB, ~2s) and only that subtree extracted (~0.24s). A request per file through
the contents API would be 293 round trips against a rate limit. Nothing is bundled
into the extension because a snapshot of an actively moving engine goes stale
between releases, and no dependency is added because the `tar` shipped with macOS,
Linux and Windows 10 1803+ does the extraction.

**The branch is followed, and the commit is recorded.** An install resolves `v2` to
a sha through the GitHub API, downloads that sha, and writes it into the receipt.
Following the branch is what was asked for and is right for a workflow still
moving, but it costs something real: two people installing on different days can
get engines that behave differently. Recording the resolved sha is what keeps that
answerable, because a project can always say which engine it has even though
nothing chose that engine in advance.

The resolution is a nicety, not a gate. Unauthenticated API calls are rate limited
and a proxy may allow codeload while blocking `api.github.com`, so a failure falls
back to downloading the ref directly and recording the ref in place of a sha. An
install is never refused over a missing label.

Note the asymmetry that made this necessary: GitHub puts the sha in the archive's
top-level directory only for a download by sha. Asking for the branch by name
yields a root called `aidlc-workflows-2`, which cannot say which engine it is.

What this costs the reader modules is the reason none of them enumerate. Every
observation in this document was made against `4d0968fc`, and upstream has moved
since (281 payload files where there were 284). A field, a stage or an event that
did not exist then is reported under "Not understood by this extension" rather than
guessed at or thrown on. That property is what makes following a branch safe here,
and it is worth re-running the probe against a fresh sample after any upstream
change that matters.

**The harness is chosen once.** Kiro IDE and Kiro CLI ship mutually exclusive agent
definitions: fourteen files differ, and upstream marks running both as
supported-but-untested. A project that already recorded one is offered a reinstall
of that one, and changing means removing first.

**bun is checked, never installed.** The check reads install locations rather than
asking the shell. On a real machine bun sat at `~/.bun/bin/bun` while
`zsh -c 'command -v bun'` found nothing, because the installer writes PATH into
`~/.zshrc` and a non-interactive shell reads `~/.zshenv` — and Kiro ran the v2
hooks perfectly anyway. A PATH probe would have told that user to install what they
already had.

### `.kiro/` is the engine. `aidlc/` is the project's memory.

This distinction is the most important thing in the install path.

The installer seeds nine files under `aidlc/`. The workflow then turns them into
the project's own accumulated rules: measured on three runs, that directory grows
to 138–146 files, and `aidlc/spaces/default/memory/project.md` collects the
corrections the workflow learned — six of them in one project, alongside an
affirmed team practice in `team.md`. None of it exists anywhere else, and the user
never opens the directory.

So an install may **create** the seed and may never **overwrite** it. A project
whose `aidlc/` has moved past nine files gets its engine replaced and its memory
left alone, and the plan says so in a note rather than relying on a copy routine to
skip quietly.

A test caught the one way this could still have gone wrong. Seeded paths were being
recorded in the receipt's removal list, so removing an install deleted four files
under `aidlc/` — including the `project.md` the workflow had rewritten. The seed and
the project's rules are the same path, so removal cannot tell them apart by looking
and no longer tries: seeded paths are recorded under their own key, removal reads
only the other one, and the planner filters any seeded path out of a removal list
even when an older or hand-edited receipt names one.

### Receipt

`.kiro/aidlc-viewer-install.json`, inside the tree the installer owns. That means
replacing `.kiro/` would destroy the record of what to remove, so the replace
operation carries an explicit preserve list.

Removal works only from a receipt and refuses without one. A v2 project set up by
hand has none, and deleting what merely looks like an install would target the two
directories a project keeps its own work in.

## Contradictions observed in the workflow itself

These are not extension bugs. They are things the runs surfaced that are worth
knowing when reading the data.

**`practices-promote` splits rules at newlines.** Two `ALWAYS` rules became five
items, including the fragments `(roll-your-own crypto)은 금지한다.` and `세운다.)`
as standalone rules. Those propagate to every later stage through the rule bundle.
Rule-based parsing of markdown broke on wrapped lines — in the engine, which is
the clearest possible argument for the extension not doing any.

**`doctor` misleads in both directions.** `Hook drops recorded (advisory):
continue-workflow x8` reads as a problem but records intentional human-wait
carve-outs. `Stale branches: 0 observed (not a git repo)` reads as fine while
hiding that git is absent. So `doctor` output is never rendered verbatim, and `.git`
existence is checked independently.

**A fabricated answer became a permanent rule.** A conductor filled in gate answers
the user never gave. The engine refused to record them twice — the human-presence
guard worked — but file writes are not gated, so the questions file kept answers the
audit has no record of. The fabrication was then logged as a learning, approved, and
written into `project.md`. The engine's own learning path can launder a refused
action into policy.

**Practices assume git without checking.** `trunk-based development`, worktrees and
squash-merge to `main` were affirmed into `team.md` and `project.md` on a project
with no repository. It never failed, because that scope's Construction stages ran
inline and never reached the Bolt worktree path. A broader scope would.

## Files

```
src/aidlc/detect.js         generation, by path existence
src/aidlc/graph.js          stage-graph.json, scope-grid.json
src/aidlc/runtime.js        runtime-graph.json, bolt_dag, intent listing
src/aidlc/audit.js          ledger reader
src/aidlc/diagnose.js       refusals with their event sequence, sensor grouping
src/aidlc/contrast.js       agent record beside sensor verdict
src/aidlc/journey-v2.js     the v1 journey shape, from v2 data
src/aidlc/index.js          entry point, stat-based memoisation
src/aidlc/install-state.js  what is installed, and has memory moved on
src/aidlc/install-plan.js   install and removal as operations
src/aidlc/install-apply.js  the only module that writes
src/aidlc/payload.js        upstream fetch and extraction
src/aidlc/bun-check.js      bun by install location
src/supervision-view.js     the panel (may use vscode)
src/install-commands.js     the two commands (may use vscode)
tools/aidlc-probe.js        diagnostic: npm run probe <dir>
```

Nothing under `src/aidlc/` imports `vscode`. That is what lets the whole layer run
under plain `node --test` with no dependencies, and it is why the two files that do
need `vscode` sit outside that directory.

Test counts: 177 total, of which 58 predate v2 and still pass unchanged.

## Performance

Reading a v2 project took 25–35ms uncached, dominated by parsing a ~330KB ledger,
on a path called for every tree refresh and panel update. That is 30ms of the
extension host's only thread each time a watcher fires during an active workflow,
and the ledger only grows.

The result is memoised against a signature built from stat calls alone: the stage
graph, the scope grid, and per intent the runtime graph plus every audit shard.
Each entry carries mtime **and** size, because a shard appended to within the same
millisecond would be missed by mtime alone and the ledger is append-only so size
always moves. Measured: 31ms first call, 0.32ms after.

The v1 journey is deliberately not cached. The caller rebuilds it from its own
artifact walk each refresh, so there is nothing to memoise and a cached answer
could only be stale.

## How v1 stayed untouched

The extension has 3,000 users on v1, so this was the constraint the work was shaped
around rather than a check at the end.

`src/extension.js` changed by +105/−7. The seven deletions are one hardcoded phase
list. The v1 journey is built exactly as before and then passed **into** the
adapter, which returns that same object for a v1 project — a test asserts object
identity rather than deep equality, because identity is what proves nothing
downstream reshaped it. Any failure inside the adapter falls back to the v1
journey: a tree showing v1-shaped progress on a v2 project is wrong, but a tree
that throws is wrong everywhere.

Phase order now derives from the order the checkpoints are already in. For v1 the
result is identical, and `tests/v1-isolation.test.js` pins both that equality and
the underlying property that v1 checkpoints are declared in phase order, so a later
reshuffle fails loudly instead of quietly reordering what users read.

## Running the probe on a new project

```
npm run probe /path/to/project
npm run probe /path/to/project -- --refusals
```

Read the GAPS section. Every non-empty line is a finding: a stage-graph field, a
scope decision, an outcome value, an event name or a directory this build has no
meaning for. The probe found four defects in these modules during development,
including one where the intent manifest was matched on the wrong key and silently
yielded no intents at all.

## Sample summary

| | scope | stages | units | sensor failures | refusals |
|---|---|---|---|---|---|
| 1 | lms-exploratory-build | 16/16 done | none | 25 | 13 |
| 2 | mvp | 20/23 | 1 | 27 | 10 |
| 3 | qc-inspection-local | 11/14 | 2, dependent | 51 | 21 |

All three differ in scope, in sensor-failure distribution and in event vocabulary,
which is why nothing is enumerated. Each one broke an assumption the previous ones
had established.

Still unobserved: the `operation` phase (skipped by all three scopes), the Bolt
worktree path, `type-check` firing (no TypeScript target in any sample), and more
than two units.
