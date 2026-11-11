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
| which stages this scope runs | `.kiro/tools/data/scope-grid.json`, overridden per intent by the state file's checklist suffixes (`- [ ] slug — EXECUTE\|SKIP`), the channel the engine's own `effectivePlanAction` reads first |
| what actually ran | `runtime-graph.json`, `outcome` field; for a stage it has no record of, the audit ledger's `STAGE_*` events (checkpoint `source: 'ledger'`) |
| which scope ran | `runtime-graph.json` `scope`; without it, the intent manifest's |
| units of work and their dependencies | `runtime-graph.json`, `bolt_dag` |
| a conditional stage the engine declined | audit ledger `STAGE_SKIPPED` (its runtime record stays `pending`) |
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

**Report only what Kiro recorded.** The Credits page shows no money and estimates no
tokens. The CLI store carries four token-count fields on every turn, and on one machine
all 930 of them were zero while credits were consumed: the field exists, the value is
not filled in. "Field present" is not "recorded"; zeros across the board read as not
recorded, the same as the IDE's absence. Pin: kiro-usage "all-zero token fields read as
not recorded".

**A turn's model comes from the turn, not from session.json.** `session.json.modelId` is
the model currently selected for the session; Kiro rewrites it when the person picks another.
Reading it stamped every past turn with today's choice (three turns on two models all shown
as the third, from a screenshot). The model a turn ran on is `payload.reasoningModelId`
(`qdev::<model>`) on the `assistant` messages inside the turn, before its `usage_summary`;
`turn_start` carries none (checked across 311 of them). A session on several models names
them all. Pin: kiro-usage "a turn's model is the one its assistant messages ran on".

**Do not name the program that wrote a session.** Kiro IDE and current `kiro-cli` both
write to `~/.kiro/sessions/<workspace-hash>/sess_*` (a `kiro-cli --resume-id sess_…`
run on 2026-10-13 landed there, not in `sessions/cli/`). The layout does not say who
wrote it, so a label that did was a guess read as a fact. Sessions show their model and
nothing about their origin. Pin: kiro-usage "a session names the store it came from".

**Separate pages, separate rows; nothing folded inside something else.** Waiting for you,
Credits and Engine records were one page for a day, with the first at the top of a page
called Credits and the third folded at its bottom. (The Engine records row and page were
removed in 0.1.4; see the pitfall "The v2 Engine Log was removed" below. The rule stands
for the two that remain.) Separate things are separate rows in the tree,
gated on the generation (`isV2`), never on "does the project have something to show" -- a
v1 tree must not gain a row. The three panels share one poll and one render loop
(`pages`), each with a fixed nonce so an unchanged report is byte-identical. Pins:
credits-page "three pages"; v1-isolation "the v2-only rows never appear in a v1 tree".

**2.11.0 artifact rows carry their stage in a Context path, not a Stage field.**
`ARTIFACT_CREATED` / `ARTIFACT_UPDATED` rows have `**Context**: <phase> > <stage> > <file>`
and no `Stage`. Reading only `Stage` / `Stage slug` left every artifact event stageless,
and the approval-wait inference, which keys on "an artifact was written and nothing moved
the stage since", had nothing to key on: a run whose agent was asking "Approve or Request
Changes?" read "nothing right now". The path has three shapes (`phase > stage > file`,
`construction > <unit> > stage > file`, `phase > stage > contributions > file`), so no
position is assumed; segments are matched against the scope's stage slugs, passed in from
journey-v2 as `knownStages`. Taking the second segment blindly reported unit names and
`phase-check-ideation.md` as waiting stages on three finished samples. Also found: the
runtime graph was read in journey-v2 and then dropped, so diagnose's "done according to
the runtime graph" check never fired; it is passed through now. The v2-test baseline
changed on purpose: its Build and Test is `pending` in the runtime graph with artifacts
written and nothing after, which is a wait by the rule. Pins: v2-robustness, four tests
under "2.11.0 ledgers put the stage in a Context path".

**The engine writes why it let the agent stop, and three of its reasons mean "waiting on
you".** `.aidlc-hooks-health/continue-workflow.drops` gets one line per allowed stop:
`<iso>\t<reason>; allowing the stop (<kind> carve-out)`. Five kinds across 164 lines in the
samples: `pending-question`, `pending-decision`, `human-wait` (the person), `conversational`
(the agent answered in prose with no engine call), and a plain reason. Found while asking why
the row read "nothing right now" under an agent message saying "type /aidlc --stage
code-generation": the hook had written `conversational carve-out` for that very stop. Only the
last line counts, and only when the ledger has nothing newer (the stop it explains would be
over; one sample was exactly that). A human-wait kind is a stated wait on its stage and covers
inferred gates and questions files there; on the samples it agreed with the ledger judgement
wherever both spoke. A conversational stop is not a wait, but the row says "see the agent's
last message" in blue, because that message is often the instruction. Pins: waiting-on-you
"the last human-wait stop reason", "a conversational stop", "a stop reason older than the
ledger"; v1-isolation decoration test.

**The most common wait leaves no file: the agent asked in the chat.** Kiro records it:
`pending_interaction` (`interactionType`, `toolCallId`, `question`, `options`) when the agent
asks, `interaction_resolved` with the same `toolCallId` when the person answers. 342 on this
machine; one session had 17 while the extension showed nothing. Only `user_input` is read:
`tool_approval` is 96% of the records and is answered in 3 to 10 seconds on a button beside
the chat, so a row refreshing every few seconds would show it after it was gone; `user_input`
took over 15s half the time and up to 83 minutes. Replayed against the real session log at
three instants: nothing before the question, the question while it stood, nothing after the
answer. It is listed while the agent's turn is open (the question is the turn's state), it
names no stage, and it ages out after an hour like an open turn. The tree re-reads every 5s
while a turn or a question is open, 15s otherwise. What it still cannot see: an agent that
asks in prose and ends its turn without a `pending_interaction`; that is not a question Kiro
recorded, and reading message bodies to find it is where this extension stops. Pins:
kiro-usage "a question the agent asked in the chat"; waiting-on-you "a question pending in
the chat"; credits-page "a chat question on the Waiting page".

**While the agent has a turn open, it is not the person's turn.** The inferred gate
("artifact written, nothing after") and a questions file with empty answers are both what a
stage looks like in the middle of the agent's reply: the artifact is there, the next event
has not landed, the file is being written. Seen live: the person answered and the Waiting
row kept its colour through the whole reply. Nothing in the AI-DLC ledger says the agent is
busy (HUMAN_TURN means the person spoke); Kiro's session store does, as a `turn_start` with
no `turn_end` or `usage_summary` after it. `readKiroUsage` reports it as `agentBusySince`
(open turns older than an hour are a crashed session, not work), `index.js` puts it in the
project cache stamp (nothing under the project changes when a turn opens, so without that
the row never refreshed), and `mergeWaiting` drops inferred gates and open questions while
busy. Engine-stated waits (STAGE_AWAITING_APPROVAL, guard refusals) are kept. The row has a
third state, "agent is working". Pins: kiro-usage "a turn_start with no turn_end";
waiting-on-you "while the agent is busy".

**A person's turn on v2 is a questions file with an open `[Answer]:`.** Guard refusals
and parked plans are two sources; the third, and on real intents the common one, is a
`*questions*.md` under `<phase>/<stage>/` with unanswered `[Answer]:` lines, the same
convention v1 uses, with `.aidlc-human-turn` touched when the engine handed the turn over.
Verified on four intents: the two in progress had open answers and the human turn later
than `.aidlc-engine-touch`; the two finished had neither. Before this was read, a project
with three unanswered questions showed "Nothing is waiting on your decision". The
regression baseline for v2-probe2 changed on purpose: it is parked at CI Pipeline with one
question open, which is the truth about that sample. Pin: waiting-on-you, four tests.

**Attribute a session to the project folder itself or a subfolder, never a parent.** A
parent-folder session attributed to two unrelated projects at once (646 credits
counted where 282 were spent).

**Position comes from the project's structure, never from parsing Markdown.** This was
0.0.19's rule, and the tree's first row broke it until 0.0.26: it was labelled by the
`aidlc-state.md` parser, whose regex needed a one-word phase before a dash. In a current
state file exactly one line has that shape, `- [ ] Operations - PLACEHOLDER`, so a v1
project in Inception read **Operations**. The row is gone; the one summary row reads
`journey.currentIndex` and nothing else, and what the state file says appears in its
tooltip as "State file says", labelled as the agent's record. `tests/state-format.test.js`
had characterised the parser's failure in January without the row being traced to it;
it now runs the real parser over both fixtures. Pins: v1-isolation "the tree has one
summary row, labelled from the journey alone"; state-format, all parser tests.

**A v2 project with no intent has no journey, and v1's must not stand in.** `readProject`
returns the caller's v1 journey when v2 has no active intent, "so a caller that only knows
about journeys keeps working". The tree took that literally and a freshly set-up v2
project showed Setup / Inception / Construction / Operations, fifteen stages that are not
its stages. The tree now checks `project.v2.active` and shows "Not started" with what to
type (`/aidlc …` on v2, `"Using AI-DLC, build …"` on v1) in the row's description and in
the viewer's strip, in place of the position that will appear once there is one. v1's
Setup repo is done the moment rules are installed, so a v1 project that has reached only
that is treated the same way; its label stays "Setup repo". Pins: v1-isolation "a set-up
project that has not run shows what to type"; viewer-single-pane "with a not-started
payload the strip shows the hint".

## Pitfalls in the viewer and the shell, found in the field

These are not v2 rules but belong with them: each cost a build or a blank screen, and
each has a test that executes the code rather than reads it.

**The webview script is inside a template literal.** Everything in `getWebviewHtml` is
unescaped once before the browser sees it. `'\n'` in the webview code is `'\\n'` in the
source file; `'\n'` becomes a literal line break (SyntaxError, viewer blank) and `'\\\\n'`
becomes a split on the two characters backslash-n (Markdown tables collapsed into one
row; this had shipped). A backtick anywhere inside, including in a comment, ends the
literal. Pin: viewer-single-pane "a Markdown table renders as rows". The viewer tests
execute the script against a DOM stub; a grep-based test would have passed on all three
shapes.

**`JSON.stringify` does not make a string safe inside an inline `<script>`.** A document
that mentions `</script>` ended the viewer's script there, and the viewer never started.
Every `<` in the embedded JSON is written `\u003c`, the same string to the JS parser and
inert to the HTML tokenizer. Found by a test fixture about HTML comments, not by a user.
Pin: viewer-single-pane "a document that mentions </script> still loads the viewer".

**HTML comments are shown, dimmed, never dropped or rendered as prose.** AI-DLC puts the
agent's instructions in them. They are extracted before escaping like code blocks, and the
text inside is escaped on the way back, so a comment cannot carry markup. Pin:
viewer-single-pane "HTML comments render dimmed, with their markup escaped".

**A `display:none` textarea has no layout in the tick it becomes visible**, so a
`scrollTop` set then is dropped (double-click to edit "went to the top"). Defer to
`requestAnimationFrame`. And never keep the two panes in step by scroll ratio: rendered
Markdown and its source differ in height, so the same ratio is different text (the Edit
button "jumped a little"). Place is kept by text, both directions. Pins: viewer-single-pane
"Edit opens on the text that was at the top of the view" and "View returns to the text
that was at the top of the editor".

**A re-rendered webview must be byte-identical when nothing changed.** The Credits page
re-reads every 10 s (its store is outside the watched folder, so no file event fires on a
spent turn) and assigns `webview.html` only when it differs, because assigning it folds
every `<details>` and resets scroll. A fresh CSP nonce per render made every render
differ, and History closed itself every ten seconds. The panel fixes one nonce for its
lifetime. Pin: credits-page "rendering twice with the same nonce is byte-identical".

**The Credits page's CSP allows no inline style.** `style-src` is the nonce'd block only,
so `style="width:60%"` is dropped and a bar renders as an empty track. Seen in a
screenshot. Widths are classes (`.w0` … `.w100`) defined in the stylesheet; nothing on the
page may carry a `style=` attribute. Pin: credits-page "the rollups carry bars", which
asserts no `style="width` survives.

**Every phase is listed in the tree, including one the scope skipped in full.** Filtering
those out left a v2 project showing three of five phases while the strip above showed all
five. The row reads "not in scope", dimmed. v1 has no scope mechanism, so its rows are
unchanged. This took two fixes: the first changed the row's wording and the test helper
but left the `.filter(...)` in `getChildren` in place, so the tree still showed three. A
test that re-implements the logic it is testing proves only that it agrees with itself;
the pin now also reads the `getChildren` source and requires no filter between the phase
groups and the rows. Pin: v1-isolation "every phase is listed".

**Toast buttons cannot be coloured, so the generation and the harness are separate
toasts.** Three buttons in a row (v1 / v2 · Kiro IDE / v2 · Kiro CLI) did not tell the
decision that matters (generation) apart from the one that follows it (harness). The first
toast offers v1 and v2; for v2 a second toast in the same place offers Kiro IDE and Kiro
CLI, skipped when the project already recorded one. The earlier objection to a two-step
flow was a QuickPick opening in the centre of the screen, not the second step itself. Pin:
install-prompts "the setup toast asks the generation with two buttons".

**Every toast button that sets up goes through `offerAidlcSetup`; only the toolbar reaches
`runSetup` bare.** `runSetup(folder)` with no preselection opens the generation QuickPick in
the centre of the screen, which is right for the toolbar (a list with explanations) and wrong
for a toast button. The per-version notice's "Set up AI-DLC" went through `setupRules()` and
reopened the picker the two-step toasts had retired; found in the field the same afternoon.
Pin: install-prompts "only the toolbar command reaches runSetup without a preselection".

**Setup's installers return nothing, so "did setup happen" is read from the folder.**
`runSetup` compares `detectGeneration` before and after; a generation present after that was
not present before is what was just set up, and only then does the start page open. A re-run
over an installed project opens nothing. A copy-to-clipboard button on it did nothing in the field (`vscode.env.clipboard` from a
command fired by a webview link), and was removed; Kiro's own `kiroAgent.focusChatInput`
takes `{ prompt, clear }` and puts the text in the input directly, which is what Kiro's
`sendTerminalToChat` does. The page is script-free like the others; its
buttons are `command:` links, and the panel's `enableCommandUris` names exactly those
commands. A test parses both and requires the sets to match, because a link to a command
the panel does not enable fails silently. Pins: credits-page "the start page" (two tests),
v1-isolation "the start page opens only for a generation setup just added".

**README images: relative in the source, rewritten to GitHub raw at packaging, and the files
must be on `main`.** Three attempts on 2026-10-13. Absolute raw URLs were broken until the
branch was pushed. Then the rewrite was turned off on the assumption that open-vsx serves
files from inside the vsix; it does not (`/file/media/x.png` is 404), and 0.0.27 shipped with
every image broken. The working arrangement: the source README keeps relative paths (GitHub
and local render them), the package script passes `--githubBranch main` so vsce rewrites them
to `raw/main/...`, and the five files are pushed to `main` (the user can push media even
where code is blocked). The test checks each URL online and skips offline. The demo gif and
`.kiro/` are excluded from the vsix. Pin: tests/readme-images.test.js.

**The viewer's colours are the theme's, never a fixed palette.** The rendered Markdown
used One Dark's hex values for headings, code, emphasis and quotes, and mixed `#000` into
the code chip. On a dark theme that read fine, which is why it shipped; on a light theme a
screenshot showed red code on a grey chip nearly the text colour. Every colour is now a
`var(--vscode-…, #fallback)` with the old hex as the fallback. Which token matters: the
first pass used `textPreformat-foreground` for inline code and `charts-*` for headings, and
a second screenshot showed grey code on a light grey chip. Kiro Light defines
`textPreformat.foreground` at 2.8:1 against its own page, and defines no `charts.*` at all
(those fall back to VS Code's dark-leaning defaults). Measured against both Kiro themes'
`editor.background`, the tokens every theme defines at legible contrast are the terminal
ANSI palette (`ansiRed` 6.5:1 light / 6.8:1 dark) and `textLink.foreground` (5.9 / 5.8).
Inline code is `terminal-ansiRed` on a 10% tint of itself; headings use the ANSI palette.
Read the theme's JSON and compute the ratio before choosing a token; a token's name says
nothing about its contrast. No light/dark branch exists to get wrong.

Was known and deliberately left until 0.1.4: `**strong**` text used `terminal-ansiYellow`,
2.7:1 on Kiro Light (11.6:1 on Kiro Dark), with no yellow-family token legible on both
backgrounds. The move to Kiro's own preview typography (below) made strong, em and the
headings the text colour, as Kiro's preview has them, so the item is closed by removal
rather than by a token. Pin: viewer-single-pane "the viewer stylesheet hard-codes no
colour", which fails on a single hex outside a var() fallback.

**Stage directories sort in workflow order.** The tree sorted directories alphabetically,
so under Inception `contract-design` came before `requirements-analysis`. The order is the
journey's (`MarkdownTreeDataProvider.stageDirectoryOrder()`): v2 slugs are the directory
names; v1 directory names come from `CHECKPOINTS.dir/unitDir` because the v1 journey
carries only ids. Phases take their first stage's index, unnamed directories (units) sort
after every stage, files after every directory. Pin: v1-isolation "stage directories sort
in workflow order", which runs the real method against a real v2 sample and the v1 list.

**The built-in guide is pinned to the build it ships with.** Prose does not fail a test
when the behaviour it describes changes, and the guide fell behind the same day twice.
`tests/guide-current.test.js` renders `getHelpHtml` and requires the sentences a user
would act on (page names from `PAGE_TITLE`, the harness buttons, "Not started", the bar
rule, the Waiting row colour) in both languages, and forbids the wording of previous
builds (largest-row bars, old page names, "Kiro IDE records credits only"). A feature
change that touches any of these fails the test and names the sentence to rewrite.

**A tree row's label is coloured only through a FileDecorationProvider.** A TreeItem can
colour its icon (`ThemeIcon` with a `ThemeColor`) but not its label, and an icon alone did
not make the Waiting row stand out. The row carries a URI in a private scheme
(`aidlc-waiting:/<count>`) and the provider that colours NEW files paints the label in the
warning colour with the count as the badge, or dims it when nothing waits. The count in the
path means a changed count is a new URI and VS Code re-asks on its own. Pin: v1-isolation
"the Waiting row is coloured through the decoration provider".

**A proportion bar is scaled to the whole, never to the largest row.** Scaling to the
largest row made every one-session project's bar full: 89 credits looked like 200 would.
Bars on the Usage page are the share of the project's total, say so in their title ("75%
of the project's credits"), and the column header reads "share of total". Pin:
credits-page "a session that is half the project draws a half bar".

**`summary { display:flex }` drops the browser's disclosure marker.** Draw ▸/▾ with
`::before`.

**Every command the UI invokes must be in `package.json` and registered in
`activate()`.** `showCredits` shipped unregistered once ("command not found"), with 276
tests green, because nothing executed `activate()`'s wiring. Pin:
command-registration.test.js, a three-way check that named the missing command when the
bug was reintroduced.

**Run the tests in a separate shell call from the commit.** A chained
`npm test … && git commit` committed with one failing test (71e2f4f, fixed in eea86b1).

**Editing `src/extension.js` from a Python heredoc misses on indentation** (the file is
two-space; `sed -n` output shows two more) and on escapes. Prefer the `strReplace` tool
after a `read` of the exact line. Commit messages go in a temp file and `git commit -F`;
the agent's shell policy blocks command text matching `kiro…crew … token` and paths under
`~/Library/Application Support` and `~/.aws`.

**The intent's plan outranks the scope grid, and the engine records it in the state
file.** A plan composed for one piece of work (`--add` / `--skip`, or a recompose) runs on
a stock scope with its own stage changes; the engine writes them as each checklist line's
suffix in `aidlc-state.md` (`- [-] practices-discovery — EXECUTE`) and reads that before
the grid (`effectivePlanAction`, `parseStateStageSuffixes`). No scope file changes. The
first 2.11.3 run seen in the field was a brownfield refactor whose plan added
practices-discovery, units-generation and delivery-planning and dropped the two deployment
stages; the grid alone showed the running added stage as "not in scope" and the position
one stage behind, on a completed stage. Reading the state file is otherwise avoided here
(it is prose the agent writes), but this suffix is written and parsed by the engine with a
fixed regex, which is copied verbatim into `graph.planOverridesFromState`; the four earlier
samples carry the same suffixes and agree with their grids, which is why this went
unnoticed. The checkpoint carries `planOverride` and the Progress tooltip says how many
stages the state file decided. Sample: v2-brownfield-wordbook (regress, fifth). Pins:
v2-robustness "plan override: …" (three; two fail on the prior code, the third holds the
grid in charge when no suffix exists).

**The audit ledger is the position's second source; the runtime graph is the first.**
The map's position came from `runtime-graph.json` alone, with the ledger read only for
units. Copying a real project (v2-probe3, eleven stages completed) and removing that one
file made the map read "Not started"; truncating it to three records put the position at
state-init. Both are what a project looks like when the hooks that write the file did not
run (an untrusted workspace, a watched folder that was not the root, the harness switch
that deleted the hooks) or when 2.11.x writes the record into a unit's worktree
(`worktreeRuntimeGraphPath`, not yet seen on a real run). Now `audit.summarise` folds the
`STAGE_*` events into a last-state per stage and `buildFromStages` consults it for a stage
the runtime graph has no record of; the checkpoint carries `source: 'ledger'` and the
Progress tooltip says how many were read that way. The rules mirror the engine's own
runtime graph as observed, not a stricter idea of it: `STAGE_COMPLETED` without a unit is
done and a later `STAGE_REVISING` does not undo it (every sample kept `approved` through
revising); a per-unit `STAGE_COMPLETED` leaves the stage active, since without the runtime
graph the unit total is unknown; a runtime record outranks the ledger wherever one exists.
The scope falls back the same way, from the runtime graph's `scope` to the manifest's, so
the denominator survives the missing file too. On the four samples the ledger and the
runtime graph name identical stage sets, so no baseline moved for the fallback itself.
Found alongside: `STAGE_SKIPPED` in the ledger (a conditional stage the engine declined)
leaves the runtime record at `pending`, which showed as "in progress" (v2-probe2,
contract-design, counted as one of two active stages). The ledger's word wins over a
pending record, never over an approved one; the stage is plain "skipped", not "not in
scope". The v2-probe2 baseline changed on purpose for that one stage. Pins:
v2-robustness "ledger fallback: …" (five) and "STAGE_SKIPPED …" (two), all built from
the fixture writer with a ledger shard and a runtime graph that disagree.

**The Usage page's By stage table is in the order the run reached the stages.** It was
sorted by credits, largest first, so on a real project functional-design sat above
intent-capture and the reader had to re-find the workflow in a list that had shuffled
it. The order is each stage's first window start in the engine's ledger (v1: its
artifacts' earliest modification time), which is the run's own sequence and needs no
stage graph; a stage revisited keeps its first position. Pin: credits-page "By stage
lists stages in the order the run reached them, not by credits", which builds three v1
stages with credits arranged against the order and reads the rendered table.

**The watched folder is the workspace folder; do not ask for it.** Kiro reads AI-DLC's
agents and hooks from the workspace root and nowhere else, so a watched folder that was
not the root was a project the viewer showed and the engine never ran in. Worse, a folder
watched from a window with no folder open was stored against that window's
`workspaceState`, which is a different workspace from the one Kiro creates when the
project is opened, so the choice vanished on the reload the person had to do next. Seen
in a customer workshop where the presenter had people pick the folder and then open it.
Now: one open folder is watched on activation without asking; several are watched when
exactly one carries AI-DLC, otherwise the toolbar asks among them (QuickPick, not a disk
dialog); none makes the toolbar button open the folder in Kiro, with the setup offer that
pick would have made carried across the reload in `globalState` and keyed to the picked
path. With one folder open the button shows no dialog: it watches that folder (bringing
a window that stored another one back in line) and asks the setup question. A dialog was
kept there at first for sub-folders, and the first press of the button in Kiro asked why
it did not just take the open folder; v1 has no sub-folder case either, its rules being in
the root's `.kiro/steering`. The `aidlc-docs` auto-detect prompt is gone: it asked for the
one thing that is now automatic, and it knew only v1. A folder watched this way with no
AI-DLC in it shows an empty tree and a second viewsWelcome panel (gated on the
`aidlcViewer.setupNeeded` context key, set in `refreshSupervision` from the same read as
the tree) whose buttons are Set up and Guide, the shape of the no-folder panel; a "Not
started" row with a hint was tried first and asked to be this. Its Set up button is
`markdownWatchViewer.offerSetup`, which goes through the same two-step corner toasts as
watching a folder does, not the toolbar's QuickPick: the first build used `setupRules`
and the centre-screen list came back, the one place those toasts were meant to retire.
Pin: workspace-folder.test.js,
which runs the real `restoreWatcher` and `selectFolder` against a `vscode` stub with 0, 1
and several workspace folders; all fail on the code before this change.

**Any AI-DLC in the folder means no setup, decided when acting, not when asking.** The
extension sets up projects that have no AI-DLC and never writes into one that does; v1
and v2 cannot share a project, and upgrading or changing harness is the engine's `aidlc
config`, which the refusal names. Two defects produced this rule, both from a customer
workshop where people installed the engine with the upstream `install.sh` and configured
the project by hand. (1) The setup toast has buttons, so it stays until pressed; the
order on screen was pick folder (toast appears, folder empty), run `aidlc config`, press
the toast's v2. `aidlcSetupNeeded` had been evaluated once, when the folder was picked,
and nothing re-read the folder before installing over it. (2) The "recorded harness is
kept" guard in `installV2` read the extension's own receipt, which the engine-performed
install (0.0.25 onward) never writes, so every v2 project read "none recorded", the
harness was asked again, and the other answer switched it. Reproduced against the real
engine on a Kiro IDE project with `--harness kiro-cli`: 18 files removed including
`.kiro/agents/aidlc-aidlc.md`, the `/aidlc` entry agent, 18 added, 31 changed. No test
had exercised the guard against an engine-installed project; the one test for it
planted the extension's receipt by hand and so tested a path no shipped project took.
Now `safeGeneration(target) !== 'none'` in `runSetup` refuses with the message, and the
toast condition is the same expression; the receipt-harness guard, `recordedHarness`,
the "reinstall" / "already present" QuickPick rows and the "Reinstalling" progress title
are gone. Pins: setup-gate.test.js, which runs the real `offerAidlcSetup` with the toast
promise held, configures the folder between showing and pressing, and asserts the
installer module is never called; and install-prompts "installV2 no longer reads a
recorded harness".

**Under unit-major iteration the block's later stages have only unit rows, and the
position is the live (stage, unit) beat, not the furthest stage.** GitHub issue #2, two
reports three weeks apart. With `Construction Iteration: unit-major` the engine walks one
unit through functional-design, NFR, infrastructure and code-generation before the next
unit begins, and its Current Stage stays on the block's first stage the whole time
(engine source, `aidlc-orchestrate.ts`: "Under the unit-major walk Current Stage stays on
the block's first stage"). So the later per-unit stages get no runtime record and no
`STAGE_*` row; their only trace is `UNIT_STARTED` / `UNIT_COMPLETED` and review rows
carrying `Stage` and `Unit`. The ledger fallback read `STAGE_*` rows only, so a project
with two of nine units through the whole block showed those four stages as "not started"
and the row looked stuck, while `aidlc --status` moved. Two changes. (1) A row naming a
stage and a unit is that stage entered, when nothing stronger is known: the same
evidence rule `unitsSeen` already applied, now applied to the stage's state too; it never
overrides completed or skipped. (2) With every stage in the block then active, "furthest
with evidence" put the position on code-generation while the run was on u3's
functional-design, which the second reporter called out. The engine's own `parked`
directive names the live (stage, unit) beat for the same reason (#1411), so the position
is the stage of the latest unit-bearing row by timestamp, when both it and the furthest
stage are open per-unit stages; the row shows `· on u3` and the tooltip bolds that stage.
Any row naming a stage and a unit, not only the `UNIT_*` lifecycle rows: the first cut
used the lifecycle rows, and the live word-book run showed a 42-minute window where u2
had closed functional-design, the engine was asking for u2's code-generation plan
(`QUESTION_ASKED`, `PLAN_APPROVAL_RECORDED`, both on code-generation u2) and no
`UNIT_STARTED` had been written yet, so the position sat on the stage just finished.
A stage-major run is unaffected by construction (its latest unit row is already on the
furthest active stage) and a non-repeating stage past the block keeps the position. The
reporter's open question, whether the block ends with stage-level `STAGE_COMPLETED`
rows, is answered by the engine's `settleBookkeepingGate`: once every unit is approved it
reports awaiting-approval then approved per stage, which writes the rows and the runtime
records the existing rules read. The word-book sample was refreshed the same day and is
the first unit-major Construction run among the samples (2 units, u1 through
code-generation, u2 on code-generation): before the change it read functional-design
with code-generation "not started" at 1/2; after, code-generation, on u2, in progress.
`UNIT_STARTED` and the rest of the engine's unit lifecycle set are now known events,
which removed one name from v2-probe3's `unknownEvents` baseline. Pins: v2-robustness
"unit-major: …" (six), "stage-major: unit rows change nothing" and "unit rows never
promote a stage the ledger closed or skipped"; five fail on the code before this change
and the plan-question one on the lifecycle-only beat.

**A bracketed key under `configurationDefaults` is a language override; one that names
a view can take every other extension's settings down with it.** GitHub issue #3, Windows
Kiro, 0.1.1: Git "not enabled", `git.enabled` "is not a registered configuration", Volar
failing on `vue.server` undefined, all gone when this extension was disabled. The cause
was `"[markdownWatchViewer.tree]": { "workbench.tree.indent": 20 }` in `package.json`,
there since 0.0.x. In `configurationDefaults` a `[...]` key is a per-language override
and the brackets must hold a language id; `markdownWatchViewer.tree` is a view id, and
`workbench.tree.indent` is not language-overridable, so the entry never did anything.
Why it reached other extensions: VS Code's `configuration` extension point depends on
`configurationDefaults` and both are applied in one `deltaConfiguration` call, so a
registry that throws on the bad key loses every extension's `configuration` contribution
in that delta. Upstream VS Code main tolerates the key and this Mac's Kiro showed no
symptom, so the throw is specific to some Kiro builds; the reporter proved the cause by
removal. The fix is the removal and nothing else: the two plain defaults beside it
(`workbench.tree.indent`, `renderIndentGuides`) stay, because they are what 8,000
installs see today and dropping them would narrow every tree in the editor, which is a
separate decision. Pin: changelog.test.js "configurationDefaults has no bracketed
key", which fails on the 0.1.2 manifest.

**The viewer renders with markdown-it, and its typography is Kiro's own preview's.** The
renderer had been a hand-written converter of fifteen regex passes, no dependency, and it
could not nest or span lines. Rendering the 423 user-facing artifacts in the five samples
with it and with markdown-it side by side (`$KIROCREW_SCRATCH/mdcmp/compare.js` at the
time; the corpus check is now renderer.test.js) showed 52% producing structurally invalid
HTML: every fenced block inside a `<p>` (42%, because the fence placeholder matched the
paragraph rule, so each code block carried a stray empty paragraph), hard-wrapped
paragraphs split per line (13%), nested list items outside any list (6%), `snake_case`
identifiers italicised (5%), list continuation lines dropped out of the list (4%),
blockquotes split per line (2%). Agents hard-wrap at 80 columns and nest bullets, so a
third of artifacts hit one of these. The replacement is markdown-it 14 (CommonMark + GFM
tables + strikethrough + linkify) with the task-lists plugin, the engine VS Code's and
Kiro's preview use, loaded as the shipped browser bundles from media/ with a nonce (CSP
unchanged); `html: false`, so a tag in the source is text as before, and `validateLink`
keeps the old rule (http(s), mailto, fragment, relative). The stylesheet follows Kiro's
`markdown.css` (MIT, Microsoft) scoped to `.preview`: same heading sizes and rules,
spacing, table, quote and code block treatment, so an artifact reads the same here as in
Kiro's preview. The per-level heading palette went with it, which also retires the
yellow-strong 2.7:1 item above; links and inline code keep this extension's measured
colours. Three things were kept on purpose and each has a pin: dimmed HTML comments,
lifted before parsing in a single pass that tracks fences, code spans and an open
multi-line comment (a second whole-text pass undid the fence protection and dimmed a
comment inside a code block, caught by the test); the mermaid fence left as
`<pre class="mermaid">` for the existing hook; double-click to edit, which finds the
source by block text and never depended on the markup. One engine note: markdown-it
replaces U+0000 with U+FFFD, so the comment placeholder is a private-use character, not
NUL as before. Pins: renderer.test.js (fifteen construct cases from the defect classes,
plus the whole corpus asserting none of the old defect shapes), viewer-single-pane
(runs the real bundles in the sandbox now). The `THIRD-PARTY-NOTICES.md` in media/ lists
the bundles and the stylesheet's origin.

Found while running the suite: the word-book regress sample is open in a Kiro window and
carries the engine's hooks, so Kiro's session start appends `SESSION_STARTED` to the
copy's ledger and moves its baseline (one `unknownEvents` entry, 2026-11-11 12:53). A
sample must not be a live project: close the copy in Kiro, or copy without `.kiro/hooks`.

**The v2 Engine Log was removed; a surface that reads the same on every project is not
earning its row.** The row and page carried three sections: the engine's live refusals
with the events that led to each, sensor findings per stage, and the agent's coverage
claim beside the engine's check of it. The user looked at it after a month of real runs
and called it unnecessary. The refusals a person must clear and the plans parked for
approval had already moved to Waiting for you (0.0.26), which is where someone acts; what
was left was a diagnostic that showed the same kind of list on every project and that no
one in a workshop opened twice. The same judgement was reached once before for the
"unknown events" list (above, "A panel section that lists things the extension does not
understand"). Removed: the `EngineRecordsItem` row, the `showEngineRecords` command and
palette entry, `renderEngineRecordsPage`, the `blocking`/`sensors`/`contrast` section
renderers and their `absolute()` helper, the guide cards (EN and KO), the README line.
Kept: the read layer under it (`diagnose`, `contrast.js`, `intent.contrast`), because
Waiting for you reads `diagnosis` and the probe and regress baseline read the rest; a
maintainer surface for that data is `npm run probe`, as the earlier rule says. Pins:
v1-isolation "the v2-only row never appears in a v1 tree" asserts the row's class and
command are gone from the source; credits-page asserts the page is no longer exported.

**The release notes ship as CHANGELOG.md and are kept identical to the README's What's
New by a test, not a build step.** open-vsx's Changes tab reads `CHANGELOG.md` from the
vsix and was empty through 0.1.2 (the API's `files` had no `changelog`). The README
section stays because the overview tab reads that. Two copies are a drift risk, so
changelog.test.js checks same versions, same order, same text under each, newest equals
`package.json`'s version, and the file is not in `.vscodeignore`. A generator was the
alternative and was not taken: the repo has no build step and the test is enough to make
editing one without the other fail the suite.

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

**The payload comes from a release, and the version is recorded.**

Upstream restructured on 2026-09-08. `dist/<harness>/`, which held ready-to-copy
installs, is gone; the repository now carries sources (`core/`, `harness/`), and the two
files this extension reads -- `stage-graph.json` and `scope-grid.json` -- are not
committed at all. They are built by a hook and shipped in the release tarball
`aidlc-runtime-<version>.tar.gz`, laid out as `runtime/<harness>/`.

So a repository tarball no longer contains anything installable. The previous approach
failed with `tar: */dist/kiro-ide/*: Not found in archive`, and there was no fallback:
fetching from the repository was the only path.

Two details cost a round of debugging. The release tarball has NO wrapper directory --
its first entry is `plugins/...` -- where a repository tarball wraps everything in
`<repo>-<ref>/`, so both the match pattern and `--strip-components` were one level too
deep. And the asset name carries the version, so it is matched on shape
(`/^aidlc-runtime-.*\.tar\.gz$/`) rather than by name, with a test that it does not also
match the platform binaries published beside it.

The receipt now records a release tag rather than a commit sha. That is a better answer
to "which engine do I have" than a sha was, and it is what upstream itself publishes.

This is the third time in a fortnight that upstream moved the payload: `v2` renamed to
`main`, `dist/kiro-cli` renamed to `dist/kiro`, and now `dist/` replaced by a release
asset. The pattern worth carrying forward is that the reader survived all three
untouched -- 33 stages, 5 phases, 11 scopes, every audit event still known -- because it
enumerates nothing. What broke each time was the fetch, which is coupling to a layout
rather than to data.

**The branch is followed, and the commit is recorded.** An install resolves the
upstream branch to a sha through the GitHub API, downloads that sha, and writes it
into the receipt.

The branch name is not a constant of nature. Upstream renamed `v2` to `main` on
2026-09-04, when the engine became the repository's default, and every install broke:
`codeload.../tar.gz/v2` 404s, and the API's commits endpoint answers 422 rather than
redirecting, so no sha could be resolved either. The failure said "no archive for that
commit", which named the wrong thing and cost a diagnosis. Two things changed as a
result. The ref moved to `main` and is now asserted by a test, because nothing else
catches it and it breaks every install. And a 404 is now worded by whether a branch or
a commit was asked for.

The same move renamed `dist/kiro-cli` to `dist/kiro`. That one failed quietly: the
extraction found nothing and reported an empty payload, which reads as a broken
download rather than a wrong path. The harness KEY is still `kiro-cli` because install
receipts on disk record it; only the directory it points at moved.
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
