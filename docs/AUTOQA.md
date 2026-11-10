# AUTOQA.md: AgentRun (Parcha-ai/agentrun)

Baseline for the `autoqa` skill. It says how to bring up AgentRun Server from a checkout, how to authenticate, and
which checks make up the core catalog. Read it first, then plan the diff cases on top of it. It does not replace diff
discovery.

Drafted from the first whole-platform QA run (2026-11-01, main `ba6a76271`). Sources: `AGENTS.md`,
`packages/serve/README.md`, `packages/serve/src/{cli,server,harness,adapters,runs,tools,tool-keys}.ts`,
`apps/console/src/App.tsx`.

## Unattended scope

When this runs from a pipeline or a periodic QA job, the scope is fixed here and nobody is asked:

- **Periodic whole-platform pass** (default when no PR is named): every row of the core catalog below, on every
  harness that `GET /v2/capabilities` reports `available: true`, at low and medium effort. Budget: about $10 of model
  spend, one build or test job at a time, 60 to 90 minutes of wall time, one headless browser.
- **PR pass**: the diff cases, plus health, auth and the rows of the catalog the diff touches.

## How to run

Node 24.11 or later (`.nvmrc` pins 24.21.0); anything older is refused. npm 11
is the documented toolchain, but `npm ci` also works with npm 10.9 (the npm bundled with Node 22.23.2).

```sh
npm ci --ignore-scripts
npm run build   # the console first (apps/console, skipped when its dist is current), then every package
```

Start it with the launcher, which hands secrets to the server over a pipe:
`packages/serve/launcher/agentrun-serve --data DIR --port N`, on its default loopback listen
address.
`node packages/serve/dist/cli.js` also works, but then the secrets stay in the environment.

The banner prints `AGENTRUN_BASE_URL`, then the token (on the first start only), then `Open <url>/` and
`Set your password: <url>/setup`. Wait for the `Open` line. The token is also in `DIR/.token` (mode 0600). Read it from
there and never print it.

| Env | Why |
| --- | --- |
| `TMPDIR`, `--data` | Use a fresh data dir and a temp dir of its own per run, so no earlier run's state is read. |
| `XDG_CONFIG_HOME` | Point it at a QA dir so your own config directory is never touched. The seal key is `AGENTRUN_SEAL_KEY`, else `<data>/seal/seal.key`, made at the server's first start; nothing is kept under the config home. |
| `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_API_KEY`, `AGENT_MODEL` | Gateway for the pi and codex harnesses (OpenAI Responses). Point them at your gateway (its `/v1` base URL) and set `AGENT_MODEL` to a small, cheap model for smokes. |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | The claude-agent harness only, on Anthropic Messages. Your gateway may serve `/v1/messages` too. |
| `AGENTRUN_MAX_RUNS` | The `max_concurrent_runs` capabilities report. It does not stop a start: a run waits `queued` until a runner has a free loop. |
| `PARALLEL_API_KEY`, `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`, `TYPESAFE_API_KEY` | Optional. They unlock web_fetch via Parallel, the `browser` tool, and Jev decisions. Without a key, only the checks that need it are UNTESTED: web_fetch's direct fetch and its private-host refusal need none and always run. |

Stop the server with SIGTERM to its exact PID. The runner beside it stops every run where it can resume, and the next claim carries on from the run's journal.

## Auth recipe

- API: `Authorization: Bearer $(cat DIR/.token)`. `GET /v2/health`, `GET /v2/capabilities` and `GET /v2/openapi.json`
  need no credential. Anything else without a token is `401 unauthenticated`. A `Host` on a loopback bind
  that is not `localhost`, `127.0.0.1`, `[::1]`, the public URL's name or an `--allow-host` name (any port) is `403`.
- Console: `/` (`/console/`, `/setup` and `/sign-in` redirect there with 303). On the first visit, set the owner
  password (12 characters or more; labels `New password` and `Password again`). After that, sign in with the
  `Password` field. The session is a cookie, and the `?token=` link sets none while accounts are on.
- Forgotten password: `agentrun-serve reset-password --data DIR`.

## Core check catalog

Each row: entry point, then what makes it pass.

1. **Boot + health**: banner `Open` line; `GET /v2/health` → `200 {"status":"ok","checks":{"store":"ok","disk":"ok"}}`.
2. **Capabilities**: `GET /v2/capabilities` → `harnesses[]` (`pi`, `claude-agent`, `codex`, each with `available`),
   `models.source`, `tools[]` with `available`/`missing`, `features`, and `limits.max_concurrent_runs`.
3. **OpenAPI**: `GET /v2/openapi.json` → 3.1 document.
4. **Auth**: no token → 401; wrong token → 401 plus an `auth_failed` log line naming the reason and never the token;
   bad Host → 403.
5. **Agent create**: `POST /v2/agents {definition:{id,name,instructions,harness?,model?,tools}}` → 201 with
   `warnings: []`. Make one agent per harness. claude-agent needs `model: "anthropic/<id>"`, and codex/pi take the
   host default.
6. **Agent edit**: `PUT /v2/agents/{id}/definition` with `If-Match: <home_etag>` → a new revision. A stale If-Match
   → 412. `tools:["bash"]` → 422. Check `GET /v2/agents/{id}/revisions`.
7. **Agent archive**: archive → hidden from `GET /v2/agents`, listed under `?archived=true`. A new run → 409
   `agent_not_runnable`. Then unarchive.
8. **Runs per harness × effort**: `POST /v2/agents/{id}/runs {input:{content}, effort:"low"|"medium"}`. Poll
   `GET /v2/runs/{id}` to a terminal status (cap 300 s). Then check `GET /v2/runs/{id}/timeline` (`final: true`),
   `cost.usd`, `GET /v2/runs/{id}/files` and `GET /v2/runs/{id}/files/<path>`. Use a task that needs two files (two tool
   calls in one turn): see the open findings.
9. **Spend cap**: a priced model and a tiny `max_cost_usd`. A cap that can't buy the next request's least pauses the run:
   `input_required` and `waiting`, `error` null, `pending.kind: "budget"` (with `cap_usd`, `spent_usd`, `needs_usd`,
   `suggested_cap_usd`), a `spend_cap_reached` row on the timeline, the refused request unsent, no files; a higher cap
   sends it. A cap that buys a smaller request limits it (its output is held to what the cap buys) and the run can
   complete: e.g. `0.01` on luna completes and `0.0001` pauses. Only a refusal no cap fixes ends `failed`
   (`spend_cap_reached`). See serve's README, "A run paused at its cap".
10. **Cancel**: start a multi-step run, `POST /v2/runs/{id}/cancel` after its first tool_use → `cancelled` within a few
    seconds. Then `POST /v2/runs/{id}/messages {content}` → 409 `not_continuable`. The body takes `content` only.
11. **Follow-up**: `POST /v2/runs/{id}/messages {content}` to a completed agentic run → back to `completed`. The
    timeline's user_message count goes up by exactly one and the original rows stay first.
12. **Kernel durability, runner crash**: start the server with `--no-runner` and a runner of its own
    (`agentrun-serve runner --data DIR`; the same launcher and data directory), then a multi-step run. Take the runner's
    name from the run's row in the store (`runs.runner`, with `runs.epoch` and `runs.claimed_until`) and `kill -KILL`
    that runner's PID (its name is `<host>:<pid>:<id>`). Pass: once its claim has lapsed (30 s), a runner started again on
    the same data directory claims the run, the row's `epoch` goes up by one, the run completes, and the timeline holds
    exactly one write per file.
13. **Kernel durability, server restart**: SIGTERM the server mid-run (its runner is beside it), then restart on the same data dir. Pass: the run
    resumes and completes with no duplicate writes. The prompt must say "do not reply or stop until …", or the model may
    end its turn with a progress note before the signal and the case proves nothing.
14. **web_fetch**: a revision naming `web_fetch`, fetching `https://example.com` → `ok:true` with `via: direct` (or
    `parallel` with the key). A loopback URL and the link-local cloud metadata address → `refused: … not a public
    host`.
15. **Workflow run**: create an agent from `packages/dsl/skills/author/examples/review-release-notes.json`, run it on
    its `.input.json` → `completed`, with `result.output.changes` length 2. `GET /v2/runs/{id}/graph` → `totals`.
16. **Stats/analytics**: `GET /v2/stats` → `analytics.{totals,time,by_harness_effort,by_day,by_source,tools}`.
    `?agent=&from=&to=` filters; a malformed `from` → 400. `GET /v2/usage` → `total_usd`, `unpriced_runs`.
17. **Run archive**: `POST /v2/runs/{id}/archive` → gone from `GET /v2/runs`, listed under `?archived=true`, still readable
    by id, and `stats.archived.runs` goes up.
18. **Tool keys**: `GET /v2/settings/tool-keys` → field names with `set`/`source`, never a value. Do not PUT real
    keys.
19. **Session import (read-only)**: `node packages/serve/dist/cli.js import --dry-run --data <QA data dir>` →
    `N projects, M sessions; nothing was written (dry run)`. Pass also requires that the data dir listing is
    unchanged. On a machine with thousands of sessions it takes minutes.
20. **Console UI** (a headless Chromium of your own on loopback, not a browser other work shares): setup, sign-in,
    Mission Control (`#/mission`), Agents (`#/agents`), agent page (`#/agents/<id>`), editor
    (`#/agents/<id>/edit`, every step through History), New agent (`#/agents/new`, **create with the defaults**),
    Playground (`#/playground`: send a run, then "Open this run" to follow it live), Runs plus a state filter
    (`#/runs?status=cancelled`), run detail tabs Report/Timeline/Files and the file viewer, and a workflow run's
    Graph. Capture console errors and HTTP ≥ 400 per page. The page CSP is
    `default-src 'self'` (plus the Keys page's provider icons from Google's favicon service), so any violation is a
    finding.

## Subsystems

Each subsystem below names its seam: what it takes from the kernel and what it gives back, as types or routes, by name
only. It gives an "alone" recipe that runs it end to end with the others faked, and 3 to 6 checks a QA pass runs when
it changed. They are light and continuous: run a subsystem's checks when its code changed, not on every PR. Each lane
edits only its own subsection.

### Kernel (runs, journal, cap, harness adapters)

Code: the runner (`packages/serve/src/runner/`: its claim and renewal, `dispatch.ts`, the adapter, workflow and learning
loops, the journal and the end of a run), the one store (`packages/serve/src/store/`: the run's row, its claim fence, its
command rows and its journal tables), the run's write half (`runs-over-store.ts`) and read half (`run-view.ts`,
`store-reads/`), `packages/serve/src/{harness,cap}.ts`, and `packages/run-adapters`,
`packages/run-adapters-claude-agent` and `packages/run-adapters-codex`. Rows 8 to 13 of the core catalog are its checks on a live model; the checks below are the
same ground with no key.

**Seam.**

| | Names on main |
| --- | --- |
| Serves | `POST /v2/agents/{id}/runs` (`input`, `revision`, `effort`, `max_cost_usd`), `GET /v2/runs`, `GET /v2/runs/{id}`, `GET /v2/runs/{id}/timeline` (pages or SSE), `POST /v2/runs/{id}/{messages,stop,cancel,pause,resume}`, `GET /v2/runs/{id}/graph`, `GET /v2/usage`, and `harnesses[]` in `GET /v2/capabilities` |
| Run fields others read | `status`, `state`, `result.final_answer`, `error.code` (`spend_cap_reached`, `moderated`, `run_failed`, `escalated`), `cost.usd` (`null` when unknown) |
| Journal | In the run's rows of the store (`pi_entries`, `pi_tasks`, `pi_submissions`), from `@parcha/pi-durable-agent/timeline`: `REQUEST_STARTED` (`heldUsd`, `capRefused`), `REQUEST_ENDED` (`heldUsd`, `unsent`), `REQUEST_COST`, `REQUEST_REFUSED`, `REQUEST_COST_PENDING`, `REQUEST_COST_LATE`, `REQUEST_CONTINUED`. Read through `timelineOf` and `runMetricsOf` |
| Run directory | `DIR/disk/agents/<agent>/runs/<id>/work/`; the run's record is in the store, not its folder. The run's claim is its row in `runs` (`epoch`, `runner`, `claimed_until`), and a message, stop, cancel, raise or approval is a row of `commands` that its runner reads |
| Adapters it calls | `dispatch.ts` reads the run's launch record and picks its loop (`harness-loops.ts` `resolveRunnerLoop`); `adapter-loop.ts` drives an `AgentAdapter` (`check`, `open`) for a `SessionSpec`: pi is `runner/adapters/pi.ts`, the others are `packages/run-adapters-*`. The cap is the loop's `beforeRequest` on the run's model port (`modelPortFor`), the one ledger for every harness; a CLI harness's requests reach it through `startModelProxy` under a `ProviderPolicy` |
| Takes from the tool plane | `TOOLS` (`ToolEntry`, `tools.ts`); a run's session carries `HostTool[]`, each with its `REPLAY` class (`safe` or `never`), which the loop's side-effect rule (`runner/side-effects.ts`) reads before a call |
| Takes from places | The run's Workspace and its computer, both opened at the claim (`workspace/run-workspace.ts`, `workspace/computer-for-claim.ts`), from the revision's `computer` setting (`definition.place` is its API view); see Places below |
| Gives the console | The routes above, and `GET /v2/stats` `analytics`, summed from the `RunMetrics` each run's end writes to its row |
| Gives the learning loop | Not wired into serve yet. The seam is run-adapters' `followUpOnce` (one more turn, held to `reserveUsd`), which learn's `reflectBudget` sizes |

**Alone.** No model key, no tool key, no box and no console. Build as in [How to run](#how-to-run), without the console
lines. Then:

- pi runs alone through the CLI on the tests' faux model. On `faux-output-priced.mjs`, one request's worst case is
  16,384 output tokens at $100 a million: $1.6384.

  ```sh
  Q=$(mktemp -d)
  env -i PATH="$PATH" HOME="$Q" TMPDIR="$Q" node packages/serve/dist/cli.js --data "$Q/data" --port 0 \
    --faux packages/serve/test/fixtures/faux-output-priced.mjs
  ```

  Drive it with the README's quick-start calls; the token is in `$Q/data/.token`. The faux model answers by the message:
  `What is six times seven?` gives `The answer is 42.`, `Take your time.` holds its answer for 60 s, `Answer once <file>
  exists.` gives `Now.` once the file exists, and a follow-up `<message>` to `Take your time.` gives
  `On <message>: done.`.
- claude-agent and codex run alone only inside the tests. `startServe({ harnessTable })` names a test module of harness table
  entries (serve's test/fixtures/faux-table.mjs puts every harness but pi on run-adapters' `fauxAdapter`); the CLI has
  no flag for it, and no environment variable of the server's own turns it on. `claude-run` drives
  the pinned Claude CLI against `fakeAnthropic`, and `codex-run` drives agentrun-harness-codex's app-server stand-in. From
  `packages/serve`:

  ```sh
  node --test --test-reporter=tap test/harness-run.test.mjs test/cap-unknown.test.mjs \
    test/claude-run.test.mjs test/codex-run.test.mjs
  ```

  The checks below name these files without `.test.mjs`.

**Checks.** Each reads `GET /v2/runs/{id}` once the run's timeline says `final: true`, unless it names another route.
The journal is the run's rows of the store's `pi_entries` table.

1. **Each harness answers.** For every entry of `harnesses[]` with `available: true`, a run ends `completed` with
   `result.final_answer` set and `cost.usd` a number. Each paid request is counted once. Alone: pi through the CLI
   (`What is six times seven?`); claude-agent and codex in `harness-run`, `claude-run` and `codex-run`.
2. **The cap refuses before anything is sent.** `max_cost_usd: 1`, below one request's worst case: the run pauses,
   `input_required` and `waiting`, `error` null, `pending.kind: "budget"` (`spent_usd` 0, `needs_usd` the request's
   least), `result: null`, `cost.usd: 0`. The journal's only request mark is `agentrun.request_started` with
   `capRefused: true`, and a higher cap sends it (`PATCH /v2/runs/{id}` `{max_cost_usd}`). Only a refusal no cap
   fixes (a spend nobody knows, no output ceiling, no price) ends `failed`, `spend_cap_reached`. Alone: pi through the
   CLI, `adapter-pi-cap-park`, `cap-raise` and `runner-cap-raise`; claude-agent and codex in `claude-run`, `codex-run` and `cap-raise`.
3. **A stopped request counts at the worst case the cap held.** `Take your time.` at `max_cost_usd: 2`; once it reads
   `working`, `POST /v2/runs/{id}/stop` (`stopped: true`) leaves it `input_required`. A message is a `follow_up`, and
   the cap counts the stopped request at the worst case it held ($1.6384). Its request is limited to what is left of
   the cap; if what is left can't buy that request's least, the run pauses at it (`input_required`,
   `pending.kind: "budget"`, `spent_usd` 1.6384) with nothing more sent. Either way the run never ends `failed` for room.
   At `10` the follow-up completes. `cost.usd` is `null` both ways. Read before `final`, at the first poll that shows the terminal status, it
   can still be the live figure (`0`, or `0.0004` after the follow-up). The stopped request's `agentrun.request_ended`
   mark carries `heldUsd: 1.6384`. Alone: pi through the CLI, and `cap-unknown`. For claude-agent and codex,
   `adapter-pi-cap-raise-crash` covers a runner lost
   with a request out, and run-adapters' `held-worst-case.test.mjs` a request cut short.
4. **Cancel ends the run and nothing more is sent.** `POST /v2/runs/{id}/cancel` on a working run answers `202` with
   `cancel_requested: true`; the run ends `cancelled`, a second cancel says `already_terminal: true`, and a message is
   `409 not_continuable`. A request cut by the cancel leaves `cost.usd` `null`. Alone: `runner-stop-withdraw`,
   which ends a run on a stop or cancel row through the runner and the store, and `adapter-pi-cap-cancel`, a stop or
   cancel of a run parked at its cap.
5. **A crash or a restart resumes the run.** Restart: `Answer once <file> exists.`; once it reads `working`, SIGTERM
   the server's own PID; the runner beside it stops the run where it can resume. Start it again on the same `--data` and
   make the file: the run ends `completed` with `Now.`. Crash: with a runner of its own (core row 12), `kill -KILL` the
   runner named in the run's row (`runs.runner`); once the claim lapses, a runner started again claims the run, which
   completes, each paid request counted once. Alone: `store-resume`, `store-claim-lease`, `runner-close-claim` and
   `runner-process`; `adapter-pi-claim-lost` for a claim lost mid-turn, and `adapter-pi-cap-raise-crash` for a runner lost
   around a raise's follow-up.
6. **A multi-tool turn completes on claude-agent and codex.** Two tool calls in one model response end `completed`,
   each call shown before its result under the answer that asked for it, none interrupted. Its faux-model test was
   deleted at the cutover merge (follow-up #2078). On a live model it is part of row 8.

### Tool plane

What a run's agent can call, on every harness, and the keys those tools use. Later changes extend this section as they
land (native and picked web search and tool settings, monid on every harness, the per-tool permission gate).

**Seam.**
- Takes from the kernel:
  - the run's pinned revision (the tools it names);
  - the run's secrets over its pipe (a tool key only to a run that needs it; Parallel's key on the decision descriptor);
  - pi's tool binding (`TOOLS[name].bind`);
  - the host-tool slot the claude-agent and codex adapters serve (`hostTools`, served over MCP or app-server dynamic
    tools);
  - the journal's replay classes (`REPLAY`: `safe` may run again after a crash, `never` is answered interrupted);
  - the run's `work/` directory.
- Gives back:
  - tool registrations per harness, and one journal entry per call;
  - `GET /v2/capabilities` `tools[]` (`name`, `harnesses`, `missing`);
  - `GET/PUT/DELETE /v2/settings/tool-keys` (keys by name, sealed at rest, never returned);
  - files the tools write under `work/` (`work/evidence/`).

**Alone.** Run the plane with no model and no third party:
- **Tests.** `startServe({ faux, fauxWeb, fauxParallel, fauxMonid })` in `packages/serve/test` replaces the model, the
  resolver and HTTP for fetches, Parallel and monid with `test/fixtures/faux-*.mjs`. The faux harness
  (`faux-harness.mjs`) stands in for claude-agent and codex.
  `node --test packages/serve/test/{web-fetch-direct,web-fetch,host-tools,harness-run,monid,tool-keys,secret-custody}.test.mjs`
  runs the plane end to end that way.
- **On a QA server.** `--faux MODULE` scripts the model's tool calls (see "The faux model" in `packages/serve/README.md`),
  so a run calls `web_fetch`, `read`, `write` and `edit` with no model key.
  `web_fetch` then reads real public pages; nothing else leaves the box.

**Checks when the tool plane changed.**
1. Every name in `GET /v2/settings/tool-keys` `unlocks` is a tool `GET /v2/capabilities` binds, on the harnesses it lists,
   and `missing` names the key each tool still needs.
2. `web_fetch` refuses loopback,
   private, link-local and metadata addresses and ports other than 80/443, at the first hop and after a redirect; a
   refused URL is never sent to Parallel.
3. A tool key reaches only a run that names a tool it unlocks, over the pipe, never in any process's environment; a saved
   key exists on disk only sealed (no plaintext under the data directory).
4. On claude-agent and codex, the host tools (`read`, `write`, `edit`, `web_fetch`, and
   `web_search` where it is not the harness's own) run and are journaled with their replay class; a `write` cut off by a
   crash comes back interrupted, never re-run.
5. A `monid.run` is sent once and never retried; a wallet refusal (402) or a workspace control (`BLOCKED`) comes back
   by name; an answer over 60,000 characters is filed under `work/evidence/monid/`.
6. On pi with no native search, `web_search` searches through Parallel where the server holds a Parallel key (its fee a
   `Tool cost` line), else Exa's keyless endpoint with no key: only `{query, numResults}` leaves the server, over IPv4;
   past Exa's free limit it is tried once more, then a tool error in our words (`Free web search is rate-limited right
   now…`), never Exa's fix text and never a hang.

### Places (computers, workspace, files)

Code: `packages/serve/src/workspace/` (the Workspace and where a run's tools run), `packages/serve/src/computers.ts`,
`computer-setting.ts`, `computer-routes.ts` and `faux-computers.ts`, and `packages/computer` (the computer protocol, its
daemon and its providers).

**Seam.** It takes the agent's `computer` setting (`{kind, provider?}` on the revision, `computer-setting.ts`) and the
run's claim from the kernel. It gives back:

- The Workspace (`workspace/workspace.ts`): one root folder, paths relative to it only (`workspace/paths.ts`). Two
  backends: the local folder (`local.ts`, Mode 1: `<data>/disk/agents/<agent>/runs/<id>/work`) and the owner's Archil disk
  (`archil.ts`, Mode 2). `openRunWorkspace` (`run-workspace.ts`) opens a run's at its claim.
- The run's computer at the claim (`computerForClaim` in `workspace/computer-for-claim.ts`): the setting is resolved in the
  server's mode against the computer package's kind registry (`resolve-computer.ts`), started for the run under its
  claim (labels `agentrun.run` and `agentrun.epoch`; the run's folder mounted only where the provider mounts it), and
  released once at the run's end. A computer that cannot be had is refused in words with `computer_unavailable`; kind
  `none` is no computer. Providers are made from `@parcha/agentrun-computer` with the keys the store holds
  (`workspace/computer-providers.ts`). A desktop or phone has a hold on who drives it, the agent or its owner
  (`workspace/computer-hold.ts`).
- The run's tools on its Workspace (`workspace/run-tools.ts`). The shell is in the computer when there is one (the folder
  at `/workspace`); with none, Archil's serverless exec in Mode 2 (a command runs 295 s at most), and no shell at all in
  Mode 1, where a run has the file tools alone.
- Serve, Settings → Computers (`computers.ts`): `GET /v2/computers`, `PUT /v2/computers/{provider}/keys` (sealed in the
  store; a key set in the environment overrides a saved one) and `POST /v2/computers/{provider}/test`; and Archil's
  (`archil-routes.ts`): `GET`, `PUT` and `DELETE /v2/workspace/archil` and `POST /v2/workspace/archil/test`. `GET
  /v2/capabilities` answers `computers` and `places`.
- Serve, an agent's place (`place.ts`, `computer-setting.ts`): `definition.place` is `{mode: "runner"}` or
  `{mode: "sandbox", box}`, the API view of the computer setting (`runner` is kind `none`, `sandbox` a sandbox on that
  provider; a desktop, phone or browser reads `runner`). A setting this server cannot serve saves with a warning at
  `definition.place`, and its run is `409 agent_not_runnable` in the same words.
- Serve, a run's files: `GET /v2/runs/{id}/files` and `GET /v2/runs/{id}/files/{path}`; and what a run is told of them
  (`packages/serve/src/run-manifest.ts`): `firstMessage` adds one line to an agentic run's first message, `Files for this
  run: "inputs/<path>" (<size>), ...`, each name quoted, at most `MANIFEST_ENTRIES` (20), from the run's `work/inputs/`,
  as `runner/adapter-run-spec.ts` and `runner/cli-run-spec.ts` send it, on every harness.
- Serve, a run's computer as the run shows it (`computer-view.ts`: `GET /v2/runs/{id}/computer`, who drives now), read from
  the store through `computerViewOf` (`computer-routes.ts`), which also holds the owner's take-over and hand-back routes.

**Alone.** Computers are faked: `--faux` swaps in three faux providers (`faux-computers.ts`: `faux-sandbox`,
`faux-broken` and a faux desktop), and the workspace tests use a fake computer (`test/workspace-fake-computer.mjs`). Put
a `docker` that exits 1 first on `PATH`, even where Docker is installed, so nothing reaches a daemon by accident:

```sh
mkdir -p "$TMPDIR/qa-bin" && printf '#!/bin/sh\nexit 1\n' > "$TMPDIR/qa-bin/docker" && chmod +x "$TMPDIR/qa-bin/docker"
export PATH="$TMPDIR/qa-bin:$PATH"
npm ci --ignore-scripts
npm run build
(cd packages/serve && node --test test/workspace-local.test.mjs test/workspace-run-tools.test.mjs \
  test/workspace-resolve-computer.test.mjs test/workspace-computer-for-claim.test.mjs test/computers.test.mjs \
  test/computers-route.test.mjs test/faux-computers.test.mjs test/computer-setting.test.mjs test/place.test.mjs \
  test/files.test.mjs test/run-manifest.test.mjs)
npm test -w @parcha/agentrun-computer
```

The Docker variant runs only where Docker exists, as CI's `computer-docker` job does: `npm run test:docker -w
@parcha/agentrun-computer`. The other providers' suites need that vendor's key; never set one, or a real `docker` on
`PATH`, for a server under test.

**Checks when it changed.**

1. **Place and computer setting**: `place.test.mjs` and `computer-setting.test.mjs` pass. Each wrong shape is a 422 at
   `definition.place`, and nothing is saved; a setting this server cannot serve saves with a warning, and its run is 409
   `agent_not_runnable` in the same words; an edit with no place keeps the agent's; a place and a computer that disagree
   are refused.
2. **Computers and keys**: `computers.test.mjs` and `computers-route.test.mjs` pass. A kind no provider can serve here is
   not offered, and says why; a key save takes only the names the provider declares, seals each, and answers names and
   saved flags, never a value; a provider's test reads its account once and fails in plain words with no key in them.
3. **The claim's computer**: `workspace-resolve-computer` and `workspace-computer-for-claim` pass. No setting is the
   server's default; a provider whose required keys are not saved is refused at the claim, naming the keys and Settings →
   Computers; a Mode 1 sandbox on Docker is made under the run's labels with its folder mounted, and released once; a
   desktop's view closes `released` or `ended`.
4. **Run tools**: `workspace-run-tools` passes. With no computer in Mode 1 a run has no shell, and `read` refuses a file
   of the server's outside the folder; with none in Mode 2 a command runs 295 s at most; with a computer, `bash` and `read`
   go through it with none of the server's environment.
5. **Run files**: `files.test.mjs` never lists or serves a dotfile or a symlink, and refuses `..` with the contract's
   codes.
6. **Run files told**: `run-manifest.test.mjs` passes. A run given `notes.txt` is sent "Summarize the attached file."
   plus `Files for this run: "inputs/notes.txt" (<n> B).`, reads it and answers with its text; on claude-agent and codex
   the first `user_message` names both files with their sizes; a run given none is sent its `content` unchanged; a name
   with `", ` or an RTL override stays inside its quotes, escaped; a link at `work/inputs` lists nothing.

### Console, import and analytics

**Seam.** Takes the `/v2` routes the console reads: `/agents`, an agent's `/revisions` and `/runs`, `/runs` and a
run's `/timeline`, `/graph` and `/files`, `/stats` with its `analytics` block, `/usage`, `/capabilities` and
`/settings/tool-keys`. Also the agent store's `run_metrics` and `run_tool_metrics`, which `/stats` sums. Gives back
`/v2` writes only: create, revise and archive an agent; start a run, message it, stop, cancel or archive it. `import`
gives the store its runs through `AgentStore.importRun`, each with its `run_metrics`.

**Alone.** Each runs with no model key and no network. From a checkout built as in [How to run](#how-to-run), with
fresh directories:

```sh
export QA_HOME=$(mktemp -d) QA_DATA=$(mktemp -d)
# A fixture home: synthetic Claude Code, Codex and pi sessions, the importer's own test fixtures.
node --input-type=module -e '
  import { mkdirSync } from "node:fs";
  import { claudeSession, codexSession, piSession } from "./packages/serve/test/fixtures/import-sessions.mjs";
  const home = process.env.QA_HOME, project = `${home}/code/site`;
  mkdirSync(project, { recursive: true });
  claudeSession(home, project, 1); codexSession(home, project, 2); piSession(home, project, 3);'
```

1. The console against a seeded store, on the faux model:

   ```sh
   HOME="$QA_HOME" node packages/serve/dist/cli.js import --all --data "$QA_DATA"
   XDG_CONFIG_HOME="$QA_HOME/.config" packages/serve/launcher/agentrun-serve --data "$QA_DATA" --port 0 \
     --faux packages/serve/test/fixtures/faux-model.mjs
   ```

   Open the console at `/` on the address the banner prints. The imported project is one agent with its three runs.
2. The console's own suite, on recorded fixtures: `(cd apps/console && npm ci && npm test)`.
3. Import alone: `HOME="$QA_HOME" node packages/serve/dist/cli.js import --dry-run --all --data "$QA_DATA"` prints what
   it would import (1 project, 3 sessions) and writes nothing.

`--all` because the fixture's project is in a temp directory, which import skips otherwise.

**Checks.**

1. The console loads at `/` and signs in: setup, then the password. With `AGENTRUN_ACCOUNTS=0` the printed
   link signs the browser in and the token leaves the address.
2. An agent is created from New agent with its defaults, and a run is started from its page. Once the workflow
   starter is on main (#1315), a workflow agent is created from it too.
3. One run on a priced faux model (`packages/serve/test/fixtures/faux-priced.mjs`): its timeline's usage row, its
   stored `cost.usd` and `/v2/stats` agree, with nothing counted twice.
4. Mission Control shows the same totals as `/v2/stats` for a date range (`?from=&to=`). So does the agent page's
   Analytics tab, once it is on main (#1354).
5. An import's dry run counts what the import then stores, and a second import adds nothing.
6. Settings → Tool keys never shows a value.

### Learning loop

_Written by the lane that owns this subsystem._

## Model and key caveats

- Run smokes on the cheapest capable model your gateway offers, and a stronger one only when a case needs it. Send
  all model traffic through your gateway.
- The claude-agent adapter maps the CLI's Haiku slot to the session model (`ANTHROPIC_DEFAULT_HAIKU_MODEL = model`),
  so no Haiku traffic leaves a claude-agent run.
- Spend-cap worst case is the request's input bound at the dearer of the model's input and cache-write prices, plus its
  whole output ceiling at its output price. That is a cent or two for one request to a small model at low effort, and
  can be more than a dollar for one request to a model with a large output ceiling, so a cap under that refuses the
  first request. A model with no price under a cap is refused outright.
- A run cut by a crash, a drain or a stop reads `cost.usd: null` from then on. Mission Control shows those runs as
  "N runs unknown". That is documented behaviour, not a QA failure.
- At these task sizes a periodic pass costs cents on small models.

## Host caveats

- Bind to loopback on a free port. The catalog needs no Docker, cloud previews or deploys.
- Kill only PIDs you started (the server, or a run's `holder.pid` after checking its ppid and cmdline). Never
  `pkill -f`.
- A fresh checkout or worktree per pass, never one in use for other work. Do not run the full test suites (CI is the
  suite of record).
- Keys by name only. The launcher's first start prints the token into the server's stdout, so redact
  `ar_local_…` from any log copied into evidence.

## Known open findings (2026-11-01; re-check each pass, do not suppress)

- Fixed by #1363, re-check with kernel check 6: claude-agent and codex runs hung in `working` when the model made two
  or more tool calls in one turn (4/4 reproductions). pi was unaffected.
- Fixed by #1357, re-check with console check 2: the console's New agent with default tools was refused with 422,
  because `pdf_pages` and `llm` (call-only tools) were ticked by default.
- Fixed by #1356, re-check with tool plane check 1: tool keys listed `web_search` and the `monid.*` tools as unlocked,
  but no such tool was bound. Fixed for `web_search` by its binding as well: it is bound on every harness now, and the
  Parallel key lists it again as a tool it unlocks.
- Not in the server yet: effort packs and output types, native web search, places and boxes, the kernel learning loop,
  and `output`/`place` on the run request.
