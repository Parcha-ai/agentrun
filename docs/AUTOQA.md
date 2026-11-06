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

Node 22.19 or later on 22 (`.nvmrc` pins 22.23.2), or 24.2 or later. Node 23 and 24.0 to 24.1 are refused. npm 11
is the documented toolchain, but `npm ci` also works with npm 10.9 (the npm bundled with Node 22.23.2).

```sh
npm ci --ignore-scripts
npm run build   # the console first (apps/console, skipped when its dist is current), then every package
```

Start it with the launcher, which hands secrets to the server over a pipe:
`packages/serve/launcher/agentrun-serve --data DIR --port N [--drain-timeout 8s]`, on its default loopback listen
address.
`node packages/serve/dist/cli.js` also works, but then the secrets stay in the environment.

The banner prints `AGENTRUN_BASE_URL`, then the token (on the first start only), then `Open <url>/` and
`Set your password: <url>/setup`. Wait for the `Open` line. The token is also in `DIR/.token` (mode 0600). Read it from
there and never print it.

| Env | Why |
| --- | --- |
| `TMPDIR`, `--data` | Use a fresh data dir and a temp dir of its own per run, so no earlier run's state is read. |
| `XDG_CONFIG_HOME` | The launcher writes `agentrun/seal.key` there. Point it at a QA dir so your own config directory is never touched. |
| `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_API_KEY`, `AGENT_MODEL` | Gateway for the pi and codex harnesses (OpenAI Responses). Point them at your gateway (its `/v1` base URL) and set `AGENT_MODEL` to a small, cheap model for smokes. |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | The claude-agent harness only, on Anthropic Messages. Your gateway may serve `/v1/messages` too. |
| `AGENTRUN_MAX_RUNS` | Cap concurrent runs (3 is plenty for QA). |
| `PARALLEL_API_KEY`, `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`, `TYPESAFE_API_KEY` | Optional. They unlock web_fetch via Parallel, the `browser` tool, and Jev decisions. Without a key, only the checks that need it are UNTESTED: web_fetch's direct fetch and its private-host refusal need none and always run. |

Stop the server with SIGTERM to its exact PID. A busy run gets the drain timeout, then resumes at the next start.

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
12. **Kernel durability, process crash**: during a multi-step run, take `holder.pid` from
    `DIR/disk/agents/<agent>/runs/<id>/run.json`. Check that its ppid is the server and its cmdline names the run dir, then `kill -KILL`
    that exact PID. Pass: the server log says `its process went before the run ended; opening it again (1 of 3)`,
    `run.json.generation` goes to 2, the run completes, and the timeline holds exactly one write per file.
13. **Kernel durability, server restart**: SIGTERM the server mid-run; `run.json.status` reads `sleeping`. Restart on
    the same data dir. Pass: the run resumes and completes with no duplicate writes. The prompt must say "do not
    reply or stop until …", or the model may end its turn with a progress note before the signal and the case proves
    nothing.
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
    `default-src 'self'`, so any violation is a finding.

## Subsystems

Each subsystem below names its seam: what it takes from the kernel and what it gives back, as types or routes, by name
only. It gives an "alone" recipe that runs it end to end with the others faked, and 3 to 6 checks a QA pass runs when
it changed. They are light and continuous: run a subsystem's checks when its code changed, not on every PR. Each lane
edits only its own subsection.

### Kernel (runs, journal, cap, harness adapters)

Code: `packages/serve/src/{runs,app,harness-app,harness,adapters,cap,request-start}.ts`, `packages/run-adapters`,
`packages/run-adapters-claude-agent`, `packages/run-adapters-codex`, `packages/pi-durable-disk`, and the timeline of
`packages/pi-durable-agent`. Rows 8 to 13 of the core catalog are its checks on a live model; the checks below are the
same ground with no key.

**Seam.**

| | Names on main |
| --- | --- |
| Serves | `POST /v2/agents/{id}/runs` (`input`, `revision`, `effort`, `max_cost_usd`), `GET /v2/runs`, `GET /v2/runs/{id}`, `GET /v2/runs/{id}/timeline` (pages or SSE), `POST /v2/runs/{id}/{messages,stop,cancel,pause,resume}`, `GET /v2/runs/{id}/graph`, `GET /v2/usage`, and `harnesses[]` in `GET /v2/capabilities` |
| Run fields others read | `status`, `state`, `result.final_answer`, `error.code` (`spend_cap_reached`, `moderated`, `run_failed`, `escalated`), `cost.usd` (`null` when unknown) |
| Journal | In the run's store, from `@parcha/pi-durable-agent/timeline`: `REQUEST_STARTED` (`heldUsd`, `capRefused`), `REQUEST_ENDED` (`heldUsd`, `unsent`), `REQUEST_COST`, `REQUEST_REFUSED`, `REQUEST_COST_PENDING`, `REQUEST_COST_LATE`, `REQUEST_CONTINUED`. Read through `timelineOf` and `runMetricsOf` |
| Run directory | `DIR/disk/agents/<agent>/runs/<id>/`: `run.json` (`status`, `holder.pid`, `generation`), `serve.json`, `store/run.sqlite`, `work/`, `process.log` |
| Adapters it calls | `adapterFor(harness, env, needs: AdapterNeeds)` gives an `AgentAdapter` (`check`, `open`) for a `SessionSpec`, driven by `createHarnessRunner`. There the cap is the runner's `beforeRequest`, asked by `startModelProxy` under a `ProviderPolicy`; on pi it wraps the models (`capModels`) |
| Takes from the tool plane | `TOOLS` (`ToolEntry`), bound on pi as a `ToolBinding`; `hostTools()` gives claude-agent and codex `HostTool[]`, each with its `REPLAY` (`safe` or `never`) |
| Takes from places | The revision's `definition.place`: `runner` (the default: a local process under `confinePrefix()`) or `sandbox` with a `box`. A sandbox run on a box this server lacks is `409 agent_not_runnable` naming it (`boxAvailability`); `places` in capabilities lists the boxes, none available yet. `startServe({ box })` takes a `BoxHost` that sweeps the boxes runs left (the run's `box.json`) |
| Gives the console | The routes above, and `GET /v2/stats` `analytics`, summed from the `RunMetrics` each run's `carryBack` stores |
| Gives the learning loop | Not wired into serve yet. The seam is run-adapters' `followUpOnce` (one more turn, held to `reserveUsd`), which learn's `reflectBudget` sizes |

**Alone.** No model key, no tool key, no box and no console. Build as in [How to run](#how-to-run), without the console
lines. Then:

- pi runs alone through the CLI on the tests' faux model. On `faux-output-priced.mjs`, one request's worst case is
  16,384 output tokens at $100 a million: $1.6384.

  ```sh
  Q=$(mktemp -d)
  env -i PATH="$PATH" HOME="$Q" TMPDIR="$Q" node packages/serve/dist/cli.js --data "$Q/data" --port 0 \
    --drain-timeout 2s --faux packages/serve/test/fixtures/faux-output-priced.mjs
  ```

  Drive it with the README's quick-start calls; the token is in `$Q/data/.token`. The faux model answers by the message:
  `What is six times seven?` gives `The answer is 42.`, `Take your time.` holds its answer for 60 s, `Answer once <file>
  exists.` gives `Now.` once the file exists, and a follow-up `<message>` to `Take your time.` gives
  `On <message>: done.`.
- claude-agent and codex run alone only inside the tests. `startServe({ fauxHarness })` puts every harness but pi on
  run-adapters' `fauxAdapter`; the CLI has no flag for it, and no environment variable turns it on. `claude-run` drives
  the pinned Claude CLI against `fakeAnthropic`, and `codex-run` drives agentrun-harness-codex's app-server stand-in. From
  `packages/serve`:

  ```sh
  node --test --test-reporter=tap test/runs.test.mjs test/harness-run.test.mjs test/cap-unknown.test.mjs \
    test/harness-cap.test.mjs test/claude-run.test.mjs test/codex-run.test.mjs test/recovery.test.mjs
  ```

  The checks below name these files without `.test.mjs`.

**Checks.** Each reads `GET /v2/runs/{id}` once the run's timeline says `final: true`, unless it names another route.
The journal is the `entries` table of the run's `store/run.sqlite`.

1. **Each harness answers.** For every entry of `harnesses[]` with `available: true`, a run ends `completed` with
   `result.final_answer` set and `cost.usd` a number. Each paid request is counted once. Alone: pi through the CLI
   (`What is six times seven?`); claude-agent and codex in `harness-run`, `claude-run` and `codex-run`.
2. **The cap refuses before anything is sent.** `max_cost_usd: 1`, below one request's worst case: the run pauses,
   `input_required` and `waiting`, `error` null, `pending.kind: "budget"` (`spent_usd` 0, `needs_usd` the request's
   least), `result: null`, `cost.usd: 0`. The journal's only request mark is `agentrun.request_started` with
   `capRefused: true`, and a higher cap sends it (`PATCH /v2/runs/{id}` `{max_cost_usd}`). Only a refusal no cap
   fixes (a spend nobody knows, no output ceiling, no price) ends `failed`, `spend_cap_reached`. Alone: pi through the
   CLI, `cap-pause` and `cap-raise`; claude-agent and codex in `claude-run`, `codex-run` and `cap-raise`.
3. **A stopped request counts at the worst case the cap held.** `Take your time.` at `max_cost_usd: 2`; once it reads
   `working`, `POST /v2/runs/{id}/stop` (`stopped: true`) leaves it `input_required`. A message is a `follow_up`, and
   the cap counts the stopped request at the worst case it held ($1.6384). Its request is limited to what is left of
   the cap; if what is left can't buy that request's least, the run pauses at it (`input_required`,
   `pending.kind: "budget"`, `spent_usd` 1.6384) with nothing more sent. Either way the run never ends `failed` for room.
   At `10` the follow-up completes. `cost.usd` is `null` both ways. Read before `final`, at the first poll that shows the terminal status, it
   can still be the live figure (`0`, or `0.0004` after the follow-up). The stopped request's `agentrun.request_ended`
   mark carries `heldUsd: 1.6384`. Alone: pi through the CLI, and `cap-unknown`. For claude-agent and codex,
   `harness-cap` covers a crash mid-request and run-adapters' `held-worst-case.test.mjs` a request cut short; no test
   stops one through serve.
4. **Cancel ends the run and nothing more is sent.** `POST /v2/runs/{id}/cancel` on a working run answers `202` with
   `cancel_requested: true`; the run ends `cancelled`, a second cancel says `already_terminal: true`, and a message is
   `409 not_continuable`. A request cut by the cancel leaves `cost.usd` `null`. Alone: `runs` (pi, on
   `Take your time.`) and `harness-run` (codex, cancelled while a request is out).
5. **A crash or a restart resumes the run.** Restart: `Answer once <file> exists.`; once it reads `working`, SIGTERM
   the server's own PID. It exits within `--drain-timeout` plus 3 s, the run's `holder.pid` exits with it, and
   `run.json` reads `sleeping`. Start it again on the same `--data` and make the file: the run ends `completed` with
   `Now.`. Crash: `kill -KILL` the run's `holder.pid`; the run opens again and completes, each paid request counted
   once. Alone: the restart on pi through the CLI, and `recovery`; the crash in `harness-run` and `claude-run`, and in
   `codex-run`, which checks that no Codex process is left behind.
6. **A multi-tool turn completes on claude-agent and codex.** Two tool calls in one model response end `completed`,
   each call shown before its result under the answer that asked for it, none interrupted. Alone:
   `node --test test/harness-multi-tool.test.mjs` from `packages/serve`. On a live model it is part of row 8.

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
  `node --test packages/serve/test/{fetch-page,web-fetch,host-tools,harness-run,monid,tool-keys,secret-custody}.test.mjs`
  runs the plane end to end that way.
- **On a QA server.** `--faux MODULE` scripts the model's tool calls (see "The faux model" in `packages/serve/README.md`),
  so a run calls `web_fetch` (or `fetch_page`, its legacy name), `read`, `write` and `edit` with no model key.
  `web_fetch` then reads real public pages; nothing else leaves the box.

**Checks when the tool plane changed.**
1. Every name in `GET /v2/settings/tool-keys` `unlocks` is a tool `GET /v2/capabilities` binds, on the harnesses it lists,
   and `missing` names the key each tool still needs.
2. `web_fetch`, under either name (`fetch_page` is its legacy one, no longer a tool of its own), refuses loopback,
   private, link-local and metadata addresses and ports other than 80/443, at the first hop and after a redirect; a
   refused URL is never sent to Parallel.
3. A tool key reaches only a run that names a tool it unlocks, over the pipe, never in any process's environment; a saved
   key exists on disk only sealed (no plaintext under the data directory).
4. On claude-agent and codex, the host tools (`read`, `write`, `edit`, `web_fetch`, also as `fetch_page`, and
   `web_search` where it is not the harness's own) run and are journaled with their replay class; a `write` cut off by a
   crash comes back interrupted, never re-run.
5. A `monid.run` is sent once and never retried; a wallet refusal (402) or a workspace control (`BLOCKED`) comes back
   by name; an answer over 60,000 characters is filed under `work/evidence/monid/`.
6. On pi with no native search, `web_search` searches through Parallel where the server holds a Parallel key (its fee a
   `Tool cost` line), else Exa's keyless endpoint with no key: only `{query, numResults}` leaves the server, over IPv4;
   past Exa's free limit it is tried once more, then a tool error in our words (`Free web search is rate-limited right
   now…`), never Exa's fix text and never a hang.

### Places (boxes, home, files)

**Seam.** It takes a run's `BoxSpec` from the kernel (`workspace`, `env`, `network`, `mounts`) and the run directory
the run's files go to. It gives back:

- `Box` and `BoxProvider` from `@parcha/pi-transport`. Only a provider whose `BoxProvider.mounts` is true binds
  `mounts` (Docker, as bind mounts); every other provider refuses a spec with any as `unsupported`.
- `@parcha/pi-transport/sync`: the safe extractor (`extractTar`, `openExtractor`, `removeEntries`) and the sync layer
  (`seedDir`/`pullDir`, `seedAgentHome`/`pullAgentHome`, `HOST_OWNED_HOME`), each answering with a receipt.
- Not in the seam: `@parcha/pi-transport/home` (its checkpoint vault and store checks included), `./launch` and
  `./place`. Serve imports none of them; they are deprecated and removed in 0.1.0-beta.31.
- Internal to pi-transport: `bwrapArgs`, `bwrapFiles` and `probeBwrap` (`src/box/bwrap-args.ts`).
- `@parcha/pi-transport/testing`: `registerBoxConformance`, and fake providers for each box (`fakeBoxes` and the
  provider-shaped fakes).
- Serve, what a run is told of its files (`packages/serve/src/run-manifest.ts`): `firstMessage` adds one line to an
  agentic run's first message, `Files for this run: "inputs/<path>" (<size>), ...`, each name quoted, at most `MANIFEST_ENTRIES` (20), from
  the run's `work/inputs/` as `runs.ts` sends it to the door, on every harness.
- Serve: `GET /v2/runs/{id}/files` and `GET /v2/runs/{id}/files/{path}`, and the sweep before any run starts
  (`sweepBoxes`, `settleBox`, `Quarantine` in `packages/serve/src/box/sweep.ts`).
- Serve, an agent's place (`packages/serve/src/place.ts`): `definition.place` is `{mode: "runner"}` or
  `{mode: "sandbox", box}`, checked by `placeIssues`; `GET /v2/capabilities` answers `places` (`placesOf`). A sandbox
  place saves with a warning at `definition.place`, and its run is 409 `agent_not_runnable` with `details.box`.
- Serve, the box registry (`packages/serve/src/boxes.ts`): `AGENTRUN_BOXES` lists the boxes to probe once at start
  (`boxRegistry`); not set at all, it is `docker` (`DEFAULT_BOXES`), and empty or `none` is no box; and the start log's `event=boxes` line says which are available and why the others aren't. Box
  keys (`BOX_KEYS`) stay with the server. The registry feeds `places` (`boxAvailability`): `docker` and `daytona` are
  available when they are, and every other box says runs in it are not available yet.
- Serve, a run's place and its box: a run takes its revision's place or the default (`resolvePlace`), and the run keeps
  its resolved `place` (its `serve.json`, `GET /v2/runs/{id}`). In the run's process, `codingSource(place, box?)`
  (`packages/serve/src/coding-tools.ts`) is the boxed coding source: on the runner pi's `read`, `write` and `edit`; in a
  box those and `bash`, each call on pi-transport's `boxEnv` over the run's box. pi's tool table and the other
  harnesses' `hostTools` both take it, and the tool plane's permission gate wraps it. `agentWorkDir(runDir, place)`
  (`place.ts`) is the run's `work/` as its tools see it: `<runDir>/work` on the runner, `/run/agentrun/run/work` in a
  box. The box's lifecycle and mounts are `packages/serve/src/run-box.ts` (`runBox`, `boxMounts`, `mountSource`,
  `destroyRunBoxes`, `sweepRunBoxes`), labelled `agentrun.run=<id>`; pi-transport's `endLeftCommands` kills what a
  crashed run's process left running.
- Serve, a Daytona place (`{mode: "sandbox", box: "daytona"}`): the server makes, seeds, pulls and destroys the run's
  sandbox with its own key (`ensureRemoteBox`, `pullRemoteBox` in `run-box.ts`; `remotePlace` in `place.ts`), the network
  blocked (`networkBlockAll`). The run's process reaches it only through the box relay (`packages/serve/src/box-relay.ts`,
  its address in `<data>/.box-relay`), which takes a run's call only with that run's own door token, follows no redirect,
  and sends on with the key only a read of the run's own
  sandbox and its toolbox's programs and files. `work/` is copied in at the sandbox's making and back at each turn's end
  (a read of the run's files waits for that copy) and before the run's end is recorded; the mark is `box-sync.json`
  beside the run. Tests: `test/daytona-boxes.test.mjs` on `test/fixtures/fake-daytona.mjs`, a loopback Daytona.

Not on main yet: runs in a box other than Docker and Daytona, a files API for the agent's home, and uploads. Each one
extends this section when it lands.

**Alone.** Everything else is faked: boxes by fake providers, the model by the faux model. Put a `docker` that exits
1 first on `PATH`, even where Docker is installed, so nothing reaches a daemon by accident:

```sh
mkdir -p "$TMPDIR/qa-bin" && printf '#!/bin/sh\nexit 1\n' > "$TMPDIR/qa-bin/docker" && chmod +x "$TMPDIR/qa-bin/docker"
export PATH="$TMPDIR/qa-bin:$PATH"
npm ci --ignore-scripts

# pi-transport: vitest on source, no build
npm test -w @parcha/pi-transport -- box- fake-boxes   # every box on fakes, Docker's argv without a daemon, bwrap
npm test -w @parcha/pi-transport -- sync-extract sync-run-files               # hostile archives and boxes

# serve: node:test over dist, on the faux model
npm run build
(cd packages/serve && node --test test/place.test.mjs test/boxes.test.mjs test/files.test.mjs \
  test/box-sweep.test.mjs test/box-record.test.mjs test/boxed-tools.test.mjs test/run-box.test.mjs \
  test/coding-tools.test.mjs test/host-tools.test.mjs test/run-manifest.test.mjs)
```

`boxed-tools.test.mjs` runs sandbox runs on a faux box (pi-transport's local box, `startServe({ fauxBox })`), and
`run-box.test.mjs` puts its own fake `docker` first on `PATH`, which runs a box's commands on the host.

The Docker variant runs only where Docker exists, as CI's `transport-docker` job does:
`docker pull debian:bookworm-slim && npm run test:live:docker -w @parcha/pi-transport`, then serve's
`AGENTRUN_SERVE_LIVE_DOCKER=1 node --test test/boxed-tools.docker.test.mjs` (advisory there). Each `.live` file the `box-`
filter picks up skips itself without its `PI_TRANSPORT_LIVE_*` variable, so the commands above start no real box.
`boxes.test.mjs` puts its own fake `docker` first on `PATH` and answers Daytona from a loopback fake; never set a box key
or a real `docker` on `PATH` for a server under test.

**Checks when it changed.**

1. **Places**: `place.test.mjs` passes. Each wrong shape is a 422 at `definition.place` and nothing is saved; a sandbox
   place saves with a warning naming its box, and its run is 409 `agent_not_runnable` with that box; an edit with no
   place keeps the agent's.
2. **Box registry and keys**: `boxes.test.mjs` passes. A name in `AGENTRUN_BOXES` that is no box refuses the start;
   each probe is bounded; no key's value is in an offer, a reason or the log; a box key set in the server's environment
   reaches no run's process.
3. **Hostile archives and home pulls**: `sync-extract`, `home-vault` and `sync-run-files` pass. Nothing is written
   outside the destination, no link, device or fifo is created, a setuid mode is capped, a pull never reverts a file the
   host changed (`host_changed`), and `learning/` is never written back.
4. **Box-made stores**: `home-untrusted-store` passes on Node 22 and on Node 24. A store with a trigger, a view, an
   `ATTACH` or a hot journal is refused, and nothing in it runs.
5. **Box arguments and mounts**: `box-bwrap-args` matches its golden vectors and refuses a workspace with a link in it;
   `box-bwrap-probe` refuses a setuid or too-old `bwrap`; `box-docker.test` refuses a missing source, a relative path,
   a `..` segment, a target of `/` and a repeated target before `docker run`; `box-local` refuses any mount.
6. **Run files and the sweep**: `files.test.mjs` never lists or serves a dotfile or a symlink, and refuses `..` with the
   contract's codes; `box-sweep.test.mjs` reaps a box whose writer is gone and quarantines one it cannot empty.
7. **Boxed tools**: `boxed-tools.test.mjs` and `run-box.test.mjs` pass. A sandbox run's `bash` `printf hi > out.txt`
   shows in `GET /v2/runs/{id}/files` on pi, claude-agent and codex; the box's environment is `LANG`, `HOME=/tmp` and
   its `PATH`, with no key or token; every `docker run` has `--network none`, `--user` the server's uid:gid, one
   `--mount` of `work/` at `/run/agentrun/run/work` and only `NAME=value` envs; a run request naming `place` is a 422 and
   makes no run; a runner agent naming `bash` and a sandbox workflow are 422; a link at a run's `work/` is refused
   and nothing is bound; the box is destroyed at completion, cancel and archive, adopted by its label after a crash
   (the left command killed), and swept at start once its run has ended.
8. **Run files told**: `run-manifest.test.mjs` passes. A run given `notes.txt` is sent "Summarize the attached file."
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
