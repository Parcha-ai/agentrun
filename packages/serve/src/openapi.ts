// The OpenAPI document this server serves at GET /v2/openapi.json: the agentrun.v2/0 contract as vendored in
// src/openapi/agentrun-v2.openapi.json (its source is in its info), with this server's marks. The contract's operations are
// not changed: an operation answered 501 here carries `x-agentrun-serve-unsupported` with the reason, and this server's
// own routes are added as operations marked `x-agentrun-serve` (true, or the addition that made it, as `stats/1`), listed
// in `info.x-agentrun-serve`.
import { readFileSync } from "node:fs";
import { NOTE_ORIGINS, NOTE_STATUSES, NOTE_TYPES } from "./learn/index.js";
import { ERROR_STATUS } from "./errors.js";
import { LAUNCH_LOST, SETUP_LOST } from "./files.js";
import { HARNESSES } from "./harness.js";
import { LEARNING_LABEL, LEARNING_MODES, LEARNING_REASONS, LEARNING_STATES } from "./learning.js";
import { MODEL_SOURCES, THINKING_LEVELS } from "./model.js";
import { BOX_IDS, BOX_NETWORKS, BOX_STATES } from "./boxes.js";
import { PLACE_MODES } from "./place.js";
import { TOOL_KEYS, UNREADABLE } from "./tool-keys.js";
import { MCP_AUTH_TYPES, MCP_SERVER_NAME } from "./mcp-servers.js";
import { MCP_SETTINGS_PAGE } from "./mcp-oauth.js";
import { ATTEMPTS_KEPT, MESSAGE_TYPES, WEBHOOK_EVENTS } from "./webhooks.js";
import { HOOK_TOLERANCE_S } from "./trigger-secrets.js";
import { CATCHUP_WINDOW_S, DUE_KEPT, FAILURES_TO_PAUSE, FIRING_STATUSES, PAYLOAD_KEPT_BYTES, HISTORY_KEPT, MAX_EVERY_S, MIN_EVERY_S, OVERLAP, SOURCE_KINDS, TARGET_KINDS } from "./triggers.js";
import { DEFINITION_FIELDS, NOT_KEPT } from "./validate.js";
import { NOT_SET_UP } from "./runnable.js";
import { APPROVAL_ROW, ARGS_PREVIEW_BYTES, PERMISSIONS } from "./tool-gate.js";
import { LEGACY_NAMES, permissionsOf, type Pickable, PICKABLE, PROVIDERS, TABLE_TOOLS } from "./tool-plane.js";

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
  type: "object", additionalProperties: false, required: ["run", "workflow", "graph", "nodes", "decisions", "effects", "totals", "read_at"],
  properties: {
    read_at: { type: "string", format: "date-time", description: "When the view shown was read: the run process's last live view while it goes, else the read itself." },
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
      harnesses: { type: "array", items: { enum: [...HARNESSES] }, description: "The harnesses that run the tools in `unlocks`: the union of their `harnesses` in capabilities' `tools`. A `model` key's: pi and the provider's own harness (OpenRouter's, all three), of those capabilities' `harnesses` say this server runs or would run once the key is set: one unavailable only for want of a model key is listed before the key is saved." },
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
          closed({ state: { const: "accepted" }, at: { type: "string", format: "date-time", description: "When it was saved and checked; the server's own key, when the server started and checked it." } }),
          closed({ state: { const: "refused" }, reason: { type: "string", description: "The server's own key only (a saved one the provider refuses is never kept): who refused which key, in the provider's first sentence (never any of the key), and what to do. The tools that need it read unavailable in capabilities, with the same words." }, at: { type: "string", format: "date-time", description: "When the server started and checked it." } }),
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
        description: "Whether the key (its first field) was checked against its provider, with one call that costs nothing: a key stored here when it was saved (`accepted`, or `not_checked` and why; a key the provider refuses is never saved, PUT's 422), a tool's key the server is started with once as it starts (`accepted`, `not_checked`, or `refused`). Null when the key is not set, or is the server's and its check has not answered yet.",
      },
    }),
  },
  reenter: {
    oneOf: [closed({ reason: { enum: [...UNREADABLE] }, fields: { type: "array", items: { type: "string" } } }), { type: "null" }],
    description: "The stored values that do not open here, to be entered again (a PUT seals them under the current key), and why: `seal_key_missing` (the server was handed no seal key), `seal_key_changed` (sealed under another), `file_unreadable` (damaged; `fields` is empty when the file as a whole does not read). Null when every stored value opens.",
  },
});
const KEY_ID = { name: "key_id", in: "path", required: true, description: "The tool key: one of GET /settings/tool-keys' ids.", schema: { type: "string" } };
/** A remote MCP server's tools as it listed them (mcp-servers.ts), and the server as saved: never its credential. */
const MCP_TOOL = {
  type: "object", additionalProperties: false, required: ["name", "input_schema"],
  properties: {
    name: { type: "string" }, title: { type: "string" }, description: { type: "string" },
    input_schema: { type: "object", description: "The JSON Schema of the tool's arguments, as the server gave it." },
    output_schema: { type: "object", description: "The JSON Schema of its structured result, when the server gives one." },
    annotations: { type: "object", description: "The server's own claims about the tool (read-only, destructive, and so on): the server's word, not checked." },
    grantable: { const: false, description: "Present, and false, on a known meta tool: one that runs other actions by name (Composio's COMPOSIO_MULTI_EXECUTE_TOOL, Klavis Strata's execute_action, Zapier's execute actions, Arcade's UseTool, Docker's mcp-exec, Cloudflare's portal_execute and code mode). A grant of it could not name the real action, so none is granted: a save that grants it is 422 with `reason`, and a run that pinned one is refused at its launch. Absent on every other tool.", "x-agentrun-serve": "mcpservers/1" },
    reason: { type: "string", description: "Beside `grantable: false`: why the tool can't be granted.", "x-agentrun-serve": "mcpservers/1" },
  },
};
const MCP_LISTING = {
  protocol: { type: "string", description: "The MCP revision agreed: `2026-07-28` with a server that speaks it, else the 2025-era revision its `initialize` agreed." },
  server_info: { type: ["object", "null"], description: "The server's name and version, as it gave them." },
  instructions: { type: "string", description: "The server's instructions for its client, when it gives any." },
  tools: { type: "array", items: MCP_TOOL, description: "Every tool it lists, all pages." },
};
const MCP_PREVIEW = { type: "object", additionalProperties: false, required: ["protocol", "server_info", "tools"], properties: MCP_LISTING };
/** The owner's declared prices of a server's tools. */
const MCP_PRICES = {
  type: "object", additionalProperties: { type: "number", minimum: 0 },
  description: "Each tool's price in USD a call, as the owner declared it, for tools the server lists (a refresh drops the price of a tool it no longer lists). A priced call is held at its price under a run's cap (refused unsent when the cap cannot take it) and booked as the run's tool cost, as any paid call; a tool with none runs, shown \"not metered\" on the run's timeline and in GET /usage, outside the run's cost and its cap. A run keeps the prices its first launch saw. On a PUT: no `prices` keeps the saved ones, for the tools the server still lists at the same URL (a new URL keeps none); `{}` clears them; any other value replaces them.",
};
const MCP_SERVER_VIEW = {
  type: "object", additionalProperties: false, required: ["name", "url", "auth", "credential", "protocol", "server_info", "tools", "listed_at", "updated_at"],
  properties: {
    name: { type: "string" }, url: { type: "string", format: "uri" },
    auth: { type: "object", additionalProperties: false, required: ["type"], properties: { type: { enum: [...MCP_AUTH_TYPES] }, headers: { type: "array", items: { type: "string" }, description: "For `headers`: the names of the headers kept (lowercase), never a value." } } },
    credential: { enum: ["sealed", "seal_key_missing", "unreadable", "expired", null], description: "`sealed`: kept sealed and opens here; `seal_key_missing`: the server was handed no seal key, so it does not open; `unreadable`: sealed under another seal key, or damaged: a PUT with the credential seals it again; `expired`: an OAuth sign-in whose refresh the authorization server refused (revoked or expired): sign in again. Null for `auth.type` none. Never a value." },
    oauth: {
      type: "object", additionalProperties: false, required: ["scopes", "client"],
      properties: {
        expires_at: { type: "string", format: "date-time", description: "When the access token expires; a run's launch refreshes it within 5 minutes of then." },
        scopes: { type: "array", items: { type: "string" }, description: "The scopes granted." },
        client_id: { type: "string", description: "The client id this server signs in with (never its secret). A start with no `client_id` signs in again with this client." },
        client: { enum: ["pre-registered", "metadata-document", "dynamic"], description: "How this server is the authorization server's client: the owner's own client id, this server's client metadata document (CIMD, from a public https address only), or dynamic registration." },
      },
      description: "For `auth.type` oauth: the sign-in, never a token.",
    },
    ...MCP_LISTING,
    prices: MCP_PRICES,
    not_metered: { type: "array", items: { type: "string" }, description: "The tools it lists that no price meters, in its order: a call of one runs outside the run's cost and its cap (\"not metered\" on the run's timeline). Absent when every tool has a price ($0 included)." },
    listed_at: { type: "string", format: "date-time", description: "When its tools were last listed (a PUT or a refresh)." },
    updated_at: { type: "string", format: "date-time", description: "When it was last saved." },
  },
};
const MCP_AUTH = {
  type: "object", additionalProperties: false, required: ["type"],
  properties: {
    type: { enum: [...MCP_AUTH_TYPES], description: `\`none\`; \`bearer\` (\`token\`, sent as \`Authorization: Bearer <token>\`); \`headers\` (each named header and its value); \`oauth\`, with no credential in the body: the server is signed in to first (POST /settings/mcp-servers/{name}/oauth/start), and a PUT keeps the sealed token set.` },
    token: { type: "string", minLength: 1, maxLength: 8192 },
    headers: { type: "object", minProperties: 1, maxProperties: 8, additionalProperties: { type: "string", minLength: 1, maxLength: 8192 }, description: "Header names a credential may go in: not Host, Content-Type, Accept, Content-Length, Connection, Transfer-Encoding, Last-Event-ID or an Mcp- header the transport sets." },
  },
  description: "Absent: none. A PUT that sends no `token` (no `headers`) keeps the sealed credential, when the type and the URL's origin are unchanged.",
};
const MCP_URL = { type: "string", format: "uri", maxLength: 2048, description: "The server's Streamable HTTP endpoint: https, or http on a loopback address of this machine; no user or password." };
const MCP_NAME = { name: "name", in: "path", required: true, description: "The server's name: lowercase letters, digits and dashes, starting with a letter, at most 32 (no underscores, so `mcp__<server>__<tool>` splits one way). `hands` and `monid` are reserved for AgentRun's own tools: a PUT under either is 422 input_invalid, field `name`, reason `reserved`.", schema: { type: "string", pattern: MCP_SERVER_NAME.source } };
const MCP_FAILED = {
  "424": { description: "`upstream_failed`: the MCP server could not be reached, did not answer within 15 s (30 s for the whole listing), answered 5xx or more than 4 MiB at once, or failed to list its tools. `details.status` holds its HTTP status when it answered one.", content: { "application/json": { schema: ref("schemas/Error") } } },
};
const MCP_CONNECTS = "Connects with the official MCP SDK client: `server/discover` (2026-07-28) first, a 2025-era server by its `initialize`; then `tools/list`, every page. No redirect is followed: a 3xx is 422 input_invalid (field `url`, reason `redirect`, naming where it points), so a credential goes only where it is sent. A server that asks for a credential (401 or 403) is 422 `auth_required`, `details.auth` `oauth` when it names protected-resource metadata (its WWW-Authenticate or `/.well-known/oauth-protected-resource`), else `bearer`; a URL whose answers hold no JSON-RPC reply is 422 `not_mcp`; a server listing more than 500 tools, or more than 1 MiB of them (names, descriptions, schemas), is 422 input_invalid (field `url`, reason `too_many_tools` or `tools_too_large`), the listing stopped at that page; any other failure is 424.";
/** A tool's permission (tool-gate.ts). */
const PERMISSION = {
  enum: [...PERMISSIONS],
  description: "What the tool gate does with each call a model makes: allow runs it; ask parks the run until the owner answers (POST /runs/{run_id}/approvals/{approval_id}); deny refuses it at once, and the model reads why. The owner's defaults: allow for this server's tools, ask for a catalog tool (monid.<tool>, mcp:<server>/<tool>). ask is offered for the tools whose approved call the kernel runs itself (read, write, edit, bash, fetch_page, web_fetch, web_search) and for catalog tools; any other is allow or deny.",
};
/** The table's tools a setting may name: its legacy names (fetch_page) are set by the capability they fold into. */
const SETTINGS_TOOLS = TABLE_TOOLS.filter((name) => !Object.hasOwn(LEGACY_NAMES, name));
/** A catalog tool's settings key, or an MCP server's wildcard, which sets each of its tools. */
const CATALOG_KEY = { type: "string", pattern: "^(monid\\.[^/]+|mcp:[^/]+/.+)$" };
/** The tool settings map (tool-plane.ts): the server's (/settings/tools) and an agent's own (definition.tool_settings),
 *  by settings key: each tool of the table, a catalog tool by name, an MCP server's wildcard; a provider only for the
 *  two that have a choice. */
const TOOL_SETTINGS = {
  type: "object",
  propertyNames: { anyOf: [{ enum: SETTINGS_TOOLS }, CATALOG_KEY] },
  properties: Object.fromEntries(SETTINGS_TOOLS.map((name) => [name, {
    type: "object", additionalProperties: false,
    properties: {
      ...((PICKABLE as readonly string[]).includes(name) ? { provider: { enum: [...PROVIDERS[name as Pickable]], description: `Default ${PROVIDERS[name as Pickable][0]}.` } } : {}),
      permission: { ...PERMISSION, enum: [...permissionsOf(name)] },
    },
  }])),
  additionalProperties: { type: "object", additionalProperties: false, properties: { permission: PERMISSION } },
};
/** What a capability resolves to on each harness: `native`, `kernel`, `exa-keyless`, `parallel`, `browserbase`, or `unavailable: <reason>`. */
const RESOLUTION = { type: "string", pattern: "^(native|kernel|exa-keyless|parallel|browserbase|unavailable: .+)$" };
const RESOLVES = {
  type: "object", additionalProperties: false, required: [...HARNESSES], properties: Object.fromEntries(HARNESSES.map((harness) => [harness, RESOLUTION])),
  description: "What the tool resolves to on each harness: native (the harness's own tool, or on pi one request to the model provider's hosted search), kernel (the guarded direct fetch; on browser, Kernel's hosted browser), exa-keyless (Exa's keyless MCP search), parallel, browserbase (Browserbase's hosted browser), or unavailable: <reason>.",
};
/** Why a capability resolves as it does on each harness: one plain sentence each, from the same resolution. */
const WHY = {
  type: "object", additionalProperties: false, required: [...HARNESSES], properties: Object.fromEntries(HARNESSES.map((harness) => [harness, { type: "string" }])),
  description: "Why the tool resolves as it does on each harness, one plain sentence each, made by the same resolution as resolves: the harness's or model provider's own search (`Codex's own search`), what leaves none and what serves instead (`behind a gateway Codex has no own search; your Parallel key (saved)`, where saved is a key saved on Tool keys and server the server's own), a pick (`keyless Exa, picked in settings: Exa's free search, no key`), or `turned off in settings`. A client shows it as is.",
};
/** GET and PUT /settings/tools's answer: each capability's provider, its default where none is set, and each permission
 *  set, by settings key. */
const TOOL_SETTINGS_ANSWER = {
  type: "object", required: [...PICKABLE], propertyNames: TOOL_SETTINGS.propertyNames,
  properties: Object.fromEntries(PICKABLE.map((name) => [name, { type: "object", additionalProperties: false, required: ["provider"], properties: { provider: { enum: [...PROVIDERS[name]] }, permission: PERMISSION } }])),
  additionalProperties: { type: "object", additionalProperties: false, required: ["permission"], properties: { permission: PERMISSION } },
};
/** GET /agents/{agent_id}'s `tools`: each tool the agent's current revision grants, in capabilities.tools' order; one
 *  with a provider choice with the provider in force, where it came from, the server's (its default), and what it
 *  resolves to on the agent's harness and model. */
const AGENT_TOOLS = {
  type: "array",
  description: "Each tool the agent's current revision grants, in capabilities.tools' order, with its permission (permission, where it came from as permission_from, default_permission, permissions). A tool with a provider choice (web_search, web_fetch, and fetch_page, web_fetch's legacy name; browser) carries the provider in force (provider), where it came from (provider_from: agent, its own tool_settings; server, the server's settings; default, the built-in default), the one that applies when the agent sets none (default_provider, the server's), and what it resolves to on the agent's harness and model (resolved). Only GET /agents/{agent_id} answers it.",
  items: {
    type: "object", additionalProperties: false, required: ["name", "permission", "permission_from", "default_permission", "permissions"],
    properties: {
      name: { type: "string" }, blurb: { type: "string", description: "One short line for people (the editor's Tools grid); the model never sees it. Absent for an MCP server's tool, and on an older server.", "x-agentrun-serve": "tool-blurb/1" }, provider: { type: "string" }, provider_from: { enum: ["agent", "server", "default"] }, default_provider: { type: "string" }, resolved: RESOLUTION,
      permission: { ...PERMISSION, description: "The permission in force: the agent's own (tool_settings), else the server's, else the owner's default.", "x-agentrun-serve": "approvals/1" },
      permission_from: { enum: ["agent", "server", "default"], description: "Where the permission came from: agent, its own tool_settings (the tool's key, or its MCP server's wildcard); server, the server's settings; default, the owner's default.", "x-agentrun-serve": "approvals/1" },
      default_permission: { enum: [...PERMISSIONS], description: "The one that applies when the agent sets none: the server's, else the owner's default.", "x-agentrun-serve": "approvals/1" },
      permissions: { type: "array", items: { enum: [...PERMISSIONS] }, description: "The permissions it may be set to.", "x-agentrun-serve": "approvals/1" },
    },
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
    "`cancelled`: a person cancelled the run. `crashed`: the run's process went. `reflect_timeout`, `reflect_failed`: the end-of-run turn did not end in time, or ended on an error.",
    "`empty`: the turn's answer gave no note. `unparsed`: it gave notes out of format (no ```note block, one not closed or named twice), and none was kept. `propose_failed`: what it answered could not be checked. `checker`: the checks refused it, at its end or at the merge, and nothing was written to git.",
    "`grader`: the grader's verdict was not to keep them. `grade_failed`: the grader gave no verdict, or the grade or the merge failed.",
  ].join(" "),
};
// ---- learning/1: what a person sees and controls of an agent's learning (learning-routes.ts) ---------------------------
const NULL_STRING = { type: ["string", "null"] };
const MARK = { "x-agentrun-serve": "learning/1" };
const PAGE = (item: Json, description: string) => closed({ items: { type: "array", items: item }, total: { ...COUNT, description: "How many there are in all, at the commit the page was read at." }, next_cursor: { ...NULL_STRING, description: "The next page, read at the same commit of main as this one: opaque. Null on the last." } }, description);
const LEARNING_NOTE_REQUIRED = closed({
  file: { type: "string", description: "The note's file name, `<slug>.md`, at the folder's top; `[redacted]` when it holds one of the host's secrets as they are now (its route still answers the real name)." },
  name: { type: "string" }, description: { type: "string" }, type: { enum: [...NOTE_TYPES] },
  status: { enum: [...NOTE_STATUSES], description: "Absent from the note's front matter: active. Only an active note is in MEMORY.md. `pending`: a rule the grader held as risky, the user's or the run's own, to wait for its owner's OK; no run reads it." },
  origin: { enum: [...NOTE_ORIGINS], description: "`you`: kept from what the user asked in their own words; `run`: what the run worked out (absent from older notes: `run`)." },
  superseded_by: { ...NULL_STRING, description: "The note that superseded it, on a superseded note; `[redacted]` as `file` is." },
  text: { type: "string", description: "The note's whole file, front matter included." },
  etag: { type: "string", description: "The note's version on main, the same ETag as `GET .../learning/files/{file}` answers: send it as `If-Match` to edit or retire the version shown, and a 412 means it changed since.", "x-agentrun-serve": "learning/2" },
  runs: closed({
    given: { ...COUNT, description: "How many of the agent's runs were given this note: named in the run's # Learned section, whole or as an index line (each run's `given`)." },
    read: { ...COUNT, description: "How many of the agent's runs opened this note's file with the read tool (each run's `read`). 0 when none did." },
  }, "This note's runs, counted over the agent's runs the server knows (held ones from memory, ended ones from the learning ledger): given it, and read it. Whether a run applied a note is not measured."),
});
/** When a retired note, skill or draft was retired, and by whom: on a retired one alone. */
const RETIRED = closed({
  at: { type: "string", format: "date-time", description: "When: the commit that retired it." },
  by: { enum: ["person", "run"], description: "`person`: its owner, in the console or with POST .../retire (the time of that retire; an edit since moves it not); `run`: anything else that set it." },
}, "When and by whom it was retired; absent unless `status` is `retired`. POST .../restore makes it active again.");
/** The newest change to a note, skill or draft, from the newest commit on its file. */
const LAST_CHANGE = closed({
  kind: { enum: ["approved", "edited", "created", "retired", "restored", "learned", "superseded"], description: "What the change was: a person's approval, edit, creation, retire or restore (named by its commit), `superseded`, a note a person's approval or restore of another superseded, or `learned`, a run's merge." },
  by: { enum: ["person", "run"], description: "`person`: its owner, in the console or through the API; `run`: a run's merge." },
  at: { type: "string", format: "date-time", description: "When: the commit's time." },
}, "The item's last change: the newest commit on its file (a note's file, a skill's SKILL.md, a draft's README.md), a person's (named by its subject's fixed prefix, `learning: <kind> by a person: `) or a run's merge (its Run-Id: `learned`). Absent when that commit is neither (the folder's own first commit, or one made outside the server).");
const LEARNING_NOTE = { ...LEARNING_NOTE_REQUIRED, properties: { ...LEARNING_NOTE_REQUIRED.properties, retired: RETIRED, last_change: LAST_CHANGE } };
const LEARNING_CHANGE = closed({
  by: { oneOf: [closed({ run: { type: "string" } }), { type: "object", additionalProperties: false, required: ["user"], properties: { user: { type: "boolean", const: true }, via: { type: "string", description: "On an approval: how it came, `console` (the owner's signed-in page)." } } }], description: "A run's merge (its commit's `Run-Id` trailer), or a person's edit, creation, retirement or approval through this API (`Changed-By: user`, and `Approved-Via` on an approval)." },
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
/** A skill or a workflow draft the agent learned, as the agent's learning lists it (learning-routes.ts learnedAt). */
const LEARNED_ITEM = (kind: "skill" | "workflow") => ({
  type: "object", additionalProperties: false,
  required: ["name", "file", ...(kind === "workflow" ? ["readme"] : []), "description", "status", "run", "bytes", "etag"],
  properties: {
    name: { type: "string", description: `The ${kind}'s folder name; \`[redacted]\` when it holds one of the host's secrets as they are now.` },
    file: { type: "string", description: kind === "skill" ? "Its SKILL.md, `skills/<name>/SKILL.md`: GET .../learning/files/{file}, percent-encoded, reads it." : "Its draft, `workflows/<name>/workflow.json`: GET .../learning/files/{file}, percent-encoded, reads it as JSON." },
    ...(kind === "workflow" ? { readme: { type: "string", description: "Its README.md, which the server writes from the description the run gave: the file that says whether it waits, and the one an approval names." } } : {}),
    description: { type: "string", description: `What its ${kind === "skill" ? "SKILL.md" : "README.md"}'s front matter says it is for, cut of the host's secrets.` },
    status: { enum: ["active", "pending", "retired"], description: `\`pending\`: the grader held it as risky to wait for its owner's OK (\`status: pending\` in its ${kind === "skill" ? "SKILL.md" : "README.md"}), and no run is given it until it is approved (POST .../learning/files/{file}/approve on its ${kind === "skill" ? "SKILL.md" : "README.md"}). \`retired\`: a person retired it (POST .../learning/files/{file}/retire on its ${kind === "skill" ? "SKILL.md" : "README.md"}), and no later run is given it.` },
    run: { ...NULL_STRING, description: "The run whose merge last changed it; null when no merge names one." },
    bytes: { ...COUNT, description: `The size of its ${kind === "skill" ? "SKILL.md" : "workflow.json"} on main.` },
    etag: { type: "string", description: `The version of its ${kind === "skill" ? "SKILL.md" : "README.md"} on main, as its file's GET answers it: an approval sends it as If-Match.` },
    retired: RETIRED,
    last_change: LAST_CHANGE,
  },
  "x-agentrun-serve": "learning/3",
});
const AGENT_LEARNING = closed({
  agent: { type: "string" },
  main: { ...NULL_STRING, description: "Main's head commit; null while the agent has no learning folder (its learning was never on), when every page is empty." },
  index: { type: "string", description: "MEMORY.md on main: what the agent's next run reads, one line per active note, built by the server." },
  notes: PAGE(LEARNING_NOTE, "The first 50 notes: active first, then by their newest change, newest first. GET .../learning/notes for more."),
  skills: { type: "array", items: LEARNED_ITEM("skill"), description: "Every skill on main, `skills/<name>/SKILL.md`, by name: what a later run is given as a skill once it is active. Empty when there is none.", "x-agentrun-serve": "learning/3" },
  workflows: { type: "array", items: LEARNED_ITEM("workflow"), description: "Every workflow draft on main, `workflows/<name>/workflow.json` with its README.md, by name. Empty when there is none.", "x-agentrun-serve": "learning/3" },
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
  given: {
    type: "array", minItems: 1,
    items: closed({ file: NOTE_NAME_FILE, name: { type: "string", description: "The note's front-matter `name`, cut of the host's secrets as they are now." } }),
    description: "The notes this run started with: every active note its # Learned section names, given whole or as an index line naming its file in `.learning/`, as it was seeded. Absent when the run started with nothing learned. Whether the run applied a note is not measured.",
    "x-agentrun-serve": "learning/2",
  },
  read: {
    type: "array", minItems: 1,
    items: closed({ file: NOTE_NAME_FILE, name: { type: "string", description: "The note's front-matter `name`, cut of the host's secrets as they are now." } }),
    description: "The notes this run read from `.learning/` in its working directory, in the order it first read each: every `read` call of its job (on any harness) whose result was a success and that names a note the run started from. A note read another way, through a command (`bash`'s `cat .learning/<file>`, say), is not counted. MEMORY.md, the index every run gets in its instructions, is not one; nor is a read the run's end-of-run turn made. Found once, as the run settles, and kept with the run: absent while it runs (a follow-up included) and when it read none. Absent when the run opened no note file.",
    "x-agentrun-serve": "learning/2",
  },
  learned: {
    type: "array", minItems: 1,
    items: closed({ file: NOTE_NAME_FILE, name: { type: "string", description: "The note's front-matter `name`, cut of the host's secrets as they are now." }, supersedes: { type: "array", items: NOTE_NAME_FILE, description: "The older notes it replaced, each now `superseded` by it; empty when it replaced none." } }),
    description: "The notes this run's learning added to the agent's learning folder: present once `state` is `merged`, absent otherwise.",
    "x-agentrun-serve": "learning/2",
  },
  skills: {
    type: "array", minItems: 1,
    items: { type: "object", additionalProperties: false, required: ["file", "name"], properties: { file: { type: "string", description: "Its SKILL.md, `skills/<name>/SKILL.md`; `[redacted]` when it holds one of the host's secrets as they are now." }, name: { type: "string", description: "The skill's folder name, `[redacted]` as `file` is." }, pending: { type: "boolean", const: true, description: "Present while it waits for the owner's OK: no run is given it until approved." } } },
    description: "The skill this run's learning added or changed: present once `state` is `merged` and it kept one, absent otherwise.",
    "x-agentrun-serve": "learning/3",
  },
  workflows: {
    type: "array", minItems: 1,
    items: { type: "object", additionalProperties: false, required: ["file", "name"], properties: { file: { type: "string", description: "Its draft, `workflows/<name>/workflow.json`; `[redacted]` when it holds one of the host's secrets as they are now." }, name: { type: "string", description: "The workflow's folder name, `[redacted]` as `file` is." }, pending: { type: "boolean", const: true, description: "Present while it waits for the owner's OK." } } },
    description: "The workflow draft this run's learning added or changed: present once `state` is `merged` and it kept one, absent otherwise.",
    "x-agentrun-serve": "learning/3",
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
/** trigger/1: schedules that start an agent's capped runs (triggers.ts). */
const TRIGGER_MARK = { "x-agentrun-serve": "trigger/1" };
/** A run's `trigger`, on Run and on RunSummary alike. */
const RUN_TRIGGER: Json = {
  oneOf: [closed({ id: { type: "string", description: "The trigger (GET /triggers/{trigger_id}); it may have been deleted since." }, firing_key: { type: "string", pattern: "^fir_[0-9a-f]{32}$", description: "The firing that started it." } }), { type: "null" }],
  description: "The trigger that started the run, and its firing; null for a run a caller started.",
  ...TRIGGER_MARK,
};
const DATE_TIME = { type: "string", format: "date-time" };
const TRIGGER_SOURCE = {
  oneOf: [
    closedWith({ kind: { const: "schedule" }, cron: { type: "string", description: "Five fields, minute hour day-of-month month day-of-week, as cron reads them (croner): at most once a minute. A time a clock change repeats fires once, at its first pass; one it skips fires at the first time after the gap." } }, { timezone: { type: "string", default: "UTC", description: "The IANA zone the cron line is read in." } }),
    closed({ kind: { const: "schedule" }, at: { ...DATE_TIME, description: "Once, at this time (to the second, in the future); the trigger turns itself off after." } }),
    closedWith({ kind: { const: "schedule" }, every_s: { type: "integer", minimum: MIN_EVERY_S, maximum: MAX_EVERY_S, description: "Every this many seconds, on the grid from start_at." } }, { start_at: { ...DATE_TIME, description: "The grid's origin, to the second: the first firing is at it when it is ahead, else at the first point of the grid after now. Default the time the trigger was made." } }),
    closed({ kind: { const: "webhook" } }),
  ],
  description: `When it fires: a cron line in a zone, one time, every N seconds (${MIN_EVERY_S} or more), or a signed request to /hooks/{trigger_id} (\`webhook\`). Each next time is reckoned from the last nominal one, never from when the timer woke. Times missed while the server was down, or more than a minute late, are one \`missed\` firing with their count, and the schedule goes on from now.`,
};
const START_RUN = closedWith(
  {
    kind: { const: "start_run" },
    agent_id: { type: "string", description: "The agent whose run each firing starts: an agent, not a workflow, since a workflow run's spend is not capped here." },
    input: { type: "object", description: "The run's input, as POST /agents/{agent_id}/runs takes it: `{content}`. Each run's content ends with a line naming the schedule and the time it fired for, in its zone." },
  },
  { effort: { $ref: "#/components/schemas/Effort" }, max_cost_usd: { type: "number", exclusiveMinimum: 0, description: "Each run's spend cap. Absent, the agent's default (its definition's `max_cost_usd`) as it stands when the firing starts; one of the two is required, so every run a trigger starts is capped: a target with neither is 422, and a firing that finds neither (the agent's default removed since) fails." } },
);
const TRIGGER_TARGET = {
  oneOf: [
    START_RUN,
    closed({
      kind: { const: "message_run" },
      run_id: { type: "string", description: "The run each firing messages, as POST /runs/{run_id}/messages would: a steer while it works, a follow-up after it ended (a completed run opens again), under its own cap, which it must have (422 otherwise). A firing never answers a run that waits on its person (a question, an approval, its cap): it is skipped." },
      input: closed({ content: { type: "string", minLength: 1 } }, "The message: its content, then a webhook's payload marked untrusted, then a line naming the trigger and when it fired."),
    }),
  ],
  description: "What each firing does: start a run of an agent, capped, or send a message to one run.",
};
const TRIGGER_FIRING = closedWith(
  {
    key: { type: "string", pattern: "^fir_[0-9a-f]{32}$", description: "The firing's key: from the trigger and its nominal time, or from the trigger and the Idempotency-Key of a run now. Its run is started under it, once." },
    by: { enum: ["schedule", "manual", "webhook"], description: "`webhook`: a signed request to /hooks/{trigger_id}, its key from the trigger and the request's `webhook-id`." },
    nominal_at: { ...DATE_TIME, description: "The time it fires for, to the second; a run now's is when it was asked." },
    status: { enum: [...FIRING_STATUSES], description: `\`due\`: recorded, its run not started yet (a full server keeps it due, with \`retry_at\`). \`started\`: its run is \`run_id\`. \`sent\`: a message_run firing's message reached \`run_id\`. \`skipped\`: the trigger's last run was still active (working, or waiting on a person), or an earlier firing was still due; \`reason\` says which. \`failed\`: the run was refused, with \`error\`; a trigger.failed webhook message says so. \`missed\`: times not fired while the server was down or its timer late (older than the catch-up window, or before the one that caught up), \`count\` of them from \`nominal_at\` on.` },
    at: { ...DATE_TIME, description: "When it was recorded." },
    run_id: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
    error: { oneOf: [closed({ code: { type: "string" }, message: { type: "string" } }), { type: "null" }] },
  },
  { count: { type: "integer", minimum: 1, description: "On a `missed` firing: how many times it stands for, from `nominal_at` on; a cron line's are counted to 10000, and `reason` says \"or more\" past that." }, attempts: { type: "integer", minimum: 0 }, retry_at: DATE_TIME, catch_up: { const: true, description: "A time that fired late, within the trigger's catch-up window: the server was down, or its timer late." } },
);
const TRIGGER = closed({
  id: { type: "string" },
  name: { type: "string", maxLength: 200 },
  enabled: { type: "boolean" },
  source: TRIGGER_SOURCE,
  target: TRIGGER_TARGET,
  overlap: { enum: [...OVERLAP], description: "What a firing does while the trigger's last run is active (working, or waiting on a person): `skip`, recorded as a skipped firing with why. Never queued: a firing queued behind a run parked on a person would wait as long as the person does." },
  catchup_window_s: { type: "integer", minimum: 0, maximum: MAX_EVERY_S, description: `How late a missed time may still fire, once: of the times that came while the server was down (or its timer was late), the latest fires if it is this recent, under its own key, and the rest are one \`missed\` firing. 0: a missed time never fires. Default ${CATCHUP_WINDOW_S}.` },
  failures_in_a_row: { type: "integer", minimum: 0, description: `Failed firings since the last that started a run; at ${FAILURES_TO_PAUSE} the trigger turns itself off (\`disabled\`). Turned on again, it counts from 0.` },
  disabled: { oneOf: [closed({ at: DATE_TIME, reason: { const: "auto_paused" } }), closed({ at: DATE_TIME, reason: { const: "source_unreadable" }, detail: { type: "string", description: "Why the source no longer reads." } }), { type: "null" }], description: `Why it is off, when the server turned it off: \`auto_paused\`, ${FAILURES_TO_PAUSE} failed firings in a row; \`source_unreadable\`, its cron line or zone no longer reads here (a newer cron library or time zone data refuses it), found at a start or when it came due, and only this trigger is turned off. Null once it is on again, which for \`source_unreadable\` takes a new source.` },
  next_at: { type: ["string", "null"], format: "date-time", description: "When it fires next; null while it is off." },
  last_run_id: { type: ["string", "null"], description: "The run its last firing that started one started; while that run is active (working, or waiting on a person), each firing is skipped. Null until one starts." },
  created_at: DATE_TIME,
  updated_at: DATE_TIME,
  last_firing: { oneOf: [TRIGGER_FIRING, { type: "null" }] },
});
const TRIGGER_WRITE = {
  name: { type: "string", minLength: 1, maxLength: 200, description: "Default the trigger's id." },
  enabled: { type: "boolean", default: true, description: "Off, it fires nothing; on again, it goes on from now: the time it was off is skipped, never caught up." },
  source: TRIGGER_SOURCE,
  target: TRIGGER_TARGET,
  catchup_window_s: { type: "integer", minimum: 0, maximum: MAX_EVERY_S, default: CATCHUP_WINDOW_S },
};
const TRIGGER_ID = { name: "trigger_id", in: "path", required: true, schema: { type: "string" } };
const TRIGGER_SECRET = { type: "string", pattern: "^whsec_[A-Za-z0-9+/]+={0,2}$", description: "A webhook trigger's signing secret, shown this once: `whsec_` and 32 random bytes in base64, as the Standard Webhooks spec gives it. Never in any GET; kept sealed under the seal key. Sign each request to /hooks/{trigger_id} with it." };
const TRIGGER_ERRORS = "409 store_unreadable when triggers.json in the data directory does not read: nothing fires, and nothing is written over it.";
const RUN_LEARNING = {
  oneOf: [
    closedWith({
      run: { type: "string" }, state: { enum: [...LEARNING_STATES] }, reason: LEARNING_REASON,
      detail: { ...NULL_STRING, maxLength: 300, description: "Run.learning's detail, the same words: at most 300 characters, cut of the host's secrets as they are now before it is cut short." }, at: { type: "string", format: "date-time" },
      seed: { ...NULL_STRING, description: "The commit of main the run started from; null when its seed failed." },
      merged: { ...NULL_STRING, description: "Its merge commit on main, once merged." },
      pending: { type: "array", items: closed({ file: { type: "string" }, name: { type: "string" } }), description: "The merge's notes that wait for the owner's OK (status `pending` on main), in no index and read by no run until approved; empty when none." },
      verdict: { oneOf: [closed({ merge: { type: "boolean" }, reason: { type: "string" }, items: { type: "array", items: VERDICT_ITEM, description: "One for each new note the run proposed." } }), { type: "null" }], description: "The grader's, once it judged; null when no grade ran." },
      problems: { type: "array", items: PROBLEM, description: "The checker's, when the reason is `checker`; otherwise, the items the checks left out while the rest went on to the grader (on a merge, a grader's drop or a grade that failed)." },
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
const NOTE_PARAM = { name: "file", in: "path", required: true, description: "A note's file name at the folder's top (`<slug>.md`), percent-encoded; on a read, `MEMORY.md` too, and a skill's `skills/<name>/SKILL.md` or a draft's `workflows/<name>/workflow.json` or `README.md`, its slashes percent-encoded (`skills%2F<name>%2FSKILL.md`); on an approval, a skill's SKILL.md or a draft's README.md. Any other name is 400, and so is a skill's or a draft's file on an edit, which is for notes; on a retire, a skill's SKILL.md or a draft's README.md too; a path with a bare `/` is no route (404).", schema: { type: "string" } };
const ETAG = { ETag: { description: "The note's version on main: its git blob id, quoted. If-Match on a write takes it.", schema: { type: "string" } }, "X-Content-Type-Options": ref("headers/NoSniff") };
const NOTE_TEXT = (description: string, json = false) => ({ description, headers: ETAG, content: { "text/markdown": { schema: { type: "string" } }, ...(json ? { "application/json": { schema: {}, description: "A draft's workflow.json, as it is on main." } } : {}) } });
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
      operationId: "readLearningFile", tags: ["agents"], summary: "One note (or MEMORY.md, a skill's SKILL.md or a draft's file) on main, as text, with its ETag",
      description: "A note, MEMORY.md, a SKILL.md and a README.md are `text/markdown`; a draft's workflow.json is `application/json`.",
      parameters: [AGENT_ID, NOTE_PARAM], responses: { "200": NOTE_TEXT("The file's text, cut of the host's secrets.", true), ...errors(400, 401, 404, 429, 500) }, ...MARK,
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
      operationId: "retireLearningFile", tags: ["agents"], summary: "Retire a note, a skill or a workflow draft: out of every later run, kept in history",
      description: `A learned skill (its \`skills/<name>/SKILL.md\`) or a workflow draft (its \`workflows/<name>/README.md\`; its workflow.json is 400) is retired the same way: \`status: retired\` last in its front matter, one host commit \`learning: retired by a person: <file>\` that changes that file alone, listed \`retired\`, and no later run is given it; one already retired is answered as it is. Sets \`status: retired\` (and drops \`superseded_by\`), on an active note or one that waits for its owner's OK (\`pending\`); any other note is answered as it is. A retire is how a person revokes a note, so only its format is checked: its front matter as retired, and the 4 KB cap with the status line on top (400 \`bad_request\` with \`problems\` otherwise). A secret shape or one of the host's values in its name or text never blocks it; the answer is cut of them. ${WRITE_DESCRIPTION}`,
      parameters: [AGENT_ID, NOTE_PARAM, IF_MATCH], responses: { "200": NOTE_TEXT("The note, retired."), ...WRITE_ERRORS }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/files/{file}/approve": {
    post: {
      operationId: "approveLearningFile", tags: ["agents"], summary: "Approve a note, a skill or a workflow draft that waits for its owner's OK",
      description: `A skill (its SKILL.md) or a workflow draft (its README.md) that waits is made active the same way, by the same session, in one commit that drops its \`status: pending\` line and changes nothing else: every later run is given it. Makes a pending note active: in MEMORY.md, read by every later run, and each note it supersedes that is active still marked superseded. One host commit on main, \`learning: approved by a person: <file>\`, with the trailers \`Changed-By: user\` and \`Approved-Via: console\`; the log shows it as \`by: {user: true, via: "console"}\` at the commit's time, and never the note's text. Only the owner, signed in with their password, approves: the route takes the console's password session alone, from this server's own origin with a JSON body (as every page write), and answers 403 \`forbidden\` to every token, the server's own included, since an agent's MCP client, the MCP endpoint's tools or a script may hold one, to a run's door token, and to every request on a server with accounts off, whose page cookie the token mints (\`capabilities.learning.approve\` is false there, with \`approve_needs: "password"\`); with no credential at all it is 401, as every route. A run that uses bash on the host runs as the server's user and can read its files, so for untrusted tasks use the sandbox. A note that is not pending is 400 \`bad_request\`. Under If-Match, as a retire: a stale ETag is 412, none 428.`,
      // The owner's password session alone (ownerSession), never the document's bearer, with the empty JSON body every
      // page write sends: a client generated from this document sends what the route takes.
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, maxProperties: 0 } } } },
      parameters: [AGENT_ID, NOTE_PARAM, IF_MATCH], responses: { "200": NOTE_TEXT("The note, approved."), ...WRITE_ERRORS, ...errors(403) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/files/{file}/restore": {
    post: {
      operationId: "restoreLearningFile", tags: ["agents"], summary: "Restore a retired note, skill or workflow draft: active again for the next run",
      description: "A retired note is made active, a skill (its SKILL.md) or a workflow draft (its README.md) is given to every later run again, in one commit on main (`learning: restored by a person: <file>`, Changed-By: user) with MEMORY.md rebuilt. The text is checked again as a new note or skill is (a secret's shape, the host's own values, a hidden character, its format), so a value a retire took out of every run never comes back: such a note stays retired, and the answer names the rule, never the value. Only a retired one is restored (else 400). The owner's password session alone, as an approval.",
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, maxProperties: 0 } } } },
      parameters: [AGENT_ID, NOTE_PARAM, IF_MATCH], responses: { "200": NOTE_TEXT("The note, restored."), ...WRITE_ERRORS, ...errors(403) }, ...MARK,
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
    host_owned: { type: "boolean", const: true, description: "A path of `capabilities.home.host_owned`: only the server writes it, and what is in it is never listed or served here: `learning` is read through the learning API (`/v2/agents/{agent_id}/learning`, on a server that has it), `sign-ins` (sealed pointers) only as GET /agents/{agent_id}'s `sign_ins`, never a pointer." },
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
const HOME_WRITES = "A path more than 16 directories deep, past where the list goes, is `400 invalid_file_path`. A path at or under one of `capabilities.home.host_owned` (`learning/`, `sign-ins/`) is `403 system_file_forbidden` with `details.reason` `host_owned`: matched on the path as normalized, by its first segment folded (compatibility form, any case, no combining marks), so `./Learning/x` too, and by identity (the same device and inode) where that segment and the host-owned path are both on disk. A link on the way, or as the file, is `403 system_file_forbidden` with `details.reason` `link`: never followed. A path that names a directory, or runs through a file, is `400 invalid_file_path`. An archived agent's home is written as any other's. Where \`capabilities.home.writes\` is false (no /proc/self/fd, as on macOS), the write or delete is \`501 unsupported_here\`.";

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
      description: "The revision's workflow and its graph, each node's state (a map's items, a route's branch taken), the decisions with their receipts, the calls with their input and output, and the totals. Readable while the run goes. 404 for an agentic run. 403 `forbidden` while this server can't read the browser sign-in the run was handed (its seal key changed or is missing): what its nodes said could repeat the sign-in's pointer, so none of it is served until the sign-in opens again.",
      parameters: [ref("parameters/RunId")],
      responses: { "200": json(RUN_GRAPH, "The run's graph as it stands."), ...errors(401, 403, 404, 429, 500) },
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
  "/runs/{run_id}": {
    patch: {
      operationId: "raiseRunCap", tags: ["runs"], summary: "Raise a run's spend cap",
      description: "Raises `max_cost_usd` of an agentic run that named one; only a raise: the new cap is above the run's current cap, its last raise included (422 otherwise, and for a run with no cap or a workflow run); the same raise sent again (a retry) changes nothing and answers as the first did. The run's serve.json keeps it before anything else, so its next process and a server started again run under it. A run paused at its cap (`pending.kind` budget) goes on: the answer comes at once (`resumed` true, its `message_id`), and once its process has been let go the server sends it one follow-up turn under that id, \"The cap was raised to $X; continue the task.\", which runs under the new cap; it is sent once, by a server started again if this one stopped before it went. A second raise before it goes answers the same `message_id`; one that cannot be sent is tried again, then the run ends failed, saying why. Caps within 1e-9 are the same cap. A run working keeps the cap its process was opened with until its next process (`note` says so). 409 not_continuable for an ended run.",
      parameters: [ref("parameters/RunId")],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["max_cost_usd"], properties: { max_cost_usd: { type: "number", exclusiveMinimum: 0, description: "The new cap, above the run's current cap." } } } } } },
      responses: {
        "200": json({ type: "object", additionalProperties: false, required: ["run_id", "max_cost_usd", "resumed", "status", "state"], properties: {
          run_id: { type: "string" }, max_cost_usd: { type: "number" }, resumed: { type: "boolean", description: "A run paused at its cap goes on: its follow-up turn is sent once its process has been let go." },
          message_id: { type: "string", description: "That follow-up's id, when `resumed`." }, note: { type: "string", description: "Said when the run's live process keeps its old cap until its next process." },
          status: ref("schemas/RunStatus"), state: ref("schemas/RunState"),
        } }, "The run, its cap raised."),
        ...errors(401, 404, 409, 422, 429, 500),
      },
      "x-agentrun-serve": "cappause/1",
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
  "/settings/mcp-servers": {
    get: {
      operationId: "listMcpServers", tags: ["local"], summary: "The remote MCP servers saved here, with their tools; never a credential",
      description: "When the saved-servers file does not read (damaged, or another format), `servers` is empty and `file_unreadable` is true; every other route on it is 409 store_unreadable, and nothing writes over it.",
      responses: { "200": json({ type: "object", additionalProperties: false, required: ["servers"], properties: { servers: { type: "array", items: MCP_SERVER_VIEW }, file_unreadable: { const: true, description: "Present when the saved-servers file does not read." } } }, "Each server, by name."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/mcp-servers/preview": {
    post: {
      operationId: "previewMcpServer", tags: ["local"], summary: "Connect to a remote MCP server and list its tools, storing nothing",
      description: `\`{url, auth}\`, or \`{name}\` for a saved server with its sealed credential (409 no_sealing_key when it does not open for want of a seal key; 422 when it does not open otherwise). ${MCP_CONNECTS}`,
      requestBody: { required: true, content: { "application/json": { schema: { oneOf: [{ type: "object", additionalProperties: false, required: ["url"], properties: { url: MCP_URL, auth: MCP_AUTH } }, { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } }] } } } },
      responses: { "200": json(MCP_PREVIEW, "What the server offers."), ...errors(400, 401, 404, 409, 415, 422, 429, 500), ...MCP_FAILED },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/mcp-servers/{name}": {
    get: {
      operationId: "getMcpServer", tags: ["local"], summary: "One saved MCP server; never its credential",
      parameters: [MCP_NAME],
      responses: { "200": json(MCP_SERVER_VIEW, "The server."), ...errors(401, 404, 409, 429, 500) },
      "x-agentrun-serve": "mcpservers/1",
    },
    put: {
      operationId: "saveMcpServer", tags: ["local"], summary: "Preview a remote MCP server, then save it with the tools listed and its credential sealed",
      description: `Each credential header's value is sealed under the server's seal key and bound to the server's name and the header, and kept in the data directory as ciphertext alone. 409 no_sealing_key when the server was handed no seal key and \`auth.type\` is not none (nothing is contacted). A body with no credential keeps the sealed one while the type and the URL's origin stay the same; else it is 422. A body with no \`prices\` keeps the saved ones for the tools still listed at the same URL, so a save from any client never leaves a paid tool unmetered; \`prices: {}\` clears them. 422 too for a bad name, URL or auth, or a price that is not a finite number 0 or more or names a tool the server does not list. ${MCP_CONNECTS} Nothing is saved unless the listing succeeds.`,
      parameters: [MCP_NAME],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: MCP_URL, auth: MCP_AUTH, prices: MCP_PRICES } } } } },
      responses: { "200": json(MCP_SERVER_VIEW, "The server, as saved."), ...errors(400, 401, 409, 415, 422, 429, 500), ...MCP_FAILED },
      "x-agentrun-serve": "mcpservers/1",
    },
    delete: {
      operationId: "deleteMcpServer", tags: ["local"], summary: "Forget a saved MCP server and its credential",
      parameters: [MCP_NAME],
      responses: { "204": { description: "Forgotten." }, ...errors(401, 404, 409, 429, 500) },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/mcp-servers/{name}/refresh": {
    post: {
      operationId: "refreshMcpServer", tags: ["local"], summary: "List a saved MCP server's tools again, keep them, and say what changed",
      description: `With its saved URL and sealed credential. \`added\` and \`removed\` are tool names; \`changed\` names a tool whose title, description, schemas or annotations differ. ${MCP_CONNECTS}`,
      parameters: [MCP_NAME],
      responses: { "200": json(closed({ added: { type: "array", items: { type: "string" } }, removed: { type: "array", items: { type: "string" } }, changed: { type: "array", items: { type: "string" } }, server: MCP_SERVER_VIEW }), "What changed, and the server now."), ...errors(401, 404, 409, 422, 429, 500, 503), ...MCP_FAILED },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/mcp-servers/{name}/oauth/start": {
    post: {
      operationId: "startMcpOAuth", tags: ["local"], summary: "Start signing in to an MCP server with OAuth: the page the owner opens",
      description: `Discovers the server's authorization server (RFC 9728, then RFC 8414) with the official MCP SDK, and its client: the \`client_id\` (and \`client_secret\`) given; else, signing in again to the same origin, the client kept from the last sign-in (its secret too); else this server's client metadata document, when this server's address is public https and the authorization server takes one; else dynamic registration. PKCE S256, and the RFC 8707 \`resource\` is the server's URL. Answers \`authorization_url\` for the owner to open; the authorization server sends the browser back to GET /settings/mcp-servers/oauth/callback within 10 minutes. 409 no_sealing_key with no seal key; 409 wrong_origin when the request came to another address than the one the callback is under (\`details.open\` says where to open the console); 424 when discovery or registration fails, or an MCP server off loopback names a private or plain-http endpoint. The answer sets a cookie (one per sign-in, \`SameSite=Lax\`, the callback's path, 10 minutes) that the callback requires.`,
      parameters: [MCP_NAME],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: MCP_URL, scopes: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } }, client_id: { type: "string", minLength: 1 }, client_secret: { type: "string", minLength: 1, description: "Only with client_id; kept sealed with the token set." } } } } } },
      responses: { "200": json(closed({ authorization_url: { type: "string", format: "uri" } }), "The page the owner opens."), ...errors(400, 401, 409, 415, 422, 429, 500), ...MCP_FAILED },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/mcp-servers/oauth/callback": {
    get: {
      operationId: "mcpOAuthCallback", tags: ["local"], summary: "Where the authorization server sends the owner's browser back", security: [{}],
      description: `Takes no token: its \`state\` (random, used once, 10 minutes, bound to the server's name) and the cookie the start set in the browser that started it (\`SameSite=Lax\`, the callback's path) are the check; without the cookie it is 403 and nothing is exchanged. Exchanges \`code\` with the PKCE verifier kept here, seals the token set (access and refresh tokens, expiry, scopes, the client) bound to the server's name, lists the server's tools as a PUT does and keeps them, then redirects to \`${MCP_SETTINGS_PAGE}?server=<name>&sign_in=ok\` (or \`sign_in=failed&error=<code>\`). 400 for a state that is unknown, used or expired.`,
      parameters: ["code", "state", "iss", "error"].map((name) => ({ name, in: "query", required: false, schema: { type: "string" } })),
      responses: { "302": { description: "To the console's MCP servers page." }, ...errors(400, 403, 429, 500) },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/mcp-servers/oauth/client.json": {
    get: {
      operationId: "mcpOAuthClient", tags: ["local"], summary: "This server's OAuth client metadata document", security: [{}],
      description: "Its own URL is its client id (CIMD): `redirect_uris` is the callback, `token_endpoint_auth_method` none. Readable without a credential, for an authorization server to fetch.",
      responses: { "200": json({ type: "object" }, "The document."), ...errors(429, 500) },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/tools": {
    get: {
      operationId: "getToolSettings", tags: ["capabilities"], summary: "The server's tool settings",
      description: "Each capability that has a choice, and its provider, and each tool's permission that is set (an MCP server's wildcard mcp:<server>/* among them): web_search auto (codex's own search or, on pi, the model provider's hosted one, else Parallel where the server holds its key, which bills it, else Exa's keyless search; claude-agent's own search only as native), native (that alone), exa-keyless (that alone) or parallel; web_fetch kernel or parallel; browser auto (Browserbase where the server holds its keys, else Kernel where it holds Kernel's), browserbase, kernel (each that alone) or chrome (a Chrome on the server's host, not set up on any server yet: unavailable). An agent's definition.tool_settings is over these. capabilities.tools say what each resolves to on each harness, and GET /agents/{agent_id} for that agent.",
      responses: { "200": json(TOOL_SETTINGS_ANSWER, "Each capability's provider."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "providers/1",
    },
    put: {
      operationId: "putToolSettings", tags: ["capabilities"], summary: "Set the providers of web_search, web_fetch and browser, and each tool's permission",
      description: "Replaces the settings: a tool the body leaves out takes its defaults. Kept in the data directory, and capabilities say so at once. A provider is read by every run launched from then on; a permission by the tool gate at each call, live runs' included (a claude-agent or codex run's own web search takes a change of web_search's at its next launch). An MCP server's wildcard, mcp:<server>/*, sets each of its tools, under a tool's own key. A pick of parallel without PARALLEL_API_KEY resolves unavailable, never to another provider, and so does a browser vendor picked without its key. An unknown tool, a provider not offered for it and a permission not offered for it are refused.",
      requestBody: { required: true, content: { "application/json": { schema: TOOL_SETTINGS } } },
      responses: { "200": json(TOOL_SETTINGS_ANSWER, "Each capability's provider now."), ...errors(400, 401, 415, 422, 429, 500) },
      "x-agentrun-serve": "providers/1",
    },
  },
  [HOME_FILES_AT]: {
    get: {
      operationId: "listHomeFiles", tags: ["agents"], summary: "Every file in the agent's home",
      description: "The agent's home is a directory of its own on this server's disk, kept across its runs (runs do not see it yet). Every regular file in it, recursively, listed as a run's files are (`GET /runs/{run_id}/files`): reached through no link, a name that starts with `.` left out. A home never written to lists none. A path of `capabilities.home.host_owned` that is there (`learning`, `sign-ins`) is one entry, `{path, host_owned: true}`, with none of what is in it.",
      parameters: [ref("parameters/AgentId")],
      responses: { "200": json(HOME_FILES, "The files."), ...errors(401, 404, 429, 500) },
      "x-agentrun-serve": "home/1",
    },
  },
  [`${HOME_FILES_AT}/{path}`]: {
    get: {
      operationId: "readHomeFile", tags: ["agents"], summary: "One file of the agent's home, raw",
      description: `Raw bytes with the file's content type, as a run's file is read (\`GET /runs/{run_id}/files/{path}\`): \`nosniff\`, a CSP on HTML, \`?download=1\` for an attachment. ${HOME_PATHS} A path at or under one of \`capabilities.home.host_owned\` (\`learning/\`, \`sign-ins/\`), as normalized, folded and by identity on disk, is \`403 system_file_forbidden\` with \`details.reason\` \`host_owned\`. Its message names the learning API (\`/v2/agents/{agent_id}/learning\`) on a server that has that route, and says this server has none on one that does not. A link on the way is \`404 not_found\`.`,
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
  "/runs/{run_id}/approvals/{approval_id}": {
    post: {
      operationId: "answerApproval", tags: ["runs"], summary: "Answer a tool call that waits for the owner's approval",
      description: "A tool set to ask parks its run at each call: status input_required, state waiting, and its view's and its summary's pending (kind approval) naming the call; a timeline row of kind tool_approval_requested follows the call's result. allow runs the call once, then resumes the session with one message that names the call and carries its result; deny resumes it with the refusal, the note as its reason. The first answer wins: the same answer again is 204, another 409 not_continuable with details {reason: already_answered, decision}. A cancel of the run marks the call canceled, and a stop withdraws it. A person's message while it waits declines it, with the message as the reason: the run resumes in one turn with the refusal and their words, its row reads `Declined by your message`, and a later answer is 409 with details.decision deny. Only the owner's password session answers, on the page's own origin with a JSON body: a bearer token is 403 forbidden, since a run's process, an agent's MCP client or a script may hold one.",
      parameters: [ref("parameters/RunId"), { name: "approval_id", in: "path", required: true, description: "The run's pending.id.", schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["decision"], properties: { decision: { enum: ["allow", "deny"] }, note: { type: "string", maxLength: 2000, description: "Why: with deny, the refusal's reason the model is told." } } } } } },
      responses: { "204": { description: "Answered: the run goes on." }, ...errors(400, 401, 403, 404, 409, 415, 422, 429, 500) },
      "x-agentrun-serve": "approvals/1",
    },
  },
  ...archiving("agents", "Agent", ref("parameters/AgentId"), "The agent, with archived_at."),
  ...archiving("runs", "Run", ref("parameters/RunId"), "The run, with archived_at."),
  ...LEARNING_EXTENSIONS,
  "/agents/{agent_id}/sign-ins/{key}": {
    delete: {
      operationId: "forgetSignIn", tags: ["agents"], summary: "Forget one of the agent's saved sign-ins",
      description: "Deletes the browser vendor's object the sign-in points to (a Browserbase context, a Kernel profile), then the sealed pointer this server kept; GET /agents/{agent_id} lists it no more, and the agent's next run with the browser starts signed out, on a new one. Best effort at the vendor: a delete it does not answer, or refuses, is said in `removed[].message` (`at_vendor: not_deleted`), and the pointer is forgotten all the same. 404 for a key the agent has no sign-in under; 409 `sign_in_held` while a run holds its save lease (`details.held_by`), until that run ends.",
      parameters: [ref("parameters/AgentId"), { name: "key", in: "path", required: true, description: "The sign-in's key, as GET /agents/{agent_id} lists it (`default`).", schema: { type: "string" } }],
      responses: {
        "200": json({ type: "object", additionalProperties: false, required: ["key", "removed"], properties: { key: { type: "string" }, removed: { type: "array", items: { type: "object", additionalProperties: false, required: ["provider", "at_vendor"], properties: { provider: { type: "string" }, at_vendor: { enum: ["deleted", "not_deleted"] }, message: { type: "string" } } } } } }, "Forgotten: what was deleted at each vendor."),
        ...errors(400, 401, 404, 409, 429, 500),
      },
      "x-agentrun-serve": "signins/1",
    },
  },
  "/settings/webhook": {
    get: {
      operationId: "getWebhook", tags: ["local"], summary: "The webhook this server POSTs run notices to, if one is set; never its secret",
      responses: { "200": json(WEBHOOK_VIEW, "The webhook, or `configured: false`."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "webhook/1",
    },
    put: {
      operationId: "saveWebhook", tags: ["local"], summary: "Set the webhook's URL",
      description: `Messages follow the Standard Webhooks spec (standardwebhooks.com), so a receiver verifies them with any of its libraries. Each is POSTed to \`url\` as JSON \`{type, timestamp, data}\`: \`run.needs_input\` when a run comes to need its person (status input_required; \`data.pending.kind\` \`question\` for an ask_person question, \`approval\` for a tool call that waits for a person's approval, \`stopped\` for a stopped turn, \`budget\` for a run paused at its spend cap) and \`run.ended\` when it ends (completed, failed or cancelled), with \`data: {run_id, agent_id, status, title, url}\`, \`url\` the run on the page; and \`trigger.failed\` when a trigger's firing could not start its run (/triggers), with \`data: {trigger_id, name, firing_key, nominal_at, error: {code, message}, auto_paused}\`, \`auto_paused\` true when it was the ${FAILURES_TO_PAUSE}th in a row and turned the trigger off, its \`webhook-id\` the same for the same firing, after a restart too; never a tool's arguments, an output or an input, which the API reads. Headers: \`webhook-id\` (the same on every try, the receiver's idempotency key), \`webhook-timestamp\` (Unix seconds) and \`webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">\` under the secret's 32 bytes; a receiver refuses a timestamp more than 5 minutes from its clock. A try not answered 2xx in 15 s (no redirect followed) is tried again after about 5 s, 5 min, 30 min, 2 h, 5 h and 10 h, with jitter, then logged as failed; pending messages go on after a restart. A 410 turns the webhook off until it is set again. The first PUT makes the secret and answers 201 with it, once; a later PUT keeps it, turns the webhook on again and answers 200. 422 for a URL that is not http or https, holds a user or password, or is over 2048 characters; 409 no_sealing_key when the server was handed no seal key to keep the secret under.`,
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
  "/triggers": {
    get: {
      operationId: "listTriggers", tags: ["local"], summary: "The triggers: schedules that start an agent's capped runs",
      description: TRIGGER_ERRORS,
      responses: { "200": json(closed({ triggers: { type: "array", items: TRIGGER } }), "Each trigger, oldest first, with its last firing."), ...errors(401, 409, 429, 500) },
      ...TRIGGER_MARK,
    },
    post: {
      operationId: "createTrigger", tags: ["local"], summary: "Make a trigger: a schedule or a signed webhook that starts a capped run of an agent, or messages a run",
      description: `Each firing starts one run of \`target.agent_id\` with \`target.input\` and its \`max_cost_usd\` (else the agent's default), as POST /agents/{agent_id}/runs would, and the run's \`trigger\` names it. A firing starts its run once, across retries and restarts. While the trigger's last run is active (working, or waiting on a person: a question, an approval, its cap), a firing is skipped. The last ${HISTORY_KEPT} firings are kept. A \`webhook\` source fires on each request to /hooks/{trigger_id} signed by its secret, which this answer holds (\`secret\`) this once: a retry under the same Idempotency-Key answers the same trigger with a \`note\` in its place, as the key's record never keeps a secret. A \`message_run\` target sends each firing's input to one run, under the firing's key, which the run's store takes once. 422 for another source kind, a start_run target with no max_cost_usd whose agent has no default one, an agent that is a workflow or does not take the input, or a run that is a workflow's; 409 no_sealing_key for a webhook trigger on a server handed no seal key.`,
      parameters: [ref("parameters/IdempotencyKey")],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["source", "target"], properties: TRIGGER_WRITE } } } },
      responses: { "201": json({ ...TRIGGER, properties: { ...TRIGGER.properties, secret: TRIGGER_SECRET, note: { type: "string", description: "On a retry under the same Idempotency-Key, in place of a webhook trigger's secret: it was shown once, and POST /triggers/{trigger_id}/secret makes a new one." } } }, "Made; a webhook trigger's first answer holds its `secret`, this once."), ...errors(400, 401, 409, 415, 422, 429, 500) },
      ...TRIGGER_MARK,
    },
  },
  "/triggers/{trigger_id}": {
    get: {
      operationId: "getTrigger", tags: ["local"], summary: "One trigger",
      parameters: [TRIGGER_ID],
      responses: { "200": json(TRIGGER, "The trigger."), ...errors(401, 404, 409, 429, 500) },
      ...TRIGGER_MARK,
    },
    patch: {
      operationId: "updateTrigger", tags: ["local"], summary: "Change a trigger, or turn it off and on",
      description: "Any of its fields. `enabled: false` stops its firings; `enabled: true` again, or a new source, goes on from now: the time it was off is skipped, never caught up. A firing already due goes on.",
      parameters: [TRIGGER_ID],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: TRIGGER_WRITE } } } },
      responses: { "200": json(TRIGGER, "Changed."), ...errors(400, 401, 404, 409, 415, 422, 429, 500) },
      ...TRIGGER_MARK,
    },
    delete: {
      operationId: "deleteTrigger", tags: ["local"], summary: "Delete a trigger and its firings; the runs it started stay",
      parameters: [TRIGGER_ID],
      responses: { "204": { description: "Deleted." }, ...errors(401, 404, 409, 429, 500) },
      ...TRIGGER_MARK,
    },
  },
  "/triggers/{trigger_id}/fire": {
    post: {
      operationId: "fireTrigger", tags: ["local"], summary: "Run it now: one firing per Idempotency-Key",
      description: "A firing now, on or off, under the same overlap rule as a scheduled one; it is driven before the answer. The same key again answers its firing as it stands (200, `Idempotent-Replayed: true`), and starts no second run, for `limits.idempotency_ttl_s` after it fired, even once the firing has left the history; past that it is a new firing, which a run the key started still answers. A firing never moves `last_run_id` back to an older run. 400 with no Idempotency-Key. 429 `rate_limited`, with Retry-After, while the trigger holds " + DUE_KEPT + " firings due.",
      parameters: [TRIGGER_ID, { name: "Idempotency-Key", in: "header", required: true, description: "Required here: a retry with the same key fires once.", schema: { type: "string", minLength: 1, maxLength: 255 } }],
      responses: { "202": json(TRIGGER_FIRING, "Fired: its run started, or why not."), "200": json(TRIGGER_FIRING, "This key's firing, as it stands."), ...errors(400, 401, 404, 409, 429, 500) },
      ...TRIGGER_MARK,
    },
  },
  "/triggers/{trigger_id}/secret": {
    post: {
      operationId: "rotateTriggerSecret", tags: ["local"], summary: "A webhook trigger's new secret, shown once; the old one signs nothing from now on",
      description: "422 for a trigger that is not a webhook's; 409 no_sealing_key when the server was handed no seal key.",
      parameters: [TRIGGER_ID],
      responses: { "200": json(closed({ secret: TRIGGER_SECRET }), "The new secret, this once."), ...errors(401, 404, 409, 422, 429, 500) },
      ...TRIGGER_MARK,
    },
  },
  "/hooks/{trigger_id}": {
    post: {
      operationId: "receiveHook", tags: ["local"], summary: "Fire a webhook trigger: a request signed by its secret, no token",
      description: `This server's one route with no token: the request's signature is its credential, checked on the raw body before anything else. It follows the Standard Webhooks spec, so a sender signs with any of its libraries: \`webhook-id\` (1 to 255 printable ASCII characters, no space; the firing's idempotency key), \`webhook-timestamp\` (Unix seconds, within ${HOOK_TOLERANCE_S} s of this server's clock either way) and \`webhook-signature\`, space-separated \`v1,<base64 HMAC-SHA256 of "{webhook-id}.{webhook-timestamp}.{body}">\` under the secret's 32 bytes (at most 2048 characters in all), any one of which may match. The body's bytes are signed as sent, whatever its content type. The body is any text, at most 256 KiB (413 past it); its first ${PAYLOAD_KEPT_BYTES / 1024} KiB reach the agent inside \`<trigger-payload source="webhook" untrusted>\`. A bad or missing signature, a stale or future timestamp, an unknown trigger, one that is off and one that is not a webhook's all answer the same 401. The first request with a webhook-id answers 202 once its firing is recorded, and its run starts after; the same webhook-id again, for a day after, answers 200 with that firing and starts nothing. A trigger holds at most ${DUE_KEPT} firings due (a message_run firing waits while its run works): past them a new webhook-id answers 429 \`rate_limited\` with Retry-After and records nothing, so the sender sends it again later.`,
      security: [],
      parameters: [TRIGGER_ID],
      requestBody: { required: true, content: { "*/*": { schema: {} } } },
      responses: { "202": json(TRIGGER_FIRING, "Recorded: its run starts (or its message goes) after this answer."), "200": json(TRIGGER_FIRING, "This webhook-id's firing, as it stands."), ...errors(401, 413, 429, 500) },
      ...TRIGGER_MARK,
    },
  },
  "/triggers/{trigger_id}/firings": {
    get: {
      operationId: "listTriggerFirings", tags: ["local"], summary: `The trigger's last ${HISTORY_KEPT} firings, newest first`,
      parameters: [TRIGGER_ID],
      responses: { "200": json(closed({ firings: { type: "array", items: TRIGGER_FIRING } }), "Each firing."), ...errors(401, 404, 409, 429, 500) },
      ...TRIGGER_MARK,
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
  description: `What the run learns from and what it learned: a run of an agent whose \`learning\` is true starts from its active notes, whole, in its instructions within the learning budget (past it, the index and the notes changed last, whole), and from the notes in \`.learning/\` in its working directory. Once it answers or fails, the server asks the same harness one more turn, under the run's cap, which answers with the notes it would keep (no tool is needed, and nothing the run writes in \`.learning/\` counts); what it answers is checked, graded by one grader (on the server's grade model or strong tier, else the agent's own model), and merged into the folder, or dropped. ${LEARNING_NULL}`,
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
/** consoleurl/1: the console's page of a run or an agent, where a person opens it. */
const CONSOLE_URL = (what: string): Json => ({ type: "string", format: "uri", description: `The ${what}'s page in this server's console, at the address people open it (the server's public URL when it has one, else the address this request reached it at): the link to give a person.`, "x-agentrun-serve": "consoleurl/1" });
const RUN_FIELDS: Record<string, Json> = {
  console_url: CONSOLE_URL("run"),
  revision: { type: "string", description: "The id of the agent revision the run runs.", "x-agentrun-serve": "serve/1" },
  kind: { enum: ["agentic", "workflow"], description: "The revision's kind: an agentic run, or a workflow run.", "x-agentrun-serve": "serve/1" },
  archived_at: { type: ["string", "null"], description: "When the run, or its agent, was archived, while it is; else null.", "x-agentrun-serve": "serve/1" },
};
/** What a run waits on, one field for every kind, told apart by `kind`: a question it asked a person, or a tool call
 *  that waits for approval. */
const PENDING: Json = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "question", "asked_at"],
      properties: { kind: { const: "question" }, question: { type: "string", description: "What it asked, at most 2000 characters." }, asked_at: { type: "string", format: "date-time" } },
      description: "A question the run asked a person (status input_required, state waiting): a message answers it.",
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "id", "tool", "call_id", "args_preview", "requested_at"],
      properties: {
        kind: { const: "approval" },
        id: { type: "string", description: "Answered at POST /runs/{run_id}/approvals/{id}; the same for the same call after a restart." },
        tool: { type: "string" },
        call_id: { type: "string", description: "The call's id, as its tool_result row's tool_use_id." },
        args_preview: { type: "string", maxLength: ARGS_PREVIEW_BYTES, description: `The call's arguments as JSON, cut at ${ARGS_PREVIEW_BYTES} bytes.` },
        requested_at: { type: "string", format: "date-time" },
        price: { oneOf: [{ type: "number", minimum: 0 }, { const: "not metered" }], description: "What the call costs, in USD, where its tool declares a price; \"not metered\" for an unpriced MCP call. Absent when the tool names none." },
      },
      description: "A tool call set to ask waits for the owner's approval (status input_required, state waiting): POST /runs/{run_id}/approvals/{id} answers it.",
      "x-agentrun-serve": "approvals/1",
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "cap_usd", "said", "at"],
      properties: {
        kind: { const: "budget" },
        cap_usd: { type: "number", exclusiveMinimum: 0, description: "The run's cap (`max_cost_usd`)." },
        spent_usd: { type: "number", minimum: 0, description: "What the cap counted as taken when it refused: spent, and held for requests still answering; once the paused process is gone, the store's spend when that is lower (those requests settled). Absent for a refusal written before the figures were kept." },
        needs_usd: { type: "number", minimum: 0, description: "The least the refused request needs. A cap above `spent_usd` + `needs_usd` sends it. Absent with `spent_usd`." },
        least_cap_usd: { type: "number", exclusiveMinimum: 0, description: "The least cap that sends the refused request: the figure `said` names (\"Raise the cap to at least $X\"), carried from the refusal that wrote those words, so the two never differ. Whole cents, always above `cap_usd`. Absent with `spent_usd`." },
        suggested_cap_usd: { type: "number", exclusiveMinimum: 0, description: "The raise this run is offered: `spent_usd` + 10 × `needs_usd`, rounded up to a whole dollar, and always above `cap_usd`, so `PATCH /runs/{run_id}` with it as `max_cost_usd` is a raise that resumes the run. Absent with `spent_usd`." },
        overshoot_bound_usd: { type: "number", minimum: 0, description: "The most a cache miss could make the refused request cost beyond `needs_usd` under the run's `cap_mode` expected (its input uncached less its input expected, rounded up to a millionth); 0 under strict, and for a request priced with nothing cached. Absent with `spent_usd`.", "x-agentrun-serve": "capmode/1" },
        said: { type: "string", description: "The cap's refusal, in its words: what was spent, what the refused request needs at the least, and the cap that would run it. At most 2000 characters." },
        at: { type: "string", format: "date-time", description: "When the request was refused." },
      },
      description: "A run paused at its spend cap (status input_required, state waiting): what is left of the cap cannot buy its next request's least, which was not sent. A message is 409 budget_reached until the cap is raised. Only a refusal for room pauses a run, a paid tool call's as a model request's (its hold is needs_usd); one no cap fixes (an unknown spend, a model with no price or no output ceiling, an input not measured) still ends it failed, spend_cap_reached.",
      "x-agentrun-serve": "cappause/1",
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
  description: "Where the run executes, as its start resolved it: its revision's place, else runner. In a sandbox place the agent's bash runs in the box, which binds only the run's work/ and has no network and no key; read, write and edit run in the box too, or on this server's copy of that work/ where the box binds it and this server holds directory handles (Docker on Linux), following no link. Its loop, its log and every key stay on the server. The Modal sandbox (box `modal`, Modal's default gVisor runtime, not a VM) never has a network: Modal takes a host list, but this server cannot read a sandbox's list back to check that it holds, so each is made blocked, and capabilities.places.boxes says so in its network_reason (unless AGENTRUN_BOX_ALLOW is none).",
  "x-agentrun-serve": "place/1",
};
/** capmode/1: how a run's cap prices a request's input. */
const CAP_MODE: Json = {
  enum: ["expected", "strict"],
  description: "How the run's cap (`max_cost_usd`) prices each model request's input. `expected` (the default): the input the previous request of its conversation reported read from or written to the cache, at the cache-read price, when that request ended less than 4 minutes before; the rest of its input (the previous request's input after the cache, and what the conversation grew by since, a token a byte) at the input price, the cache write's when dearer. With no such request, all of it at that price. Output is limited to what the cap leaves, so output never passes it; a cache miss can, by at most the request's bound (its input uncached less its input expected), served as the run's `cost.overshoot_bound_usd` while it is in flight; its real cost is booked, and the timeline says so. `strict`: every input token at the input or cache-write price, the worst case: no request passes the cap, and a run pauses sooner. Only with a cap.",
  "x-agentrun-serve": "capmode/1",
};
/** costsofar/1: a cost no one fully knows, said as what is known and how much is not, with no ceiling claimed. */
const SO_FAR = {
  so_far_usd: { type: "number", minimum: 0, description: "Set only while `usd` is null: the sum of the charges whose cost is known (model requests, a workflow's decisions, paid tool calls). Never the cost: the charges counted in `unpriced` are not in it, and nothing bounds them.", "x-agentrun-serve": "costsofar/1" },
  unpriced: { type: "integer", minimum: 1, description: "Set only while `usd` is null: how many charges have no known cost (a model request cut, stopped, still pending or with no price; a decision whose cost is unknown; a paid tool call charged an unknown amount or cut).", "x-agentrun-serve": "costsofar/1" },
};
const FIELD_EXTENSIONS: Record<string, Record<string, Json>> = {
  Cost: {
    ...SO_FAR,
    overshoot_bound_usd: { type: "number", minimum: 0, description: "Set when the run has a cap: the most its model requests in flight could cost beyond what its cap holds them at, when one misses the cache (`cap_mode` expected: each one's input uncached less its input expected, rounded up to a millionth). 0 with none in flight, under strict, and for a request priced with nothing cached. The cap never lets output pass it, so this is all a run can go over its cap by.", "x-agentrun-serve": "capmode/1" },
  },
  RunCreate: { cap_mode: { ...CAP_MODE, description: `${CAP_MODE.description as string} Absent: the agent's (its definition's \`cap_mode\`), else expected. 422 not_allowed for a run with no cap.` } },
  TimelineUsage: { ...SO_FAR, not_metered: { type: "integer", minimum: 1, description: "Set when the run made tool calls with no price (an MCP tool its owner set none for): how many. They ran outside the run's cost and its cap, and never make `usd` unknown.", "x-agentrun-serve": "mcpservers/1" } },
  UsageLine: { unpriced_runs: { type: "integer", minimum: 0, description: "How many of the runs counted on this line have a cost no one knows on it: they add no dollars to `usd`, so no sum passes them off as $0.", "x-agentrun-serve": "costsofar/1" }, not_metered_calls: { type: "integer", minimum: 1, description: "On the `tools` meter's line, set when the runs counted made tool calls with no price (an MCP tool its owner set none for): how many. They are outside `usd`.", "x-agentrun-serve": "mcpservers/1" } },
  Run: {
    ...RUN_FIELDS,
    cap_mode: { type: ["string", "null"], enum: ["expected", "strict", null], description: "How the run's cap prices each model request's input (`cap_mode` on its start, else its agent's, else expected; see RunCreate.cap_mode). Null for a run with no cap.", "x-agentrun-serve": "capmode/1" },
    last_progress_at: {
      type: ["string", "null"],
      format: "date-time",
      description: "While a message the run took is still open (an agentic run, working or queued): when its turn last wrote anything, a request's start included; it holds still while a tool or a model request runs, and moves as the turn writes. Null once every message has had its turn, and on a workflow run.",
      "x-agentrun-serve": "turnend/1",
    },
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
    trigger: RUN_TRIGGER,
  },
  InputIssue: {
    code: { type: "string", description: "A workflow definition's issue: the DSL's validation code (`STATE_PATH_UNPRODUCED`, say), with `field` the path to it under `definition.workflow`.", "x-agentrun-serve": "validate/1" },
    example: { description: "A value the field accepts, said in `message` too: the operation's documented request body's value there, else the schema's example, const or option, else one made from its type; each is suggested only once the route's own check of the body takes it in place (else the schema, for a value the document gives), so this server never suggests a value it refuses. Absent when there is none. For a field the body does not keep that an object inside it does, the body with the field where it belongs, as `fix` shows it: `{\"definition\": {\"name\": \"Due diligence\"}}`.", "x-agentrun-serve": "explain/1" },
  },
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
    trigger: RUN_TRIGGER,
  },
  RunError: {
    details: {
      type: "object", additionalProperties: false, required: ["reason"],
      properties: { reason: { enum: [LAUNCH_LOST, SETUP_LOST] } },
      description: `Why the run failed, when its code alone does not say: \`${LAUNCH_LOST}\`, the server went down while it started the run's process, which never came up, so the next start failed the run rather than start it again; \`${SETUP_LOST}\`, the server went down after the run was made and before it was set up, so it never started.`,
      "x-agentrun-serve": "launch/1",
    },
  },
  TimelineRow: {
    paused: {
      const: true,
      description: "On an `error` row that is the spend cap's refusal for room: the request was not sent and the run paused at its cap for a raise (`pending.kind` budget), so a client shows it as a pause, never as a failure. Kept once the cap is raised. Absent on every other row.",
      "x-agentrun-serve": "cappause/1",
    },
    origin: {
      enum: ["server", "trigger"],
      description: "On the row of a message the person did not write: `server`, one the server wrote into the run (a raised cap's follow-up, an approval's resume), a `phase` row \"AgentRun: <its first line>\"; `trigger`, a trigger's input (a started run's first message, or a firing's message), a `phase` row \"Trigger <trigger id>: <its first line>\". Either is where a person's message would be a `user_message` row, and counts, as a person's does, as the message its turn took. Absent on every other row.",
      "x-agentrun-serve": "origin/1",
    },
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
      description: "Where the revision's runs execute: `runner` (no box and no shell) or `sandbox` (the agent's file and shell tools run in the box; its loop, its log and every key stay on the server). Absent on a create of an agentic revision, the place this server gives a new agent (capabilities.places.default_place): the Docker box where this server has docker, ready or preparing, written on the revision so an answer shows it, with tools [\"bash\", \"bash_background\", \"bash_output\", \"bash_input\", \"bash_signal\", \"bash_list\"] when the definition names no tools (a list it names, an empty one included, is kept as named); where docker is unavailable, or the definition names a tool a box refuses (browser), none, as before. A revision saved with no place runs where this server's capabilities.places.default_place says at each run (the Docker box where docker is available or preparing now, else the runner); a workflow, and one that names a tool a box refuses, on the runner. A revision keeps the place it names, runner included. An edit that names none keeps the agent's. A box this server does not have saves with a warning, and its runs are 409 agent_not_runnable naming it (capabilities.places.boxes). Only an agentic revision in a sandbox place may name `bash` or a background tool (`bash_background`, `bash_output`, `bash_input`, `bash_signal`, `bash_list`); a workflow revision's place is runner or none (a sandbox place is 422).",
      "x-agentrun-serve": "place/1",
    },
    tool_settings: { ...TOOL_SETTINGS, description: "The agent's own tool settings (web_search's, web_fetch's and browser's provider, any tool's permission, an MCP server's wildcard mcp:<server>/*), over the server's (GET /settings/tools); absent, the server's. A grant in tools names the capability, never a provider.", "x-agentrun-serve": "providers/1" },
    learning: { type: "boolean", default: false, description: "Whether an agentic revision's runs learn: each starts from what its agent has learned, its notes in its instructions under `# Learned` (each whole within the server's learning budget, else the index and the notes changed last, whole) and in `.learning/` in its working directory, and once it answers or fails is asked one more turn to add notes there, which are checked, graded and merged. Kept when a definition says so, true or false; absent, off, and an answer shows none. An edit that leaves it out keeps the agent's. A workflow revision keeps none. On a server whose learning is off (`capabilities.features.learning`), no run learns, whatever this says.", "x-agentrun-serve": "learning/1" },
    cap_mode: { ...CAP_MODE, description: `The cap mode of each run of this agent that has a cap and names none of its own. ${CAP_MODE.description as string} An edit that leaves it out keeps the agent's. An agentic definition only: on a workflow's it is 422 not_allowed.` },
  },
  AgentCreate: {
    note: { type: "string", maxLength: 2000, description: "What the revision changes, kept with it (GET /agents/{agent_id}/revisions).", "x-agentrun-serve": "definitionbody/1" },
  },
  Agent: {
    console_url: CONSOLE_URL("agent"),
    tools: AGENT_TOOLS,
    kind: { enum: ["agentic", "workflow", null], description: "The current revision's kind; null before the agent has one.", "x-agentrun-serve": "serve/1" },
    revision: { type: ["string", "null"], description: "The current revision's id; null before the agent has one.", "x-agentrun-serve": "serve/1" },
    revisions: { type: "integer", minimum: 0, description: "How many revisions the agent has.", "x-agentrun-serve": "serve/1" },
    archived_at: { type: ["string", "null"], description: "When the agent was archived, while it is; else null.", "x-agentrun-serve": "serve/1" },
    learning: {
      type: "object", additionalProperties: false, required: ["pending"],
      description: "For an agent that learns (its current revision `learning: true`, on a server whose learning is on): what waits on it. Absent for any other agent, and from an older server.",
      properties: {
        pending: { type: "integer", minimum: 0, description: "How many of its learned items wait for its owner's OK: notes, skills and workflow drafts held with `status: pending` on its learning folder's main (approve them on GET /agents/{agent_id}/learning)." },
      },
      "x-agentrun-serve": "serve/1",
    },
  },
  Capabilities: {
    learning: {
      type: "object", additionalProperties: false, required: ["grade_model", "pending", "approve"],
      properties: {
        grade_model: { type: ["string", "null"], description: "The model that grades what a run proposes to learn: `--grade-model` (AGENTRUN_SERVE_GRADE_MODEL), else the strong tier (AGENT_MODEL_STRONG), named as the strong tier takes one; null when the server names none, and each run is graded on its agent's own model." },
        pending: { type: "boolean", const: true, description: "A risky rule, one a run's user asked for or one the run worked out (to trust a site or a seller, skip or loosen an approval or a check, or send money or data somewhere), is kept to wait for its owner's OK: committed as a note with status `pending`, in no MEMORY.md and read by no run. Its owner approves it (POST /agents/{agent_id}/learning/files/{file}/approve) or retires it." },
        approve: { type: "boolean", description: "Whether this caller can approve a note that waits for its owner's OK: true only for the owner's password session in the console. A token (the server's own included), a run, and every caller on a server with accounts off (AGENTRUN_ACCOUNTS=0) read false." },
        approve_needs: { type: "string", enum: ["password"], description: "Present when `approve` is false: what approving needs, the owner's password sign-in (set one in Settings, or sign in with it)." },
      },
      description: "How this server judges what a run proposes to learn, and who approves what waits.",
      "x-agentrun-serve": "learning/1",
    },
    places: {
      type: "object", additionalProperties: false, required: ["modes", "boxes", "allow"],
      properties: {
        modes: { type: "array", items: { enum: [...PLACE_MODES] } },
        boxes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "available", "state"], properties: { id: { enum: [...BOX_IDS] }, available: { type: "boolean" }, state: { enum: [...BOX_STATES], description: "`ready`; `preparing`, available while the server builds (or pulls) the Docker box's image at its start (a sandbox run's first box waits for it, with a timeline row); `unavailable`, with the `reason`." }, reason: { type: "string", description: "Why the box is unavailable, or what a preparing one waits for. Docker is set up by default (AGENTRUN_BOXES not set), so docker's reason says first, in plain words, what is wrong on this machine, then what to do (`Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun`); every other box AGENTRUN_BOXES does not list says the setting that lists it." }, network: { enum: [...BOX_NETWORKS], description: "What an available box reaches: `allowlist`, the hosts in `allow`, and nothing else (a Docker box through its egress proxy, on Linux with a daemon of that machine's own; a program that skips the proxy has no route; a Daytona box through Daytona's domain list, whose proxy re-signs TLS with Daytona's CA), or `none`. A Docker box's `none` comes with `network_reason`, and so does a Daytona box's when Daytona could not keep a list here (a tier that takes none); neither has one when AGENTRUN_BOX_ALLOW is `none`.", "x-agentrun-serve": "place/2" }, network_reason: { type: "string", description: "Why an available box has no network for a cause of its own, naming what the server found: a Docker in a VM, a daemon on another machine, docker info that did not answer; or a Daytona that could not keep its domain list.", "x-agentrun-serve": "place/2" } } } },
      },
      description: "The places a revision may name, this host's default, each box (whether this server has it, its state: ready, preparing or unavailable, and when not, why) and the hosts a box may reach.",
      "x-agentrun-serve": "place/1",
    },
    harnesses: {
      type: "array",
      description: "Each harness a revision may name, and whether this server runs it; when not, why. A harness whose one run needs more memory than this server has for runs is unavailable, its reason naming the numbers, and its runs are 409 agent_not_runnable.",
      items: { type: "object", additionalProperties: false, required: ["id", "available", "steer", "default_model", "run_memory_mib", "max_concurrent_runs"], properties: { id: { enum: [...HARNESSES] }, available: { type: "boolean" }, run_memory_mib: { type: "integer", minimum: 1, description: "The memory a run of this harness reserves while its process lives, in MiB, measured. A start is admitted while the runs going and it fit in this server's memory less its own; over that, 429 rate_limited with retry-after, as over `limits.max_concurrent_runs`." }, max_concurrent_runs: { type: "integer", minimum: 0, description: "The most runs of this harness alone at once here: by memory and by the cap on the count, whichever is fewer. 0 when one never fits. `limits.max_concurrent_runs` is pi's, the smallest run." }, default_model: { type: ["string", "null"], description: "The model this server runs for the harness when a definition names none (provider/model-id), or null when it runs none: the harness does not run here, or no default model here runs on it." }, steer: { type: "boolean", description: "Whether a message sent while the run works lands mid-turn (`steer`); when false, it waits for the turn's end and the answer's mode is `follow_up`." }, reason: { type: "string" }, installs: { const: "on_first_use", description: "claude-agent and codex only, while that harness's CLI is not installed in this server's data: it installs on first use. The first run on it, or the first agent saved on it, installs the version AgentRun pins (claude-agent: the Claude Agent SDK; codex: Codex) from npm into `<data>/harnesses/<harness>`, by the lock AgentRun ships, once (every run that needs it waits for that one install); a run shows a `phase` row, `Installing Claude Code (first use)…` or `Installing Codex (first use)…`, while it does. When npm fails the run fails, and its error names the command that installs it by hand. Absent once it is installed.", "x-agentrun-serve": "firstuse/1" } } },
      // harness/2: each entry took on its memory and count (run_memory_mib, max_concurrent_runs). A client that validates
      // against harness/1 refuses them, so it is a mark of its own.
      "x-agentrun-serve": "harness/2",
    },
    tools: {
      type: "array",
      description: "Every tool a revision may name (this server's closed table): whether a workflow's model nodes may use it (`nodes`), whether its code may call it (`calls`), and whether it runs here, else the variables it is missing; and its permission (the server's, its default and those offered).",
      items: {
        type: "object", additionalProperties: false, required: ["name", "summary", "nodes", "calls", "available", "harnesses", "permission", "default_permission", "permissions"],
        properties: {
          name: { type: "string" }, summary: { type: "string" }, blurb: { type: "string", description: "One short line for people (the editor's Tools grid); the model never sees it. Absent for an MCP server's tool, and on an older server.", "x-agentrun-serve": "tool-blurb/1" }, nodes: { type: "boolean" }, calls: { type: "boolean" }, call_only: { type: "boolean", description: "Only a workflow's call node runs it (pdf_pages, llm): no agentic revision or model node names it." }, sandbox_only: { type: "boolean", description: "Only an agent whose place is a sandbox names it (bash, and the background tools bash_background, bash_output, bash_input, bash_signal and bash_list): it runs in the box, and a runner has no shell." }, available: { type: "boolean" }, reason: { type: "string", description: "Why the tool is unavailable here, present whenever `available` is false: a provider pick's own words (`web_search is turned off in settings`, `parallel picked, no PARALLEL_API_KEY`), or `Needs` and the variables it is missing; for a sandbox-only tool (bash, the background tools) that no box this server has can run, `no box is set up on this server: …` with each box's own reason (`places.boxes`)." }, missing: { type: "array", items: { type: "string" } },
          harnesses: { type: "array", items: { enum: [...HARNESSES] }, description: "The harnesses that run the tool here; a revision naming it on another harness saves with a warning and its runs are 409 agent_not_runnable.", "x-agentrun-serve": "tool-harness/1" },
          providers: { type: "array", items: { type: "string" }, description: "A tool with a provider choice: the providers offered for it, its default first.", "x-agentrun-serve": "providers/1" },
          provider: { type: "string", description: "A tool with a provider choice: the server's, its default where it sets none.", "x-agentrun-serve": "providers/1" },
          default_provider: { type: "string", description: "A tool with a provider choice: the built-in default.", "x-agentrun-serve": "providers/1" },
          resolves: { ...RESOLVES, "x-agentrun-serve": "providers/1" },
          why: { ...WHY, "x-agentrun-serve": "providers/1" },
          permission: { ...PERMISSION, description: "The server's permission of the tool: its setting, else the owner's default.", "x-agentrun-serve": "approvals/1" },
          default_permission: { enum: [...PERMISSIONS], description: "The owner's default: allow for this server's tools, ask for a catalog tool.", "x-agentrun-serve": "approvals/1" },
          permissions: { type: "array", items: { enum: [...PERMISSIONS] }, description: "The permissions it may be set to.", "x-agentrun-serve": "approvals/1" },
          ask_needs: { const: "password", description: "Present on a server with accounts off (AGENTRUN_ACCOUNTS=0), on each tool ask is offered for: an approval takes the owner's password sign-in, which this server has none of, so an ask is refused at each call (`needs the owner's approval, and this server has accounts off`), never parked. Absent with accounts on.", "x-agentrun-serve": "approvals/1" },
          key: { enum: TOOL_KEYS.map((row) => row.id), description: "The tool key that unlocks it (GET /settings/tool-keys' id; the browser's, its vendor's: kernel where Kernel is picked or resolved, else browserbase): saved there, it is read by name like a secret the server is started with, and the tool's `missing` goes at once. Absent when no tool key does.", "x-agentrun-serve": "toolkeys/1" },
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
  // widening is a mark of its own. decisions/3: a provider takes `route` (parallel's, on Parallel's API or OpenRouter), which a
  // client that validates against decisions/2 refuses.
  "Capabilities/places": {
    default_place: {
      oneOf: [
        { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { const: "runner" } } },
        { type: "object", additionalProperties: false, required: ["mode", "box"], properties: { mode: { const: "sandbox" }, box: { enum: [...BOX_IDS] } } },
      ],
      description: "The place a NEW agentic agent that names none is saved with, written on its revision at its create: the Docker box (`{\"mode\": \"sandbox\", \"box\": \"docker\"}`) where this server has docker, ready or preparing (its first run waits for the image, with a timeline row), with tools [\"bash\", \"bash_background\", \"bash_output\", \"bash_input\", \"bash_signal\", \"bash_list\"] when the definition names no tools; else the runner, with `default_reason`. It is also where an agentic revision saved with no place runs, resolved at each run: a workflow, and a revision that names a tool a box refuses, run on the runner. (It replaces `places.default`, which said `runner`.)",
      "x-agentrun-serve": "place/4",
    },
    default_reason: { type: "string", description: "Why a new agent is not given a box here, when `default_place` is the runner, in docker's own words: `new agents run on the runner, because the docker box is unavailable here: <docker's reason>`, such as `Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun`, or, with AGENTRUN_BOXES set to a list without docker, empty or `none`, the setting that turns it on.", "x-agentrun-serve": "place/3" },
    allow: { type: "array", items: { type: "string" }, description: "The hosts a box whose `network` is `allowlist` may reach: AGENTRUN_BOX_ALLOW's, else the package registries and GitHub; empty when it is `none`.", "x-agentrun-serve": "place/2" },
  },
  "Capabilities/workflows": {
    decisions: {
      type: "object", additionalProperties: false, required: ["providers"],
      description: "The decision providers a workflow's typed questions (judge, pick, sift, route, ask) run on, and whether this server runs each: when not, why (`reason`); when it runs in a way an operator should know of, a `note`. `runJudge` is among `adapters` once one runs.",
      properties: {
        providers: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "available"], properties: { id: { enum: ["jev", "parallel", "openrouter"] }, available: { type: "boolean" }, reason: { type: "string" }, note: { type: "string" }, route: { enum: ["parallel", "openrouter"], description: "parallel's route here: Parallel's own API (PARALLEL_API_KEY), else Parallel's model on OpenRouter (parallel/decisions-fast, on the OpenRouter key)." } } } },
      },
      "x-agentrun-serve": "decisions/3",
    },
  },
  "Capabilities/models": {
    fast: { type: ["string", "null"], description: "`provider/model` of the fast tier, when one is fixed.", "x-agentrun-serve": "serve/1" },
    strong: { type: ["string", "null"], description: "`provider/model` of the strong tier, when one is fixed.", "x-agentrun-serve": "serve/1" },
    route_prefix: { type: ["string", "null"], description: "With `source` `gateway`, the routing prefix this server puts before the gateway's model ids (`agent-model`): every tier's model and every harness's `default_model` here is the prefix, a slash and the gateway's own id. Null with any other source, where ids are shown whole.", "x-agentrun-serve": "model/2" },
    ready: { type: "boolean", description: "Whether a revision that names no model runs here: the host names a default (`AGENT_MODEL`), or a model provider's key is here, saved (`PUT /settings/tool-keys/{key_id}`, a `model` key) or the server's own, and gives its default model, the first of anthropic, openai, openrouter that has one.", "x-agentrun-serve": "toolkeys/1" },
    needs: { enum: ["key", "model", null], description: "When `ready` is false, what would make it true: `key`, a model provider's key (none is here, or the default model's provider has none); `model`, another default model (`AGENT_MODEL` names one this server does not know). Null when ready.", "x-agentrun-serve": "toolkeys/1" },
    priced: { type: ["boolean", "null"], description: "Whether that model has a price here, which a run's `max_cost_usd` needs: false for a gateway model (`source` `gateway`) with no `AGENT_MODEL_PRICE` that pi-ai's catalog does not list in any form, whose answers' cost is unknown; a run with `max_cost_usd` on it is refused (409 agent_not_runnable, on `definition.model`), and one without runs with its cost unknown, never $0. Null while `ready` is false: no model, nothing to price.", "x-agentrun-serve": "pricing/1" },
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
    mcp_client: {
      type: "object", additionalProperties: false, required: ["routes", "transports", "auth", "at_rest", "harnesses"],
      properties: { routes: { type: "boolean" }, transports: { type: "array", items: { const: "streamable-http" } }, auth: { type: "array", items: { enum: [...MCP_AUTH_TYPES] } }, at_rest: { enum: ["sealed", "unavailable"] }, harnesses: { type: "array", items: { type: "string" }, description: "The harnesses whose agents call a saved server's tools, each granted as mcp:<server>/<tool> in definition.tools."} },
      description: "/settings/mcp-servers: remote MCP servers over Streamable HTTP, previewed and saved with the auth types listed; a credential kept `sealed` under the seal key the server was handed, `unavailable` with none, when only servers that take no credential are kept.",
      "x-agentrun-serve": "mcpservers/1",
    },
    tool_permissions: { type: "boolean", description: "Whether a tool setting may carry a permission (allow, ask, deny), which the tool gate holds every tool call to.", "x-agentrun-serve": "providers/1" },
    webhooks: {
      type: "object", additionalProperties: false, required: ["routes", "events", "signing", "at_rest"],
      properties: { routes: { type: "boolean" }, events: { type: "array", items: { enum: [...WEBHOOK_EVENTS] } }, signing: { const: "standard-webhooks/v1" }, at_rest: { enum: ["sealed", "unavailable"] } },
      description: "/settings/webhook: one URL each of `events` is POSTed to, signed by the Standard Webhooks spec; its secret kept `sealed` under the seal key the server was handed, `unavailable` with none, when no webhook is set.",
      "x-agentrun-serve": "webhook/1",
    },
    triggers: {
      ...closed({ routes: { type: "boolean" }, sources: { type: "array", items: { enum: [...SOURCE_KINDS] } }, targets: { type: "array", items: { enum: [...TARGET_KINDS] } }, overlap: { type: "array", items: { enum: [...OVERLAP] } }, min_every_s: { type: "integer" }, history_kept: { type: "integer" }, catchup_window_s: { type: "integer" }, failures_to_pause: { type: "integer" }, webhook: closed({ signing: { const: "standard-webhooks/v1" }, tolerance_s: { type: "integer" }, max_body_bytes: { type: "integer" }, payload_kept_bytes: { type: "integer" }, at_rest: { enum: ["sealed", "unavailable"] } }) }),
      description: "/triggers: schedules that start an agent's capped runs: the source and target kinds this server takes, what a firing does while the last run is active, the shortest interval, how many firings each trigger keeps, the default catch-up window, and how many failed firings in a row turn a trigger off.",
      ...TRIGGER_MARK,
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
    denied: { type: "array", items: { type: "string" }, description: "A workflow revision: the tools its call nodes call that are set to deny here." },
    asks: { type: "array", items: { type: "string" }, description: "A workflow revision: the tools its call nodes call that are set to ask here (a catalog tool's default among them). A call node cannot wait for an approval: set the tool to allow for the agent." },
    box: { enum: [...BOX_IDS], description: "The box of the revision's place, when this server does not have it (capabilities.places.boxes)." },
    not_grantable: { type: "array", items: { type: "object", additionalProperties: false, required: ["tool", "reason"], properties: { tool: { type: "string" }, reason: { type: "string" } } }, description: "The MCP tools the revision grants that are never granted here (known meta tools, which run other actions by name), each with why. Not in `unbound`: no server setup makes one grantable; remove the grant and use the server's direct tools." },
    adapters: { type: "array", items: { type: "string" }, description: "A workflow revision: the adapters it needs that this server does not bind." },
    code: { type: "boolean", description: "A workflow revision: whether it needs code this server does not run." },
    tier: { type: "string", description: "A workflow revision: the model tier this host has no model for." },
    decisions: { type: "object", description: "A workflow revision: each decision provider it needs that this host has not set up, with why and the keys that would set it up.", additionalProperties: { type: "object", additionalProperties: false, required: ["reason", "needs"], properties: { reason: { type: "string" }, needs: { type: "array", items: { type: "string" }, description: "The variables that would set the provider up. Where it has more than one route, either key is enough (parallel: PARALLEL_API_KEY or OPENROUTER_API_KEY)." } } } },
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
/** A working request body for each operation a client most often writes by hand, by operationId: served as its media type's
 *  examples, printed by the CLI's help as a `--body`, and sent to the server by a test, so none can stop working. The run
 *  and the trigger name the agent the first one makes. */
export const REQUEST_EXAMPLES: Record<string, Record<string, { summary: string; value: Json }>> = {
  createAgent: {
    agentic: {
      summary: "An agent that researches a company on the web",
      value: { definition: { id: "due-diligence", name: "Due diligence", instructions: "Research the company you are given on the web and write a short brief: what it does, who runs it, red flags, and the sources you read.", tools: ["web_search", "web_fetch"] } },
    },
  },
  createRun: {
    agentic: { summary: "An agentic agent's run, capped at $1", value: { input: { content: "Research https://stripe.com and write the brief." }, max_cost_usd: 1 } },
  },
  createTrigger: {
    schedule: {
      summary: "A capped run of an agent every Monday at 09:00 UTC",
      value: { name: "Weekly brief", source: { kind: "schedule", cron: "0 9 * * 1" }, target: { kind: "start_run", agent_id: "due-diligence", input: { content: "Research https://stripe.com again and say what changed this week." }, max_cost_usd: 1 } },
    },
  },
};

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
  // The console's password session, the one credential approving a note takes (approveLearningFile).
  ((doc.components as Json).securitySchemes as Record<string, Json>).ownerSession = {
    type: "apiKey", in: "cookie", name: "agentrun-<port>",
    description: "The owner's console session: the cookie `agentrun-<port>`, this server's port (the document as served names it), that the console sets when the owner signs in with their password (accounts on). Sent from this server's own origin; a token never stands for it.",
    "x-agentrun-serve": "learning/2",
  };
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
  // A contract field this server takes with a meaning of its own, said on it.
  definition.properties.max_cost_usd = { ...definition.properties.max_cost_usd, "x-agentrun-serve-note": "The agent's default cap of each run started without a max_cost_usd of its own (a run's own wins), kept with its revision: above 0 sets it, 0 clears it (no default), and an edit that leaves the field out keeps the agent's, so leaving a field out never removes a spend limit. An agentic definition only: on a workflow's, above 0 is 422 not_allowed, as a workflow run is not capped here." };
  // A row's usage: the contract's shape, on more rows here than the usage row (pi-durable-agent's timeline, BROWSER_CHARGE).
  const timelineRow = schemas.TimelineRow as Json & { properties: Record<string, Json> };
  timelineRow.properties.usage = { ...timelineRow.properties.usage, "x-agentrun-serve-note": "On the `usage` row, the run's cost so far. On a paid tool's charge row (a `phase` row, \"Tool cost: monid charged $0.0030 for monid.run\", `tool_name` the tool, `tool_use_id` the call), that charge alone. On a browser call's `tool_use` row (`tool_name` one of the browser's tools: snapshot, run, browser_read, ...), the browser session time booked under that call: what the session ran since its last charge, and, on the session's last call, its release's charge topped up to the provider's minimum. A browser charge has no row of its own. A charge booked after the row was served (a release after the answer) is served as a change of that row, with the same `id` and its new `usage`. `requests` is 0 on every row but the usage row; `usd` is null once a charge on the row has no price, with `so_far_usd` and `unpriced` saying what is known. The run's cost counts each charge once, wherever it shows: summing every row's `usage` but the usage row's gives what its paid tools charged." };
  // ErrorBody.fields beyond `input_invalid`: a 409 agent_not_runnable names each thing that keeps the run from starting.
  const errorBody = schemas.ErrorBody as Json & { properties: Record<string, Json> };
  errorBody.properties.fields = { ...errorBody.properties.fields, "x-agentrun-serve-note": "Also on `agent_not_runnable` (409) here: each thing that keeps the run from starting, by the field it is about, its reason, its message and the fix when there is one (such as AGENT_MODEL_PRICE for a capped run on a model with no price), as a 422 names each field." };
  const noted = ["DefinitionInput.max_cost_usd", "TimelineRow.usage", "ErrorBody.fields"];
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
  // An agentic run's cancel is its end at once: the 202 reads `cancelled`, and no later end of its turn moves it.
  const cancel = (doc.paths["/runs/{run_id}/cancel"] as Json).post as Json;
  cancel.description = `${String(cancel.description).trimEnd()}\nHere an agentic run reads \`cancelled\` from the 202 on, \`final\` once it has stopped: a run's first terminal status is its last, so nothing its cut turn writes later (an answer, a cost over its cap) moves it. A workflow run reads \`cancelled\` once its workflow has stopped.\n`;
  cancel["x-agentrun-serve-changed"] = { description: "turnend/1" };
  changed.push("POST /runs/{run_id}/cancel");
  // A run create's key is kept with its run in the agent store (its origin), so it replays that run past the key's day.
  const createRun = (doc.paths["/agents/{agent_id}/runs"] as Json).post as Json;
  createRun.description = `${String(createRun.description).trimEnd()}\nHere a create's \`Idempotency-Key\` is also kept with the run it started, written in the agent store with the run itself: the same key and body replays that run, as it reads now, for as long as the run exists (after any restart, and past \`limits.idempotency_ttl_s\`, which bounds the other creates' keys); another body under the key is \`409 idempotency_mismatch\`.\n`;
  createRun["x-agentrun-serve-changed"] = { description: "runorigin/1" };
  changed.push("POST /agents/{agent_id}/runs");
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
  // browser/1: the browser tool runs on Browserbase or Kernel, picked per server and per agent (tool-plane.ts), so
  // capabilities' `features.browser` names Kernel's where the server's settings resolve to it, which the contract's enum
  // (browserbase, chrome, none) lacks.
  const browser = ((schemas.Features as Json).properties as Record<string, Json>).browser as Json & { enum?: string[] };
  if (Array.isArray(browser.enum) && !browser.enum.includes("kernel")) {
    browser.enum = [...browser.enum, "kernel"];
    browser["x-agentrun-serve"] = "browser/1";
    fields.push("Features.browser.kernel");
  }
  // signins/1: a saved sign-in whose pointer does not open under this server's seal key (sign-ins.ts) reads `unreadable`,
  // which the contract's SignIn.state (ready, held) lacks.
  const signInState = ((schemas.SignIn as Json).properties as Record<string, Json>).state as Json & { enum?: string[] };
  if (Array.isArray(signInState.enum) && !signInState.enum.includes("unreadable")) {
    signInState.enum = [...signInState.enum, "unreadable"];
    signInState.description = "`held` while a run holds its save lease, else `ready`. `unreadable` (this server's own): its pointer does not open under this server's seal key (none now, or another), so runs start signed out and none is made in its place until it is forgotten (DELETE /agents/{agent_id}/sign-ins/{key}); its `held_by` names a run that still holds its lease, else null.";
    signInState["x-agentrun-serve"] = "signins/1";
    fields.push("SignIn.state.unreadable");
    // An unreadable sign-in still names a run that holds its lease (held_by), as a held one does; a ready one never.
    const signIn = schemas.SignIn as Json & { else?: Json };
    if (signIn.else) {
      signIn.else = { if: { properties: { state: { const: "unreadable" } } }, then: { properties: { held_by: { oneOf: [ref("schemas/Id"), { type: "null" }] } } }, else: signIn.else, "x-agentrun-serve": "signins/1" };
      fields.push("SignIn.else");
    }
  }
  // A workflow run pauses here (POST /runs/{run_id}/pause): its status reads `paused` until it is resumed.
  const runStatus = schemas.RunStatus as Json & { enum?: string[] };
  if (Array.isArray(runStatus.enum) && !runStatus.enum.includes("paused")) {
    runStatus.enum = [...runStatus.enum.slice(0, runStatus.enum.indexOf("working") + 1), "paused", ...runStatus.enum.slice(runStatus.enum.indexOf("working") + 1)];
    runStatus["x-agentrun-serve"] = "pause/1";
    fields.push("RunStatus.paused");
  }
  // runnable/1: a 409 agent_not_runnable's `fields` (server.ts runnable) name what keeps a run from starting, many of them a
  // setting this host lacks (`not_set_up_here`, runnable.ts NOT_SET_UP), a reason the contract's InputIssue enum lacks.
  const issueReason = ((schemas.InputIssue as Json).properties as Record<string, Json>).reason as Json & { enum?: string[] };
  if (Array.isArray(issueReason.enum) && !issueReason.enum.includes(NOT_SET_UP)) {
    issueReason.enum = [...issueReason.enum, NOT_SET_UP];
    issueReason["x-agentrun-serve"] = "runnable/1";
    fields.push(`InputIssue.reason.${NOT_SET_UP}`);
  }
  // A paid tool's charges (monid's) are a meter of their own on /usage, beside the model's tokens.
  const meter = schemas.Meter as Json & { enum?: string[] };
  if (Array.isArray(meter.enum) && !meter.enum.includes("tools")) {
    meter.enum = [...meter.enum, "tools"];
    meter["x-agentrun-serve"] = "toolcost/1";
    fields.push("Meter.tools");
  }
  // A tool call that waited for a person's approval has a row of its own (runs.ts).
  if (Array.isArray(timelineKind.enum) && !timelineKind.enum.includes(APPROVAL_ROW)) {
    timelineKind.enum = [...timelineKind.enum, APPROVAL_ROW];
    fields.push(`TimelineKind.${APPROVAL_ROW}`);
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
    // The newest addition that widened it: a client that validates against mcpservers/1 refuses budget_reached.
    errorCode["x-agentrun-serve"] = "cappause/1";
    fields.push(...own.map((code) => `ErrorCode.${code}`));
  }
  const details = ((schemas.ErrorBody as Json).properties as Record<string, Json>).details!;
  details["x-agentrun-serve-details"] = {
    agent_not_runnable: NOT_RUNNABLE_DETAILS, system_file_forbidden: FORBIDDEN_DETAILS,
    auth_required: closed({ auth: { enum: ["bearer", "oauth"], description: "What the MCP server asks for: `oauth` when it names protected-resource metadata, else `bearer`." }, status: { enum: [401, 403] } }),
    upstream_failed: { type: "object", additionalProperties: false, properties: { status: { type: "integer", description: "The MCP server's HTTP status, when it answered one." } } },
    wrong_origin: closed({ open: { type: "string", format: "uri", description: "Where to open the console to sign in: the address the authorization server sends the browser back to." } }),
  };
  const extensions: string[] = [];
  for (const [path, item] of Object.entries(EXTENSIONS)) {
    for (const [method, op] of Object.entries(item)) {
      (doc.paths[path] ??= {})[method] = { "x-agentrun-serve": true, ...op };
      extensions.push(`${method.toUpperCase()} ${path}`);
    }
  }
  // examples/1: a working body for the operations in REQUEST_EXAMPLES, on the JSON media type; a contract operation that
  // gains one is changed, and says so.
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const examples = REQUEST_EXAMPLES[op.operationId as string];
      if (!examples) continue;
      (((op.requestBody as Json).content as Json)["application/json"] as Json).examples = structuredClone(examples);
      if (op["x-agentrun-serve"] !== undefined) continue;
      op["x-agentrun-serve-changed"] = { ...(op["x-agentrun-serve-changed"] as Json | undefined), requestBody: "examples/1" };
      if (!changed.includes(`${method.toUpperCase()} ${path}`)) changed.push(`${method.toUpperCase()} ${path}`);
    }
  }
  doc.info["x-agentrun-serve"] = {
    description: "Served by @parcha/agentrun-serve: the contract as vendored, unchanged, with this server's marks. Operations and schema properties marked x-agentrun-serve are this server's own, outside the contract (fields lists the properties, each marked with the addition that made it); operations marked x-agentrun-serve-unsupported answer 501 unsupported_here here; operations marked x-agentrun-serve-changed take more than the contract gives, each change named (changed lists them); a contract property marked x-agentrun-serve-unsupported is one this server refuses (unsupported_fields, with why); x-agentrun-serve-details gives what a code's details hold here (details lists where); x-agentrun-serve-note says what a contract property means here (notes lists them). servers is this server, relative to this document; the contract's own are in contract_servers.",
    extensions,
    changed,
    fields,
    unsupported_fields: refused,
    details: ["ErrorBody.details"],
    notes: noted,
    unsupported,
    contract_servers: doc.servers,
  };
  // This document is read from the server it describes, wherever it is published: a client generated from it calls
  // that server, not the first of the contract's.
  doc.servers = [{ url: "/v2", description: "This server." }];
  return doc;
}

/** The document as served on `port`: the owner's session cookie named as the console sets it on that port
 *  (page.ts: `agentrun-<port>`). Without a port, the document as built. */
export function servedOpenapi(doc: Json, port: number | undefined): Json {
  if (port === undefined) return doc;
  const components = doc.components as Json;
  const schemes = components.securitySchemes as Record<string, Json>;
  return { ...doc, components: { ...components, securitySchemes: { ...schemes, ownerSession: { ...schemes.ownerSession, name: `agentrun-${port}` } } } };
}
