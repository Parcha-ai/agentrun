<h1 align="center">AgentRun</h1>

<p align="center">
  <b>The open-source managed agent platform.<br>Bring your harness. AgentRun gives it everything else.</b>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#the-life-of-a-request">Life of a request</a> ·
  <a href="packages/serve/README.md">Server docs</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="LICENSE">Apache-2.0</a>
</p>

Pick pi, Claude Code, Codex or OpenCode. Your agent gets the same sandbox, tools, permission gate, spend cap and
self-learning on every one of them. The whole platform is one server and a folder of SQLite files. No Postgres, no queue, no workers.

```sh
npx @parcha/agentrun
```

Or tell your coding agent:

```text
Read agentrun.ai/SKILL.md and set up AgentRun for me
```

## Why AgentRun

- **Superpowers on any harness.** pi, Claude Code, Codex and OpenCode get the same tools, sandbox, gate, spend cap and
  learning. Switching is one field in the agent's definition.
- **A browser that stays signed in.** Sign in once at Browserbase or Kernel, and every later run of that agent starts
  signed in. The cookies stay at the vendor and the model never sees them.
- **A persistent workspace.** Every run keeps its folder, and a follow-up message picks the run up where it stopped.
  Every agent keeps a home across runs with what it learned and its sign-ins.
- **Spend you can see and cap.** A run's `max_cost_usd` is checked before every model request, paid tool call and
  browser minute. At the cap the run pauses until you raise it. A cost nobody can price is refused, never booked as $0.
- **Analytics across every agent and harness.** Mission Control shows what's running and what needs you. `/v2/stats`
  and `/v2/usage` break down runs, tokens, cost and tools by agent, harness, effort and day.
- **Agents that learn.** After each run the agent writes down what it learned. A grader keeps what's worth keeping in
  the agent's own git repo, and the next run starts from it.
- **APIs, MCP, tools.** Shell, files, web search and fetch, a hosted browser and monid's paid data APIs, every call
  through one allow, ask or deny gate. Save remote MCP servers with their credentials sealed. Drive the whole thing
  from Claude Code or Codex over AgentRun's own MCP endpoint.
- **Run anywhere.** Your machine, a Docker container per run, or Daytona and Modal sandboxes. One image for your cloud.

## Quickstart

```sh
npx @parcha/agentrun
```

That starts AgentRun on `127.0.0.1:7340`, keeps everything in `~/.agentrun` and opens the console (Node 22.19+, macOS or
Linux). Add a model key under Settings → Tool keys → Model keys. One `OPENROUTER_API_KEY` gives every harness a model,
or use `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

Create an agent, run it with a 25-cent cap, read the answer:

```sh
export AGENTRUN_BASE_URL=http://127.0.0.1:7340/v2   # the port it printed
export AGENTRUN_API_KEY=$(cat ~/.agentrun/.token)
H="authorization: Bearer $AGENTRUN_API_KEY"; J='content-type: application/json'

curl -s "$AGENTRUN_BASE_URL/agents" -H "$H" -H "$J" \
  -d '{"definition":{"id":"calc","name":"Calc","instructions":"Answer the question."}}'

run=$(curl -s "$AGENTRUN_BASE_URL/agents/calc/runs" -H "$H" -H "$J" \
  -d '{"input":{"content":"What is six times seven?"},"max_cost_usd":0.25}' \
  | node -p 'JSON.parse(require("fs").readFileSync(0)).run_id')

curl -s "$AGENTRUN_BASE_URL/runs/$run/timeline?wait_ms=5000" -H "$H"
curl -s "$AGENTRUN_BASE_URL/runs/$run" -H "$H"
```

Every edit is a revision: `PUT /v2/agents/calc/definition` makes revision 2 current, and every run records the revision
it ran. Put `"harness": "codex"` in the definition and the agent's next run is a Codex run.

Rather have your coding agent drive it?

```sh
claude mcp add --transport http agentrun "$AGENTRUN_BASE_URL/mcp" --header "Authorization: Bearer $AGENTRUN_API_KEY"
```

Full API: [AgentRun Server](packages/serve/README.md#quick-start-no-key-no-network). OpenAPI at `GET /v2/openapi.json`.

## Architecture

![Five harnesses side by side, pi, Claude Code, Codex, OpenCode and Workflows, inside the kernel, inside the meta harness, surrounded by triggers, browser, tools and MCP, sandbox, workspace, self-learning, spend and analytics.](docs/assets/agentrun-layers.svg)

- **Harnesses are peers.** An agent names one: `pi` (the default), `claude-agent`, `codex` or `opencode`. A workflow
  agent runs typed steps with no agent loop at all. An agent never falls back to another harness behind your back.
- **The kernel** makes them interchangeable. Claude Code, Codex and OpenCode plug in through one adapter that hands the
  CLI AgentRun's tools as its only tools, routes its model calls through a proxy that prices each one, and journals
  every step. pi runs natively on pi-durable under the same gate and cap.
- **The meta harness** is the loop around any harness: start, steer, stop, resume after a crash, the permission gate,
  the spend cap, the end-of-run learning turn. A feature written here works on every harness the day it lands.
- **The layers** plug into the meta harness. Each has a section [below](#whats-in-it).

### Where your agent lives

![The control plane holds store.sqlite and reads each run's database live off the disk. One disk per owner holds each agent's learning repo and a folder per run with run.sqlite and work. A box running tools mounts work; a box running the loop and tools mounts the whole run folder.](docs/assets/agentrun-disk.svg)

Two kinds of data, two places.

- **The control plane** keeps one database, `store.sqlite`: every agent, revision, run and cost. Only the server
  writes it, and no sandbox ever mounts it.
- **Your disk** keeps everything the agents make. One disk per owner: a folder on your machine, or your own
  [Archil](https://archil.com) disk when sandboxes run on other machines.

```text
disk/
└── agents/<agent>/
    ├── learning/                 a git repo of what the agent learned
    └── runs/<run>/
        ├── store/run.sqlite      the run's journal: every turn, tool call and cost
        └── work/                 /workspace
```

A run mounts its own folder and nothing above it. A box that only runs tools mounts `work/`. A box that runs the agent
loop too mounts the whole run folder, with the journal and the tools under different users. Nothing is copied in or out.

Live views read the run's SQLite straight off the disk. The run writes its journal in WAL mode and never rewrites the
database file mid-run; the control plane opens it read-only, lock-free, on every poll. SQLite's checksummed WAL frames
mean a reader on another machine always lands on the last complete commit. No message bus, no streaming, about 100 ms
behind a run on a remote sandbox.

### Durable by default

A run is a process with a folder. Every turn and tool call is committed to `run.sqlite` before the next step starts.
Kill the process, restart the server, reboot the machine. The next start finds the run, reopens its folder and carries on
from the last commit. Stopping the server gives a busy run a few seconds to finish its turn, and a turn that gets cut
off resumes at the next start.

### Simplicity is the point

One Node process and one folder. No Postgres, no Redis, no queue, no worker fleet, no event bus between the server and
its runs. A full server says `429` with a `retry-after` instead of queueing. Want to know exactly what a run did?

```sh
sqlite3 disk/agents/<agent>/runs/<run>/store/run.sqlite
```

## The life of a request

<p align="center"><img src="docs/assets/agentrun-life-of-a-request.svg" width="440" alt="Top to bottom: request, run starts, agent loop, tool call, gate and spend cap, sandbox, disk, learning. A dashed arrow from disk back to the agent loop shows the loop repeating."></p>

1. **Request.** `POST /v2/agents/{id}/runs`, from you, the console, a schedule or a signed webhook.
2. **Run starts.** The server pins the agent's current revision, makes `runs/<id>/` and starts the run's own process.
3. **Agent loop.** The harness runs the agent's instructions, skills, learned notes and tools. Every model request is
   priced before it's sent, and the run's cap is checked first.
4. **Tool call.** The model asks for a shell command, a file, a page, a browser action or a paid API.
5. **Gate & spend cap.** Each tool is allow, ask or deny, set per server or per agent. An ask pauses the run until you
   answer in the console. A call the cap can't cover pauses the run for a raise.
6. **Sandbox.** Shell commands run in the run's box. No key ever enters it.
7. **Disk.** Files land in `work/`. The turn, the call and its cost land in `run.sqlite`. Then the loop goes again.
8. **Learning.** When the run ends, the agent gets one more turn to write down what it learned. A grader keeps the good
   notes, and the next run starts from them.

The same run from the server's side: [a run's life](packages/serve/README.md#a-runs-life).

## Self-learning and workflows

Not everything is an agent. A support flow, a document check or a ranking has fixed steps and a few judgment calls.
The workflow harness runs typed workflows with no agent loop: steps as JSON or a TypeScript builder, decisions on
[Jev](https://docs.typesafe.ai/) with typed answers and their probabilities, and an agent only where the work needs
investigating. The console draws a workflow run's graph live, every decision with its receipt.

![Support workflow: search for an answer, check it with Jev, and return it or ask an agent to investigate. Check the investigation before returning it or escalating for review.](docs/assets/support-workflow.gif)

Run it yourself, with scripted models and no key ([definition](examples/support-answer.mjs),
[static diagram](docs/assets/support-workflow.svg)):

```sh
git clone https://github.com/Parcha-ai/agentrun.git && cd agentrun
npm ci --ignore-scripts && npm run build
npm run demo:support
```

Self-learning is how an agent turns into a workflow. Turn it on with `"learning": true`. After each run the agent
proposes notes, skills and, when it keeps repeating the same steps, a workflow draft. One grader with one rubric
decides what to keep, and kept items merge as one commit into the agent's learning repo, in Claude Code's auto-memory
format. A risky rule ("trust this site", "skip that check") waits for your OK whatever the grader said. The next run
starts from what was learned on any harness, and a learned workflow runs as a single `learned_workflow` tool call.

The console's Learning tab shows every note, which runs used it, what was dropped and why, and what learning changed:
median time and cost per run before and after the agent's first note. [Learning](packages/serve/README.md#learning).

## What's in it

### Harnesses

pi, Claude Code (the Claude Agent SDK), Codex (its app-server) and OpenCode, plus the workflow harness.
`GET /v2/capabilities` says which harnesses a server runs, and why not when it doesn't. When Claude Code or Codex
isn't installed, AgentRun prints the one `npx` line that adds it.
[Harnesses](packages/serve/README.md#harnesses) · [Models](packages/serve/README.md#models)

### Sandboxes

Start with `AGENTRUN_BOXES=docker` and a new agent gets a shell in a Docker container made for each run. The box binds
the run's `work/` and nothing else, holds no key, and reaches only the package registries and GitHub. Daytona and Modal
sandboxes run the same tools on someone else's machine. Background processes (a dev server, a long build) outlive a
single tool call. [Sandbox in 60 seconds](packages/serve/README.md#sandbox-in-60-seconds) ·
[Sandbox](packages/serve/README.md#sandbox)

### Browser

The `browser` tool is a hosted session at Browserbase or Kernel. Sign-ins are saved per agent, never shared between
agents, and sealed on the server. Every page the agent reads is filed under `work/evidence/`, and browser minutes
count against the run's cap. [Saved sign-ins](packages/serve/README.md#saved-sign-ins)

### Tools, MCP and the gate

Agents pick tools from one closed table: `read`, `write`, `edit`, `bash` and its background family, `ask_person`,
`web_search`, `web_fetch`, `browser` and [monid](https://monid.ai)'s paid data APIs. Web search runs on the harness's
own search where it has one, else Parallel on your key, else a keyless fallback. Every call goes through the same gate,
on every harness: built-in tools allow by default, third-party tools ask. Remote MCP servers are saved once, with
their credential sealed and their tools listed before you keep them.
[Tools](packages/serve/README.md#tools) · [MCP servers](packages/serve/README.md#mcp-servers) ·
[For coding agents](packages/serve/README.md#for-coding-agents)

### Triggers

Schedules start runs with nobody watching: a cron line in a time zone, a single time, or every N seconds, with catch-up
after downtime and auto-pause after five failures in a row. Webhook triggers fire on a signed `POST /v2/hooks/{id}`.
No trigger starts an uncapped run. Outbound webhooks tell your URL when a run needs you and when it ends.
[Schedules](packages/serve/README.md#schedules) · [Webhooks](packages/serve/README.md#webhooks)

### Spend and analytics

The cap counts what the run spent, plus every request in flight at its worst case, plus the next one. Paid tools,
browser minutes and the learning turn count too. A paused run shows its suggested raise; `PATCH /v2/runs/{id}` or one
click in the console sends it on its way. An agent can carry a default cap for every run that doesn't set one.
Mission Control is the console's first page: live runs, what needs you, and answers in place.
[Spend cap](packages/serve/README.md#spend-cap) · [The console](packages/serve/README.md#the-console)

## Run it on a server

The image is public, `ghcr.io/parcha-ai/agentrun-server`:

```sh
docker run -d --name agentrun -p 127.0.0.1:7340:7340 -v agentrun:/data \
  -e OPENROUTER_API_KEY ghcr.io/parcha-ai/agentrun-server:beta
docker logs agentrun | grep Open
```

Open the link it prints and set your password. Or [deploy to Render](https://render.com/deploy?repo=https://github.com/Parcha-ai/agentrun)
from [`render.yaml`](render.yaml): a Starter instance with a 1 GB disk, about $7 a month. The image doesn't host sandbox
boxes or Claude Code yet; for those, run from a checkout or with `npx`.
[In a container](packages/serve/README.md#in-a-container) · [Capacity and health](packages/serve/README.md#capacity-and-health)

## Open source, hosted and enterprise

**Open source** is this repository, all of it Apache-2.0. It's built for one owner: a password for the console, a token
for scripts. It stays that simple on purpose.

**Hosted AgentRun** will be the same `/v2` API on our cloud, with model billing on one account, teams and managed
sandboxes. An agent you build here will move there unchanged.

**Enterprise** will run AgentRun in your own cloud with SSO, SCIM, audit and ContextForge. None of that goes into the
open-source server.

## Roadmap

What's built is above. What's next:

- One disk per owner, read live off SQLite (rolling out in the next release), and Archil for sandboxes on other machines.
- Agents calling the tools of your saved MCP servers.
- Slack and GitHub triggers.
- A CLI and SDKs.
- Composio connectors.
- ContextForge for your own APIs and MCP servers.
- Full computers on E2B and Orgo.
- Hosted AgentRun.

## Contributing

For development setup and checks, see [Contributing](CONTRIBUTING.md). [Open an issue](https://github.com/Parcha-ai/agentrun/issues)
for bugs or proposals, and read [Security](SECURITY.md) before reporting a vulnerability.

AgentRun is built from open packages, each usable on its own: [`packages/`](packages/). Changes ship in the
[changelog](CHANGELOG.md).

## License

Code and documentation use [Apache-2.0](LICENSE). Copyright 2026 Parcha Labs, Inc. Dependencies retain their own
licenses. Built by [Grep.ai](https://grep.ai).

## Acknowledgements

AgentRun builds on these projects. Each keeps its own license.

- [Pi](https://github.com/earendil-works/pi) by Earendil Works and Mario Zechner (MIT): `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `pi-durable`, `chord` and `pi-codemode`, the agent loop and the durable runtime every package here runs on.
- [Stagehand](https://github.com/browserbase/stagehand) by Browserbase (MIT): browser automation in `@parcha/pi-browser`, which also vendors part of Stagehand's facade (see [its NOTICE](packages/pi-browser/NOTICE)).
- The [Browserbase Node SDK](https://github.com/browserbase/sdk-node) (Apache-2.0): Browserbase sessions in `@parcha/pi-browser`.
- The [TypeSafe JavaScript SDK](https://github.com/typesafe-ai/typesafe-sdk-js) (MIT): Jev's typed decisions in `@parcha/agentrun-jev`.
- Archil's [disk SDK](https://github.com/archil-data/archil-sdk) (MIT): the network disk under `@parcha/pi-durable-disk`.
- The document readers in `@parcha/pi-vision`: [@hyzyla/pdfium](https://github.com/hyzyla/pdfium) (MIT, with Google's PDFium), [unpdf](https://github.com/unjs/unpdf) (MIT, with Mozilla's PDF.js), [Photon](https://github.com/silvia-odwyer/photon) (Apache-2.0), [xmldom](https://github.com/xmldom/xmldom) (MIT) and [fflate](https://github.com/101arrowz/fflate) (MIT).
- [PDF.js](https://github.com/mozilla/pdf.js) by Mozilla (Apache-2.0), vendored in `apps/viewer` with the OpenJPEG decoder (BSD-2-Clause) and PDFium's JBIG2 decoder (BSD-3-Clause) it bundles.
- [TypeBox](https://github.com/sinclairzx81/typebox), [Zod](https://github.com/colinhacks/zod), [undici](https://github.com/nodejs/undici), [node-html-parser](https://github.com/taoqf/node-fast-html-parser), [node-html-markdown](https://github.com/crosstype/node-html-markdown) and [htmlparser2](https://github.com/fb55/htmlparser2), all MIT.
- [vercel-labs/durable-harness](https://github.com/vercel-labs/durable-harness) (Apache-2.0): AgentRun's durable harnesses build on its ideas and code. What `@parcha/agentrun-kernel` and `@parcha/agentrun-harness-claude` copy is listed in each package's `vendor/durable-harness/UPSTREAM.json` and credited in its NOTICE ([adapters](packages/run-adapters/NOTICE), [Claude Agent](packages/run-adapters-claude-agent/NOTICE)).
