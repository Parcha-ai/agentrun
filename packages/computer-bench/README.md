# computer-bench

A benchmark of an agent's computer use. A task is data; the runner is generic; checks read the computer's real state
through the computer protocol before it is released; one grader judges what the checks can't; a report compares arms
(harness × surface × model) on the same tasks and seeds.

```
computer-bench validate suites/mac-dev suites/android-dev
computer-bench verify --suite suites/fake --out /tmp/cb/verify --seeds 1,2
computer-bench run --suite suites/fake --arms arms.json --out /tmp/cb/run --seeds 1,2,3 --grade never [--verified /tmp/cb/verify/verify.json]
computer-bench report /tmp/cb/run [--split heldout]
```

The fake backend runs the fake world (`src/fake-world.ts`) with the fake agents `fake-right`, `fake-wrong` and
`fake-null` as harnesses: the whole loop at $0. `--backend serve --serve <url>` runs on an AgentRun serve, once it has the
routes listed under [What serve needs](#what-serve-needs). Keys come from the environment only: `AGENTRUN_TOKEN` for
serve, `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` for `--judge anthropic:<model>` or `--judge openrouter:<model>`.

## A task

A folder holding `task.json` ([schema](schema/task.schema.json)), an optional `rubric.md`, and any file a placeholder
names. `loadTask` validates the schema, then the rules a schema can't say (every placeholder names a param or a file,
check ids are unique, regexes compile, `exit` only on `exec.run`, a task whose checks are not sufficient has a rubric).

| field | what it is |
| --- | --- |
| `id`, `version`, `title`, `split` | `split` is `dev` (tune on it) or `heldout` (report on it, never tune on it) |
| `needs` | `os`, `kind` (`desktop`, `phone`, `sandbox`, `browser`: serve's kinds), `osVersion` (a prefix of hello's), `groups` the computer must have only when the task can't be done without them (a drag needs `input.pointer`), `apps` and `capabilities` (below). A task never says which tools the agent uses: the agent is given what the computer offers, so one suite compares code-mode, tools and vendor computer-tool agents |
| `needs.apps` | the apps the task can't be done without, by bundle id or package. Each entry is required; an entry that is a list is alternatives, any one of which will do (`[["com.google.android.deskclock", "com.android.deskclock", "com.sec.android.app.clockpackage"]]`: one clock, whoever made the phone). Read through `apps.list`, which lists the apps a person can open, so never a system service such as `com.android.systemui` |
| `needs.capabilities` | probes, each written as a check (not `answer`) whose `id` names what it proves the computer can do (`camera`): `take-selfie`'s reads `dumpsys media.camera` for a camera device. Same for every seed, so no placeholders |
| `exec` | `allow` (default) or `deny`: the task is done through the UI, so the agent is given no exec or processes group, and the oracle may use only `ui`, `input`, `screen` and `apps` (not `apps.install`), the path the agent must take. `loadTask` names the oracle call that breaks this |
| `params` | per-seed perturbations: `{pick: [...]}` (scalars, or objects read as `{{name.field}}`) or `{int: [lo, hi]}`; each param is picked from sha256(task, seed, name), so every arm sees the same values |
| `setup`, `teardown`, `oracle` | protocol calls: `{method, params, why, allow (error kinds that count as done), exit (exec.run's good exit codes)}` |
| `instruction` | what the agent is told |
| `budget` | `steps` (computer calls), `usd`, `wall_s` |
| `checks` | stage 1 (below) |
| `sufficient` | default true: the checks decide alone. False: the grader decides, and `rubric` is required |
| `source` | a ported task's suite, id, revision, licence and changes |

Placeholders: `{{param}}`, `{{param.field}}`, `{{seed}}`, `{{nonce}}` (6 hex characters from task and seed: put it in
every name a task makes, so runs on a shared computer never meet) and `{{file:NAME}}` (the file's text, its own
placeholders filled). A placeholder always fills as text.

Checks, each `{id, kind, why}` plus its fields, all read through the protocol on the bench's channel:

| kind | reads | passes when |
| --- | --- | --- |
| `exec` | `exec.run` `argv` | `exit` (default [0]), and `stdout`/`stderr` match |
| `file` | `files.read` `path` | `exists`, and `text` matches |
| `ui` | `ui.observe` (full) of `app` | between `min` and `max` nodes match `find` (`role`, `name`, `value`, `flags`) |
| `app` | `apps.list` | `front` is in front, or `installed` is installed |
| `answer` | the agent's final answer | `text` matches |

A match is one of `equals`, `contains`, `matches`, `oneOf` or `empty`, with `not`, `trim` (default true) and `caseless`.

A `ui.act` call in setup, teardown or the oracle can't know a window's refs, so any slot that names an element
(`press`, `set`, `perform`, `click`, `into`, `scroll`) may hold `{"find": <ui query>}` instead. The runner observes the
call's target (full), puts in the ref of the first node that matches, and acts on that observation's state. A find
that matches nothing fails the call, and so does a ui.act whose step was refused or whose `expect` did not hold.

A good task starts from the opposite of its goal (so an agent that does nothing fails), names everything it makes with
the nonce, and has an oracle: the calls that solve it, which `verify` uses to prove its checks.

## The runner

`runBench` takes tasks, arms, seeds and a `Backend`, and for each seed × task × arm (in that order, so arms see a task
under the same conditions):

1. opens an episode: a computer claimed for the run, its bench channel, and the agent that will drive it;
2. reads `hello` and refuses a computer that is not what the task needs (os, kind, osVersion, a group the task can't
   be done without, the groups setup and checks need) before setup touches it, in one sentence naming what is missing;
3. reads the preconditions (record phase `precondition`): `needs.apps` through one `apps.list`, then each
   `needs.capabilities` probe. A missing app or a failing probe refuses the run as `skipped: needs com.android.chrome`
   (`needs one of a, b` for alternatives; `needs camera: <why>` for a probe), and a computer with no apps group is
   refused in words. A skip is never retried, and it is remembered for the bench run: the task's other runs are
   refused without opening a computer. An `apps.list` or a probe that could not run is infra;
4. runs setup; a setup that fails is infra;
5. runs the agent under its budget: the step budget answers `limit` past it and stops the agent, the wall budget aborts
   it, and a run that spent more than `usd` counts as `budget` whatever its checks say;
6. pings the computer on the bench's channel (phase `ping`, 15 s). No answer means it died during the agent's turn: the
   run is infra ("the computer stopped answering during the agent's turn") and runs again, before any check can
   score a dead computer as wrong. After a stop the bench made (the step or wall budget) a failed ping is expected,
   since serve's cancel lets the computer go, so the run stays `budget`, unless the bench saw the agent's calls lose
   the computer's stream before it stopped them (ordered by when the bench saw each answer, never by a driver's
   clock): then it is infra too;
7. runs the checks on the computer as the agent left it, then reads the tree and a last frame;
8. tears down and releases (always, once setup began);
9. grades, after the release: no computer waits on a model.

Outcomes: `pass`, `fail` and `budget` are scored; `infra` (the platform failed: no computer, a lost connection, a
computer that stopped answering, a check that could not run) is run again, up to `retries` (default 2), and never
scored; `refused` (the computer or the agent can't take the task, and `skipped: ` when a precondition failed) is
neither. A run stopped for its budget stays `budget` even when its checks can't run after the stop (serve's cancel lets
the computer go). `--mode null` runs no agent and `--mode oracle` runs the task's oracle on the bench's
channel: `verify` runs both and names every check that passes an untouched state or fails a solved one.

An `answer` check reads the agent's final answer without markdown emphasis (`**`, `__`, `*`, `_`, backticks) and
without thousands separators (a comma before exactly three digits: `103,190.70` reads `103190.70`), and so does its
`equals`, `contains` or `oneOf`. Nothing else: no fuzzy matching, no rounding.

`verify` writes `verify.md` and `verify.json`: a skipped task × seed is a proof of its own (`untouched` and `solved`
are `skipped`, `skipped_because` says why), counted apart: "N task × seed proofs: X right, Y skipped, Z not right".
Each proof names the task's version and folder sha256. `computer-bench run --verified <verify.json>` runs only the
pairs that file proves right for the task's folder as it is now. Every other pair is refused without opening a
computer, as `not verified for seed N` (with what verify found, or that it proved another version) or as its skip, and
the CLI says how many it left out.

The agent's calls go through a tap (`src/tap.ts`) that records them, keeps the budget, and denies a method outside the
groups the agent is given (exec on a phone is the bench's, not the agent's). After each act it takes a frame on the
bench's channel: the whole screen where the computer has the screen group, else the front window's image through
`ui.observe` where `ui.image` is on. A backend whose agent's calls are recorded elsewhere (serve's Timeline) reports
them as steps instead.

## The run record

`<out>/runs/<run>.jsonl`, one entry per line, shaped as serve's journal entries (`{kind, at, run, data}`) so they can
move into a run's journal once serve writes computer steps itself:

| kind | data |
| --- | --- |
| `agentrun.bench.run` | the header: task (id, version, sha256, split, seed, nonce, params, instruction), arm, attempt, budget, what the agent was given (sha256s), the computer's identity and its whole hello |
| `agentrun.computer.step` | one protocol call: `n`, phase (precondition, setup, agent, frame, ping, check, observe, teardown, oracle), method, params without bytes (`{bytes, sha256}` in their place), timings, ok or error, routes and verified (ui.act), changed, expect, state before and after, stale, and images (`got`, `pre`, `post`) by sha256 |
| `agentrun.bench.checks` | stage 1: each check's status, what it read, and why it failed |
| `agentrun.bench.grade` | stage 2's verdict and the judge's id, or its error |
| `agentrun.bench.verdict` | the result line (below) |
| `agentrun.bench.cleanup` | a teardown or release that failed after the verdict |

Images are kept once under `<out>/blobs/<sha256>`. Beside the runs: `bench.json` (the bench run's arms, seeds, tasks
and judge), `results.jsonl` (one line per attempt: outcome, scored, rerun, stage 1, the grade, steps, cost, wall,
routes, stale, no-op acts, verified steps), `human-queue.jsonl`, and the person's `labels.jsonl`. One bench run per
folder: a run refuses a folder that already holds `results.jsonl`, so a report never pools two.

## The grader

Stage 1 is the checks. When they are sufficient they decide; the grader runs on failures (`--grade auto`, the default)
to name the failure's locus and catch a check's false negative, or on every run (`always`) to measure false positives.
When a task's checks are not sufficient, the grader decides.

Stage 2 is one grader, with the rules stated once in [templates/grader-prompt.md](templates/grader-prompt.md) and only
what is task-specific in the task's `rubric.md` ([template](templates/rubric.md)). It is given the instruction, the
rubric, each check's status and output, the end state's tree, the agent's last 30 steps, the last 3 distinct images (the
last the end state) and the agent's own end, and answers `{verdict, locus, decisive_step, checks_agree, rationale,
confidence}`. The locus is the earliest decisive error: `planning`, `grounding`, `verification`, `environment` or
`task`. `combine()` is the one place verdicts meet:

| checks | grader | final | queued for a person |
| --- | --- | --- | --- |
| sufficient pass | fail | pass | yes |
| sufficient fail | pass or unknown | fail | yes |
| not sufficient | pass or fail | the grader's | when it differs from the checks |
| not sufficient | unknown, or none ran | fail (unknown) or the checks' (none) | yes |

A person labels a queued run in `labels.jsonl` (`{run, verdict: pass|fail|infra, note}`), and the report applies it.
The judge is a seam (`Judge`); `messagesJudge` calls an Anthropic Messages endpoint and asks once more when the answer
isn't the JSON, then says unknown.

## The report

`computer-bench report <out>` writes `report.md` and `report.json`: per arm, success with a 95% interval clustered by
task (the task is the unit; never narrower than Wilson's at the task count), tasks passed on every seed (pass^k), mean
steps, $ per run and per success, wall time, budget stops, infra re-runs and final, refusals, the queue, the route mix
(semantic, page, background, foreground, raw input, error), stale steps per run, no-op acts and verified steps; each
arm's paired difference against the first, over the task × seed pairs both arms scored; the failure loci; and a table
per task.

## Suites

| suite | tasks | what |
| --- | --- | --- |
| [fake](suites/fake) | 6 | the fake world's: what the tests run |
| [ui-fixture](suites/ui-fixture) | 4 | the protocol's ui fixture app (`ai.agentrun.uifixture`; its canvas counts the clicks that reach it), run by its fake ui driver (`@parcha/agentrun-computer/fake-ui-driver`) in the tests, and by a real driver wherever the fixture app is installed |
| [mac-dev](suites/mac-dev/README.md) | 20 (10 dev, 10 held out) | Notes, Calendar, Finder, Safari, TextEdit, System Settings, Reminders on macOS 26; four tasks cross two apps |
| [android-dev](suites/android-dev/README.md) | 20 (10 dev, 10 held out) | Settings, Clock, Contacts, Files, Chrome, and two tasks through Chrome's share sheet, on an unrooted phone, checked through `settings get`, `content query` and the ui tree |
| [macosworld](suites/macosworld/PORT.md) | 10 | ported from macOSWorld (CC BY-NC 4.0: by reference, none of its text) |
| [mobileworld](suites/mobileworld/PORT.md) | 8 | ported from MobileWorld (Apache-2.0): the 8 of its 201 that port faithfully to an unrooted phone |

Each suite's README says which tasks are proven only on the fake and which wait on a live run.

## Arms

`arms.json` is a list of `{id, harness, surface, model, effort?, options?}`. On serve, the arm is an agent definition:
`harness` and `model` as they are, `effort` as its `thinking` level, `computer.kind` from the task, `options.provider` the provider that serves
it, and `options.definition` any other field of the definition as it is, such as the tools that make the surface:

```json
[
  { "id": "pi-code-sonnet", "harness": "pi", "surface": "code", "model": "claude-sonnet-5-5",
    "options": { "provider": "<a provider GET /computers lists>", "definition": { "tools": ["computer_script"] } } },
  { "id": "pi-tools-sonnet", "harness": "pi", "surface": "tools", "model": "claude-sonnet-5-5",
    "options": { "provider": "<a provider GET /computers lists>", "definition": { "tools": ["computer_observe", "computer_act", "computer_screenshot"] } } }
]
```

## What serve needs

One concept, a held computer. `src/serve.ts` is written against these routes (`SERVE_CONTRACT`); `test/serve.test.mjs`
proves it on a fake serve that keeps them, and runs the preflight against this repository's serve, which finds nothing
missing.

1. `POST /agents/{agent_id}/runs` with `hold: true` (and `hold_minutes`, 1 to 120, default 30): the run claims its
   computer and waits, its agent not started, `computer.held.state` `waiting`; `POST /runs/{run_id}/start` starts the
   agent. Only for a sandbox, a desktop or a phone.
2. `POST /runs/{run_id}/computer/call` `{method, params}` answers the computer's answer verbatim, `{ok, value}` or
   `{ok: false, error}`, for any method of the computer protocol (others are 422): the bench's channel, for every group
   the computer has (exec on a phone included, which the agent is not given). The owner's token or session only; a run
   never holds that token, so no agent reaches its own computer this way.
3. After the agent ends the run keeps its computer (`held.state` `ended`) until `POST /runs/{run_id}/computer/release`
   (404 `not_found` once let go, a message other than "no route"), or until `hold_minutes` pass with no call. Released
   after the agent's end, the run ends as its agent did; released before the start, it ends cancelled.
4. The agent's steps come from `GET /runs/{run_id}/timeline`: each `tool_use` and its `tool_result` row (the tool's
   name, its input preview, success or failure). No journal route. The rows carry no protocol detail, so a serve run's
   steps have no ui.act routes or verified counts; a `computer_calls` field on a tool_result row would carry them.
5. `GET /runs/{run_id}` answers `computer {state, provider, why, held {state, minutes, until, why}}`, `cost {usd,
   so_far_usd}`, `result {final_answer}` once the run completed, and `error {code}`; a platform failure's code is one of
   `computer_unavailable`, `provider_error`, `model_unavailable`, `upstream_error`, `internal`, `runner_lost`. The
   answer the checks read is the Timeline's `final_answer` row, there once the agent ends, before the release.
6. Budgets: the money budget is the run's `max_cost_usd`. The step budget is the agent's `max_tool_calls` on pi (one
   agent per arm, kind and budget there); on every harness the bench counts the Timeline's tool calls and cancels the
   run past it, which lets the computer go, so the checks after a cancel find it gone. Labels are gone: the bench's
   agent ids say which bench run made them.

When serve lacks one, `--backend serve` stops before it claims any computer, with one error that names each route serve
lacks (a 404 "no route" or a 405), what its OpenAPI document leaves out (`RunCreate.hold`, `Run.computer.held`), and
the item above that asks for it. It asks once, of a run nobody has, so the asking claims nothing. A route that goes
missing later stops the bench at the first episode that needs it (a body field it keeps none of is a 422 "The body
keeps no field"), its computer released where serve can.

## Live runs

A run on vendor phones or with model spend is planned in this order: first `verify` (null and oracle, $0 of model) on a
Mac and a phone, which turns each suite README's "verify live" into proven or fixed; then the agent arms on
the dev split; then the held-out split once, for the numbers a report states.

## Tests

`npm test` runs `test/*.test.mjs` against `dist` at $0: the schema and every suite; the runner on the fake world
(passes and fails, the record, checks before release, infra re-runs, refusals, grants, the three budgets, images,
stale steps, null and oracle, parallel); the grader with fake judges and a fake fetch; the statistics, the report,
labels, verify and the command line; the serve backend on a fake serve, and its preflight on this repository's serve;
and the runner on the protocol's own fake ui driver over its line stream (the fixture suite's verify, right and wrong
agents, each act's routes, verified count, states and window frames, a stale ref, and oracles that fail in words).
Those two need `@parcha/agentrun-serve` and `@parcha/agentrun-computer` built: they are dev dependencies, and the
package's source imports nothing from them.
