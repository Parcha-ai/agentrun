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
npm run build
(cd apps/console && npm ci && npm run build)   # the console; the serve build copies it into dist/console
npm run build -w @parcha/agentrun-serve         # rebuild serve after the console so dist/console exists
```

Start it with the launcher, which hands secrets to the server over a pipe:
`packages/serve/launcher/agentrun-serve --data DIR --port N --listen 127.0.0.1 [--drain-timeout 8s]`.
`node packages/serve/dist/cli.js` also works, but then the secrets stay in the environment.

The banner prints `AGENTRUN_BASE_URL`, then the token (on the first start only), then `Open <url>/` and
`Set your password: <url>/setup`. Wait for the `Open` line. The token is also in `DIR/.token` (mode 0600). Read it from
there and never print it.

| Env | Why |
| --- | --- |
| `TMPDIR`, `--data` | Use a fresh data dir and a temp dir of its own per run, so no earlier run's state is read. |
| `XDG_CONFIG_HOME` | The launcher writes `agentrun/seal.key` there. Point it at a QA dir so `~/.config` is never touched. |
| `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_API_KEY`, `AGENT_MODEL` | Gateway for the pi and codex harnesses (OpenAI Responses). Point them at your gateway (`http://127.0.0.1:<port>/v1`, say) and set `AGENT_MODEL` to a small, cheap model for smokes. |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | The claude-agent harness only, on Anthropic Messages. Your gateway may serve `/v1/messages` too. |
| `AGENTRUN_MAX_RUNS` | Cap concurrent runs (3 is plenty for QA). |
| `PARALLEL_API_KEY`, `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`, `TYPESAFE_API_KEY` | Optional. They unlock web_fetch via Parallel, the `browser` tool, and Jev decisions. Without them those rows are UNTESTED. |

Stop the server with SIGTERM to its exact PID. A busy run gets the drain timeout, then resumes at the next start.

## Auth recipe

- API: `Authorization: Bearer $(cat DIR/.token)`. `GET /v2/health`, `GET /v2/capabilities` and `GET /v2/openapi.json`
  need no credential. Anything else without a token is `401 unauthenticated`. A non-loopback `Host` on a loopback
  bind is `403`.
- Console: `/console/` (`/console` redirects with 303). On the first visit, set the owner password (12 characters or
  more; labels `New password` and `Password again`). After that, sign in with the `Password` field. The session is a
  cookie, and the `?token=` link sets none while accounts are on.
- The store page is `/`. On a fresh server `/` redirects to `/setup`.
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
7. **Agent archive**: archive → hidden from `GET /agents`, listed under `?archived=true`. A new run → 409
   `agent_not_runnable`. Then unarchive.
8. **Runs per harness × effort**: `POST /v2/agents/{id}/runs {input:{content}, effort:"low"|"medium"}`. Poll
   `GET /v2/runs/{id}` to a terminal status (cap 300 s). Then check `GET /runs/{id}/timeline` (`final: true`),
   `cost.usd`, `GET /runs/{id}/files` and `GET /runs/{id}/files/<path>`. Use a task that needs two files (two tool
   calls in one turn): see the open findings.
9. **Spend cap**: `max_cost_usd: 0.01` on a small model → `failed`, `error.code: spend_cap_reached`, `result: null`, no
   files.
10. **Cancel**: start a multi-step run, `POST /runs/{id}/cancel` after its first tool_use → `cancelled` within a few
    seconds. Then `POST /runs/{id}/messages {content}` → 409 `not_continuable`. The body takes `content` only.
11. **Follow-up**: `POST /runs/{id}/messages {content}` to a completed agentic run → back to `completed`. The
    timeline's user_message count goes up by exactly one and the original rows stay first.
12. **Kernel durability, process crash**: during a multi-step run, take `holder.pid` from
    `DIR/runs/<id>/run.json`. Check that its ppid is the server and its cmdline names the run dir, then `kill -KILL`
    that exact PID. Pass: the server log says `its process went before the run ended; opening it again (1 of 3)`,
    `run.json.generation` goes to 2, the run completes, and the timeline holds exactly one write per file.
13. **Kernel durability, server restart**: SIGTERM the server mid-run; `run.json.status` reads `sleeping`. Restart on
    the same data dir. Pass: the run resumes and completes with no duplicate writes. The prompt must say "do not
    reply or stop until …", or the model may end its turn with a progress note before the signal and the case proves
    nothing.
14. **web_fetch**: a revision naming `web_fetch`, fetching `https://example.com` → `ok:true` with `via: direct` (or
    `parallel` with the key). `http://127.0.0.1/` and `169.254.169.254` → `refused: … not a public host`.
15. **Workflow run**: create an agent from `packages/dsl/skills/author/examples/review-release-notes.json`, run it on
    its `.input.json` → `completed`, with `result.output.changes` length 2. `GET /runs/{id}/graph` → `totals`.
16. **Stats/analytics**: `GET /v2/stats` → `analytics.{totals,time,by_harness_effort,by_day,by_source,tools}`.
    `?agent=&from=&to=` filters; a malformed `from` → 400. `GET /v2/usage` → `total_usd`, `unpriced_runs`.
17. **Run archive**: `POST /runs/{id}/archive` → gone from `GET /runs`, listed under `?archived=true`, still readable
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
    (`#/runs?status=cancelled`), run detail tabs Report/Timeline/Files and the file viewer, a workflow run's Graph,
    and the store page `/`. Capture console errors and HTTP ≥ 400 per page. The page CSP is
    `default-src 'self'`, so any violation is a finding.

## Model and key caveats

- Run smokes on the cheapest capable model your gateway offers, and a stronger one only when a case needs it. Send
  all model traffic through your gateway.
- The claude-agent adapter maps the CLI's Haiku slot to the session model (`ANTHROPIC_DEFAULT_HAIKU_MODEL = model`),
  so no Haiku traffic leaves a claude-agent run.
- Spend-cap worst case is the model's whole output ceiling at its output price. That is a cent or two for one request
  to a small model at low effort, and can be more than a dollar for one request to a model with a large output
  ceiling, so a cap under that refuses the first request.
- A run cut by a crash, a drain or a stop reads `cost.usd: null` from then on. Mission Control shows those runs as
  "N runs unknown". That is documented behaviour, not a QA failure.
- At these task sizes a periodic pass costs cents on small models.

## Host caveats

- Bind 127.0.0.1 on a free port. The catalog needs no Docker, cloud previews or deploys.
- Kill only PIDs you started (the server, or a run's `holder.pid` after checking its ppid and cmdline). Never
  `pkill -f`.
- A fresh checkout or worktree per pass, never one in use for other work. Do not run the full test suites (CI is the
  suite of record).
- Keys by name only. The launcher's first start prints the token into the server's stdout, so redact
  `ar_local_…` from any log copied into evidence.

## Known open findings (2026-11-01; re-check each pass, do not suppress)

- claude-agent and codex runs hang in `working` when the model makes two or more tool calls in one turn (4/4
  reproductions). pi is unaffected.
- The console's New agent with default tools is refused with 422, because `pdf_pages` and `llm` (call-only tools) are
  ticked by default.
- Tool keys list `web_search` and the `monid.*` tools as unlocked, but no such tool is bound.
- Not in the server yet: effort packs and output types, native web search, places and boxes, the kernel learning loop,
  and `output`/`place` on the run request.
