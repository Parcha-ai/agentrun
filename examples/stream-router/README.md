# Stream ring router

A [Sandbar Stream](https://www.sandbar.com/technology/stream-mcp) voice ring posts every note you save to one webhook.
Most notes need no agent: a grocery item, a thought, a reminder to yourself. This example takes the ring's webhook with
AgentRun alone and wakes an agent only for the notes that ask for one, in the shape of the Cloudflare Worker design in
bfrench's "A Ring on My Finger Now Wakes My Chief of Staff" (four gates in front of an agent), with each gate moved onto
something AgentRun already does, and the gaps named.

```
Stream ring ─▶ iPhone ─▶ POST /v2/hooks/{trigger}   webhook trigger, signature "stream"
                         │  verify X-Stream-Signature (5 min), one firing per interaction_id
                         ▼
                 stream-router (workflow agent)
                         │  route: Jev picks none, arun, research or code; unsure (< 0.7) is none
          ┌──────────────┼──────────────┬──────────────┐
         none           arun         research          code
   (Stream keeps it)  agent step     agent step     agent step
   one decision,      Arun's work    web search     repo plan
   no model           budget 0.25    budget 0.50    budget 0.25
```

| File | What it is |
| --- | --- |
| `router.workflow.json` | The router: one Jev `route` over the note as delivered, and a specialist `agent` step per route. Each run's result is its whole state: the note, the `route`, and the specialist's `reply` (none for a note routed to none). No code nodes, so a server runs it without `--allow-code-nodes`. |
| `setup.mjs` | Makes (or revises) the `stream-router` agent and the `Stream ring` trigger on a server, then prints the URL for Stream and the page where you set Stream's secret. |
| `router.test.mjs` | The offline check: a faux server, Jev scripted by `faux-jev.mjs`, four notes sent at once, and the gaps below pinned as today's behaviour. |
| `faux-jev.mjs` | The test's stand-in for Jev: it routes by the note's words. Live routing is Jev's judgment. |

## Set it up

1. A server with a Jev key (`TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY`; Settings → API Keys) and a public address
   Stream can reach over `https://` (`AGENTRUN_PUBLIC_URL`). Stream posts from the phone, waits 5 s, follows no redirect
   and never retries; the hook answers once the firing is recorded, before any run starts.
2. `AGENTRUN_BASE_URL=https://your-server/v2 AGENTRUN_API_KEY=... node examples/stream-router/setup.mjs`
3. In Stream on your iPhone, open Developer (Webhook) under Other Tools in its settings: paste the URL the script prints,
   turn on Send interactions and Sign requests, and copy the secret Stream shows (`swh_...`).
4. On the trigger's page in the console (the script prints it), Set secret with that value. Until then every note is
   refused `401`. Regenerating the secret in Stream means setting the new one here.
5. Say something to the ring. Its run is on the console's Runs page, titled `Webhook Stream ring: interaction`, with
   the route Jev took and, for an agent's route, the specialist's answer.

Edit the branches' `criteria` (what Jev reads to choose) and each specialist's `instructions`, `tools` and
`budget_usd` to fit your agents, then run `setup.mjs` again: it revises the agent in place.

## How the post's gates land on AgentRun

| The post's Worker | Here | Where |
| --- | --- | --- |
| Tier 0: verify `X-Stream-Signature`, fail closed, 5-minute window | The webhook trigger's `stream` signature: refused `401` until the owner sets Stream's secret | `packages/serve/src/trigger-signatures.ts` |
| Tier 1: drop a repeated `interaction_id` | The firing's key is the signed `interaction_id`: a note posted again is the same firing | same |
| Tier 1: drop blank text | Not yet (gap 4): a blank note reaches Jev, which routes it to none | |
| Tier 2: a leading wake name forwards at once | `accept` with `{pointer: "/text", prefix: "Arun"}` on a trigger whose target is the agent, for a person who wants names alone; here Jev reads the name with the rest (gap 4) | `trigger-accept.ts` |
| Tier 3: an optional classifier on unmarked speech | The router's Jev `route`, its threshold in the workflow (`unsure.gte`) | `router.workflow.json` |
| Answer the phone fast; forward in `waitUntil`, retry twice | The hook records the firing durably and answers `202`; the run starts from it, and a firing left by a restart is driven again | `triggers.ts` |
| A 30-day log and a bearer `GET /digest` of notes not forwarded | Every router run is in the run history with its route; Stream keeps every note, so a schedule trigger can start a digest agent that reads Stream's MCP server (`mcp:stream/get_recent_interactions`) | an agentic agent, not this workflow (gap 2) |
| The bot treats the note as untrusted and acts only on a yes | The note arrives inside `<trigger-payload ... untrusted>`; the specialists hold read-only tools and are told nothing is sent, posted or changed without the person's yes | the workflow's instructions |
| Caps against usage drain | Each run's `max_cost_usd`, each step's `budget_usd`, `max_active_runs: 5`, and a payload cut at 16 KiB; no per-hour limit (gap 7) | the trigger and workflow |

A note Jev routes to none costs one decision (live Jev reports about $0.00003) and no model request: the test checks it.

## Gaps

What the design needs that AgentRun does not do yet. **Verified** means `router.test.mjs` or a server's refusal shows
it; **from the code** means read, not run.

1. **A workflow cannot start another agent's run.** Verified: granting `mcp:<server>/runs_start` to a workflow agent is
   refused at save, "a workflow's nodes don't bind MCP tools here yet; grant it to an agentic agent"
   (`packages/serve/src/runnable.ts`). So the specialists are steps inside the router run, not your separate agents
   with their own history, tools and caps. Wanted: MCP tools bound in workflow `call` nodes, or a native way for a
   `call` to start an agent's run (its id fixed in the workflow, never chosen by the note).
2. **A workflow's steps cannot use any MCP tool.** Same refusal: the coder step can't reach a GitHub MCP server, Arun
   can't reach your calendar or Slack, and the router can't save a summary back to Stream. Today those need an agentic
   agent, which a workflow can't start (gap 1).
3. **One webhook URL is one trigger.** From the code: a webhook trigger's hook is `/hooks/{trigger_id}`, and Stream
   sends to one URL. GitHub's server-wide source fires every trigger whose `accept` takes an event; a server-wide
   `stream` source would let several agents each take their own notes (Arun's by name, the coder's by a rule) without a
   router run.
4. **`accept` can't say what the post's tiers 1 and 2 say.** Verified: the prefix `Arun` takes "Arundel castle photos"
   (no word boundary), and a blank note is taken (no "not blank" condition). The post also strips the wake name and
   records which name matched; a trigger passes the body as it came. Wanted: a boundary on `prefix` (or a bounded
   pattern), a not-blank condition, and the matched rule on the payload's tag.
5. **Jev can't gate a firing, only a run.** From the code: `accept` reads the body with no model, and Jev answers only
   inside a run. So every note becomes a router run in the history, even the ones routed to none. An `accept` condition
   Jev answers (an `ask` with its threshold) would keep those out of the run list.
6. **Without `accept`, a webhook trigger skips notes.** Verified while building this: three of four notes sent together
   were skipped, "The last run ... is still queued". `accept` makes each note its own run, so the trigger here has one.
   A `stream` trigger might be concurrent by default, as a GitHub trigger is.
7. **No shadow mode, and no rate limit.** Verified: a paused trigger refuses a note `401` and records nothing, where the
   post rolled out by logging matches without waking the bot. From the code: `max_active_runs` bounds runs at once,
   not runs an hour.
8. **Testing locally.** Verified: `agentrun-serve` has no switch for a fake Jev (only the test harness's `fauxJev`
   option), so a local server without a Jev key fails the route ("Jev returned HTTP 401"); and a server's own MCP
   endpoint on loopback was refused as a private address even with `AGENTRUN_MCP_ALLOW_LOOPBACK=1` (not investigated
   further).

## Run the check

```sh
npm run build
node --test examples/stream-router/router.test.mjs
```
