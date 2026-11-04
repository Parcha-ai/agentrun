// The OpenAPI document this server serves at GET /v2/openapi.json: the agentrun.v2/0 contract as vendored in
// src/openapi/agentrun-v2.openapi.json (its source is in its info), with this server's marks. The contract's operations are
// not changed: an operation answered 501 here carries `x-agentrun-serve-unsupported` with the reason, and this server's
// own routes are added as operations marked `x-agentrun-serve` (true, or the addition that made it, as `stats/1`), listed
// in `info.x-agentrun-serve`.
import { readFileSync } from "node:fs";
import { NOTE_ORIGINS, NOTE_STATUSES, NOTE_TYPES } from "./learn/index.js";
import { ERROR_STATUS } from "./errors.js";
import { LAUNCH_LOST } from "./files.js";
import { HARNESSES } from "./harness.js";
import { LEARNING_LABEL, LEARNING_MODES, LEARNING_REASONS, LEARNING_STATES } from "./learning.js";
import { MODEL_SOURCES, THINKING_LEVELS } from "./model.js";
import { BOX_IDS } from "./boxes.js";
import { PLACE_MODES } from "./place.js";
import { TOOL_KEYS, UNREADABLE } from "./tool-keys.js";
import { ATTEMPTS_KEPT, MESSAGE_TYPES, WEBHOOK_EVENTS } from "./webhooks.js";
import { DEFINITION_FIELDS, NOT_KEPT } from "./validate.js";
import { NOT_YET, PICKABLE, PROVIDERS } from "./tool-plane.js";

type Json = Record<string, unknown>;

/** Why each capability this server turns off answers 501, by the route's capability. */
export const UNSUPPORTED: Readonly<Record<string, string>> = {
  "home.export": "This server does not export a home yet.",
  "home.import": "This server does not import a home yet.",
  "runs.kill": "This server does not kill a run's process yet.",
  quotes: "This server has no billing, so it gives no quotes.",
};

const ref = (name: string) => ({ $ref: `#/components/${name}` });
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [String(code), ref(`responses/${{ 400: "BadRequest", 401: "Unauthenticated", 403: "Forbidden", 404: "NotFound", 409: "Conflict", 412: "PreconditionFailed", 413: "PayloadTooLarge", 415: "UnsupportedMediaType", 422: "Unprocessable", 429: "RateLimited", 500: "Internal", 501: "Unsupported", 503: "Unavailable" }[code]}`)]));
const json = (schema: unknown, description: string) => ({ description, content: { "application/json": { schema } } });
/** GET /health's answer (host.ts Health). */
const HEALTH = {
  type: "object", additionalProperties: false, required: ["status", "checks"],
  properties: {
    status: { enum: ["ok", "failing"] },
    checks: { type: "object", additionalProperties: false, required: ["store", "disk"], properties: { store: { enum: ["ok", "does_not_open"] }, disk: { enum: ["ok", "below_floor", "cannot_check"] } } },
  },
};

const COUNT = { type: "integer", minimum: 0 };
const closed = (properties: Json, description?: string) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties, ...(description ? { description } : {}) });
const USD = { type: ["number", "null"], minimum: 0, description: "The sum of the known costs, rounded to 1e-6; null when no run's cost is known, never 0 for unknown." };
/** Runs counted together (AgentStoreReader.analytics's AnalyticsGroup). */
const GROUP = {
  runs: COUNT, completed: { ...COUNT, description: "Completed, escalated runs included: one completed and waits for a person's review." },
  needs_review: { ...COUNT, description: "Of `completed`, the escalated runs, which wait for a person's review.", "x-agentrun-serve": "stats/3" },
  failed: { ...COUNT, description: "Failed: never an escalated run." },
  runs_with_metrics: { ...COUNT, description: "Of `runs`, those that ended with metrics: a running run, and a run whose end wrote none, has none." },
  tokens: { ...COUNT, description: "Input, cache read, cache write and output tokens, summed over `runs_with_metrics`." },
  cost_usd: USD, unknown_cost_runs: { ...COUNT, description: "Runs with no known cost: running, or ended without one." },
};
/** GET /stats's `analytics` (stats.ts analyticsView). */
const ANALYTICS = closed({
  filter: closed({ from: { type: ["string", "null"], format: "date-time" }, to: { type: ["string", "null"], format: "date-time" }, agent: { type: ["string", "null"] } }, "The query's bounds, each null when not given: runs started at or after `from` and before `to`, of `agent`."),
  totals: closed({
    ...GROUP, input: COUNT, cache_read: COUNT, cache_write: COUNT, output: COUNT,
    requests: { ...COUNT, description: "Model requests." }, unmetered: { ...COUNT, description: "Of `requests`, those whose tokens are unknown: in no token sum." },
  }, "Over every run the filter picks. `input` excludes cached input: the whole input is `input + cache_read + cache_write`."),
  time: closed({ ended_runs: COUNT, wall_ms: { ...COUNT, description: "Ended minus started, summed over `ended_runs`." }, active_runs: COUNT, active_ms: { ...COUNT, description: "How long the runs were at work, summed over the `active_runs` whose metrics say." } }),
  by_harness_effort: { type: "array", description: "By the revision's harness (`pi` when it names none, `workflow` for a workflow revision), then the effort the run's metrics name (null: unset, or no metrics).", items: closed({ harness: { type: "string" }, effort: { type: ["string", "null"] }, ...GROUP }) },
  by_day: { type: "array", description: "By the UTC date the run started, oldest first.", items: closed({ day: { type: "string", format: "date" }, ...GROUP }) },
  by_source: { type: "array", description: "`live`, run here, first, then each source runs were imported from.", items: closed({ source: { enum: ["live", "claude-code", "codex", "pi"] }, ...GROUP }) },
  tools: { type: "array", maxItems: 20, description: "The 20 tools with the most calls, by name on a tie; `errors` counts the calls that failed (an error, a result the tool reads as failed such as a refused fetch, or no result at all).", items: closed({ tool: { type: "string", description: "The name the tool was called by." }, label: { type: "string", description: "What a person calls the tool, from the timeline's label registry; the name it was called by when it has none.", "x-agentrun-serve": "stats/3" }, calls: COUNT, errors: COUNT }) },
}, "The runs' tokens, requests, time and tool calls from their metrics, over the runs not archived that the query picks; a run with no metrics counts in `runs` alone.");
/** GET /stats's answer (stats.ts). */
const STATS = closed({
  agents: { ...COUNT, description: "Agents not archived." },
  runs: closed(
    { total: COUNT, active: COUNT, needs_input: COUNT, failed: COUNT, needs_review: { ...COUNT, "x-agentrun-serve": "stats/3" }, status_unknown: COUNT },
    "Runs not archived. `total` counts them all; a completed or cancelled run is counted in `total` alone, but for an escalated one, which completed and waits for a person's review: it is in `needs_review`, never in `failed`. Each running run is in exactly one of `active` (this server holds it, queued, working or paused), `needs_input` (it holds it, input_required) and `status_unknown` (it does not hold it, or holds it as ended before its end is written).",
  ),
  per_agent: {
    type: "array", description: "Each agent not archived, by name then id, with how many of its runs are not archived; an agent with no runs is listed with 0.",
    items: closed({ agent_id: ref("schemas/Id"), name: { type: "string" }, runs: COUNT }),
  },
  cost: closed(
    {
      usd: { type: ["number", "null"], minimum: 0, description: "The sum of the known costs, rounded to 1e-6; null when no run's cost is known, never 0 for unknown." },
      basis: { type: ["string", "null"], enum: ["estimate", null], description: "`estimate` (what the runs report: their model requests' cost and their paid tools' charges) when `usd` is a number; null when it is null." },
      unknown_runs: COUNT,
    },
    "Over the runs not archived: `usd` sums the cost of each run that ended with one; every other run (running, or ended with no cost) is in `unknown_runs`.",
  ),
  archived: closed({ agents: COUNT, runs: COUNT }, "Agents archived, and runs archived or of an archived agent: counted here and in nothing else."),
  analytics: { ...ANALYTICS, "x-agentrun-serve": "stats/2" },
  learning: {
    ...closed({
      runs: { ...COUNT, description: "Runs that tried to learn: each with a `learning` block. A run with learning off, a workflow's or an imported one has none." },
      merged: COUNT,
      dropped: { type: "object", additionalProperties: COUNT, propertyNames: { enum: [...LEARNING_REASONS] }, description: "The dropped runs, by reason (Run.learning.reason): only reasons with one run or more." },
      in_progress: { ...COUNT, description: "Seeded, reflecting or proposed: runs this server holds." },
    }, "How the runs that tried to learn fared, over the runs not archived that `from`, `to` and `agent` pick, as `analytics` counts them."),
    "x-agentrun-serve": "learning/1",
  },
});
const NODE_STATUS = { enum: ["pending", "working", "done", "failed", "stopped", "escalated", "not_run", "needs_review"] };
const nullable = (type: string) => ({ type: [type, "null"] });
/** GET /runs/{run_id}/graph's answer (graph-view.ts). */
const RUN_GRAPH = {
  type: "object", additionalProperties: false, required: ["run", "workflow", "graph", "nodes", "decisions", "effects", "totals", "stale", "read_at"],
  properties: {
    read_at: { type: "string", format: "date-time", description: "When the view shown was read: the run process's last live view while it goes, else the read itself." },
    stale: { type: "boolean", description: "True when the run's store was busy and this is the last view read whole: the next poll reads it again. A poll never answers home_busy." },
    run: {
      type: "object", additionalProperties: false, required: ["id", "agent", "revision", "status", "paused", "startedAt", "endedAt"],
      properties: { id: { type: "string" }, agent: { type: "string" }, revision: { type: "string" }, status: ref("schemas/RunStatus"), paused: { type: "boolean" }, startedAt: { type: "string", format: "date-time" }, endedAt: { type: ["string", "null"], format: "date-time" } },
    },
    workflow: { type: "object", description: "The revision's workflow definition." },
    graph: { type: "object", required: ["nodes", "edges"], description: "The DSL's workflowGraph of the definition: nodes { path, kind, label, via?, changeCheck } and edges { from, to, kind }." },
    nodes: {
      type: "object", description: "Each graph node's state, by its path.",
      additionalProperties: {
        type: "object", additionalProperties: false, required: ["status"],
        properties: {
          status: NODE_STATUS, startedAt: { type: "string", format: "date-time" }, endedAt: { type: "string", format: "date-time" },
          branch: { type: "string", description: "A route's branch taken." },
          items: { type: "array", description: "A map's items, one per item of its list.", items: { type: "object", additionalProperties: false, required: ["index", "status", "executionPath"], properties: { index: { type: "integer" }, status: NODE_STATUS, executionPath: { type: "string" }, label: { type: "string" }, branches: { type: "object", additionalProperties: { type: "string" }, description: "Each route in the map's body that ran for this item (by graph path) and the branch it took." } } } },
        },
      },
    },
    decisions: {
      type: "array", description: "Each decision receipt, joined to its graph node by its execution path.",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "node", "executionPath", "item", "kind", "provider", "model", "status", "questions", "answers", "evidence", "rule", "action", "cost_usd", "cost_basis", "latency_ms", "state", "state_truncated", "images", "error"],
        properties: {
          id: nullable("string"), node: nullable("string"), executionPath: nullable("string"), item: nullable("integer"), kind: nullable("string"), provider: nullable("string"), model: nullable("string"), status: nullable("string"),
          questions: {}, answers: {}, evidence: { type: "array" }, rule: {}, action: {}, cost_usd: nullable("number"), cost_basis: nullable("string"), latency_ms: nullable("number"),
          state: { description: "The state the judge saw, when the receipt kept it." }, state_truncated: { type: "boolean" }, error: { type: ["string", "null"], description: "A failed or cancelled request's reason." },
          images: { type: "array", items: { type: "object", additionalProperties: false, required: ["token", "ref", "url"], properties: { token: nullable("string"), ref: nullable("string"), url: nullable("string") } } },
        },
      },
    },
    effects: {
      type: "array", description: "Each call node's call: its input and output, in the order they started.",
      items: {
        type: "object", additionalProperties: false, required: ["node", "executionPath", "item", "tool", "status", "input", "output", "error", "startedAt", "endedAt"],
        properties: { node: nullable("string"), executionPath: nullable("string"), item: nullable("integer"), tool: { type: "string" }, status: { enum: ["working", "done", "failed", "stopped"] }, input: {}, output: {}, error: nullable("string"), startedAt: { type: "string", format: "date-time" }, endedAt: { type: ["string", "null"], format: "date-time" } },
      },
    },
    totals: {
      type: "object", additionalProperties: false, required: ["cost_usd", "decisions", "effects", "elapsed_ms"],
      properties: { cost_usd: { type: ["number", "null"], description: "Null when any part is unknown." }, decisions: { type: "integer" }, effects: { type: "integer" }, elapsed_ms: { type: ["integer", "null"] } },
    },
  },
};
/** POST /workflows/validate's answer: the DSL's validateWorkflow (code not run), and what a save would refuse. */
const VALIDATED = {
  type: "object", additionalProperties: false, required: ["ok", "issues", "warnings"],
  properties: {
    ok: { type: "boolean" },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "code", "message"], properties: { path: { type: "string", description: "A JSON Pointer into the workflow; empty for its root." }, code: { type: "string" }, message: { type: "string" } } } },
    warnings: { type: "array", items: { type: "string" } },
  },
};
/** GET /settings/tool-keys's answer (tool-keys.ts): each key's fields by name and where each is set, never a value. */
const TOOL_KEYS_VIEW = closed({
  keys: {
    type: "array",
    items: closed({
      id: { enum: TOOL_KEYS.map((row) => row.id) }, kind: { enum: ["tool", "model"], description: "`tool`: it unlocks tools, and reaches only the runs that name one; `model`: a model provider's key, which every run gets, and which gives the default model when the host names none (`capabilities.models`)." }, label: { type: "string" },
      unlocks: { type: "array", items: { type: "string" }, description: "What the key unlocks on this server: tools capabilities' `tools` lists, and `decisions.<id>` for a provider its `workflows.decisions.providers` lists. Empty when the key unlocks nothing this server binds." },
      harnesses: { type: "array", items: { enum: [...HARNESSES] }, description: "The harnesses that run the tools in `unlocks`: the union of their `harnesses` in capabilities' `tools`. A `model` key's: pi and the provider's own harness, of those capabilities' `harnesses` say this server runs." },
      fields: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["name", "set", "source"],
          properties: {
            name: { type: "string" }, set: { type: "boolean" },
            source: { enum: ["server", "stored", null], description: "`server`: the server is started with it (its launcher), and that one wins; `stored`: saved here, sealed; null: neither." },
            stored_unreadable: { type: "boolean", const: true, description: "A value is stored for it that does not open here: `reenter` says why." },
          },
        },
      },
      check: {
        oneOf: [
          closed({ state: { const: "accepted" }, at: { type: "string", format: "date-time", description: "When it was saved and checked." } }),
          {
            type: "object", additionalProperties: false, required: ["state", "reason"],
            properties: {
              state: { const: "not_checked" },
              reason: { type: "string", description: "Why, in plain words: the provider would not answer the check (403: the key may still work for its tools), did not answer in 5 s, could not be reached, answered a redirect (never followed, so the key goes nowhere else), or answered neither yes nor no (its status and first sentence); it has no call that costs nothing to check a key with; or the key was saved before this server checked keys." },
              at: { type: "string", format: "date-time", description: "When it was saved. Absent for a key saved before this server checked keys." },
            },
          },
          { type: "null" },
        ],
        description: "Whether the key (its first field) was checked against its provider when it was saved here, with one call that costs nothing: `accepted`, or `not_checked` and why; a key the provider refuses is never saved (PUT's 422). Null when the key is not stored here: not set, or set by the server, whose own key is not checked here.",
      },
    }),
  },
  reenter: {
    oneOf: [closed({ reason: { enum: [...UNREADABLE] }, fields: { type: "array", items: { type: "string" } } }), { type: "null" }],
    description: "The stored values that do not open here, to be entered again (a PUT seals them under the current key), and why: `seal_key_missing` (the server was handed no seal key), `seal_key_changed` (sealed under another), `file_unreadable` (damaged; `fields` is empty when the file as a whole does not read). Null when every stored value opens.",
  },
});
const KEY_ID = { name: "key_id", in: "path", required: true, description: "The tool key: one of GET /settings/tool-keys' ids.", schema: { type: "string" } };
/** The tool settings map (tool-plane.ts): the server's (/settings/tools) and an agent's own (definition.tool_settings).
 *  `permission` is reserved for the tool gate: a save that names it is 422 `not_yet`. */
const TOOL_SETTINGS = {
  type: "object", additionalProperties: false,
  properties: Object.fromEntries(PICKABLE.map((name) => [name, {
    type: "object", additionalProperties: false,
    properties: { provider: { enum: [...PROVIDERS[name]], description: `Default ${PROVIDERS[name][0]}.` }, permission: { type: "string", description: `Reserved for the tool gate: refused until then (422 not_yet, "${NOT_YET}").` } },
  }])),
};
/** What a capability resolves to on each harness: `native`, `kernel`, `exa-keyless`, `parallel`, or `unavailable: <reason>`. */
const RESOLUTION = { type: "string", pattern: "^(native|kernel|exa-keyless|parallel|unavailable: .+)$" };
const RESOLVES = {
  type: "object", additionalProperties: false, required: [...HARNESSES], properties: Object.fromEntries(HARNESSES.map((harness) => [harness, RESOLUTION])),
  description: "What the tool resolves to on each harness: native (the harness's own tool, or on pi one request to the model provider's hosted search), kernel (the guarded direct fetch), exa-keyless (Exa's keyless MCP search), parallel, or unavailable: <reason>.",
};
/** GET and PUT /settings/tools's answer: each capability's provider, its default where none is set. */
const TOOL_SETTINGS_ANSWER = closed(Object.fromEntries(PICKABLE.map((name) => [name, closed({ provider: { enum: [...PROVIDERS[name]] } })])));
/** GET /agents/{agent_id}'s `tools`: each tool the agent's current revision grants, in capabilities.tools' order; one
 *  with a provider choice with the provider in force, where it came from, the server's (its default), and what it
 *  resolves to on the agent's harness and model. */
const AGENT_TOOLS = {
  type: "array",
  description: "Each tool the agent's current revision grants, in capabilities.tools' order. A tool with a provider choice (web_search, web_fetch, and fetch_page, web_fetch's legacy name) carries the provider in force (provider), where it came from (provider_from: agent, its own tool_settings; server, the server's settings; default, the built-in default), the one that applies when the agent sets none (default_provider, the server's), and what it resolves to on the agent's harness and model (resolved). Only GET /agents/{agent_id} answers it.",
  items: {
    type: "object", additionalProperties: false, required: ["name"],
    properties: { name: { type: "string" }, provider: { type: "string" }, provider_from: { enum: ["agent", "server", "default"] }, default_provider: { type: "string" }, resolved: RESOLUTION },
  },
  "x-agentrun-serve": "providers/1",
};
const WEBHOOK_ID = { name: "webhook_id", in: "path", required: true, description: "The message, as its `webhook-id` names it.", schema: { type: "string" } };
const WEBHOOK_SET_FIELDS = {
  configured: { const: true }, url: { type: "string" },
  signing: { enum: ["sealed", "seal_key_missing", "unreadable"], description: "Whether the secret signs here: `sealed`; `seal_key_missing` (the server was handed no seal key) or `unreadable` (sealed under another key, or damaged), when nothing is sent until the webhook is removed and set again. Never the secret." },
  disabled: { oneOf: [closed({ at: { type: "string", format: "date-time" }, reason: { type: "string" } }), { type: "null" }], description: "Set when the receiver answered 410 Gone: nothing is sent until a PUT sets the webhook again." },
  updated_at: { type: "string", format: "date-time" },
};
const WEBHOOK_SET = closed(WEBHOOK_SET_FIELDS);
/** GET /settings/webhook (webhooks.ts): the webhook, or none; never its secret. */
const WEBHOOK_VIEW = { oneOf: [closed({ configured: { const: false } }), WEBHOOK_SET] };
const WEBHOOK_SECRET = { type: "string", pattern: "^whsec_[A-Za-z0-9+/]+={0,2}$", description: "The signing secret, shown this once: `whsec_` and 32 random bytes in base64, as the Standard Webhooks spec gives it. Keep it where the receiver checks `webhook-signature`." };
const WEBHOOK_ATTEMPT = closed({
  webhook_id: { type: "string", description: "The message's `webhook-id`: the same on each of its tries, and on a redelivery." },
  type: { enum: [...MESSAGE_TYPES] }, at: { type: "string", format: "date-time" },
  status_code: { type: ["integer", "null"], description: "The receiver's answer; null when it was not reached." },
  latency_ms: { type: "integer", minimum: 0 },
  error: { type: ["string", "null"], description: "Why the try failed: an answer not 2xx (a redirect is not followed), no answer in 15 s, not reached, or the webhook removed or off." },
  retry_at: { type: ["string", "null"], format: "date-time", description: "When the message is tried again after this one, if it is." },
  redelivery: { type: "boolean", description: "Sent again by POST .../redeliver." },
});
const PAUSED = { type: "object", additionalProperties: false, required: ["run_id", "paused", "status"], properties: { run_id: { type: "string" }, paused: { type: "boolean" }, status: ref("schemas/RunStatus") } };

/** POST .../archive and .../unarchive: hide an agent and its runs, or one run, from the lists, and show them again. */
const archiving = (collection: string, noun: string, id: Json, answer: string): Record<string, Record<string, Json>> =>
  Object.fromEntries(
    (["archive", "unarchive"] as const).map((verb) => [
      `/${collection}/{${noun.toLowerCase()}_id}/${verb}`,
      {
        post: {
          operationId: `${verb}${noun}`, tags: [collection], parameters: [id],
          summary: verb === "archive" ? `Archive the ${noun.toLowerCase()}: hidden from the lists, kept with its history` : `Show the archived ${noun.toLowerCase()} in the lists again`,
          responses: { "200": json({ type: "object" }, answer), ...errors(401, 404, 429, 500) },
        },
      },
    ]),
  );

const LEARNING_REASON = {
  enum: [...LEARNING_REASONS, null],
  description: [
    "Set only when `state` is `dropped`, from a closed list; a new reason is announced before it ships.",
    "`seed_failed`: the agent's learning folder could not be read or made, or its notes copied, so the run started with nothing learned.",
    "`no_budget`: the run's cap left no room for the end-of-run turn, or refused its request. `unknown_cost`: a capped run whose spend is unknown.",
    "`no_write_tool`, `tool_denied`: older runs only, from before the end-of-run turn answered with its notes (an agent with no `write` tool, or one a tool gate denied it); no run gets them now.",
    "`cancelled`: a person cancelled the run. `crashed`: the run's process went. `reflect_timeout`, `reflect_failed`: the end-of-run turn did not end in time, or ended on an error.",
    "`empty`: the turn's answer gave no note. `unparsed`: it gave notes out of format (no ```note block, one not closed or named twice), and none was kept. `propose_failed`: what it answered could not be checked. `checker`: the checks refused it, at its end or at the merge, and nothing was written to git.",
    "`screen`, `screen_down`: the injection screen (only with an independent judge) refused a new note, or could not judge one. `grader`: the grader's verdict was not to keep them. `grade_failed`: the grader gave no verdict, or the grade or the merge failed.",
  ].join(" "),
};
// ---- learning/1: what a person sees and controls of an agent's learning (learning-routes.ts) ---------------------------
const NULL_STRING = { type: ["string", "null"] };
const MARK = { "x-agentrun-serve": "learning/1" };
const PAGE = (item: Json, description: string) => closed({ items: { type: "array", items: item }, total: { ...COUNT, description: "How many there are in all, at the commit the page was read at." }, next_cursor: { ...NULL_STRING, description: "The next page, read at the same commit of main as this one: opaque. Null on the last." } }, description);
const LEARNING_NOTE = closed({
  file: { type: "string", description: "The note's file name, `<slug>.md`, at the folder's top; `[redacted]` when it holds one of the host's secrets as they are now (its route still answers the real name)." },
  name: { type: "string" }, description: { type: "string" }, type: { enum: [...NOTE_TYPES] },
  status: { enum: [...NOTE_STATUSES], description: "Absent from the note's front matter: active. Only an active note is in MEMORY.md. `pending`: a rule the grader held as risky, the user's or the run's own, to wait for its owner's OK; no run reads it." },
  origin: { enum: [...NOTE_ORIGINS], description: "`you`: kept from what the user asked in their own words; `run`: what the run worked out (absent from older notes: `run`)." },
  superseded_by: { ...NULL_STRING, description: "The note that superseded it, on a superseded note; `[redacted]` as `file` is." },
  text: { type: "string", description: "The note's whole file, front matter included." },
  etag: { type: "string", description: "The note's version on main, the same ETag as `GET .../learning/files/{file}` answers: send it as `If-Match` to edit or retire the version shown, and a 412 means it changed since.", "x-agentrun-serve": "learning/2" },
});
const LEARNING_CHANGE = closed({
  by: { oneOf: [closed({ run: { type: "string" } }), closed({ user: { type: "boolean", const: true } })], description: "A run's merge (its commit's `Run-Id` trailer), or a person's edit, creation or retirement through this API (`Changed-By: user`)." },
  commit: { type: "string" }, at: { type: "string", format: "date-time" },
  reason: { type: "string", description: "A merge's: the grader's reason. A person's: what was done, `edited by a person: <file>`." },
  files: { type: "array", items: { type: "string" }, description: "The files the commit changed, MEMORY.md among them; a name holding one of the host's secrets reads `[redacted]`." },
});
const LEARNING_COUNTS = closed({
  merged: COUNT,
  dropped: { type: "object", additionalProperties: COUNT, propertyNames: { enum: [...LEARNING_REASONS] }, description: "By reason (Run.learning.reason): only reasons with one run or more." },
  in_progress: { ...COUNT, description: "Seeded, reflecting or proposed: runs this server holds." },
}, "How the agent's runs that tried to learn fared, archived runs left out: GET /stats' `learning` with `agent`, less `runs`, counted as it counts them, from the runs this server holds and its learning ledger, no run's files opened.");
/** One side of an agent's impact (learning-run.ts learningImpact). */
const IMPACT_SIDE = (side: "before" | "after") => closed({
  runs: { ...COUNT, description: side === "before" ? "The completed runs that started before the agent's first note." : "The completed runs that started from at least one active note." },
  median_duration_s: { type: "number", minimum: 0, description: "Their median time to the answer, in seconds to a tenth: from the run's start to the moment its job's answer was final, before it looks back (a run that does not look back: to its end)." },
  median_cost_usd: { type: ["number", "null"], minimum: 0, description: "The median of the job's own cost, without its end-of-run turn, over the `cost_runs` whose cost is known, rounded to 1e-6; null when none is." },
  cost_runs: { ...COUNT, description: "Of `runs`, those whose job's cost is known: the ones `median_cost_usd` is the median of." },
  median_learning_usd: { type: ["number", "null"], minimum: 0, description: "The median of what learning itself cost a run, its end-of-run turn and its grade (the grade's is on GET /usage's `learning` meter), over the runs that learn whose learning cost is known, rounded to 1e-6; null when none is (a side of runs with learning off)." },
});
const AGENT_LEARNING = closed({
  agent: { type: "string" },
  main: { ...NULL_STRING, description: "Main's head commit; null while the agent has no learning folder (its learning was never on), when every page is empty." },
  index: { type: "string", description: "MEMORY.md on main: what the agent's next run reads, one line per active note, built by the server." },
  notes: PAGE(LEARNING_NOTE, "The first 50 notes: active first, then by their newest change, newest first. GET .../learning/notes for more."),
  log: PAGE(LEARNING_CHANGE, "The first 20 changes on main, newest first. GET .../learning/log for more."),
  counts: LEARNING_COUNTS,
  impact: {
    oneOf: [closed({ before: IMPACT_SIDE("before"), after: IMPACT_SIDE("after") }), { type: "null" }],
    description: "What learning changed for the agent: its completed agentic runs that started from at least one active note (`after`) against those that started before its first note (`before`: before the earlier of its first merge and the start of its first run that started from a note, so a person's first note counts too). A later run with learning off, or seeded with no note (every note retired), an imported and an archived run are on neither side. Null unless both sides count 2 runs or more: say it \"on N runs\", N `after.runs`. Read from the runs' rows and the learning ledger, no run's files opened.",
    "x-agentrun-serve": "learning/2",
  },
});
const PROBLEM = { type: "object", additionalProperties: false, required: ["rule", "detail"], properties: { rule: { type: "string" }, path: { type: "string" }, detail: { type: "string" } } };
const VERDICT_ITEM = {
  type: "object", additionalProperties: false, required: ["file", "keep", "why"],
  properties: {
    file: { type: "string", description: "The new note's file name; `[redacted]` when it holds one of the host's secrets as they are now." },
    keep: { type: "boolean", description: "Whether the rubric keeps the note: true for one that waits for the owner's OK too." },
    pending: { type: "boolean", const: true, description: "Present on a note kept to wait for the owner's OK: a risky rule, the user's or the run's own (its question is Risky)." },
    origin: { enum: [...NOTE_ORIGINS], description: "On a kept note: `you`, from what the user asked in their own words, or `run`." },
    question: { type: "string", description: "The rubric's question the note failed (General, Planted, Secret, Duplicate or Contradicts) when it is not kept, or Risky when it waits." },
    why: { type: "string", description: "One sentence, the grader's, cut of the host's secrets." },
  },
};
/** A note's file name, as a run's learning names one. */
const NOTE_NAME_FILE = { type: "string", description: "The note's file name, `<slug>.md`, in the agent's learning folder (GET /agents/{agent_id}/learning/files/{file}); `[redacted]` when it holds one of the host's secrets as they are now." };
/** The notes a run read and learned, on its learning block (runs.ts, learning.ts notesView): each present only when it
 *  holds a note. */
const LEARNING_NOTES: Record<string, Json> = {
  used: {
    type: "array", minItems: 1,
    items: closed({ file: NOTE_NAME_FILE, name: { type: "string", description: "The note's front-matter `name`, cut of the host's secrets as they are now." } }),
    description: "The notes this run read from `.learning/` in its working directory, in the order it first read each: every `read` call of its job (on any harness) whose result was a success and that names a note the run started from. A note read another way, through a command (`bash`'s `cat .learning/<file>`, say), is not counted. MEMORY.md, the index every run gets in its instructions, is not one; nor is a read the run's end-of-run turn made. Found once, as the run settles, and kept with the run: absent while it runs (a follow-up included) and when it read none.",
    "x-agentrun-serve": "learning/2",
  },
  learned: {
    type: "array", minItems: 1,
    items: closed({ file: NOTE_NAME_FILE, name: { type: "string", description: "The note's front-matter `name`, cut of the host's secrets as they are now." }, supersedes: { type: "array", items: NOTE_NAME_FILE, description: "The older notes it replaced, each now `superseded` by it; empty when it replaced none." } }),
    description: "The notes this run's learning added to the agent's learning folder: present once `state` is `merged`, absent otherwise.",
    "x-agentrun-serve": "learning/2",
  },
};
/** A run's learning block, past its read and learned notes: the notes its merge holds for the owner's OK. The run's
 *  learning whole (RUN_LEARNING) says the same as a list that is always there. */
const RUN_NOTES: Record<string, Json> = {
  ...LEARNING_NOTES,
  pending: {
    type: "array", minItems: 1,
    items: closed({ file: NOTE_NAME_FILE, name: { type: "string", description: "The note's front-matter `name`, cut of the host's secrets as they are now." } }),
    description: "The notes this run's merge holds for the owner's OK (status `pending` in the folder: a risky rule, the user's or the run's own), in no index and read by no run until approved, never among `learned`: present once `state` is `merged` and one waits, absent otherwise.",
    "x-agentrun-serve": "learning/2",
  },
};
/** `properties` as a closed object, its `optional` ones left out of `required`. */
const closedWith = (properties: Record<string, Json>, optional: Record<string, Json>) => ({ ...closed(properties), properties: { ...properties, ...optional } });
const RUN_LEARNING = {
  oneOf: [
    closedWith({
      run: { type: "string" }, state: { enum: [...LEARNING_STATES] }, reason: LEARNING_REASON,
      detail: { ...NULL_STRING, maxLength: 300, description: "Run.learning's detail, the same words: at most 300 characters, cut of the host's secrets as they are now before it is cut short." }, at: { type: "string", format: "date-time" },
      seed: { ...NULL_STRING, description: "The commit of main the run started from; null when its seed failed." },
      merged: { ...NULL_STRING, description: "Its merge commit on main, once merged." },
      pending: { type: "array", items: closed({ file: { type: "string" }, name: { type: "string" } }), description: "The merge's notes that wait for the owner's OK (status `pending` on main), in no index and read by no run until approved; empty when none." },
      verdict: { oneOf: [closed({ merge: { type: "boolean" }, reason: { type: "string" }, items: { type: "array", items: VERDICT_ITEM, description: "One for each new note the run proposed." } }), { type: "null" }], description: "The grader's, once it judged; null when no grade ran." },
      problems: { type: "array", items: PROBLEM, description: "The checker's, when the reason is `checker`." },
      cost_usd: closed({ grade: { type: ["number", "null"], description: "The grade's, outside the run (GET /usage's `learning` meter); null before a grade ran, or when its cost is unknown. The end-of-run turn's cost is in the run's own totals." } }),
      tokens: closed({ grade: { oneOf: [closed({ input: COUNT, cache_read: COUNT, cache_write: COUNT, output: COUNT }), { type: "null" }], description: "The grade's tokens; `input` excludes cached input." } }),
    }, LEARNING_NOTES),
    { type: "null" },
  ],
  description: "The run's learning whole. Null for a run that does not learn.",
};
const LEARNING_DIFF = closed({
  base: { ...NULL_STRING, description: "A merged run's merge's parent; else the commit the run's proposal was checked against (its seed)." },
  head: { ...NULL_STRING, description: "A merged run's merge commit; null before (the proposal is in the run's own folder, not a commit)." },
  files: {
    type: "array",
    items: {
      type: "object", additionalProperties: false, required: ["path", "status"],
      properties: {
        path: { type: "string", description: "The file's name; `[redacted]` when it holds one of the host's secrets." }, status: { enum: ["added", "modified", "deleted"] },
        patch: { type: "string", description: "The file's unified diff as git writes it, hunks only: from the first `@@` line, 3 lines of context. An added file diffs against nothing (`@@ -0,0 +1,N @@`)." },
        withheld: { enum: ["too_large", "secret"], description: "Set instead of `patch` when the file is not shown: its patch is over 64 KiB, or holds one of the host's secrets." },
      },
    },
  },
}, "What the run proposed: once merged, its merge commit against its parent, MEMORY.md and superseded notes included; before, its new notes against its seed; a run that proposed nothing, no file.");
const AGENT_ID = ref("parameters/AgentId");
const NOTE_PARAM = { name: "file", in: "path", required: true, description: "A note's file name at the folder's top (`<slug>.md`), percent-encoded; on a read, `MEMORY.md` too. Any other name is 400; a path with a `/` is no route (404).", schema: { type: "string" } };
const ETAG = { ETag: { description: "The note's version on main: its git blob id, quoted. If-Match on a write takes it.", schema: { type: "string" } }, "X-Content-Type-Options": ref("headers/NoSniff") };
const NOTE_TEXT = (description: string) => ({ description, headers: ETAG, content: { "text/markdown": { schema: { type: "string" } } } });
const PRECONDITION_REQUIRED = { description: "`precondition_required`: the write names no version it read: If-Match with the note's ETag (an edit or a retire), or If-None-Match: * (a new note). If-Match: * is not one.", content: { "application/json": { schema: ref("schemas/Error") } } };
const IF_MATCH = { name: "If-Match", in: "header", required: false, description: "The note's ETag, as a GET answered it: an edit or a retire lands only on that version, else 412.", schema: { type: "string" } };
const WRITE_ERRORS = { ...errors(400, 401, 404, 412, 429, 500), "428": PRECONDITION_REQUIRED };
const WRITE_DESCRIPTION = "As a person, with no grader: one host commit on main in the agent's queue, `learning: <edited|created|retired> by a person: <file>` with a `Changed-By: user` trailer, MEMORY.md rebuilt from the active notes, and the folder's files brought in line. A note that fails the structural checks a run's notes pass (front matter, the 4 KB cap, UTF-8, hidden characters, text shaped like a secret or holding one of the host's) is 400 `bad_request` with `problems`, and nothing is written; so is an index past 200 lines. MEMORY.md is 400: the server builds it. Answers the note as it now is, with its new ETag. An archived agent's notes are written as its definition is.";
const LEARNING_EXTENSIONS: Record<string, Record<string, Json>> = {
  "/agents/{agent_id}/learning": {
    get: {
      operationId: "getAgentLearning", tags: ["agents"], summary: "What the agent has learned: its index, notes, log of changes and counts",
      description: "Read at main's head with git's plumbing; every text cut of the host's secrets as they are now, and a file name holding one `[redacted]` whole. An agent whose learning was never on has no folder: `main` null and every page empty. An archived agent's is readable.",
      parameters: [AGENT_ID], responses: { "200": json(AGENT_LEARNING, "The agent's learning."), ...errors(401, 404, 429, 500) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/notes": {
    get: {
      operationId: "listLearningNotes", tags: ["agents"], summary: "A page of the agent's notes",
      parameters: [
        AGENT_ID,
        { name: "cursor", in: "query", required: false, description: "`next_cursor` from the previous page: opaque, read at the commit the first page was.", schema: { type: "string" } },
        { name: "limit", in: "query", required: false, description: "At most 200.", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        { name: "status", in: "query", required: false, description: "Only notes with this status.", schema: { enum: [...NOTE_STATUSES] } },
      ],
      responses: { "200": json(PAGE(LEARNING_NOTE, "Active first, then newest first."), "One page of notes."), ...errors(400, 401, 404, 429, 500) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/log": {
    get: {
      operationId: "listLearningLog", tags: ["agents"], summary: "A page of the changes on the agent's main, newest first",
      parameters: [
        AGENT_ID,
        { name: "cursor", in: "query", required: false, description: "`next_cursor` from the previous page: opaque.", schema: { type: "string" } },
        { name: "limit", in: "query", required: false, description: "At most 200.", schema: { type: "integer", minimum: 1, maximum: 200, default: 20 } },
      ],
      responses: { "200": json(PAGE(LEARNING_CHANGE, "Newest first."), "One page of changes."), ...errors(400, 401, 404, 429, 500) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/files/{file}": {
    get: {
      operationId: "readLearningFile", tags: ["agents"], summary: "One note (or MEMORY.md) on main, as text, with its ETag",
      parameters: [AGENT_ID, NOTE_PARAM], responses: { "200": NOTE_TEXT("The file's text, cut of the host's secrets."), ...errors(400, 401, 404, 429, 500) }, ...MARK,
    },
    put: {
      operationId: "writeLearningFile", tags: ["agents"], summary: "Edit a note (If-Match) or create one (If-None-Match: *)",
      description: `The body is the note's whole text, front matter included; a person may set any field, \`status\` too (an active note is in the index), except that a note waiting for its owner's OK stays waiting: an edit of a \`pending\` note that drops or changes its status is 400 \`bad_request\` with the rule \`status\`, and only an approval makes it active. With neither header, 428. ${WRITE_DESCRIPTION}`,
      parameters: [AGENT_ID, NOTE_PARAM, IF_MATCH, { name: "If-None-Match", in: "header", required: false, description: "`*`: create the note, only if the name is not taken, else 412.", schema: { type: "string", const: "*" } }],
      requestBody: {
        required: true,
        description: "The note's whole text: as text, or as JSON `{text}`, the form the console's page sends under its session (a write from the page is JSON from its own origin). A JSON body that is not an object is 400; a missing or wrong `text`, or another field, is 422 by field.",
        content: {
          "text/markdown": { schema: { type: "string" } }, "text/plain": { schema: { type: "string" } },
          "application/json": { schema: closed({ text: { type: "string", description: "The note's whole text, front matter included." } }) },
        },
      },
      responses: { "200": NOTE_TEXT("Edited: the note as it now is."), "201": NOTE_TEXT("Created: the note."), ...WRITE_ERRORS, ...errors(413, 415, 422) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/files/{file}/retire": {
    post: {
      operationId: "retireLearningFile", tags: ["agents"], summary: "Retire a note: out of the index, kept in history",
      description: `Sets \`status: retired\` (and drops \`superseded_by\`), on an active note or one that waits for its owner's OK (\`pending\`); any other note is answered as it is. A retire is how a person revokes a note, so only its format is checked: its front matter as retired, and the 4 KB cap with the status line on top (400 \`bad_request\` with \`problems\` otherwise). A secret shape or one of the host's values in its name or text never blocks it; the answer is cut of them. ${WRITE_DESCRIPTION}`,
      parameters: [AGENT_ID, NOTE_PARAM, IF_MATCH], responses: { "200": NOTE_TEXT("The note, retired."), ...WRITE_ERRORS }, ...MARK,
    },
  },
  "/runs/{run_id}/learning": {
    get: {
      operationId: "getRunLearning", tags: ["runs"], summary: "The run's learning whole: its seed, merge, verdict, problems and cost",
      parameters: [ref("parameters/RunId")], responses: { "200": json(RUN_LEARNING, "The run's learning, or null."), ...errors(401, 404, 429, 500) }, ...MARK,
    },
  },
  "/runs/{run_id}/learning/diff": {
    get: {
      operationId: "getRunLearningDiff", tags: ["runs"], summary: "What the run proposed, file by file",
      description: "404 for a run that does not learn, or whose merge is not in its agent's folder.",
      parameters: [ref("parameters/RunId")], responses: { "200": json(LEARNING_DIFF, "The run's diff."), ...errors(401, 404, 429, 500) }, ...MARK,
    },
  },
};
/** A file of an agent's home, listed as a run's file is (RunFile). */
const HOME_FILE = {
  type: "object", additionalProperties: false, required: ["path", "size_bytes", "modified_at"],
  properties: {
    path: { type: "string", description: "Relative to the agent's home, `/` between segments." },
    size_bytes: { type: "integer", minimum: 0 },
    modified_at: ref("schemas/Timestamp"),
    content_type: { type: ["string", "null"] },
    unreadable: { type: "boolean", const: true, description: "Present when this server cannot read the file (another user made it private): reading it answers 403 `system_file_forbidden` with `details.reason` `unreadable`." },
  },
};
/** A host-owned path of the home that is there: one entry by its name, with nothing of what is in it. */
const HOME_HOST_ENTRY = {
  type: "object", additionalProperties: false, required: ["path", "host_owned"],
  properties: {
    path: { type: "string", description: "Its name at the top of the home, as it is on disk (`learning`)." },
    host_owned: { type: "boolean", const: true, description: "A path of `capabilities.home.host_owned`: only the server writes it, and what is in it is read through the learning API (`/v2/agents/{agent_id}/learning`, on a server that has it), never listed or served here." },
  },
};
const HOME_FILES = {
  type: "object", additionalProperties: false, required: ["agent_id", "files", "complete", "truncated"],
  properties: { agent_id: ref("schemas/Id"), files: { type: "array", items: { oneOf: [HOME_FILE, HOME_HOST_ENTRY] } }, complete: { type: "boolean", description: "Always true here: the home is on this server's disk." }, truncated: { type: "boolean", description: "The list stopped at the server's cap: its count of files, or a directory more than 16 deep." } },
};
/** Where an agent's home's files are listed; each file's own path is below it. */
const HOME_FILES_AT = "/agents/{agent_id}/home/files";
const HOME_PATH = {
  name: "path", in: "path", required: true,
  description: "A path relative to the agent's home. It may hold `/` between segments, sent as is; each segment is percent-encoded. The server matches the rest of the URL after `/files/`.",
  schema: { type: "string", minLength: 1, maxLength: 1024 },
};
const RAW = { "application/octet-stream": { schema: { type: "string", contentMediaType: "application/octet-stream" } }, "*/*": { schema: { type: "string" } } };
const HOME_PATHS = "A path with an empty, `.` or `..` segment, a backslash, a NUL or a leading `/`, a segment that is not plain text (not its own NFC form, or holding a default-ignorable code point), or over 1024 characters, is `400 invalid_file_path`; a segment that starts with `.` is `403 system_file_forbidden`.";
const HOME_WRITES = "A path more than 16 directories deep, past where the list goes, is `400 invalid_file_path`. A path at or under one of `capabilities.home.host_owned` (`learning/`) is `403 system_file_forbidden` with `details.reason` `host_owned`: matched on the path as normalized, by its first segment folded (compatibility form, any case, no combining marks), so `./Learning/x` too, and by identity (the same device and inode) where that segment and the host-owned path are both on disk. A link on the way, or as the file, is `403 system_file_forbidden` with `details.reason` `link`: never followed. A path that names a directory, or runs through a file, is `400 invalid_file_path`. An archived agent's home is written as any other's. Where \`capabilities.home.writes\` is false (no /proc/self/fd, as on macOS), the write or delete is \`501 unsupported_here\`.";

/** This server's own routes, outside the contract. */
/** One JSON-RPC 2.0 message, and the answer to a request (POST /mcp). */
const RPC_MESSAGE = { type: "object", required: ["jsonrpc"], properties: { jsonrpc: { const: "2.0" }, id: { type: ["string", "number"] }, method: { type: "string" }, params: { type: "object" } } };
const RPC_ANSWER = {
  type: "object", required: ["jsonrpc", "id"],
  properties: { jsonrpc: { const: "2.0" }, id: { type: ["string", "number", "null"] }, result: {}, error: { type: "object", required: ["code", "message"], properties: { code: { type: "integer" }, message: { type: "string" } } } },
};
/** GET /files's answer: a page of this server's uploads, newest first. */
const FILE_LIST = { type: "object", additionalProperties: false, required: ["files", "next_cursor"], properties: { files: { type: "array", items: ref("schemas/File") }, next_cursor: { type: ["string", "null"] } } };

const EXTENSIONS: Record<string, Record<string, Json>> = {
  "/files": {
    get: {
      operationId: "listFiles", tags: ["files"], summary: "This server's uploads, newest first",
      description: "Every file reserved or sent here, pending or ready, a page at a time, so a file whose id was lost is found again. A run that copied a file keeps its copy whatever happens to the upload.",
      parameters: [ref("parameters/Limit"), ref("parameters/Cursor")],
      responses: { "200": json(FILE_LIST, "One page of files, newest first."), ...errors(400, 401, 429, 500) },
      "x-agentrun-serve": "files/1",
    },
  },
  "/files/{file_id}": {
    get: {
      operationId: "getFile", tags: ["files"], summary: "An upload's record",
      description: "The file as POST /files answered it, with its status now: `pending` until its bytes arrive, then `ready` with their `sha256`.",
      responses: { "200": json(ref("schemas/File"), "The file."), ...errors(401, 404, 429, 500) },
      "x-agentrun-serve": "files/1",
    },
    delete: {
      operationId: "deleteFile", tags: ["files"], summary: "Delete an upload",
      description: "Removes the file and its bytes, pending or ready. A run that already copied it into its workspace keeps its copy; a run started after names it in vain (`422` at `file_ids`).",
      responses: { "204": { description: "Deleted." }, ...errors(401, 404, 429, 500) },
      "x-agentrun-serve": "files/1",
    },
  },
  "/mcp": {
    post: {
      operationId: "callMcp", tags: ["local"], summary: "The MCP endpoint: this API's tools, for a coding agent",
      description:
        "The Model Context Protocol over Streamable HTTP: one JSON-RPC 2.0 message per POST (initialize, ping, tools/list, tools/call), answered as JSON, stateless: no stream (any other method is 405) and no session. Ten tools: whoami, agents_list, agents_create, agents_revise, runs_start, runs_get, runs_events, runs_files, runs_respond and runs_cancel. Each calls this API's routes in process, with the caller's token, and answers as they do: the route's JSON as structured content, a refusal as a result with isError and the route's error. A run is started, then polled; no call is held open for one. The token only: the page's session cookie is never taken here, and a browser Origin other than this server's own is 403. A refusal of the request itself carries a JSON-RPC error.",
      requestBody: { required: true, content: { "application/json": { schema: RPC_MESSAGE } } },
      responses: {
        "200": json(RPC_ANSWER, "The request's answer: its result, or its JSON-RPC error."),
        "202": { description: "A notification, or a response, taken. No body." },
        "400": json(RPC_ANSWER, "Not one JSON-RPC 2.0 request (a batch is not taken), or an MCP-Protocol-Version this server does not speak."),
        "401": json(RPC_ANSWER, "No token, or not this server's."),
        "403": json(RPC_ANSWER, "An Origin other than this server's own."),
        "413": json(RPC_ANSWER, "The body is over 1 MiB."),
        "415": json(RPC_ANSWER, "The body is not application/json."),
      },
      "x-agentrun-serve": "mcp/1",
    },
  },
  "/openapi.json": {
    get: {
      operationId: "getOpenapi", tags: ["capabilities"], summary: "This document", security: [{}],
      description: "Readable without a credential, as capabilities are.",
      responses: { "200": json({ type: "object" }, "The OpenAPI document: the contract, with this server's marks."), ...errors(429, 500) },
    },
  },
  "/health": {
    get: {
      operationId: "getHealth", tags: ["capabilities"], summary: "Whether this server can serve", security: [{}],
      description: "Readable without a credential: the store opens and the data directory's disk is above its floor. 503 with the same shape when either fails.",
      responses: {
        "200": json(HEALTH, "Healthy."),
        "503": json(HEALTH, "Not healthy: which check failed."),
        ...errors(429, 500),
      },
    },
  },
  "/runs": {
    get: {
      operationId: "listAllRuns", tags: ["runs"], summary: "Every agent's runs, newest first",
      parameters: [
        ref("parameters/Limit"), ref("parameters/Cursor"),
        { name: "agent", in: "query", required: false, description: "Only this agent's runs.", schema: ref("schemas/Id") },
        { name: "revision", in: "query", required: false, description: "Only runs of this revision.", schema: { type: "string" } },
        { name: "status", in: "query", required: false, description: "Only runs with this status.", schema: ref("schemas/RunStatus") },
        { name: "archived", in: "query", required: false, description: "true lists only archived runs; false, the default, the others.", schema: { type: "boolean" } },
      ],
      responses: { "200": json(ref("schemas/RunList"), "One page of runs, newest first."), ...errors(400, 401, 429, 500) },
    },
  },
  "/agents/{agent_id}/revisions": {
    get: {
      operationId: "listRevisions", tags: ["agents"], summary: "The agent's revisions, newest first",
      parameters: [ref("parameters/AgentId"), ref("parameters/Limit"), ref("parameters/Cursor")],
      responses: {
        "200": json({
          type: "object", required: ["revisions", "next_cursor"],
          properties: {
            revisions: {
              type: "array",
              items: {
                type: "object", required: ["revision", "version", "parent", "kind", "current", "note", "created_at", "definition"],
                properties: {
                  revision: { type: "string" }, version: { type: "integer", minimum: 1 }, parent: { type: ["string", "null"] },
                  kind: { type: "string", enum: ["agentic", "workflow"] }, current: { type: "boolean" }, note: { type: ["string", "null"] },
                  created_at: ref("schemas/Timestamp"), definition: ref("schemas/Definition"),
                },
              },
            },
            next_cursor: { type: ["string", "null"] },
          },
        }, "One page of the agent's revisions."),
        ...errors(400, 401, 404, 429, 500),
      },
    },
  },
  "/agents/{agent_id}/current": {
    post: {
      operationId: "setCurrent", tags: ["agents"], summary: "Make one of the agent's revisions current again",
      parameters: [ref("parameters/AgentId")],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["revision"], properties: { revision: { type: "string" } } } } } },
      responses: { "200": json(ref("schemas/Agent"), "The agent, its current revision the one named."), ...errors(401, 404, 415, 422, 429, 500) },
    },
  },
  "/stats": {
    get: {
      operationId: "getStats", tags: ["runs"], summary: "Counts and cost over every agent and run",
      description: "Read from the agent store's aggregates, and `learning` from the runs this server holds and its learning ledger, where each run's learning end is written: no run's files are opened. Archived agents and runs are left out of every number but their own counts. `from`, `to` and `agent` bound `analytics` and `learning` only; every other number is the whole store's.",
      parameters: [
        { name: "from", in: "query", required: false, description: "Runs started at or after this RFC 3339 date-time, to the millisecond (a finer fraction is a 400). Default no bound.", schema: { type: "string", format: "date-time" }, "x-agentrun-serve": "stats/2" },
        { name: "to", in: "query", required: false, description: "Runs started before this RFC 3339 date-time, to the millisecond (a finer fraction is a 400). Default no bound.", schema: { type: "string", format: "date-time" }, "x-agentrun-serve": "stats/2" },
        { name: "agent", in: "query", required: false, description: "One agent's runs.", schema: ref("schemas/Id"), "x-agentrun-serve": "stats/2" },
      ],
      responses: { "200": json(STATS, "The counts and the cost."), ...errors(400, 401, 429, 500) },
      "x-agentrun-serve": "stats/1",
    },
  },
  "/runs/{run_id}/graph": {
    get: {
      operationId: "getRunGraph", tags: ["runs"], summary: "A workflow run's graph, live",
      description: "The revision's workflow and its graph, each node's state (a map's items, a route's branch taken), the decisions with their receipts, the calls with their input and output, and the totals. Readable while the run goes. 404 for an agentic run.",
      parameters: [ref("parameters/RunId")],
      responses: { "200": json(RUN_GRAPH, "The run's graph as it stands."), ...errors(401, 404, 429, 500) },
    },
  },
  "/workflows/validate": {
    post: {
      operationId: "validateWorkflow", tags: ["agents"], summary: "Check a workflow definition without saving it",
      description: "Every issue a save of it as a workflow revision would refuse (the DSL's validation with code not run, a call node's tool the revision does not list, what the durable runner refuses before any step), each with its JSON Pointer path, and the DSL's warnings. Writes nothing. `tools` is the revision's tool list; absent, every tool this server binds.",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["workflow"], properties: { workflow: { type: "object" }, tools: { type: "array", items: { type: "string" } } } } } } },
      responses: { "200": json(VALIDATED, "The workflow's issues and warnings; ok when it has no issue."), ...errors(400, 401, 415, 422, 429, 500) },
    },
  },
  "/runs/{run_id}/pause": {
    post: {
      operationId: "pauseRun", tags: ["runs"], summary: "Pause a workflow run",
      description: "What is in flight finishes; no node, model call or decision starts until the run is resumed. The run's status reads `paused`, and stays so across a restart of the server. 501 for an agentic run, 409 not_continuable for an ended one.",
      parameters: [ref("parameters/RunId")],
      responses: { "200": json(PAUSED, "The run, paused."), ...errors(401, 404, 409, 429, 500) },
    },
  },
  "/runs/{run_id}/resume": {
    post: {
      operationId: "resumeRun", tags: ["runs"], summary: "Resume a paused workflow run",
      parameters: [ref("parameters/RunId")],
      responses: { "200": json(PAUSED, "The run, going again."), ...errors(401, 404, 409, 429, 500) },
    },
  },
  "/settings/tool-keys": {
    get: {
      operationId: "listToolKeys", tags: ["local"], summary: "The tool keys a person may save, and which are set: names only, never a value",
      responses: { "200": json(TOOL_KEYS_VIEW, "Each tool key, its fields and what it unlocks."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "toolkeys/1",
    },
  },
  "/settings/tool-keys/{key_id}": {
    put: {
      operationId: "saveToolKey", tags: ["local"], summary: "Save a tool key's fields, sealed",
      description: "Each value is sealed under the server's seal key and kept in the data directory as ciphertext alone; the key's other fields stay as they are. The key (the first field) is first checked against its provider with one call that costs nothing, given 5 s: a key the provider refuses (401) is 422 input_invalid, its field's reason `refused_by_provider` and the message in plain words with the provider's first sentence (never any of the key), and nothing is kept; otherwise it is kept, and GET's `check` says `accepted` or `not_checked` and why (a 403 is not_checked: a key scoped away from the check's call may still work for its tools). A save whose check is still waiting when the server begins to close keeps nothing (503 unavailable, while its connection lasts). 422 also for an unknown key or field, or a value that is empty, holds a control character or is over 1024 bytes; 409 key_set_by_server for a field the server is started with; 409 no_sealing_key when the server was handed no seal key.",
      parameters: [KEY_ID],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["values"], properties: { values: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } } } } } } },
      responses: { "204": { description: "Saved." }, ...errors(400, 401, 409, 415, 422, 429, 500, 503) },
      "x-agentrun-serve": "toolkeys/1",
    },
    delete: {
      operationId: "deleteToolKey", tags: ["local"], summary: "Forget a tool key's stored fields",
      description: "409 key_set_by_server when the server is started with every field of it.",
      parameters: [KEY_ID],
      responses: { "204": { description: "Forgotten." }, ...errors(401, 409, 422, 429, 500) },
      "x-agentrun-serve": "toolkeys/1",
    },
  },
  "/settings/tools": {
    get: {
      operationId: "getToolSettings", tags: ["capabilities"], summary: "The server's tool settings",
      description: "Each capability that has a choice, and its provider: web_search auto (the harness's own search or the model provider's hosted one, else Exa's keyless search), native (that alone), exa-keyless or parallel; web_fetch kernel or parallel. An agent's definition.tool_settings is over these. capabilities.tools say what each resolves to on each harness, and GET /agents/{agent_id} for that agent.",
      responses: { "200": json(TOOL_SETTINGS_ANSWER, "Each capability's provider."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "providers/1",
    },
    put: {
      operationId: "putToolSettings", tags: ["capabilities"], summary: "Set the providers of web_search and web_fetch",
      description: `Replaces the settings: a capability the body leaves out takes its default. Kept in the data directory, read by every run launched from then on, and capabilities say so at once. A pick of parallel without PARALLEL_API_KEY resolves unavailable, never to another provider. An unknown capability, a provider not offered for it, and a permission (422 not_yet, "${NOT_YET}") are refused.`,
      requestBody: { required: true, content: { "application/json": { schema: TOOL_SETTINGS } } },
      responses: { "200": json(TOOL_SETTINGS_ANSWER, "Each capability's provider now."), ...errors(400, 401, 415, 422, 429, 500) },
      "x-agentrun-serve": "providers/1",
    },
  },
  [HOME_FILES_AT]: {
    get: {
      operationId: "listHomeFiles", tags: ["agents"], summary: "Every file in the agent's home",
      description: "The agent's home is a directory of its own on this server's disk, kept across its runs (runs do not see it yet). Every regular file in it, recursively, listed as a run's files are (`GET /runs/{run_id}/files`): reached through no link, a name that starts with `.` left out. A home never written to lists none. A path of `capabilities.home.host_owned` that is there (`learning`) is one entry, `{path, host_owned: true}`, with none of what is in it.",
      parameters: [ref("parameters/AgentId")],
      responses: { "200": json(HOME_FILES, "The files."), ...errors(401, 404, 429, 500) },
      "x-agentrun-serve": "home/1",
    },
  },
  [`${HOME_FILES_AT}/{path}`]: {
    get: {
      operationId: "readHomeFile", tags: ["agents"], summary: "One file of the agent's home, raw",
      description: `Raw bytes with the file's content type, as a run's file is read (\`GET /runs/{run_id}/files/{path}\`): \`nosniff\`, a CSP on HTML, \`?download=1\` for an attachment. ${HOME_PATHS} A path at or under one of \`capabilities.home.host_owned\` (\`learning/\`), as normalized, folded and by identity on disk, is \`403 system_file_forbidden\` with \`details.reason\` \`host_owned\`. Its message names the learning API (\`/v2/agents/{agent_id}/learning\`) on a server that has that route, and says this server has none on one that does not. A link on the way is \`404 not_found\`.`,
      parameters: [ref("parameters/AgentId"), HOME_PATH, { name: "download", in: "query", required: false, description: "`1` forces a download.", schema: { type: "integer", enum: [0, 1], default: 0 } }],
      responses: {
        "200": { description: "The whole file.", headers: { "Content-Disposition": ref("headers/ContentDisposition"), "X-Content-Type-Options": ref("headers/NoSniff") }, content: RAW },
        ...errors(400, 401, 403, 404, 429, 500),
      },
      "x-agentrun-serve": "home/1",
    },
    put: {
      operationId: "writeHomeFile", tags: ["agents"], summary: "Write one file of the agent's home",
      description: `The raw body becomes the file, whole: written to a temporary file beside it and renamed over it (0600), the directories on the way made. Of two writes of one file at once, each lands whole and the last wins. A body over \`capabilities.home.max_file_bytes\` is \`413 payload_too_large\`. ${HOME_PATHS} ${HOME_WRITES}`,
      parameters: [ref("parameters/AgentId"), HOME_PATH],
      requestBody: { required: true, content: RAW },
      responses: { "200": json(HOME_FILE, "The file, as the list shows it."), ...errors(400, 401, 403, 404, 413, 429, 500, 501) },
      "x-agentrun-serve": "home/1",
    },
    delete: {
      operationId: "deleteHomeFile", tags: ["agents"], summary: "Delete one file of the agent's home",
      description: `Removes the file; a directory it leaves empty stays. A file that is not there is \`404 not_found\`. ${HOME_PATHS} ${HOME_WRITES}`,
      parameters: [ref("parameters/AgentId"), HOME_PATH],
      responses: { "204": { description: "The file is gone." }, ...errors(400, 401, 403, 404, 429, 500, 501) },
      "x-agentrun-serve": "home/1",
    },
  },
  ...archiving("agents", "Agent", ref("parameters/AgentId"), "The agent, with archived_at."),
  ...archiving("runs", "Run", ref("parameters/RunId"), "The run, with archived_at."),
  ...LEARNING_EXTENSIONS,
  "/settings/webhook": {
    get: {
      operationId: "getWebhook", tags: ["local"], summary: "The webhook this server POSTs run notices to, if one is set; never its secret",
      responses: { "200": json(WEBHOOK_VIEW, "The webhook, or `configured: false`."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "webhook/1",
    },
    put: {
      operationId: "saveWebhook", tags: ["local"], summary: "Set the webhook's URL",
      description: `Messages follow the Standard Webhooks spec (standardwebhooks.com), so a receiver verifies them with any of its libraries. Each is POSTed to \`url\` as JSON \`{type, timestamp, data}\`: \`run.needs_input\` when a run comes to need its person (status input_required; \`data.pending.kind\` \`question\` for an ask_person question, \`stopped\` for a stopped turn) and \`run.ended\` when it ends (completed, failed or cancelled), with \`data: {run_id, agent_id, status, title, url}\`, \`url\` the run on the page; never a tool's arguments, an output or an input, which the API reads. Headers: \`webhook-id\` (the same on every try, the receiver's idempotency key), \`webhook-timestamp\` (Unix seconds) and \`webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">\` under the secret's 32 bytes; a receiver refuses a timestamp more than 5 minutes from its clock. A try not answered 2xx in 15 s (no redirect followed) is tried again after about 5 s, 5 min, 30 min, 2 h, 5 h and 10 h, with jitter, then logged as failed; pending messages go on after a restart. A 410 turns the webhook off until it is set again. The first PUT makes the secret and answers 201 with it, once; a later PUT keeps it, turns the webhook on again and answers 200. 422 for a URL that is not http or https, holds a user or password, or is over 2048 characters; 409 no_sealing_key when the server was handed no seal key to keep the secret under.`,
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", format: "uri", maxLength: 2048 } } } } } },
      responses: {
        "201": json(closed({ ...WEBHOOK_SET_FIELDS, secret: WEBHOOK_SECRET }), "Set, with its secret, shown this once."),
        "200": json(WEBHOOK_SET, "Changed; the secret is kept."),
        ...errors(400, 401, 409, 415, 422, 429, 500),
      },
      "x-agentrun-serve": "webhook/1",
    },
    delete: {
      operationId: "deleteWebhook", tags: ["local"], summary: "Remove the webhook; its pending messages are dropped, the log of attempts is kept",
      responses: { "204": { description: "Removed." }, ...errors(401, 429, 500) },
      "x-agentrun-serve": "webhook/1",
    },
  },
  "/settings/webhook/test": {
    post: {
      operationId: "testWebhook", tags: ["local"], summary: "Send a `webhook.test` message now, once, and say how it went",
      description: "The body is `{type: \"webhook.test\", timestamp, data: {}}`, signed as every message is. It is tried once, never again, and kept in the log. 409 webhook_off when a 410 turned the webhook off: nothing is sent until a PUT sets it again.",
      responses: { "200": json(WEBHOOK_ATTEMPT, "Its attempt."), ...errors(401, 404, 409, 429, 500) },
      "x-agentrun-serve": "webhook/1",
    },
  },
  "/settings/webhook/deliveries": {
    get: {
      operationId: "listWebhookDeliveries", tags: ["local"], summary: `The last ${ATTEMPTS_KEPT} attempts, newest first`,
      responses: { "200": json(closed({ attempts: { type: "array", items: WEBHOOK_ATTEMPT } }), "Each attempt."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "webhook/1",
    },
  },
  "/settings/webhook/deliveries/{webhook_id}/redeliver": {
    post: {
      operationId: "redeliverWebhook", tags: ["local"], summary: "Send a message of the log again, once now, under the same webhook-id and body",
      description: "Signed again at a new timestamp. A message still pending that this try delivers is settled; one this try fails keeps its own schedule. 409 webhook_off when a 410 turned the webhook off.",
      parameters: [WEBHOOK_ID],
      responses: { "200": json(WEBHOOK_ATTEMPT, "Its attempt."), ...errors(401, 404, 409, 429, 500) },
      "x-agentrun-serve": "webhook/1",
    },
  },
};

let vendored: Json | undefined;
/** Why an escalated workflow run waits for a person. Such a run is `completed` with no error and no output; every other
 *  run's review is null. */
const REVIEW: Json = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "node", "reason", "at"],
      properties: {
        kind: { type: ["string", "null"], description: "The escalation's kind, as its escalate node names it (`coi_review`, say)." },
        node: { type: ["string", "null"], description: "The label of the node the run escalated at." },
        reason: { type: "string", description: "The escalation's summary: what the person is to look at." },
        at: { type: "string", format: "date-time", description: "When the run ended: its `ended_at`, one saved time." },
      },
    },
    { type: "null" },
  ],
  description: "Set when a workflow run escalated: it completed, and waits for a person to review it. Like every workflow run, it takes no messages (501 unsupported_here).",
  "x-agentrun-serve": "review/1",
};
const LEARNING_NULL = "Null for a run that does not learn: its agent's `learning` is not true, the server's learning was off when it started (`capabilities.features.learning`), or it is a workflow's or an imported run.";
/** A run's learning (runs.ts): whether it started from what its agent learned. */
const LEARNING = {
  oneOf: [
    closedWith({
      state: { enum: [...LEARNING_STATES], description: "`seeded` when the run started from what its agent learned; `reflecting` while its end-of-run turn runs, and until what it wrote is checked (after the run ended, so it may still read `reflecting` once the run reads completed or failed); `proposed` once the new notes passed the checks, while they are graded; `merged` once they are on the folder's main; `dropped` when learning was skipped or refused, with `reason`." },
      reason: LEARNING_REASON,
      detail: { type: ["string", "null"], maxLength: 300, description: "Where the run's learning stands, in one sentence in a person's words (at most 300 characters, ending in an ellipsis when cut; a note's name or the grader's reason in it is cut of the host's secrets as they are now before it is cut short, so none is shown in part), the same as its timeline row says: \"Started from 2 notes.\", \"Looking back on this run…\", \"Checking 1 new note…\", \"Learned: <note's name> (replaces 1 older note)\", \"Learned: <note's name>. Waiting for your OK: <note's name>.\", \"Nothing new to remember from this run.\", \"Not kept: <the grader's reason, its first sentence>\", \"Not kept: its notes weren't in the expected format.\", \"Not kept: learning stopped (<why>).\" and so on. Never a secret or a value from the input, cut of the host's secrets as they are now. For a person: a client that acts on it reads `state` and `reason`, whose codes do not change." },
      at: { type: "string", format: "date-time", description: "When the state last changed." },
    }, RUN_NOTES),
    { type: "null" },
  ],
  description: `What the run learns from and what it learned: a run of an agent whose \`learning\` is true starts from its agent's learning folder, the index of its notes in its instructions and the notes in \`.learning/\` in its working directory. Once it answers or fails, the server asks the same harness one more turn, under the run's cap, which answers with the notes it would keep (no tool is needed, and nothing the run writes in \`.learning/\` counts); what it answers is checked, graded by one grader (on the server's grade model or strong tier, else the agent's own model), and merged into the folder, or dropped. ${LEARNING_NULL}`,
  "x-agentrun-serve": "learning/1",
};
const LEARNING_SHORT = {
  oneOf: [closedWith({
    state: { enum: [...LEARNING_STATES] }, reason: LEARNING_REASON,
    detail: { type: ["string", "null"], maxLength: 140, description: "Run.learning's detail, in the same words, cut short: at most 140 characters, ending in an ellipsis when cut (a grader's long reason). Cut of the host's secrets first, so none is ever shown in part.", "x-agentrun-serve": "learning/2" },
  }, RUN_NOTES), { type: "null" }],
  description: `The run's learning, in short (GET /runs/{run_id} has it whole, with its whole detail and its time). ${LEARNING_NULL}`,
  "x-agentrun-serve": "learning/1",
};

/** What this server's run answers carry beyond the contract's Run and RunSummary: added before they were marked, so
 *  `serve/1`. */
const RUN_FIELDS: Record<string, Json> = {
  revision: { type: "string", description: "The id of the agent revision the run runs.", "x-agentrun-serve": "serve/1" },
  kind: { enum: ["agentic", "workflow"], description: "The revision's kind: an agentic run, or a workflow run.", "x-agentrun-serve": "serve/1" },
  archived_at: { type: ["string", "null"], description: "When the run, or its agent, was archived, while it is; else null.", "x-agentrun-serve": "serve/1" },
};
/** What a run waits on, one field for every kind, told apart by `kind`: here a question it asked a person. A later kind
 *  (a tool call waiting on approval) is one more variant of the same union. */
const PENDING: Json = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "question", "asked_at"],
      properties: { kind: { const: "question" }, question: { type: "string", description: "What it asked, at most 2000 characters." }, asked_at: { type: "string", format: "date-time" } },
      description: "A question the run asked a person (status input_required, state waiting): a message answers it.",
    },
    { type: "null" },
  ],
  description: "What the run waits on, told apart by kind; null when it waits on nothing. A run read from its stored row alone has ended, so null.",
  "x-agentrun-serve": "pending/1",
};
/** This server's own properties on the contract's objects, outside the contract, by where they go (a schema of
 *  components.schemas, then property names down to the object that takes them). Each is marked x-agentrun-serve with
 *  the addition that made it: `harness/1` and `place/1` are ones a later contract version would take on; `model/1` and
 *  `serve/1` are what this server added before it marked them. */
/** A run's place, as its start resolved it. */
const RUN_PLACE: Json = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { const: "runner" } } },
    { type: "object", additionalProperties: false, required: ["mode", "box"], properties: { mode: { const: "sandbox" }, box: { enum: [...BOX_IDS] } } },
  ],
  description: "Where the run executes, as its start resolved it: its revision's place, else runner. In a sandbox place the agent's bash runs in the box, which binds only the run's work/ and has no network and no key; read, write and edit run in the box too, or on this server's copy of that work/ where the box binds it and this server holds directory handles (Docker on Linux), following no link. Its loop, its log and every key stay on the server.",
  "x-agentrun-serve": "place/1",
};
const FIELD_EXTENSIONS: Record<string, Record<string, Json>> = {
  Run: {
    ...RUN_FIELDS,
    place: RUN_PLACE,
    learning: LEARNING,
    review: REVIEW,
    pending: PENDING,
    imported_from: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["source", "session"],
      properties: { source: { enum: ["claude-code", "codex", "pi"] }, session: { type: "string", description: "The session's id in its source." } },
      description: "Imported history (`agentrun-serve import`): where the run was run, and its session there; else null. An imported run takes no message (`409 not_continuable`, `details.reason` `imported`); a stop or a cancel answers as for an ended run.",
      "x-agentrun-serve": "imported/1",
    },
  },
  InputIssue: { code: { type: "string", description: "A workflow definition's issue: the DSL's validation code (`STATE_PATH_UNPRODUCED`, say), with `field` the path to it under `definition.workflow`.", "x-agentrun-serve": "validate/1" } },
  RunSummary: {
    ...RUN_FIELDS,
    effort: { $ref: "#/components/schemas/Effort", description: "The effort the run was started with, as the run shows it; absent when it was started with none.", "x-agentrun-serve": "effort/1" },
    error: { oneOf: [{ $ref: "#/components/schemas/RunError" }, { type: "null" }], description: "Set when `failed`, as the run's own.", "x-agentrun-serve": "serve/1" },
    learning: LEARNING_SHORT,
    review: REVIEW,
    pending: PENDING,
    imported_from: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["source", "session"],
      properties: { source: { enum: ["claude-code", "codex", "pi"] }, session: { type: "string", description: "The session's id in its source." } },
      description: "Imported history (`agentrun-serve import`): where the run was run, and its session there; else null. An imported run takes no message (`409 not_continuable`, `details.reason` `imported`); a stop or a cancel answers as for an ended run.",
      "x-agentrun-serve": "imported/1",
    },
  },
  RunError: {
    details: {
      type: "object", additionalProperties: false, required: ["reason"],
      properties: { reason: { enum: [LAUNCH_LOST] } },
      description: `Why the run failed, when its code alone does not say: \`${LAUNCH_LOST}\`, the server went down while it started the run's process, which never came up, so the next start failed the run rather than start it again.`,
      "x-agentrun-serve": "launch/1",
    },
  },
  TimelineRow: {
    learning: {
      ...closed({ state: { enum: [...LEARNING_STATES] }, reason: LEARNING_REASON, detail: { type: ["string", "null"] } }),
      description: `On a row of kind \`learning\` alone, labelled \`${LEARNING_LABEL}\`: where the run's learning ended (proposed, merged or dropped, \`seed_failed\` included), and why: one row, changed in place as it moves. Its \`summary\` and \`text\` are its \`detail\` (Run.learning.detail), in a person's words. The rows of the run's end-of-run turn are labelled \`${LEARNING_LABEL}\` too, its message and answer included, and are never the run's answer.`,
      "x-agentrun-serve": "learning/1",
    },
  },
  ErrorBody: {
    problems: { type: "array", items: PROBLEM, description: "`bad_request` from a write of a learning note only: each structural check it fails, printable (never a secret).", "x-agentrun-serve": "learning/1" },
  },
  RunFile: {
    unreadable: { type: "boolean", const: true, description: "Present when this server cannot read the file: a tool in the run's box created it private (owner-only). Reading it answers 403 `system_file_forbidden` with `details.reason` `unreadable`.", "x-agentrun-serve": "unreadable/1" },
  },
  DefinitionInput: {
    model: { type: "string", description: "`provider/model-id`, the model an agentic revision runs on; absent, this host's default. A workflow revision keeps none.", "x-agentrun-serve": "model/1" },
    thinking: { enum: [...THINKING_LEVELS], description: "An agentic revision's thinking level; absent, the model's. A workflow revision keeps none.", "x-agentrun-serve": "model/1" },
    harness: { enum: [...HARNESSES], description: "The harness that runs the revision. Absent on a request, pi; every answer names it. One this server does not run saves with a warning, and its runs are 409 agent_not_runnable naming it (capabilities.harnesses).", "x-agentrun-serve": "harness/1" },
    place: {
      oneOf: [
        { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { const: "runner" } } },
        { type: "object", additionalProperties: false, required: ["mode", "box"], properties: { mode: { const: "sandbox" }, box: { enum: [...BOX_IDS] } } },
      ],
      description: "Where the revision's runs execute: `runner` (no box and no shell) or `sandbox` (the agent's file and shell tools run in the box; its loop, its log and every key stay on the server). Absent, this host's default (capabilities.places.default), and an answer shows none; a revision keeps the place it names, runner included. An edit that names none keeps the agent's. A box this server does not have saves with a warning, and its runs are 409 agent_not_runnable naming it (capabilities.places.boxes). Only an agentic revision in a sandbox place may name `bash`; a workflow revision's place is runner or none (a sandbox place is 422).",
      "x-agentrun-serve": "place/1",
    },
    tool_settings: { ...TOOL_SETTINGS, description: "The agent's own settings of web_search and web_fetch (their provider), over the server's (GET /settings/tools); absent, the server's. A grant in tools names the capability, never a provider.", "x-agentrun-serve": "providers/1" },
    learning: { type: "boolean", default: false, description: "Whether an agentic revision's runs learn: each starts from what its agent has learned, the index of its notes in its instructions under `# Learned` and the notes in `.learning/` in its working directory, and once it answers or fails is asked one more turn to add notes there, which are checked, graded and merged. Kept when a definition says so, true or false; absent, off, and an answer shows none. An edit that leaves it out keeps the agent's. A workflow revision keeps none. On a server whose learning is off (`capabilities.features.learning`), no run learns, whatever this says.", "x-agentrun-serve": "learning/1" },
  },
  AgentCreate: {
    note: { type: "string", maxLength: 2000, description: "What the revision changes, kept with it (GET /agents/{agent_id}/revisions).", "x-agentrun-serve": "definitionbody/1" },
  },
  Agent: {
    tools: AGENT_TOOLS,
    kind: { enum: ["agentic", "workflow", null], description: "The current revision's kind; null before the agent has one.", "x-agentrun-serve": "serve/1" },
    revision: { type: ["string", "null"], description: "The current revision's id; null before the agent has one.", "x-agentrun-serve": "serve/1" },
    revisions: { type: "integer", minimum: 0, description: "How many revisions the agent has.", "x-agentrun-serve": "serve/1" },
    archived_at: { type: ["string", "null"], description: "When the agent was archived, while it is; else null.", "x-agentrun-serve": "serve/1" },
  },
  Capabilities: {
    learning: {
      type: "object", additionalProperties: false, required: ["grade_model", "pending"],
      properties: {
        grade_model: { type: ["string", "null"], description: "The model that grades what a run proposes to learn: `--grade-model` (AGENTRUN_SERVE_GRADE_MODEL), else the strong tier (AGENT_MODEL_STRONG), named as the strong tier takes one; null when the server names none, and each run is graded on its agent's own model." },
        pending: { type: "boolean", const: true, description: "A risky rule, one a run's user asked for or one the run worked out (to trust a site or a seller, skip or loosen an approval or a check, or send money or data somewhere), is kept to wait for its owner's OK: committed as a note with status `pending`, in no MEMORY.md and read by no run. This server has no route that approves one yet; a person can retire it." },
      },
      description: "How this server judges what a run proposes to learn.",
      "x-agentrun-serve": "learning/1",
    },
    places: {
      type: "object", additionalProperties: false, required: ["modes", "default", "boxes"],
      properties: {
        modes: { type: "array", items: { enum: [...PLACE_MODES] } },
        default: { enum: [...PLACE_MODES], description: "The mode a revision that names no place runs in here." },
        boxes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "available"], properties: { id: { enum: [...BOX_IDS] }, available: { type: "boolean" }, reason: { type: "string" } } } },
      },
      description: "The places a revision may name, this host's default, and each box: whether this server has it, and when not, why.",
      "x-agentrun-serve": "place/1",
    },
    harnesses: {
      type: "array",
      description: "Each harness a revision may name, and whether this server runs it; when not, why. A harness whose one run needs more memory than this server has for runs is unavailable, its reason naming the numbers, and its runs are 409 agent_not_runnable.",
      items: { type: "object", additionalProperties: false, required: ["id", "available", "steer", "default_model", "run_memory_mib", "max_concurrent_runs"], properties: { id: { enum: [...HARNESSES] }, available: { type: "boolean" }, run_memory_mib: { type: "integer", minimum: 1, description: "The memory a run of this harness reserves while its process lives, in MiB, measured. A start is admitted while the runs going and it fit in this server's memory less its own; over that, 429 rate_limited with retry-after, as over `limits.max_concurrent_runs`." }, max_concurrent_runs: { type: "integer", minimum: 0, description: "The most runs of this harness alone at once here: by memory and by the cap on the count, whichever is fewer. 0 when one never fits. `limits.max_concurrent_runs` is pi's, the smallest run." }, default_model: { type: ["string", "null"], description: "The model this server runs for the harness when a definition names none (provider/model-id), or null when it runs none: the harness does not run here, or no default model here runs on it." }, steer: { type: "boolean", description: "Whether a message sent while the run works lands mid-turn (`steer`); when false, it waits for the turn's end and the answer's mode is `follow_up`." }, reason: { type: "string" } } },
      // harness/2: each entry took on its memory and count (run_memory_mib, max_concurrent_runs). A client that validates
      // against harness/1 refuses them, so it is a mark of its own.
      "x-agentrun-serve": "harness/2",
    },
    tools: {
      type: "array",
      description: "Every tool a revision may name (this server's closed table): whether a workflow's model nodes may use it (`nodes`), whether its code may call it (`calls`), and whether it runs here, else the variables it is missing.",
      items: {
        type: "object", additionalProperties: false, required: ["name", "summary", "nodes", "calls", "available", "harnesses"],
        properties: {
          name: { type: "string" }, summary: { type: "string" }, nodes: { type: "boolean" }, calls: { type: "boolean" }, call_only: { type: "boolean", description: "Only a workflow's call node runs it (pdf_pages, llm): no agentic revision or model node names it." }, sandbox_only: { type: "boolean", description: "Only an agent whose place is a sandbox names it (bash): it runs in the box, and a runner has no shell." }, available: { type: "boolean" }, reason: { type: "string", description: "Why the tool is unavailable here, present whenever `available` is false: a provider pick's own words (`web_search is turned off in settings`, `parallel picked, no PARALLEL_API_KEY`), or `Needs` and the variables it is missing; for a sandbox-only tool (bash) that no box this server has can run, `no box is set up on this server: …` with each box's own reason (`places.boxes`)." }, missing: { type: "array", items: { type: "string" } },
          harnesses: { type: "array", items: { enum: [...HARNESSES] }, description: "The harnesses that run the tool here; a revision naming it on another harness saves with a warning and its runs are 409 agent_not_runnable.", "x-agentrun-serve": "tool-harness/1" },
          providers: { type: "array", items: { type: "string" }, description: "A tool with a provider choice: the providers offered for it, its default first.", "x-agentrun-serve": "providers/1" },
          provider: { type: "string", description: "A tool with a provider choice: the server's, its default where it sets none.", "x-agentrun-serve": "providers/1" },
          default_provider: { type: "string", description: "A tool with a provider choice: the built-in default.", "x-agentrun-serve": "providers/1" },
          resolves: { ...RESOLVES, "x-agentrun-serve": "providers/1" },
          key: { enum: TOOL_KEYS.map((row) => row.id), description: "The tool key that unlocks it (GET /settings/tool-keys' id): saved there, it is read by name like a secret the server is started with, and the tool's `missing` goes at once. Absent when no tool key does.", "x-agentrun-serve": "toolkeys/1" },
        },
      },
      "x-agentrun-serve": "serve/1",
    },
    workflows: {
      type: "object", additionalProperties: false, required: ["nodes", "node_tools", "adapters", "decisions"],
      properties: {
        nodes: { type: "array", items: { type: "string" } }, node_tools: { type: "array", items: { type: "string" } }, adapters: { type: "array", items: { type: "string" } },
      },
      description: "What a workflow revision's run gets: the model nodes it runs, the tools they may name, the adapters it binds, and the decision providers its typed questions run on.",
      "x-agentrun-serve": "serve/1",
    },
    links: { type: "object", additionalProperties: false, required: ["openapi"], properties: { openapi: { type: "string" } }, description: "This document's address.", "x-agentrun-serve": "serve/1" },
    home: {
      type: "object", additionalProperties: false, required: ["disk", "host_owned", "max_file_bytes", "writes"],
      properties: {
        disk: { enum: ["local"], description: "Where the homes are: this server's disk, under its data directory." },
        host_owned: { type: "array", items: { type: "string" }, description: "The paths in a home only the server writes, never served here: each that is there is one entry of the list (`host_owned: true`), and a GET, PUT or DELETE at or under one, matched by its name folded (compatibility form, any case, no combining marks) or by identity on disk, is 403 `system_file_forbidden`." },
        max_file_bytes: { type: "integer", minimum: 1, description: "The largest file a PUT takes: `limits.max_body_bytes`. Over it, 413 `payload_too_large` naming `max_body_bytes`." },
        writes: { type: "boolean", description: "Whether PUT and DELETE write a home's files here. True only where this server reaches its held directory handles through /proc/self/fd (Linux), probed once at start, the probe its confinement walks by; false elsewhere (macOS), where both answer 501 `unsupported_here` and nothing is written or removed. The list and reads work either way." },
      },
      description: "Each agent's home: a directory of its own (its id in lower case and 16 hex digits of the id's SHA-256, so ids that differ only in case never share one), kept across its runs, its files listed, read, written and deleted at `/agents/{agent_id}/home/files`.",
      "x-agentrun-serve": "home/1",
    },
    secrets: {
      type: "object", additionalProperties: false, required: ["names", "handoff", "condition", "limit"],
      properties: { names: { type: "array", items: { type: "string" } }, handoff: { enum: ["pipe"] }, condition: { type: "string" }, limit: { type: "string" } },
      description: "How this server holds its secrets: the names it treats as secrets, handed over a pipe, the condition that rests on, and what it does not cover.",
      "x-agentrun-serve": "serve/1",
    },
  },
  // decisions/2: the providers took on parallel (and, here, openrouter). A client that validates against decisions/1 refuses it, so the
  // widening is a mark of its own.
  "Capabilities/workflows": {
    decisions: {
      type: "object", additionalProperties: false, required: ["providers"],
      description: "The decision providers a workflow's typed questions (judge, pick, sift, route, ask) run on, and whether this server runs each: when not, why (`reason`); when it runs in a way an operator should know of, a `note`. `runJudge` is among `adapters` once one runs.",
      properties: {
        providers: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "available"], properties: { id: { enum: ["jev", "parallel", "openrouter"] }, available: { type: "boolean" }, reason: { type: "string" }, note: { type: "string" } } } },
      },
      "x-agentrun-serve": "decisions/2",
    },
  },
  "Capabilities/models": {
    fast: { type: ["string", "null"], description: "`provider/model` of the fast tier, when one is fixed.", "x-agentrun-serve": "serve/1" },
    strong: { type: ["string", "null"], description: "`provider/model` of the strong tier, when one is fixed.", "x-agentrun-serve": "serve/1" },
    route_prefix: { type: ["string", "null"], description: "With `source` `gateway`, the routing prefix this server puts before the gateway's model ids (`agent-model`): every tier's model and every harness's `default_model` here is the prefix, a slash and the gateway's own id. Null with any other source, where ids are shown whole.", "x-agentrun-serve": "model/2" },
    ready: { type: "boolean", description: "Whether a revision that names no model runs here: the host names a default (`AGENT_MODEL`), or a model provider's key is here, saved (`PUT /settings/tool-keys/{key_id}`, a `model` key) or the server's own, and gives its default model, the first of anthropic, openai, openrouter that has one.", "x-agentrun-serve": "toolkeys/1" },
    needs: { enum: ["key", "model", null], description: "When `ready` is false, what would make it true: `key`, a model provider's key (none is here, or the default model's provider has none); `model`, another default model (`AGENT_MODEL` names one this server does not know). Null when ready.", "x-agentrun-serve": "toolkeys/1" },
  },
  Features: {
    archive: {
      type: "object", additionalProperties: false, required: ["agents", "runs", "list_param", "routes"],
      properties: { agents: { type: "boolean" }, runs: { type: "boolean" }, list_param: { type: "string" }, routes: { type: "array", items: { type: "string" } } },
      description: "Archiving agents and runs: hidden from the lists, kept with their history.",
      "x-agentrun-serve": "serve/1",
    },
    thinking: { type: "array", items: { type: "string" }, description: "The thinking levels an agentic revision may name.", "x-agentrun-serve": "serve/1" },
    learning: { enum: [...LEARNING_MODES], description: "This server's learning switch (`--learning`): `on`, a run of an agent whose definition says `learning: true` starts from what its agent learned and adds to it; `off`, no run this server starts does, whatever its agent says, and its `learning` is null.", "x-agentrun-serve": "learning/1" },
    tool_keys: {
      type: "object", additionalProperties: false, required: ["routes", "at_rest"],
      properties: { routes: { type: "boolean" }, at_rest: { enum: ["sealed", "unavailable"] } },
      description: "GET, PUT and DELETE /settings/tool-keys: a tool's key saved by name, kept `sealed` under the seal key the server was handed; `unavailable` with none, when nothing is kept.",
      "x-agentrun-serve": "toolkeys/1",
    },
    tool_permissions: { type: "boolean", description: "Whether a tool setting may carry a permission: false until the tool gate lands, and a save that names one is 422 not_yet.", "x-agentrun-serve": "providers/1" },
    webhooks: {
      type: "object", additionalProperties: false, required: ["routes", "events", "signing", "at_rest"],
      properties: { routes: { type: "boolean" }, events: { type: "array", items: { enum: [...WEBHOOK_EVENTS] } }, signing: { const: "standard-webhooks/v1" }, at_rest: { enum: ["sealed", "unavailable"] } },
      description: "/settings/webhook: one URL each of `events` is POSTed to, signed by the Standard Webhooks spec; its secret kept `sealed` under the seal key the server was handed, `unavailable` with none, when no webhook is set.",
      "x-agentrun-serve": "webhook/1",
    },
  },
  "Features/agents": { revisions: { type: "boolean", description: "`GET /agents/{agent_id}/revisions` and `POST /agents/{agent_id}/current`.", "x-agentrun-serve": "serve/1" } },
  "Features/runs": {
    pause_workflow_runs: { type: "boolean", description: "POST /runs/{run_id}/pause and /resume hold and release a workflow run.", "x-agentrun-serve": "pause/1" },
    graph: { type: "boolean", description: "GET /runs/{run_id}/graph draws a workflow run, live.", "x-agentrun-serve": "pause/1" },
    list: { type: "boolean", description: "`GET /runs`.", "x-agentrun-serve": "serve/1" },
    kinds: { type: "array", items: { enum: ["agentic", "workflow"] }, description: "The kinds of run this server starts.", "x-agentrun-serve": "serve/1" },
  },
  "Features/timeline": { live_workflow_rows: { type: "boolean", description: "Whether a workflow run's rows arrive while it runs.", "x-agentrun-serve": "serve/1" } },
};

/** What a run refused `409 agent_not_runnable` holds in `error.details` here: what keeps its revision from running
 *  (server.ts, from runnable.ts's blockers), or, for an archived agent, when it was archived (server.ts, runs.ts). */
const BLOCKED_DETAILS = {
  type: "object", additionalProperties: false, required: ["unbound", "missing"],
  properties: {
    unbound: { type: "array", items: { type: "string" }, description: "The tools the revision names that this server does not bind, or does not bind on its harness." },
    missing: { type: "object", additionalProperties: { type: "array", items: { type: "string" } }, description: "Each bound tool this host cannot run yet, with the variables it is missing." },
    harness: { enum: [...HARNESSES], description: "The revision's harness, when this server does not run it (capabilities.harnesses)." },
    box: { enum: [...BOX_IDS], description: "The box of the revision's place, when this server does not have it (capabilities.places.boxes)." },
    adapters: { type: "array", items: { type: "string" }, description: "A workflow revision: the adapters it needs that this server does not bind." },
    code: { type: "boolean", description: "A workflow revision: whether it needs code this server does not run." },
    tier: { type: "string", description: "A workflow revision: the model tier this host has no model for." },
    decisions: { type: "object", description: "A workflow revision: each decision provider it needs that this host has not set up, with why and the variables it needs.", additionalProperties: { type: "object", additionalProperties: false, required: ["reason", "needs"], properties: { reason: { type: "string" }, needs: { type: "array", items: { type: "string" } } } } },
  },
};
const ARCHIVED_DETAILS = {
  type: "object", additionalProperties: false, required: ["archived_at"],
  properties: { archived_at: { type: "string", format: "date-time", description: "When the agent was archived: unarchive it to run it." } },
};
const NOT_RUNNABLE_DETAILS = { oneOf: [BLOCKED_DETAILS, ARCHIVED_DETAILS] };
/** What a file refused `403 system_file_forbidden` holds in `error.details` here, when it holds any (a dot-name holds none). */
const FORBIDDEN_DETAILS = {
  type: "object", additionalProperties: false, required: ["reason"],
  properties: { reason: { enum: ["unreadable", "host_owned", "link"], description: "`unreadable`: another user made the file private. `host_owned`: a read, write or delete in an agent's home at or under a path only the server writes, in any case. `link`: a write or a delete in an agent's home through a link." } },
};

/** The contract as vendored, read once. */
function contract(): Json {
  vendored ??= JSON.parse(readFileSync(new URL("./openapi/agentrun-v2.openapi.json", import.meta.url), "utf8")) as Json;
  return vendored;
}

/** The document: the contract, its operations this server turns off marked with why (`capabilityOf` gives an
 *  operation's capability here, by its operationId), and this server's own routes added and marked. */
export function openapiDocument(capabilityOf: (operationId: string) => string | undefined): Json {
  const doc = structuredClone(contract()) as Json & { info: Json; paths: Record<string, Record<string, Json>> };
  const unsupported: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const capability = typeof op.operationId === "string" ? capabilityOf(op.operationId) : undefined;
      if (capability === undefined) continue;
      op["x-agentrun-serve-unsupported"] = { capability, reason: UNSUPPORTED[capability] ?? "This server does not offer it." };
      unsupported.push(`${method.toUpperCase()} ${path}`);
    }
  }
  const schemas = (doc.components as Json).schemas as Record<string, Json>;
  const fields: string[] = [];
  for (const [where, added] of Object.entries(FIELD_EXTENSIONS)) {
    const [name, ...down] = where.split("/");
    let object = schemas[name!] as Json & { properties: Record<string, Json> };
    for (const key of down) object = object.properties[key] as Json & { properties: Record<string, Json> };
    for (const [field, schema] of Object.entries(added)) {
      object.properties[field] = schema;
      fields.push([name, ...down, field].join("."));
    }
  }
  // The contract's definition fields this server refuses (validate.ts), each marked with the reason its 422 gives.
  const definition = schemas.DefinitionInput as Json & { properties: Record<string, Json> };
  const refused: string[] = [];
  for (const field of Object.keys(definition.properties)) {
    if (DEFINITION_FIELDS.includes(field)) continue;
    definition.properties[field] = { ...definition.properties[field], "x-agentrun-serve-unsupported": { reason: NOT_KEPT[field] ?? `The definition keeps no field ${field}.` } };
    refused.push(`DefinitionInput.${field}`);
  }
  // PUT .../definition takes the contract's body (the definition itself) or this server's own, POST /agents' body with a
  // note: exactly one, as only this server's holds `definition` and both are closed. If-Match is the contract's
  // precondition for its body; this server's own body may leave it out.
  const update = (doc.paths["/agents/{agent_id}/definition"] as Json).put as Json;
  const media = ((update.requestBody as Json).content as Json)["application/json"] as Json;
  media.schema = { oneOf: [media.schema as Json, { $ref: "#/components/schemas/AgentCreate" }] };
  for (const parameter of update.parameters as Json[]) {
    if (parameter.name === "If-Match") Object.assign(parameter, { required: false, description: `${parameter.description} Required with the contract's body; this server's own body (\`{definition, skills?, note?}\`) may leave it out.` });
  }
  // What this server changes in a contract operation, by the addition that made it.
  update["x-agentrun-serve-changed"] = { requestBody: "definitionbody/1", "If-Match": "definitionbody/1" };
  const changed = ["PUT /agents/{agent_id}/definition"];
  // A workflow run's decisions are rows of its timeline here (decision-rows.ts), of a kind the contract does not list.
  const timelineKind = schemas.TimelineKind as Json & { enum?: string[] };
  if (Array.isArray(timelineKind.enum) && !timelineKind.enum.includes("decision")) {
    timelineKind.enum = [...timelineKind.enum, "decision"];
    timelineKind["x-agentrun-serve"] = "decision-rows/1";
    fields.push("TimelineKind.decision");
  }
  // A timeline page of at most `limit` rows: the contract's pages hold up to 500, more than a small client reads at once.
  const timeline = (doc.paths["/runs/{run_id}/timeline"] as Json).get as Json;
  timeline.parameters = [...(timeline.parameters as Json[]), { name: "limit", in: "query", required: false, description: "At most this many rows in a page (1 to 500, default 500); has_more says when another waits.", schema: { type: "integer", minimum: 1, maximum: 500, default: 500 } }];
  timeline["x-agentrun-serve-changed"] = { limit: "timelinelimit/1" };
  changed.push("GET /runs/{run_id}/timeline");
  // upload/2: POST /files also takes a file's bytes in one call (`path` in the query, the bytes the body), answered as
  // a reservation is with the file ready; and `upload.url` is a path from the server's root, `/v2/files/{file_id}`.
  const createFile = (doc.paths["/files"] as Json).post as Json & { requestBody: Json & { content: Record<string, Json> }; parameters: Json[]; responses: Record<string, Json> };
  createFile.requestBody.description = "Without `path` in the query: the contract's JSON reservation (application/json, FileCreate), its bytes sent after with PUT /files/{file_id}. With `path` in the query: the file's bytes themselves, in any type, application/json included (a multipart form is 415), sent in one call, the length the body's and the hash its own.";
  Object.assign(createFile.requestBody.content, structuredClone(RAW));
  const query = (name: string, description: string, schema: Json) => ({ name, in: "query", required: false, description, schema });
  createFile.parameters = [
    ...createFile.parameters,
    query("path", "With the file's bytes as the body: the file's path (FilePathString). Its presence makes the body the file.", ref("schemas/FilePathString")),
    query("content_type", "With `path`: the file's type. Absent, the request's own type when it names one (not application/octet-stream, not application/x-www-form-urlencoded), else the path's extension's, else application/octet-stream.", { type: "string" }),
    query("sha256", "With `path`: the hash the bytes must have (`422 input_invalid` at sha256 when they do not).", { type: "string", pattern: "^[0-9a-f]{64}$" }),
  ];
  createFile.responses["201"] = { ...createFile.responses["201"], description: "The file and where to send its bytes; sent in one call, the file is ready. `upload.url` is a path from the server's root (`/v2/files/{file_id}`): resolve it against the server's address, do not append it to the `/v2` base." };
  createFile.responses["415"] = ref("responses/UnsupportedMediaType");
  createFile["x-agentrun-serve-changed"] = { requestBody: "upload/2", parameters: "upload/2", responses: "upload/2" };
  changed.push("POST /files");
  // models/2: capabilities' `models.source` takes on the values this server answers with that the contract's enum (managed,
  // chatgpt, env, faux) lacks, `gateway` and `providers`. A client that validates against the contract's enum refuses them,
  // so the widening is a mark of its own, each value listed, as RunStatus's `paused` is.
  const modelsSource = ((((schemas.Capabilities as Json).properties as Record<string, Json>).models as Json).properties as Record<string, Json>).source as Json & { enum?: string[] };
  const sourcesAdded = MODEL_SOURCES.filter((value) => Array.isArray(modelsSource.enum) && !modelsSource.enum.includes(value));
  if (sourcesAdded.length) {
    modelsSource.enum = [...modelsSource.enum!, ...sourcesAdded];
    modelsSource.description = "Where this server's models come from. `gateway`: every model through the OpenAI-compatible gateway at `AGENT_MODEL_BASE_URL`, its ids under `route_prefix`. `providers`: each model from its own provider, with that provider's key. `faux`: a scripted model, with no key and no network. `managed`, `chatgpt` and `env` are the hosted API's.";
    modelsSource["x-agentrun-serve"] = "models/2";
    fields.push(...sourcesAdded.map((value) => `Capabilities.models.source.${value}`));
  }
  // A workflow run pauses here (POST /runs/{run_id}/pause): its status reads `paused` until it is resumed.
  const runStatus = schemas.RunStatus as Json & { enum?: string[] };
  if (Array.isArray(runStatus.enum) && !runStatus.enum.includes("paused")) {
    runStatus.enum = [...runStatus.enum.slice(0, runStatus.enum.indexOf("working") + 1), "paused", ...runStatus.enum.slice(runStatus.enum.indexOf("working") + 1)];
    runStatus["x-agentrun-serve"] = "pause/1";
    fields.push("RunStatus.paused");
  }
  // A paid tool's charges (monid's) are a meter of their own on /usage, beside the model's tokens.
  const meter = schemas.Meter as Json & { enum?: string[] };
  if (Array.isArray(meter.enum) && !meter.enum.includes("tools")) {
    meter.enum = [...meter.enum, "tools"];
    meter["x-agentrun-serve"] = "toolcost/1";
    fields.push("Meter.tools");
  }
  // A run's learning row (runs.ts) beside the contract's row kinds, and GET /usage's `learning` meter (usage.ts): what a
  // run's grade spends on this server, outside any run.
  for (const [name, value] of [["TimelineKind", "learning"], ["Meter", "learning"]] as const) {
    const schema = schemas[name] as Json & { enum?: string[] };
    if (!Array.isArray(schema.enum) || schema.enum.includes(value)) continue;
    schema.enum = [...schema.enum, value];
    // A schema two additions widen keeps the first one's mark; each value's own mark is in info's fields.
    schema["x-agentrun-serve"] ??= "learning/1";
    fields.push(`${name}.${value}`);
  }
  // This server's own error codes (errors.ts), beside the contract's closed list.
  const errorCode = schemas.ErrorCode as Json & { enum?: string[] };
  const own = Object.keys(ERROR_STATUS).filter((code) => Array.isArray(errorCode.enum) && !errorCode.enum.includes(code));
  if (own.length) {
    errorCode.enum = [...errorCode.enum!, ...own];
    // The newest addition that widened it: a client that validates against toolkeys/1 refuses precondition_required.
    errorCode["x-agentrun-serve"] = "learning/1";
    fields.push(...own.map((code) => `ErrorCode.${code}`));
  }
  const details = ((schemas.ErrorBody as Json).properties as Record<string, Json>).details!;
  details["x-agentrun-serve-details"] = { agent_not_runnable: NOT_RUNNABLE_DETAILS, system_file_forbidden: FORBIDDEN_DETAILS };
  const extensions: string[] = [];
  for (const [path, item] of Object.entries(EXTENSIONS)) {
    for (const [method, op] of Object.entries(item)) {
      (doc.paths[path] ??= {})[method] = { "x-agentrun-serve": true, ...op };
      extensions.push(`${method.toUpperCase()} ${path}`);
    }
  }
  doc.info["x-agentrun-serve"] = {
    description: "Served by @parcha/agentrun-serve: the contract as vendored, unchanged, with this server's marks. Operations and schema properties marked x-agentrun-serve are this server's own, outside the contract (fields lists the properties, each marked with the addition that made it); operations marked x-agentrun-serve-unsupported answer 501 unsupported_here here; operations marked x-agentrun-serve-changed take more than the contract gives, each change named (changed lists them); a contract property marked x-agentrun-serve-unsupported is one this server refuses (unsupported_fields, with why); x-agentrun-serve-details gives what a code's details hold here (details lists where). servers is this server, relative to this document; the contract's own are in contract_servers.",
    extensions,
    changed,
    fields,
    unsupported_fields: refused,
    details: ["ErrorBody.details"],
    unsupported,
    contract_servers: doc.servers,
  };
  // This document is read from the server it describes, wherever it is published: a client generated from it calls
  // that server, not the first of the contract's.
  doc.servers = [{ url: "/v2", description: "This server." }];
  return doc;
}
