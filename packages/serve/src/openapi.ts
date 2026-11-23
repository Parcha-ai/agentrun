import {CLI_LEARNING_BINDING,CLI_LEARNING_RUN,CLI_LEARNING_PATHS} from "./cli-learning/schema.js";
import { OBSERVATION_PATHS } from './observation/schema.js';
import { SDK_BINDING, SDK_PATHS, SDK_RUN } from "./sdk/schema.js";
import { NATIVE_BINDING, NATIVE_RUN, NATIVE_PATHS } from "./native/schema.js";
// The OpenAPI document this server serves at GET /v2/openapi.json: the agentrun.v2/0 contract as vendored in
// src/openapi/agentrun-v2.openapi.json (its source is in its info), with this server's marks. The contract's operations are
// not changed: an operation answered 501 here carries `x-agentrun-serve-unsupported` with the reason, one this server does
// not serve at all (NOT_SERVED) is left out of the document, and this server's own routes are added as operations marked
// `x-agentrun-serve` (true, or the addition that made it, as `stats/1`), listed in `info.x-agentrun-serve`.
import { readFileSync } from "node:fs";
import { CALL_RESULT_CHARS, CAPS, TRIGGER_SOURCES } from "./timeline/index.js";
import { EMAIL_SCOPES, PASSWORD_MAX, SCOPED_TOOLS, SEND_CAP } from "./email/names.js";
import { PAYLOAD_KEPT_BYTES, type TriggerAdapter } from "./trigger-adapter.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { CORRECTIONS_CAP } from "./learn/index.js";
import { ERROR_STATUS } from "./errors.js";
import { COMPUTER_UNAVAILABLE_CODE } from "./computer-lost.js";
import { MAX_NEEDS, NEED_NAME } from "./computer-needs.js";
import { RUNNER_REFUSED_CODE } from "./runner/presence.js";
import { TAKE_OVER_MINUTES } from "./computer-routes.js";
import { VIEWER_CREDENTIAL_MS } from "./viewer-credential.js";
import { HOLD_MAX_MINUTES, HOLD_MINUTES } from "./computer-held.js";
import { CALL_MS, PROTOCOL_METHODS } from "./computer-channel.js";
import { LAUNCH_LOST, SETUP_LOST } from "./files.js";
import { HARNESS_ID_PATTERN, HARNESSES } from "./harness.js";
import { LEARNING_LABEL, LEARNING_MODES, LEARNING_REASONS, LEARNING_STATES, RUN_LEARNING_USE } from "./learning.js";
import { AUDIT_DEFAULTS, AUDIT_MAX, REPICK_MAX_CHARS_DEFAULT, REPICK_MAX_CHARS_MAX } from "./learning-setting.js";
import { AFTER_STATES, CHEAPER_AFTER_RUNS, COST_CSV_COLUMNS, COST_WINDOW, COST_RUNS_DEFAULT, COST_RUNS_MAX, RUN_PATHS } from "./learning-cost.js";
import { FEEDBACK_ROUNDS, FEEDBACK_STATUSES } from "./runner/feedback-round.js";
import { COMPILE_AFTER_MAX } from "./learning-setting.js";
import { LOOP_COMPILES_MAX } from "./store-reads/loop.js";
import { GRADE_SOURCES, GRADES_KEPT, LABEL_MAX } from "./learn/promote.js";
import { MODEL_SOURCES, THINKING_LEVELS } from "./model.js";
import { MAX_MODEL_KEY_CHARS } from "./run-model-key.js";
import { MIN_SECRET } from "./learn/secrets.js";
import { HANDED_SECRET } from "./handed-secret.js";
import { BOX_IDS, BOX_NETWORKS, BOX_STATES } from "./place-offers.js";
import { PLACE_MODES } from "./place.js";
import { TOOL_FIELDS, TOOL_KEYS, UNREADABLE } from "./tool-keys.js";
import { MAX_KEY as MAX_RUN_KEY } from "./run-keys.js";
import { MCP_AUTH_TYPES } from "./mcp-probe.js";
import { CATALOG_KEY_PATTERN, MCP_SERVER_NAME } from "./tool-names.js";
import { MAX_PRIVATE_HOSTS } from "./mcp-private-hosts.js";
import { COMPOSIO_KEY_ENV, COMPOSIO_ORIGIN } from "./composio-made.js";
import { COMPOSIO_AUTH_CONFIG_ID, COMPOSIO_USER_ID } from "./composio-preset.js";
// The predicate of MCP's fields this document marks x-agentrun-secret, registered with the one gate as it loads.
import "./mcp-secret-writes.js";
// The email account's routes (email/routes.ts), each marked x-agentrun-secret whole, registered with the one gate as it
// loads: the view among them, so the API token never reads the account.
import "./email/routes.js";
// The calendar's routes (calendar/routes.ts), each marked x-agentrun-secret whole, registered the same way: the view
// among them, so the API token never reads which calendar is saved.
import "./calendar/routes.js";
import { MCP_SETTINGS_PAGE } from "./mcp-oauth.js";
import { ATTEMPTS_KEPT, MESSAGE_TYPES, WEBHOOK_EVENTS } from "./webhooks.js";
import { SLACK_EVENTS, SLACK_HOST, SLACK_MESSAGE_TYPES } from "./slack.js";
import { DEFAULT_SCHEME, SCHEME_NAMES, SIGNATURE_SCHEMES } from "./trigger-signatures.js";
import { HOOK_BODY_MS } from "./push-handler.js";
import { CATCHUP_WINDOW_S, DUE_KEPT, MAX_ACTIVE_RUNS, SEEN_KEPT, FAILURES_TO_PAUSE, FIRING_STATUSES, HISTORY_KEPT, MAX_EVERY_S, SOURCE_KINDS, TARGET_KINDS } from "./triggers.js";
import { DEFINITION_FIELDS, EXTERNAL_NAME, MODEL_REF } from "./validate.js";
import { CATEGORIES, COMPUTER_ENTRIES, GRADER_TYPES, MODEL_TIERS } from "./templates.js";
import { EXPORT_NOTE_KINDS } from "./agent-package.js";
import { MCP_SOURCES } from "./mcp-sources.js";
import { NOT_SET_UP } from "./runnable.js";
import { PRICED_BY_USAGE } from "./monid.js";
import { APPROVAL_ROW, ARGS_PREVIEW_BYTES, MAX_PIN_ARGS, MAX_PIN_CHOICES, PERMISSIONS } from "./tool-gate.js";
import { BROWSER_VENDOR_IDS, DECISION_PROVIDER_KEYS, KIND_KEYS, MAX_PIN_TEXT, permissionsOf, type Pickable, PICKABLE, PROVIDERS } from "./tool-plane.js";
import { tableTools } from "./tool-list.js";
import { SECRET_META_SCHEMA } from "./secret-writes.js";
import { LABEL_KEY, MAX_LABEL_VALUE, MAX_LABELS } from "./run-labels.js";
import { COST_BASES } from "./runner/metrics.js";
import { BASH_POLICIES } from "./bash-read-only.js";
// The modules that own the computer and Archil key writes: loading the document loads their secret-write predicates
// (secret-writes.ts registerSecretWrite), so every operation the document marks has its predicate wherever it is read.
import "./computers.js";
import { ARCHIL_KEY_NAMES } from "./archil-routes.js";
import { RUN_FILE_CUT_MAX } from "./run-files.js";
import { ATTACH_HEARTBEAT_MS, ATTACH_IDLE_MS, ATTACH_SUBPROTOCOL, MAX_LINE_BYTES, PAIRING_CODE_PATTERN, PAIRING_CODE_TTL_MS, PROTOCOL_VERSION } from "@parcha/agentrun-computer";
import { DAEMON_FETCHES_PER_MINUTE, PAIR_TRIES_PER_MINUTE, PAIRED_NAME_MAX } from "./computer-attach.js";

type Json = Record<string, unknown>;

/** runlabels/1: a run's labels, given at its start and served on every read of it (run-labels.ts). */
const RUN_LABELS: Json = {
  type: "object",
  maxProperties: MAX_LABELS,
  propertyNames: { pattern: LABEL_KEY.source },
  additionalProperties: { type: "string", minLength: 1, maxLength: MAX_LABEL_VALUE },
  "x-agentrun-serve": "runlabels/1",
};
/** runlabels/1: GET /runs' and GET /agents/{agent_id}/runs' filter on a run's labels. */
const LABEL_PARAMETER: Json = {
  name: "label", in: "query", required: false,
  description: "Only runs holding this label: `<key>:<value>`, split at the first `:` (a key holds none). Once per request; a second `label`, or one that does not read as a label, is 400.",
  schema: { type: "string" },
  "x-agentrun-serve": "runlabels/1",
};

/** Why each capability this server turns off answers 501, by the route's capability. */
export const UNSUPPORTED: Readonly<Record<string, string>> = {
  quotes: "This server has no billing, so it gives no quotes.",
};

/** The contract's operations this server does not serve, and never will as they are: a home's packed export and import
 *  (its files are read and written one by one, under /agents/{id}/home/files) and a run's kill (stop and cancel end a
 *  run). They are left out of the served document, so no client is generated for them, and their paths answer 404.
 *  Capabilities say each is off (home.export, home.import, runs.kill). */
export const NOT_SERVED: readonly string[] = ["exportHome", "importHome", "killRun"];

const ref = (name: string) => ({ $ref: `#/components/${name}` });
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [String(code), ref(`responses/${{ 400: "BadRequest", 401: "Unauthenticated", 403: "Forbidden", 404: "NotFound", 409: "Conflict", 410: "Gone", 412: "PreconditionFailed", 413: "PayloadTooLarge", 415: "UnsupportedMediaType", 422: "Unprocessable", 429: "RateLimited", 500: "Internal", 501: "Unsupported", 503: "Unavailable" }[code]}`)]));
const json = (schema: unknown, description: string) => ({ description, content: { "application/json": { schema } } });
/** GET /health's answer (host.ts Health; listen-first.ts while the server is warming). */
const HEALTH = {
  type: "object", additionalProperties: false, required: ["status", "checks"],
  properties: {
    status: { enum: ["ok", "degraded", "failing", "warming"], description: "`degraded` (answered 200, as `ok` is): the server serves, and every runner here refused to claim any run (`checks.runner`), so a platform's health check never restarts it over a runner's setting. `failing` (503): the store or the disk." },
    checks: {
      type: "object", additionalProperties: false, required: ["store", "disk"],
      properties: {
        store: { enum: ["ok", "does_not_open", "opening"] },
        disk: { enum: ["ok", "below_floor", "cannot_check"] },
        runner: { enum: ["refused"], description: "Present only while every runner here refused to claim any run (its run isolation refused): no run starts until one is started again as `runner_refused` says.", "x-agentrun-serve": "runners/1" },
      },
    },
    runner_refused: { type: "string", description: "With `checks.runner`: why no runner here can take a run, in the runners' own words and their fix.", "x-agentrun-serve": "runners/1" },
  },
};

const COUNT = { type: "integer", minimum: 0 };
/** A sandbox's needs, as computer-needs.ts holds them (needsIssues): one schema for the agent's computer and a template's manifest. */
const NEEDS = { type: "array", items: { type: "string", pattern: NEED_NAME.source }, minItems: 1, maxItems: MAX_NEEDS, uniqueItems: true };

/** What a harness promises (harness-table.ts HarnessPromises), as capabilities show it. */
const HARNESS_PROMISES = {
  type: "object", additionalProperties: false, required: ["resume", "tool_gate", "billing"],
  description: "What the harness promises, each measured on its pinned build, never named. The built-in harnesses (pi, claude-agent, codex, opencode) promise exact resume, every call gated, proxy billing.",
  "x-agentrun-serve": "harness-table/1",
  properties: {
    resume: { enum: ["exact", "load", "restart"], description: "After a crash: `exact`, its state mirrored into the run's journal; `load`, the agent's own session load; `restart`, the turn restarts with a recovery note." },
    tool_gate: { enum: ["every_call", "permission", "config"], description: "What holds its tool calls: `every_call`, each blocks until journaled; `permission`, the agent's permission requests; `config`, its own tools off by its config and this server's tools gated." },
    billing: { enum: ["proxy", "plan"], description: "Who pays for its model: `proxy`, through the run's model proxy, on this server's keys and under its cap; `plan`, the vendor bills the person's own plan, bounded by turn and tool-call limits, not by this server's cap." },
  },
};
const closed = (properties: Json, description?: string) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties, ...(description ? { description } : {}) });
const USD = { type: ["number", "null"], minimum: 0, description: "The sum of the known costs, rounded to 1e-6; null when no run's cost is known, never 0 for unknown." };
/** Runs counted together (AgentStoreReader.analytics's AnalyticsGroup). */
const GROUP = {
  runs: COUNT, completed: { ...COUNT, description: "Completed, escalated runs included: one completed and waits for a person's review." },
  needs_review: { ...COUNT, description: "Of `completed`, the escalated runs, which wait for a person's review.", "x-agentrun-serve": "stats/3" },
  failed: { ...COUNT, description: "Failed: never an escalated run." },
  runs_with_metrics: { ...COUNT, description: "Of `runs`, those that ended with metrics: a running run, and a run whose end wrote none, has none." },
  runs_with_token_metrics: { ...COUNT, description: "Of `runs`, those that ended with all four token counters reported. Metrics objects with missing or null counters do not count." },
  tokens: { ...COUNT, type:["integer","null"], description: "Input, cache read, cache write and output tokens, summed only over `runs_with_token_metrics`. A partial total remains visible when other runs have unknown usage. Null when runs exist but none has a complete token count; zero for an empty scope." },
  cost_usd: USD, unknown_cost_runs: { ...COUNT, description: "Runs with no known cost: running, or ended without one." },
};
/** GET /stats's `analytics` (stats.ts analyticsView). */
const ANALYTICS = closed({
  usage: closed({
    tokens: { ...COUNT, type: ["integer", "null"], description: "Known token lower bound across recorded runs and connected source sessions. Ambiguous overlapping aggregates retain the larger coherent view; distinct immutable CLI prompt windows can sum. Null when no included source reports a total." },
    input: { ...COUNT, type: ["integer", "null"], description: "Uncached input; null when a counted source cannot split cached input." },
    output: { ...COUNT, type: ["integer", "null"] },
    cache_read: { ...COUNT, type: ["integer", "null"] }, cache_write: { ...COUNT, type: ["integer", "null"] },
    known_runs: { ...COUNT, description: "Runs contributing known usage to the selected lower bound." }, unknown_runs: { ...COUNT, description: "Runs with missing counters or unresolved overlap. A run can contribute a known lower bound and also have incomplete coverage." },
    observed_sessions: { ...COUNT, description: "Distinct source session identities with usable reported tokens in scope, including when a larger captured view supplies the selected total." },
    unknown_sessions: { ...COUNT, description: "Source session identities with missing reports or unresolved overlap between report copies. A session may have known usage and also incomplete coverage." },
    partial_days: { ...COUNT, description: "UTC boundary days whose source aggregates cannot be split exactly and were excluded." },
    retention_limited: { type: "boolean", description: "The requested observed range extends beyond the retained 90 days; older source usage is unavailable." },
    by_day: { type: "array", items: closed({ day: { type: "string", format: "date" }, tokens: { ...COUNT, type: ["integer", "null"] } }) },
    by_harness: { type: "array", items: closed({ harness: { type: "string" }, tokens: { ...COUNT, type: ["integer", "null"] } }) },
  }, "Unified reported token usage. Runs use their server start date; connected usage uses its retained observation UTC day. Verified session identity groups potentially overlapping views, independently of learning state. Server receipt dates do not prove native execution intervals: unknown coverage remains explicit. Daily source buckets are included only when fully inside the requested range."),
  filter: closed({ from: { type: ["string", "null"], format: "date-time" }, to: { type: ["string", "null"], format: "date-time" }, agent: { type: ["string", "null"] } }, "The query's bounds, each null when not given: runs started at or after `from` and before `to`, of `agent`."),
  totals: closed({
    ...GROUP, input: {...COUNT,type:["integer","null"]}, cache_read: {...COUNT,type:["integer","null"]}, cache_write: {...COUNT,type:["integer","null"]}, output: {...COUNT,type:["integer","null"]},
    requests: { ...COUNT, type: ["integer", "null"], description: "Model requests; null if native runtimes in scope cannot report the count." }, unmetered: { ...COUNT, type: ["integer", "null"], description: "Of `requests`, those whose tokens are unknown; null when request counts are unavailable." },
  }, "Over every run the filter picks. `input` excludes cached input: the whole input is `input + cache_read + cache_write`."),
  time: closed({ ended_runs: COUNT, wall_ms: { ...COUNT, description: "Ended minus started, summed over `ended_runs`." }, active_runs: COUNT, active_ms: { ...COUNT, description: "How long the runs were at work, summed over the `active_runs` whose metrics say." } }),
  by_harness_effort: { type: "array", description: "By the revision's harness (`pi` when it names none, `workflow` for a workflow revision), then the effort the run's metrics name (null: unset, or no metrics).", items: closed({ harness: { type: "string" }, effort: { type: ["string", "null"] }, ...GROUP }) },
  by_day: { type: "array", description: "By the UTC date the run started, oldest first.", items: closed({ day: { type: "string", format: "date" }, ...GROUP }) },
  by_source: { type: "array", description: "`live`, run here, first, then each source runs were imported from.", items: closed({ source: { enum: ["live", "claude-code", "codex", "pi"] }, ...GROUP }) },
  tools: { type: "array", maxItems: 20, description: "The 20 tools with the most calls, by name on a tie; `errors` counts the calls that failed (an error, a result the tool reads as failed such as a refused fetch, or no result at all).", items: closed({ tool: { type: "string", description: "The name the tool was called by." }, label: { type: "string", description: "What a person calls the tool, from the timeline's label registry; the name it was called by when it has none.", "x-agentrun-serve": "stats/3" }, calls: COUNT, errors: COUNT }) },
}, "The runs' tokens, requests, time and tool calls from their metrics, over the runs not archived that the query picks; a run with no metrics counts in `runs` alone.");
/** GET /stats's answer (stats.ts). */
/** GET /capacity's answer (capacity.ts CapacityView). */
const CAPACITY = closed({
  at: { type: "string", format: "date-time", description: "When it was read, on the store's clock (the database's on Postgres)." },
  runs: closed(
    {
      queued: { ...COUNT, description: "Runs waiting for a runner now: queued, handed back or with their claim run out (past any backoff), or parked with something to wake them. The backlog a scaler reads." },
      executing: { ...COUNT, description: "Runs a live claim holds now, on any runner." },
    },
    "The store's runs, by whether a runner holds them.",
  ),
  runners: {
    type: "array", description: "Each live runner (it said it was there within the last 30 s), by name.",
    items: closed({
      id: { type: "string", description: "The runner's name." },
      version: { type: ["string", "null"], description: "Its build's version; null for a runner of an earlier build." },
      slots: { type: ["integer", "null"], minimum: 0, description: "The most runs it holds at once; null when it did not say (an earlier build, or a runner that refused to claim)." },
      executing: { ...COUNT, description: "The runs its live claims hold now." },
      free_slots: { type: ["integer", "null"], minimum: 0, description: "`slots` less `executing`, never below 0; 0 for a runner that refused to claim, null with no `slots`. A runner also claims by its host's memory, so a free slot is the most it may take." },
      refused: { type: "boolean", description: "It refused to claim any run; capabilities' `runner_refused` has its words." },
      seen_at: { type: "string", format: "date-time", description: "When it last said it was there." },
    }),
  },
  free_slots: { ...COUNT, description: "The free slots of every live runner that said its slots." },
  hand_backs: closed(
    {
      window_minutes: { type: "integer", minimum: 1, maximum: 1440, description: "The window asked for (`window`)." },
      count: { ...COUNT, description: "Runs a runner gave back still running within the window: a drain, a loop that closed itself, a claim given back. A claim whose lease ran out is not counted here." },
    },
    "The hand-backs within the window.",
  ),
});

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
      basis: { type: ["string", "null"], enum: [...COST_BASES, null], description: "How the summed costs were reached, by how each run's model requests were priced (a run's `cost.basis`): `reported` when every run summed that priced a request had each priced by its provider or gateway, `estimate` when any run's was priced from a price table (a run that ended before this was recorded, or whose figure is its harness's own, counts as `estimate` when it cost anything), `unpriced` when no run summed priced a request. Null when `usd` is null.", "x-agentrun-serve": "costbasis/1" },
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
      in_progress: { ...COUNT, description: "Seeded or reflecting: runs this server holds." },
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
          model: { type: "string", description: "A model node's (agent, decide, extract, report) once it ran: the model it ran on, as the run's model route names it; a decision node's, the model its provider answered with (its newest receipt's). Absent on every other node." },
          tier: { type: "string", description: "The tier a model node named (`fast`, `strong`), beside its model; absent for none, which runs on the run's own model." },
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
/** GET /runs/{run_id}/usage's answer (run-usage.ts): one run's cost by line. Its line is not the contract's UsageLine
 *  (GET /usage's, a sum over runs by group). */
const COST_WORDS = {
  so_far_usd: { type: "number", minimum: 0, description: "Beside a null `usd`, or a bound: what is known of it, the charges' own figures alone." },
  unpriced: { type: "integer", minimum: 0, description: "Beside `so_far_usd`: how many of its charges have no known figure, or count at their hold." },
  upper_bound: { const: true, description: "`usd` counts a request a crash or a stop cut at the hold its cap kept for it: the most it can have cost." },
};
/** Which attempt at a turn a part of a run's usage was made in (store run_attempts), and whether it is billable. */
const ATTEMPT_FIELDS = {
  attempt: { type: ["integer", "null"], minimum: 1, description: "The attempt at its turn this was made in: 1 the turn's first, 2 its first redo, and so on. A turn is redone when the claim working it was cut (its runner drained for a deploy, crashed or lost its lease, or the turn was tried again) and another claim worked it again. Null for a run whose claims kept no attempt (one from before this server kept them).", "x-agentrun-serve": "runusage/5" },
  billable: { type: "boolean", description: "False for model requests an attempt sent and never finished (cut in flight, or cut off by a crash) when a later attempt worked its turn again: that attempt sends them again, so their cost is the infrastructure's (the run's `infra_usd`), not the task's. True for every other part: an answered request, a paid call, browser and computer time, which the attempt that takes a turn over reuses, and every part of a run whose claims kept no attempt. Data only: `usd`, `total` and the run's `cost.usd` hold it either way, and nothing is charged differently by it.", "x-agentrun-serve": "runusage/5" },
};
const RUN_USAGE_LINE = {
  type: "object", additionalProperties: false, required: ["meter", "model", "provider", "charged_by", "quantity", "unit", "basis", "attempt", "billable", "usd"],
  properties: {
    meter: { enum: ["tokens", "tools", "browser_time", "compute_time"], description: "`tokens`: model requests, by model. `tools`: paid tool calls, by who charged for them; a workflow decision Parallel answered on its own API (this server's PARALLEL_API_KEY) is one, on the `parallel` line, never on `tokens`. `browser_time`: browser session time, by browser provider. `compute_time`: the time of the computers the run made, by provider and resource (`resource`, a GPU's `gpu_type`), priced by the operator's per-resource settings; sum a provider's lines for its compute figure.", "x-agentrun-serve": "runusage/5" },
    model: { type: ["string", "null"], description: "On `tokens`: the model the requests were sent on, as the run's booking names it (a workflow decision's model too, but for a decision Parallel charged, which is on the `parallel` `tools` line). One line per model and route: the same model reached two ways is two lines. Null on the other meters, and when the record names none." },
    provider: { type: ["string", "null"], description: "On `tokens`: the provider the requests went to, named only when this server sent them there itself (the run's own model on a provider's key). Null behind a model gateway, whose upstream this server does not know, and for a model it did not route (a workflow decision's). On `tools`: the vendor that charged for the calls, the same name as `charged_by` (the vendor that charges for a call is its provider). On `browser_time`: the browser provider. On `compute_time`: the computer provider, as this server's registry names it. Null where the record names none." },
    charged_by: { type: ["string", "null"], description: "On `tools`: who charged for the calls, whose invoice they land on (`monid`, an MCP server's name, `parallel`). On `compute_time`: the computer provider, the same name as `provider`. Null on the other meters, and when the record names none." },
    quantity: { type: ["number", "null"], minimum: 0, description: "In `unit`, as measured: never rounded to a billing increment, never topped up to a minimum. On `tokens`, the requests' input, cache read, cache write and output tokens as each reported them (a workflow decision's as its receipt does; a request that reported none is in `unmetered_requests`, in no token); on `tools`, the charges booked, one per paid call (a decision Parallel charged is one); on `browser_time`, the seconds this server's clock charged the provider's sessions for, its minimum per session included as the browser charged it; on `compute_time`, every second of every such computer of the run's times its figure (vCPUs, GiB of memory, GPUs, or GB of disk over a 730-hour month), a computer still open counted up to `measured_to`. Null when nothing measured it, or when a computer's figure is unknown (its provider said none and its create asked none)." },
    unit: { enum: ["token", "call", "second", "vcpu_second", "gib_second", "gpu_second", "gb_month"] },
    basis: { enum: ["reported", "estimate", "unpriced"], description: "How `usd` was reached. On `tokens`, as the run's `cost.basis` is, over the line's requests alone: `reported` when every request priced had its gateway's or provider's own figure, `estimate` when any was priced from a price table, `unpriced` when none was priced. On `tools`, `reported` when every charge with a figure is the provider's own (monid's answer says what it charged), `estimate` when any is a price this server holds (an MCP tool's saved price, Parallel's, a Parallel decision's list price), `unpriced` when none has a figure. On `browser_time`, `estimate` when any charge has a figure (the provider's price per hour on this server's clock, never its invoice), else `unpriced`. On `compute_time`, `estimate` when the run's ledger booked any of it at the operator's price (or its provider bills nothing, at $0), else `unpriced` (no price set for the resource, or its figure unknown): its time ran outside the run's cap, and `usd` is null." },
    ...ATTEMPT_FIELDS,
    usd: { type: ["number", "null"], minimum: 0, description: "The line's cost on this server, as booked, joined by the rule `cost.usd` is (float noise rounded off at 1e-12). Null when a charge of it is unknown: never $0 for unknown." },
    ...COST_WORDS,
    requests: { type: "integer", minimum: 0, description: "On `tokens`: the model requests booked." },
    tokens: closed({ input: { type: "integer", minimum: 0, description: "Input not read from cache." }, output: { type: "integer", minimum: 0 }, cache_read: { type: "integer", minimum: 0 }, cache_write: { type: "integer", minimum: 0 } }, "On `tokens`: `quantity` by kind."),
    unmetered_requests: { type: "integer", minimum: 0, description: "On `tokens`: requests that reported no tokens (booked with no usage, or sent and never answered), in no token count." },
    not_metered_calls: { type: "integer", minimum: 1, description: "On `tools`: calls with no price set (an MCP tool its owner set none for), as GET /usage counts them. They ran outside the run's cost and its cap, so they are in neither `quantity` nor `usd`: a line of such calls alone has `quantity` 0 and `usd` 0." },
    resource: { enum: ["vcpu", "memory", "gpu", "disk"], description: "On `compute_time`: the resource the line counts." },
    gpu_type: { type: ["string", "null"], description: "On `compute_time` for `gpu`: the provider's own name for the GPU type. Null on the other resources." },
    unheld_quantity: { type: ["number", "null"], minimum: 0, description: "On `compute_time`: the part of `quantity` no claim of the run held, so no cap held and nothing booked: a computer kept past its claim for a follow-up, one deleted after its run ended, one whose delete failed, one still open. Its cost is in neither `usd` nor `total`. Null when `quantity` is." },
    open_computers: { type: "integer", minimum: 0, description: "On `compute_time`: how many of the line's computers no delete has ended yet (still running, or their delete failed), counted up to `measured_to`." },
    measured_to: { type: "string", format: "date-time", description: "On `compute_time` with an open computer: the moment its time is counted to, this read's." },
  },
};
/** One browser session on GET /runs/{run_id}/usage (browser-sessions.ts). */
const BROWSER_SESSION = {
  type: "object", additionalProperties: false,
  required: ["provider", "tag", "provider_session_id", "started_at", "ended_at", "release_reason", "charged_seconds", "provider_record", "provider_record_status", "attempt", "billable"],
  properties: {
    provider: { type: "string", description: "The browser provider, as the `browser_time` line's `provider` names it." },
    tag: { type: "string", description: "The run's own name for the session, the same on every read." },
    provider_session_id: { type: ["string", "null"], description: "The provider's id for the session, by which its own records and bill find it. Null when no session was made (its create failed) or its end is not recorded." },
    started_at: { type: ["string", "null"], format: "date-time", description: "When this server began opening the session. Null while its end is not recorded." },
    ended_at: { type: ["string", "null"], format: "date-time", description: "When this server let the session go. Null when its end is not recorded (a run whose process was lost before the release was told): unknown, never zero." },
    release_reason: { type: ["string", "null"], description: "Why the session ended, in the browser's words: `tool` (the agent closed it), `idle`, `relaunch`, `close` (its run let it go), `ended` (the provider ended it), `lost`, `create_failed`." },
    charged_seconds: { type: ["number", "null"], minimum: 0, description: "The seconds of the session's time this server charged, on its own clock: what the `browser_time` line sums, the provider's minimum per session included where the browser charged one at the release. How long the session ran is `ended_at` less `started_at`. Null when none was charged (a free provider's, or no charge recorded)." },
    provider_record: {
      type: ["object", "null"], additionalProperties: false, required: ["started_at", "ended_at", "proxy_bytes"],
      description: "The provider's own record of the session, read once when it was let go, for matching it to the provider's invoice. Null unless `provider_record_status` is `read`. A field is null where the provider's record does not hold it.",
      properties: {
        started_at: { type: ["string", "null"], format: "date-time" },
        ended_at: { type: ["string", "null"], format: "date-time", description: "Null where the provider had not ended it when read." },
        proxy_bytes: { type: ["integer", "null"], minimum: 0, description: "The bytes the session moved through the provider's proxy, as the provider counts them." },
      },
    },
    provider_record_status: { enum: ["read", "not_offered", "not_found", "failed", "no_session", null], description: "What came of reading the provider's record: `read`; `not_offered`, the provider keeps none this server reads; `not_found`, the provider did not know the session; `failed`, the read failed or timed out; `no_session`, none was made. Null while the session's end is not recorded." },
    ...ATTEMPT_FIELDS,
  },
};
/** One computer a run made on GET /runs/{run_id}/usage (run-usage.ts computerIntervalsOf, store computer_intervals). */
const COMPUTER_INTERVAL = {
  type: "object", additionalProperties: false,
  required: ["provider", "provider_id", "kind", "gpu", "cpus", "memory_mb", "disk_gb", "started_at", "ended_at", "kept", "booked_seconds", "attempt", "billable"],
  properties: {
    provider: { type: "string", description: "The computer provider, as this server's registry names it (the agent's computer setting's `provider`: `docker`, `e2b`, `daytona`, ...)." },
    provider_id: { type: "string", description: "The provider's own id for the computer, by which its console, its API and its invoice find it." },
    kind: { type: ["string", "null"], description: "`sandbox`, `desktop` or `phone`. Null when not known." },
    gpu: {
      type: ["object", "null"], additionalProperties: false, required: ["type", "count"],
      description: "The computer's GPUs: its provider's own figure where its answer gave one, else what its create asked for. Null when neither says it has any.",
      properties: { type: { type: ["string", "null"] }, count: { type: ["integer", "null"], minimum: 0 } },
    },
    cpus: { type: ["number", "null"], minimum: 0, description: "The computer's vCPUs: its provider's own figure where its answer gave one (Daytona, E2B, Fly), else what its create asked for. Null when neither says: none is guessed." },
    memory_mb: { type: ["integer", "null"], minimum: 0, description: "The computer's memory, in MB: its provider's own figure where its answer gave one, else what its create asked for. Null when neither says." },
    disk_gb: { type: ["number", "null"], minimum: 0, description: "The computer's disk, in GB, where its provider's answer said it (Daytona). Null else.", "x-agentrun-serve": "runusage/4" },
    started_at: { type: "string", format: "date-time", description: "When the provider's create answered with the computer, on this server's clock." },
    ended_at: { type: ["string", "null"], format: "date-time", description: "When the provider's delete of the computer answered ok, on this server's clock. Null while none did: the computer may still be running (a run that ended with one open left it behind), or its delete failed or its answer is unknown. Never a guessed end." },
    kept: { type: "boolean", description: "The run's park kept the computer past its claim, for the person's answer (it is deleted once its keep's time passes, or at the run's end)." },
    booked_seconds: { type: "number", minimum: 0, description: "How much of the computer's time a claim of the run held and booked on the run's ledger. The rest of its life is time no claim held (`unheld_quantity` on its `compute_time` lines). 0 for one whose provider has no price set, or that bills nothing.", "x-agentrun-serve": "runusage/4" },
    ...ATTEMPT_FIELDS,
  },
};
const RUN_USAGE = {
  type: "object", additionalProperties: false, required: ["run_id", "ended_at", "currency", "total", "lines", "browser_sessions", "computer_intervals", "infra_usd", "reason"],
  properties: {
    run_id: ref("schemas/Id"),
    ended_at: { type: ["string", "null"], format: "date-time", description: "When the run ended: the moment the lines cover. Null while it is at work. The lines change only while the run works, and a follow-up can open an ended run again (a trigger's often does); its next end is a later one. Keep `ended_at` beside the lines: a later read with another `ended_at`, or null, means the run moved since. `run.ended` fires at each end." },
    currency: { const: "USD" },
    total: {
      type: ["object", "null"], additionalProperties: false, required: ["usd"], description: "The run's cost, joined from its lines. Null with no lines.",
      properties: { usd: { type: ["number", "null"], minimum: 0, description: "The run's booking joined by the rule `cost.usd` is: the run's `cost.usd` on GET /runs/{run_id}, always. Null when a charge of it is unknown. A `compute_time` line that is `unpriced`, and any line's `unheld_quantity`, ran outside the run's booking and are not in it." }, ...COST_WORDS },
    },
    lines: { type: ["array", "null"], items: RUN_USAGE_LINE, description: "`tokens` lines first, then `tools`, then `browser_time`, then `compute_time`, each by its model, charger or provider (`compute_time` then by resource). A meter the run used nothing of has no line. Null when the server can't split the run (`reason`)." },
    browser_sessions: { type: ["array", "null"], items: BROWSER_SESSION, description: "One record per browser session the run opened, in the order it opened them, for matching `browser_time` to the provider's own records and invoice by its session id. Empty for a run that opened none. Null exactly when `lines` is. Its words are cut of this server's secrets and the run's sign-ins, as the lines' names are.", "x-agentrun-serve": "runusage/2" },
    computer_intervals: { type: ["array", "null"], items: COMPUTER_INTERVAL, description: "One record per computer the run made through its provider (a sandbox, a desktop, a phone), by when each was made: how long each lived for the run, one left running after it (`ended_at` null), and the provider's own id to match its invoice by. Not the agent's own persistent computer, a paired computer, or a browser's sessions (those are `browser_sessions`). Their time is on the `compute_time` lines. Empty for a run that made none (or one made before this server kept them). Null exactly when `lines` is. Its words are cut of this server's secrets and the run's sign-ins, as the lines' names are.", "x-agentrun-serve": "runusage/3" },
    infra_usd: { type: ["number", "null"], minimum: 0, description: "What the infrastructure's own redo cost: the sum of the lines that are not `billable` (requests a cut attempt never finished and a later attempt sent again, after a deploy's drain, a crash, a lost lease or a retry). 0 for a run none of whose attempts left one. A request cut in flight has no known cost, so a run that has one reads null here: never a guess. Inside `total` and `cost.usd`, never beside them: data to compare, nothing charged differently. Null exactly when `lines` is, and when one such line's cost is unknown.", "x-agentrun-serve": "runusage/5" },
    reason: { enum: ["running", "not_booked", "reopened", null], description: "Why `lines` is null: `running`, the run is at work and its booking still moves; `not_booked`, its figure is not its booking's (an imported run's, a native or SDK run's harness figure, a CLI run whose model requests went past its model proxy); `reopened`, a learning run a follow-up opened again, whose `cost.usd` is its first round's and whose booking can't be split by round. Null with lines." },
  },
};
/** GET /runs/{run_id}/trace's answer (run-trace.ts). */
const RUN_TRACE = {
  type: "object", additionalProperties: false, required: ["run_id", "model_requests", "spans", "dropped"],
  properties: {
    run_id: ref("schemas/Id"),
    model_requests: { enum: ["priced", "tokens_only", "not_recorded"], description: "What the run's record keeps of its model requests. `priced`: each is a span with its tokens and its cost. `tokens_only`: a workflow run. Each model node's request is a span with its tokens and no cost, since the run's cost is its booking's; each decision (a judge's, a route's, a verify's request) is a span with its own cost. `not_recorded`: the harness's record keeps no request (a CLI harness), so the spans are its tool calls alone; the run's cost and request count are on its Timeline's usage row." },
    spans: {
      type: "array", description: "Each model request that answered (a workflow's decisions among them) and each tool call, in the order they started.",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "kind", "parent_id", "name", "agent_label", "started_at", "ended_at", "status", "stop_reason", "tokens", "usd", "decision", "charged", "not_metered", "tool_use_id", "input_preview", "result_preview", "result_size_bytes"],
        properties: {
          id: { type: "string", description: "The span's id in this trace, the same on every read of the run." },
          kind: { enum: ["model", "tool"] },
          parent_id: { type: ["string", "null"], description: "The span this one ran under: for a tool call, the model request that called it, or the call it nested in; for a subagent's model request, the call that started the subagent. Null at the top." },
          name: { type: "string", description: "A model request's model, as its answer names it (a decision's, the model its provider answered with, else the provider); a tool call's tool, as its Timeline rows name it." },
          agent_label: { type: ["string", "null"], description: "The subagent the span ran in, as the Timeline labels it; a workflow decision's node." },
          started_at: ref("schemas/Timestamp"),
          ended_at: { type: ["string", "null"], format: "date-time", description: "Null while a tool call runs or waits, and for a span whose end the record does not keep: a model request with no duration, a call cut with no result." },
          status: { enum: ["ok", "failed", "refused", "interrupted", "waiting", "running"], description: "`waiting`: a tool call held for its owner's approval, which has not run. `running`: a tool call with no result yet. `refused`: a call refused before it ran (a deny). `interrupted`: a request or a call cut before its end, or a call whose approval was withdrawn with its run. A model request is a span once it answered, so it is never waiting or running." },
          stop_reason: { type: ["string", "null"], description: "A model request's stop reason, as pi names it (`stop`, `toolUse`, `length`, `error`, `aborted`, `deferred`, `pending`). Null on a tool call." },
          tokens: {
            type: ["object", "null"], additionalProperties: false, required: ["input", "cache_read", "cache_write", "output"],
            description: "A model request's tokens. Null when its answer reported none (a request cut before its end), and on a tool call.",
            properties: { input: { type: "integer", description: "Input tokens not read from cache. A decision's receipt keeps its input whole, so all of it is here." }, cache_read: { type: "integer" }, cache_write: { type: "integer" }, output: { type: "integer" }, reasoning: { type: "integer", description: "The thinking tokens among `output`, where the provider reports them." } },
          },
          usd: { type: ["number", "null"], description: "A model request's cost; for a tool call, the sum of the charges booked under it (a browser session's time, a paid tool's fee). Null when it is not known (a request cut before its end, a charge of an unknown amount, a request of a run whose `model_requests` is `tokens_only`), and on a call nothing was charged under (`charged`). A computer's own time is its provider's to bill and is in no span." },
          decision: { type: "boolean", description: "A workflow decision's request (a judge's, a route's, a verify's), which has a cost of its own whatever `model_requests` says of the run's other requests. False on every other span." },
          charged: { type: "boolean", description: "Whether anything was charged under a tool call (a browser session's time, a paid tool's fee): `usd` is their sum. False on a model request." },
          not_metered: { type: "boolean", description: "A tool call whose tool has no price set: it ran outside the run's cost." },
          tool_use_id: { type: ["string", "null"], description: "A tool call's id, as its Timeline rows carry it. Null on a model request." },
          input_preview: { type: ["string", "null"], description: "A tool call's arguments, as its Timeline row shows them." },
          result_preview: { type: ["string", "null"], description: "A tool call's output's head, as its Timeline row shows it." },
          result_size_bytes: { type: ["integer", "null"], description: "The size of a tool call's whole output." },
        },
      },
    },
    dropped: { type: "integer", description: "Spans left out past the 2,000 one read serves: the run's first 2,000 are served." },
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
/** A mail server's endpoint: its host and port. */
const MAIL_ENDPOINT = closed({ host: { type: "string", minLength: 1, maxLength: 253 }, port: { type: "integer", minimum: 1, maximum: 65535 } });
const MAIL_ENDPOINT_OR_NULL = { oneOf: [MAIL_ENDPOINT, { type: "null" }] };
/** GET and PUT /settings/email's answer (email/account.ts accountView): the account, never its password. */
const EMAIL_ACCOUNT = closed({
  configured: { type: "boolean", description: "An account is saved and its password opens with this server's seal key: the email trigger and tools can sign in." },
  preset: { oneOf: [{ enum: ["gmail", "fastmail", "icloud", "other"] }, { type: "null" }], description: "The preset it was saved from: its servers are the preset's; `other`, the person's own." },
  address: { type: ["string", "null"], description: "The address it sends as." },
  user: { type: ["string", "null"], description: "Who signs in: the address unless saved otherwise." },
  imap: { ...MAIL_ENDPOINT_OR_NULL, description: "Where its mail is read: TLS on 993, STARTTLS required on any other port." },
  smtp: { ...MAIL_ENDPOINT_OR_NULL, description: "Where its mail is sent: TLS on 465, STARTTLS required on any other port." },
  password_unreadable: { type: "boolean", description: "An account is saved but its password, sealed under another seal key, does not open here: save it again." },
}, "The server's one email account (\"default\"), never its password.");
/** PUT /settings/email's and POST /settings/email/test's body: the account and its password. */
const EMAIL_ACCOUNT_BODY = {
  type: "object", additionalProperties: false,
  properties: {
    preset: { enum: ["gmail", "fastmail", "icloud", "other", "outlook"], default: "other", description: "gmail, fastmail and icloud fill imap and smtp; other takes both. outlook is refused in words: Outlook needs Microsoft sign-in, which this server doesn't do yet." },
    address: { type: "string", minLength: 1, maxLength: 320, description: "The address it sends as." },
    user: { type: "string", minLength: 1, maxLength: 320, description: "Who signs in. Default: the address." },
    password: { type: "string", minLength: 1, maxLength: PASSWORD_MAX, "x-agentrun-secret": true, description: "The account's app password (Gmail, iCloud and Fastmail each make one for an app): sealed, never answered or shown again. A test of the saved account may leave it out." },
    imap: MAIL_ENDPOINT,
    smtp: MAIL_ENDPOINT,
  },
};
/** One half of an email account test. */
const MAIL_CHECK = closed({ ok: { type: "boolean" }, message: { type: "string", description: "In plain words: \"Signed in to <host>.\", with INBOX's count for IMAP, or why not." } });
/** GET and PUT /settings/calendar's answer (calendar/address.ts calendarView): the calendar, never its address. */
const CALENDAR_VIEW = closed({
  configured: { type: "boolean", description: "A calendar is saved and its address opens with this server's seal key: calendar_events reads it." },
  host: { type: ["string", "null"], description: "The host its address reads from (calendar.google.com), never the address." },
  name: { type: ["string", "null"], description: "The calendar's own name (its X-WR-CALNAME), as the save read it; null when that read failed or it has none." },
  time_zone: { type: ["string", "null"], description: "The calendar's own time zone (its X-WR-TIMEZONE, else the server's), as the save read it; null when that read failed." },
}, "The server's one calendar, never its iCal address.");
/** PUT /settings/calendar's and POST /settings/calendar/test's body: the calendar's iCal address. */
const CALENDAR_BODY = {
  type: "object", additionalProperties: false,
  properties: {
    url: { type: "string", minLength: 1, maxLength: 2048, "x-agentrun-secret": true, description: "The calendar's secret iCal address (https://… or webcal://…, read as https://): Google Calendar's \"Secret address in iCal format\", Outlook's ICS link, iCloud's public calendar link. Sealed, never answered or shown again." },
  },
};
/** GET /settings/chatgpt's answer (chatgpt-plan.ts PlanView): the sign-in's state, never a token. */
const CHATGPT_SIGN_IN = {
  type: "object", additionalProperties: false, required: ["state"],
  properties: {
    state: { enum: ["signed_out", "pending", "signed_in", "expired"], description: "`pending`: a sign-in waits for its address (POST /settings/chatgpt/sign-in/finish); `expired`: OpenAI refused to renew it, so nothing runs on the plan until a sign-in again." },
    email: { type: "string", description: "The ChatGPT account's email, for display." },
    plan: { type: "string", description: "The account's ChatGPT plan (`plus`, `pro`, ...), for display." },
    authorize_url: { type: "string", format: "uri", description: "With `pending`: the link that sign-in opens." },
    expires_at: { type: "string", format: "date-time", description: "With `pending`: when that sign-in stops waiting, as its start answered." },
    models: { type: "array", items: { type: "string" }, description: "With `signed_in`: the plan's models, read from OpenAI at the sign-in, each named `chatgpt/<model-id>` in a revision." },
  },
};
/** GET /settings/claude-login's answer (claude-login.ts ClaudeLoginView): what Claude Code's CLI says of its login, never
 *  a token. */
const CLAUDE_LOGIN = {
  type: "object", additionalProperties: false, required: ["state", "place", "command", "can_start"],
  properties: {
    state: { enum: ["off", "other_machine", "signed_in", "signed_out", "no_cli", "unknown"], description: "`off`: not turned on. `other_machine`: turned on for another machine than this server's. Else what the CLI says: `signed_in`, `signed_out`, `no_cli` (no Claude Code CLI here yet: claude-agent's first run installs the pinned one), `unknown` (it gave no answer)." },
    place: { enum: ["agentrun", "machine"], description: "Where the login is: `agentrun`, AgentRun's own directory in its data (the default); `machine`, this machine's own Claude Code login (~/.claude), which the owner opts into." },
    command: { type: "string", description: "The line that signs the CLI in at `place`, for a terminal on this machine." },
    can_start: { type: "boolean", description: "Whether POST /settings/claude-login/login can start the CLI's sign-in here: the server is bound to loopback with no public address, so the browser it opens is on this machine." },
    refused: { type: "string", description: "Why the mode can't be turned on here, in one line: more than one person can start runs on this server." },
    account: {
      type: "object", additionalProperties: false,
      properties: { method: { type: "string" }, email: { type: "string" }, organization: { type: "string" }, plan: { type: "string" } },
      description: "With `signed_in`: what the CLI's status says of the account (its sign-in method, email, organization and plan), for display.",
    },
  },
};
/** GET /settings/tool-keys's answer (tool-keys.ts): each key's fields by name and where each is set, never a value. */
const TOOL_KEYS_VIEW = closed({
  keys: {
    type: "array",
    items: closed({
      id: { enum: TOOL_KEYS.map((row) => row.id) }, kind: { enum: ["tool", "model"], description: "`tool`: it unlocks tools, and reaches only the runs that name one; `model`: a model provider's key, which every run gets, and which gives the default model when the host names none (`capabilities.models`)." }, label: { type: "string" },
      unlocks: { type: "array", items: { type: "string" }, description: "What the key unlocks on this server: tools capabilities' `tools` lists, and `decisions.<id>` for a provider its `workflows.decisions.providers` lists. Empty when the key unlocks nothing this server binds." },
      harnesses: { type: "array", items: { type: "string", pattern: HARNESS_ID_PATTERN, examples: [...HARNESSES] }, description: "The harnesses that run the tools in `unlocks`: the union of their `harnesses` in capabilities' `tools`. A `model` key's: pi and the provider's own harness (OpenRouter's, all of them), of those capabilities' `harnesses` say this server runs or would run once the key is set: one unavailable only for want of a model key is listed before the key is saved. `goose` is among Anthropic's and OpenRouter's only once its owner has installed it (`agentrun harness install goose`) and capabilities list it." },
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
      secrets: { type: "array", items: { $ref: "#/components/schemas/SecretMeta" }, description: "Each of `fields` as every secret's view says it (SecretMeta, in their order): named tool:<FIELD> or model:<FIELD>; source `env` where `fields` says `server`, `console` where it says `stored`; changed_at when that field's own value was saved." },
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
    description: "The stored values that do not open here, to be entered again (a PUT seals them under the current key), and why: `seal_key_changed` (sealed under another key than the server's), `file_unreadable` (damaged; `fields` is empty when the file as a whole does not read). Null when every stored value opens.",
  },
});
const KEY_ID = { name: "key_id", in: "path", required: true, description: "The tool key: one of GET /settings/tool-keys' ids.", schema: { type: "string" } };
/** GET /settings/harness-keys (harness-keys.ts HarnessKeysOverStore.list): names and SecretMeta only, never a value. */
const HARNESS_KEYS_VIEW = closed({
  harnesses: {
    type: "array",
    description: "Each harness recipe billed to its vendor's plan that this server is started with (--harness-recipe), in the table's order. Empty when it names none.",
    items: closed({
      id: { type: "string", pattern: HARNESS_ID_PATTERN, description: "The harness's id, as a revision's `harness` names it." },
      label: { type: "string", description: "Its recipe's label." },
      keys: { type: "array", items: { $ref: "#/components/schemas/SecretMeta" }, description: "Each key its recipe runs on (its `keys`, in their order) as every secret's view says it: named harness:<harness>:<KEY>; source `console` once saved; changed_at when its value was last saved. Never a value." },
      ready: { type: "boolean", description: "Whether every one of `keys` is saved: then its runs run on them, a scheduled or triggered one too, ahead of its owner's own sign-in (--harness-sign-in)." },
    }),
  },
});
const HARNESS_ID_PARAM = { name: "harness_id", in: "path", required: true, description: "The harness: one of GET /settings/harness-keys' ids.", schema: { type: "string" } };
const HARNESS_KEY_PARAM = { name: "key", in: "path", required: true, description: "One of the harness's `keys`, by the name its recipe gives it.", schema: { type: "string" } };
/** The InputIssue reasons a saved MCP server's refusals give that the contract's enum lacks (mcp-probe.ts). */
const MCP_ISSUE_REASONS = ["redirect", "not_https", "too_many_tools", "tools_too_large", "reserved", "expired", "registration_unavailable"] as const;
/** Whether an MCP server's OAuth sign-in brings its own client, and the callback URL a hand-made one must name
 *  (mcp-oauth.ts McpSignIns.registration). */
const MCP_SIGN_IN_CLIENT = closed({
  registration: { type: "boolean", description: "Whether its sign-in can start with no Client ID entered: its authorization server's metadata names a registration endpoint (or takes a client metadata document this server publishes). False when it publishes no metadata or offers neither: a sign-in then needs a Client ID and Secret, and POST .../oauth/start without `client_id` is 422 on `client_id`, reason `registration_unavailable`." },
  callback: { type: "string", format: "uri", description: "Where this server's sign-in sends the browser back (AGENTRUN_PUBLIC_URL's address when set, never the address a request came to): the callback URL an OAuth app made by hand must name." },
});
/** The private-network hosts an MCP server's authorization server may be on (mcp-private-hosts.ts). */
const PRIVATE_HOSTS = closed({ hosts: { type: "array", maxItems: MAX_PRIVATE_HOSTS, items: { type: "string", minLength: 1, maxLength: 253 }, description: "Host names or IP addresses, as kept: lowercase, every final dot dropped, an IPv6 address in brackets." } });
const PRIVATE_HOSTS_RULE = "A listed host may resolve to private-network addresses (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7), and still only over https; every address it resolves to is checked, and the request goes to an address checked. Loopback, link-local (cloud metadata among them), unspecified, multicast and broadcast addresses, this machine's and this server's own are refused whatever the list says. The server's sign-in and a runner's token refresh read the list at each use.";
/** How a tool's annotations sort it (tool-gate.ts toolEffect). */
const EFFECT_RULE = "read when its annotations say readOnlyHint true; else destructive only when they say destructiveHint true; else write (destructiveHint false or not given, or no annotations: not the MCP spec's default of destructiveHint true, under which every tool of a server that annotates nothing would read destructive). The server's own claims, as the listing the run pinned gave them, never a later listing.";
const MCP_RESOURCE = { enum: ["list", "templates", "read"], description: "An AgentRun-generated operation for an MCP server that advertises resources: list resources, list templates, or read a URI. Uses the same grants, revision pin, credentials and permission gate as a tool; dispatches the corresponding MCP resource method. Absent on upstream tools.", "x-agentrun-serve": "mcpresources/1" };
/** A remote MCP server's tools as it listed them (mcp-probe.ts listServer), and the server as saved: never its credential. */
const MCP_TOOL = {
  type: "object", additionalProperties: false, required: ["name", "input_schema"],
  properties: {
    name: { type: "string" }, title: { type: "string" }, description: { type: "string" },
    resource: MCP_RESOURCE,
    input_schema: { type: "object", description: "The JSON Schema of the tool's arguments, as the server gave it." },
    output_schema: { type: "object", description: "The JSON Schema of its structured result, when the server gives one." },
    annotations: { type: "object", description: "The server's own claims about the tool (read-only, destructive, and so on): the server's word, not checked." },
    grantable: { const: false, description: "Present, and false, on a known meta tool: one that runs other actions by name (Composio's COMPOSIO_MULTI_EXECUTE_TOOL, Klavis Strata's execute_action, Zapier's execute actions, Arcade's UseTool, Docker's mcp-exec, Cloudflare's portal_execute and code mode). A grant of it could not name the real action, so none is granted: a save that grants it is 422 with `reason`, and a run that pinned one is refused at its launch. Absent on every other tool.", "x-agentrun-serve": "mcpservers/1" },
    reason: { type: "string", description: "Beside `grantable: false`: why the tool can't be granted.", "x-agentrun-serve": "mcpservers/1" },
    effect: { enum: ["read", "write", "destructive"], description: `On a saved server's read: what the tool does by its annotations, ${EFFECT_RULE} A read tool runs with no one asked under the server's \`allow_reads\`; allowing a destructive one's call takes \`confirm_destructive\`.`, "x-agentrun-serve": "allowreads/1" },
    grant_problems: { type: "object", additionalProperties: { type: "string" }, description: "On a saved server's read: why a grant of the tool is refused, where it would run, in the words the save's 422 says. `*` is a refusal on every harness (the server is named hands); a harness id is that harness alone, whose own MCP client would drop or retype the tool's schema. Absent when nothing refuses the grant. A known meta tool is `grantable: false` instead. A long name refuses nothing: a tool whose `mcp__<server>__<tool>` is past 52 characters is called by a shortened name with a hash of its catalog name. Two tools an agent grants that would be called by one name are refused at that agent's save, both named; that depends on the agent's other grants, so it is not listed here.", "x-agentrun-serve": "mcpservers/1" },
    permission: { enum: [...PERMISSIONS], description: "On a saved server's read: the permission this server applies to the tool for an agent that sets none, under its tool settings (`mcp:<server>/<tool>`, else `mcp:<server>/*` and its `allow_reads`, else `default_permission`). The same as an agent's read gives as its `default_permission` once it grants the tool. Absent on a preview.", "x-agentrun-serve": "mcpservers/1" },
    allow_reads: { const: true, description: "On a saved server's read: present where `permission` is allow because of its server's `allow_reads` (a read-only tool that would ask), not a setting or a default. Absent where the tool's own setting (`mcp:<server>/<tool>`) or a deny decides it.", "x-agentrun-serve": "allowreads/1" },
    fallback_allow_reads: { const: true, description: "On a saved server's read: present where, with no permission on the tool's own key (`mcp:<server>/<tool>`), its server's `allow_reads` would let it run with no one asked: the permission it falls back to is allow, whatever its own setting says now. Absent on a tool that is not read-only, with `allow_reads` off, or where a deny holds.", "x-agentrun-serve": "allowreads/1" },
    default_permission: { enum: [...PERMISSIONS], description: "On a saved server's read: the owner's default for the tool (ask, as for any catalog tool), the one that applies when the server's tool settings set none.", "x-agentrun-serve": "mcpservers/1" },
    permissions: { type: "array", items: { enum: [...PERMISSIONS] }, description: "On a saved server's read: the permissions the tool may be set to.", "x-agentrun-serve": "mcpservers/1" },
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
const MCP_SOURCE = { enum: [...MCP_SOURCES] };
/** A save's (and a sign-in's) `toolkit`: what the saved server is, for a template's apply to match. Its source is never
 *  sent: it is what made the server. */
const MCP_TOOLKIT_BODY = {
  toolkit: { type: ["string", "null"], pattern: MCP_SERVER_NAME.source, description: "The toolkit its tools are, as a template names them (`mcp:<toolkit>/<tool>`): a template's MCP need of the server's `source` and this toolkit maps to it at apply. null clears it (not on a composio server, which names its toolkit); on the GitHub App's tokens it is `github` alone. Absent: what it was. The source is what made the server, never sent: `composio` from the Composio preset, `github` on the GitHub App's tokens, else `url`." },
};
/** A Composio server's key variable as a read shows it (api_key_env on its save): the name, never the value. */
const MCP_KEY_ENV_SHOWN = { enum: [COMPOSIO_KEY_ENV], description: "For a Composio server saved with `api_key_env`: the variable of this server's environment its key is read from at each use. The name alone; the server keeps no copy of the value." };
const MCP_SECRET_SHOWN = { $ref: "#/components/schemas/SecretMeta", description: "Its credential as every secret is read (SecretMeta), never a value: named mcp:<server>; source `console` for a pasted bearer token or headers, `sign-in` for an OAuth sign-in, `env` for a Composio key read from the server's environment (`auth.api_key_env`: `set` is whether the variable is set now, changed_at null), null with none; changed_at moves when a new credential is saved or signed in, never on a save that keeps it, a refresh of the tools or a token refresh." };
const MCP_SERVER_VIEW = {
  type: "object", additionalProperties: false, required: ["name", "url", "source", "toolkit", "auth", "credential", "protocol", "server_info", "tools", "listed_at", "updated_at"],
  properties: {
    name: { type: "string" }, url: { type: "string", format: "uri" },
    source: { ...MCP_SOURCE, description: "Where its tools come from, recorded when it was saved from what made it, which a template's MCP needs are matched on at apply: `composio` from the Composio preset, `github` on the GitHub App's tokens, else `url`." },
    toolkit: { type: ["string", "null"], description: "The toolkit its tools are, as a template names them (`mcp:<toolkit>/<tool>`): the Composio preset's toolkit, `github` on the GitHub App's tokens, else what a PUT's (or a sign-in's) `toolkit` said; null: none, and no template's need maps to it." },
    auth: { type: "object", additionalProperties: false, required: ["type"], properties: { type: { enum: [...MCP_AUTH_TYPES] }, headers: { type: "array", items: { type: "string" }, description: "For `headers`: the names of the headers kept (lowercase), never a value." }, api_key_env: MCP_KEY_ENV_SHOWN } },
    credential: { enum: ["sealed", "unreadable", "expired", null], description: "`sealed`: kept sealed and opens here; `unreadable`: sealed under another seal key, or damaged: a PUT with the credential seals it again; `expired`: an OAuth sign-in whose refresh the authorization server refused (revoked or expired): sign in again. Null for `auth.type` none. Never a value." },
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
    secret: MCP_SECRET_SHOWN,
  },
};
const MCP_AUTH = {
  type: "object", additionalProperties: false, required: ["type"],
  properties: {
    type: { enum: [...MCP_AUTH_TYPES], description: `\`none\`; \`bearer\` (\`token\`, sent as \`Authorization: Bearer <token>\`); \`headers\` (each named header and its value); \`oauth\`, with no credential in the body: the server is signed in to first (POST /settings/mcp-servers/{name}/oauth/start), and a PUT keeps the sealed token set; \`github_app\`: the connected GitHub App's installation token, minted for each run; \`per_run\`: nothing kept, each run's caller hands the run its credential (\`mcp_auth\` on POST /runs, POST /agents/{agent_id}/runs and POST /runs/{run_id}/messages), and \`headers\`, when sent, only list the server's tools now.` },
    token: { type: "string", minLength: 1, maxLength: 8192, "x-agentrun-secret": true },
    headers: { type: "object", minProperties: 1, maxProperties: 8, additionalProperties: { type: "string", minLength: 1, maxLength: 8192, "x-agentrun-secret": true }, description: "Header names a credential may go in: not Host, Content-Type, Accept, Content-Length, Connection, Transfer-Encoding, Last-Event-ID or an Mcp- header the transport sets." },
  },
  description: "Absent: none. A PUT that sends no `token` (no `headers`) keeps the sealed credential, when the type and the URL's origin are unchanged.",
};
const MCP_URL = { type: "string", format: "uri", maxLength: 2048, description: "The server's Streamable HTTP endpoint: https, or http on a loopback address of this machine; no user or password." };
const MCP_NAME = { name: "name", in: "path", required: true, description: "The server's name: lowercase letters, digits and dashes, starting with a letter, at most 32 (no underscores, so `mcp__<server>__<tool>` splits one way). `hands` is reserved for AgentRun's own tools: a PUT under it is 422 input_invalid, field `name`, reason `reserved`.", schema: { type: "string", pattern: MCP_SERVER_NAME.source } };
const COMPOSIO_KEY = { type: "string", minLength: 1, maxLength: 8192, "x-agentrun-secret": true, description: "The Composio API key, sent only to Composio." };
/** A Composio save's `api_key_env`: the key named by a variable of the server's environment. A name, not a secret. */
const COMPOSIO_KEY_ENV_BODY = { enum: [COMPOSIO_KEY_ENV], description: `In place of \`api_key\`: the variable of this server's environment the Composio key is read from, ${COMPOSIO_KEY_ENV} and no other (Composio's address is fixed, so no other secret of the environment is ever sent there). The server keeps the name, never the value: it reads it at each use (this save's calls to Composio, each run's connection, a delete's), as the server and each runner were started with it, so a new value takes effect when they start again. It is a secret the launcher hands each over a pipe, never in a process's environment, and no run is handed it: a run granted a tool of the server is sent it only as the server's MCP header. The value is only ever sent to Composio's origin (\`${COMPOSIO_ORIGIN}\`): a server whose address is anywhere else is refused by name wherever the key would be read (a save, a refresh, a run's start), and nothing is sent. Another name is 422 \`invalid\` under \`api_key_env\`; unset or blank now, 422 \`missing\`; with \`api_key\` too, 422 \`not_allowed\`. A run of a server whose variable is unset is refused before it starts (409 agent_not_runnable), naming it. On an API-only server (AGENTRUN_API_ONLY=1) its token saves one so; on any other server the token's is 403, as \`api_key\` is.` };
const COMPOSIO_TOOLKIT = { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$", description: "The toolkit's slug as Composio names it (`github`, `slack`, `gmail`...)." };
/** The mark of what a composio trigger adds (composio-triggers.ts). */
const COMPOSIO_TRIGGERS_MARK = { "x-agentrun-serve": "composiotriggers/1" };
/** A composio trigger's create, in the words its refusals use. */
const COMPOSIO_CREATE = "A `composio` source names a saved Composio server, one of its toolkit's events (GET /settings/mcp-servers/{name}/composio/events) and its config: the create makes, with the server's key, the Composio project's webhook subscription at this server's address (/hooks/composio/{hook}) when there is none, then the event's trigger instance for the account the server is connected as, then the trigger, and undoes what it made when a later step fails; the answer's `source` names them (`instance_id`, `hook`). Triggers with the same server, event and config share one instance. 409 composio_no_public_url (\"Composio can't reach this server\") with no public URL (AGENTRUN_PUBLIC_URL), before Composio is asked anything; 409 composio_subscription_elsewhere (`details.webhook_url`) when the project's subscription is at another address (another AgentRun server's, or a tool of the owner's), unless `source.move_subscription` is true, which moves it here: whatever listens at that address gets no more events; 409 composio_not_connected (`details.connect_url`, Composio's page to connect it) when the server's Composio user has no connected account; 409 composio_account_ambiguous (`details.accounts`, each with when it was connected) when it has several: a trigger runs as one, so the owner disconnects the others in Composio; 422 for an event or config Composio refuses, under `source.event` or `source.config`; 424 when Composio fails.";
/** What Composio could not do for a composio trigger turned on or off, or deleted: the change here holds. */
const COMPOSIO_UNDONE = closed({ done: { type: "boolean", enum: [false] }, note: { type: "string", description: "What to do on Composio by hand: the instance's id and the dashboard's address." } });
const COMPOSIO_NOTE = "The Composio preset: Composio is an MCP server like any other, and this makes one for the owner's key, toolkit and chosen actions. The key goes to Composio (backend.composio.dev) and into the sealed header, and is never logged or answered.";
const MCP_FAILED = {
  "424": { description: "`upstream_failed`: the MCP server could not be reached, did not answer within 15 s (30 s for the whole listing), answered 5xx or more than 4 MiB at once, or failed to list its tools. `details.status` holds its HTTP status when it answered one.", content: { "application/json": { schema: ref("schemas/Error") } } },
};
/** What a preview's tool list is (#84): the server's offer, listed with this credential, never what the credential may do. */
export const MCP_PREVIEW_SCOPE = "The tools are what the server offers, not what this credential allows: a read-only token still lists its write tools. A call the credential can't make is refused by the MCP server when a run makes it.";
const MCP_CONNECTS = "Connects with the official MCP SDK client: `server/discover` (2026-07-28) first, a 2025-era server by its `initialize`; then `tools/list`, every page. No redirect is followed: a 3xx is 422 input_invalid (field `url`, reason `redirect`, naming where it points), so a credential goes only where it is sent. A server that asks for a credential (401 or 403) is 422 `auth_required`, `details.auth` `oauth` when it names protected-resource metadata (its WWW-Authenticate or `/.well-known/oauth-protected-resource`), else `bearer`; a URL whose answers hold no JSON-RPC reply is 422 `not_mcp`; a server listing more than 500 tools, or more than 1 MiB of them (names, descriptions, schemas), is 422 input_invalid (field `url`, reason `too_many_tools` or `tools_too_large`), the listing stopped at that page; any other failure is 424.";
/** A tool's permission (tool-gate.ts). */
const PERMISSION = {
  enum: [...PERMISSIONS],
  description: "What the tool gate does with each call a model makes: allow runs it; ask parks the run until the owner answers (POST /runs/{run_id}/approvals/{approval_id}); deny refuses it at once, and the model reads why. The owner's defaults: allow for this server's tools, ask for a catalog tool (mcp:<server>/<tool>, monid:<provider>/<endpoint>). ask is offered for the tools whose approved call the kernel runs itself (read, write, edit, bash, web_fetch, web_search, learned_workflow) and for catalog tools; any other is allow or deny.",
};
/** The table's tools a setting may name, a computer kind's keys (desktop, phone), each holding its kind's tools, and a
 *  decision provider's key (jev, parallel, openrouter: what a learned workflow's decision nodes may ask; allow or deny). */
const SETTINGS_TOOLS = [...tableTools(), ...KIND_KEYS, ...DECISION_PROVIDER_KEYS];
/** A catalog tool's settings key, or an MCP server's wildcard, which sets each of its tools. */
const CATALOG_KEY = { type: "string", pattern: CATALOG_KEY_PATTERN };
/** A pinned scalar. */
const PIN_SCALAR = [{ type: "string", maxLength: MAX_PIN_TEXT }, { type: "number" }, { type: "boolean" }, { type: "null" }];
/** pins/1: a keys pin, the keys an MCP tool's object argument may hold (tool-gate.ts PinKeys). */
const PIN_KEYS = {
  type: "object", required: ["keys"], additionalProperties: false,
  properties: { keys: { type: "array", minItems: 1, maxItems: MAX_PIN_CHOICES, items: { type: "string", minLength: 1, maxLength: MAX_PIN_TEXT } } },
  description: `The argument, when given (not left out, nor null), is an object whose keys are among these, any values: {"keys": ["hs_lead_score"]} lets a write set that one field and no other. Kept in one form, each key once, sorted.`,
};
/** pins/1: an MCP tool's pin (tool-gate.ts pinRefusal), the top-level arguments its calls must carry. */
const PIN = {
  type: "object", minProperties: 1, maxProperties: MAX_PIN_ARGS, propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,127}$" },
  additionalProperties: { anyOf: [...PIN_SCALAR, { type: "array", minItems: 1, maxItems: MAX_PIN_CHOICES, items: { anyOf: PIN_SCALAR } }, PIN_KEYS] },
  description: `On an MCP tool's own key (mcp:<server>/<tool>) only, never a server's wildcard: 1 to ${MAX_PIN_ARGS} of the tool's top-level arguments, each to the one JSON scalar its calls must carry (null: the argument left out, or null), a list of 1 to ${MAX_PIN_CHOICES} of them, the argument one of the list (strict equality; kept and said in one form: each value once, null first, then by its JSON text), or {"keys": [...]}, 1 to ${MAX_PIN_CHOICES} keys an object argument may hold, its values free (left out or null holds too). The tool gate refuses a call whose arguments are not as pinned before it runs or asks anyone, whatever the tool's permission, and the model reads the values it may use. A pin adds to a setting and is never a permission: the agent's pin and the server's both hold, an argument both pin takes what holds both (two keys pins, the keys in both), and one where nothing does refuses every call. A pinned tool takes only its listed arguments: a call of a tool with a pin in either layer may carry only the top-level arguments its listing in the run's pin declares under its inputSchema's properties, beside the pinned ones, so an alias the server takes for a pinned argument (Gmail's "to" for "recipient_email") is refused unsent, with no pin of its own; a listing with no properties object closes nothing. Until the agent store's cutover an agent's own pin (definition.tool_settings) is 422 not_set_up_here: set it on the server.`,
  "x-agentrun-serve": "pins/1",
};
/** pins/1: the server's mark of a pin in its tool settings file that does not read. */
const PIN_BROKEN = {
  const: true,
  description: "The server's own settings only (GET /settings/tools): this MCP tool's stored pin does not read, so the tool gate refuses every call of it. A PUT that keeps the key and sets no valid pin (this mark sent back, as served, or the pin left out) keeps it broken; a valid pin repairs it, and leaving the key out removes the setting. Refused in an agent's definition.tool_settings.",
  "x-agentrun-serve": "pins/1",
};
/** An MCP server's "allow reads" (tool-gate.ts readsLift): on its wildcard in the server's tool settings only. */
const ALLOW_READS = {
  type: "boolean",
  description: `On an MCP server's wildcard (\`mcp:<server>/*\`) in this server's tool settings only (an agent's own, or any other key, is 422): true lets each of the server's read-only tools run with no one asked, where it would ask; false clears it. A tool is read-only when its annotations say readOnlyHint true; a tool's effect is ${EFFECT_RULE} It never lifts a deny (the server's or the agent's), the agent's own ask, a tool's own key (\`mcp:<server>/<tool>\`), a pin's refusal, or a write's or a destructive tool's ask.`,
  "x-agentrun-serve": "allowreads/1",
};
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
  additionalProperties: { type: "object", additionalProperties: false, properties: { permission: PERMISSION, pin: PIN, pin_broken: PIN_BROKEN, allow_reads: ALLOW_READS } },
};
/** bash's policy in an agent's own tool settings (bash-read-only.ts). */
const BASH_POLICY = {
  enum: [...BASH_POLICIES],
  description: "An agent's own setting on bash only, never the server's. read-only: the tool gate reads each shell call's command before it runs or anyone is asked, and refuses, in words the model reads, one that could write, run code or read outside the run's folder: a program outside its read list (git's read subcommands, grep, sed -n with one N,Mp range, cat, head, tail, wc, ls, find without -exec and the like), redirection other than 2>/dev/null and 2>&1, $ and backticks, subshells, ||, a lone &, a pipe into anything but a filter, an unquoted glob, or a path outside the folder or on the never-open list. bash_background and bash_input are refused under it. A policy adds to bash's permission and is never one: approvals `never` lifts none of it, and an approved call is decided again before it runs.",
};
/** An email read tool's scope in an agent's own tool settings (email/tools.ts). */
const EMAIL_SCOPE = {
  enum: [...EMAIL_SCOPES],
  description: "An agent's own setting on email_read, email_search and email_file only, never the server's. thread (the default): on a run an email trigger started, the tool sees (and email_file files) the thread of the message that started it alone (that message, and every message whose References or In-Reply-To links it, in any mailbox), and a message outside it is answered \"outside this run's thread\" and never fetched; mailbox: the whole account. A run no email started sees the whole account either way.",
  "x-agentrun-serve": "email/1",
};
/** An agent's own tool settings (definition.tool_settings): the map, with bash's policy and the email read tools' scope. */
const AGENT_TOOL_SETTINGS = {
  ...TOOL_SETTINGS,
  additionalProperties: { type: "object", additionalProperties: false, properties: { permission: PERMISSION, pin: PIN, pin_broken: PIN_BROKEN } },
  properties: {
    ...TOOL_SETTINGS.properties,
    bash: { ...TOOL_SETTINGS.properties.bash, properties: { ...TOOL_SETTINGS.properties.bash!.properties, policy: BASH_POLICY } },
    ...Object.fromEntries(SCOPED_TOOLS.map((name) => [name, { ...TOOL_SETTINGS.properties[name], properties: { ...TOOL_SETTINGS.properties[name]!.properties, scope: EMAIL_SCOPE } }])),
  },
};
/** What a capability resolves to on each harness: `native`, `kernel`, `firecrawl-keyless`, `exa-keyless`, `parallel`, `browserbase`, or `unavailable: <reason>`. */
const RESOLUTION = { type: "string", pattern: "^(native|kernel|firecrawl-keyless|exa-keyless|parallel|browserbase|unavailable: .+)$" };
const RESOLVES = {
  type: "object", additionalProperties: false, required: [...HARNESSES], properties: Object.fromEntries(HARNESSES.map((harness) => [harness, RESOLUTION])),
  description: "What the tool resolves to on each harness: native (the harness's own tool, or on pi one request to the model provider's hosted search), kernel (the guarded direct fetch; on browser, Kernel's hosted browser), firecrawl-keyless (Firecrawl's keyless MCP endpoint: for web_search with keyless Exa behind it, for web_fetch with the guarded direct fetch behind it, sent each URL read), exa-keyless (Exa's keyless MCP search), parallel, browserbase (Browserbase's hosted browser), or unavailable: <reason>.",
};
/** Why a capability resolves as it does on each harness: one plain sentence each, from the same resolution. */
const WHY = {
  type: "object", additionalProperties: false, required: [...HARNESSES], properties: Object.fromEntries(HARNESSES.map((harness) => [harness, { type: "string" }])),
  description: "Why the tool resolves as it does on each harness, one plain sentence each, made by the same resolution as resolves: the harness's or model provider's own search (`Codex's own search`), what leaves none and what serves instead (`behind a gateway Codex has no own search; your Parallel key (saved)`, where saved is a key saved on API Keys and server the server's own), a pick (`keyless Exa, picked in settings: Exa's free search, no key`), what leaves the server (keyless Firecrawl's web_fetch says each URL goes to Firecrawl's keyless service, and how to fetch directly), or `turned off in settings`. A client shows it as is.",
};
/** GET and PUT /settings/tools's answer: each capability's provider, its default where none is set, and each permission
 *  set, by settings key. */
const TOOL_SETTINGS_ANSWER = {
  type: "object", required: [...PICKABLE], propertyNames: TOOL_SETTINGS.propertyNames,
  properties: Object.fromEntries(PICKABLE.map((name) => [name, { type: "object", additionalProperties: false, required: ["provider"], properties: { provider: { enum: [...PROVIDERS[name]] }, permission: PERMISSION } }])),
  additionalProperties: { type: "object", additionalProperties: false, properties: { permission: PERMISSION, pin: PIN, pin_broken: PIN_BROKEN, allow_reads: { const: true, description: "Set: this MCP server's read-only tools run with no one asked (see PUT's `allow_reads`).", "x-agentrun-serve": "allowreads/1" } } },
};
/** A revision's MCP pin as the API shows it (agents-store.ts pinView): per server, the granted tools as its save listed
 *  them and their prices; never the server's URL. */
const MCP_PIN = {
  type: ["object", "null"],
  additionalProperties: {
    type: "object", additionalProperties: false, required: ["tools"],
    properties: {
      tools: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["name", "input_schema"],
          properties: {
            name: { type: "string" }, title: { type: "string" }, description: { type: "string" },
            resource: MCP_RESOURCE,
            input_schema: { type: "object", description: "The tool's input schema as the server listed it at the save." },
            annotations: { type: "object", description: "The tool's annotations as the server listed them at the save (readOnlyHint, destructiveHint and the rest)." },
          },
        },
      },
      prices: { type: "object", additionalProperties: { type: "number", minimum: 0 }, description: "The price in USD its owner set for each pinned tool that has one." },
    },
  },
  "x-agentrun-serve": "mcppin/1",
};
/** GET /agents/{agent_id}'s `tools`: each tool the agent's current revision grants, in capabilities.tools' order; one
 *  with a provider choice with the provider in force, where it came from, the server's (its default), and what it
 *  resolves to on the agent's harness and model; a tool of bash's family its computer leaves out, unavailable. */
const AGENT_TOOLS = {
  type: "array",
  description: "Each tool the agent's current revision grants, in capabilities.tools' order, with its permission (permission, where it came from as permission_from, default_permission, permissions). A tool with a provider choice (web_search, web_fetch, browser) carries the provider in force (provider), where it came from (provider_from: agent, its own tool_settings; server, the server's settings; default, the built-in default), the one that applies when the agent sets none (default_provider, the server's), and what it resolves to on the agent's harness and model (resolved). A tool of bash's family (bash and the background tools) carries resolved only where the agent's computer gives a run of it no such tool, `unavailable: ` and why: with no computer that mounts the run's folder the background tools are not there, and bash neither unless the server keeps its folders on Archil, whose exec runs it. Only GET /agents/{agent_id} answers it.",
  items: {
    type: "object", additionalProperties: false, required: ["name", "permission", "permission_from", "default_permission", "permissions"],
    properties: {
      name: { type: "string" }, blurb: { type: "string", description: "One short line for people (the editor's Tools grid); the model never sees it. Absent for an MCP server's tool.", "x-agentrun-serve": "tool-blurb/1" }, provider: { type: "string" }, provider_from: { enum: ["agent", "server", "default"] }, default_provider: { type: "string" }, resolved: RESOLUTION,
      permission: { ...PERMISSION, description: "The permission in force: a deny set on this server, which is absolute (no setting of the agent's reaches past it); else the agent's own (tool_settings), else the server's, else the owner's default.", "x-agentrun-serve": "approvals/1" },
      permission_from: { enum: ["agent", "server", "default", "unattended"], description: "Where the permission came from: agent, its own tool_settings (the tool's key, or its MCP server's wildcard); server, the server's settings (always, for a deny set on the server, which is absolute); default, the owner's default; unattended, an ask its definition's approvals `never` allowed (permission is then allow).", "x-agentrun-serve": "approvals/1" },
      default_permission: { enum: [...PERMISSIONS], description: "The one that applies when the agent sets none: the server's, else the owner's default.", "x-agentrun-serve": "approvals/1" },
      permissions: { type: "array", items: { enum: [...PERMISSIONS] }, description: "The permissions it may be set to.", "x-agentrun-serve": "approvals/1" },
    },
  },
  "x-agentrun-serve": "providers/1",
};
const WEBHOOK_ID = { name: "webhook_id", in: "path", required: true, description: "The message, as its `webhook-id` names it.", schema: { type: "string" } };
/** The outbound webhook's secret's metadata (secret-writes.ts SecretMeta): never its value. */
const WEBHOOK_SECRET_META = { ...ref("schemas/SecretMeta"), description: "Its signing secret's metadata, named `webhook:outbound`: set, made by this server at the first save or a rotation (source console), and when; null for a webhook set before it was kept. Never the value." };
const WEBHOOK_SET_FIELDS = {
  configured: { const: true }, url: { type: "string" },
  secret: WEBHOOK_SECRET_META,
  signing: { enum: ["sealed", "unreadable"], description: "Whether the secret signs here: `sealed`; `unreadable` (sealed under another key, or damaged), when nothing is sent until its secret is rotated (POST /settings/webhook/secret), or the webhook is removed and set again. Never the secret." },
  disabled: { oneOf: [closed({ at: { type: "string", format: "date-time" }, reason: { type: "string" } }), { type: "null" }], description: "Set when the receiver answered 410 Gone: nothing is sent until a PUT sets the webhook again." },
  updated_at: { type: "string", format: "date-time" },
};
const WEBHOOK_SET = closed(WEBHOOK_SET_FIELDS);
/** GET /settings/webhook (webhooks.ts): the webhook, or none; never its secret. */
const WEBHOOK_VIEW = { oneOf: [closed({ configured: { const: false }, secret: WEBHOOK_SECRET_META }), WEBHOOK_SET] };
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
/** Slack (slack.ts): its URL's metadata, its events, and its view; never the URL. */
const SLACK_SECRET_META = { ...ref("schemas/SecretMeta"), description: "Its incoming-webhook URL's metadata, named `slack:outbound`: set, pasted in the console (source console), and when. Never the URL." };
const SLACK_EVENT_SWITCHES = closed(Object.fromEntries(SLACK_EVENTS.map((name) => [name, { type: "boolean" }])), "Which events are posted: each on unless turned off.");
const SLACK_SET = closed({
  configured: { const: true },
  url: { type: "string", description: `The URL as the server shows it: https://${SLACK_HOST}/… and its last four characters. Never the whole URL, which is the credential.` },
  url_state: { enum: ["sealed", "unreadable"], description: "Whether the URL opens here: `sealed`; `unreadable` (sealed under another key, or damaged), when nothing is sent until the URL is saved again." },
  secret: SLACK_SECRET_META,
  events: SLACK_EVENT_SWITCHES,
  disabled: { oneOf: [closed({ at: { type: "string", format: "date-time" }, reason: { type: "string" } }), { type: "null" }], description: "Set when Slack answered 404 or 410 (no_service, channel_not_found, channel_is_archived): nothing is sent until a PUT saves a URL again." },
  updated_at: { type: "string", format: "date-time" },
});
const SLACK_VIEW = { oneOf: [closed({ configured: { const: false }, secret: SLACK_SECRET_META, events: SLACK_EVENT_SWITCHES }), SLACK_SET] };
const SLACK_ATTEMPT = closed({
  webhook_id: { type: "string", description: "The message's id: the same on each of its tries, and on a redelivery." },
  type: { enum: [...SLACK_MESSAGE_TYPES] }, at: { type: "string", format: "date-time" },
  status_code: { type: ["integer", "null"], description: "Slack's answer; null when it was not reached." },
  latency_ms: { type: "integer", minimum: 0 },
  error: { type: ["string", "null"], description: "Why the try failed: Slack's status and its word (`answered 404 no_service`), no answer in 15 s, not reached, or Slack removed or off. Never the URL." },
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
    "`seed_failed`: the agent's learning folder could not be read or made, so the run started with nothing learned.",
    "`no_budget`: the run's cap left no room for the compile turn, or refused its request. `unknown_cost`: a capped run whose spend is unknown.",
    "`cancelled`: a person cancelled the run. `crashed`: the run's process went. `reflect_failed`: the compile turn ended on an error.",
    "`empty`: the compile turn kept no workflow and the owner gave no correction, or the run was not asked its compile turn because its only tool work was its learned workflows, each answering, with nothing said after its first message (its `detail` says so). `checker`: the checks (or the workflow's dry run) refused it, or the owner's correction would pass corrections.md's cap, and nothing was written to git.",
    "`use`: the run was started with `learning: \"use\"`: it started from what its agent learned and keeps nothing, so it was never asked its end-of-run turn.",
    "`reset`: the run read what its agent learned before a reset of the agent's learning (DELETE /v2/agents/{agent_id}/learning), so nothing it learned is kept and it was never asked its end-of-run turn.",
  ].join(" "),
};
// ---- learning/1: what a person sees and controls of an agent's learning (learning-routes.ts) ---------------------------
const NULL_STRING = { type: ["string", "null"] };
const MARK = { "x-agentrun-serve": "learning/1" };
const PAGE = (item: Json, description: string) => closed({ items: { type: "array", items: item }, total: { ...COUNT, description: "How many there are in all, at the commit the page was read at." }, next_cursor: { ...NULL_STRING, description: "The next page, read at the same commit of main as this one: opaque. Null on the last." } }, description);
/** When a retired workflow draft was retired, and by whom: on a retired one alone. */
const RETIRED = {
  type: "object", additionalProperties: false, required: ["at", "by"],
  properties: {
    at: { type: "string", format: "date-time", description: "When: the commit that retired it; for `host`, the newest commit on its file." },
    by: { enum: ["person", "run", "host"], description: "`person`: its owner, in the console or with POST .../retire (the time of that retire); `run`: anything else that set it; `host`: no one retired it, a draft's README.md whose front matter can't be read (it reads no way, or its status is none the host writes) reads retired, so no run is given it (`why`). Fix the file, then restore it." },
    from: { enum: ["active", "pending"], description: "With `by: person` or `run`: the status POST .../restore gives it back, as its retire recorded it (`retired_from` in its front matter): `active`, or `pending`, waiting for its owner's OK again, so a retire and a restore never skip that OK. One whose retire recorded none reads `pending`. Absent with `by: host`." },
    why: { const: "unreadable", description: "With `by: host` alone: why it reads retired." },
  },
  description: "When and by whom it was retired, and what its restore gives back; absent unless `status` is `retired`. POST .../restore puts it back in the status it had before its retire (`from`).",
};
/** The newest change to a draft, from the newest commit on its README.md. */
const LAST_CHANGE = closed({
  kind: { enum: ["approved", "edited", "created", "retired", "restored", "learned"], description: "What the change was: a person's approval, edit, creation, retire or restore (named by its commit), or `learned`, a run's merge." },
  by: { enum: ["person", "run"], description: "`person`: its owner, in the console or through the API; `run`: a run's merge." },
  at: { type: "string", format: "date-time", description: "When: the commit's time." },
}, "The draft's last change: the newest commit on its README.md, a person's (named by its subject's fixed prefix, `learning: <kind> by a person: `) or a run's merge (its Run-Id: `learned`). Absent when that commit is neither (the folder's own first commit, or one made outside the server).");
const LEARNING_BY = { oneOf: [closed({ run: { type: "string" } }), { type: "object", additionalProperties: false, required: ["user"], properties: { user: { type: "boolean", const: true }, via: { type: "string", description: "On an approval: how it came, `console` (the owner's signed-in page)." } } }], description: "A run's merge (its commit's `Run-Id` trailer), or a person's edit, retirement or approval through this API (`Changed-By: user`, and `Approved-Via` on an approval)." };
const LEARNING_CHANGE = closed({
  by: LEARNING_BY,
  commit: { type: "string" }, at: { type: "string", format: "date-time" },
  reason: { type: "string", description: "A merge's: what it kept. A person's: what was done, `edited by a person: corrections.md`." },
  files: { type: "array", items: { type: "string" }, description: "The files the commit changed; a name holding one of the host's secrets reads `[redacted]`." },
});
const LEARNING_COUNTS = closed({
  merged: COUNT,
  dropped: { type: "object", additionalProperties: COUNT, propertyNames: { enum: [...LEARNING_REASONS] }, description: "By reason (Run.learning.reason): only reasons with one run or more." },
  in_progress: { ...COUNT, description: "Seeded or reflecting: runs this server holds." },
}, "How the agent's runs that tried to learn fared, archived runs left out: GET /stats' `learning` with `agent`, less `runs`, counted as it counts them, from the runs this server holds and its learning ledger, no run's files opened.");
/** One side of an agent's impact (learning-run.ts learningImpact). */
const IMPACT_SIDE = (side: "before" | "after") => closed({
  runs: { ...COUNT, description: side === "before" ? "The completed runs that started before the agent's first learned item (a correction or a workflow)." : "The completed runs that started from at least one learned item: a correction in corrections.md, or a learned workflow their learned_workflow tool could run." },
  median_duration_s: { type: "number", minimum: 0, description: "Their median time to the answer, in seconds to a tenth: from the run's start to the moment its job's answer was final, before its end-of-run step (a run that does not learn: to its end)." },
});
/** A workflow draft the agent learned, as the agent's learning lists it (learning-routes.ts workflowView). */
const LEARNED_WORKFLOW = {
  type: "object", additionalProperties: false,
  required: ["name", "file", "readme", "description", "status", "run", "bytes", "etag"],
  properties: {
    name: { type: "string", description: "The workflow's folder name; `[redacted]` when it holds one of the host's secrets as they are now." },
    file: { type: "string", description: "Its draft, `workflows/<name>/workflow.json`: GET .../learning/files/{file}, percent-encoded, reads it as JSON." },
    readme: { type: "string", description: "Its README.md, which the server writes from the description the run gave: the file that says whether it waits, and the one an approval names." },
    description: { type: "string", description: "What its README.md's front matter says it is for, cut of the host's secrets." },
    status: { enum: ["serving", "checking", "held", "stopped", "pending", "retired"], description: "Where it stands, one word. `pending`: it waits for its owner's OK (`status: pending` in its README.md: a draft that calls a tool with no price), and no run is given it until it is approved (POST .../learning/files/{file}/approve on its README.md). `retired`: a person retired it (POST .../learning/files/{file}/retire on its README.md), and no later run is given it. Else its state as GET .../learning/promotions says it (`serving[].state`, the same records and the same cost rule): `serving`, a revision of it serves first on the runs it fits; `checking`, its newest revision's check is at work, or it has no promotion record yet and the first run it fits starts its check (an older revision that serves keeps serving meanwhile, else the agent takes the runs); `held`, none serves, its newest record holds it; `stopped`, none runs first until a new revision lands: its holds stopped it, or the cost rule did (GET .../learning/cost `workflows[].state` `needs_revision`)." },
    run: { ...NULL_STRING, description: "The run whose merge last changed it; null when no merge names one." },
    bytes: { ...COUNT, description: "The size of its workflow.json on main." },
    etag: { type: "string", description: "The version of its README.md on main, as its file's GET answers it: an approval sends it as If-Match." },
    retired: RETIRED,
    last_change: LAST_CHANGE,
  },
  "x-agentrun-serve": "learning/3",
};
const LEARNING_MODEL = closed({
  location: { enum: ["server", "native"], description: "Server model route, or the connected native runtime's existing sign-in (no copied server key required)." },
  ready: { type: "boolean", description: "The required model route and credential are configured. This read makes no paid model request and does not verify provider quota or future availability." },
  model: { ...NULL_STRING, description: "The resolved model for this agent, or the server default in capabilities; null when none is configured." },
  needs: { enum: ["key", "model", null], description: "What must be configured: a credential for the selected model route, or a supported model. A tool or decision-provider key alone is insufficient." },
  reason: { ...NULL_STRING, description: "Setup guidance when unavailable, or how native sign-in supplies the model." },
});
const AGENT_LEARNING = closed({
  learning_model: LEARNING_MODEL,
  agent: { type: "string" },
  main: { ...NULL_STRING, description: "Main's head commit; null while the agent has no learning folder (its learning was never on), when every page is empty." },
  corrections: { type: "string", description: "corrections.md on main, cut of the host's secrets: what the agent's next run is given whole under # Learned, one line per correction its owner gave. Empty when there is none. GET .../learning/corrections reads it with its ETag; PUT writes it.", "x-agentrun-serve": "learning/4" },
  workflows: { type: "array", items: LEARNED_WORKFLOW, description: "Every workflow draft on main, `workflows/<name>/workflow.json` with its README.md, by name. Empty when there is none.", "x-agentrun-serve": "learning/3" },
  log: PAGE(LEARNING_CHANGE, "The first 20 changes on main, newest first. GET .../learning/log for more."),
  counts: LEARNING_COUNTS,
  impact: {
    oneOf: [closed({ before: IMPACT_SIDE("before"), after: IMPACT_SIDE("after") }), { type: "null" }],
    description: "What learning changed for the agent: its completed agentic runs that started from at least one learned item, a correction or a learned workflow they could run (`after`), against those that started before its first item (`before`: before the earlier of its first merge and the start of its first run that started from one, so a person's first correction counts too). A later run with learning off, or seeded with no item (no correction, every workflow retired), an imported and an archived run are on neither side. Null unless both sides count 2 runs or more: say it \"on N runs\", N `after.runs`. Read from the runs' rows and the learning ledger, no run's files opened.",
    "x-agentrun-serve": "learning/2",
  },
});
/** GET and PUT /agents/{agent_id}/learning/corrections (learning-routes.ts correctionsView). */
const CORRECTIONS = closed({
  text: { type: "string", description: "corrections.md's whole text on main, cut of the host's secrets; empty when there is none." },
  etag: { type: "string", description: "Its version on main, the same as the ETag header: a PUT sends it as If-Match." },
  cap_bytes: { type: "integer", const: CORRECTIONS_CAP, description: "The most bytes the file holds: a correction or an edit past it is refused." },
});
const PROBLEM = { type: "object", additionalProperties: false, required: ["rule", "detail"], properties: { rule: { type: "string" }, path: { type: "string" }, detail: { type: "string" } } };
/** A workflow draft a run's merge wrote, as its learning names it (learning.ts filesView). */
const MERGED_WORKFLOW = { type: "object", additionalProperties: false, required: ["file", "name"], properties: { file: { type: "string", description: "Its draft, `workflows/<name>/workflow.json`; `[redacted]` when it holds one of the host's secrets as they are now." }, name: { type: "string", description: "The workflow's folder name, `[redacted]` as `file` is." }, pending: { type: "boolean", const: true, description: "Present while it waits for the owner's OK." } } };
/** The workflow draft a run's learning merged, on its learning block: present only when it merged one. */
const RUN_WORKFLOWS: Record<string, Json> = {
  workflows: {
    type: "array", minItems: 1, items: MERGED_WORKFLOW,
    description: "The workflow draft this run's learning added or changed: present once `state` is `merged` and it kept one, absent otherwise.",
    "x-agentrun-serve": "learning/3",
  },
};
/** `properties` as a closed object, its `optional` ones left out of `required`. */
const closedWith = (properties: Record<string, Json>, optional: Record<string, Json>) => ({ ...closed(properties), properties: { ...properties, ...optional } });

/** What POST /runs/{run_id}/computer/take-over and .../hand-back answer (computer-commands.ts ComputerHoldAnswer). */
const COMPUTER_ANSWER = closedWith({
  hold: { enum: ["agent", "pending", "person"], description: "Who drives now: `agent`; `pending`, the owner's take waits for the agent's call in flight (new agent calls wait meanwhile); `person`, the owner." },
}, {
  outcome: { enum: ["done", "cancelled", "expired"], description: "A hand-back that answered the agent's ask: the answer the agent gets, the first one." },
});
/** A secret's set, source and changed_at, from the one shared shape (secret-writes.ts SECRET_META_SCHEMA): never a value,
 *  a prefix, a length or a hash. */
const { set: SECRET_SET, source: SECRET_SOURCE, changed_at: SECRET_CHANGED_AT } = SECRET_META_SCHEMA.properties;
const SECRET_META = { set: SECRET_SET, source: SECRET_SOURCE, changed_at: SECRET_CHANGED_AT };
/** One secret's SecretMeta, exactly { name, set, source, changed_at }: its name is "<plane>:<id>". */
const SECRET_ITEM = (nameDescription: string) => closed({ name: { type: "string", description: nameDescription }, ...SECRET_META });
/** GET /settings/model-gateway's answer (model-gateway.ts GatewayView): the gateway in force and its models, its key as
 *  its SecretMeta, never a value. */
const GATEWAY_MODEL_ID = { type: ["string", "null"], description: "A model id as the gateway lists it, sent as it is (AGENT_MODEL_GATEWAY_IDS never cuts it); null: none, and a node of the tier runs on the run's own model." };
const MODEL_GATEWAY_VIEW = closed({
  source: { enum: ["env", "console", null], description: "The gateway in force: `env`, the one AGENT_MODEL_BASE_URL names where AgentRun starts, which wins whole (its key, its id style, its models) and is changed only there; `console`, the one saved with PUT /settings/model-gateway; null, none, and the provider keys are in force." },
  base_url: { type: ["string", "null"], description: "The gateway's address as given: every model request goes to its `/v1/...` routes (a trailing `/v1` is taken off)." },
  ids: { enum: ["as_named", "bare"], description: "How the gateway takes the ids a revision or a provider key's default names: whole (`as_named`, `openai/gpt-x`), or `bare`, the part after the provider. The tiers' own models go as they are." },
  models: closed({ default: GATEWAY_MODEL_ID, fast: GATEWAY_MODEL_ID, strong: GATEWAY_MODEL_ID }),
  set_at_start: { type: "array", items: { type: "string" }, description: "The variables of these fields set where AgentRun starts (AGENT_MODEL_BASE_URL, AGENT_MODEL_GATEWAY_IDS, AGENT_MODEL, AGENT_MODEL_FAST, AGENT_MODEL_STRONG, AGENT_MODEL_API_KEY): each wins over what is saved here, and is changed only where AgentRun starts. A key set there goes only to the gateway AGENT_MODEL_BASE_URL names, never to a saved one." },
  secret: { ...SECRET_ITEM("\"model:gateway\": the gateway's key, which PUT /settings/model-gateway takes as api_key and AGENT_MODEL_API_KEY sets with AGENT_MODEL_BASE_URL."), description: "The gateway's key as its SecretMeta: never a value." },
  problem: { type: ["string", "null"], description: "Why the gateway in force runs no model, in words: an address the one rule refuses (https only, or http to this machine; no user, query, fragment or dot segment). Null when none." },
});
/** POST /settings/model-gateway/test's answer: the model ids the gateway lists, or why it could not be asked. */
const MODEL_GATEWAY_TEST = {
  oneOf: [
    closed({ ok: { const: true }, models: { type: "array", items: { type: "string" }, description: "The model ids GET <base>/v1/models listed, in its order, at most 500." } }),
    closed({ ok: { const: false }, why: { type: "string", description: "Why the gateway could not be asked or listed no models, in words naming what to check: never the key." } }),
  ],
};
/** computer/1: an agent's computer kind, as Settings → Computers and the run read name it (computer-setting.ts). */
const COMPUTER_KIND = { enum: ["none", "sandbox", "desktop", "phone", "browser"] };
/** A computer choice's shell (computers.ts ShellChoice): where its runs have their shell, in this server's folder mode. */
const CHOICE_SHELL = { enum: ["computer", "local", "none"], description: "Where a run of this choice has its shell, in this server's folder mode: `computer`, in the computer, which mounts the run's folder (bash and the background tools); `local`, no computer mounts it and the folder is on the owner's disk, so bash runs in a fresh container there (bash only); `none`, no computer mounts it and the folder is on this server's own disk, so the run has no shell (the file tools only)." };
/** The host tools a choice gives, by name: the kernel registry's list for its shell. */
const CHOICE_HOST_TOOLS = { type: "array", items: { type: "string" }, description: "Exactly the host tools a run of this choice gets, by name: the file tools always, bash with a shell (`computer` or `local`), the five background tools on a computer." };
/** What a choice leaves out of the shell, in words. */
const CHOICE_SHELL_NOTE = { type: "string", description: "What this choice leaves out of the shell, in plain words; absent when its shell is `computer`. A save that names a tool it leaves out is refused in the same words." };
/** A sandbox's GPUs on an agent's computer setting (computer-setting.ts GpuSetting). */
const COMPUTER_GPU = {
  type: "object", additionalProperties: false, required: ["type", "count"],
  properties: {
    type: { type: "string", minLength: 1, description: "A GPU type the provider declares, in the vendor's own name (GET /computers: the provider's `gpu.types`), such as \"T4\" or \"A100-80GB\"." },
    count: { type: "integer", minimum: 1, description: "How many: at most the provider's `gpu.max`." },
  },
  description: "The GPUs a sandbox computer asks for; only a sandbox takes them (another kind is 422). A type or a count its provider does not give, or a provider whose GPU computers take no mount of this server's folder mode, keeps the agent from running here (409 agent_not_runnable, in the computer package's checkGpu words); absent, none.",
};
/** A provider's GPUs in Settings → Computers (computers.ts GpuView): what its sandbox configuration declares. */
const COMPUTER_PROVIDER_GPU = closedWith({
  types: { type: "array", items: { type: "string" }, description: "The GPU types it gives, as `computer.gpu.type` names them." },
  max: { type: "integer", minimum: 1, description: "The most GPUs one computer gets." },
}, {
  isolation: { enum: ["container", "gvisor", "microvm", "vm", "machine"], description: "The isolation a GPU computer runs under, where it is not the provider's own (Modal's run on gVisor)." },
  preemptible: { type: "boolean", description: "Whether the vendor may preempt a GPU computer mid-run." },
  stopDeletes: { type: "boolean", description: "Whether stopping a GPU computer deletes it: no pause and no snapshot, so nothing on it persists." },
  region: { type: "string", description: "The one region its GPU computers run in." },
  perGpu: closed({ cpus: { type: "integer" }, memoryMb: { type: "integer" }, diskMb: { type: "integer" } }, "What a GPU computer is given per GPU, by default."),
  mounts: { type: "array", items: { type: "string" }, description: "The mount kinds its GPU computers take, where fewer than its own: one that is not listed is refused as not proven." },
  fence: { enum: ["netns", "userns-netns"], description: "How the computer's daemon holds a GPU computer's programs off its network, where it is not the plain network namespace: `userns-netns`, one made inside a user namespace (Modal's gVisor, where root may not make one itself). Either way the programs reach their own loopback alone." },
  why: { type: "string", description: "Why a run on this server cannot have its GPUs: its GPU computers take no mount of this server's folder mode." },
});
/** `runs_refused` of a provider in Settings → Computers (computers.ts ProviderView; attached-computers.ts dialApartWords). */
const PROVIDER_RUNS_REFUSED = { type: ["string", "null"], description: "On a server whose runner runs in a process of its own (`--no-runner`; the image's default `server-and-runner`), why no run here can use this provider's computers, and the one-line fix: start the image with the server options alone, without `server-and-runner`. Said for a provider whose machines dial this server (Fly Machines and Cloudflare), whose sockets the server's process takes and its runner never reaches, unless a runner of its relays their dials now (it knows the server's public address, AGENTRUN_PUBLIC_URL, and the server relays each machine's socket to it); and for a paired computer, always. Its test (POST /computers/{provider}/test) fails in the same words. Null where this server's runs can use it." };
/** A provider in Settings → Computers (computers.ts ProviderView). */
const COMPUTER_PROVIDER = closedWith({
  id: { type: "string", description: "The provider's id, as an agent's `computer.provider` names it (PUT /computers/{provider}/keys)." },
  name: { type: "string", description: "Its name in words." },
  metered: { type: "boolean", description: "Whether its computers are billed by the vendor." },
  secrets: { type: "array", items: SECRET_ITEM("\"computer:<provider>:<KEY>\": KEY is the name PUT /computers/{provider}/keys takes, and the environment variable that sets it."), description: "Each key the provider declares, as its SecretMeta: never a value." },
  required: { type: "array", items: { type: "string" }, description: "The names of the secrets the provider needs; any other may stay unset." },
  ready: { type: "boolean", description: "Whether a run could have its computer of this kind here now: it fits this server's folder mode and every required key is saved." },
  runs_refused: PROVIDER_RUNS_REFUSED,
  folder: { enum: ["bind", "archil", "sync", null], description: "The kind of the run's folder a run of an agent with this computer holds on this server now, by the rule a run's claim picks it by (this server's folder mode, and the provider's keys and image as this server has them). `bind`: a folder of this machine (Mode 1). `archil`: the owner's Archil disk, where the provider takes an Archil mount, has Archil's image and does not dial this server. `sync`: a synced folder the runner keeps, for any other computer that takes a folder in Mode 2. Null: none. For a computer with no GPUs: `gpu.mounts` says which kinds its GPU computers take. A kind alone, never a key, an image or an address." },
  shell: CHOICE_SHELL,
  host_tools: CHOICE_HOST_TOOLS,
}, {
  why: { type: "string", description: "Why it is not ready, in words naming the setting to fill." },
  picked: { type: "array", items: { type: "string" }, description: "The names of the secrets a person picks from the vendor's own list (GET /computers/{provider}/choices: Orgo's workspace, by name) rather than pastes. Absent when it has none." },
  shell_note: CHOICE_SHELL_NOTE,
  gpu: { ...COMPUTER_PROVIDER_GPU, description: "A sandbox provider's GPUs, where it declares them: the choices an agent's `computer.gpu` names." },
  network: { type: "string", description: "What this server's allow-list (AGENTRUN_BOX_ALLOW) means for the provider's computer of this kind, where it does not apply as it is, in words: one with no network has none (\"no network, so this server's allow-list isn't offered\"); one on an open network is open (\"an open network (the vendor's own, or public addresses from this machine); this server's allow-list doesn't apply\"), except where AGENTRUN_BOX_ALLOW is none and the computer needs a network, which this server refuses (\"needs a network, which this server refuses: its AGENTRUN_BOX_ALLOW is none\"; the provider is then not ready, and its runs are refused). A desktop whose provider makes open and an allowlist (Docker's, Agent37's, E2B's), and Local Chrome, reach the public web under the default list, through their egress proxy (\"open unless this server sets AGENTRUN_BOX_ALLOW; then only those hosts\"). Absent where the allow-list applies as it is (a sandbox), or where it depends on the image a provider's configurations name." },
  images: { type: "array", items: { type: "string" }, description: "The images the provider offers for the kind, as an agent's `computer.image` names them (Orgo's desktop: `linux`, `windows`); the kind's default first when it is one of them. Absent when it offers none to choose." },
  persistent: {
    ...closedWith({}, { images: { type: "array", items: { type: "string" }, description: "Of `images`, the ones whose computer an agent can keep. Absent when the provider offers no images to choose." } }),
    description: "Present where an agent's computer of this kind can be kept between its runs (`computer.persistent: true`): its provider keeps one for an agent (Orgo's Linux desktop, which its suspend keeps with its memory). Absent where none can.",
  },
});
/** `runs_refused` of a pairing code, the pair answer and a paired computer (attached-computers.ts RUNNER_APART_WORDS). */
const RUNS_REFUSED = { type: ["string", "null"], description: "On a server whose runner runs in a process of its own (`--no-runner`; the image's default `server-and-runner`), why no run here can use a paired computer, and the one-line fix: start the image with the server options alone, without `server-and-runner`. A computer still pairs and attaches. Null where this server's runs can use it." };
/** A paired computer in GET /computers' `paired` (computer-attach.ts PairedView). */
const PAIRED_COMPUTER = closed({
  id: { type: "string", description: "Its id: an agent's `computer.provider` names it (`{kind: \"desktop\", provider: <id>}`), and DELETE /computers/{computer_id} removes it." },
  name: { type: "string", description: "What the person called it when they paired it." },
  kind: { type: "string", description: "The machine kind it paired as (its hello's `kind`, such as `desktop` or `android`)." },
  serves: { type: "array", items: COMPUTER_KIND, description: "The kinds of an agent's computer setting it serves, from its driver's last hello: an agent's `computer` names it under one of these." },
  unserved: { type: ["string", "null"], description: "When it serves no kind (`serves` is empty), why, naming what its driver lacks and to update the driver: \"desk-1's driver serves no kind: it says desktop but declares no input.pointer, input.keys: update the driver on desk-1\". Its driver's next hello after an update counts. Null when it serves a kind." },
  runs_refused: RUNS_REFUSED,
  os: { type: "string", description: "Its OS, as its hello said it." },
  os_version: { type: ["string", "null"], description: "Its OS's version as its driver says it, with a build where the driver knows one; null where it says none." },
  device: { oneOf: [closed({ maker: { type: "string" }, model: { type: "string" } }), { type: "null" }], description: "The machine, as its driver says it (`maker`, `model`); null where it says none." },
  arch: { type: "string", description: "Its architecture, as its hello said it." },
  screen: { oneOf: [closed({ width: { type: "number" }, height: { type: "number" }, scale: { type: "number" } }), { type: "null" }], description: "Its main screen in points, and pixels per point; null for a computer with no screen." },
  groups: { type: "array", items: { type: "string" }, description: "The capability groups its driver offers: its live hello's while it is attached, else its last hello's. A run uses only these." },
  features: { type: "object", additionalProperties: { oneOf: [{ const: true }, closed({ off: { type: "string", description: "Why it is off here, in words a person can act on." } })] }, description: "What its groups can and cannot do on it, by feature name (true, or off with why), as its driver says it: live while attached, else as paired." },
  driver: { type: "string", description: "Its driver's build: its live hello's while it is attached, else the one it last said." },
  online: { type: "boolean", description: "Whether its driver is attached to this server now." },
  held_by_run: { type: ["string", "null"], description: "The run that holds it now; null when none does." },
  held_until: { type: ["string", "null"], format: "date-time", description: "When the holding run's hold ends, released or not: the run's lifetime. Past it the run's connections close and the next run may claim it, and the computer stays attached. Null when no run holds it." },
  pairing: { type: "string", description: "The pairing (POST /computers/pairings' `id`) whose code paired it." },
  created_at: { type: "string", format: "date-time", description: "When it was paired." },
  seen_at: { type: ["string", "null"], format: "date-time", description: "When it last attached; null before its first." },
});
/** POST /computers/pairings' answer. */
const PAIRING = closed({
  id: { type: "string", description: "Names this pairing, not its code: the computer the code makes carries it as `pairing` in GET /computers' `paired`, so the page that made the code can tell its own code was used, and by which computer." },
  code: { type: "string", pattern: PAIRING_CODE_PATTERN.source, description: "The code to type into the driver, such as K7PD-W3QX." },
  expires_at: { type: "string", format: "date-time", description: "When it stops pairing; it is good once before then." },
  runs_refused: RUNS_REFUSED,
});
/** POST /computers/pair's body: the driver's. */
const PAIR_REQUEST = closedWith({
  code: { type: "string", description: "The code the console showed; spaces and case are taken as typed." },
  name: { type: "string", minLength: 1, maxLength: PAIRED_NAME_MAX, description: "What the person calls the computer: \"Ada's MacBook Pro\"." },
  hello: {
    type: "object",
    required: ["protocol", "version", "os", "kind", "arch", "groups"],
    properties: {
      protocol: { type: "string", description: `The protocol version the driver speaks: this server's is ${PROTOCOL_VERSION}.` },
      version: { type: "string", description: "The driver's own build." },
      os: { enum: ["linux", "windows", "macos", "android", "ios"] },
      kind: { enum: ["linux", "desktop", "android", "ios", "browser"] },
      arch: { type: "string" },
      groups: { type: "array", items: { type: "string" } },
    },
    description: "The driver's own answer to hello, as it would give it: what the server pairs (its kind, OS, groups and features).",
  },
}, {});
/** POST /computers/pair's answer. */
const PAIRED_TOKEN = closed({
  computer: { type: "string", description: "The paired computer's id." },
  token: { type: "string", description: "The computer's token (`art_` and 32 random bytes): shown only here; the driver keeps it in the OS's keychain." },
  runs_refused: RUNS_REFUSED,
});
/** GET /computers' answer (computers.ts view). */
const COMPUTERS_VIEW = closed({
  paired: { type: "array", items: PAIRED_COMPUTER, description: "The person's own computers paired with this server (Settings → Computers → Pair a computer), oldest first, each online or not. Each is also a provider of its kind under `kinds`, ready while it is online." },
  kinds: {
    type: "array",
    items: closedWith({
      kind: COMPUTER_KIND,
      offered: { type: "boolean", description: "Whether this server offers the kind now: `none` always; another when a provider that serves it fits this server's folder mode." },
      groups: { type: "array", items: { type: "string" }, description: "The capability groups the kind needs, then those it brings when a provider declares them." },
      tools: { type: "array", items: { type: "string" }, description: "The model's tools the kind brings, by name." },
      settings: { type: "array", items: { type: "string" }, description: "The fields an agent's computer of this kind may set beside its kind and provider; none for kind none. Whether a provider offers a value is its own (images, persistent, gpu)." },
      record: {
        oneOf: [
          closed({ available: { type: "boolean", const: true, description: "An agent's computer of this kind may set `record: true` here: the kind records (a desktop, a phone or a browser) and this server has ffmpeg on its PATH, read at each call." } }),
          closed({ available: { type: "boolean", const: false, description: "An agent's computer of this kind may not set `record: true` here." }, why: { type: "string", description: "Why not, in plain words: the kind has no screen to record, or this server has no ffmpeg." } }),
        ],
        description: "Whether a run of this kind can record a video of its screen on this server (an agent's `computer.record`), and why not.",
      },
      providers: { type: "array", items: COMPUTER_PROVIDER, description: "The providers that serve the kind." },
    }, {
      why: { type: "string", description: "Why it is not offered." },
      shell: { ...CHOICE_SHELL, description: `Kind none only (the one "no computer" choice; another kind's is each provider's). ${CHOICE_SHELL.description}` },
      host_tools: { ...CHOICE_HOST_TOOLS, description: `Kind none only. ${CHOICE_HOST_TOOLS.description}` },
      shell_note: { ...CHOICE_SHELL_NOTE, description: `Kind none only. ${CHOICE_SHELL_NOTE.description}` },
    }),
  },
});
/** POST /computers/{provider}/test's and POST /workspace/archil/test's answer. */
const ACCOUNT_TEST = {
  oneOf: [
    closed({ ok: { const: true }, detail: { type: "string", description: "What the one account-level read found." } }),
    closed({ ok: { const: false }, why: { type: "string", description: "Why the test did not pass, in plain words naming what to check: never a key." } }),
  ],
};
/** GET /computers/{provider}/choices (computers.ts choices): each picked key, its choices or why there are none. */
const COMPUTER_CHOICES = closed({
  choices: {
    type: "array",
    description: "Each key the provider lists under `picked`, in its descriptor's order.",
    items: {
      oneOf: [
        closedWith({
          key: { type: "string", description: "The KEY, as PUT /computers/{provider}/keys takes it." },
          options: { type: "array", description: "The values the vendor's list offers, in its order.", items: closed({ value: { type: "string", description: "The value saved under the key." }, label: { type: "string", description: "Its words, as a person picks it (a workspace's name)." } }) },
        }, {
          saved: { type: "string", description: "The option whose value is saved under the key now, where one is. Absent when none is saved, or the saved one is not offered." },
        }),
        closed({ key: { type: "string", description: "The KEY, as PUT /computers/{provider}/keys takes it." }, why: { type: "string", description: "Why there is none to pick, in plain words: never a key." } }),
      ],
    },
  },
});
/** held/1: what POST /runs/{run_id}/start and .../computer/release answer (computer-held-routes.ts heldRoute). */
const HELD_ANSWER = (state: "started" | "released") => closed({ held: closed({ state: { const: state } }) });
/** A run's computer, on the run read (run-computer.ts runComputerField). */
const RUN_COMPUTER = {
  ...closedWith({
    kind: { enum: ["sandbox", "desktop", "phone", "browser"] },
    provider: { type: "string" },
    state: { enum: ["starting", "ready", "taken_over", "ended", "failed"], description: "`taken_over` while the owner holds the run's desktop or phone (POST /runs/{run_id}/computer/take-over); `failed` when the run could not have its computer (error code `computer_unavailable`)." },
  }, {
    why: { type: "string", description: "With `failed`: the server's words, naming the setting to fill." },
    held: {
      ...closedWith({
        state: { enum: ["starting", "waiting", "started", "ended", "released"], description: "`starting` until the run's computer comes up; `waiting`, up and held, the agent not started (POST /runs/{run_id}/start); `started`, the agent runs; `ended`, the agent is done or was stopped and the run keeps the computer for its owner; `released`, let go (POST /runs/{run_id}/computer/release, no call for `minutes`, or the run's end)." },
        minutes: { type: "integer", minimum: 1, maximum: HOLD_MAX_MINUTES, description: "How long the hold waits with no call from its owner (the run's `hold_minutes`)." },
      }, {
        until: { type: "string", format: "date-time", description: "When the hold lets the computer go if no call comes first. Absent once released." },
        why: { enum: ["timeout", "lost"], description: "Why it was let go when no release did: `timeout`, no call came for `minutes`; `lost`, the runner that held it lost the run, and its computer with it." },
      }),
      description: "A run started with `hold: true`: where its held computer is.",
    },
  }),
  description: "The run's computer, its agent's `computer` setting: absent for a run with none.",
  "x-agentrun-serve": "computer/1",
};
const RUNNING_COMPUTERS = closed({
  runs: {
    type: "array",
    items: ref("schemas/Run"),
    description: "The runs still going whose agent has a computer, newest first, each as GET /runs/{run_id} answers it, so each carries its `computer`. A run with no computer, and one that has ended, is not here.",
  },
});
/** archil/1: GET, PUT and DELETE /workspace/archil's answer (archil-routes.ts view). */
const ARCHIL_VIEW = closedWith({
  on: { type: "boolean", description: "Whether Mode 2 is on: run folders on Archil disks, each agent's own (made on its first run that needs one) unless a run's launch names another. Off, they are on this server's own disk (Mode 1)." },
  secret: { ...SECRET_ITEM("\"workspace:archil\": the Archil account key, which PUT /workspace/archil takes as keys.ARCHIL_API_KEY and the environment variable ARCHIL_API_KEY sets."), description: "The account key as its SecretMeta: never a value." },
}, {
  source: { enum: ["env", "console"], description: "While on, where the settings come from: `env`, the server's environment (AGENTRUN_ARCHIL_REGION, AGENTRUN_ARCHIL_S3_URL and AGENTRUN_ARCHIL_IMAGE), which wins over saved ones and is changed where the server is started; `console`, saved with PUT /workspace/archil." },
  region: { type: "string", description: "The account key's region: every disk is made, read and minted on its control plane." },
  s3Url: { type: "string", format: "uri", description: "The region's S3 endpoint (the disks' file API)." },
  image: { type: "string", description: "The exec image, pinned by digest (`<name>@sha256:<64 hex>`); absent, serve's default (`buildpack-deps:trixie-scm` pinned by digest, git 2.47)." },
});
/** archil/1: GET and DELETE /agents/{agent_id}/archil's answer (archil-routes.ts agentView). */
const AGENT_ARCHIL_VIEW = closed({
  on: { type: "boolean", description: "Whether this server is in Archil mode (Mode 2). Off, no agent has a disk here." },
  archil_disk: {
    oneOf: [closed({ disk_id: { type: "string", pattern: "^dsk-[0-9a-f]{16}$" } }), { type: "null" }],
    description: "The agent's own disk, which agentrun made for it (named `agentrun-<server id>-i-<agent id>`): null until its first run that uses it (a run whose launch names no `archil_disk`), when it is made.",
  },
});
const COMPUTER_MARK = { "x-agentrun-serve": "computer/1" };
/** attach/1: a person's own computer paired with this server (computer-attach.ts). */
const ATTACH_MARK = { "x-agentrun-serve": "attach/1" };
const ARCHIL_MARK = { "x-agentrun-serve": "archil/1" };
const PROVIDER_PARAM = { name: "provider", in: "path", required: true, description: "The provider's id (GET /computers lists them).", schema: { type: "string", minLength: 1 } };
/** computer/1: a run's live computer kind, one live view family for every kind (GET /runs/{run_id}/computer). */
const RUN_COMPUTER_KIND: Json = { enum: ["browser", "desktop", "phone"], description: "The run's computer: its agent's computer kind (`browser` for the browser tool)." };
/** Who drives the run's computer now (GET /runs/{run_id}/computer). */
const COMPUTER_HOLD: Json = { enum: ["agent", "pending", "person"], description: "Who drives the computer now: `agent`; `pending`, the person's Take over waits for the agent's step in flight; `person`, taken over." };
/** trigger/1: triggers, a schedule or a signed webhook, that start an agent's capped runs or message a run (triggers.ts). */
const TRIGGER_MARK = { "x-agentrun-serve": "trigger/1" };
/** A trigger whose firings could not carry the keys its agent's runs owe under AGENTRUN_RUN_KEYS=1 (run-keys.ts firingsOwe). */
const TRIGGER_RUN_KEYS = "on a server started with AGENTRUN_RUN_KEYS=1, a target whose runs must each bring a tool key this server does not hold (`keys`) is 409 `agent_not_runnable` naming each key at `keys.<NAME>`, and nothing is made or changed: a start_run target's, unless the launch hook is set (each firing then goes to the backend, which starts the run with its keys), and a message_run target's, hook or not.";
/** A run's `trigger`, on Run and on RunSummary alike. */
const RUN_TRIGGER: Json = {
  oneOf: [closed({ id: { type: "string", description: "The trigger (GET /triggers/{trigger_id}); it may have been deleted since." }, firing_key: { type: "string", pattern: "^fir_[0-9a-f]{32}$", description: "The firing that started it." } }), { type: "null" }],
  description: "The trigger that started the run, and its firing; null for a run a caller started.",
  ...TRIGGER_MARK,
};
/** path/1: the path a run took and the learned workflow that served it (store-reads/learning.ts pathViewOf), on Run and RunSummary alike. */
const RUN_PATH: Record<string, Json> = {
  path: {
    oneOf: [{ enum: [...RUN_PATHS] }, { type: "null" }],
    description: "The path the run took, as its end recorded it. `agent`: no learned workflow ran (every run of an agent that does not learn); `workflow`: a learned workflow served it first and its answer stands, `result.final_answer` that answer as the workflow gave it; `handed_back`: a learned workflow served it first and handed back (an escalate node said it could not, a step failed) or the agent answered after it, `result.final_answer` the agent's; `replay`: a check's run of a new revision on one of the agent's graded inputs; `audit`: an audit's shadow run (`audit_of`), the agent on a served run's input with learning off. A host's run list holds no `audit` run, and its webhooks never name one. Null while the run has not ended, for a workflow revision's run, and for a run that learns whose end recorded no path.",
    "x-agentrun-serve": "path/1",
  },
  workflow: {
    oneOf: [closed({
      name: { type: ["string", "null"], description: "The learned workflow, by name (GET /agents/{agent_id}/learning/promotions names it); null when its launch offered none by that name." },
      digest: { type: ["string", "null"], description: "The revision that ran: the first 16 hex of its workflow.json's sha256, as GET /agents/{agent_id}/learning/cost `runs[].digest` names it; null when its record names none." },
      repick: { oneOf: [{ enum: ["found", "missed"] }, { type: "null" }], description: "`found` or `missed`: the answer's quote re-pick ran and found, or still missed, its quotes. Null: no re-pick ran." },
    }), { type: "null" }],
    description: "The learned workflow that served the run, as its end recorded it: present on a run with `path` `workflow` (its answer is the workflow's) or `handed_back` (its answer is the agent's), null on every other run. Read off the run's record, so every row of a runs list carries it.",
    "x-agentrun-serve": "path/1",
  },
};
const DATE_TIME = { type: "string", format: "date-time" };
/** A trigger's source, as `adapters` give it. */
const sourceSchemaOf = (adapters: readonly TriggerAdapter[]) => ({
  oneOf: adapters.flatMap((a) => a.schemas),
  description: `When it fires: ${adapters.map((a) => a.fires).join(", or ")}. Each next time is reckoned from the last nominal one, never from when the timer woke. Times missed while the server was down, or more than a minute late, are one \`missed\` firing with their count, and the schedule goes on from now.`,
});
const TRIGGER_SOURCE = sourceSchemaOf(TRIGGER_ADAPTERS);
/** A trigger's source as the server holds and sends it: each adapter's sent shapes (a cron line's zone and an interval's
 *  start always set, to UTC and to when it was written when the write left them out), else its own (a webhook's
 *  signature and accept, absent when the write left them out). */
const sentOf = (adapters: readonly TriggerAdapter[]) => ({ ...sourceSchemaOf(adapters), oneOf: adapters.flatMap((a) => a.sent ?? a.schemas) });
const TRIGGER_SOURCE_SENT = sentOf(TRIGGER_ADAPTERS);
const START_RUN = closedWith(
  {
    kind: { const: "start_run" },
    agent_id: { type: "string", description: "The agent whose run each firing starts, an agentic agent or a workflow: capped either way." },
    input: { type: "object", description: "The run's input, as POST /agents/{agent_id}/runs takes it: `{content}`. Each run's content ends with a line naming the trigger and the time it fired for, in its zone." },
  },
  { effort: { $ref: "#/components/schemas/Effort" }, max_cost_usd: { type: "number", exclusiveMinimum: 0, description: "Each run's spend cap. Absent, the agent's default (its definition's `max_cost_usd`) as it stands when the firing starts; one of the two is required, so every run a trigger starts is capped: a target with neither is 422, and a firing that finds neither (the agent's default removed since) fails. The exception is a connected (native) agent, whose own CLI keeps its own limits: its target takes no max_cost_usd and no effort (422 not_allowed), and its runs start uncapped." } },
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
/** A firing's `by`, as `adapters` give it. */
/** A firing's `by`, as `adapters` give it: the clock's sources, then a run now, then the pushed ones, the order the
 *  document has always served. */
const firedByOf = (adapters: readonly TriggerAdapter[]) => ({ enum: [...adapters.filter((a) => a.delivery === "clock").map((a) => a.id), "manual", ...adapters.filter((a) => a.delivery === "push").map((a) => a.id)], description: adapters.flatMap((a) => (a.firedBy ? [a.firedBy] : [])).join(" ") });
const TRIGGER_FIRING = closedWith(
  {
    key: { type: "string", pattern: "^fir_[0-9a-f]{32}$", description: "The firing's key: from the trigger and its nominal time, or from the trigger and the Idempotency-Key of a run now. Its run is started under it, once." },
    by: firedByOf(TRIGGER_ADAPTERS),
    nominal_at: { ...DATE_TIME, description: "The time it fires for, to the second; a run now's is when it was asked." },
    status: { enum: [...FIRING_STATUSES], description: `\`due\`: recorded, its run not started yet (a full server, or a launch hook that did not answer, answered 5xx or 429, keeps it due, with \`retry_at\`). \`started\`: its run is \`run_id\`. \`sent\`: a message_run firing's message reached \`run_id\`; or, on a server with the launch hook (AGENTRUN_LAUNCH_HOOK_URL), the host took the firing and started no run for it here (a run it starts with \`trigger_firing\`, up to \`start_by\`, makes the firing \`started\`). \`skipped\`: the trigger's last run was still active (working, or waiting on a person), or an earlier firing was still due; \`reason\` says which. \`failed\`: the run was refused, or the launch hook did not take the firing (\`hook_failed\`, its answer or its retries run out), with \`error\`; a trigger.failed webhook message says so. \`missed\`: times not fired while the server was down or its timer late (older than the catch-up window, or before the one that caught up), \`count\` of them from \`nominal_at\` on.` },
    at: { ...DATE_TIME, description: "When it was recorded." },
    run_id: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
    error: { oneOf: [closed({ code: { type: "string" }, message: { type: "string" } }), { type: "null" }] },
  },
  { count: { type: "integer", minimum: 1, description: "On a `missed` firing: how many times it stands for, from `nominal_at` on; a cron line's are counted to 10000, and `reason` says \"or more\" past that." }, attempts: { type: "integer", minimum: 0 }, retry_at: { ...DATE_TIME, description: "On a `due` firing alone: when it is tried again." }, start_by: { ...DATE_TIME, description: "On a `sent` firing its launch hook's host took with no run: until when the host may still start that run with `trigger_firing`, 10 minutes after its 2xx (whenever the firing reached it: a catch-up, a firing that waited on `max_active_runs`, or one handed again after a restart). Not a retry: the server never hands the firing over again. Until then the firing holds its trigger's room as a run in progress: `max_active_runs` counts it, and the overlap check skips a later firing for it." }, catch_up: { const: true, description: "A time that fired late, within the trigger's catch-up window: the server was down, or its timer late." } },
);
const TRIGGER_FIELDS = closed({
  id: { type: "string" },
  name: { type: "string", maxLength: 200 },
  enabled: { type: "boolean" },
  source: TRIGGER_SOURCE_SENT,
  target: TRIGGER_TARGET,
  catchup_window_s: { type: "integer", minimum: 0, maximum: MAX_EVERY_S, description: `How late a missed time may still fire, once: of the times that came while the server was down (or its timer was late), the latest fires if it is this recent, under its own key, and the rest are one \`missed\` firing. 0: a missed time never fires. Default ${CATCHUP_WINDOW_S}.` },
  max_active_runs: { type: ["integer", "null"], minimum: 1, maximum: MAX_ACTIVE_RUNS, description: `For a \`start_run\` trigger of a pushed source (a webhook, with or without \`accept\`): each event starts its own run, never skipped behind the last, and this is the most of its runs active at once. A firing past it waits due and is tried again; past 20 due an event is 429 \`rate_limited\`. Null: a trigger with \`accept\` takes every run this server has room for, and one without keeps the overlap skip. A schedule or a \`message_run\` target is 422 with it set.` },
  failures_in_a_row: { type: "integer", minimum: 0, description: `Failed firings since the last that started a run; at ${FAILURES_TO_PAUSE} the trigger turns itself off (\`disabled\`). Turned on again, it counts from 0.` },
  disabled: { oneOf: [closed({ at: DATE_TIME, reason: { const: "auto_paused" } }), closed({ at: DATE_TIME, reason: { const: "source_unreadable" }, detail: { type: "string", description: "Why the source no longer reads." } }), closed({ at: DATE_TIME, reason: { const: "agent_archived" }, detail: { type: "string", description: "The agent it runs as, archived." } }), closed({ at: DATE_TIME, reason: { const: "connection_lost" }, detail: { type: "string", description: "Which connection went (GitHub disconnected here, or the App's installation deleted or suspended on GitHub)." } }), closed({ at: DATE_TIME, reason: { const: "sign_in_refused" }, detail: { type: "string", description: "What to fix: the account in Settings → Email." } }), { type: "null" }], description: `Why it is off, when the server turned it off: \`agent_archived\`, the agent it runs as was archived (turning it on is 409 agent_archived until the agent is unarchived); \`auto_paused\`, ${FAILURES_TO_PAUSE} failed firings in a row; \`connection_lost\`, the connection it needs went (GitHub disconnected here, or the App's installation deleted or suspended on GitHub); \`sign_in_refused\`, an email trigger's mail server refused the sign-in 3 times in a row (fix the account in Settings → Email, then turn it on); \`source_unreadable\`, its cron line or zone no longer reads here (a newer cron library or time zone data refuses it) or its every_s is out of range (a hand edit of its row), found at a start or when it came due, and only this trigger is turned off, or every feed a feed trigger reads has stopped (a 410, or a 404 three checks running, each), which turning it on again reads from the start (edit its urls first). Null once it is on again, which for \`source_unreadable\` takes a new source.` },
  next_at: { type: ["string", "null"], format: "date-time", description: "When it fires next; null while it is off." },
  last_run_id: { type: ["string", "null"], description: "The run its last firing that started one started; while that run is active (working, or waiting on a person), each firing is skipped, unless its firings each start their own run (a webhook with `accept`, or a pushed trigger with `max_active_runs`). Null until one starts." },
  created_at: DATE_TIME,
  updated_at: DATE_TIME,
  last_firing: { oneOf: [TRIGGER_FIRING, { type: "null" }] },
}, "A trigger. A firing while its last run is active (working, or waiting on a person) is skipped, and recorded as a skipped firing with why: never queued, since a firing queued behind a run parked on a person would wait as long as the person does. A webhook trigger with `accept` is the exception: each event it takes starts its own run.");
/** A trigger's view: its fields, all there, and `hook_url`, a pushed source's alone. */
const TRIGGER = { ...TRIGGER_FIELDS, properties: { ...TRIGGER_FIELDS.properties, last_check: { oneOf: [closed({ at: DATE_TIME, ok: { type: "boolean" }, message: { type: "string" } }), { type: "null" }], description: "A polled source's (an email's or a feed's) last check of its mailbox or its feeds: when, whether it read, and in words (\"Read INBOX: 2 messages new.\", \"Read 2 feeds: 1 new.\", or why not: a server that couldn't be reached is said here and tried at the next time). Null before its first; absent for any other source.", "x-agentrun-serve": "email/1" }, hook_url: { type: "string", description: "Where its sender posts, for a pushed source alone (absent for a schedule): a webhook's own hook, `/v2/hooks/{id}`, at this server's public URL (AGENTRUN_PUBLIC_URL) when it has one, else the path." } } };
const TRIGGER_WRITE = {
  name: { type: "string", minLength: 1, maxLength: 200, description: "Default the trigger's id." },
  enabled: { type: "boolean", default: true, description: "Off, it fires nothing; on again, it goes on from now: the time it was off is skipped, never caught up." },
  source: TRIGGER_SOURCE,
  target: TRIGGER_TARGET,
  catchup_window_s: { type: "integer", minimum: 0, maximum: MAX_EVERY_S, default: CATCHUP_WINDOW_S },
  max_active_runs: { type: ["integer", "null"], minimum: 1, maximum: MAX_ACTIVE_RUNS, description: `For a \`start_run\` trigger of a pushed source (a webhook, with or without \`accept\`): each event starts its own run, never skipped behind the last, and this is the most of its runs active at once. A firing past it waits due and is tried again; past 20 due an event is 429 \`rate_limited\`. Null: a trigger with \`accept\` takes every run this server has room for, and one without keeps the overlap skip. A schedule or a \`message_run\` target is 422 with it set. A PATCH with null clears it.` },
};
const TRIGGER_ID = { name: "trigger_id", in: "path", required: true, schema: { type: "string" } };
/** A webhook trigger's minted secret's metadata (secret-writes.ts SecretMeta, trigger-secrets-shown.ts): never its value. */
const TRIGGER_SECRET_META = { ...ref("schemas/SecretMeta"), description: "A webhook trigger's signing secret's metadata, named `trigger:<id>`: set, made by this server (source console), and when, where known (its create's and rotation's answers; a read says null). Never the value. Absent for a trigger that keeps none (a schedule's)." };
/** A trigger as GET and the list read it: with its minted secret's metadata, where it has one. */
const TRIGGER_READ = { ...TRIGGER, properties: { ...TRIGGER.properties, secret: TRIGGER_SECRET_META, note: { type: "string", description: "Present when its signing secret is kept but does not open under this server's seal key (sealed under another): why it reads as not set, and what to do (rotate it in the console). Until then each delivery is the one 401." } } };
/** A hook whose body did not arrive in time (push-handler.ts readCapped): answered, then its socket closed. */
const HOOK_TIMEOUT = { description: `\`request_timeout\`: the body did not arrive, whole, within ${HOOK_BODY_MS / 1000} s; the socket is closed after this answer.`, headers: { "X-Request-Id": ref("headers/RequestId") }, content: { "application/json": { schema: ref("schemas/Error") } } };
/** A verified request whose firing key was seen within its day, its firing no longer kept: nothing fired. */
const HOOK_DUPLICATE = closed({ ok: { const: "duplicate" } }, "A firing key seen within its day whose firing is no longer kept: nothing fired for it.");
/** A verified request its trigger's or its source's own filter (a webhook's accept) does not take: nothing fired. */
const HOOK_IGNORED = closed({ ok: { const: "ignored" } }, "Verified, and not an event the trigger's `accept` (or its source's own filter) takes: nothing fired.");
/** What a pushed request made: one firing for each event it held that a trigger takes, in order (a key seen within its
 *  day whose firing is no longer kept, `{ok: "duplicate"}`); none for a request with no event, or whose events no
 *  trigger takes. Its firings' `by` names the sources `adapters` give. */
const hookFiringsOf = (adapters: readonly TriggerAdapter[]) => closed({ firings: { type: "array", items: { oneOf: [{ ...TRIGGER_FIRING, properties: { ...TRIGGER_FIRING.properties, by: firedByOf(adapters) } }, HOOK_DUPLICATE] } } });
const TRIGGER_SECRET = { type: "string", pattern: "^whsec_[A-Za-z0-9+/]+={0,2}$", description: "A webhook trigger's signing secret, shown this once: `whsec_` and 32 random bytes in base64, as the Standard Webhooks spec gives it. Never in any GET; kept sealed under the seal key. Sign each request to /hooks/{trigger_id} with it." };
/** github/1: Connect GitHub, the server's one GitHub App (github-connection.ts). */
const GITHUB_MARK = { "x-agentrun-serve": "github/1" };
const GITHUB_CONNECTION = closed({ connected: { const: true }, app_id: { type: "string" }, slug: { type: "string", description: "The App's name on GitHub, as its URL has it." }, installations: { type: "array", items: closed({ id: { type: "integer" }, account: { type: "string", description: "The GitHub user or organization it is installed on." } }), description: "Where the App is installed, as its installation events and setup redirects say." } }, "The server's GitHub App: never a secret.");
/** GET /integrations/github: whether a GitHub App is connected, always a 200 (not connected is an answer, never a 404 a
 *  browser logs as an error), and the App when it is. */
const GITHUB_STATUS = { oneOf: [closed({ connected: { const: false } }, "No GitHub App is connected to this server: Connect GitHub in Settings."), GITHUB_CONNECTION] };

/** Suggested agents (suggestions.ts): their routes and answers. */
const SUGGESTIONS_MARK = { "x-agentrun-serve": "suggestions/1" };
const SUGGESTION_ID = { name: "suggestion_id", in: "path", required: true, schema: { type: "string", pattern: "^sg_[0-9a-f]{20}$" }, description: "A suggestion's id: the same repository and key always give the same one." };
const SUGGESTED_LINE = closed({ path: { type: "string", description: "From the repository's root." }, line: { type: "integer", minimum: 1 }, quote: { type: "string", description: "That line, as the scan read it." }, url: { type: "string", format: "uri", description: "The line on GitHub, at the commit the scan read." } });
const SUGGESTED_INPUT = closed({ name: { type: "string" }, type: { enum: ["string", "number", "integer", "boolean"] }, description: { type: "string" }, required: { type: "boolean" } });
const SUGGESTED_OUTPUT = closedWith({ name: { type: "string" }, type: { enum: ["string", "number", "integer", "boolean", "string_list"] }, description: { type: "string" } }, { enum: { type: "array", items: { type: "string" }, description: "The values a choice the app branches on takes." } });
const SUGGESTION = closed({
  id: { type: "string" },
  repo: { type: "string", description: "owner/name" },
  key: { type: "string", description: "The job's kebab-case name: the created agent's package name, its folder `.agentrun/agents/<key>` and its branch `agentrun/<key>`." },
  status: { enum: ["open", "created", "discarded"] },
  title: { type: "string" }, summary: { type: "string" }, why: { type: "string" }, impact: { enum: ["high", "medium", "low"] },
  evidence: { type: "array", items: SUGGESTED_LINE },
  agent: closedWith({ name: { type: "string" }, description: { type: "string" }, inputs: { type: "array", items: SUGGESTED_INPUT }, output: { type: "array", items: SUGGESTED_OUTPUT }, tools: { type: "array", items: { enum: ["web_search", "web_fetch"] } }, tier: { enum: ["fast", "balanced", "strong"] } }, { instructions: { type: "string", description: "The agent's instructions: on GET /suggestions/{suggestion_id} alone." } }),
  integration: closed({ language: { enum: ["typescript", "javascript", "python", "other"] }, path: { type: "string", description: "The client file the pull request adds." }, call_site: closed({ path: { type: "string" }, line: { type: "integer", minimum: 1 }, note: { type: "string" }, url: { type: "string", format: "uri" } }) }),
  scan: closed({ run_id: { type: "string" }, commit: { type: ["string", "null"] }, at: { type: "string", format: "date-time" } }),
  decided_at: { type: ["string", "null"], format: "date-time" },
  created: { oneOf: [{ type: "null" }, closed({ agent_id: { type: "string" }, template_id: { type: "string", description: "The imported template the agent was applied from: github:<owner>/<repo>/.agentrun/agents/<key>." }, branch: { type: ["string", "null"] }, pull_request: { oneOf: [{ type: "null" }, closed({ number: { type: "integer" }, url: { type: "string", format: "uri" } })] }, pull_error: { type: ["string", "null"], description: "Why the pull request was not opened though the agent was made: a create sent again opens it." } })] },
});
const SUGGESTION_READINESS = closed({
  ready: { type: "boolean", description: "Whether this server's GitHub App can open the pull request now, as GitHub says." },
  reason: { enum: [null, "not_connected", "not_installed", "github_failed", "permission_missing"] },
  message: { type: ["string", "null"] },
  missing: { type: "array", items: { type: "string" }, description: "The permissions the installation lacks, as `contents: write`." },
  install_url: { type: ["string", "null"], format: "uri", description: "Where the App is installed on more repositories." },
  permissions_url: { type: ["string", "null"], format: "uri", description: "The App's permissions page on GitHub, where its owner adds what is missing." },
  installation_url: { type: ["string", "null"], format: "uri", description: "The installation's page, where its account accepts new permissions." },
});
const SUGGESTION_WHOLE = { ...SUGGESTION, required: [...SUGGESTION.required, "files", "problems", "github"], properties: { ...SUGGESTION.properties, files: { type: "array", items: closed({ path: { type: "string" }, content: { type: "string" } }), description: "The files a create adds to the repository, rendered now." }, problems: { type: "array", items: { type: "string" }, description: "Why the package would not check (a create is refused); empty when it checks." }, github: SUGGESTION_READINESS } };
const SUGGESTIONS_LIST = closed({
  github: closed({ connected: { type: "boolean" }, app: { type: ["string", "null"] }, installations: { type: "array", items: closed({ account: { type: "string" } }) }, install_url: { type: ["string", "null"], format: "uri" } }),
  repositories: { type: "array", items: closed({
    repo: { type: "string" },
    scan: closed({ run_id: { type: "string" }, agent_id: { type: "string" }, started_at: { type: "string", format: "date-time" }, status: { enum: ["running", "waiting", "completed", "failed", "cancelled"], description: "`waiting`: the scan's run stopped without ending (at its cost cap or asking for input, `input_required`, or paused): it is resumed or cancelled on its run's page, and a new scan starts a new run." }, ended_at: { type: ["string", "null"], format: "date-time" }, app: { type: ["string", "null"], description: "What the scan says the app does." }, commit: { type: ["string", "null"] }, found: { type: ["integer", "null"] }, dropped: { type: "array", items: { type: "string" }, description: "Each suggestion of the answer that did not check, and why." }, already_decided: { type: "integer", description: "Suggestions of the answer left out because a person had decided them." }, error: { type: ["string", "null"] } }),
    counts: closed({ open: { type: "integer" }, created: { type: "integer" }, discarded: { type: "integer" } }),
  }) },
  suggestions: { type: "array", items: SUGGESTION },
});
/** templates/1: template packages, listed and applied (templates.ts; the format is templates/README.md). */
const TEMPLATE_MARK = { "x-agentrun-serve": "templates/1" };
/** template-computer/1: a package's computer preference list, and what this server would pick of it. */
const TEMPLATE_COMPUTER_MARK = { "x-agentrun-serve": "template-computer/1" };
const NULLABLE_STRING = { type: ["string", "null"] };
const TEMPLATE_ORIGIN_MARK = { "x-agentrun-serve": "template-import/1" };
const TEMPLATE = closed({
  id: { type: "string", description: "Its id here, the one apply and delete take: a bundled package's name (`kyb`), an imported one's source without its ref (`github:<owner>/<repo>[/<path>]`), or an uploaded one's `upload:<name>` (POST /templates/import with `files`), so a bundled package and an imported one of the same name are two packages.", ...TEMPLATE_ORIGIN_MARK },
  bundled: { type: "boolean", description: "True for a package this server ships; false for one imported (POST /templates/import).", ...TEMPLATE_ORIGIN_MARK },
  source: { type: ["string", "null"], description: "An imported package's source as it was given, normalized: `github:<owner>/<repo>[/<path>][@<ref>]`; an uploaded one's, its id (`upload:<name>`). Null for a bundled one.", ...TEMPLATE_ORIGIN_MARK },
  sha: { type: ["string", "null"], pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$", description: "The full commit SHA an imported package was read at: its ref resolved before anything was read. An uploaded package's is its sha256 (64 hex): over its files sorted by path, each `path NUL bytes NUL`. Null for a bundled one.", ...TEMPLATE_ORIGIN_MARK },
  publisher: { type: ["string", "null"], description: "The GitHub account an imported package comes from (its source's owner). Null for a bundled one and for an uploaded one (its owner sent it).", ...TEMPLATE_ORIGIN_MARK },
  name: { type: "string", description: "Its folder's name (agent.md's `name`)." },
  display_name: { type: ["string", "null"], description: "The agent's name, its `${parameters.<name>}` filled at apply; null: the package's name." },
  version: { type: "string", description: "SemVer." },
  description: { type: "string" },
  license: NULLABLE_STRING,
  author: { type: ["object", "null"], additionalProperties: false, required: ["name"], properties: { name: { type: "string" }, email: { type: "string" }, url: { type: "string" } }, description: "Who made the package; null when it names no one." },
  repository: NULLABLE_STRING,
  output: { type: ["object", "null"], additionalProperties: false, required: ["schema", "json_schema"], properties: { schema: { type: "string", description: "The schema's file in the package; it ships beside each SKILL.md." }, json_schema: { type: ["object", "null"], description: "The JSON Schema the agent's answer meets (its last fenced json block)." } }, description: "The shape of the agent's answer; null when the package names none." },
  harness: { type: ["array", "null"], items: { type: "string" }, description: "The harnesses it runs on, in the order it prefers them: apply takes the first this server runs. Null: any, the server's default." },
  model: {
    type: ["object", "null"], additionalProperties: false, required: ["tier"],
    properties: {
      tier: { enum: Object.keys(MODEL_TIERS) }, prefer: { type: "string" }, fast: { type: "string" }, strong: { type: "string" },
      choices: {
        type: "array", minItems: 1, maxItems: 3,
        items: closed({
          id: { type: "string", description: "What apply's `overrides.choice` names." },
          label: { type: "string", maxLength: 40, description: "Its name on the install form." },
          model: { type: "string", description: "The model the agent runs on, \"provider/model-id\"." },
          harness: { type: "string", description: "The harness it runs on, one of the package's `harness`." },
          warning: { type: ["string", "null"], maxLength: 300, description: "Shown word for word beside the choice on the install form, never reworded. Null: none." },
          note: { type: ["string", "null"], maxLength: 300, description: "A setup line shown beside the choice. Null: none." },
          secrets: { type: "array", items: { type: "string" }, description: "Keys only this choice needs, by variable name: apply with the choice refuses (409) when one is missing, as the package's `secrets`." },
        }),
        description: "Named models an owner may pick one of at install (apply's `overrides.choice`), each on its own harness. Apply runs the agent on exactly the choice's model and harness, or refuses (409) where this server can't run it: never the tier's model in its place. Absent: the package offers none.",
        "x-agentrun-serve": "template-model-choices/1",
      },
    },
    description: "The model it wants: `prefer`, which apply refuses (409) where this server can't run it, never taking the tier's model in its place (a server behind a gateway skips it, with a warning); with no `prefer`, this server's model for the tier (fast: AGENT_MODEL_FAST, balanced: AGENT_MODEL, strong: AGENT_MODEL_STRONG, each else the default); `fast` and `strong`, the models its subagents of those tiers prefer. `choices`, the models an owner may pick instead at install. Null: the server's default.",
  },
  effort: { type: ["string", "null"], description: "Its thinking level, the definition's `thinking`." },
  tools: { type: ["array", "null"], items: { type: "string" }, description: "The tools its agent is granted; null: those a new agent gets." },
  checkout: { enum: ["pull_request", "repository", null], description: "What the server checks out in each run's folder before its first turn, set as the agent definition's `checkout` at apply: `pull_request`, the pull request the run's GitHub event names, at its head, in `repo/`; `repository`, the head of the default branch of the repository the run names; each fetched with a read-only token the agent never holds. Null: none." },
  tool_policy: { type: ["object", "null"], additionalProperties: false, required: ["bash"], properties: { bash: BASH_POLICY }, description: "A policy by tool, bash's alone: apply writes it as the tool's policy in the agent's tool_settings, so the tool gate refuses any command it does not allow, whatever bash's permission. Null: none.", "x-agentrun-serve": "bash-policy/1" },
  computer: { type: ["array", "null"], items: { enum: [...COMPUTER_ENTRIES] }, description: "The computers it prefers, in order: `shell`, a computer that gives the agent a shell here (Docker's sandbox, or Archil's serverless exec on the runner in Mode 2); `none`, no shell. Apply takes the first this server meets now and writes it as the agent's `computer`; with `none`, the shell tools in `tools` are not granted, said in a `computer` warning. Null: where this server puts a new agent.", ...TEMPLATE_COMPUTER_MARK },
  needs: { ...NEEDS, type: ["array", "null"], description: "The programs its agent's sandbox must have on its PATH, or the libraries its code loads by their pip or npm names (`python-pptx`, `pptxgenjs`) (the manifest's `needs`, read only beside `computer: [shell]`). Apply writes them onto the sandbox it picks as the agent's `computer.needs`, which each run checks in its box before its first model request; where the shell here is no sandbox (Archil's serverless exec, or none), apply is refused (409) in words naming them and `AGENTRUN_DOCKER_IMAGE`. They name no image: a Docker box's is the server's `AGENTRUN_DOCKER_IMAGE`. Null: none.", "x-agentrun-serve": "template-needs/1" },
  computer_here: {
    type: ["object", "null"], additionalProperties: false, required: ["entry", "computer", "shell", "dropped", "note"],
    properties: {
      entry: { enum: [...COMPUTER_ENTRIES, null], description: "The entry an apply here would take now; null: none is met, and an apply is refused (409)." },
      computer: { type: ["object", "null"], additionalProperties: false, required: ["kind"], properties: { kind: { type: "string" }, provider: { type: "string" }, needs: { type: "array", items: { type: "string" }, description: "The package's `needs`, on the sandbox it would be saved with.", "x-agentrun-serve": "template-needs/1" } }, description: "The agent's `computer` it would be saved with." },
      shell: { type: ["string", "null"], description: "Its shell, in words; null: no shell." },
      dropped: { type: "array", items: { type: "string" }, description: "The shell tools in `tools` it would not grant: that computer does not run them." },
      note: { type: ["string", "null"], description: "What an apply here would say of it: the `computer` warning (a fallback, or a tool dropped), or the refusal." },
    },
    description: "What this server would pick of `computer` now: its readiness, read on each listing. Null: the package names no list.",
    ...TEMPLATE_COMPUTER_MARK,
  },
  category: { enum: [...CATEGORIES, null], description: "What it is for, for a list or marketplace page to file it under; display only. Null: none given." },
  tags: { type: "array", maxItems: 8, items: { type: "string", pattern: "^[a-z0-9-]{1,32}$" }, description: "Its tags, display only." },
  mcp: {
    type: "array",
    items: closed({
      source: { enum: [...MCP_SOURCES], description: "Where its tools come from: `composio` (a Composio toolkit, through Settings → MCP servers → Add from Composio), `github` (GitHub's MCP server) or `url` (any MCP server its owner marks with the toolkit)." },
      toolkit: { type: "string", description: "The toolkit its tools are: the package names them `mcp:<toolkit>/<tool>`, and apply maps it to a saved MCP server whose `source` and `toolkit` match, rewriting the name to `mcp:<server>/<tool>` in the agent it makes." },
      required: { type: "boolean" },
      reason: { type: ["string", "null"], description: "Why the agent needs these tools, one line, for the apply screen." },
      tools: { type: "array", items: closedWith({ name: { type: "string" }, tool: { type: "string", description: "Its name in the package, `mcp:<toolkit>/<tool>`: what apply's `grants` name." }, asks: { enum: ["allow", "ask"], description: "Every listed tool is one the package uses and asks the owner to grant (a consent screen shows each): only the owner's `grants` at apply grant it, with no permission written; one left out is not granted. `asks` says only how its calls run once granted: `allow`, a tool the package's manifest lists under `allow`, expected to run without asking (a read); `ask`, each call waits for the owner's OK (a write) unless the owner allowed it in tool settings or chose approvals `never`." } }, { pin: { type: "object", additionalProperties: { anyOf: [{ type: ["string", "number", "boolean", "null"] }, { type: "array", items: { type: ["string", "number", "boolean", "null"] } }, PIN_KEYS] }, description: "The arguments (each a value, a list one of which, or {keys: [...]}, the keys an object argument may hold) each call of the tool must carry, `${parameters.<name>}` unfilled: apply writes them, filled, as the tool's pin in the agent's tool_settings, so the tool gate refuses a call with any other (a send goes only to the destination the owner sets), and a call carrying an argument the tool's listing does not declare (an alias of a pinned one). A pin whose parameter apply is not given sets the tool to deny instead, with a `pins.<tool>` warning.", "x-agentrun-serve": "pins/1" } }) },
    }),
    description: "The MCP servers it uses, by source and toolkit, and the tools of each it may be granted: apply maps each to a saved server whose `source` and `toolkit` match (`servers` picks when several do) and grants there only those the apply's `grants` name, with no permission written (each call follows this server's tool settings: under approvals ask a write asks unless the owner allowed it there, and a read runs unasked only where the server's Allow reads is on); a tool left out of `grants` is not the agent's at all, whatever its approvals, and the owner can grant it later in the agent's tools. One no saved server matches is skipped with an `mcp.<toolkit>` warning saying how to set it up, or, `required`, refuses the apply (409, nothing made).",
  },
  parameters: { type: "object", description: "What apply takes in `parameters`, put where the package writes `${parameters.<name>}`: the package's `parameters`, compiled as `inputs` are, a closed JSON Schema object (no properties when it names none). Apply fills a blank one with its `default` and checks them as a run's input is checked." },
  input_schema: { type: ["object", "null"], description: "What each run of its agent takes as `input`: the package's `inputs`, compiled to the JSON Schema apply sets as the agent's `input_schema`. Null: the package names none, and a run takes `{content}`." },
  secrets: { type: "array", items: { type: "string" }, description: "The keys this server must have, by variable name (a saved key counts), before apply makes anything." },
  budget: { type: ["object", "null"], additionalProperties: false, required: ["per_run_usd"], properties: { per_run_usd: { type: "number" }, max_requests: { type: "integer", minimum: 1, "x-agentrun-serve": "maxrequests/1" } }, description: "Each run's limits: per_run_usd, its spend cap (the agent's max_cost_usd), required of a package with triggers; max_requests, when given, the most requests on free models it makes (the agent's max_requests), under the server's own limit." },
  learning: { oneOf: [{ type: "boolean" }, { type: "object" }], description: "The agent's `learning` as apply sets it, as an agent definition takes it: true, false, or the loop's settings (kyb's `{agree_on: [\"verdict.decision\"]}`: its check and audit compare two answers on the verdict's decision alone)." },
  approvals_default: { enum: ["ask", "never"], description: "What the package recommends for the agent's approvals: `ask`, the agent asks its person before a tool runs; `never`, it runs unattended (a template whose job runs on triggers). Deny settings and pins hold either way: a pinned write can only go where its pin says." },
  triggers: { type: "array", items: { type: "object" }, description: "The triggers apply makes on its agent: POST /triggers bodies with no agent_id, placeholders unfilled. A trigger's `enabled` may be `${parameters.<name>}`, a boolean parameter with a default: apply makes it on or off by that value." },
  skills: { type: "array", items: { type: "string" } },
  evals: { type: "array", items: { type: "string" }, description: `Its eval cases (evals/<case>/: prompt.md and graders of ${GRADER_TYPES.join(", ")}); none runs here.` },
});
/** One file of an uploaded package (POST /templates/import `files`), and of an exported one. */
const PACKAGE_FILE = closed({
  path: { type: "string", minLength: 1, description: "Its path in the package's folder, `/`-separated: no empty, `.` or `..` part, no leading `/`, no backslash or control character." },
  encoding: { enum: ["utf8", "base64"], description: "How `content` holds its bytes." },
  content: { type: "string", description: "Its bytes: the text itself (utf8), or base64." },
});
const TEMPLATE_IMPORT = {
  type: "object", additionalProperties: false,
  description: "`source` (a GitHub folder) or `files` (an upload): one of the two, never both (422).",
  properties: {
    source: { type: "string", minLength: 1, maxLength: 1024, description: "Where the package is: `github:<owner>/<repo>[/<path>][@<ref>]` (the ref, a branch, tag or commit, defaults to the default branch), or the folder's https://github.com/<owner>/<repo>/tree/<ref>/<path> URL. A public repository on github.com alone. Not with `files`; refused on a server that serves the API alone." },
    files: { type: "array", minItems: 1, maxItems: 256, items: PACKAGE_FILE, description: "The package itself, uploaded (`agentrun deploy`): each file of its folder. Checked as an import from GitHub is, with the same limits and words; its id is `upload:<name>` (agent.md's `name`), its `sha` the package's sha256, its publisher none: an upload asks no publisher's trust, as only this server's owner sends one. An upload of a name already uploaded replaces it. Not with `source` or `trust_publisher`.", "x-agentrun-serve": "template-upload/1" },
    dry_run: { type: "boolean", description: "True: read and check the package and answer it, storing nothing (the install preview). Absent or false: store it, listed by GET /templates." },
    trust_publisher: { type: "boolean", description: "The owner's \"I trust <publisher>\": needed (true) for the first import this server stores from a GitHub account, and remembered for that account. Never needed for a dry run." },
  },
};
/** A package whole: what it is, as GET /templates lists it, and every file it would hand the agent, in full. */
const TEMPLATE_WHOLE = {
  template: { ...TEMPLATE, description: "The package, as GET /templates lists it." },
  instructions: { type: "string", description: "The agent's instructions in full (agent.md's body), placeholders unfilled: what a third party's package would tell the agent." },
  skill_files: { type: "object", additionalProperties: { type: "string" }, description: "Every skill file the agent would be given, by path under its skills folder (`<skill>/SKILL.md`, the rules and the answer's schema beside each), in full." },
};
const TEMPLATE_READ = closed({
  ...TEMPLATE_WHOLE,
  console_url: { type: "string", format: "uri", description: "The package's apply page in the console." },
});
const TEMPLATE_IMPORTED = closed({
  ...TEMPLATE_WHOLE,
  publisher_trusted: { type: "boolean", description: "Whether this server's owner has said they trust the publisher (an earlier import with `trust_publisher`)." },
  stored: { type: "boolean", description: "True when the package was stored (listed by GET /templates); false for a dry run." },
  replaced: { type: ["string", "null"], pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$", description: "The SHA (an upload's sha256) of the package of the same id this import replaced (or, on a dry run, would replace); null when there was none." },
  console_url: { type: "string", format: "uri", description: "The console page to go on from: the package's apply page once stored; for a dry run, its install page, which shows it whole before it is stored (an upload's, the templates page)." },
});
const TEMPLATE_APPLY = {
  type: "object", additionalProperties: false,
  properties: {
    dry_run: { type: "boolean", description: "True: answer the apply's plan (200 `{plan}`) from the same reads and checks, writing nothing and keeping no Idempotency-Key record. Missing keys and MCP servers are listed in the plan where the apply would be 409; any other refusal is the apply's own.", "x-agentrun-serve": "template-plan/1" },
    parameters: { type: "object", description: "The package's parameters (GET /templates), by name, each of its type." },
    servers: { type: "object", additionalProperties: { type: "string" }, description: "The owner's pick of a saved MCP server, by the package's toolkit, where several saved servers match its source and toolkit; one that does not match is 422. Absent for a toolkit: its one match; where several match, the apply is 422 under `servers.<toolkit>`, naming them (a server is never picked for the owner)." },
    grants: { type: "array", items: { type: "string" }, description: "The owner's answer to the consent screen: the package's MCP tools, by the package's own names (`mcp:<toolkit>/<tool>`, GET /templates `mcp[].tools[].tool`; apply grants each as the tool of the server it maps the toolkit to), the agent is granted: the only MCP tools the agent gets. Any other is 422. A grant writes no permission: each call follows this server's tool settings, so under approvals `ask` a write asks the owner unless the owner allowed it there (PUT /settings/tools), and a read runs unasked only where the owner turned on Allow reads for its server; approvals `never` lifts those asks. One the owner denies on this server stays denied, with a warning; a deny set on this server, before or after the apply, still refuses the tool there, as a server deny is absolute (edit the agent's `definition.tools` to take a grant back). Absent, none: the agent gets no tool of the package's MCP servers." },
    agent_id: { type: "string", description: "An agent this package made here (GET /agents `template.id` is the package's id): the apply writes a new revision of it in place of making another, answered 200 with the same id. Its runs and its learning (corrections and workflows) stay. The parameters and grants are checked as a fresh apply checks them. Its triggers are reconciled by name: one of a name it has is changed in place (its id, a feed trigger's seen items, a webhook trigger's secret and whether it is on are kept; a `catchup_window_s` or `max_active_runs` the package leaves out goes back to its default, as a fresh apply makes it; a source the package leaves as it was is not rewritten, so a schedule keeps its next time, and an `every_s` one with no `start_at` the grid its first apply set), a new name is made, and one this package's apply made or kept that the package no longer lists is removed (a feed trigger whose feeds are left empty is not listed). Which triggers are the package's is kept on each trigger, never in an API body: one the owner made, one moved to the agent from another (or away and back), and one made before this was kept are never removed. A Composio trigger it removes (the package dropped it, or makes it again) goes at Composio first: one whose instance Composio does not delete is kept here as it was (on or off, the package's, its config sealed), and the next apply removes it; a dropped one is said in `warnings` under `triggers`, naming it and what is left at Composio. Such an unmarked trigger with a package trigger's name is adopted only when it can be changed in place (the same kind, and for a Composio trigger the same server, event and config), and is the package's from then on; one that would have to be made again, or one another package made, is 409 name_taken under `triggers.<i>.name` before anything is written: rename or delete it, then apply again. A trigger moved to another agent while the update runs is neither changed nor removed; its name is made anew. A Composio trigger it keeps keeps its sealed config when the package sends the same values; one whose server, event or config the package changes (another key too) is made again, as one whose source kind changed is: the old trigger and its Composio instance are removed first, and the new one is off where the owner turned the old one off. When Composio does not delete the old instance, the new one is not made, and the apply is 424 upstream_failed with the new revision standing and the old trigger kept as it was (remove the instance at Composio, or wait, and apply again: the old trigger's off carries to the new one). What the package owns and its new version leaves out (an input or answer schema, a checkout, a default cap, learning) is gone from the agent; what the host set (its harness, computer, sdk and native references) is kept. Updates of one agent run one after the other on a server, and each writes only onto the revision it read: one whose read went stale meanwhile (an edit, or an update elsewhere) is 412 precondition_failed, with nothing changed. An agent made otherwise, or from another package, is 422 under `agent_id`, saying which; an unknown id is 404; an archived agent is 409 agent_archived.", "x-agentrun-serve": "template-update/1" },
    overrides: { type: "object", additionalProperties: false, properties: { model: { type: "string", pattern: MODEL_REF.source, description: "The agent's model in place of the one the package's tier and preference pick, \"provider/model-id\". Not with `choice` (422)." }, choice: { type: "string", description: "One of the package's model choices (GET /templates `model.choices[].id`): the agent runs on its model and harness. An id the package does not offer is 422; `choice` with `model` is 422, as they say different things. The choice's `secrets` missing is 409 `agent_not_runnable`, as the package's are; a model this server can't run on that harness (not in its catalog, no key for it, or behind a gateway that never said it serves it) is 409 naming the model, never a fallback.", "x-agentrun-serve": "template-model-choices/1" }, approvals: { enum: ["ask", "never"], description: "The agent's approvals (its definition's): never runs it unattended (each tool that would ask allowed, a deny still refusing), ask makes it ask. Absent: the package's `approvals_default` (`ask` only when it names none).", "x-agentrun-serve": "unattended/1" } } },
    revision: { type: "string", description: "With `agent_id`: the agent's revision as you read it (GET /agents/{agent_id} `revision`, or a plan's `current_revision_id`). The apply, or its plan, writes only while it is the agent's current one: another is 412 precondition_failed, nothing changed. Without `agent_id` it is 422.", "x-agentrun-serve": "template-plan/1" },
    sha: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$", description: "The package's sha as you read it (GET /templates `sha`, or an import's answer): the apply, or its plan, is 412 precondition_failed when the package stored under this id is another (an upload of the same name replaced it), nothing changed.", "x-agentrun-serve": "template-plan/1" },
  },
};
/** POST /templates/{template}/apply with dry_run's answer: what the apply would do, nothing written. */
const TEMPLATE_PLAN = closed({
  plan: closed({
    action: { enum: ["create", "revise"], description: "`create`: the apply makes a new agent; `revise`: it writes a new revision of the agent `agent_id` names." },
    agent_id: { ...NULLABLE_STRING, description: "The agent a revise writes onto; null for a create." },
    current_revision_id: { ...NULLABLE_STRING, description: "That agent's current revision as the plan read it; null for a create." },
    twins: { type: "array", items: { type: "string" }, description: "For a create: the live agents here this template already made with these parameters, by id. The apply still makes another, and its `agent_id` warning (`duplicate`) names each; an apply with `agent_id` updates one instead. Empty for a revise." },
    missing_secrets: { type: "array", items: { type: "string" }, description: "The keys the package (and the model choice asked for) names that this server does not hold, and MONID_API_KEY where a monid tool it grants is pinned when the agent is saved and no monid key is here: the apply refuses until each is added." },
    unmatched_mcp: { type: "array", items: closed({ source: { type: "string" }, toolkit: { type: "string" }, required: { type: "boolean", description: "True: the apply refuses (409) until a server of it is saved; false: the agent is made without its tools." } }), description: "The package's MCP needs no saved server here matches." },
    triggers: {
      type: "array",
      description: "What becomes of each trigger, the package's first in its order, then the agent's this package made that it no longer lists.",
      items: closedWith({
        name: { type: "string" },
        kind: { type: "string", description: "Its source's kind." },
        action: { enum: ["create", "update", "remove", "skip"], description: "`create`: made (or made again: `reason` says why); `update`: changed in place; `remove`: removed; `skip`: not made (`code` and `reason` say why)." },
      }, {
        code: { enum: ["not_set_up_here", "not_an_option"], description: "A skip's: `not_set_up_here` for a trigger this server makes once it is set up (a connection it lacks, a feed left empty, an API-only server's launch hook), so a later apply makes it; `not_an_option` for one it never makes (a trigger kind an API-only server serves no route for). The apply's warning for that trigger has the same `reason`." },
        reason: { type: "string" },
      }),
    },
    computer: { anyOf: [closed({ kind: { type: "string" }, provider: NULLABLE_STRING }), { type: "null" }], description: "The computer the apply picks from the package's list; null when the package names none." },
  }),
});
const TEMPLATE_APPLIED = closedWith({
  template: { type: "string" },
  version: { type: "string" },
  agent_id: { type: "string", description: "The agent made, or the one updated (GET /agents/{agent_id})." },
  revision_id: { type: ["string", "null"], description: "The id of the agent's revision `revision_version` numbers (GET /agents/{agent_id} `revision` once nothing else has written one): the one this apply wrote, or the current one it kept.", "x-agentrun-serve": "template-plan/1" },
  revision_version: { type: "integer", minimum: 1, description: "The number of the agent's revision this apply wrote, its current one now (its `definition.version`): 1 for an agent it made; on an update with agent_id, the new revision's; on one that changed nothing (`agent_change` unchanged), the current revision it kept." },
  agent_change: { enum: ["made", "updated", "unchanged"], description: "What the apply did to the agent: `made` it (201); `updated` it, a new revision written (an update with agent_id); or left it `unchanged`: an update whose package and parameters its current revision already holds writes no revision, and `revision_version` is that current one. Its triggers are reconciled either way (`triggers`)." },  servers: { type: "object", additionalProperties: { type: ["string", "null"] }, description: "The saved MCP server each of the package's toolkits runs on, by toolkit; null: none here matches it (said under `mcp.<toolkit>`)." },
  triggers: {
    type: "array",
    description: "Its triggers, in the package's order, each as the apply left it (GET /triggers/{trigger_id}): every one it made or kept, of any kind. A trigger the apply skipped (said in `warnings`) is not here, so a package trigger is found by its `name`, never by its index in the package.",
    items: closed({
      trigger_id: { type: "string" },
      name: { type: "string", description: "Its name: the package's name for it." },
      kind: { enum: [...SOURCE_KINDS], description: "Its source's kind (GET /triggers/{trigger_id} `source.kind`)." },
      enabled: { type: "boolean", description: "Whether it is on: made off where the package says so, or where the owner turned off the one it replaced; one changed in place keeps the owner's on or off." },
    }),
    "x-agentrun-serve": "template-triggers/1",
  },
  warnings: { type: "array", items: ref("schemas/InputIssue"), description: "What this host still lacks for the agent to run, as POST /agents answers it; a webhook trigger the apply made adds a warning pointing to the console for its signing secret, never the secret itself (the first answer to the owner's signed-in session shows it once, under `webhook_secrets`)." },
}, {
  webhook_secrets: {
    type: "array",
    description: "Each webhook trigger it made, in `triggers`' order; absent when it made none. Each carries its secret's metadata (`secret`) and, in the first answer to the owner's signed-in session alone, its `signing_secret`, shown this once as POST /triggers shows it; to the API token, or on a replay under the same Idempotency-Key, `secret_set` and `note` in its place.",
    items: closedWith({ trigger_id: { type: "string" }, secret: { ...ref("schemas/SecretMeta"), description: "Its signing secret's metadata, named `trigger:<id>`. Never the value." } }, {
      signing_secret: { type: "string", pattern: "^whsec_[A-Za-z0-9+/]+={0,2}$", description: "Its signing secret, shown this once: in the apply's first answer to the owner's signed-in session alone." },
      secret_set: { const: true },
      note: { type: "string", description: "In place of the secret: to the API token, the words that send the person to the console to rotate it there; on a replay, that it was shown once." },
    }),
  },
});
const TRIGGER_ERRORS = "The triggers are rows in the server's store, read as they are now. A store busy with another write answers 409 home_busy, retryable: send it again.";
/** A run's grade (learn/promote.ts gradeView): what PUT /runs/{run_id}/grade answers (GRADE, with `expected`) and GET
 *  /runs/{run_id}/learning reads back (`graded`, never `expected`). */
const GRADE_FIELDS = {
  run_id: { type: "string" },
  correct: { type: "boolean", description: "Whether the run's answer was right." },
  source: { enum: [...GRADE_SOURCES], description: "Who graded it: `feedback`, a person; `eval`, an eval's label." },
  graded_at: DATE_TIME,
  path: { enum: [...RUN_PATHS], description: "The path the run took, read from its record when it was graded." },
  workflow: { ...NULL_STRING, description: "The learned workflow that served it, when one did." },
  workflow_digest: { ...NULL_STRING, description: "That workflow's digest (the first 16 hex of its workflow.json's sha256), when it was served first." },
  feedback: { enum: [...FEEDBACK_ROUNDS, null], description: "What the grade asked of the run's learning, a round the run opened again on (no turn of the job's: its end-of-run step alone, learning spend): `correction`, a run the agent finished graded with a `label`, whose words are appended to its agent's corrections.md as one line. null: nothing more (a grade of a run its learned workflow answered alone, right or wrong, is kept and costs $0: the workflow's graded hold reads it), or a run that does not learn or that can't be opened again. Kept with the grade once the round opened, so a later read still says it." },
};
const RUN_LEARNING = {
  oneOf: [
    closedWith({
      run: { type: "string" }, state: { enum: [...LEARNING_STATES] }, reason: LEARNING_REASON,
      detail: { ...NULL_STRING, maxLength: 300, description: "Run.learning's detail, the same words: at most 300 characters, cut of the host's secrets as they are now before it is cut short." }, at: { type: "string", format: "date-time" },
      seed: { ...NULL_STRING, description: "The commit of main the run started from; null when its seed failed." },
      merged: { ...NULL_STRING, description: "Its merge commit on main, once merged." },
      workflows: { type: "array", items: MERGED_WORKFLOW, description: "The workflow draft its merge wrote, `pending` while it waits for the owner's OK; empty when none." },
      corrections: { ...COUNT, description: "How many lines of its owner's words its merge added to corrections.md: 1 when a correction was kept, else 0." },
      problems: { type: "array", items: PROBLEM, description: "The checker's, when the reason is `checker`; on a merge, what the checks refused of a part that was not kept (an owner's correction past the cap, say) while the rest merged." },
      compiled: { oneOf: [closed({
        workflow: { type: "string", description: "The learned workflow the compile turn wrote: the agent's whole job, or a revision of the one it has." },
        attempts: { type: "array", items: closed({ ok: { type: "boolean" }, errors: { type: "array", items: { type: "string" }, description: "What the static checks and the dry run refused of this attempt, sent back to the model for the next one." } }), description: "Each attempt in order: the first, then a retry for each refusal, at most 4." },
        digest: { type: ["string", "null"], description: "The kept draft's digest (the first 16 hex of its workflow.json's sha256): what a run serving it records as `workflow_digest`, and its promotion records' `digest`; null when no attempt passed." },
        promoted: { type: ["boolean", "null"], description: "Whether the kept draft serves the agent's runs, from its promotion records (GET /agents/{agent_id}/learning/promotions): true once promoted, false while held, null while it is checked, before its first claim decides it, or when no attempt passed." },
      }), { type: "null" }], description: "The run's compile turn, when its end-of-run step wrote the agent's job as a learned workflow (the agent has its `compile_after` completed runs and no learned workflow yet, or its workflow's promotion held it, once per hold); null when the run compiled nothing." },
      draft_errors: { type: "array", items: { type: "string" }, description: "What the checks refused of a compiled draft that never passed after its retries, cut of the host's secrets; empty when none." },
      used: closed({
        workflows: { type: "array", items: closed({ name: { type: "string" }, calls: COUNT, failed: COUNT }), description: "Each learned workflow the run's job called (`learned_workflow`), by the name its calls gave: how many calls, and how many of them failed. A name holding one of the host's secrets reads `[redacted]`." },
      }, "What the run's job did with the learned workflows it was offered, apart from `workflows`, the one it learned."),
    }, {
      graded: { ...closedWith({ ...GRADE_FIELDS, feedback_status: { enum: [...FEEDBACK_STATUSES, null], description: "How the round the grade opened (`feedback`) stands, read from its run's journal and its steer's row (no clock compared): `running` until it settles; `ended`, its run took the grade's words and ended after them; `not_run`, its run ended before it took them (its claim refused, say), so the round never ran: grade it again to ask once more. null for a grade that opened none." } }, {}), description: "The run's grade (PUT /runs/{run_id}/grade), as its agent keeps it and the PUT answered it, never its `expected`: the newest, since a later grade replaces it, and how the round it opened stands. Absent when it has none kept." },
    }),
    { type: "null" },
  ],
  description: "The run's learning whole. Null for a run that does not learn.",
};
const LEARNING_DIFF = closed({
  base: { ...NULL_STRING, description: "A merged run's merge's parent; else the commit the run started from (its seed)." },
  head: { ...NULL_STRING, description: "A merged run's merge commit; null when it merged nothing." },
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
}, "What the run merged: its merge commit against its parent; a run that merged nothing, no file, against its seed.");
const AGENT_ID = ref("parameters/AgentId");
const FILE_PARAM = { name: "file", in: "path", required: true, description: "A file of the agent's learning folder, its slashes percent-encoded (`workflows%2F<name>%2FREADME.md`): on a read, a draft's `workflows/<name>/workflow.json` or `README.md`; on an approval, a retire or a restore, a draft's README.md. Any other name is 400, corrections.md included: it is read and written on `/agents/{agent_id}/learning/corrections`; a path with a bare `/` is no route (404).", schema: { type: "string" } };
const ETAG = { ETag: { description: "The file's version on main: its git blob id, quoted. If-Match on a write takes it.", schema: { type: "string" } }, "X-Content-Type-Options": ref("headers/NoSniff") };
const FILE_TEXT = (description: string, json = false) => ({ description, headers: ETAG, content: { "text/markdown": { schema: { type: "string" } }, ...(json ? { "application/json": { schema: {}, description: "A draft's workflow.json, as it is on main." } } : {}) } });
const PRECONDITION_REQUIRED = { description: "`precondition_required`: the write names no version it read: If-Match with the file's ETag. If-Match: * is not one.", content: { "application/json": { schema: ref("schemas/Error") } } };
const IF_MATCH = { name: "If-Match", in: "header", required: false, description: "The file's ETag, as a GET answered it: the write lands only on that version, else 412.", schema: { type: "string" } };
const WRITE_ERRORS = { ...errors(400, 401, 403, 404, 409, 412, 429, 500), "428": PRECONDITION_REQUIRED };
/** Why every learning route of an agent may answer 403: what it learned is cut of the agent's own sign-in pointers, and
 *  withheld when one of them can't be read here. */
const SIGN_IN_WITHHELD = "Every text is cut of the agent's own browser sign-in pointers too, live or forgotten, and a write holding one is refused as one holding a host secret; when one of them does not open on this server (its seal key changed or is missing, or the sign-in is damaged), every learning route of the agent answers 403 `forbidden`, so nothing is shown over a shorter list.";
const WRITE_DESCRIPTION = "As a person: one host commit on main in the agent's queue, `learning: <approved|retired|restored> by a person: <file>` with a `Changed-By: user` trailer. Answers the file as it now is, with its new ETag. An archived agent's learning is written as its definition is. " + SIGN_IN_WITHHELD;
/** GET /agents/{agent_id}/learning/cost (learning-cost.ts, store-reads/learning.ts agentCostOverStore). */
const COST_USD = (description: string) => ({ type: ["number", "null"], minimum: 0, description: `${description} As booked (its float noise rounded off at 1e-12, the precision of a run's own cost): a decision's sub-micro-dollar cost is in it; null when unknown, never 0 for unknown.` });
const COST_MEAN = (description: string) => ({ oneOf: [closed({ runs: { ...COUNT, minimum: 1, description: "How many runs the mean is over." }, mean_usd: { type: "number", minimum: 0, description: "Their mean, rounded to 1e-6." } }), { type: "null" }], description });
const COST_RUN = closed({
  n: { type: ["integer", "null"], minimum: 1, description: "The run's place among the agent's runs that do a job (`agent`, `workflow` and `handed_back`), oldest first, as `bill.points` number them: 1 is its first. Null for a `replay`: it checks a revision and does no job." },
  run_id: { type: "string" },
  started_at: DATE_TIME,
  path: { enum: [...RUN_PATHS], description: "The path the run took: `workflow`, a learned workflow finished it alone (its job's only tool calls were learned_workflow calls, each answering, and nothing was said after its first message, so it was not asked to look back); `handed_back`, a learned workflow ran and the agent went on (it failed or escalated, or the agent worked on after it); `agent`, no learned workflow ran; `replay`, a replay run: a learned workflow's new revision run alone on one of the agent's graded inputs, at workflow cost, to decide whether it serves first (its cost is learning's, shown as its own run); `audit`, never a row here: a shadow run auditing a served run is no run of the series, its cost that run's `learning_usd`." },
  workflow: { ...NULL_STRING, description: "The learned workflow the job called last, by name; null when it called none." },
  digest: { ...NULL_STRING, description: "The learned workflow revision that ran it, as its run record names it (the bill's `revisions[].digest`): the first 16 hex characters of its workflow.json's sha256, one value for as long as one revision serves. Null when no learned workflow ran." },
  took_over: { type: "boolean", description: "The first run its revision (`workflow` at `digest`) served (`path` `workflow` or `handed_back`), over every run of the series, `limit` aside: where that revision took over, the run its promotion record (GET .../learning/promotions) first bore on. The first such run is `summary.takeover` (a learned workflow that ran first always names its revision). False for a `replay` and for a run no revision ran (`digest` null)." },
  audited: { type: "boolean", description: "An audit's shadow run was started for it (the agent definition's `learning.audit_every`): the shadow's cost is in `learning_usd`, and its verdict is a row of GET /agents/{agent_id}/learning/audits once scored, at a later run's start." },
  cost_usd: COST_USD("The job's own cost: what the run had cost when its answer was final, before its compile turn; for a run that was asked none, its whole cost."),
  cost_upper_bound: { type: "boolean", description: "The run's stored cost is only a bound (its row's `costAtMostUsd`: a model request cut at its cap hold): `cost_usd` and `total_usd` are null, never a known cost. `summary` counts such a run as `at_most`, not `unknown`." },
  learning_usd: COST_USD("What learning cost for the run: its compile turn. 0 for a run that does not learn or was not asked one. An audit's shadow run of it is its learning too: null while that shadow is queued or running, never $0."),
  total_usd: COST_USD("The run's all-in cost, `cost_usd` and `learning_usd` together; null when either is."),
});
const LEARNING_COST = closed({
  agent: { type: "string" },
  runs: { type: "array", items: COST_RUN, description: "The agent's agentic runs that ended (completed, stopped or failed), oldest first: the last `limit` of them, each keeping its number (a replay has none). A run still at work, an imported or archived run, a workflow revision's run and a run whose path is not known (`unknown_path_runs`) are left out; a run's grade is no run here, and its cost is that run's `learning_usd`." },
  total_runs: { ...COUNT, description: "How many runs the series counts in all, `limit` aside." },
  unknown_cost_runs: { ...COUNT, description: "How many of them have no known all-in cost (`total_usd` null)." },
  unknown_path_runs: { ...COUNT, description: "How many runs that learn ended with no path on their record (their end could not read their cost and path in time, or no runner wrote their end): left out of `runs`, `total_runs` and `summary`, never counted as `agent` runs at $0." },
  workflows: { type: "array", items: closed({
    workflow: { type: "string", description: "The learned workflow, by name." },
    digest: { type: "string", description: "The version of it its newest run served first ran: the first 16 hex characters of its workflow.json's sha256. A new version starts its count from zero." },
    state: { enum: ["serving", "needs_revision"], description: `\`serving\`: it runs first on every run it fits. \`needs_revision\`: over its newest ${COST_WINDOW} priced runs served at this version, its mean all-in cost (\`served\`) is at or over the agent's cost by hand (\`by_hand\`), so it no longer runs first: the agent takes each run it would have served, and the stop asks for no new version. A new version (a new digest) runs first again.` },
    served: COST_MEAN(`The mean all-in cost (\`total_usd\`: the run's own cost, the workflow's nodes and, after a handback, the agent's work, with every learning round booked for it) of its newest ${COST_WINDOW} runs served first at this version whose all-in cost is known (a window, never how many runs it served: \`runs\` stops at ${COST_WINDOW}); null when none is.`),
    by_hand: COST_MEAN("The agent's cost by hand: the mean all-in cost (`total_usd`) of its runs on the `agent` path whose all-in cost is known or, with none, of its runs before the workflow first ran; null when there are none: the workflow then keeps serving."),
    unknown_cost_runs: { ...COUNT, description: "How many runs `served` and `by_hand` would have read have no known all-in cost: left out of their means, never read as 0." },
  }), description: "Each learned workflow that has run first on one of these runs, at its newest version, and where it stands against the money rule: it runs first while its cost a run stays under the agent's by hand. It does not catch a workflow that answers wrong with confidence." },
  summary: closed({
    takeover: { oneOf: [closed({ n: { type: "integer", minimum: 1 }, run_id: { type: "string" } }), { type: "null" }], description: "The first run a learned workflow served (`path` `workflow` or `handed_back`), numbered as `runs` number it. Null before one." },
    before: COST_MEAN("The mean of the job's own cost (`cost_usd`, learning left out) over the `agent` runs before the takeover (all of them when there is none yet) whose cost is known exactly (never `cost_upper_bound`); null when there is none."),
    after: COST_MEAN("The mean all-in cost (`total_usd`, learning included) of the runs a learned workflow served from the takeover on (`path` `workflow` or `handed_back`; never a `replay`, which checks a revision and serves no one, nor an `agent` run) whose total is known exactly (never `cost_upper_bound`); null when there is none, and `after_state` says why."),
    after_state: { enum: [...AFTER_STATES], description: "Why `after` is what it is: `priced`, it is the mean of the served runs whose cost is known; `no_served_runs`, no learned workflow has taken over yet (replays are not served runs), so there is no after side; `cost_unknown`, runs were served but no served run's all-in cost is known exactly. A reader says these in words, never as a figure." },
    times_cheaper: { type: ["number", "null"], minimum: 0, description: `\`before\` over \`after\`, to a tenth, once \`after\` counts ${CHEAPER_AFTER_RUNS} runs or more and \`withheld\` is null; else null. Learning is left out of the before side and kept in the after side, so it never flatters learning.` },
    hand_backs: { oneOf: [closed({ ran: COUNT, back: COUNT }), { type: "null" }], description: "Of the runs a learned workflow ran first on from the takeover on (`path` `workflow` or `handed_back`), how many (`ran`) and how many it handed back to the agent (`back`); null before a takeover." },
    withheld: { oneOf: [closed({ unknown: { ...COUNT, description: "Runs whose cost is unknown." }, at_most: { ...COUNT, description: "Runs whose cost is known only as at most (`cost_upper_bound`)." } }), { type: "null" }], description: "After a takeover, the runs `before` and `after` would read whose cost is not known exactly: while any is, `times_cheaper` is null, so the ratio is never over a partial set. Null when every one is known, and before a takeover." },
    replay: { oneOf: [closed({
      n: { ...COUNT, description: "The inputs its check ran on." },
      workflow_pct: { type: "number", minimum: 0, maximum: 100, description: "The share of them it answered alone with the agent's own recorded answer, in percent to a tenth." },
      agent_pct: { type: "number", minimum: 0, maximum: 100, description: "The agent's accuracy on them, in percent: 100, its own answers being the label." },
      cleared: { type: "boolean", description: "The check passed: a serving champion was promoted on it." },
      agreed: { ...COUNT, description: "Of the inputs it answered alone (`alone`), how many said what the agent's own recorded answer said." },
      alone: { ...COUNT, description: "The inputs it answered alone (no hand-back, no failed step)." },
      agree_min: { type: "number", minimum: 0, maximum: 1, description: "The agreement bar it passed (the definition's `learning.agree_min`): `agreed` over `alone` at least this. Passing it says the workflow agreed with the agent that often, never that it is as accurate." },
    }), { type: "null" }], description: "The check the serving promotion was decided on: the current champion of the learned workflow the newest served run ran. Null when none serves." },
  }, "What the series shows, over every run it counts, `limit` aside."),
  bill: closed({
    learning_usd: { type: "number", minimum: 0, description: "What learning cost in all: `booked_usd` less every priced job's own cost (`cost_usd`): compile turns, audit shadow runs and replay runs. As booked (float noise rounded off at 1e-12)." },
    points: { type: "array", items: closed({
      n: { type: "integer", minimum: 1, description: "The run's place among the agent's runs that do a job (`agent`, `workflow` and `handed_back`), oldest first: a `replay` checks a revision and a shadow audits a run, so neither is on the index." },
      run_id: { type: "string" },
      actual_usd: { type: "number", minimum: 0, description: "Booked to this run, every run before it included: each run all in (`total_usd`: its own cost, its compile turn and its audit shadow), and each replay run's cost at the run that does a job it followed. As booked (float noise rounded off at 1e-12)." },
      agent_usd: { type: ["number", "null"], minimum: 0, description: "The agent for all of it: `summary.before`'s mean times the runs shown to here. Null with no `before`." },
    }), description: "One a run that does a job whose all-in cost is known exactly, every one: a run whose cost is unknown or only a bound is on neither line and counted in `withheld` (its number skipped)." },
    break_even: { oneOf: [closed({ n: { type: "integer", minimum: 1 }, run_id: { type: "string" } }), { type: "null" }], description: "The first run from `summary.takeover` on after which `actual_usd` is never again over `agent_usd`, `booked_usd` against the line at the last point included: learning has paid for itself there. Null while it has not (`gap_usd` says by how much), and before a run on a served path." },
    gap_usd: { type: ["number", "null"], description: "While `break_even` is null: `booked_usd` less `agent_usd` at the last point (over 0: the bill is that much over the agent for all of it), spend booked after that point included. Null with a break-even, with no `summary.before` or no run." },
    withheld: { ...COUNT, description: "Runs (replays included) whose cost is unknown or only a bound: on neither line." },
    booked_usd: { type: "number", minimum: 0, description: "The booked total: every priced run's cost (0 with none). Spend with no point to join (a replay after a run of unknown cost) is carried to the next point's `actual_usd`, and is in this when no point follows (or when there is no point at all: replays whose job runs were archived). With every run's GET /runs/{id} `cost.all_in_usd`, the sum of those and `unattributed_usd` is this." },
    revisions: { type: "array", items: closed({
      workflow: { type: "string", description: "The learned workflow, by name." },
      digest: { type: "string", description: "The revision: the first 16 hex characters of its workflow.json's sha256." },
      compile_usd: COST_USD("What the compile turns that drafted it cost: each ran at the end of a run, in its session, and is that run's learning spend no more, but this revision's. A recompile's turn is its recompiled revision's. 0 when none on record drafted it."),
      check_usd: COST_USD("What its check cost: its replay runs (the first draft's check or the one recompile's, each revision its own)."),
      spend_usd: COST_USD("Its learning spend: `compile_usd` and `check_usd` together."),
      k: { type: "integer", minimum: 1, description: "The served runs its spend is spread over: its check's `compile_after`." },
      served: { ...COUNT, description: "How many runs it has served (`workflow` or `handed_back` at this digest), every one: its first `k` carry its spend." },
      attributed_usd: COST_USD("What they carry: spend over k each in whole micro-dollars (a micro-dollar more on the first ones, and the sub-micro-dollar rest on the k-th, so the split is exact), on their GET /runs/{id} `cost.learning_usd`."),
      unattributed_usd: COST_USD("The rest: on no run until it serves `k` runs; for a `stopped` revision, on none ever."),
      state: { enum: ["checking", "serving", "stopped"], description: "`checking`: its check is at work; `serving`: it is its workflow's champion; `stopped`: held or replaced, so nothing more will carry it." },
    }), description: "Each revision of the agent's learned workflows its promotion records name, in the order first recorded, and how its learning spend is passed on to the runs it serves." },
    unattributed_usd: COST_USD("What no run carries: `booked_usd` less every run's GET /runs/{id} `cost.all_in_usd`. A revision's spend its served runs have not carried yet (each revision's `unattributed_usd`), a compile whose drafts all failed its checks or that the spend cap stopped (it drafted no revision to serve), and the spend of a revision whose promotion records aged out of the kept history land here, never nowhere. Null while any run's cost or learning is unknown, or a run is `withheld`."),
    holds: { type: "array", items: closed({
      n: { type: ["integer", "null"], minimum: 1, description: "The first run that does a job started at or after the hold, by its place on the bill's index (as `points` number them), placed by the server over every run, `limit` aside. Null when none has started since." },
      at: DATE_TIME,
      workflow: { type: "string", description: "The learned workflow held, by name." },
      by: { enum: ["audit", "check", "dsl"], description: "What held it: `audit`, its audits disagreed past the hold bar; `check`, a new revision's check held it (its draft failed its checks, or its replays fell short); `dsl`, this release's workflow DSL refused the serving revision (a hold with neither `audit` nor `check`, its `reason` the DSL's)." },
      reason: { type: "string", description: "The hold record's reason, in the server's words." },
    }), description: "Each hold the agent's promotion records keep, oldest first, at the run it bore on." },
  }, "The owner's bill, booked dollars only (each request at the price it was billed, cached tokens at their cached price), over every run, `limit` aside: the cumulative cost run after run against the agent doing all of it, and where learning pays for itself."),
});

/** PUT /runs/{run_id}/grade and GET /agents/{agent_id}/learning/promotions (learn/promote.ts, runner/promotion.ts). */
const GRADE = closedWith(GRADE_FIELDS, { expected: { type: "object", description: "The fields a right answer's JSON holds, when the grade gave them." } });
const REPLAY_SCORE = {
  n: { ...COUNT, description: "The inputs it was decided on (a replay stopped at a write is none)." },
  agree: { ...COUNT, description: "How many of them the workflow answered alone with the agent's own recorded answer." },
  agent_acc: { type: "number", minimum: 0, maximum: 1, description: "The agent's accuracy on them: 1, the agent's own recorded answers being the label." },
  wf_acc: { type: "number", minimum: 0, maximum: 1, description: "The workflow's accuracy on them: the share it answered alone as the agent did, plus the ones it handed back (a hand-back is the agent's answer), over `n`." },
  delta: { type: "number", description: "`wf_acc` - `agent_acc`." },
  handed_back: { ...COUNT, description: "How many of them it handed back; it answered `n` - `handed_back` alone." },
};
/** A replay's runs' outcomes, the one count of them: on its promotion record (`replay.outcomes`) and its read. */
const SKIPPED_TOOLS = { type: "array", items: closed({ tool: { type: "string", description: "The tool's catalog name." }, inputs: { ...COUNT, description: "How many skipped inputs it stopped." }, no_read_only_hint: { type: "boolean", description: "An MCP tool its server lists with no `readOnlyHint` (and not `destructiveHint`): replay treats it as a write only because nothing says it reads. The hold's `reason` names these: if they only read, mark them read-only in the MCP server and the next replay runs them." } }), description: "The tools that stopped its skipped inputs, most inputs first." };
const REPLAY_OUTCOMES = closed({
  answered: { ...COUNT, description: "Replay runs the workflow answered alone, as each run did." },
  handed_back: { ...COUNT, description: "Replay runs it handed back on." },
  failed: { ...COUNT, description: "Replay runs a step failed in, or still at work past the replay's deadline: no evidence either way, never scored." },
  skipped_write: { ...COUNT, description: "Replay runs stopped at a write (an MCP tool its server does not mark read-only, or any tool not known to read) that the graded run's recording does not have with the same arguments: a replay never runs a write, so these are neither scored nor wrong; a replay whose every input was skipped holds the revision." },
}, "How many of its replay runs ended each way: what each run did.");
/** One input a check did not agree on (learn/promote.ts CheckDisagreement). */
const CHECK_DISAGREEMENT = closedWith({ run: { type: "string" }, input: { type: "string", description: "The run's input, as text or JSON, cut at 1200 characters." }, agent: NULL_STRING }, { draft: { type: "string", description: "What it answered instead." }, escalated: { type: "string", description: "Why it handed the input back." }, failed: { const: true, description: "A step failed on it, or its run was still at work past the check's deadline, or never created by then." }, differs_on: { type: "string", description: "When `grader` compared it: the decision the two answers differ on, in the fast model's words, or why its verdict could not be had (\"the comparison could not be read\", \"the cap held the comparison\", or \"the comparison read an earlier answer\" when the agent's run answered again after it was compared). Cut at 1200 characters." } });
/** A compiled draft's one check (learn/promote.ts CheckRecord): its bar while it replays, its numbers once decided. */
const PROMOTION_CHECK = closedWith({
  compile_after: { type: "integer", minimum: 1, description: "The agent definition's `learning.compile_after` when the check began: how many of the agent's newest completed runs it read inputs from." },
  agree_min: { type: "number", minimum: 0, maximum: 1, description: "The bar on agreement: of the inputs it answered alone, the least share that must say what the agent's recorded answer said." },
  alone_min: { type: "number", minimum: 0, maximum: 1, description: "The bar on answering alone: the least share of the inputs it ran on that it must answer with no escalate and no failed step." },
  attempt: { enum: [1, 2], description: "1: the compile's first check. 2: the check of its one recompile, after the first held it; held again, it stops (`stopped`)." },
}, {
  agree_on: { type: "array", items: { type: "string" }, minItems: 1, description: "The definition's `learning.agree_on` it compared the draft's answer and the agent's on: dotted paths into the answer's JSON object, each resolving in both answers to equal values. Left out when it compared the whole answer." },
  grader: { type: "string", description: "With no `agree_on`: the agent's fast model that compared the two answers where they were not equal, asked whether they reach the same decision (one request per input, booked as the check's spend; a reply it could not read, a failed request or one the cap refused counts as differing). Left out when no fast model compared them: with `agree_on`, or with no fast model (the whole answer)." },
  n: { ...COUNT, description: "The inputs it ran on (a replay stopped at a write is none; one never created, or not ended, by the check's deadline counts, as failed). 0 with nothing to run on: never promoted, it stops (`stopped`) and `reason` says why." },
  agreed: { ...COUNT, description: "How many of them it answered alone with the agent's recorded answer (compared on `agree_on` when set; else equal answers, or the same decision by `grader`'s verdict; with neither, the whole answer)." },
  alone: { ...COUNT, description: "How many of them it answered alone. Promoted when `alone`/`n` >= `alone_min` and `agreed`/`alone` >= `agree_min`." },
  of: { type: "array", items: { type: "string" }, description: "The agent's runs whose inputs it ran on, newest first." },
  cost_usd: { type: ["number", "null"], minimum: 0, description: "What its replay runs cost together; null when one's cost is unknown." },
  outcomes: { ...REPLAY_OUTCOMES, description: "How each input it ran on came out, one per input: a replay run never created, or not ended, by the check's deadline is `failed`." },
  unstarted: { ...COUNT, minimum: 1, description: "How many of its replay runs were never created by the check's deadline (the server stopped after reserving them, say), each a `failed` input. Left out when none. Every one: its replay's read is `failed`." },
  skipped_tools: SKIPPED_TOOLS,
  disagreements: { type: "array", items: CHECK_DISAGREEMENT, description: "On a hold: each input it did not agree on, which the agent's next run reads as data in its one recompile." },
  stopped: { const: true, description: "The recompile's check held it too, or there was nothing to check it on (no input of the agent's it takes, or every input skipped at a write: `n` 0, `reason` starting \"nothing to check it on\", which asks no recompile): nothing compiles again until a hold or its owner acts; the agent keeps the runs." },
  released: { type: "integer", minimum: 1, description: "A connected agent's check (`via` sdk): how many of its reserved native turns in a row since the last one checked could not be its baseline and were given back to wait for the next turn the draft takes (see runner/promotion.ts SDK_CHECK_RELEASES for the causes and the hold the fifth writes). Left out when none." },
  fresh_reads: { type: "integer", minimum: 1, description: "A connected agent's check (`via` sdk): how many fresh read-only calls its shadow made where the native turn's recording had no result (the host's opt-in `shadowReadFallback`). Left out when every call was answered from the recording." },
  turns: { ...closedWith({
    n: { ...COUNT, description: "The native turns checked so far: each whose shadow answered or handed back, and each the backend never completed within an hour (`failed`)." },
    agreed: { ...COUNT, description: "How many of them the shadow answered alone with the native answer." },
    alone: { ...COUNT, description: "How many of them the shadow answered alone." },
    of: { type: "array", items: { type: "string" }, description: "The agent's runs of those turns, newest first." },
    outcomes: { ...REPLAY_OUTCOMES, description: "How each turn came out, one per turn." },
  }, {
    disagreements: { type: "array", items: CHECK_DISAGREEMENT, description: "Each turn it did not agree on." },
    fresh_reads: { type: "integer", minimum: 1, description: "The fresh read-only calls its shadows made, as `fresh_reads` counts them." },
  }), description: "A connected agent's check (`via` sdk) still collecting native turns. A check decides once, on `compile_after` inputs, so this one waits for that many turns, the agent answering each, then decides on all of them. Left out once decided, and on a server replay; a check stopped or set aside before it held them keeps the turns it had." },
});
const PROMOTION = closedWith({
  workflow: { type: "string" },
  digest: { type: "string", description: "The revision the record decides: the first 16 hex of its workflow.json's sha256." },
  at: DATE_TIME,
  decided: { enum: ["promote", "hold", "replaying"], description: "`promote`: it serves first on the runs it fits. `hold`: it does not; the champion (the revision promoted last) takes them, else the agent, until a new revision. A hold with `audit` is its audits' (a serving revision: at least the definition's `learning.hold_disagree` of its newest `learning.hold_window` audit rows, GET .../learning/audits, disagreed); one with `check`, its check's; one with neither, this release's workflow DSL refused the serving revision (`reason` names the DSL's code and where; its runs handed back to the agent): the agent's next run recompiles it once. `replaying`: its check's replay runs are at work; the champion serves meanwhile, else the agent. One revision of a workflow is checked at a time, and a running check finishes." },
  reason: { type: "string", description: "Why, in words, with the numbers." },
}, {
  check: PROMOTION_CHECK,
  runs: { type: "array", items: { type: "string" }, description: "Its replay runs (path `replay`)." },
  inputs: { type: "array", items: { type: "string" }, description: "On a replaying record: the graded run each of `runs` replays, in the same order. Its runs are reserved before they are created; one not created a few minutes on is created by the next claim." },
  replay_id: { type: "string", description: "The replay's id, on its replaying record and the one that decided it: GET .../revisions/{digest}/replays/{replay_id} reads it, whether a run's claim or its owner started it." },
  commit: { type: "string", description: "The learning commit whose workflow.json is this revision's text: what it serves from as the champion while a newer revision replays." },
  via: { const: "sdk", description: "A connected (SDK) agent's check, on each reservation and on the record that decides it: its one run (`runs`) is the agent's own native turn reserved now, checked by the caller's shadow, not a replay run. A `replaying` one with no `runs` waits for the next native turn the draft takes. It collects its checked turns (`check.turns`) until it holds `check.compile_after` of them, then decides once on all of them, as a server replay decides once on its inputs. A turn the backend never completes within an hour is one failed input. Left out for a server replay." },
  audit: closedWith({
    window: { type: "integer", minimum: 1, description: "The definition's `learning.hold_window` when it was held." },
    disagree: { type: "integer", minimum: 1, description: "The definition's `learning.hold_disagree` when it was held." },
    rows: { ...COUNT, description: "The audit rows it was decided on: the newest `window` with a verdict." },
    disagreements: { type: "array", items: closedWith({
      run: { type: "string", description: "The run whose answer is the agent's: the shadow run, or the served run for a grade." },
      served: { type: "string", description: "The run the workflow served." },
      input: { type: "string", description: "The served run's input, as text or JSON, cut at 1200 characters." },
      agent: { ...NULL_STRING, description: "The agent's answer (the shadow run's), cut at 1200 characters; null for a grade's row." },
      draft: { ...NULL_STRING, description: "The served answer, cut at 1200 characters; null when it could not be read." },
    }, { graded: { const: true, description: "An owner's grade wrote this row: the served answer was graded wrong." } }), description: "Its disagreeing rows: the data its one recompile reads." },
  }, { stopped: { const: true, description: "A second audit hold within the definition's `learning.stop_window` served runs of the first: it stopped, no compile is asked, nothing serves again until a new revision lands." } }),
});
const AUDIT_LINE = closed({
  window: { type: "integer", minimum: 1, description: "The definition's `learning.hold_window`." },
  disagree: { type: "integer", minimum: 1, description: "The definition's `learning.hold_disagree`." },
  rows: { ...COUNT, description: "The serving revision's newest audit rows with a verdict, at most `window`." },
  disagreed: { ...COUNT, description: "How many of them disagreed: it is held once this reaches `disagree`." },
});
const SERVING = closed({
  workflow: { type: "string" },
  digest: { ...NULL_STRING, description: "The revision that serves first (the champion: the one promoted last, while its newest record still says promote); null when none does and the agent takes the runs. A champion the cost rule stopped is still named here, with `state` `stopped`: the agent takes its runs." },
  replaying: { ...NULL_STRING, description: "A newer revision whose replay is at work, when there is one: it serves only once its replay promotes it; the champion serves meanwhile." },
  state: { enum: ["serving", "checking", "held", "stopped"], description: "`serving`: a revision serves first. `checking`: its newest revision's check is at work (an older revision that serves keeps serving meanwhile, else the agent takes the runs). `held`: none serves, its newest record holds it (a check's or an audit's hold, or this release's workflow DSL refused it: the agent's next run recompiles it once). `stopped`: none runs first until a new revision lands: the cost rule stopped its champion (GET .../learning/cost `workflows[].state` `needs_revision`: over its newest served runs it cost as much as the agent by hand, and the stop asks for no compile), or none serves and nothing compiles again (a recompile's check held it too, or a second audit hold within `learning.stop_window`, or a check whose every input stopped at a write)." },
  check: { anyOf: [closed({ n: COUNT, agreed: COUNT, alone: COUNT, attempt: { enum: [1, 2] } }), { type: "null" }], description: "The numbers of the workflow's newest decided check: its inputs, those it agreed on, those it answered alone, which check of its compile it was; null when none was decided." },
  audit: { anyOf: [AUDIT_LINE, { type: "null" }], description: "Its audit line: the serving (else the newest) revision's newest audit rows against the hold bar; null when no revision has a record." },
  audits_off: { ...NULL_STRING, description: "Why none of the agent's runs is audited, e.g. `audits off: send_email can write`: its definition can call a tool that is not read-only (an MCP tool its server lists without `readOnlyHint`, or a built-in other than web_fetch, web_search, pdf_pages and llm, its computer's tools among them), which a shadow run would call a second time. Null when every tool it can call only reads: its served runs are audited." },
  not_auditable: { ...COUNT, description: "Of the serving revision's newest `learning.stop_window` served runs, those a trigger started: never audited (a shadow run gets none of a trigger's context, and could answer where it answers). 0 when none serves." },
  champion: { anyOf: [closed({
    digest: { type: "string", description: "The champion's revision: `digest` above." },
    commit: { ...NULL_STRING, description: "The learning commit its text was read at: the newest its promotion records name that holds it, else the folder's main. Read by its recorded digest, never by paging the workflow's history. Null when no commit read holds it." },
    nodes: { anyOf: [{ type: "array", items: closed({
      path: { type: "string", description: "Where the node is in its parent: a chain's step by its index (`0`, `1`), any other child by its field (`2.body`); `root` for a root that is no chain." },
      kind: { type: "string", description: "Its node kind (`extract`, `decide`, `call`, `loop`, `escalate`, ...)." },
      label: { type: "string", description: "Its label; its kind when it has none." },
      tier: { type: ["string", "null"], enum: ["fast", "agent", null], description: "The tier its model step runs on: `fast`, or `agent` for the agent's own model. Null for a node that calls no model tier (a call, a loop, an escalate, a decision node's own provider)." },
      checks: { type: "array", items: closed({ on: { enum: ["when", "until"], description: "`when`: the node runs only when the predicate holds. `until`: a loop stops once it holds." }, predicate: { type: "object", description: "The predicate as the workflow holds it (the DSL's predicate: `field_equals`, `exists`, `not`, `and`, `or`, ...)." } }), description: "The checks it runs in code." },
    }) }, { type: "null" }], description: "Each node of its workflow.json, depth first, a chain's steps in order and the chain itself left out. Null when its text could not be read." },
    check: { anyOf: [PROMOTION_CHECK, { type: "null" }], description: "The check it was promoted on: its promote record's `check`. Null when it was promoted with none." },
  }), { type: "null" }], description: "The revision that serves first, as a person reads it: its nodes with their tiers and code checks, and the check it was promoted on. Kept while a newer revision is checked (`replaying`). Null when none serves (`digest` null)." },
});
const AUDIT_ROW = closedWith({
  run: { type: "string", description: "The served run." },
  shadow_run: { ...NULL_STRING, description: "Its shadow run (the same agent on the same input with learning off, GET /runs/{id}'s `audit_of` names the served run); null for a grade's row, or when none was started (`skipped`)." },
  workflow: { type: "string" },
  digest: { type: "string", description: "The revision that served it." },
  promoted_at: { type: ["string", "null"], format: "date-time", description: "The promotion of that revision the row counts for: its promote record's `at` (GET .../learning/promotions), the one serving when the shadow started or the grade was given. The hold rule counts only the rows of the revision's promotion now, so a revision its owner's replay promotes again after a hold starts on none. Null: none." },
  source: { enum: ["shadow", "grade"], description: "`shadow`: the shadow run's answer compared with the served one. `grade`: an owner's grade of a run the workflow answered alone (PUT /runs/{id}/grade)." },
  agreed: { type: ["boolean", "null"], description: "Whether the two answers say the same (a grade's: whether it was graded right); null when either answer is missing (a shadow that failed or `parked`, or none was started): no evidence, not counted." },
  served_cost: { type: ["number", "null"], minimum: 0, description: "What the served run cost; null when unknown." },
  shadow_cost: { type: ["number", "null"], minimum: 0, description: "What the shadow run cost (the agent's learning cost); null for a grade's row, or when unknown." },
  at: DATE_TIME,
}, {
  turn: { type: "string", description: "The served run's answer the row is of: the id of its answer row in the run's timeline (GET /runs/{id}/timeline), its newest final answer when the audit began (or at the grade). A follow-up's later answer is never the one compared. Absent when the run had no answer." },
  skipped: { const: "no allowance", description: "No shadow was started: the served run's cap left less than a run's smallest cap ($0.01), or what it spent under it is not known. `agreed` is null: not counted." },
  parked: { const: true, description: "The shadow came to wait on a person (an approval its tool settings ask, a question, a raise of its cap: what the served run's cap left) and ended there at once, no one asked, so it has no answer. `agreed` is null: not counted." },
});
const LEARNING_EXTENSIONS: Record<string, Record<string, Json>> = {
  "/runs/{run_id}/grade": {
    put: {
      operationId: "gradeRun", tags: ["runs"], summary: "Grade an ended run's answer: right or wrong, and the fields a right answer holds",
      description: `A person's feedback or an eval's label on a run that ended, kept for its agent (one grade a run: a later one replaces it; the newest ${GRADES_KEPT} are kept). Promotion reads none: a revision's check is scored against the agent's own recorded answers. A replay run is never graded. The run's path never changes on a grade: a grade of a run its learned workflow answered alone, right or wrong, is kept and nothing more ($0); a run the agent finished, graded with a \`label\`, opens again on a look-back on it. That round asks the agent no turn of the job's, only its end-of-run turn, and its spend is the run's learning (\`feedback\`). A run that reads ended while it still learns from that end (its \`learning.state\` \`reflecting\`: its own look-back, or a grade's round) is \`409 run_learning\`, nothing kept: grade it once \`learning.state\` moves on.`,
      parameters: [ref("parameters/RunId")],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["correct"], properties: { correct: { type: "boolean" }, expected: { type: "object", description: "The fields a right answer's JSON holds." }, source: { enum: [...GRADE_SOURCES], default: "feedback" }, label: { type: "string", maxLength: LABEL_MAX, description: "The grade's words (a teacher's label, a reviewer's note): what the run's look-back reads." } } } } } },
      responses: { "200": json(GRADE, "The run's grade."), ...errors(400, 401, 404, 409, 429, 500) },
      "x-agentrun-serve": "promotion/1",
    },
  },
  "/agents/{agent_id}/learning/loop": {
    get: {
      operationId: "getLearningLoop", tags: ["agents"], summary: "The self-learning loop's own record: each compile turn",
      description: `What the console's Learning tab tells of the loop beside the cost series. \`compiles\`: the agent's compile turns, newest first (the newest ${LOOP_COMPILES_MAX}): the workflow a run's compile turn wrote, each attempt and what the checks refused, its draft's digest and whether that revision was promoted; a follow-up's round compiles on its own, so a run can list one turn a round; a turn whose draft never passed is listed with its \`draft_errors\`, never silent. Aggregates and the checks' own words only: no input or answer. Each text cut of the host's secrets and of its run's handed values; a run whose handed values can't be read here shows no error text (\`withheld\`).`,
      parameters: [AGENT_ID],
      responses: { "200": json(closed({
        agent: { type: "string" },
        completed_runs: { ...COUNT, description: "The agent's completed runs of its own (never one a learned workflow answered alone, a replay, an imported or an archived run) toward its first compile, at most its definition's `learning.compile_after`." },
        compiles: { type: "array", items: closed({
          run_id: { type: "string", description: "The run whose end compiled it." },
          round: { type: "integer", minimum: 1, description: "The run's round that compiled it: 1 its first end, more for an end after a follow-up opened it again." },
          at: DATE_TIME,
          workflow: { ...NULL_STRING, description: "The workflow it wrote or revised; null when no attempt named one." },
          attempts: { type: "array", items: closed({ ok: { type: "boolean" }, errors: { type: "array", items: { type: "string" } } }), description: "Each attempt in order: whether its checks and dry run passed, and what they refused." },
          digest: { ...NULL_STRING, description: "The kept draft's digest; null when none passed." },
          promoted: { type: ["boolean", "null"], description: "Whether that revision was promoted, as its records say now: true promoted, false held, null undecided or none passed. It may no longer serve: the promotions read's \`serving\` says which revision does." },
          draft_errors: { type: "array", items: { type: "string" }, description: "A draft that never passed: its last errors. A draft its check had nothing to run on (its promotion `check.stopped` with `n` 0): its record's reason, starting \"nothing to check it on\". Empty otherwise." },
          withheld: { type: "boolean", description: "The run's handed values can't be read here: its error texts are left out (the counts stand)." },
        }), description: "Newest first." },
      }), "The loop's compile turns."), ...errors(401, 403, 404, 429, 500) },
      "x-agentrun-serve": "learningloop/1",
    },
  },
  "/agents/{agent_id}/learning/promotions": {
    get: {
      operationId: "listLearningPromotions", tags: ["agents"], summary: "Each learned workflow revision's promotion: its replay's numbers and whether it serves",
      description: "Every promotion record of the agent's learned workflows, oldest first: a new revision's one check, a replay of it on the inputs of the agent's last completed runs scored against the agent's own recorded answers (replaying, then promoted or held, with its numbers), a draft held with nothing to check it on, a compile whose drafts all failed their checks (a hold with nothing checked, its reason naming the failed checks: the compile's attempt; a recompile's stops), or a serving revision held by its audits (GET .../learning/audits; the hold's `audit` holds the rows). A revision serves only once its check promotes it; the champion (the revision promoted last) keeps serving while a newer one is checked or after it is held, and `serving` says which digest serves and which is checked, each workflow's state, its newest check's numbers and its audit line. One revision of a workflow is checked at a time and a running check finishes. A hold's disagreements (a check's, an audit's) quote inputs and answers, cut as the agent's other learning reads cut them. What the console's Learning tab marks on its cost chart.",
      parameters: [AGENT_ID],
      responses: { "200": json(closed({ agent: { type: "string" }, promotions: { type: "array", items: PROMOTION }, serving: { type: "array", items: SERVING, description: "Each learned workflow with a record: the revision that serves, the one replaying, its state, its check's numbers and its audit line." } }), "The agent's promotion records, and what serves."), ...errors(401, 403, 404, 429, 500) },
      "x-agentrun-serve": "promotion/1",
    },
  },
  "/agents/{agent_id}/learning/audits": {
    get: {
      operationId: "listLearningAudits", tags: ["agents"], summary: "The audit ledger of the agent's serving learned workflows",
      description: "One row per finished audit, oldest first, as the agent's learning folder keeps them (audits.jsonl): a run a promoted learned workflow answered alone (path `workflow`; a run it handed back is never drawn) is audited at 1 in `learning.audit_every` (drawn from its id): its shadow run, the same agent on the same input with learning off, answers it again, and the row says whether the two answers say the same and what each run cost (the shadow's is the agent's learning cost; the shadow is no row of the run list, and GET /runs/{id} reads it with `audit_of`). A capped run's shadow starts at its end, capped at what its cap left, so the two never spend past it: with less than a run's smallest cap left, none starts (`skipped`). A shadow never waits on a person: one that would (an approval, a question, a raise of its cap) ends there at once with no answer (`parked`); neither is counted. Each row compares the served run's answer at the audit's start (`turn`), never a follow-up's. An owner's grade of a run the workflow answered alone is a row too. The hold rule reads them (`learning.hold_window`, `learning.hold_disagree`).",
      parameters: [AGENT_ID],
      responses: { "200": json(closed({ agent: { type: "string" }, audits: { type: "array", items: AUDIT_ROW } }), "The agent's audit rows."), ...errors(401, 403, 404, 429, 500) },
      "x-agentrun-serve": "promotion/1",
    },
  },
  "/agents/{agent_id}/learning": {
    get: {
      operationId: "getAgentLearning", tags: ["agents"], summary: "What the agent has learned: its corrections, workflow drafts, log of changes and counts",
      description: "Read at main's head with git's plumbing; every text cut of the host's secrets as they are now, and a file name holding one `[redacted]` whole. An agent whose learning was never on has no folder: `main` null, `corrections` empty and every page empty. An archived agent's is readable." + " " + SIGN_IN_WITHHELD,
      parameters: [AGENT_ID], responses: { "200": json(AGENT_LEARNING, "The agent's learning."), ...errors(401, 403, 404, 429, 500) }, ...MARK,
    },
    delete: {
      operationId: "deleteAgentLearning", tags: ["agents"], summary: "Reset the agent's learning: everything it learned deleted, the agent and its runs kept",
      description: "Deletes what the agent learned: its learning folder whole (`corrections.md`, its learned workflows, their history and the audit ledger), on this server and on every Archil disk its runs used (its own disk, and a disk a run's launch named, where Archil mode keeps it; nothing else on those disks), then its promotion records and grades. The agent, its definition, its runs and everything kept of them (their files, timelines, costs and each one's learning) stay, so the run list, `GET /stats` and `GET /usage` read the same after; a served run's cost keeps its share of its workflow revision's compile and check (the revision's name, digest and `compile_after` are kept for it, nothing else of its records). A run's learning diff (`GET /runs/{run_id}/learning/diff`, the text it merged) is the folder's and goes with it: 404 after. From then on no run is given a correction or a learned workflow of before, and the agent's next run takes the agent path; learning starts again from the agent's runs, as for a new agent. Its learning work in flight is stopped first: a run that exists only for learning (a check's or an owner's replay, an audit's shadow run) is cancelled and waited for. A run of the agent's own still going (queued, running or parked) carries its learning with it (what it was started with, its compile turn and look-back at its end) and is never cancelled for this: while one is, or a learning run this server cannot end (an SDK run) or one not ended in time, it is `409 learning_busy`, each named in `details.runs`, and nothing of the agent's learning is deleted. `204` when done; idempotent: an agent that never learned, or one reset already, is `204` too. An agent being deleted is `409 agent_not_runnable`. While an Archil disk that holds its learning can't be reached (Archil off on this server, no key, or Archil refusing) it is `503 unavailable`, retryable, with its learning here and its records kept; the next call finishes it. A reset that failed on the way (anything but `409`) may have removed part of the agent's learning, so from then on learning reads no run from before it, as after a reset done. Resetting takes the owner's session (the password sign-in, or the console on a server bound to loopback) or the API token, as deleting an agent does: any other console session is `403 forbidden`. Served in the API-only profile (`AGENTRUN_API_ONLY=1`) too, with the token, as the other learning writes take it.",
      parameters: [AGENT_ID],
      responses: { "204": { description: "The agent's learning is reset." }, ...errors(401, 403, 404, 409, 429, 500, 503) },
      "x-agentrun-serve": "learningreset/1",
    },
  },
  "/agents/{agent_id}/learning/cost": {
    get: {
      operationId: "getLearningCost", tags: ["agents"], summary: "The agent's cost per run, run after run: its own cost, what learning added and the path it took",
      description: "Each of the agent's ended agentic runs in the order they started, with its own cost, what learning cost for it and its all-in cost, the path it took (a learned workflow alone, a learned workflow that handed back, or the agent with none) and the learned revision that served it, plus what the series shows: the first run a learned workflow finished alone, the mean cost before it and the mean all-in cost from it on. What the console's Cost per run chart draws. Aggregates only: no run's input, answer or tool text. Read from the runs' rows, launches, learning ends and timelines in the store; an agent with learning never on has every run on the `agent` path. `format=csv` answers the same runs as CSV (`text/csv`, a header line, an unknown figure empty), to plot elsewhere.",
      parameters: [
        AGENT_ID,
        { name: "limit", in: "query", required: false, description: `The latest runs to answer, each keeping its number. At most ${COST_RUNS_MAX}.`, schema: { type: "integer", minimum: 1, maximum: COST_RUNS_MAX, default: COST_RUNS_DEFAULT } },
        { name: "format", in: "query", required: false, description: "`csv`: the runs as CSV, columns " + COST_CSV_COLUMNS.join(", ") + ".", schema: { enum: ["json", "csv"], default: "json" } },
      ],
      responses: { "200": { description: "The agent's cost per run.", content: { "application/json": { schema: LEARNING_COST }, "text/csv": { schema: { type: "string" } } } }, ...errors(400, 401, 403, 404, 429, 500) },
      "x-agentrun-serve": "learningcost/1",
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
      responses: { "200": json(PAGE(LEARNING_CHANGE, "Newest first."), "One page of changes."), ...errors(400, 401, 403, 404, 429, 500) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/corrections": {
    get: {
      operationId: "getLearningCorrections", tags: ["agents"], summary: "The agent's corrections.md on main, with its ETag",
      description: `The owner's corrections, one line each, as every later run is given them whole under # Learned in its instructions. A run's feedback appends one line (the owner's words, checked as every write is); a person edits the file whole with PUT. Cut of the host's secrets as they are now. An agent with none answers \`text\` empty. At most ${CORRECTIONS_CAP} bytes. ${SIGN_IN_WITHHELD}`,
      parameters: [AGENT_ID],
      responses: { "200": { ...json(CORRECTIONS, "corrections.md as it is on main."), headers: ETAG }, ...errors(401, 403, 404, 429, 500) },
      "x-agentrun-serve": "learning/4",
    },
    put: {
      operationId: "putLearningCorrections", tags: ["agents"], summary: "Replace the agent's corrections.md (If-Match)",
      description: `The body is the file's whole text. One host commit on main in the agent's queue, \`learning: edited by a person: corrections.md\` with a \`Changed-By: user\` trailer; every later run is given it. Under If-Match with the ETag a GET answered: none (or \`*\`) is 428, a stale one 412 (a run's correction or another edit landed since). Text past ${CORRECTIONS_CAP} bytes, text shaped like a secret or holding one of the host's values, a hidden character or one that is not UTF-8 is 422 by field \`text\`, the rule named, never the value, and nothing is written. Answers the file as it now is, with its new ETag. ${SIGN_IN_WITHHELD}`,
      parameters: [AGENT_ID, { ...IF_MATCH, required: true }],
      requestBody: {
        required: true,
        description: "The file's whole text: as text, or as JSON `{text}`, the form the console's page sends under its session.",
        content: {
          "text/markdown": { schema: { type: "string" } }, "text/plain": { schema: { type: "string" } },
          "application/json": { schema: closed({ text: { type: "string", description: "corrections.md's whole text." } }) },
        },
      },
      responses: { "200": { ...json(CORRECTIONS, "corrections.md as it now is."), headers: ETAG }, ...WRITE_ERRORS, ...errors(413, 415, 422) },
      "x-agentrun-serve": "learning/4",
    },
  },
  "/agents/{agent_id}/learning/files/{file}": {
    get: {
      operationId: "readLearningFile", tags: ["agents"], summary: "One file of a learned workflow on main (its workflow.json or README.md), as text, with its ETag",
      description: "corrections.md and a README.md are `text/markdown`; a draft's workflow.json is `application/json`. A run's purge (`DELETE /runs/{run_id}`) puts each workflow whose workflow.json it changed last back to the version before it, the newest no purged run wrote (off main when it wrote it new, so both its files are `404`), and no read at an older commit serves the purged run's text either: a champion read by its digest reads no commit, a later merge's diff shows its files as added, and no run lays it. A file of a workflow still on main whose workflow.json a purged run wrote (its run purged before its purge took the text, until its `DELETE` is sent again) is `410 purged`, as an approval or a restore of it is.",
      parameters: [AGENT_ID, FILE_PARAM], responses: { "200": FILE_TEXT("The file's text, cut of the host's secrets.", true), ...errors(400, 401, 403, 404, 410, 429, 500) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/files/{file}/retire": {
    post: {
      operationId: "retireLearningFile", tags: ["agents"], summary: "Retire a workflow draft: out of every later run, kept in history",
      description: `A workflow draft is retired by its \`workflows/<name>/README.md\` (its workflow.json is 400): \`status: retired\` last in its front matter, one host commit \`learning: retired by a person: <file>\` that changes that file alone, listed \`retired\`, and no later run is given it; one already retired is answered as it is. Only its format is checked; a secret shape or one of the host's values never blocks a retire, and the answer is cut of them. ${WRITE_DESCRIPTION}`,
      parameters: [AGENT_ID, FILE_PARAM, IF_MATCH], responses: { "200": FILE_TEXT("The README.md, retired."), ...WRITE_ERRORS }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/files/{file}/approve": {
    post: {
      operationId: "approveLearningFile", tags: ["agents"], summary: "Approve a workflow draft that waits for its owner's OK",
      description: `A workflow draft (its README.md) that waits is made active in one commit that drops its \`status: pending\` line and changes nothing else: every later run is given it. One host commit on main, \`learning: approved by a person: <file>\`, with the trailers \`Changed-By: user\` and \`Approved-Via: console\`; the log shows it as \`by: {user: true, via: "console"}\` at the commit's time. Only the owner, signed in with their password, approves: the route takes the console's password session alone, from this server's own origin with a JSON body (as every page write), and answers 403 \`forbidden\` to every token, the server's own included, since an agent's MCP client, the MCP endpoint's tools or a script may hold one, to a run's door token, and to every request on a server with accounts off, whose page cookie the token mints (\`capabilities.learning.approve\` is false there, with \`approve_needs: "password"\`); with no credential at all it is 401, as every route. A run that uses bash on the host runs as the server's user and can read its files, so for untrusted tasks use the sandbox. A draft that is not pending is 400 \`bad_request\`. Under If-Match, as a retire: a stale ETag is 412, none 428.`,
      // The owner's password session alone (ownerSession), never the document's bearer, with the empty JSON body every
      // page write sends: a client generated from this document sends what the route takes.
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, maxProperties: 0 } } } },
      parameters: [AGENT_ID, FILE_PARAM, IF_MATCH], responses: { "200": FILE_TEXT("The README.md, approved."), ...WRITE_ERRORS, ...errors(410) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/files/{file}/restore": {
    post: {
      operationId: "restoreLearningFile", tags: ["agents"], summary: "Restore a retired workflow draft to the status it had before its retire",
      description: "A retired workflow draft (its README.md) goes back to the status its retire recorded (`retired.from`): active, given to every later run again, or waiting for its owner's OK again (a retire that recorded none restores it waiting): a restore is never an approval. In one commit on main (`learning: restored by a person: <file>`, Changed-By: user). Its files are checked again as a run's draft is (a secret's shape, the host's own values, a hidden character, its format, its workflow against the agent's tools and gate), so a value a retire took out of every run never comes back: such a draft stays retired, and the answer names the rule, never the value. Only a retired one is restored (else 400). The owner's password session alone, as an approval.",
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, maxProperties: 0 } } } },
      parameters: [AGENT_ID, FILE_PARAM, IF_MATCH], responses: { "200": FILE_TEXT("The README.md, restored."), ...WRITE_ERRORS, ...errors(410) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/workflows/{name}/revisions": {
    get: {
      operationId: "listLearnedWorkflowRevisions", tags: ["agents"], summary: "A learned workflow's revisions on main, oldest first, each with its workflow.json as it was then",
      description: "The commits on the agent's learning main that changed `workflows/<name>/workflow.json`, the latest `limit` of them, oldest first, each with who made it (a run's merge, or a person), when, why, and the workflow's text at that commit (`null` when that commit holds no such file). What the console's learned-workflow replay steps through, drawing each text as a graph and marking its nodes new or edited against the revision before. One read-only exec per revision returned. `total` counts every such commit the log holds; `truncated` is true when the log itself is cut (it keeps the latest 200 changes). A workflow no commit in the log changed is 404. " + SIGN_IN_WITHHELD,
      parameters: [AGENT_ID, { name: "name", in: "path", required: true, description: "The learned workflow's folder name, `workflows/<name>/`: lowercase letters, digits, dashes and underscores.", schema: { type: "string" } }, { name: "limit", in: "query", required: false, description: "The latest revisions to answer. At most 50.", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } }],
      responses: { "200": json(closed({
        name: { type: "string" },
        revisions: { type: "array", items: closed({ commit: { type: "string" }, at: { type: "string", format: "date-time" }, by: LEARNING_BY, reason: { type: "string", description: "A merge's: what it kept. A person's: what was done." }, text: { type: ["string", "null"], description: "The workflow's workflow.json at this commit, cut of the host's secrets; null when the commit holds no such file." }, digest: { type: ["string", "null"], description: "That workflow.json's digest, the first 16 hex of its sha256 (read before any cut): the one a run's metrics (`workflow_digest`), its guard rows and the promotion records name. Null when the commit holds no such file." } }), description: "Oldest first." },
        total: { ...COUNT, description: "How many commits in the log changed this workflow's workflow.json, `limit` aside." },
        truncated: { type: "boolean", description: "The agent's log is cut at its latest 200 changes, so older revisions may exist." },
      }), "The workflow's revisions."), ...errors(400, 401, 403, 404, 429, 500) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/workflows/{name}/revisions/{digest}/replays": {
    post: {
      operationId: "startLearnedWorkflowReplay", tags: ["agents"], summary: "Re-check a learned workflow's revision on the agent's own runs: a held revision, or an edited one",
      description: `Starts the one check a run's claim starts for a new revision (GET /agents/{agent_id}/learning/promotions explains it): one replay run of the agent per input, each the workflow alone at workflow cost, its reads live and its writes answered only from the agent's own run's recording, never sent, scored against the agent's own recorded answers. \`inputs\`: \`held\` (the default), the runs the revision's last check ran on, or, with none, the agent's last \`compile_after\` completed runs; a number from 1 to ${COMPILE_AFTER_MAX}, that many of the agent's newest completed runs. Each is a completed run of the agent's own (path \`agent\` or \`handed_back\`), with no uploaded file, whose input the revision takes. Its record is a check's (\`replaying\` then promoted or held, with its numbers, as a claim-started one is), decided once every replay run ended: at a run's claim that lays the revision, or at its read (GET .../replays/{replay_id}). Its replay runs are handed no per-run MCP credentials. The revision is \`digest\`, the first 16 hex of its workflow.json's sha256: one a promotion record names (read at its commit), or the one on the learning folder's main. 404 for an unknown agent, workflow or revision. 409 \`replay_conflict\` when it is replaying already, another revision of the workflow replays (one at a time, and a running check finishes), it is promoted (it serves already), none of the inputs asked for fits it (nothing is reserved and no run starts), or the agent's runs take no learned workflow here. 409 \`agent_not_runnable\` for an archived agent, as a run's start is: nothing is reserved. 400 for any other \`inputs\`. Only the owner, signed in with their password, starts one: the console's password session alone, from this server's own origin with a JSON body; every token is 403 \`forbidden\`.`,
      security: [{ ownerSession: [] }],
      parameters: [AGENT_ID, { name: "name", in: "path", required: true, description: "The learned workflow's folder name, `workflows/<name>/`.", schema: { type: "string" } }, { name: "digest", in: "path", required: true, description: "The revision: the first 16 hex of its workflow.json's sha256.", schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { inputs: { oneOf: [{ const: "held" }, { type: "integer", minimum: 1, maximum: COMPILE_AFTER_MAX }], default: "held", description: "`held`: the runs it was last checked on; a number: the agent's newest that many completed runs." } } } } } },
      responses: { "202": { description: "The replay started: its runs are queued.", headers: { Location: ref("headers/Location") }, content: { "application/json": { schema: closed({ replay: { type: "string", description: "The replay's id." }, inputs: { ...COUNT, description: "How many graded inputs it replays: one replay run each." } }) } } }, ...errors(400, 401, 403, 404, 409, 422, 429, 500, 503) }, ...MARK,
    },
  },
  "/agents/{agent_id}/learning/workflows/{name}/revisions/{digest}/replays/{replay_id}": {
    get: {
      operationId: "getLearnedWorkflowReplay", tags: ["agents"], summary: "Read a replay's result: running, done or failed, its counts and its score (start one from the console's Learning tab)",
      description: "A replay a run's claim or the agent's owner started. This read decides it as a claim would, once every replay run ended or its deadline passed (promoted when it clears the check's bar, else held), so a replay of a revision no run lays is decided too. It never starts a run: a replay whose launch was interrupted (the server stopped before creating its runs) reads `running` until its deadline. `status`: `running` while it replays, `done` once promoted or held (`decided`, with its `reason`), `failed` when none of its runs started by its deadline (held, nothing replayed; its `reason` says so and to start it again with POST). `outcomes` counts its replay runs so far (once decided, those it was decided on, as its promotion record keeps them): `answered` alone, `handed_back` (the agent's recorded answer), `failed` (no evidence either way), `skipped_write` (a write its recording does not have). `score` is the decided record's. Aggregates only, its words cut as the promotions list's are.",
      parameters: [AGENT_ID, { name: "name", in: "path", required: true, description: "The learned workflow's folder name.", schema: { type: "string" } }, { name: "digest", in: "path", required: true, description: "The revision's digest.", schema: { type: "string" } }, { name: "replay_id", in: "path", required: true, description: "The replay's id: POST .../replays answered it, and its promotion records carry it (`replay_id`).", schema: { type: "string" } }],
      responses: { "200": json(closedWith({
        replay: { type: "string" }, workflow: { type: "string" }, digest: { type: "string" },
        status: { enum: ["running", "done", "failed"] },
        inputs: { ...COUNT, description: "Its replay runs: one per input." },
        outcomes: REPLAY_OUTCOMES,
        score: closed(REPLAY_SCORE),
        cost_usd: { type: ["number", "null"], minimum: 0, description: "What its replay runs cost together; null while one's cost is unknown (one not created or not ended yet), never a part of it." },
      }, {
        decided: { enum: ["promote", "hold"], description: "Once it is not running: what it decided." },
        reason: { type: "string", description: "Why, in words, with the numbers." },
      }), "The replay."), ...errors(401, 403, 404, 429, 500) }, ...MARK,
    },
  },
  "/runs/{run_id}/learning": {
    get: {
      operationId: "getRunLearning", tags: ["runs"], summary: "The run's learning whole: its seed, merge, verdict, problems and cost",
      parameters: [ref("parameters/RunId")], responses: { "200": json(RUN_LEARNING, "The run's learning, or null."), ...errors(401, 403, 404, 429, 500) }, ...MARK,
    },
  },
  "/runs/{run_id}/learning/diff": {
    get: {
      operationId: "getRunLearningDiff", tags: ["runs"], summary: "What the run proposed, file by file",
      description: "404 for a run that does not learn, or whose merge is not in its agent's folder.",
      parameters: [ref("parameters/RunId")], responses: { "200": json(LEARNING_DIFF, "The run's diff."), ...errors(401, 403, 404, 429, 500) }, ...MARK,
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
const HOME_WRITES = "A path more than 16 directories deep, past where the list goes, is `400 invalid_file_path`. A path at or under one of `capabilities.home.host_owned` (`learning/`, `sign-ins/`) is `403 system_file_forbidden` with `details.reason` `host_owned`: matched on the path as normalized, by its first segment folded (compatibility form, any case, no combining marks), so `./Learning/x` too. A link on the way, or as the file, is `403 system_file_forbidden` with `details.reason` `link`: never followed. A path that names a directory, or runs through a file, is `400 invalid_file_path`. An archived agent's home is written as any other's. Where \`capabilities.home.writes\` is false (no /proc/self/fd, as on macOS), the write or delete is \`501 unsupported_here\`.";

/** This server's own routes, outside the contract. */
/** One JSON-RPC 2.0 message, and the answer to a request (POST /mcp). */
const RPC_MESSAGE = { type: "object", required: ["jsonrpc"], properties: { jsonrpc: { const: "2.0" }, id: { type: ["string", "number"] }, method: { type: "string" }, params: { type: "object" } } };
const RPC_ANSWER = {
  type: "object", required: ["jsonrpc", "id"],
  properties: { jsonrpc: { const: "2.0" }, id: { type: ["string", "number", "null"] }, result: {}, error: { type: "object", required: ["code", "message"], properties: { code: { type: "integer" }, message: { type: "string" } } } },
};
/** GET /files's answer: a page of this server's uploads, newest first. */
const FILE_LIST = { type: "object", additionalProperties: false, required: ["files", "next_cursor"], properties: { files: { type: "array", items: ref("schemas/File") }, next_cursor: { type: ["string", "null"] } } };

/** A template package's file as GET /agents/{agent_id}/package answers it: text as itself, any other file base64. */
const AGENT_PACKAGE_FILE = closed({ path: { type: "string", description: "Its path in the package folder, with / between folders." }, encoding: { enum: ["utf8", "base64"] }, content: { type: "string" } });
/** One thing an export does not carry as it is here: what it is, which one, and why. */
const EXPORT_NOTE = closed({ kind: { type: "string", enum: [...EXPORT_NOTE_KINDS], description: "What the note is about." }, name: { type: "string", description: "Which one: a server, a trigger, a tool's key. A credential in the clear is named by its field (`<trigger>: source.urls.0`, `<server>: pin.<tool>.api_key`), never its value." }, reason: { type: "string" } });

const EXTENSIONS: Record<string, Record<string, Json>> = {
  "/agents/{agent_id}": {
    delete: {
      operationId: "deleteAgent", tags: ["agents"], summary: "Delete an agent another system owns, or purge an archived agent made here",
      description:
        "An agent made here, once archived (`POST /agents/{agent_id}/archive`), is purged by the rule `DELETE /runs/{run_id}` purges a run by: its revisions' content (instructions, skills, notes), its name and description, its learning, its triggers, its saved sign-ins, its own computer, disk and folders go, and each of its runs is purged (a tombstone, its cost kept). An uploaded package (`upload:<name>`, `POST /templates/import` with `files`) it was applied from goes in the same write when no other agent here, archived or not, was applied from it; a package imported from GitHub stays. The agent's row stays as its tombstone: every route of it answers `410 purged` with `details` {agent_id, archived_at, purged_at}, and no list shows it. What its runs cost stays in `/usage` and `/stats`. `204` when it is purged; a second `DELETE` is `204` too. An agent made here that is not archived is `409 agent_not_archived`, nothing purged; `409 run_not_final` while a run of it is live (`details.runs`), nothing purged; `503 unavailable` as below, the next `DELETE` finishing it. Purging one agent touches no other. Deleting or purging takes the owner's session (the password sign-in, or the console on a server bound to loopback) or the API token: any other console session is `403 forbidden`.\n\n" +
        "An agent made by an inline run (`POST /runs` with `external`) is deleted whole, archived or not: its runs and everything kept of them (journals, launch records, messages, files), its triggers, its learning, its saved sign-ins, its own computer and disk, its revisions and the agent. A run whose launch named an Archil disk (`archil_disk`, the caller's) has its own folder there deleted; the disk and everything else on it are kept, and a disk Archil says is gone has nothing left to delete. Shared things (MCP servers, keys, computers) are kept. In order: the agent refuses new runs (a mark in the store that outlives a restart: a run, an inline run, a trigger's firing, an SDK run or a message that would open one of its runs again is `409 agent_not_runnable`, as is a new trigger of it, off too, a trigger moved to it or turned on, and a write to its home or learning), and its runs still going are cancelled and waited for; then its learning (its learning folder, and its promotions and grades); then the rest. `204` when it is gone; a second `DELETE` is `404`. `409 runs_in_flight` (a run did not end in time, or only its application ends it) and `409 learning_busy` (learning work in flight; each names what in `details.runs`) leave the agent refusing runs, as does `503 unavailable` while something it owns elsewhere is not deleted there yet: a trigger's registration upstream (Composio), a saved sign-in at its vendor, its own computer at its provider, its Archil disk (Archil failing or not reached, a run of another agent on it, or Archil off on this server), or a run's folder on a disk its launch named (Archil failing, a computer still holding the folder, or Archil off), or a trigger that reached the agent after its triggers were removed. Each is deleted there before the record here that names it, so none is left behind: send the `DELETE` again, which also finishes a delete that stopped part way.",
      parameters: [AGENT_ID],
      responses: { "204": { description: "Deleted, or purged." }, ...errors(401, 403, 404, 409, 429, 500, 503) },
      "x-agentrun-serve": "agentdelete/1",
    },
  },
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
      description: "Readable without a credential: the store opens and the data directory's disk is above its floor. 503 with the same shape when either fails. While the server is still starting (it listens before it has loaded and opened its store), 503 with `status` `warming` and `checks.store` `opening`, and a Retry-After; every other request then answers 503 `unavailable`, retryable.",
      responses: {
        "200": json(HEALTH, "Healthy."),
        "503": json(HEALTH, "Not healthy: which check failed; or warming, still starting."),
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
        LABEL_PARAMETER,
      ],
      responses: { "200": json(ref("schemas/RunList"), "One page of runs, newest first."), ...errors(400, 401, 429, 500) },
    },
    post: {
      operationId: "createInlineRun", tags: ["runs"], summary: "Start a run of an agent another system owns, given inline",
      description: "Starts a run as POST /agents/{agent_id}/runs does, with that route's run fields, checks and answer, of an agent given inline: `definition` (with `skills` and `note`) as POST /agents takes one and checked as it checks one, in its words, and `external`, the agent's reference in the system that owns it. The agent here is one per `external` source, kind and id, made by its first run; its revision is one per `external.version`, made by that version's first run and made current then, which also brings the agent's name and description up to it. A later run of a version reuses its revision and changes nothing. A version's definition never changes here: another definition under a version already run is `409 external_body_conflict`, nothing written, and the source publishes a new version. Two first runs at once make one agent and one revision. The agent is read-only here (its edits, current revision and archive are `403 forbidden`); it is read, run, learns and is triggered as any agent. `revision` is not taken: the run runs its version's. The run reads, on every read route, as a run of an agent made with POST /agents.",
      parameters: [ref("parameters/IdempotencyKey")],
      requestBody: { required: true, content: { "application/json": { schema: ref("schemas/RunCreateInline") } } },
      responses: {
        "202": { description: "The run, accepted, as POST /agents/{agent_id}/runs answers it. Follow it on its timeline.", headers: { Location: ref("headers/Location"), "Idempotent-Replayed": ref("headers/IdempotentReplayed") }, content: { "application/json": { schema: ref("schemas/Run") } } },
        ...errors(400, 401, 409, 422, 429, 500, 503),
      },
      "x-agentrun-serve": "inlineagent/1",
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
                  mcp_pin: { ...MCP_PIN, description: "The MCP tools this revision grants, as its save pinned them: every run of it calls these. Null when it grants none." },
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
  "/agents/{agent_id}/package": {
    get: {
      operationId: "getAgentPackage", tags: ["local"], summary: "The agent's current revision as a template package",
      description: "The reverse of `POST /templates/{template}/apply`: the files of a package (`agent.md`, `skills/`, `rules/`, an output schema) that applies on any AgentRun as this agent. `agent.md` always names the model and approvals, and carries the harness, typed inputs, budget, learning, the computer it needs (a shell, or none) and the programs its sandbox must have, the secrets it names (the key names its package declared, as its apply kept them) and its MCP needs; its body is the instructions. Each MCP tool it is granted is written as a need of its saved server's source and toolkit, and its triggers as bodies with no agent and no secret. What names this server is left out: its box, its computer's provider, its pins of this server's tool listings, its place. Every file is read back as an import reads a package before it is answered. `report.blocked` names what would keep the package from working elsewhere (an MCP server saved nowhere here, one on this machine's loopback, one that sends its own auth header, a pin on a tool a package can't pin, a bash policy over shell tools granted without bash, an input schema a package can't say, and each field the export would copy as it is that holds a credential in the clear: a trigger's source, such as a feed URL's `?token=`, its input, or an MCP tool's pin, read as a composio trigger's config is sealed): the files leave each out, and `agentrun export` writes none of them. `report.remade` names what the target sets up again (a webhook, GitHub, Composio or email trigger, a trigger that messages one of its runs, a browser sign-in, a paired computer, a computer this server gives, what the agent learned here). `sha256` is hex over the files sorted by path, each written as path, a NUL byte, its bytes, a NUL byte. `409 not_exportable` for an agent whose source is elsewhere (a native, CLI learning, SDK or another system's agent), a workflow, or one with no revision.",
      parameters: [ref("parameters/AgentId")],
      responses: {
        "200": json(closed({
          name: { type: "string", description: "The package's name: the template it was applied from, else the agent's name as a package name." },
          files: { type: "array", items: AGENT_PACKAGE_FILE, description: "Sorted by path." },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          report: closed({ blocked: { type: "array", items: EXPORT_NOTE }, remade: { type: "array", items: EXPORT_NOTE } }),
        }), "The package, and what of the agent it does not carry as it is here."),
        ...errors(401, 404, 409, 429, 500),
      },
      "x-agentrun-serve": "export/1",
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
        { name: "agent", in: "query", required: false, description: "One agent's runs and associated source usage, or a connected session id to select that session's usage (with no recorded runs).", schema: ref("schemas/Id"), "x-agentrun-serve": "stats/2" },
      ],
      responses: { "200": json(STATS, "The counts and the cost."), ...errors(400, 401, 429, 500) },
      "x-agentrun-serve": "stats/1",
    },
  },
  "/capacity": {
    get: {
      operationId: "getCapacity", tags: ["capabilities"], summary: "The runs waiting and held, the live runners and the recent hand-backs",
      description: "Read from the store alone, so a server with no runner beside it (`--no-runner`, `AGENTRUN_API_ONLY=1`) answers for every runner on its store: what an operator or a scaler reads to size the runners. Counts, runner names and versions only, never a run, an agent or an address.",
      parameters: [
        { name: "window", in: "query", required: false, description: "The hand-back window in minutes, from 1 to 1440. Default 15.", schema: { type: "integer", minimum: 1, maximum: 1440 } },
      ],
      responses: { "200": json(CAPACITY, "The capacity, read now."), ...errors(400, 401, 429, 500) },
      "x-agentrun-serve": "capacity/1",
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
  "/runs/{run_id}/trace": {
    get: {
      operationId: "getRunTrace", tags: ["runs"], summary: "A run's trace: each model request and tool call, with its time, tokens and cost",
      description: "Each model request that answered and each tool call of the run as one span: when it started and ended, how it ended, a request's model, tokens (input, cache read, cache write, output) and cost, and a call's tool, the head of its arguments and output, and what was charged under it. Readable while the run goes: read it again to see new spans. Its words are the run's Timeline's, cut the same way. 403 `forbidden` while this server can't read the browser sign-in the run was handed, as its graph answers. A trace says only what the run's record keeps: see `model_requests`.",
      parameters: [ref("parameters/RunId")],
      responses: { "200": json(RUN_TRACE, "The run's spans as they stand."), ...errors(401, 403, 404, 429, 500) },
    },
  },
  "/runs/{run_id}/usage": {
    get: {
      operationId: "getRunUsage", tags: ["runs"], summary: "What a run cost, by model, by who charged for its tools, and by browser provider",
      description: "One run's cost, line by line: its model requests by model (and the provider they went to, where this server sent them itself), its paid tool calls by who charged for them, and its browser time by provider. Each line has its quantity as measured, its dollars as the run's booking holds them, and how those were reached (`basis`). This server prices nothing here: the lines are the charges `cost.usd` already joins, so they add up to the run's `cost.usd` (`total`), and a charge no one knows is null, never $0. It reads the same for every kind of run that books its cost: an agentic run on any harness that sends its model requests through this server, and a workflow run with its decisions. Learning's spend for the run is not here: its end-of-run learning turn is this server's work for the agent, which `cost.usd` leaves out too; it is on the run read's `learning_usd`. While the run works, and for a run the server cannot split, `lines` is null and `reason` says why. A name on a line (a model, a provider, a charger) is cut of this server's secrets and the sign-ins the run was handed, as the run's trace is; 403 `forbidden` while this server can't read the browser sign-in the run was handed, as its trace answers.",
      parameters: [ref("parameters/RunId")],
      responses: { "200": json(RUN_USAGE, "The run's usage lines, or why it has none."), ...errors(401, 403, 404, 429, 500) },
      "x-agentrun-serve": "runusage/1",
    },
  },
  "/runs/{run_id}/browser": {
    get: {
      operationId: "getRunBrowser", tags: ["runs"], summary: "Watch the run's browser live and take it over: its viewer link, for the owner",
      description: "The live view of the run's browser session: `live` with `viewer`, a link on this server (`/v2/runs/{run_id}/browser/live/v/<id>#t=<token>`) to open, or frame, in the console, while a session is open; `none` when the run has a browser but no session is open (or its process is gone); `off` when the run has no browser at all, with `reason`: its agent has no browser tool, or its browser resolves unavailable here (the tool plane's words, as capabilities give them). The viewer watches until its Take over, then drives until its Hand back (features.browser_live): outside a hold the run drops its input. The token, in the link's fragment, opens that one session's view, and drives it once taken over: it dies when the session is released, and a second viewer of the same session is refused (viewer_in_use). The viewer's page is served under the link's path with `frame-ancestors 'self'`, and its WebSocket is taken only from this server's own origin (or its public address, AGENTRUN_PUBLIC_URL). It takes the owner's password session in the console: never a token, which a run's process, an MCP client or a script may hold (403); no credential is 401. The vendors' own live-view links never leave the run's process.",
      parameters: [ref("parameters/RunId")],
      responses: {
        "200": json({ oneOf: [closed({ state: { const: "off" }, reason: { type: "string", description: "Why the run has no browser, in plain words." } }), closed({ state: { const: "none" } }), closed({ state: { const: "live" }, viewer: { type: "string", description: "The viewer's link on this server, its token in the fragment." } })] }, "The run's live view, none open, or no browser."),
        ...errors(401, 403, 404, 429, 500),
      },
      "x-agentrun-serve": "liveview/1",
    },
  },
  "/runs/{run_id}/browser/hand-back": {
    post: {
      operationId: "handBackRunBrowser", tags: ["runs"], summary: "Answer the agent's ask for you in its browser",
      description: "When a run's agent asks for the person in its browser (its `browser_request_handoff` tool), the run reads input_required/waiting with `pending.kind` `browser` (what it asks, when it is done, when the ask expires), its timeline shows \"Waiting for you: <instruction>\", and `run.needs_input` fires. The owner does it in the live view (GET /runs/{run_id}/browser: Take over, then Hand back) and answers here: `done` when it is done, `cancelled` when they will not. The first answer wins: the same answer again is 200, a different one 409 `handoff_answered` (`details.outcome`, the answer it has); an ask unanswered 15 minutes has expired, and an answer after that is 409 with `outcome` `expired`. Any answer hands the browser back to the agent, ending a take-over. 404 when the run's agent has asked for nobody. It takes the owner's password session in the console: never a token (403); no credential is 401. The person's time is held under the run's cap from the ask (the next 15 minutes of session time at the provider's price): with no room the agent is told so and no ask is made.",
      parameters: [ref("parameters/RunId")],
      requestBody: { required: true, content: { "application/json": { schema: closed({ outcome: { enum: ["done", "cancelled"], description: "`done`: the person did what the agent asked; `cancelled`: they will not." } }) } } },
      responses: {
        "200": json(closed({ outcome: { enum: ["done", "cancelled"], description: "The answer the agent gets." } }), "The answer, the first one."),
        ...errors(401, 403, 404, 409, 422, 429, 500),
      },
      "x-agentrun-serve": "liveview/2",
    },
  },
  "/runs/{run_id}/computer/take-over": {
    post: {
      operationId: "takeOverRunComputer", tags: ["runs"], summary: "Take over the run's desktop or phone",
      description: `The owner takes the run's desktop or phone: a row the run's runner applies. The take is \`pending\` while the agent's call in flight finishes (never cut in half), then the owner's (\`person\`); the agent's screen, input and phone calls wait meanwhile. At the hand-back a look (a screenshot, the app list) runs on the screen as the owner left it; an act (input, a tap, a swipe, typing, opening an app) is not done, and the agent is told the person had the computer and to look again. The take goes back to the agent on its own after ${TAKE_OVER_MINUTES} minutes with no input from the owner, when the live view closes, or when the computer's session ends. Taking one already pending or taken is the same answer, and writes nothing. 404 when the run has no desktop or phone; 409 \`computer_not_live\` when it is not up now. The run stays working. It takes the owner's password session in the console: never a token (403). On an API-only server (AGENTRUN_API_ONLY=1), which has no owner, it takes the server's token, the backend's own.`,
      parameters: [ref("parameters/RunId")],
      requestBody: { required: false, content: { "application/json": { schema: closed({}) } } },
      responses: { "200": json(COMPUTER_ANSWER, "Who drives now: pending until the agent's call in flight ends, then the person."), ...errors(401, 403, 404, 409, 422, 429, 500) },
      "x-agentrun-serve": "computer/1",
    },
  },
  "/runs/{run_id}/computer/hand-back": {
    post: {
      operationId: "handBackRunComputer", tags: ["runs"], summary: "Hand the run's computer back to the agent, or answer its ask for the owner",
      description: "Every kind of computer. A desktop or a phone: when the run's agent asked for the owner (its `computer_request_handoff` tool; the run reads input_required/waiting), this answers the ask: `outcome` `done` (the default) or `cancelled`, and a take in force ends with it. Otherwise it ends the owner's take, and the agent's waiting calls go on. A browser: this answers its agent's ask as POST /runs/{run_id}/browser/hand-back does, the one answer either route gives. A row the run's runner applies; the first hand-back wins, decided at the write: a second hand-back of the same take, or one after the take went back another way (no input, the live view closed, the computer's session ended), is 409 `handoff_answered` in words; for an ask, the same answer again is that answer and a different one is 409 (`details.outcome`), as is an answer after the ask expired. 404 when the agent asked nothing and nobody took the computer. It takes the owner's password session in the console: never a token (403). On an API-only server (AGENTRUN_API_ONLY=1), which has no owner, it takes the server's token, the backend's own.",
      parameters: [ref("parameters/RunId")],
      requestBody: { required: false, content: { "application/json": { schema: closedWith({}, { outcome: { enum: ["done", "cancelled"], description: "The answer to the agent's ask: `done` when the person did what it asked, `cancelled` when they will not. Absent: done." } }) } } },
      responses: { "200": json(COMPUTER_ANSWER, "Who drives now, and the answer the agent gets when this answered its ask."), ...errors(401, 403, 404, 409, 422, 429, 500) },
      "x-agentrun-serve": "computer/1",
    },
  },
  "/runs/{run_id}/computer/viewer": {
    post: {
      operationId: "createRunComputerViewer", tags: ["runs"], summary: "Mint a link to the run's live view for the backend's user",
      description: `An API-only server's (AGENTRUN_API_ONLY=1): the backend in front of it, with the server's token, asks for a link its user's browser opens, which has no owner's session here. \`url\` is on this server's public address (AGENTRUN_PUBLIC_URL; 501 \`unsupported_here\` when it is unset): the run's open viewer's page, a viewer credential in its query and the viewer's token in its fragment. The credential is bound to this run and lasts ${VIEWER_CREDENTIAL_MS / 60_000} minutes (\`expires_at\`): it opens this run's live page, its files and its WebSocket, from the public address alone (another Origin is 403), and nothing else; the page's answer keeps it in a cookie on the live view's path for its files and socket. Within it the person watches, and takes over and hands back in the viewer's own bar, as the owner's page does. The run's end (completed, failed or cancelled) revokes it on every server on the store, and closes a socket open on it; a stop (input_required) does not, since the run goes on with its next message. A socket opened in time stays open past the minutes, until the run ends. 409 \`computer_not_live\` when the run has ended or its computer has no live view open now (GET /runs/{run_id}/computer reads live once it does). On a server that is not API-only this route is 404: its owner opens the live view in the console.`,
      parameters: [ref("parameters/RunId")],
      requestBody: { required: false, content: { "application/json": { schema: closed({}) } } },
      responses: {
        "201": json(closed({
          url: { type: "string", format: "uri", description: "The link to open: `<AGENTRUN_PUBLIC_URL>/v2/runs/{run_id}/computer/live/v/<id>?viewer=<credential>#t=<token>`." },
          expires_at: { type: "string", format: "date-time", description: "When the credential stops opening the page and its socket." },
        }), "The link, and when its credential expires."),
        ...errors(401, 404, 409, 422, 429, 500, 501),
      },
      "x-agentrun-serve": "computer/1",
    },
  },
  "/runs/{run_id}/start": {
    post: {
      operationId: "startRun", tags: ["runs"], summary: "Start a held run's agent",
      description: "A run started with `hold: true` waits, its computer up and held, until this starts its agent on its input. A row the run's runner applies: answered once the agent is started. 404 for a run that holds no computer; 409 `computer_not_live` when its computer is not up yet (`computer.held.state` starting), its agent already started, or the computer was let go; 503 when no runner took the row within a minute. The owner's: the server's token or the owner's session. A run never holds the server's token.",
      parameters: [ref("parameters/RunId")],
      requestBody: { required: false, content: { "application/json": { schema: closed({}) } } },
      responses: { "200": json(HELD_ANSWER("started"), "The agent is started."), ...errors(401, 404, 409, 422, 429, 500, 503) },
      "x-agentrun-serve": "held/1",
    },
  },
  "/runs/{run_id}/computer/call": {
    post: {
      operationId: "callRunComputer", tags: ["runs"], summary: "Send a run's computer one protocol call",
      description: `One call of the computer protocol (spec/computer) on a running run's computer: a sandbox, a desktop or a phone. A run that holds its computer (\`hold: true\`) takes calls before its agent starts, while it runs, and after it ended until the release; each call starts the hold's \`hold_minutes\` again. The answer is the computer's, verbatim: \`{ok: true, value}\` or \`{ok: false, error: {code, message, data?}}\`, the method's result or error as the protocol defines it. A row the run's runner answers, behind the owner's take-over as the agent's calls are: while a person holds the desktop or phone, the call waits for the hand-back. A call runs ${CALL_MS / 1000} seconds at most, its wait included (then \`{ok: false, error: {code: "timeout"}}\`). The run's record keeps each call's method, outcome and time, never its params or its answer's bytes. \`method\` is one of the protocol's methods (422 otherwise). 404 for no such run; 409 \`computer_not_live\` when the run is not running, has no computer that takes calls, or let its computer go; 503 when no runner took the row in time. The owner's: the server's token or the owner's session. A run never holds the server's token, so its agent drives its computer through its own tools alone.`,
      parameters: [ref("parameters/RunId")],
      requestBody: {
        required: true,
        content: { "application/json": { schema: closedWith({ method: { enum: [...PROTOCOL_METHODS], description: "The protocol method." } }, { params: { type: "object", additionalProperties: true, description: "The method's params. Absent: {}." } }) } },
      },
      responses: {
        "200": json({
          oneOf: [
            closed({ ok: { const: true }, value: { description: "The method's result." } }),
            closed({ ok: { const: false }, error: { type: "object", additionalProperties: true, required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } }, description: "The computer's error: its code, its words and its data." } }),
          ],
        }, "The computer's answer."),
        ...errors(401, 404, 409, 422, 429, 500, 503),
      },
      "x-agentrun-serve": "channel/1",
    },
  },
  "/runs/{run_id}/computer/release": {
    post: {
      operationId: "releaseRunComputer", tags: ["runs"], summary: "Let a held run's computer go",
      description: "The owner is done with the computer a run holds (`hold: true`). After the agent's end the run then ends as its agent did, and its computer goes with it; before the start, the run ends cancelled, its agent never run; while the agent runs, the run no longer waits after its end. A row the run's runner applies. 404 for a run that holds no computer, and for one already let go (released, timed out, or the run is over); 409 `computer_not_live` when it is not up yet; 503 when no runner took the row within a minute. The owner's: the server's token or the owner's session.",
      parameters: [ref("parameters/RunId")],
      requestBody: { required: false, content: { "application/json": { schema: closed({}) } } },
      responses: { "200": json(HELD_ANSWER("released"), "The computer is let go."), ...errors(401, 404, 409, 422, 429, 500, 503) },
      "x-agentrun-serve": "held/1",
    },
  },
  "/runs/{run_id}/computer": {
    get: {
      operationId: "getRunComputer", tags: ["runs"], summary: "Watch the run's computer live and take it over: its viewer link, for the owner",
      description: "The live view of the run's computer, one family for every kind (`browser`, `desktop`, `phone`: the run's agent's computer). `live` with `viewer`, a link on this server (`/v2/runs/{run_id}/computer/live/v/<id>#t=<token>`) to open, or frame, in the console, while a viewer is open; `none` when the run has a computer but no session is up, with `session` saying whether the run hasn't opened it, is opening it, or opened one that closed; `off` when there is no computer view here (its agent has none, its computer is a sandbox, which has no screen, or its computer resolves unavailable here), with `why` in plain words. `kind` is the run's computer, on every answer but `off`. `hold` says who drives now: `agent`; `pending`, the person's Take over waits for the agent's step; `person`. The viewer watches until its Take over, then drives until its Hand back, both in the viewer's own bar: outside a hold the run drops its input. The token is in the link's fragment alone, never in a request line, a Referer or a log; the viewer's page sends it once, in its WebSocket hello. It opens that one session's view, and drives it once taken over: it dies with the computer (its release), the run's end, or the owner's sign-out (the socket closes), and a second viewer of the same session is refused (viewer_in_use). The viewer's page is served under the link's path with `frame-ancestors 'self'`, and its WebSocket is taken only from this server's own origin (or its public address, AGENTRUN_PUBLIC_URL) with the owner's cookie. It takes the owner's password session in the console: never a token, which a run's process, an MCP client or a script may hold (403); no credential is 401. On an API-only server (AGENTRUN_API_ONLY=1), which has no owner, it takes the server's token, and the link opens only with the viewer credential POST /runs/{run_id}/computer/viewer mints. The vendors' own live-view links never leave the run's process.",
      parameters: [ref("parameters/RunId")],
      responses: {
        "200": json({ oneOf: [closedWith({ state: { const: "off" }, hold: COMPUTER_HOLD }, { why: { type: "string", description: "Why there is no computer view here, in plain words." } }), closedWith({ state: { const: "none" }, kind: RUN_COMPUTER_KIND, hold: COMPUTER_HOLD, session: { type: "string", enum: ["unopened", "opening", "closed"], description: "Where the run's computer is, read from the run's journal: `unopened`, the run hasn't opened it so far (a browser opens at the agent's first browser step); `opening`, it is being opened now (a browser step that opens it has no result yet; a desktop or a phone from the run's start until it is up); `closed`, the run opened one, which is not up now (a parked run's desktop or phone, kept for the run's resume: the run's timeline says until when; `ended` says why when it was let go while the run waited for its person)." } }, { ended: { type: "object", additionalProperties: false, required: ["at", "why"], description: "A going run's computer let go while the run waited for its person, with none opened since: the words and when. A browser: its window (AGENTRUN_BROWSER_PERSON_WAIT_MIN) ran out, the cap ended it, or its provider ended the session, in the Timeline row's words; the next browser call, once the run goes on, opens a new one. A parked run's desktop or phone kept at its park: its 10 minutes passed (\"The desktop wasn't kept: 10 minutes passed. A new one starts when the run goes on.\"), at the time they did; the run's next claim starts a new one.", properties: { at: { type: "string", format: "date-time" }, why: { type: "string" } } } }), closed({ state: { const: "live" }, kind: RUN_COMPUTER_KIND, viewer: { type: "string", description: "The viewer's link on this server, `/v2/runs/{run_id}/computer/live/v/<id>#t=<token>`: its token in the fragment alone." }, hold: COMPUTER_HOLD })] }, "The run's live view, none open, or no computer here."),
        ...errors(401, 403, 404, 429, 500),
      },
      "x-agentrun-serve": "computer/1",
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
    delete: {
      operationId: "deleteRun", tags: ["runs"], summary: "Purge a run's content and keep its cost",
      description:
        "Purges a run that is not live: what it was given and what it did go, what it cost stays. Gone: its launch record (its input and prompt), its journal and timeline, its messages and commands, its outputs and files, the answers kept under its idempotency keys, its folders (on this machine, and its own folder on an Archil disk, its agent's or one its launch named; the disk and everything else on it are kept), its settings, the grades its agent keeps of it, and its kept learning's content (its learning's end, merged or dropped, stays, as `/stats` counts it). Its row stays as its tombstone: every route of it answers `410 purged` with `details` {run_id, agent_id, state, started_at, ended_at, cost_usd, cost_upper_bound, tools_usd, purged_at}, and no run list shows it. `/usage`, `/stats` and the spend a cap reads sum it as before: no total moves. The runs made from it are purged with it, each the same way: its audit's shadow run, the replay runs of its input and a learning run its kept learning names. Once it is purged, no replay or shadow run of it is started. Its agent, the agent's other runs and what its agent learned are kept: a promotion record keeps its decision, numbers and run ids (the run's among them), and what it copied from the run (a disagreement's input and answers, the grader's words, and the words a hold's reason quoted from them) is blanked. A run's purge removes its diff files and its feedback lines from the folder's current files and puts each learned workflow whose workflow.json it changed last back to the version before it, the newest no purged run wrote (off main when it wrote it new), and the folder's history no longer serves its merge; the bytes stay in the folder's .git until a learning reset (DELETE /v2/agents/{id}/learning) or the agent's purge, which delete the folder whole. `204` when it is purged; a second `DELETE` is `204` too, and takes off what is left of its text in the learning folder; a run this server never had is `404`. Live (queued, working, waiting on a person or an approval, or held by a runner): `409 run_not_final` (`details.runs`, the run or each run made from it that is live, or a replay or shadow run of it a check or an audit started while the `DELETE` ran, which the next `DELETE` purges first), nothing purged; cancel it first (`POST /runs/{run_id}/cancel`). A run that ended and takes a follow-up (`idle`), or that a person stopped, is not live; one that reads so before its runner has written it ended is waited for (up to 30 seconds), then purged. `503 unavailable` while its folder on an Archil disk is not deleted there yet (Archil failing or off, a computer still holding the folder), or while its agent's learning folder can't be written: the run is not purged (or, purged before, keeps its text in that folder), and the `DELETE` sent again finishes it, as it finishes a purge that stopped part way. Takes the owner's session (the password sign-in, or the console on a server bound to loopback) or the API token: any other console session is `403 forbidden`.",
      parameters: [ref("parameters/RunId")],
      responses: { "204": { description: "Purged, now or before. A run's purge removes its diff files and its feedback lines from the folder's current files and puts each learned workflow whose workflow.json it changed last back to the version before it, the newest no purged run wrote (off main when it wrote it new), and the folder's history no longer serves its merge; the bytes stay in the folder's .git until a learning reset (DELETE /v2/agents/{id}/learning) or the agent's purge, which delete the folder whole." }, ...errors(401, 403, 404, 409, 429, 500, 503) },
      "x-agentrun-serve": "purge/1",
    },
    patch: {
      operationId: "raiseRunCap", tags: ["runs"], summary: "Raise a run's spend cap",
      description: "Raises `max_cost_usd` of a run that named one, agentic or workflow; only a raise: the new cap is above the run's current cap, its last raise included (422 otherwise, and for a run with no cap); the same raise sent again (a retry) changes nothing and answers as the first did. The run's serve.json keeps it before anything else, so its next process and a server started again run under it. A run paused at its cap (`pending.kind` budget) goes on: the answer comes at once (`resumed` true, its `message_id`), and once its process has been let go the server sends it one follow-up turn under that id, \"The cap was raised to $X; continue the task.\", which runs under the new cap; it is sent once, by a server started again if this one stopped before it went. A second raise before it goes answers the same `message_id`; one that cannot be sent is tried again, then the run ends failed, saying why. Caps within 1e-9 are the same cap. A run working holds the new cap from its next step; a step already under way keeps the cap it was admitted at (`note` says so). A workflow run takes no follow-up: paused at its cap, the step that waits there is judged again under the new cap in its process, or, once the pause let its process go (10 minutes on), the run is opened again under it and resumes from its journal, sending no completed node again (`resumed` true, no `message_id`); a working one's process holds the new cap from its next check. 409 not_continuable for an ended run, and for a run a person stopped (send it a message to go on, then raise its cap).",
      parameters: [ref("parameters/RunId")],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["max_cost_usd"], properties: { max_cost_usd: { type: "number", exclusiveMinimum: 0, description: "The new cap, above the run's current cap." } } } } } },
      responses: {
        "200": json({ type: "object", additionalProperties: false, required: ["run_id", "max_cost_usd", "resumed", "status", "state"], properties: {
          run_id: { type: "string" }, max_cost_usd: { type: "number" }, resumed: { type: "boolean", description: "A run paused at its cap goes on: its follow-up turn is sent once its process has been let go." },
          message_id: { type: "string", description: "That follow-up's id, when `resumed`." }, note: { type: "string", description: "Said when the run is working: the raised cap holds from its next step, and a step already under way keeps the cap it was admitted at." },
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
      responses: { "200": json(PAUSED, "The run, paused."), ...errors(401, 404, 409, 429, 500, 501) },
    },
  },
  "/runs/{run_id}/resume": {
    post: {
      operationId: "resumeRun", tags: ["runs"], summary: "Resume a paused workflow run",
      description: "501 unsupported_here for an agentic run, which never pauses here; 409 not_continuable for an ended one.",
      parameters: [ref("parameters/RunId")],
      responses: { "200": json(PAUSED, "The run, going again."), ...errors(401, 404, 409, 429, 500, 501) },
    },
  },
  "/computers": {
    get: {
      operationId: "listComputers", tags: ["local"], summary: "Settings → Computers: the kinds of computer this server offers, each provider and whether its keys are saved",
      description: "Each kind an agent's `computer` may name (none, sandbox, desktop, phone, browser): whether this server offers it now and why not, the capability groups and model tools it brings, and each provider that serves it, with its key names and whether each is saved (never a value), whether it is metered, and whether a run could have it here now. A sandbox holds the run's folder: on this server's own disk (Mode 1) only a provider that binds a local folder serves it; on the owner's Archil disk (Mode 2, PUT /workspace/archil) only one that mounts the disk.",
      responses: { "200": json(COMPUTERS_VIEW, "The kinds, each with its providers."), ...errors(401, 429, 500) },
      ...COMPUTER_MARK,
    },
  },
  "/computers/running": {
    get: {
      operationId: "listRunningComputers", tags: ["local"], summary: "Every run still going that has a computer",
      description: "Each run that is queued, working, paused or waiting on its person and whose agent has a computer (a sandbox, a desktop, a phone or a browser), as GET /runs/{run_id} answers it: its `computer` says the kind and provider, `starting`, `ready` or `taken_over`, and a held run's hold. The runs list carries no computer, so this is the one read of the computers up across runs and agents. It costs a run read for each such run and nothing for a run with no computer. An agent's own computer kept between runs is on the agent's read (`own_computer`), and a paired computer on GET /computers (`paired`); neither is a run here.",
      responses: { "200": json(RUNNING_COMPUTERS, "The runs still going that have a computer, newest first."), ...errors(401, 429, 500) },
      ...COMPUTER_MARK,
    },
  },
  "/computers/{provider}/keys": {
    put: {
      operationId: "saveComputerKeys", tags: ["local"], summary: "Save a computer provider's keys, sealed",
      description: "Each key the provider declares (GET /computers names them) is sealed under the server's seal key; null removes one. Saving or removing a key is a secret write: it takes the owner's signed-in session, and the API token is 403. A name it does not declare, a value that is not a non-empty string, or any key on a server with no seal key is 422 input_invalid with its fields, and nothing is saved. The answer is the provider as GET /computers shows it: never a value.",
      parameters: [PROVIDER_PARAM],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: { type: ["string", "null"], "x-agentrun-secret": true }, description: "The provider's key names, each its value, or null to remove it." } } } },
      responses: { "200": json(COMPUTER_PROVIDER, "The provider, its keys saved or not."), ...errors(401, 403, 404, 422, 429, 500) },
      ...COMPUTER_MARK,
    },
  },
  "/computers/{provider}/test": {
    post: {
      operationId: "testComputer", tags: ["local"], summary: "Test a computer provider's account with its saved keys",
      description: "One account-level read with the provider's saved keys (a list by label, the vendor's own check): it never makes a computer, so it never spends. ok with what it read; else why, in plain words naming what to check (a key not saved, a key the vendor refused, a vendor not reached), never a key. A provider whose row says `runs_refused` (its machines dial this server, and this server's runner runs in a process of its own) fails in those words, with no call to the vendor.",
      parameters: [PROVIDER_PARAM],
      responses: { "200": json(ACCOUNT_TEST, "The test's answer."), ...errors(401, 404, 429, 500) },
      ...COMPUTER_MARK,
    },
  },
  "/computers/{provider}/choices": {
    get: {
      operationId: "listComputerChoices", tags: ["local"], summary: "The values a computer provider's picked keys offer, read from the vendor",
      description: "Each key the provider lists under `picked` (GET /computers), with the values the vendor's own list offers for it, read with the provider's saved keys (Orgo's workspaces, each its id and its name): it never makes a computer. A person picks one, and PUT /computers/{provider}/keys saves its value under the key. Where there is none to pick, `why` says so in plain words (a required key not saved, an account with none), never a key. A provider with no picked key answers an empty list.",
      parameters: [PROVIDER_PARAM],
      responses: { "200": json(COMPUTER_CHOICES, "Each picked key's choices, or why there are none."), ...errors(401, 404, 429, 500) },
      ...COMPUTER_MARK,
    },
  },
  "/computers/pairings": {
    post: {
      operationId: "createPairing", tags: ["local"], summary: "A code that pairs a person's own computer with this server",
      description: `Settings → Computers → Pair a computer. A new code of eight letters and digits (two groups of four, no 0, O, 1 or I), good once for ${PAIRING_CODE_TTL_MS / 60_000} minutes: the person types it, with this server's address, into the driver on their computer, which trades it for its own token (POST /computers/pair). The server keeps the code's SHA-256, never the code. A new code does not cancel an older one.`,
      responses: { "201": json(PAIRING, "The code, and when it expires."), ...errors(401, 429, 500) },
      ...ATTACH_MARK,
    },
  },
  "/computers/pair": {
    post: {
      operationId: "pairComputer", tags: ["local"], summary: "A driver trades a pairing code for its computer's token (no token: the code is the credential)",
      description: `The driver on a person's own computer sends the code the console showed, the computer's name and its own hello. The code must exist, be unused and be unexpired: it is then used up, and the computer is paired. A wrong, used or expired code is 404, with no word about which; each source address gets ${PAIR_TRIES_PER_MINUTE} tries a minute (429 past them, with Retry-After). A hello of another protocol version than the server's (${PROTOCOL_VERSION}) is 422 in words that say which side to update, and the code stays good; so is a hello that serves no kind of computer (a desktop that declares no input.pointer and input.keys groups, say), which no agent could pick, in words that name what the driver lacks. The token is shown only in this answer: the driver keeps it in the OS's keychain and dials GET /computers/attach with it. It has no expiry; it ends when the computer is removed (DELETE /computers/{computer_id}). The server keeps its SHA-256 alone.`,
      security: [],
      requestBody: { required: true, content: { "application/json": { schema: PAIR_REQUEST } } },
      responses: { "201": json(PAIRED_TOKEN, "The computer's id and its token."), ...errors(404, 422, 429, 500) },
      ...ATTACH_MARK,
    },
  },
  "/computers/attach": {
    get: {
      operationId: "attachComputer", tags: ["local"], summary: "The attach socket: a paired computer's driver dials it (a WebSocket)",
      description: `A WebSocket (spec/computer/attach.md). The driver dials it with \`Authorization: Bearer <its token>\` (POST /computers/pair) and the subprotocol \`${ATTACH_SUBPROTOCOL}\`. A hosted machine of a dial provider dials it the same way with the token its create minted (GET /computers/daemon), and its socket stands for that create's machine, whose hello must say the kind, os and arch it was made as (else 4400). A token no paired computer or hosted machine has good (unknown, its computer removed, its machine deleted or past its backstop) is 401 before the upgrade; another subprotocol is 426. Frames are text, one JSON-RPC message each, at most ${MAX_LINE_BYTES} bytes (a bigger one closes the socket with 1009, a binary frame with 1003). The server is the caller: it sends hello, and the computer is attached while its hello is what it paired as (else closed with 4400, or 4426 for another protocol version); then the server sends a run's calls. Each side pings every ${ATTACH_HEARTBEAT_MS / 1000} s, and one that hears nothing for ${ATTACH_IDLE_MS / 1000} s closes with 4408. The same computer dialing again replaces its older socket (4409); removing it closes the socket with 4401. A request with no upgrade is 400. One server process holds the socket, so a run uses a paired computer only on a runner in that process (the start's runner beside the server).`,
      responses: { "101": { description: "Switching to the attach WebSocket." }, ...errors(400, 401, 500) },
      ...ATTACH_MARK,
    },
  },
  "/computers/daemon": {
    get: {
      operationId: "getComputerDaemon", tags: ["local"], summary: "This server's computerd build, for a hosted machine that dials it (its minted token)",
      description: `A hosted machine of a provider whose host has no exec (a dial provider's) fetches its daemon here as it boots, with \`Authorization: Bearer <its token>\`: the token the machine's create minted, which its env holds (AGENTRUN_ATTACH_TOKEN). The answer is this server's own computerd build for \`arch\`, the same bytes a hosted provider uploads, whose SHA-256 the create put in the machine's env (AGENTRUN_DAEMON_SHA256) for the machine to check before it runs it. A token no machine has good (unknown, revoked at the machine's delete, or past its backstop) is 401; each machine's token gets ${DAEMON_FETCHES_PER_MINUTE} fetches a minute (429 past them, with Retry-After); an arch other than amd64 or arm64 is 422. The owner's token and session are not a machine's token: 401.`,
      security: [],
      parameters: [{ name: "arch", in: "query", required: true, description: "The machine's architecture.", schema: { type: "string", enum: ["amd64", "arm64"] } }],
      responses: { "200": { description: "The daemon's bytes.", content: { "application/octet-stream": { schema: { type: "string", contentMediaType: "application/octet-stream" } } } }, ...errors(401, 422, 429, 500, 503) },
      ...ATTACH_MARK,
    },
  },
  "/computers/{computer_id}": {
    delete: {
      operationId: "deleteComputer", tags: ["local"], summary: "Remove a paired computer: its token ends and its socket closes",
      description: "Revokes the computer's token (its next dial is 401), ends a run's hold on it (the run's next call to it fails), and closes its live socket with 4401, so the driver stops dialing and asks to be paired again. The computer itself is untouched. 404 for an id no paired computer has, or one removed already.",
      parameters: [{ name: "computer_id", in: "path", required: true, description: "The paired computer's id (GET /computers lists them under `paired`).", schema: { type: "string", minLength: 1 } }],
      responses: { "204": { description: "Removed." }, ...errors(401, 404, 429, 500) },
      ...ATTACH_MARK,
    },
  },
  "/workspace/archil": {
    get: {
      operationId: "getWorkspaceArchil", tags: ["local"], summary: "Whether run folders are on Archil disks (Mode 2), the settings, and whether its keys are saved",
      responses: { "200": json(ARCHIL_VIEW, "The Archil settings, never a key."), ...errors(401, 429, 500) },
      ...ARCHIL_MARK,
    },
    put: {
      operationId: "putWorkspaceArchil", tags: ["local"], summary: "Turn Mode 2 on: run folders on Archil disks, one per agent",
      description: "Replaces the Archil settings (the account key's region and its S3 URL, and an exec image pinned by digest when given) and seals the account key (ARCHIL_API_KEY) under the server's seal key when given; null removes it, and a key not given is kept. There is no server-wide disk: each agent gets its own, made in this region on its first run that uses it (`agentrun-<server id>-i-<agent id>`), and a run may name another (`archil_disk` on its start), so `diskId` is refused. No disk token is kept: a computer's mount credential is minted per run from the account key, so ARCHIL_DISK_TOKEN is refused like any field Archil does not take. Any PUT here is a secret write, whatever its body: it takes the owner's signed-in session, and the API token is 403, since the region and S3 URL say where every run's files go. A field that is not right, or an image not pinned by digest, is 422 input_invalid with its fields, and nothing is saved. While the server's environment sets the settings (GET's `source` is `env`), it is 409 key_set_by_server naming its variables, and nothing is saved. The answer never holds a key.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: closedWith({ region: { type: "string", minLength: 1 }, s3Url: { type: "string", format: "uri", pattern: "^https://" } }, {
          image: { type: "string", pattern: "^[^\\s@]+@sha256:[0-9a-f]{64}$" },
          keys: { type: "object", additionalProperties: false, properties: Object.fromEntries(ARCHIL_KEY_NAMES.map((name) => [name, { type: ["string", "null"], minLength: 1, "x-agentrun-secret": true }])) },
        }) } },
      },
      responses: { "200": json(ARCHIL_VIEW, "The Archil settings, saved."), ...errors(401, 403, 409, 422, 429, 500) },
      ...ARCHIL_MARK,
    },
    delete: {
      operationId: "deleteWorkspaceArchil", tags: ["local"], summary: "Turn Mode 2 off: run folders on this server's own disk",
      description: "Removes the Archil settings. Its saved keys, and each agent's disk, are kept, for turning it on again. While the server's environment sets the settings (GET's `source` is `env`), it is 409 key_set_by_server naming its variables, and nothing is removed.",
      responses: { "200": json(ARCHIL_VIEW, "The Archil settings, off."), ...errors(401, 409, 429, 500) },
      ...ARCHIL_MARK,
    },
  },
  "/workspace/archil/test": {
    post: {
      operationId: "testWorkspaceArchil", tags: ["local"], summary: "Test the Archil account key at its region's control plane",
      description: "One listing of the account's disks at the region's control plane, with the saved account key. ok, or why in plain words: Archil is off, the key is not saved, Archil refused it, or Archil was not reached. Never a key.",
      responses: { "200": json(ACCOUNT_TEST, "The test's answer."), ...errors(401, 429, 500) },
      ...ARCHIL_MARK,
    },
  },
  "/agents/{agent_id}/archil": {
    get: {
      operationId: "getAgentArchil", tags: ["agents"], summary: "The agent's own Archil disk, once its first run made it",
      description: "In Archil mode each agent has its own disk, made on its first run whose launch names no `archil_disk` (never at the agent's creation), in the account key's region, named `agentrun-<server id>-i-<agent id>`. Null before that, and in Mode 1. A disk a run's launch names is the caller's (a disk per customer) and is never shown here.",
      parameters: [ref("parameters/AgentId")],
      responses: { "200": json(AGENT_ARCHIL_VIEW, "The agent's disk, or none yet."), ...errors(401, 404, 429, 500) },
      ...ARCHIL_MARK,
    },
    delete: {
      operationId: "deleteAgentArchil", tags: ["agents"], summary: "Remove an agent's own Archil disk, and everything on it",
      description: "For an archived agent, or an agent its source manages (an inline run's agent, which is never archived here), with no live run of any agent on its disk (a run of another agent may name it in `archil_disk`): its own disk is deleted at Archil (DELETE /api/disks/{id}), with its runs' folders, its home and its learning, and forgotten; the agent's next run would make a new, empty one. This frees a disk of the Archil plan's limit. The disk is marked as being removed before its live runs are counted: meanwhile a new run of the agent on it is 409 agent_not_runnable, and a run launched just before is refused at its claim. A disk a run's launch named is never touched. 412 precondition_failed for an agent of this server not archived, or a live run on the disk (the disk is the agent's again); 424 upstream_failed when Archil does not remove it (nothing is forgotten). Answers the agent's disk now (none) and what was removed.",
      parameters: [ref("parameters/AgentId")],
      responses: {
        "200": json({ ...AGENT_ARCHIL_VIEW, required: [...AGENT_ARCHIL_VIEW.required, "removed"], properties: { ...AGENT_ARCHIL_VIEW.properties, removed: { oneOf: [closed({ disk_id: { type: "string" } }), { type: "null" }], description: "The disk deleted at Archil, or null when the agent had none." } } }, "The agent's disk removed, or none to remove."),
        ...errors(401, 404, 412, 429, 500, 503),
        "424": { description: "`upstream_failed`: Archil did not remove the agent's disk (refused, or not reached); nothing is forgotten.", content: { "application/json": { schema: ref("schemas/Error") } } },
      },
      ...ARCHIL_MARK,
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
      description: "Each value is sealed under the server's seal key and kept in the data directory as ciphertext alone; the key's other fields stay as they are. The key (the first field) is first checked against its provider with one call that costs nothing, given 5 s: a key the provider refuses (401) is 422 input_invalid, its field's reason `refused_by_provider` and the message in plain words with the provider's first sentence (never any of the key), and nothing is kept; otherwise it is kept, and GET's `check` says `accepted` or `not_checked` and why (a 403 is not_checked: a key scoped away from the check's call may still work for its tools). A save whose check is still waiting when the server begins to close keeps nothing (503 unavailable, while its connection lasts). 422 also for an unknown key or field, or a value that is empty, holds a control character or is over 1024 bytes; 409 key_set_by_server for a field the server is started with. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      parameters: [KEY_ID],
      // The owner's password session alone (secret-writes.ts), never the document's bearer.
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["values"], properties: { values: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1, "x-agentrun-secret": true }, "x-agentrun-secret": true } } } } } },
      responses: { "204": { description: "Saved." }, ...errors(400, 401, 403, 409, 415, 422, 429, 500, 503) },
      "x-agentrun-serve": "toolkeys/1",
    },
    delete: {
      operationId: "deleteToolKey", tags: ["local"], summary: "Forget a tool key's stored fields",
      // A removal has no body to mark a field in: the operation is marked whole, a secret write all the same.
      "x-agentrun-secret": true,
      description: "409 key_set_by_server when the server is started with every field of it. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      parameters: [KEY_ID],
      security: [{ ownerSession: [] }],
      responses: { "204": { description: "Forgotten." }, ...errors(401, 403, 409, 422, 429, 500) },
      "x-agentrun-serve": "toolkeys/1",
    },
  },
  "/settings/harness-keys": {
    get: {
      operationId: "listHarnessKeys", tags: ["local"], summary: "The keys each plan-billed harness recipe runs on, and which are saved: names only, never a value",
      responses: { "200": json(HARNESS_KEYS_VIEW, "Each plan-billed recipe's harness and its keys."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "harnesskeys/1",
    },
  },
  "/settings/harness-keys/{harness_id}/{key}": {
    put: {
      operationId: "saveHarnessKey", tags: ["local"], summary: "Save one key of a plan-billed harness recipe, sealed, for that harness alone",
      description: "The value is sealed under the server's seal key and kept in the store as ciphertext alone, named for this harness, so no other harness's run ever gets it, nor any run's tools. The next claim of a run on the harness opens it, with no restart. A value it replaces stays sealed for the cut, so a timeline written while it was live stays cut. 404 for a harness that is not a plan-billed recipe on this server; 422 for a key its recipe does not name, or a value under 8 characters, over 1024 bytes, or holding whitespace or a control character. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      parameters: [HARNESS_ID_PARAM, HARNESS_KEY_PARAM],
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string", minLength: 8, "x-agentrun-secret": true } } } } } },
      responses: { "204": { description: "Saved." }, ...errors(400, 401, 403, 404, 415, 422, 429, 500, 503) },
      "x-agentrun-serve": "harnesskeys/1",
    },
    delete: {
      operationId: "deleteHarnessKey", tags: ["local"], summary: "Forget one key of a plan-billed harness recipe",
      // A removal has no body to mark a field in: the operation is marked whole, a secret write all the same.
      "x-agentrun-secret": true,
      description: "Its runs no longer get it; the value stays sealed for the cut. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      parameters: [HARNESS_ID_PARAM, HARNESS_KEY_PARAM],
      security: [{ ownerSession: [] }],
      responses: { "204": { description: "Forgotten." }, ...errors(401, 403, 404, 422, 429, 500) },
      "x-agentrun-serve": "harnesskeys/1",
    },
  },
  "/settings/email": {
    get: {
      operationId: "getEmailAccount", tags: ["local"], summary: "This server's email account: its address, servers and who signs in, never its password",
      description: "The one account the email trigger reads and the email tools read and send with. The owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: { "200": json(EMAIL_ACCOUNT, "The account."), ...errors(401, 403, 429, 500) },
      "x-agentrun-serve": "email/1",
    },
    put: {
      operationId: "saveEmailAccount", tags: ["local"], summary: "Save this server's email account, its password sealed",
      description: "Replaces the account. A preset fills the servers (gmail: imap.gmail.com:993 and smtp.gmail.com:465; fastmail: imap.fastmail.com:993 and smtp.fastmail.com:465; icloud: imap.mail.me.com:993 and smtp.mail.me.com:587); `other` takes both. Every connection is TLS (993 and 465 from the start, any other port with STARTTLS required), never in the clear. The password is sealed under the server's seal key and is in no answer, event or log line. Saved only once it signs in: the save signs in to IMAP and to SMTP as POST /settings/email/test does, sending nothing, and a sign-in either server refuses, or a server not reached, is 424 with nothing saved and the account kept before as it was. 422 by field for a body that does not read (before any sign-in), and outlook is refused in words. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { ...EMAIL_ACCOUNT_BODY, required: ["address", "password"] } } } },
      responses: { "200": json(EMAIL_ACCOUNT, "Saved: both servers signed in."), ...errors(400, 401, 403, 415, 422, 429, 500, 503), "424": { description: "`upstream_failed`: the account did not sign in (IMAP or SMTP refused it, or was not reached): nothing was saved, and the account kept before is as it was. The message says why in the test's words; `details.imap` and `details.smtp` are each half as POST /settings/email/test answers it ({ok, message}).", content: { "application/json": { schema: ref("schemas/Error") } } } },
      "x-agentrun-serve": "email/1",
    },
    delete: {
      operationId: "deleteEmailAccount", tags: ["local"], summary: "Forget this server's email account",
      description: "Removes the account and its sealed password. An email trigger's next check then fails, saying so, and an email tool answers that no account is saved. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: { "204": { description: "Forgotten." }, ...errors(401, 403, 429, 500) },
      "x-agentrun-serve": "email/1",
    },
  },
  "/settings/email/test": {
    post: {
      operationId: "testEmailAccount", tags: ["local"], summary: "Sign in to the email account's IMAP and SMTP servers, sending nothing",
      description: "Signs in to IMAP (INBOX opened read-only, its count said) and to SMTP (signed in and out, nothing sent), for the saved account with an empty body, or the account in the body (its password may be left out to test the saved one's with other servers). Saves nothing. Each half answers ok and its words: a refused sign-in, or a server that couldn't be reached, in words, never the password. 422 for a body that does not read, or an empty body with no account saved. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      requestBody: { required: false, content: { "application/json": { schema: EMAIL_ACCOUNT_BODY } } },
      responses: { "200": json(closed({ ok: { type: "boolean", description: "Both signed in." }, imap: MAIL_CHECK, smtp: MAIL_CHECK }), "The test's answer."), ...errors(400, 401, 403, 415, 422, 429, 500) },
      "x-agentrun-serve": "email/1",
    },
  },
  "/settings/calendar": {
    get: {
      operationId: "getCalendar", tags: ["local"], summary: "This server's calendar: its host, name and time zone, never its address",
      description: "The one calendar calendar_events reads. The owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: { "200": json(CALENDAR_VIEW, "The calendar."), ...errors(401, 403, 429, 500) },
      "x-agentrun-serve": "calendar/1",
    },
    put: {
      operationId: "saveCalendar", tags: ["local"], summary: "Save this server's calendar, its iCal address sealed",
      description: "Replaces the calendar. The address is https (webcal:// is read as https://; plain http, another scheme, or a user and password in it is refused in words), sealed under the server's seal key, and in no answer, event, log line or run input. The calendar is read once for its own name and time zone; a read that fails saves the address all the same (name and time_zone null): POST /settings/calendar/test says why. 422 by field for a body that does not read. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { ...CALENDAR_BODY, required: ["url"] } } } },
      responses: { "200": json(CALENDAR_VIEW, "Saved."), ...errors(400, 401, 403, 415, 422, 429, 500, 503) },
      "x-agentrun-serve": "calendar/1",
    },
    delete: {
      operationId: "deleteCalendar", tags: ["local"], summary: "Forget this server's calendar",
      description: "Removes the calendar and its sealed address. calendar_events then answers that no calendar is saved. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: { "204": { description: "Forgotten." }, ...errors(401, 403, 429, 500) },
      "x-agentrun-serve": "calendar/1",
    },
  },
  "/settings/calendar/test": {
    post: {
      operationId: "testCalendar", tags: ["local"], summary: "Read the calendar and say what it holds",
      description: "Reads the saved calendar with an empty body, or the address in the body (saved nowhere), as calendar_events reads it (https only; a private address refused unless its host is allowed in Settings → MCP servers; 10 MB, 20 s, 5 redirects), and answers in words: \"Work: 214 events, time zone America/New_York, next: Standup, Mon Nov 17 09:30\" (its name, its events and series, its time zone, and its next event in the next 62 days), or why it couldn't be read, never the address. 422 for a body that does not read, or an empty body with no calendar saved. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      requestBody: { required: false, content: { "application/json": { schema: CALENDAR_BODY } } },
      responses: { "200": json(closed({ ok: { type: "boolean", description: "The calendar was read." }, message: { type: "string", description: "In plain words: what it holds, or why it couldn't be read." } }), "The test's answer."), ...errors(400, 401, 403, 415, 422, 429, 500) },
      "x-agentrun-serve": "calendar/1",
    },
  },
  "/settings/chatgpt": {
    get: {
      operationId: "getChatGPTSignIn", tags: ["local"], summary: "This server's ChatGPT sign-in: its state, who and which plan, never a token",
      description: "One sign-in per server, whose plan runs codex and pi with no key (`chatgpt/<model-id>`, capabilities' `models.source` `chatgpt` when no key is set). `expired`: OpenAI refused to renew it; sign in again. The owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: { "200": json(CHATGPT_SIGN_IN, "The sign-in's state."), ...errors(401, 403, 429, 500) },
      "x-agentrun-serve": "chatgpt/1",
    },
    delete: {
      operationId: "signOutChatGPT", tags: ["local"], summary: "Sign out of ChatGPT: the session revoked at OpenAI, then forgotten here",
      description: "Cancels a sign-in that waits, removes the sealed sign-in and revokes its session at OpenAI's documented revocation endpoint on auth.openai.com (one try, 5 s); the sign-in is removed whatever OpenAI answered. A renewal or a sign-in finishing meanwhile revokes the pair it got rather than keep it. `revoked` true: nothing of the sign-in is left alive at OpenAI as far as the server can tell (OpenAI confirmed the revocation, or nothing was signed in, as when only a waiting sign-in was cancelled). `revoked` false: signed out here, and `message` says \"Signed out here. OpenAI didn't confirm the revocation: remove AgentRun in your ChatGPT settings.\" A run on a plan model after it fails saying the server is not signed in. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: {
        "200": json({ type: "object", additionalProperties: false, required: ["revoked"], properties: { revoked: { type: "boolean", description: "Whether OpenAI confirmed the revocation (true, too, when nothing was signed in)." }, message: { type: "string", description: "With `revoked` false: what to do, in words." } } }, "Signed out here."),
        ...errors(401, 403, 429, 500),
      },
      "x-agentrun-serve": "chatgpt/1",
    },
  },
  "/settings/chatgpt/sign-in": {
    post: {
      operationId: "startChatGPTSignIn", tags: ["local"], summary: "Start signing in with ChatGPT: the link to open",
      description: "Starts OpenAI's Sign in with ChatGPT for this server and answers the link a person opens. One waits at a time, for 10 minutes: a new start cancels the one waiting, whose address is then stale. On the machine the server runs on, the browser's return finishes it; elsewhere, paste the address the tab ended on (`127.0.0.1:1455/auth/callback?...`, the address OpenAI's sign-in returns to) to POST /settings/chatgpt/sign-in/finish. 400 in words when the sign-in can't start (another holds this machine's port 1455). A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: {
        "200": json({ type: "object", additionalProperties: false, required: ["authorize_url", "expires_at"], properties: { authorize_url: { type: "string", format: "uri", description: "OpenAI's page to sign in on." }, expires_at: DATE_TIME } }, "The sign-in, waiting."),
        ...errors(400, 401, 403, 429, 500),
      },
      "x-agentrun-serve": "chatgpt/1",
    },
  },
  "/settings/chatgpt/sign-in/finish": {
    post: {
      operationId: "finishChatGPTSignIn", tags: ["local"], summary: "Finish signing in with ChatGPT with the address the sign-in tab ended on",
      description: "Takes the whole address the browser tab ended on, pasted, and finishes the sign-in that waits: its plan's models are read from OpenAI, and the sign-in is sealed here. 400 in words for an address that is not that sign-in's end (another address, a cancelled sign-in's, one with no code: the sign-in keeps waiting), with no sign-in waiting, or when OpenAI refuses it (start again). A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["redirect_url"], properties: { redirect_url: { type: "string", minLength: 1, maxLength: 8192, "x-agentrun-secret": true, description: "The address the sign-in tab ended on, whole." } } } } } },
      responses: { "200": json(CHATGPT_SIGN_IN, "Signed in."), ...errors(400, 401, 403, 415, 422, 429, 500) },
      "x-agentrun-serve": "chatgpt/1",
    },
  },
  "/settings/claude-login": {
    get: {
      operationId: "getClaudeLogin", tags: ["local"], summary: "Claude Code's login on this machine: on or off, and what its CLI says of it",
      description: "With the mode on, claude-agent runs on a person's own Claude plan through the Claude Code CLI on this server's machine: the CLI holds the login and calls Anthropic itself, and AgentRun only asks it `claude auth status`. Such runs cost no dollars here; the plan's own limits apply. 404 not_found, naming the operation, when the server's AGENTRUN_CLAUDE_CODE_LOGIN is `off`. The owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: { "200": json(CLAUDE_LOGIN, "The mode and its login."), ...errors(401, 403, 404, 429, 500) },
      "x-agentrun-serve": "claudelogin/1",
    },
    put: {
      operationId: "turnOnClaudeLogin", tags: ["local"], summary: "Turn on Claude Code's login on this machine for claude-agent's runs",
      description: "Runs claude-agent on the login at `place` (default `agentrun`), on this machine's runner only. 403 forbidden in one line where more than one person can start runs (more than one API token, the API-only profile); 422 input_invalid without `only_me` true. A model a revision names on a gateway or OpenRouter still runs on its key. 404 not_found, naming the operation, when AGENTRUN_CLAUDE_CODE_LOGIN is `off`. A secret write: the owner's signed-in session alone (ownerSession).",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["only_me"], properties: { place: { enum: ["agentrun", "machine"], description: "Where the login is (see the answer's `place`)." }, only_me: { const: true, description: "The owner's word that they alone run agents on this server, since its runs would use their Claude plan." } } } } } },
      responses: { "200": json(CLAUDE_LOGIN, "Turned on."), ...errors(401, 403, 404, 415, 422, 429, 500) },
      "x-agentrun-serve": "claudelogin/1",
    },
    delete: {
      operationId: "turnOffClaudeLogin", tags: ["local"], summary: "Turn off Claude Code's login on this machine",
      description: "claude-agent runs on the model keys again. The login stays as the CLI keeps it: nothing here signs it out. 404 not_found, naming the operation, when AGENTRUN_CLAUDE_CODE_LOGIN is `off`. A secret write: the owner's signed-in session alone (ownerSession).",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: { "200": json(CLAUDE_LOGIN, "Turned off."), ...errors(401, 403, 404, 429, 500) },
      "x-agentrun-serve": "claudelogin/1",
    },
  },
  "/settings/claude-login/login": {
    post: {
      operationId: "startClaudeLogin", tags: ["local"], summary: "Start the Claude Code CLI's own sign-in on this machine",
      description: "Runs the CLI's `auth login` at the login's place; the CLI opens a browser on this machine and keeps what it gets. Nothing of the sign-in passes through AgentRun. 403 forbidden where the browser would not be the person's (a server not on loopback, or with a public address): run the answer's `command` in a terminal there. 409 agent_not_runnable when the mode is off, was turned on for another machine, or no CLI is here yet. 404 not_found, naming the operation, when AGENTRUN_CLAUDE_CODE_LOGIN is `off`. A secret write: the owner's signed-in session alone (ownerSession).",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: { "200": json(CLAUDE_LOGIN, "The sign-in started."), ...errors(401, 403, 404, 409, 429, 500) },
      "x-agentrun-serve": "claudelogin/1",
    },
  },
  "/settings/model-gateway": {
    get: {
      operationId: "getModelGateway", tags: ["local"], summary: "The model gateway in force: the environment's, the one saved here, or none",
      description: "A model gateway is an OpenAI-compatible proxy the owner already runs (LiteLLM, or another): with one in force, every model is sent to it (pi's and codex's on its Responses API, a Claude model on its Messages API), and the provider keys are not used. AGENT_MODEL_BASE_URL set where AgentRun starts wins whole; else the gateway saved here is in force, at once, with no restart. Never the key.",
      responses: { "200": json(MODEL_GATEWAY_VIEW, "The gateway in force."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "modelgateway/1",
    },
    put: {
      operationId: "saveModelGateway", tags: ["local"], summary: "Use a model gateway for every model, saved here",
      description: "Saves the gateway and puts it in force for the next run and capabilities, with no restart. `base_url` follows the one rule AGENT_MODEL_BASE_URL does (https, or http to this machine alone; no user, query, fragment, dot segment, backslash or whitespace), else 422 input_invalid in its words. `api_key` is sealed under the server's seal key, never shown again and never put in a run's environment; null removes it (each run then brings its own `model_key`); left out, the saved key is kept, and only for the origin it was saved for: a new origin with a key saved is 422 at `api_key`. `models.default` is required unless AGENT_MODEL is set where AgentRun starts. 409 key_set_by_server while AGENT_MODEL_BASE_URL is set where AgentRun starts, or for a field whose variable is set there. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", additionalProperties: false, required: ["base_url"],
        properties: {
          base_url: { type: "string", minLength: 1, description: "The gateway's address, such as https://gateway.example/v1." },
          api_key: { type: ["string", "null"], minLength: 1, maxLength: 4096, "x-agentrun-secret": true, description: "The gateway's key, sent as a bearer token. Null removes it; left out, the saved one is kept for the same origin." },
          ids: { enum: ["as_named", "bare"], description: "How the gateway takes the ids a revision names (the answer's `ids`). Default `as_named`." },
          models: { type: "object", additionalProperties: false, properties: { default: { type: "string", minLength: 1, maxLength: 200 }, fast: { type: ["string", "null"], minLength: 1, maxLength: 200 }, strong: { type: ["string", "null"], minLength: 1, maxLength: 200 } }, description: "The model of each tier, as the gateway lists it (POST /settings/model-gateway/test lists them): `default` for a run that names none, `fast` and `strong` for a workflow's tiers." },
        },
      } } } },
      responses: { "200": json(MODEL_GATEWAY_VIEW, "Saved, and in force."), ...errors(401, 403, 409, 415, 422, 429, 500) },
      "x-agentrun-serve": "modelgateway/1",
    },
    delete: {
      operationId: "deleteModelGateway", tags: ["local"], summary: "Stop using the saved model gateway: the provider keys are back in force",
      description: "Removes the saved gateway and its key; the next run and capabilities read the provider keys again, with no restart. 409 key_set_by_server while AGENT_MODEL_BASE_URL is set where AgentRun starts. A secret write: the owner's signed-in session alone (ownerSession).",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      responses: { "200": json(MODEL_GATEWAY_VIEW, "Removed."), ...errors(401, 403, 409, 429, 500) },
      "x-agentrun-serve": "modelgateway/1",
    },
  },
  "/settings/model-gateway/test": {
    post: {
      operationId: "testModelGateway", tags: ["local"], summary: "Ask a model gateway which models it serves",
      description: "The server asks GET <base>/v1/models (OpenAI's shape, `{ data: [{ id }] }`), under the same address rule as a save, with no redirect followed and a 10-second limit, and answers the ids it lists, so the defaults can be picked from them; or why not, in words. The body may name an address and a key not saved yet (the form's), or `api_key` null to ask with no key; with none, the gateway in force is asked with its own key. A saved key goes only to the origin it was saved for. A model id that holds the key it was asked with is left out of the list. A secret write, since it may carry the key: the owner's signed-in session alone (ownerSession). Never the key in the answer.",
      "x-agentrun-secret": true,
      security: [{ ownerSession: [] }],
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { base_url: { type: "string", minLength: 1, description: "The gateway's address to ask; left out, the gateway in force." }, api_key: { type: ["string", "null"], minLength: 1, maxLength: 4096, "x-agentrun-secret": true, description: "The key to ask with. Null: ask with no key, never the saved one; left out, the saved key, and only when the address is of the origin it was saved for." } } } } } },
      responses: { "200": json(MODEL_GATEWAY_TEST, "The test's answer."), ...errors(401, 403, 415, 422, 429, 500) },
      "x-agentrun-serve": "modelgateway/1",
    },
  },
  "/auth/session": {
    get: {
      operationId: "getAuthSession", tags: ["local"], summary: "Whether this browser has accounts, is signed in, and may save a secret",
      description: "Answered with no credential: what the console needs before it shows a setup or sign-in screen, or a field to paste a secret into. `accounts`: whether this server has accounts (a password owner); with them off it answers `accounts`, `secrets_writable` and `secrets_reason` alone, no user field. A secret (a model or tool key, an MCP header or token, a computer vendor's key) is saved only from the owner's session: with accounts on, the owner's password session; with accounts off on a server bound to loopback alone, the console the launch link opened. The API token never saves one, on any server.",
      security: [],
      responses: {
        "200": json({
          type: "object", additionalProperties: false, required: ["accounts", "secrets_writable"],
          properties: {
            accounts: { type: "boolean", description: "Whether this server has accounts (a password owner). false: the console shows no setup or sign-in screen." },
            password_set: { type: "boolean", description: "With accounts: whether the owner's password is set." },
            signed_in: { type: "boolean", description: "With accounts: whether this browser holds the owner's password session." },
            setup_code: { type: "boolean", description: "With accounts, before the password is set: whether setup takes the code the server printed (a server at a public address, or listening on any address but loopback). Never the code." },
            secrets_writable: { type: "boolean", description: "Whether this caller may save, replace or remove a secret here (the same rule the server applies to the write itself)." },
            secrets_reason: { enum: ["sign_in", "no_accounts", "token"], description: "Present only when secrets_writable is false: sign_in, this is not the owner's session (accounts on: sign in with the password; accounts off on a loopback-bound server: open the console from the launch link); no_accounts, accounts are off and this server is reachable off loopback, where no one saves a secret until accounts are on; token, the caller is the API token, which never saves one, on any server." },
          },
        }, "This browser's account state, and whether it may save a secret."),
        ...errors(429, 500),
      },
      "x-agentrun-serve": "secrets/1",
    },
  },
  "/settings/mcp-server-names": {
    get: {
      operationId: "listMcpServerNames", tags: ["local"], summary: "The names of the MCP servers saved here, and nothing else of them",
      description: "Each saved server's name once, sorted: no URL, auth type, header, token, tool or Composio record. Served with the server's token, also on an API-only server (`AGENTRUN_API_ONLY=1`), which serves no other settings route.",
      responses: { "200": json({ type: "object", additionalProperties: false, required: ["names"], properties: { names: { type: "array", items: { type: "string" } } } }, "The saved servers' names."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "mcpservernames/1",
    },
  },
  "/settings/mcp-servers": {
    get: {
      operationId: "listMcpServers", tags: ["local"], summary: "The remote MCP servers saved here, with their tools; never a credential",
      responses: { "200": json({ type: "object", additionalProperties: false, required: ["servers"], properties: { servers: { type: "array", items: MCP_SERVER_VIEW } } }, "Each server, by name."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/mcp-servers/preview": {
    post: {
      operationId: "previewMcpServer", tags: ["local"], summary: "Connect to a remote MCP server and list its tools, storing nothing",
      description: `\`{url, auth}\`, or \`{name}\` for a saved server with its sealed credential (422 when it does not open). \`{name, url, auth}\` is an edit of the saved server \`name\`: its address as every read shows it (origin and \`/…\`), sent back unchanged, is previewed at the saved endpoint. ${MCP_CONNECTS} ${MCP_PREVIEW_SCOPE}`,
      requestBody: { required: true, content: { "application/json": { schema: { oneOf: [{ type: "object", additionalProperties: false, required: ["url"], properties: { url: MCP_URL, auth: MCP_AUTH, name: { type: "string", description: "The saved server this is an edit of." } } }, { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } }] } } } },
      responses: { "200": json(MCP_PREVIEW, `What the server offers. ${MCP_PREVIEW_SCOPE}`), ...errors(400, 401, 404, 409, 415, 422, 429, 500), ...MCP_FAILED },
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
      description: `The credential is sealed under the server's seal key, bound to the server's name and its URL's origin, and kept in the data directory as ciphertext alone. 403 forbidden to the API token for a save that sends a credential's value, or over a saved server the token did not save or that holds a credential (one the owner saved stays the owner's, sealing a credential or not: its address, its credential and what the Composio preset made for it): the owner's signed-in session alone, and the refusal's \`details.console_url\` opens the console's form for it filled with the rest (no credential). 412 precondition_failed when a save that sends a new credential, or none, finds the server's credential changed while it listed its tools (another save, a sign-in or a removal landed), or the token's save finds the owner saved over its server meanwhile, or a save that keeps it finds the server at another address or holding another kind of credential by then (a Composio save over it moved it): nothing is written over it. A body with no credential keeps the sealed one while the type and the URL's origin stay the same; else it is 422. A body with no \`prices\` keeps the saved ones for the tools still listed at the same URL, so a save from any client never leaves a paid tool unmetered; \`prices: {}\` clears them. 422 too for a bad name, URL or auth, or a price that is not a finite number 0 or more or names a tool the server does not list. ${MCP_CONNECTS} Nothing is saved unless the listing succeeds. A save that moves a server the Composio preset made to another address makes it another service's server, and removes in the owner's Composio account what the preset made for it, as its delete does (the MCP server, then the connected account its connect link started and the auth config it made, unless another saved server uses them), with the key it was saved with, and answers \`composio\` saying so; 409 composio_in_use, naming them in \`details.triggers\`, while Composio triggers use it: delete them first. A save of a server the preset made lists its tools at once, then writes and cleans up one at a time with the preset's saves and the MCP servers' deletes, in its Composio project's turn.`,
      parameters: [MCP_NAME],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: MCP_URL, auth: MCP_AUTH, prices: MCP_PRICES, ...MCP_TOOLKIT_BODY } } } } },
      responses: { "200": json({ ...MCP_SERVER_VIEW, properties: { ...MCP_SERVER_VIEW.properties, composio: closed({ removed: { type: "boolean", description: "Nothing the save was to remove at Composio is left there." }, note: { type: "string", description: "What it removed at Composio, what it kept and why, and what is left, with the dashboard's address to remove that by hand." } }, "Present when the save moved a server the Composio preset made off Composio: what became of what the preset made there.") } }, "The server, as saved."), ...errors(400, 401, 403, 409, 412, 415, 422, 429, 500), ...MCP_FAILED },
      "x-agentrun-serve": "mcpservers/1",
    },
    delete: {
      operationId: "deleteMcpServer", tags: ["local"], summary: "Forget a saved MCP server and its credential",
      description: "409 composio_in_use, naming them in `details.triggers`, for a Composio server that Composio triggers still use: delete them first. A server the Composio preset made also has its MCP server deleted in the owner's Composio account, with the saved key, after the row is removed: the row is already gone while that delete waits on Composio. So does what its save made for it there that no other saved server uses: the connected account its connect link started (the link with it), and the auth config it made. What another saved server uses is kept, and goes with the last of them; what the save found there already (an auth config or an account the owner had) is never deleted. A preset's delete answers 200 with `composio`: `removed` true when nothing it was to remove is left, and `note`, what it removed, kept (and why) and left, in words. Composio's 404 means that one is already gone; when Composio refuses or does not answer, or the saved key does not open, `removed` is false and the note names what is left, to remove there. 403 forbidden to the API token when the server holds a credential (removing it drops a secret, the owner's signed-in session's alone) or when the token did not save it: one the owner saved, sealing a credential or not, stays the owner's, and nothing is sent to Composio. A server the token saved with none is the token's to remove, a Composio server saved with `api_key_env` among them (its delete at Composio uses the variable's value the server was started with), on an API-only server (AGENTRUN_API_ONLY=1) too. 412 precondition_failed when the server's credential changed, or the owner saved over it, between that check and the removal (a save or a sign-in landed): nothing is removed, and nothing is sent to Composio.",
      parameters: [MCP_NAME],
      responses: {
        "204": { description: "Forgotten: a server the Composio preset did not make." },
        "200": json(closed({ deleted: { type: "boolean", enum: [true] }, composio: closed({ removed: { type: "boolean", description: "Nothing the delete was to remove at Composio is left there." }, note: { type: "string", description: "What it removed at Composio, what it kept and why, and what is left, with the dashboard's address to remove that by hand." } }) }), "Forgotten here, a Composio preset server: what its delete did in the owner's Composio account. The row is gone either way."),
        ...errors(401, 403, 404, 409, 412, 429, 500),
      },
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
  "/settings/mcp-servers/composio/tools": {
    post: {
      operationId: "listComposioTools", tags: ["local"], summary: "List the actions of a Composio toolkit, for the console's picker; stores nothing",
      description: COMPOSIO_NOTE + " The toolkit's actions at its latest version (`toolkit_versions=latest`), every page: Composio's list without it is the toolkit's base version, which leaves out actions added since. 422 `input_invalid` when Composio refuses the key (field `api_key`) or has no such toolkit (field `toolkit`); 424 `upstream_failed` when Composio does not answer or fails. The owner's signed-in session alone: 403 forbidden to the API token, which never sends a key.",
      requestBody: { required: true, content: { "application/json": { schema: closed({ api_key: COMPOSIO_KEY, toolkit: COMPOSIO_TOOLKIT }) } } },
      responses: { "200": json(closed({ toolkit: { type: "string" }, no_auth: { type: "boolean", description: "Whether the toolkit needs no account of the person's: nothing to connect." }, tools: { type: "array", items: closed({ slug: { type: "string" }, name: { type: "string" }, description: { type: "string" } }) } }), "The toolkit's actions."), ...errors(400, 401, 403, 409, 415, 422, 429, 500), ...MCP_FAILED },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/mcp-servers/{name}/composio": {
    put: {
      operationId: "saveComposioServer", tags: ["local"], summary: "Have Composio make a managed MCP server for a toolkit's chosen actions, and save it as an MCP server",
      description: COMPOSIO_NOTE + " For a toolkit that needs the person's account it uses `auth_config_id`, an auth config the owner already has at Composio (a custom OAuth app's, say), else makes (or reuses) a Composio-managed one; it makes a Composio MCP server allowing only `tools`, asks for its address (the helper actions that connect an account left off; its path ends in `/mcp`), and saves that address as the MCP server `name` through the one MCP save: the key is sealed as an `x-api-key` header, the tools listed. With `price_usd`, every granted action the server lists is priced at it (the server's `prices`), so each call is held under its run's cap and booked as the run's tool cost, as any priced MCP call; without it a save over a server keeps its prices for the actions it still lists, and a new server's are none (\"not metered\"). When the toolkit needs an account and `user_id` has no active one, `connect_url` is Composio's page to connect it; nothing here signs in. `user_id` defaults to `agentrun`. 422 for a bad name, key, toolkit, tools, `price_usd` or `auth_config_id`, a key or request Composio refuses (each says the step); 422 under `auth_config_id` before anything is made at Composio for one Composio doesn't know (`not_found`), one of another toolkit (`wrong_toolkit`), a disabled one (`disabled`), or any on a toolkit that needs no account (`not_allowed`); 422 `not_found` under `tools` for a slug the toolkit doesn't list at its latest version (the listing above, every page), naming each, with the listed slug when it is one in another case, before anything is made at Composio; 424 `upstream_failed` when Composio fails or the saved address does not list its tools. Nothing is saved unless every step succeeds, and a save that fails removes in Composio what it made there (the MCP server, the connected account its connect link started, the auth config it made), never what it found; when Composio refuses that too, its error's message names what is left, with the dashboard's address (and a 422 on a field says it in \`details.composio\` as well). A save over a server the preset made removes, once it is saved, the MCP server that server's earlier save made, and what that save made and this one no longer stands on (the account of another `user_id`, the auth config of another toolkit), with the key it was made with, unless another saved server uses it (then it is that one's), and answers `composio` saying so, as a delete does. A save over a server as another `user_id` or auth config is 409 composio_in_use, naming them in `details.triggers`, while Composio triggers use it: delete them first; a save that leaves what they stand on alone goes through. Preset saves, the saves of the servers they made, and deletes of MCP servers run one at a time. Exactly one of `api_key` and `api_key_env`: neither is 422 `missing` under `api_key`, both 422 `not_allowed` under `api_key_env`. The body names no address and no headers: Composio answers the server's address, and the key is the one header sent; any other field (`url`, `headers`...) is 422 `not_allowed` under it, before anything is sent. The owner's signed-in session alone: 403 forbidden to the API token, except on an API-only server (AGENTRUN_API_ONLY=1), which has no owner: there its token saves a server whose key is named by `api_key_env` (never sent as `api_key`, still 403), over a new name or a server the token saved (one the owner saved, sealing a credential or not, is 403, stays as it was, and nothing is sent to Composio), and reads the saved servers' names with GET /settings/mcp-server-names. 412 precondition_failed when the server changed while the save ran (another save, a sign-in or a removal; the owner's save over the token's server among them): nothing is written over it.",
      parameters: [MCP_NAME],
      requestBody: { required: true, content: { "application/json": { schema: closedWith({ toolkit: COMPOSIO_TOOLKIT, tools: { type: "array", minItems: 1, maxItems: 500, items: { type: "string", minLength: 1, maxLength: 128 }, description: "The slugs of the actions to grant, from the listing." } }, { user_id: { type: "string", pattern: COMPOSIO_USER_ID.source, description: "The Composio user the actions run as; default `agentrun`. \"per_run\" is reserved for the per-run mode and is not a Composio user id: the server is saved with no user and no connected account in its address, no account is looked up and no connect link made (its tools are listed as `agentrun~tool-listing`, a user no save or run can name, since Composio refuses an address naming none), and each run names the Composio user (and connected account) its calls run as in `mcp_auth.<server>` = `{\"composio_user_id\", \"connected_account_id\"}`; a run that names none has its calls of the server refused, nothing sent. Such a server makes no Composio trigger (a trigger runs as one account). A server saved before this mode for a Composio user literally named \"per_run\" keeps calling as that user until it is saved again." }, auth_config_id: { type: "string", pattern: COMPOSIO_AUTH_CONFIG_ID.source, description: "An auth config the owner already has at Composio for this toolkit (a custom OAuth app's, say): the MCP server and its connect link are made against it, in place of the Composio-managed one. Read first; a save never deletes it. Absent: the toolkit's Composio-managed auth config, found or made." }, price_usd: { type: "number", minimum: 0, description: "What each call of the server's actions costs, in USD, a finite number 0 or more (as any `prices` value): saved as the price of every granted action the server lists, so a call is held under its run's cap and booked as the run's tool cost (its trace span's `usd`, the run's `cost.usd`). Absent: the server's prices as they stand, for the actions it still lists, whatever its new address (none on a new server: \"not metered\"). A later save that names no price, this one with no `price_usd` or PUT /settings/mcp-servers/{name} with no `prices`, keeps them." }, api_key: COMPOSIO_KEY, api_key_env: COMPOSIO_KEY_ENV_BODY }) } } },
      responses: { "200": json(closedWith({ server: MCP_SERVER_VIEW }, { connect_url: { type: "string", format: "uri", description: "Present when the toolkit needs an account and the user has no active one: Composio's page to connect it." }, not_served: { type: "array", items: { type: "string" }, description: "Present when Composio's server leaves out some of `tools` (it can, for an action it was allowed): the slugs it doesn't list, which a run can't call." }, composio: closed({ removed: { type: "boolean", description: "Nothing the save was to remove at Composio is left there." }, note: { type: "string", description: "What it removed at Composio, what it kept and why, and what is left, with the dashboard's address to remove that by hand." } }, "Present when the save was over a server whose earlier save made something at Composio that this one no longer stands on: what became of it.") }), "The server as saved, and where to connect the account when it must be."), ...errors(400, 401, 403, 409, 412, 415, 422, 429, 500), ...MCP_FAILED },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/mcp-servers/{name}/composio/events": {
    get: {
      operationId: "listComposioEvents", tags: ["local"], summary: "List a saved Composio server's toolkit's events, for a composio trigger",
      description: "Every page of Composio's trigger types for the server's toolkit, asked with its saved key: each event's slug (a composio trigger's `event`), name, description, the JSON schema of its config (a trigger's `config`, its `required` fields marked) and whether Composio polls for it rather than being sent it. 404 for a name that is no saved server, or one not saved with the Composio preset; 422 when Composio refuses the key; 424 `upstream_failed` when Composio fails.",
      parameters: [MCP_NAME],
      responses: { "200": json(closed({ server: { type: "string" }, toolkit: { type: "string" }, events: { type: "array", items: closedWith({ slug: { type: "string" }, name: { type: "string" }, description: { type: "string" }, config: { type: "object", description: "The event's config, as a JSON schema (`properties`, `required`)." }, polled: { type: "boolean", description: "Composio polls for it (every few minutes) rather than being sent it." }, sealed: { type: "array", items: { type: "string" }, description: "The fields of its config a save seals: each named like a credential (developer_api_key), taken as a password and answered as \"[sealed]\" once saved. Composio's schemas mark no field secret, so the name says it." } }, { instructions: { type: "string" } }) } }), "The toolkit's events."), ...errors(401, 404, 422, 429, 500), ...MCP_FAILED },
      ...COMPOSIO_TRIGGERS_MARK,
    },
  },
  "/settings/mcp-servers/{name}/composio/triggers": {
    get: {
      operationId: "listComposioTriggers", tags: ["local"], summary: "A saved Composio server's triggers, each with its instance's state on Composio",
      description: "The composio triggers that name the server, each with `on_composio`: `on` or `off` as Composio has its instance, `missing` when Composio has it no more, `unknown` when Composio did not answer (and `composio_error` says why). `subscription`: the Composio project's webhook subscription, `ours` when it is at this server's address (null when there is none). Its secret is never answered. 404 for a name that is no saved Composio server.",
      parameters: [MCP_NAME],
      responses: { "200": json(closedWith({ triggers: { type: "array", items: closed({ id: { type: "string" }, name: { type: "string" }, enabled: { type: "boolean" }, event: { type: "string" }, instance_id: { type: "string" }, on_composio: { enum: ["on", "off", "missing", "unknown"] } }) }, subscription: { oneOf: [closed({ ours: { type: "boolean" }, webhook_url: { type: "string" } }), { type: "null" }] } }, { composio_error: { type: "string" } }), "Its triggers, and the project's subscription."), ...errors(401, 404, 422, 429, 500) },
      ...COMPOSIO_TRIGGERS_MARK,
    },
  },
  "/settings/mcp-servers/{name}/composio/rotate-secret": {
    post: {
      operationId: "rotateComposioSecret", tags: ["local"], summary: "Rotate the Composio project's webhook subscription's secret, and keep the new one",
      description: "Composio makes the subscription a new secret, which is sealed here: deliveries signed with the old one are the one 401 from then on. The secret is never answered. 404 when the project has no subscription; 409 composio_subscription_elsewhere when it is at another address than this server's. The owner's signed-in session alone: 403 forbidden to the API token.",
      parameters: [MCP_NAME],
      responses: { "200": json(closed({ rotated: { type: "boolean", enum: [true] } }), "Rotated, and kept."), ...errors(401, 403, 404, 409, 422, 429, 500), ...MCP_FAILED },
      ...COMPOSIO_TRIGGERS_MARK,
    },
  },
  "/settings/mcp-servers/{name}/composio/subscription": {
    delete: {
      operationId: "deleteComposioSubscription", tags: ["local"], summary: "Delete the Composio project's webhook subscription, once no trigger uses it",
      description: "Deletes the subscription on Composio, and its secret here. 409 composio_in_use, naming them, while a composio trigger uses it; 409 composio_subscription_elsewhere when it is at another address than this server's (it is not this server's to delete); 404 when there is none. The owner's signed-in session alone: 403 forbidden to the API token.",
      parameters: [MCP_NAME],
      responses: { "200": json(closed({ deleted: { type: "boolean", enum: [true] } }), "Deleted."), ...errors(401, 403, 404, 409, 422, 429, 500), ...MCP_FAILED },
      ...COMPOSIO_TRIGGERS_MARK,
    },
  },
  "/settings/mcp-servers/{name}/oauth/start": {
    post: {
      operationId: "startMcpOAuth", tags: ["local"], summary: "Start signing in to an MCP server with OAuth: the page the owner opens",
      description: `Discovers the server's authorization server (RFC 9728, then RFC 8414) with the official MCP SDK, and its client: the \`client_id\` (and \`client_secret\`) given; else, signing in again to the same origin, the client kept from the last sign-in (its secret too); else this server's client metadata document, when this server's address is public https and the authorization server takes one; else dynamic registration. PKCE S256, and the RFC 8707 \`resource\` is the server's URL. Answers \`authorization_url\` for the owner to open; the authorization server sends the browser back to GET /settings/mcp-servers/oauth/callback within 10 minutes. 409 wrong_origin when the request came to another address than the one the callback is under (\`details.open\` says where to open the console); 424 when discovery or registration fails, or an MCP server off loopback names a private or plain-http endpoint. The answer sets a cookie (one per sign-in, \`SameSite=Lax\`, the callback's path, 10 minutes) that the callback requires.`,
      parameters: [MCP_NAME],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: MCP_URL, scopes: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } }, client_id: { type: "string", minLength: 1 }, client_secret: { type: "string", minLength: 1, description: "Only with client_id; kept sealed with the token set.", "x-agentrun-secret": true }, ...MCP_TOOLKIT_BODY } } } } },
      responses: { "200": json(closed({ authorization_url: { type: "string", format: "uri" } }), "The page the owner opens."), ...errors(400, 401, 403, 409, 415, 422, 429, 500), ...MCP_FAILED },
      "x-agentrun-serve": "mcpservers/1",
      // Started anywhere but the owner's browser, the sign-in can never finish: the cookie its callback requires is set on
      // this answer, to whoever sent it. The generated CLI and SDKs (scripts/generate-clients.mjs) give it no method.
      "x-agentrun-browser-only": "The sign-in's cookie, which its callback requires, is set on the answer to whoever starts it, so it must start in the owner's browser: use the console's MCP page.",
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
  "/integrations/github": {
    get: {
      operationId: "getGitHubConnection", tags: ["local"], summary: "Whether a GitHub App is connected, and if so its id, slug and installations, never a secret",
      description: "Its installations are first repaired from GitHub's own (GET /app/installations with the App's JWT), at most once a minute: an installation event missed or not checked (GitHub out of reach answers that event 503) is put right here, and a list that comes to hold none turns every github trigger off (`connection_lost`). GitHub out of reach leaves the list as it is.",
      responses: { "200": json(GITHUB_STATUS, "`{connected: false}`, or the connection with `connected: true`."), ...errors(401, 429, 500) },
      ...GITHUB_MARK,
    },
    delete: {
      operationId: "disconnectGitHub", tags: ["local"], summary: "Disconnect GitHub: the App's credentials gone from this server, and every github trigger off",
      description: "Removes the App's sealed credentials and installations, and turns every github trigger off (`disabled: {reason: \"connection_lost\"}`), keeping them: connected again, each goes on when turned on. The App itself stays on GitHub: `note` says \"Delete the App itself on GitHub: <its settings URL>\". 404 when none is connected.",
      responses: { "200": json(closed({ disconnected: { const: true }, triggers_off: { type: "integer", minimum: 0, description: "How many github triggers it turned off." }, note: { type: "string", description: "Where to delete the App itself on GitHub." } }), "Disconnected."), ...errors(401, 403, 404, 429, 500) },
      ...GITHUB_MARK,
    },
  },
  "/integrations/github/connect": {
    post: {
      operationId: "connectGitHub", tags: ["local"], summary: "Start Connect GitHub: the app-manifest form the console posts to GitHub",
      description: "GitHub's app-manifest flow, which makes the server's one GitHub App. Answers the form the console auto-submits: `action` (GitHub's new-App page, under `org` when given, with `state` on it) and `manifest` (a field of that form, as JSON): a name GitHub lets the person edit, the server's public URL, its hook `/v2/hooks/github`, its callback and its setup URL, the App's permissions (pull requests write, contents, metadata and issues read) and events (pull_request, issue_comment, release). `state` is random, used once, good for an hour, and bound to the browser that started it by a cookie on the callback's path; GitHub reads it from `action`'s URL, and the form posts only `manifest`. 409 github_no_public_url (\"GitHub can't reach this server: set its public URL first\") with no public URL (AGENTRUN_PUBLIC_URL); 409 github_already_connected (\"This server already has a GitHub App. Disconnect it first.\"); 409 github_wrong_origin (\"Open this server at <public URL> to connect GitHub.\", `details.public_url` that URL, for the console's link) when the request came to another address than the public URL, where GitHub sends the browser back: nothing is started.",
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { org: { type: "string", pattern: "^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$", description: "The GitHub organization to make the App under; absent, the signed-in GitHub user." }, contents: { enum: ["read", "write"], description: "The App's Contents permission: read (the default), or write, which suggested agents' pull requests need (they add files on a new branch). Nothing else is widened.", "x-agentrun-serve": "suggestions/1" } } } } } },
      responses: { "200": json(closed({ action: { type: "string", format: "uri" }, manifest: { type: "object", description: "GitHub's app manifest, posted as the form's `manifest` field." }, state: { type: "string" } }), "The form to post to GitHub."), ...errors(400, 401, 403, 409, 415, 422, 429, 500) },
      ...GITHUB_MARK,
      "x-agentrun-browser-only": "Its state is bound by a cookie to the browser that posts the form to GitHub, which sends that browser back to the callback: Connect GitHub runs in the console.",
    },
  },
  "/integrations/github/callback": {
    get: {
      operationId: "gitHubCallback", tags: ["local"], summary: "Where GitHub sends the owner's browser back with the new App's code", security: [{}],
      description: "Takes no token, and answers the browser only with where to go. Its `state` and the cookie its start set in that browser are the check. Converts `code` with GitHub (POST /app-manifests/{code}/conversions), keeps the App's id, slug, client id, private key and webhook secret sealed (its client secret is never kept), and redirects to GitHub's page that installs the App. A state that is unknown, used, over an hour old or from another browser redirects to the console's `/#/settings/github?github=error&reason=state_invalid`, a code GitHub does not convert to `...&reason=conversion_failed`, and one whose App GitHub made while another Connect kept its App to `...&reason=already_connected`; nothing is kept. Nothing of the App's secrets is logged or answered.",
      parameters: ["code", "state"].map((name) => ({ name, in: "query", required: false, schema: { type: "string" } })),
      responses: { "302": { description: "To GitHub, to install the App; or to the console's GitHub settings with `github=error&reason=state_invalid`, `conversion_failed` or `already_connected`." }, ...errors(429, 500) },
      ...GITHUB_MARK,
      "x-agentrun-browser-only": "GitHub sends the owner's browser here with the new App's code; it takes no token, and its state and cookie are that browser's.",
    },
  },
  "/integrations/github/installed": {
    get: {
      operationId: "gitHubInstalled", tags: ["local"], summary: "Where GitHub sends the browser once the App is installed", security: [{}],
      description: "Takes no token, and answers the browser only with where to go. It records an installation only with the install state the callback sent GitHub's install page (`state`, which GitHub passes on) and the cookie it set in that browser, and only as GitHub, asked with the App's own JWT (GET /app/installations/{installation_id}), says it is the App's; then the browser goes to the console's `/#/settings/github?github=connected`. Without the state and cookie it records nothing and lands there too (an install from GitHub's own pages arrives as the App's signed installation event); otherwise (no such installation of the App, no App connected, GitHub not reached) to `/#/settings/github?github=error&reason=installation_unverified`, and nothing is kept.",
      parameters: ["installation_id", "setup_action", "state"].map((name) => ({ name, in: "query", required: false, schema: { type: "string" } })),
      responses: { "302": { description: "To the console's GitHub settings: `github=connected`, or `github=error&reason=installation_unverified`." }, ...errors(429, 500) },
      ...GITHUB_MARK,
      "x-agentrun-browser-only": "GitHub sends the browser here once the App is installed; it takes no token, and it checks the cookie the callback set in that browser.",
    },
  },
  "/integrations/github/repositories": {
    get: {
      operationId: "listGitHubRepositories", tags: ["local"], summary: "The repositories this server's GitHub App is installed on",
      description: "Each installation's repositories, as GitHub lists them now (GET /installation/repositories with a token of that installation holding metadata read alone, revoked after), sorted by name, at most 500 (`truncated` past that). An installation GitHub did not list is in `unread` with why. 409 github_not_connected with no App.",
      responses: { "200": json(closed({ repositories: { type: "array", items: closedWith({ full_name: { type: "string" }, private: { type: "boolean" }, account: { type: "string" }, installation: { type: "integer" } }, { default_branch: { type: "string" }, description: { type: "string" } }) }, truncated: { type: "boolean" }, unread: { type: "array", items: closed({ account: { type: "string" }, why: { type: "string" } }) } }), "The repositories."), ...errors(401, 409, 429, 500) },
      ...SUGGESTIONS_MARK,
    },
  },
  "/suggestions": {
    get: {
      operationId: "listSuggestions", tags: ["local"], summary: "Suggested agents: each repository's scan and the agents it suggests",
      description: "Whether GitHub is connected, each repository scanned (its newest scan: running, or what was read of its answer), and its suggestions: open and created by default (`status` picks open, created, discarded or all), open first, then by impact. A scan that ended is read here once: each suggestion of the agent-scout's answer is checked field by field (a path inside the repository, a client path its language's and outside `.github/`, typed inputs and answer), and one that does not check is dropped and listed with why. A newer scan replaces the open suggestions of the one before; a decided one (created or discarded) stays as decided, and the next scan is told not to suggest it again.",
      parameters: [{ name: "repo", in: "query", required: false, schema: { type: "string" }, description: "owner/name: one repository's alone." }, { name: "status", in: "query", required: false, schema: { enum: ["open", "created", "discarded", "all"] } }],
      responses: { "200": json(SUGGESTIONS_LIST, "Suggested agents."), ...errors(401, 422, 429, 500) },
      ...SUGGESTIONS_MARK,
    },
  },
  "/suggestions/scans": {
    post: {
      operationId: "scanForSuggestions", tags: ["local"], summary: "Scan a repository for places its app needs an agent",
      description: "Starts a run of the bundled agent-scout template's agent (applied here the first time, then reused) on `repo`: the server checks the head of its default branch out read-only in the run's folder (`checkout: repository`, with the GitHub App's contents-read token, or anonymously), and the run answers at most five suggestions. Its first message lists the suggestions already decided on the repository, so none comes back. 202 with the run; 200 with the scan still running, when one is. The repository's scan is reserved in the store before the run starts, on every server sharing it: a second scan sent while one is starting is 409 home_busy (retryable), and starts nothing. What the apply or the start refuses is the answer (409 agent_not_runnable with no model key, say), and takes the reservation back.",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["repo"], properties: { repo: { type: "string", description: "owner/name, or its https://github.com URL." } } } } } },
      responses: { "200": json(closed({ repo: { type: "string" }, run_id: { type: "string" }, agent_id: { type: "string" }, status: { const: "running" }, already_running: { type: "boolean" } }), "The scan already running."), "202": json(closed({ repo: { type: "string" }, run_id: { type: "string" }, agent_id: { type: "string" }, status: { const: "running" }, already_running: { type: "boolean" } }), "The scan started."), ...errors(400, 401, 409, 415, 422, 429, 500) },
      ...SUGGESTIONS_MARK,
    },
  },
  "/suggestions/{suggestion_id}": {
    get: {
      operationId: "getSuggestion", tags: ["local"], summary: "One suggested agent whole: its instructions, the files a create adds, and whether GitHub lets it",
      description: "The suggestion with its agent's instructions; `files`, the files a create pushes (its package's `agent.md` and `output.schema.json` under `.agentrun/agents/<key>/`, and the client at `integration.path`), rendered now from its checked fields; `problems`, why its package would not check; and `github`, whether this server's GitHub App can open its pull request now, read from GitHub (the installation that covers the repository and its permissions), with what is missing and the pages that fix it.",
      parameters: [SUGGESTION_ID, { name: "name", in: "query", required: false, schema: { type: "string", minLength: 3, maxLength: 60 }, description: "The agent's name a create would be sent (`POST .../create` `name`): `files` are rendered with it, as the create pushes them. 422 when it is not 3 to 60 characters." }],
      responses: { "200": json(SUGGESTION_WHOLE, "The suggestion."), ...errors(401, 404, 422, 429, 500) },
      ...SUGGESTIONS_MARK,
    },
  },
  "/suggestions/{suggestion_id}/discard": {
    post: {
      operationId: "discardSuggestion", tags: ["local"], summary: "Discard a suggested agent: it goes away, and later scans leave it out",
      description: "Open to discarded (a discarded one answers as it is). 409 suggestion_decided for a created one, whose pull request is closed on GitHub instead; 409 home_busy while a create of it runs.",
      parameters: [SUGGESTION_ID],
      responses: { "200": json(SUGGESTION, "Discarded."), ...errors(401, 404, 409, 429, 500) },
      ...SUGGESTIONS_MARK,
    },
  },
  "/suggestions/{suggestion_id}/restore": {
    post: {
      operationId: "restoreSuggestion", tags: ["local"], summary: "Bring a discarded suggestion back (an undo)",
      description: "Discarded to open (an open one answers as it is). 409 suggestion_decided for a created one.",
      parameters: [SUGGESTION_ID],
      responses: { "200": json(SUGGESTION, "Open again."), ...errors(401, 404, 409, 429, 500) },
      ...SUGGESTIONS_MARK,
    },
  },
  "/suggestions/{suggestion_id}/create": {
    post: {
      operationId: "createSuggestedAgent", tags: ["local"], summary: "Create a suggested agent: a branch with its package and client, the agent made here, and a pull request",
      description: "Checks the package rendered from the suggestion as an imported one is checked (422 with each problem), then reads the GitHub App's installation on the repository: 409 github_not_connected, 409 github_not_installed (`details.install_url`), or 409 github_permission_missing (`details.missing`, `permissions_url`, `installation_url`) when it lacks Contents or Pull requests write; nothing is written. Then, with one installation token narrowed to the repository (contents and pull requests write, metadata read; revoked after): the files are committed over the default branch's head on a new branch `agentrun/<key>` (409 github_file_exists when one is already there: the pull request only adds files); the package is applied here as the imported template `github:<owner>/<repo>/.agentrun/agents/<key>` at that commit (a refusal, such as 409 agent_not_runnable, deletes the branch and makes nothing); and the pull request is opened, naming the agent's id and the variables the client reads. 201 with the suggestion, `created` holding the agent, the branch and the pull request, and the apply's `warnings`. A created suggestion answers 200 as it is; one whose agent was made and whose pull request failed (502 github_failed, `details.agent_id`) opens only the pull request when sent again. A create claims the suggestion in the store before it writes to GitHub, on every server sharing it: 409 home_busy (retryable) while another create of it runs; a claim older than 15 minutes, left by a server that stopped, is taken over. 409 suggestion_decided for a discarded one.",
      parameters: [SUGGESTION_ID],
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { name: { type: "string", minLength: 3, maxLength: 60, description: "The agent's name, in place of the suggestion's." } } } } } },
      responses: { "200": json({ ...SUGGESTION, required: [...SUGGESTION.required, "warnings"], properties: { ...SUGGESTION.properties, warnings: { type: "array", items: { type: "object" } } } }, "Created already."), "201": json({ ...SUGGESTION, required: [...SUGGESTION.required, "warnings"], properties: { ...SUGGESTION.properties, warnings: { type: "array", items: { type: "object" } } } }, "Created: the agent, its branch and its pull request."), ...errors(401, 404, 409, 415, 422, 429, 500), "502": { description: "`github_failed`: GitHub refused or did not answer a step; with `details.agent_id` when the agent was made and only its pull request failed (send the create again to open it).", headers: { "X-Request-Id": ref("headers/RequestId") }, content: { "application/json": { schema: ref("schemas/Error") } } } },
      ...SUGGESTIONS_MARK,
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
  "/settings/mcp-servers/oauth/private-hosts": {
    get: {
      operationId: "getMcpPrivateHosts", tags: ["local"], summary: "The private-network hosts an MCP server's authorization server may be on",
      description: `An MCP server's authorization server (its discovery, registration, token and refresh endpoints) is refused on a private network unless its host is on this list, which is empty by default. ${PRIVATE_HOSTS_RULE}`,
      responses: { "200": json(PRIVATE_HOSTS, "The list."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "mcpservers/1",
    },
    put: {
      operationId: "putMcpPrivateHosts", tags: ["local"], summary: "Replace the private-network hosts an MCP server's authorization server may be on",
      description: `Replaces the list; an empty list allows none. Each entry is a host name or an IP address, matched exactly (lowercase, every final dot dropped, an IPv6 address as a URL writes it, in brackets): no wildcards, address ranges, ports or schemes, at most ${MAX_PRIVATE_HOSTS}. 422 with each entry that is not one, or that names an address no listing could allow. ${PRIVATE_HOSTS_RULE} Only the owner, signed in with their password, changes it: the route takes the console's password session alone, from this server's own origin with a JSON body (as every page write), and answers 403 \`forbidden\` to every token, the server's own included, since a run's process, an agent's MCP client or a script may hold one, and to every request on a server with accounts off; with no credential at all it is 401, as every route.`,
      security: [{ ownerSession: [] }],
      requestBody: { required: true, content: { "application/json": { schema: PRIVATE_HOSTS } } },
      responses: { "200": json(PRIVATE_HOSTS, "The list, as kept."), ...errors(400, 401, 403, 415, 422, 429, 500, 503) },
      "x-agentrun-serve": "mcpservers/1",
    },
  },
  "/settings/tools": {
    get: {
      operationId: "getToolSettings", tags: ["capabilities"], summary: "The server's tool settings",
      description: "Each capability that has a choice, and its provider, and each tool's permission that is set (an MCP server's wildcard mcp:<server>/* among them): web_search auto (codex's own search or, on pi, the model provider's hosted one, else Parallel where the server holds its key, which bills it, else Firecrawl's keyless search with Exa's behind it; claude-agent's own search only as native), native (that alone), firecrawl-keyless (Firecrawl's, Exa's behind it), exa-keyless (that alone) or parallel; web_fetch auto (the guarded direct fetch where the server holds a Parallel key, else Firecrawl's keyless fetch, which is sent each URL read, never a private or local one, with the guarded direct fetch behind it), firecrawl-keyless (that, whatever the key), kernel (the guarded direct fetch alone) or parallel; browser auto (Browserbase where the server holds its keys, else Kernel where it holds Kernel's), browserbase, kernel (each that alone) or chrome (a Chrome on the server's host, not set up on any server yet: unavailable). An agent's definition.tool_settings is over these, except a permission set to deny here: a server deny is absolute and refuses the tool on this server whatever the agent sets. capabilities.tools say what each resolves to on each harness, and GET /agents/{agent_id} for that agent. An MCP tool's own key may carry its pin, the arguments its calls must carry.",
      responses: { "200": json(TOOL_SETTINGS_ANSWER, "Each capability's provider."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "providers/1",
    },
    put: {
      operationId: "putToolSettings", tags: ["capabilities"], summary: "Set the providers of web_search, web_fetch and browser, and each tool's permission",
      description: "Replaces the settings: a tool the body leaves out takes its defaults. Kept in the data directory, and capabilities say so at once. A provider is read by every run launched from then on; a permission by the tool gate at each call, live runs' included, and a run waiting on a person's approval of a call whose tool now reads allow for that run (its agent's own settings over these) goes on at once, the setting answering it (a claude-agent or codex run's own web search takes a change of web_search's at its next launch). An MCP server's wildcard, mcp:<server>/*, sets each of its tools, under a tool's own key. A pick of parallel without PARALLEL_API_KEY resolves unavailable, never to another provider, and so does a browser vendor picked without its key. An MCP tool's own key (never a wildcard) may carry `pin`, 1 to 8 of its top-level arguments to the JSON scalar each call must carry (or a list one of which, or {keys: [...]}, the keys an object argument may hold): the gate refuses any other call before it runs or asks anyone, whatever the permission, and a pin here and an agent's both hold. An unknown tool, a provider not offered for it, a permission not offered for it and a pin that is not one are refused.",
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
      description: `Raw bytes with the file's content type, as a run's file is read (\`GET /runs/{run_id}/files/{path}\`): \`nosniff\`, a CSP on HTML, \`?download=1\` for an attachment. ${HOME_PATHS} A path at or under one of \`capabilities.home.host_owned\` (\`learning/\`, \`sign-ins/\`), as normalized and folded, is \`403 system_file_forbidden\` with \`details.reason\` \`host_owned\`. Its message names the learning API (\`/v2/agents/{agent_id}/learning\`) on a server that has that route, and says this server has none on one that does not. A link on the way is \`404 not_found\`.`,
      parameters: [ref("parameters/AgentId"), HOME_PATH, { name: "download", in: "query", required: false, description: "`1` forces a download.", schema: { type: "integer", enum: [0, 1], default: 0 } }],
      responses: {
        "200": { description: "The whole file.", headers: { "Content-Disposition": ref("headers/ContentDisposition"), "X-Content-Type-Options": ref("headers/NoSniff") }, content: RAW },
        ...errors(400, 401, 403, 404, 429, 500),
      },
      "x-agentrun-serve": "home/1",
    },
    put: {
      operationId: "writeHomeFile", tags: ["agents"], summary: "Write one file of the agent's home",
      description: `The raw body becomes the file, whole: written to a temporary file beside it and renamed over it (the workspace's mode, inside the owner-only 0700 home folder), the directories on the way made. Of two writes of one file at once, each lands whole and the last wins. A body over \`capabilities.home.max_file_bytes\` is \`413 payload_too_large\`. ${HOME_PATHS} ${HOME_WRITES}`,
      parameters: [ref("parameters/AgentId"), HOME_PATH],
      requestBody: { required: true, content: RAW },
      responses: { "200": json(HOME_FILE, "The file, as the list shows it."), ...errors(400, 401, 403, 404, 409, 413, 429, 500, 501) },
      "x-agentrun-serve": "home/1",
    },
    delete: {
      operationId: "deleteHomeFile", tags: ["agents"], summary: "Delete one file of the agent's home",
      description: `Removes the file; a directory it leaves empty stays. A file that is not there is \`404 not_found\`. ${HOME_PATHS} ${HOME_WRITES}`,
      parameters: [ref("parameters/AgentId"), HOME_PATH],
      responses: { "204": { description: "The file is gone." }, ...errors(400, 401, 403, 404, 409, 429, 500, 501) },
      "x-agentrun-serve": "home/1",
    },
  },
  "/runs/{run_id}/approvals/{approval_id}": {
    post: {
      operationId: "answerApproval", tags: ["runs"], summary: "Answer a tool call that waits for the owner's approval",
      description: "A tool set to ask parks its run at each call: status input_required, state waiting, and its view's and its summary's pending (kind approval) naming the call; a timeline row of kind tool_approval_requested follows the call's own rows (its call's, and its result's once it ran), then a row with what came of the answer. allow runs the call once, and the session goes on with its result; deny answers the call with the refusal, the note as its reason. The first answer wins: the same answer again is 204, another 409 not_continuable with details {reason: already_answered, decision}. A cancel of the run marks the call canceled, and a stop withdraws it. A person's message while it waits declines it, with the message as the reason: the run goes on in one turn with the refusal and their words, its row reads `Declined by your message`, their words show as their own message row between the approval row and the outcome, and a later answer is 409 with details.decision deny. Only the owner's password session answers, on the page's own origin with a JSON body: a bearer token is 403 forbidden, since a run's process, an agent's MCP client or a script may hold one.",
      parameters: [ref("parameters/RunId"), { name: "approval_id", in: "path", required: true, description: "The run's pending.id.", schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["decision"], properties: { decision: { enum: ["allow", "deny"] }, note: { type: "string", maxLength: 2000, description: "Why: with deny, the refusal's reason the model is told." }, confirm_destructive: { const: true, description: "The second confirm an allow of a destructive call needs (its pending's `destructive`): without it that allow is 422 on `confirm_destructive`, reason `missing`, and the call still waits. A deny needs none.", "x-agentrun-serve": "allowreads/1" } } } } } },
      responses: { "204": { description: "Answered: the run goes on." }, ...errors(400, 401, 403, 404, 409, 415, 422, 429, 500) },
      "x-agentrun-serve": "approvals/1",
    },
  },
  ...archiving("agents", "Agent", ref("parameters/AgentId"), "The agent, with archived_at, and `triggers_off: [{id, name}]`: archived, the triggers that run as it, turned off with the archive (`disabled.reason` `agent_archived`); unarchived, those its archive turned off that are off still (unarchiving turns none on: PATCH /triggers/{id} with enabled true does)."),
  ...archiving("runs", "Run", ref("parameters/RunId"), "The run, with archived_at."),
  ...LEARNING_EXTENSIONS,
  "/agents/{agent_id}/sign-ins/{key}": {
    delete: {
      operationId: "forgetSignIn", tags: ["agents"], summary: "Forget one of the agent's saved sign-ins",
      description: "Deletes the browser vendor's object the sign-in points to (a Browserbase context, a Kernel profile), then the sealed pointer this server kept; GET /agents/{agent_id} lists it no more, and the agent's next run with the browser starts signed out, on a new one. Best effort at the vendor: a delete it does not answer, or refuses, is said in `removed[].message` (`at_vendor: not_deleted`), and the pointer is forgotten all the same. 404 for a key the agent has no sign-in under; 409 `sign_in_held` while a run holds its save lease (`details.held_by`), and while a run it was handed is still going, its lease let go or not (`details.handed_to`: one waiting for its person, say), until that run ends: what that run says could repeat the pointer, and once it is forgotten a restarted server could not cut it from what the run shows. The message names the run, never the pointer.",
      parameters: [ref("parameters/AgentId"), { name: "key", in: "path", required: true, description: "The sign-in's key, as GET /agents/{agent_id} lists it (`default`).", schema: { type: "string" } }],
      responses: {
        "200": json({ type: "object", additionalProperties: false, required: ["key", "removed"], properties: { key: { type: "string" }, removed: { type: "array", items: { type: "object", additionalProperties: false, required: ["provider", "at_vendor"], properties: { provider: { type: "string" }, at_vendor: { enum: ["deleted", "not_deleted"] }, message: { type: "string" } } } } } }, "Forgotten: what was deleted at each vendor."),
        ...errors(400, 401, 403, 404, 409, 429, 500),
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
      description: `Messages follow the Standard Webhooks spec (standardwebhooks.com), so a receiver verifies them with any of its libraries. Each is POSTed to \`url\` as JSON \`{type, timestamp, data}\`: \`run.needs_input\` when a run comes to need its person (status input_required; \`data.pending.kind\` \`question\` for an ask_person question, \`approval\` for a tool call that waits for a person's approval, \`stopped\` for a turn a person stopped, \`budget\` for a run paused at its spend cap, \`browser\` or \`computer\` for an agent's ask for the person in its browser or on its desktop or phone: always the run read's own \`pending.kind\`; no \`pending\` when the run waits on nothing named, as when its harness ended its turn on its own) and \`run.ended\` when it ends (completed, failed or cancelled), with \`data: {run_id, agent_id, agent_name, status, title, url}\`, \`url\` the run on the page; and \`trigger.failed\` when a trigger's firing could not start its run (/triggers), with \`data: {trigger_id, name, agent_id, agent_name, firing_key, nominal_at, error: {code, message}, auto_paused}\`, \`agent_id\` the agent the trigger runs as (a start_run target's agent, or the agent of the run a message_run target names, so always present), \`auto_paused\` true when it was the ${FAILURES_TO_PAUSE}th in a row and turned the trigger off, its \`webhook-id\` the same for the same firing, after a restart too. \`agent_name\` in each is the agent's name as the message is built, or its \`agent_id\` when it has none. Never a tool's arguments, an output or an input, which the API reads. Headers: \`webhook-id\` (the same on every try, the receiver's idempotency key), \`webhook-timestamp\` (Unix seconds) and \`webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">\` under the secret's 32 bytes; a receiver refuses a timestamp more than 5 minutes from its clock. A try not answered 2xx in 15 s (no redirect followed) is tried again after about 5 s, 5 min, 30 min, 2 h, 5 h and 10 h, with jitter, then logged as failed; pending messages go on after a restart. A 410 turns the webhook off until it is set again. The first PUT makes the secret and answers 201 with it, once; a later PUT of the same URL keeps it, turns the webhook on again and answers 200, and one of a new URL makes a new secret. POST /settings/webhook/secret makes a new secret for the same URL. 422 for a URL that is not http or https, holds a user or password, or is over 2048 characters.`,
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", format: "uri", maxLength: 2048 } } } } } },
      responses: {
        "201": json({ oneOf: [closed({ ...WEBHOOK_SET_FIELDS, signing_secret: WEBHOOK_SECRET }), closed({ ...WEBHOOK_SET_FIELDS, note: { type: "string", description: "To the API token, which is never shown the secret: the words that send the person to the console for it." } })] }, "Set, with its secret as `signing_secret`, shown this once to the owner's signed-in session; to the API token, its metadata and the words in its place."),
        "200": json(WEBHOOK_SET, "Changed; the secret is kept."),
        ...errors(400, 401, 409, 415, 422, 429, 500),
      },
      "x-agentrun-serve": "webhook/1",
    },
    delete: {
      operationId: "deleteWebhook", tags: ["local"], summary: "Remove the webhook; its pending messages are dropped, the log of attempts is kept",
      description: "A secret write: its signing secret goes with it. The owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words and the webhook kept.",
      // The owner's password session alone (secret-writes.ts), never the document's bearer.
      security: [{ ownerSession: [] }],
      responses: { "204": { description: "Removed." }, ...errors(401, 403, 429, 500) },
      "x-agentrun-serve": "webhook/1",
    },
  },
  "/settings/webhook/secret": {
    post: {
      operationId: "rotateWebhookSecret", tags: ["local"], summary: "The webhook's new signing secret, shown once; the old one signs nothing from now on",
      description: "A new secret for the URL set now; the webhook is otherwise as it was (its URL, and off if a 410 turned it off). The old secret is retired at once: every try from now on is signed with the new one, a message queued before the rotation included, so the receiver needs the new secret before its next message. A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words and the secret kept. 404 when no webhook is set; 422 for any body, `{}` too, refused before it rotates: the new secret is made here, never given.",
      // No body to mark a field in: the operation is marked whole, a secret write all the same.
      "x-agentrun-secret": true,
      // The owner's password session alone (secret-writes.ts), never the document's bearer.
      security: [{ ownerSession: [] }],
      responses: { "200": json(closed({ ...WEBHOOK_SET_FIELDS, signing_secret: WEBHOOK_SECRET }), "The webhook, with the new secret as `signing_secret`, this once, and its metadata."), ...errors(401, 403, 404, 409, 422, 429, 500) },
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
  "/settings/slack": {
    get: {
      operationId: "getSlack", tags: ["local"], summary: "Where this server posts run notices in Slack, if it is set; never the URL",
      responses: { "200": json(SLACK_VIEW, "Slack, or `configured: false`."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "slack/1",
    },
    put: {
      operationId: "saveSlack", tags: ["local"], summary: "Set Slack's incoming-webhook URL, or which events it is sent",
      description: `Posts a readable message (Block Kit, with \`text\` for notifications) to a Slack incoming webhook for each event that is on: \`run.ended\` when a run ends (completed, failed or cancelled), \`run.needs_input\` when a run comes to need its person (what it waits on, by its \`pending.kind\`), and \`trigger.failed\` when a trigger's firing could not start its run (the trigger's name and error). A run's message names its agent (its name, else its id), its status in a word, its title and a link to the run in the console; never a tool's arguments, an output or an input. Delivery is the webhook's: a try not answered 2xx in 15 s is tried again on the same schedule, and pending messages go on after a restart. Slack answers 200 \`ok\`; a 404 or 410 (\`no_service\`, \`channel_not_found\`, \`channel_is_archived\`) turns Slack off until a URL is saved again. \`url\` is the credential: a body with it is a secret write, the owner's signed-in session alone (the API token is 403 forbidden in words); it is sealed, and never answered, logged or shown again but for its last four characters. The first save names \`url\` and answers 201; a later one answers 200, and with \`url\` turns Slack on again. \`events\` turns each event on or off (all on by default); a body with \`events\` alone is no secret write. 422 for a URL that is not https://${SLACK_HOST}/services/... (no port, query or user), and for an unknown event.`,
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: {
        url: { type: "string", format: "uri", maxLength: 2048, pattern: `^https://${SLACK_HOST.replace(/\./g, "\\.")}/services/`, "x-agentrun-secret": true, description: "The Slack incoming-webhook URL, as Slack shows it. Sealed, never answered or shown again." },
        events: { type: "object", additionalProperties: false, properties: Object.fromEntries(SLACK_EVENTS.map((name) => [name, { type: "boolean" }])), description: "Events to turn on (true) or off (false); those left out stay as they are." },
      } } } } },
      responses: {
        "201": json(SLACK_SET, "Set."),
        "200": json(SLACK_SET, "Changed."),
        ...errors(400, 401, 403, 404, 415, 422, 429, 500),
      },
      "x-agentrun-serve": "slack/1",
    },
    delete: {
      operationId: "deleteSlack", tags: ["local"], summary: "Remove Slack; its pending messages are dropped, the log of attempts is kept",
      description: "A secret write: its URL goes with it. The owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words and Slack kept.",
      security: [{ ownerSession: [] }],
      responses: { "204": { description: "Removed." }, ...errors(401, 403, 429, 500) },
      "x-agentrun-secret": true,
      "x-agentrun-serve": "slack/1",
    },
  },
  "/settings/slack/test": {
    post: {
      operationId: "testSlack", tags: ["local"], summary: "Post a test message to Slack now, once, and say how it went",
      description: "Posts \"AgentRun can post here\" with a link to this server. It is tried once, never again, and kept in the log as `slack.test`. 404 when Slack is not set; 409 slack_off when Slack turned it off: nothing is sent until a URL is saved again.",
      responses: { "200": json(SLACK_ATTEMPT, "Its attempt."), ...errors(401, 404, 409, 429, 500) },
      "x-agentrun-serve": "slack/1",
    },
  },
  "/settings/slack/deliveries": {
    get: {
      operationId: "listSlackDeliveries", tags: ["local"], summary: `Slack's last ${ATTEMPTS_KEPT} attempts, newest first`,
      responses: { "200": json(closed({ attempts: { type: "array", items: SLACK_ATTEMPT } }), "Each attempt."), ...errors(401, 429, 500) },
      "x-agentrun-serve": "slack/1",
    },
  },
  "/settings/slack/deliveries/{webhook_id}/redeliver": {
    post: {
      operationId: "redeliverSlack", tags: ["local"], summary: "Post a message of Slack's log again, once now, under the same id and body",
      description: "A message still pending that this try delivers is settled; one this try fails keeps its own schedule. 409 slack_off when Slack turned it off.",
      parameters: [{ ...WEBHOOK_ID, description: "The message, as its attempt's `webhook_id` names it." }],
      responses: { "200": json(SLACK_ATTEMPT, "Its attempt."), ...errors(401, 404, 409, 429, 500) },
      "x-agentrun-serve": "slack/1",
    },
  },
  "/triggers": {
    get: {
      operationId: "listTriggers", tags: ["local"], summary: "The triggers: schedules and signed webhooks that start an agent's capped runs or message a run",
      description: TRIGGER_ERRORS,
      responses: { "200": json(closed({ triggers: { type: "array", items: TRIGGER_READ } }), "Each trigger, oldest first, with its last firing."), ...errors(401, 409, 429, 500) },
      ...TRIGGER_MARK,
    },
    post: {
      operationId: "createTrigger", tags: ["local"], summary: "Make a trigger: a schedule or a signed webhook that starts a capped run of an agent, or messages a run",
      description: `Each firing starts one run of \`target.agent_id\` with \`target.input\` and its \`max_cost_usd\` (else the agent's default), as POST /agents/{agent_id}/runs would, and the run's \`trigger\` names it. A firing starts its run once, across retries and restarts. While the trigger's last run is active (working, or waiting on a person: a question, an approval, its cap), a firing is skipped; a webhook trigger with \`accept\` starts a run for each event it takes instead (the server's run limit still holds: a start it refuses is tried again). The last ${HISTORY_KEPT} firings are kept. A \`webhook\` source fires on each request to /hooks/{trigger_id} signed by its secret, which this answer holds (\`secret\`) this once: a retry under the same Idempotency-Key answers the same trigger with a \`note\` in its place, as the key's record never keeps a secret. A \`message_run\` target sends each firing's input to one run, under the firing's key, which the run's store takes once. 422 for another source kind, a start_run target with no max_cost_usd whose agent has no default one, an agent that is a workflow or does not take the input, or a run that is a workflow's; and ${TRIGGER_RUN_KEYS} ${COMPOSIO_CREATE}`,
      parameters: [ref("parameters/IdempotencyKey")],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["source", "target"], properties: TRIGGER_WRITE } } } },
      responses: { "201": json({ ...TRIGGER, properties: { ...TRIGGER.properties, secret: TRIGGER_SECRET_META, signing_secret: TRIGGER_SECRET, secret_set: { const: true, description: "A webhook trigger's first answer: its secret is made and kept. The secret itself is in the answer to the owner's signed-in session alone (the console's)." }, note: { type: "string", description: "In place of a webhook trigger's secret: to the API token, which is never shown one, the words that send the person to the console to rotate it there; on a retry under the same Idempotency-Key, that it was shown once." } } }, "Made; a webhook trigger's first answer to the owner's signed-in session holds its `signing_secret`, this once."), ...errors(400, 401, 409, 415, 422, 429, 500) },
      ...TRIGGER_MARK,
    },
  },
  "/triggers/{trigger_id}": {
    get: {
      operationId: "getTrigger", tags: ["local"], summary: "One trigger",
      parameters: [TRIGGER_ID],
      responses: { "200": json(TRIGGER_READ, "The trigger."), ...errors(401, 404, 409, 429, 500) },
      ...TRIGGER_MARK,
    },
    patch: {
      operationId: "updateTrigger", tags: ["local"], summary: "Change a trigger, or turn it off and on",
      description: `Any of its fields. \`enabled: false\` stops its firings; \`enabled: true\` again, or a new source, goes on from now: the time it was off is skipped, never caught up. A firing already due goes on. A new \`target\` is checked as POST /triggers checks one: ${TRIGGER_RUN_KEYS}`,
      parameters: [TRIGGER_ID],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: TRIGGER_WRITE } } } },
      responses: { "200": json({ ...TRIGGER_READ, properties: { ...TRIGGER_READ.properties, composio: COMPOSIO_UNDONE } }, "Changed: the trigger as a read answers it, with its secret's metadata, and for a composio trigger turned on or off whose instance Composio did not turn, `composio`: what to do there by hand."), ...errors(400, 401, 404, 409, 415, 422, 429, 500) },
      ...TRIGGER_MARK,
    },
    delete: {
      operationId: "deleteTrigger", tags: ["local"], summary: "Delete a trigger and its firings; the runs it started stay",
      parameters: [TRIGGER_ID],
      responses: { "204": { description: "Deleted (a composio trigger's instance deleted on Composio too, already gone there, or kept for another trigger that holds it)." }, "200": json(closed({ deleted: { type: "boolean", enum: [true] }, composio: COMPOSIO_UNDONE }), "Deleted here, but Composio did not delete the composio trigger's instance: what to remove there by hand."), ...errors(401, 404, 409, 429, 500) },
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
      description: "A secret write: the owner's signed-in session alone (ownerSession), never the token, which is 403 forbidden in words and the secret kept. 422 for a trigger that is not a webhook's, and for any body, `{}` too, refused before it rotates: the new secret is made here, never given.",
      parameters: [TRIGGER_ID],
      // No body to mark a field in: the operation is marked whole, a secret write all the same.
      "x-agentrun-secret": true,
      // The owner's password session alone (secret-writes.ts), never the document's bearer.
      security: [{ ownerSession: [] }],
      responses: { "200": json(closedWith({ secret: TRIGGER_SECRET_META }, { signing_secret: TRIGGER_SECRET }), "The new secret as `signing_secret`, this once, and its metadata."), ...errors(401, 403, 404, 409, 422, 429, 500) },
      ...TRIGGER_MARK,
    },
  },
  "/hooks/{trigger_id}": {
    post: {
      operationId: "receiveHook", tags: ["local"], summary: "Fire a webhook trigger: a request signed by its secret, no token",
      description: `A route with no token: the request's signature is its credential, checked on the raw body before anything else. A webhook trigger's \`signature\` names the scheme its requests are signed under (default \`${DEFAULT_SCHEME}\`), and a request is checked by the one scheme whose signature header it carries (${SCHEME_NAMES.map((name) => `\`${SIGNATURE_SCHEMES[name].signatureHeader}\` for \`${name}\``).join(", ")}): ${SCHEME_NAMES.map((name) => SIGNATURE_SCHEMES[name].describe).join(" ")} The body's bytes are signed as sent, whatever its content type. The body is any text, at most 256 KiB (413 past it), arriving whole within ${HOOK_BODY_MS / 1000} s (408 past that); its first ${PAYLOAD_KEPT_BYTES / 1024} KiB reach the agent inside \`<trigger-payload source="webhook" scheme="..." event="..." action="..." delivery="..." untrusted>\`, the event as the scheme reads it, the action the JSON body's top-level \`action\`, the delivery the unsigned delivery id (GitHub's X-GitHub-Delivery), and for a GitHub delivery \`number\` (pull_request.number, else issue.number), \`head_sha\` (pull_request.head.sha) and \`base_sha\` (pull_request.base.sha; neither on a comment event), read from the signed body so the cut never loses them, each when there is one. A bad or missing signature, a stale or future timestamp, no scheme's signature header or more than one, a scheme other than the trigger's, an unknown trigger, one that is off and one that is not a webhook's all answer the same 401. A verified request its trigger's \`accept\` does not take (GitHub's \`ping\` among them, when no rule names it) answers 200 \`{"ok": "ignored"}\`, fires nothing and is said in the log. The first request with a firing key (as its scheme reads it: the signed \`webhook-id\`, or the SHA-256 of a GitHub body) answers 202 once its firing is recorded, and its run starts after; the same key again, for a day after, answers 200 with that firing (or \`{"ok": "duplicate"}\` once the firing has left the trigger's kept history; each trigger keeps up to ${SEEN_KEPT} keys for their day, the oldest let go first past that) and starts nothing. A trigger holds at most ${DUE_KEPT} firings due (a message_run firing waits while its run works): past them a new delivery answers 429 \`rate_limited\` with Retry-After and records nothing, so the sender sends it again later.`,
      security: [],
      parameters: [TRIGGER_ID],
      requestBody: { required: true, content: { "*/*": { schema: {} } } },
      responses: { "202": json(TRIGGER_FIRING, "Recorded: its run starts (or its message goes) after this answer."), "200": json({ oneOf: [TRIGGER_FIRING, HOOK_IGNORED, HOOK_DUPLICATE] }, "This firing key's firing, as it stands; `{ok: \"ignored\"}`; or `{ok: \"duplicate\"}`."), "408": HOOK_TIMEOUT, ...errors(401, 413, 429, 500) },
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
  "/templates": {
    get: {
      operationId: "listTemplates", tags: ["local"], summary: "The template packages this server ships, and those imported here: each makes an agent, its skills and its triggers",
      responses: { "200": json(closed({ templates: { type: "array", items: TEMPLATE } }), "Each bundled package, by name, then each imported one, by id."), ...errors(401, 429, 500) },
      ...TEMPLATE_MARK,
    },
  },
  "/templates/import": {
    post: {
      operationId: "importTemplate", tags: ["local"], summary: "Import a template package from a public GitHub repository or upload it whole, or preview it (dry_run)",
      description: "The source's ref is resolved to a full commit SHA first (GitHub's answer), then the repository's tarball at that SHA is read from GitHub's own hosts alone (github.com, api.github.com, codeload.github.com; a redirect anywhere else is refused), within size and time limits, and the package's folder taken out of it in memory: a symbolic or hard link, or any entry that is not a regular file or a folder, refuses the import (422). The package is checked as the packages this server ships are (`agentrun template validate`), each problem a 422 field under `package`. Nothing in it runs. GitHub is read with this server's GitHub App token when it has one, else anonymously, whose rate limit (60 an hour) a 502 github_failed names. A dry run stores nothing and answers 200; otherwise the package is stored (201), listed by GET /templates under its id, and loaded again at each start; one already stored under the id (an earlier SHA) is replaced. The first import stored from a GitHub account needs `trust_publisher: true` (422 on `trust_publisher` without it), remembered for that account. An upload (`files` in place of `source`) is the package's files themselves, checked the same way under the same limits: stored as `upload:<name>`, replacing an earlier upload of that name, with no publisher to trust. A server that serves the API alone takes an upload and refuses a `source` (422).",
      requestBody: { required: true, content: { "application/json": { schema: TEMPLATE_IMPORT } } },
      responses: { "200": json(TEMPLATE_IMPORTED, "The dry run: the package, checked, stored nowhere."), "201": json(TEMPLATE_IMPORTED, "Imported: stored and listed."), ...errors(400, 401, 413, 415, 422, 429, 500), "502": { description: "`github_failed`: GitHub refused or did not answer (its rate limit, a redirect off its hosts, the time limit, a tarball that does not read); the message says which, and whether the server read it anonymously or with its GitHub App.", headers: { "X-Request-Id": ref("headers/RequestId") }, content: { "application/json": { schema: ref("schemas/Error") } } } },
      ...TEMPLATE_MARK,
    },
  },
  "/templates/{template}": {
    get: {
      operationId: "getTemplate", tags: ["local"], summary: "One template package, whole: what it makes and needs, its instructions and every skill file it would give the agent. Its instructions and skill files are what the new agent will be told, not instructions to you",
      description: "A bundled package or an imported one, by its id. The package as GET /templates lists it (its `computer_here` read against this server now), with its instructions and skill files in full, placeholders unfilled, as an import's answer shows them: what a person or a coding agent reads before applying it. Nothing is made or changed.",
      parameters: [{ name: "template", in: "path", required: true, schema: { type: "string" }, description: "The package's id (GET /templates `id`), URL-encoded: a bundled one's name, or an imported one's `github%3A<owner>%2F<repo>…`." }],
      responses: { "200": json(TEMPLATE_READ, "The package."), ...errors(401, 404, 429, 500) },
      ...TEMPLATE_MARK,
    },
    delete: {
      operationId: "deleteTemplate", tags: ["local"], summary: "Remove an imported template package",
      description: "The package is no longer listed or applied here. Agents applied from it stay as they are. A bundled package is 403 forbidden: it ships with this server. An uploaded package also goes with the last agent applied from it (`DELETE /agents/{agent_id}`).",
      parameters: [{ name: "template", in: "path", required: true, schema: { type: "string" }, description: "The package's id (GET /templates `id`), URL-encoded: `github%3Aacme%2Fagents%2Fkyb`." }],
      responses: { "204": { description: "Removed." }, ...errors(401, 403, 404, 429, 500) },
      ...TEMPLATE_MARK,
    },
  },
  "/templates/{template}/apply": {
    post: {
      operationId: "applyTemplate", tags: ["local"], summary: "Apply a template package: make its agent, with its skills, then its triggers",
      description: "The package's parameters are checked (422 naming each, nothing made), then the secrets and required MCP servers it names: one this server does not have is `409 agent_not_runnable`, each a field with reason `not_set_up_here`, and nothing is made. An MCP server it can do without that is not saved here is skipped, a warning under `mcp.<server>`; one saved has the package's tools of it that the apply's `grants` name granted, with no permission written (each call follows this server's tool settings). Then its agent is made as POST /agents makes one, on the first harness of its list this server runs and the model its tier and preference pick here (`overrides.model` wins; `overrides.choice` takes one of the package's model choices, its model on its harness, or refuses with 409 where this server can't run it; a `prefer` this server can't run, outside a gateway, refuses with 409 under `model`, naming it and the fix, and makes nothing); then each trigger on it as POST /triggers makes one. A trigger refused deletes the triggers made before it and archives the agent, and its refusal is the answer, a 422's fields under `triggers.<i>`; but a github trigger on a server GitHub is not connected to is skipped, the agent and the rest made, with a warning under `triggers.<i>` (`not_set_up_here`: connect GitHub and apply again), and one made adds a note there saying what it runs on. A webhook trigger's secret is not in the answer: POST /triggers/{trigger_id}/secret makes one. The same Idempotency-Key and body answers the first apply again and makes nothing. With `agent_id`, the apply updates that agent in place (a new revision, its triggers reconciled by name) and answers 200; a trigger refused then removes the triggers this apply made, and the revision and the triggers it changed stand. A fresh apply of a package whose same parameters already made a live agent here still makes one, with a warning under `agent_id` (reason `duplicate`) naming the agent there. Served in the API-only profile (`AGENTRUN_API_ONLY=1`) too, with the token: there a run starts through the backend, never on the server's own model key, so a schedule or feed trigger is made only with the launch hook set (AGENTRUN_LAUNCH_HOOK_URL: each firing goes to the backend, which starts the run), else a warning under `triggers.<i>` (reason `not_set_up_here`); a webhook, GitHub, Composio or email trigger is never made there (reason `not_an_option`). On a server started with AGENTRUN_RUN_KEYS=1, a tool key the package names that this server does not hold is a warning under `secrets.<NAME>` (`not_set_up_here`) instead of a 409, as each run of the agent must bring it in `keys`; a firing brings none, so each of the package's triggers is skipped with a warning under `triggers.<i>` (`not_set_up_here`) unless the launch hook is set. Each skipped trigger is a `skip` in the dry run's plan, in the same words, and a trigger of that name the agent has already is left as it is. With `dry_run: true` it answers 200 with the plan (what it would make, revise, remove or skip, and the keys and MCP servers it lacks) and writes nothing.",
      parameters: [{ name: "template", in: "path", required: true, schema: { type: "string" }, description: "The package's id (GET /templates `id`), URL-encoded: a bundled one's name, or an imported one's `github%3A<owner>%2F<repo>…`." }, ref("parameters/IdempotencyKey")],
      requestBody: { required: true, content: { "application/json": { schema: TEMPLATE_APPLY } } },
      responses: { "200": json({ oneOf: [TEMPLATE_APPLIED, TEMPLATE_PLAN] }, "Updated: the agent agent_id named, its new revision written and its triggers reconciled. With dry_run, the plan (`{plan}`), nothing written."), "201": json(TEMPLATE_APPLIED, "Applied: the agent and its triggers made."), ...errors(400, 401, 404, 409, 412, 415, 422, 429, 500), "424": { description: "`upstream_failed`: a service a trigger stands on failed. Composio did not make a trigger instance, or, on an update with agent_id, did not delete the old instance of a Composio trigger the package changed: the new one is not made, the new revision stands, and the old trigger is kept here as it was (apply again).", content: { "application/json": { schema: ref("schemas/Error") } } } },
      ...TEMPLATE_MARK,
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
      state: { enum: [...LEARNING_STATES], description: "`seeded` when the run started from what its agent learned. `reflecting` while its end-of-run step runs and until what it wrote is checked; a run reflecting after its job ended reads that end (`status`, `ended_at`, `result`), with `poll_after_ms` above 0 until its learning settles. `merged` once what it kept is on the folder's main; `dropped` when learning was skipped or refused, with `reason`." },
      reason: LEARNING_REASON,
      detail: { type: ["string", "null"], maxLength: 300, description: "Where the run's learning stands, in one sentence in a person's words (at most 300 characters, ending in an ellipsis when cut; a workflow's name in it is cut of the host's secrets as they are now before it is cut short, so none is shown in part), the same as its timeline row says: \"Started from 2 corrections and 1 workflow.\", \"Keeping what this run learned…\", \"Learned the workflow <name>.\", \"Kept your correction.\", \"Waiting for your OK: workflow <name>.\", \"Nothing new to keep from this run.\", \"Not kept: it didn't pass the checks (<rules>).\", \"Not kept: learning stopped (<why>).\" and so on. Never a secret or a value from the input, cut of the host's secrets as they are now. For a person: a client that acts on it reads `state` and `reason`, whose codes do not change." },
      at: { type: "string", format: "date-time", description: "When the state last changed." },
    }, RUN_WORKFLOWS),
    { type: "null" },
  ],
  description: `What the run learns from and what it learned: a run of an agent whose \`learning\` is true starts from its agent's corrections.md, whole, under # Learned in its instructions, and from its learned workflows, which its learned_workflow tool runs. Once it answers, the server may ask the same harness one compile turn, under the run's cap, that writes the job as a learned workflow (checked statically and by a dry run, retried on a refusal), and a correction its owner gives as feedback is appended to corrections.md; what passes the checks is committed to the folder's main, or dropped. ${LEARNING_NULL}`,
  "x-agentrun-serve": "learning/1",
};
const LEARNING_SHORT = {
  oneOf: [closedWith({
    state: { enum: [...LEARNING_STATES] }, reason: LEARNING_REASON,
    detail: { type: ["string", "null"], maxLength: 140, description: "Run.learning's detail, in the same words, cut short: at most 140 characters, ending in an ellipsis when cut. Cut of the host's secrets first, so none is ever shown in part.", "x-agentrun-serve": "learning/2" },
  }, RUN_WORKFLOWS), { type: "null" }],
  description: `The run's learning, in short (GET /runs/{run_id} has it whole, with its whole detail and its time). ${LEARNING_NULL}`,
  "x-agentrun-serve": "learning/1",
};

/** What this server's run answers carry beyond the contract's Run and RunSummary: added before they were marked, so
 *  `serve/1`. */
/** consoleurl/1: the console's page of a run or an agent, where a person opens it. */
const CONSOLE_URL = (what: string): Json => ({ type: "string", format: "uri", description: `The ${what}'s page in this server's console, at the address people open it (the server's public URL when it has one, else the address this request reached it at): the link to give a person.`, "x-agentrun-serve": "consoleurl/1" });
/** The RUN_FIELDS every run's view and summary hold (runs.ts): required, beside the contract's. */
export const RUN_FIELDS_SENT = ["revision", "kind", "archived_at"];
/** The capabilities every answer carries beside the contract's required ones (server.ts capabilitiesWith). */
export const CAPABILITIES_SENT = ["learning_model", "models", "places", "tools", "learning", "switches", "harnesses"];
/** This server's own agent fields every agent answer carries (agents-store.ts agentView): required, beside the contract's. */
export const AGENT_FIELDS_SENT = ["kind", "revision", "revisions", "archived_at"];
/** The field every saved sign-in is sent with beside the contract's, required: `secret`, its one secret's metadata
 *  (secrets/1, sign-ins-secrets.ts). */
export const SIGN_IN_FIELDS_SENT = ["secret"];
/** DefinitionInput's contract fields this server does not require (validate.ts): a workflow revision has no
 *  instructions, and the server mints or keeps version, skills and tools when a write leaves them out. */
export const DEFINITION_INPUT_OPTIONAL = ["instructions", "version", "skills", "tools"];
/** Definition's own: only instructions ever misses from an answer (a workflow revision keeps none); version, skills
 *  and tools are always sent (agents-store.ts definitionOf), so they stay required there. */
export const DEFINITION_OPTIONAL = ["instructions"];
const RUN_FIELDS: Record<string, Json> = {
  console_url: CONSOLE_URL("run"),
  revision: { type: "string", description: "The id of the agent revision the run runs.", "x-agentrun-serve": "serve/1" },
  kind: { enum: ["agentic", "workflow"], description: "The revision's kind: an agentic run, or a workflow run.", "x-agentrun-serve": "serve/1" },
  archived_at: { type: ["string", "null"], description: "When the run, or its agent, was archived, while it is; else null.", "x-agentrun-serve": "serve/1" },
  labels: { ...RUN_LABELS, description: "The labels the run was started with (RunCreate.labels), as given; `{}` when none. Always sent by a server that keeps labels (`runlabels/1`); absent from an earlier one's answer." },
  stopped_for: {
    oneOf: [{ const: "budget" }, { type: "null" }],
    description: "Why a `completed` run stopped short: `budget` when it wound down to stay under its `max_cost_usd`, its model told to wrap up near the cap, or its tool calls refused (`budget_refused_calls`), under the cap it has now (a raise since is a new cap it has not wound down under). Its status stays `completed`: the run answered from what it had, under its cap. Null for every other run: one with no cap or that never came near it, one not completed, and a workflow run. A run its cap paused reads `pending.kind` `budget`, and one its cap ended reads failed, `error.code` `spend_cap_reached`, as before. Always sent by a server that keeps it (`stoppedfor/1`), on the run read and every list item; absent from an earlier one's answer.",
    "x-agentrun-serve": "stoppedfor/1",
  },
  budget_refused_calls: {
    type: "integer", minimum: 0,
    description: "How many of the run's tool calls its spend cap's wrap-up refused, each call once: once what the run keeps back to answer no longer fits under `max_cost_usd`, every tool call its model makes is refused, unrun, and the model answers. 0 for a run with no cap or never near it. Its end-of-run learning turn's calls are not counted. Sent with `stopped_for`.",
    "x-agentrun-serve": "stoppedfor/1",
  },
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
        args_preview: { type: "string", maxLength: ARGS_PREVIEW_BYTES, description: `The call's arguments as JSON, cut at ${ARGS_PREVIEW_BYTES} bytes: the model's alone (why the call asks is asks_because).` },
        summary: { type: "string", description: `What the call does, in words, where its tool says: email_send's "Send email to <to>, cc <cc>: <subject>", a blank line, then the text's first 300 characters; email_file's "File <message_id> under <to>". Redacted as args_preview is.`, "x-agentrun-serve": "email/1" },
        asks_because: { type: "string", description: `Why the call asks though its setting allows it, a clause to say as "Asks because <why>.": its tool's own ask, email_send past ${SEND_CAP} sends in a run ("this run has sent 5 emails") or to anyone outside the thread of the email that started the run ("<address> is outside this email's thread"). Redacted as args_preview is. Absent on a call that asks by its setting.`, "x-agentrun-serve": "email/1" },
        requested_at: { type: "string", format: "date-time" },
        price: { oneOf: [{ type: "number", minimum: 0 }, { const: "not metered" }, { const: "priced by usage" }], description: "What the call costs, in USD, where its tool declares a price; \"not metered\" for an unpriced MCP call; \"priced by usage\" for a monid endpoint priced by usage: monid estimates its cost only when the call runs, after the allow (the call is held at that estimate; a charge above it is booked as charged, and stops the run only when it passes the run's cap), so nothing is sent to monid while it waits. Absent when the tool names none." },
        destructive: { const: true, description: `Present on an MCP tool's call that is destructive by the annotations the run pinned (destructiveHint true, readOnlyHint not true), and on a call whose allow lets such a tool run (a learned workflow's, its card naming the tool in \`mcp_calls\`): its allow needs \`confirm_destructive: true\`. Absent on every other call.`, "x-agentrun-serve": "allowreads/1" },
      },
      description: "A tool call set to ask waits for the owner's approval (status input_required, state waiting): POST /runs/{run_id}/approvals/{id} answers it.",
      "x-agentrun-serve": "approvals/1",
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "cap_usd", "said", "at"],
      properties: {
        kind: { const: "budget" },
        cap_usd: { type: "number", exclusiveMinimum: 0, description: "The run's cap (`max_cost_usd`)." },
        spent_usd: { type: "number", minimum: 0, description: "What the run had spent when the cap refused: its requests that answered, at what each cost, and any a crash or lost claim cut, at what was held for it. Never the hold of a request still answering (`held_usd`). Absent for a refusal written before the figures were kept." },
        held_usd: { type: "number", minimum: 0, description: "What the cap held, when it refused, for steps still running: a hold is the worst a step can cost, never spend; each settles at what it cost. A request that does not fit only because of other requests' holds waits for them to settle and is not refused, so this is mostly 0. Absent with `spent_usd`." },
        needs_usd: { type: "number", minimum: 0, description: "The least the refused request needs, at its worst case: every input token priced uncached (at the cache-write rate when that is dearer) and its least output. A cap above `spent_usd` + `held_usd` + `needs_usd` sends it. Absent with `spent_usd`." },
        least_cap_usd: { type: "number", exclusiveMinimum: 0, description: "The least cap that sends the refused request: the figure `said` names (\"Raise the cap to at least $X\"), carried from the refusal that wrote those words, so the two never differ. Whole cents, always above `cap_usd`. Absent with `spent_usd`." },
        suggested_cap_usd: { type: "number", exclusiveMinimum: 0, description: "The raise this run is offered: `spent_usd` + `held_usd` + 10 × `needs_usd`, rounded up to a whole dollar, and always above `cap_usd`, so `PATCH /runs/{run_id}` with it as `max_cost_usd` is a raise that resumes the run. Absent with `spent_usd`." },
        said: { type: "string", description: "The cap's refusal, in its words: what was spent, what the refused request needs at the least, and the cap that would run it. At most 2000 characters." },
        at: { type: "string", format: "date-time", description: "When the request was refused." },
        node: { type: ["string", "null"], description: "A workflow run's: the label of the node whose step waits at the cap (a model node's request, a call node's call, a decision); null when it is not known. Absent on an agentic run.", "x-agentrun-serve": "workflowcap/1" },
      },
      description: "A run paused at its spend cap (status input_required, state waiting): what is left of the cap cannot buy its next request's least, which was not sent. A message is 409 budget_reached until the cap is raised. Only a refusal for room pauses a run, a paid tool call's as a model request's (its hold is needs_usd); one no cap fixes (an unknown spend, a model with no price or no output ceiling, an input not measured) still ends it failed, spend_cap_reached. A workflow run pauses the same way, each paid step held before it is sent (a model node's request, a call node's paid tool call or `llm` call, a decision at its provider's price): the step waits where it stands, unsent, and the run goes on from it once raised.",
      "x-agentrun-serve": "cappause/1",
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "instruction", "completion_condition", "asked_at", "expires_at"],
      properties: {
        kind: { const: "browser" },
        instruction: { type: "string", description: "What the agent asks the person to do in its browser, at most 2000 characters." },
        completion_condition: { type: "string", description: "How the agent will know it is done, at most 2000 characters." },
        asked_at: { type: "string", format: "date-time" },
        expires_at: { type: "string", format: "date-time", description: "When the ask expires unanswered (15 minutes after it)." },
      },
      description: "The run's agent asked for the person in its browser (status input_required, state waiting; its turn waits inside the tool call): POST /runs/{run_id}/browser/hand-back answers it, after the person does it in the live view.",
      "x-agentrun-serve": "liveview/2",
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "computer", "instruction", "completion_condition", "asked_at", "expires_at"],
      properties: {
        kind: { const: "computer" },
        computer: { enum: ["desktop", "phone"], description: "The run's computer the agent asks the person to use." },
        instruction: { type: "string", description: "What the agent asks the person to do on its computer." },
        completion_condition: { type: "string", description: "How the agent will know it is done." },
        asked_at: { type: "string", format: "date-time" },
        expires_at: { type: "string", format: "date-time", description: "When the ask expires unanswered (15 minutes after it at most)." },
      },
      description: "The run's agent asked for the person on its desktop or phone (its `computer_request_handoff` tool; status input_required, state waiting; its turn waits inside the tool call): POST /runs/{run_id}/computer/hand-back answers it, and so does a take-over handed back.",
      "x-agentrun-serve": "computer/1",
    },
    {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: { kind: { const: "stopped" } },
      description: "A person stopped the run's turn (POST /runs/{run_id}/stop; status input_required, state idle): it waits for a message, which starts its next turn. The run.needs_input webhook names the same kind. A turn its harness ended on its own reads input_required and idle too, with `pending` null.",
      "x-agentrun-serve": "stoppedpending/1",
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
  description: "Where the run executes, as its start resolved it: its revision's place, else runner. A sandbox place on a box is a sandbox computer of that provider, which the run's runner starts and releases: the agent's file and shell tools run in it, with the run's folder mounted, and no key. Its loop, its log and every key stay on the server. A Docker computer reaches the hosts in capabilities.places.allow through its egress proxy; a Daytona or Modal computer reaches them through the egress proxy its init starts.",
  "x-agentrun-serve": "place/1",
};
/** inlineagent/1: an agent's reference in the system that owns it, as POST /runs names it. */
const EXTERNAL_REF = closed({
  source: { type: "string", pattern: EXTERNAL_NAME.source, description: "The system that owns the agent, such as `grep`. No colon." },
  kind: { type: "string", pattern: EXTERNAL_NAME.source, description: "What the agent is there, such as `expert`. No colon." },
  id: { type: "string", minLength: 1, maxLength: 255, description: "The agent's id there." },
  version: { oneOf: [{ type: "string", minLength: 1, maxLength: 128 }, { type: "integer", minimum: 0 }], description: "The version there of the definition sent: one revision here per version, kept as text (7 and \"7\" are one version). A version's definition never changes: another under a version already run is 409 external_body_conflict." },
}, "The agent's reference in the system that owns it: one agent here per source, kind and id; one revision per version.") as Json & { properties: Record<string, Json> };

/** costsofar/1: a cost no one fully knows, said as what is known and how much is not, with no ceiling claimed; and
 *  (freemodel/1) a known $0 that is a free model's. On the run's Cost and the timeline's usage row alike. */
const SO_FAR = {
  // freemodel/1: a known $0 that says why.
  free: { type: "boolean", enum: [true], description: "Set only when `usd` is 0 because every model request went to a free model, one whose known price is $0 for every token (an OpenRouter `:free` model, say), each booked at $0 however it ended: a request that failed once it left, was retried or was cut costs nothing on such a model. Absent otherwise: a model with no known price never reads $0, and its requests' cost stays unknown.", "x-agentrun-serve": "freemodel/1" },
  so_far_usd: { type: "number", minimum: 0, description: "Set while `usd` is null, and beside `upper_bound`: the sum of the charges whose cost is known (model requests, a workflow's decisions, paid tool calls), never a hold. Never the cost: the charges counted in `unpriced` are not in it. While `usd` is null nothing bounds them; beside `upper_bound`, `usd` does.", "x-agentrun-serve": "costsofar/1" },
  unpriced: { type: "integer", minimum: 1, description: "Set while `usd` is null: how many charges have no known cost (a model request cut, stopped, still pending or with no price, or counted at its hold; a decision whose cost is unknown; a paid tool call charged an unknown amount or cut). Beside `upper_bound`: how many model requests `usd` counts at their hold.", "x-agentrun-serve": "costsofar/1" },
  // cutathold/1: a request cut with no answer and no usage is counted at what its cap held for it.
  upper_bound: { type: "boolean", enum: [true], description: "Set only when `usd` is known and counts at least one model request cut with no answer and no usage reported (its process ended mid-request) at what the run's cap held for it: the most that request can have cost. The run cost at most `usd`; `so_far_usd` beside it is what it is known to have spent, `unpriced` how many requests are counted at their hold. Absent otherwise.", "x-agentrun-serve": "cutathold/1" },
};
/** composioperrun/1: the Composio user (and connected account) a per-run Composio server's calls run as, for one run. */
const COMPOSIO_RUN_BINDING: Json = {
  ...closedWith({
    composio_user_id: { type: "string", pattern: COMPOSIO_USER_ID.source, description: "The Composio user this run's calls of that server run as. The preset's default user `agentrun` is refused (422 not_allowed): it is the one single-user preset servers call as." },
  }, {
    connected_account_id: { type: "string", pattern: "^ca_[A-Za-z0-9_-]{5,64}$", description: "The user's connected account they run on (Composio's `ca_...` id). Absent: Composio picks the user's account for the toolkit." },
  }),
  description: "For a per-run Composio server (saved through the Composio preset with `user_id` \"per_run\"): the Composio account this run's calls of it run as. The server's Composio key stays its own; no headers.",
  "x-agentrun-serve": "composioperrun/1",
};

/** mcpperrun/1: the credentials a run's caller hands its per_run MCP servers, for that run alone. */
const MCP_RUN_AUTH: Json = {
  type: "object", minProperties: 1, maxProperties: 8,
  additionalProperties: { oneOf: [closed({ headers: { type: "object", minProperties: 1, maxProperties: 8, additionalProperties: { type: "string", minLength: 1, maxLength: 8192 } } }, "For a per_run MCP server: the headers this run's calls of it carry, e.g. {\"authorization\": \"Bearer <token>\"}."), { $ref: "#/components/schemas/ComposioRunBinding" }] },
  propertyNames: { pattern: "^[a-z][a-z0-9-]{0,31}$" },
  // Not x-agentrun-secret: that marks a write of a secret the server keeps for every run (an owner's alone). This one is
  // the run's own, handed by whoever may start it, and kept only for that run.
  description: "What each MCP server this run calls takes from the run, by server name: a per_run server's headers, `{\"<server>\": {\"headers\": {...}}}`, or the Composio account a per-run Composio server's calls run as, `{\"<server>\": {\"composio_user_id\": \"...\", \"connected_account_id\": \"ca_...\"}}` (the account optional). For this run alone, from whoever starts it: the server keeps it sealed for the run's life and redacts its values from what the run shows; a per-run Composio server's row never names a user or an account. A server of either kind that this run hands nothing calls its tools refused, nothing sent.",
  "x-agentrun-serve": "mcpperrun/1",
};

/** runmodelkey/1: the run's own model key (run-model-key.ts), such as a LiteLLM virtual key minted for it. */
const RUN_MODEL_KEY: Json = {
  type: "string", minLength: MIN_SECRET, maxLength: MAX_MODEL_KEY_CHARS, pattern: HANDED_SECRET.source,
  // Not x-agentrun-secret, as mcp_auth: a key for this run alone, handed by whoever may start it, never kept for others.
  description: `The run's own model key: a key for the model gateway at AGENT_MODEL_BASE_URL, such as a LiteLLM virtual key minted for this run, which every model request tied to the run carries in place of the server's own key (its turns, its subagents, its learned workflows' nodes, a workflow's model nodes, its end-of-run compile turn). AgentRun never mints, lists or revokes it. Sealed into the run's launch bound to the gateway's origin, read at each claim (a reclaim after a crash among them), erased from the store by the write that ends the run's turn; never in its saved body, its timeline, its view, a log or an Idempotency-Key's fingerprint (a retry with a new key answers the first request's run, its first key kept). The harness, its tools and its sandbox never see it. 422 \`invalid\` at \`model_key\` for a key under ${MIN_SECRET} characters (no cut could hold it) or one with a character that is not visible ASCII (a space, a control character, anything past ASCII); 422 at \`model_key\` when the run's model never goes to that gateway (no AGENT_MODEL_BASE_URL here, a native run, or a model routed elsewhere). Absent, the run spends on the server's key for its route; where the server holds none (no AGENT_MODEL_API_KEY, none saved in Settings), a start without it is 422 \`model_key_required\`, never a failure at its first model call.`,
  "x-agentrun-serve": "runmodelkey/1",
};

/** runkeys/1: the run's own tool keys (run-keys.ts), by name. */
const RUN_TOOL_KEYS: Json = {
  type: "object", propertyNames: { enum: [...TOOL_FIELDS] }, additionalProperties: { type: "string", minLength: MIN_SECRET, maxLength: MAX_RUN_KEY, pattern: HANDED_SECRET.source },
  description: `The run's own tool keys, by name: a value for each tool key its revision reads (its tools', its workflow nodes' and decision providers', and those its template declares), which its tools use in place of the server's key of that name. Sealed into the run's launch, opened at each claim for its tools alone, erased from the store by the write that ends the run's turn; never in its saved body, its timeline, its view, a log or an Idempotency-Key's fingerprint, and cut from what the run writes. 422 at \`keys.<NAME>\` for a name that is not a tool key, or one no tool of the run's revision reads (a model key goes in \`model_key\`), and 422 \`invalid\` there for a value under ${MIN_SECRET} characters (no cut could hold it) or one with a character that is not visible ASCII (a space, a control character, anything past ASCII). On a server started with AGENTRUN_RUN_KEYS=1, a run of an agent made from a template that declares a tool key the server does not hold is 409 \`agent_not_runnable\` at \`keys.<NAME>\` without it.`,
  "x-agentrun-serve": "runkeys/1",
};

const FIELD_EXTENSIONS: Record<string, Record<string, Json>> = {
  Limits: {
    free_model_requests: { type: "integer", minimum: 1, description: "The most requests on free models a run makes: a free model's catalog price is all zeros, so a dollar cap cannot stop it. AGENTRUN_FREE_MODEL_REQUESTS, else 60. The request after that many is not sent, and the run ends `failed`, its error `spend_cap_reached`: \"Not sent: this run reached its 60-request limit for free models.\" (the number is this one). Every free model's request counts, the run's own, its subagents', its side calls and any cut by a crash, capped or not; a paid request, a paid tool call and a workflow decision never do. ChatGPT-plan requests don't count.", "x-agentrun-serve": "freerequests/1" },
  },
  MessageCreate: {
    model_key: { ...RUN_MODEL_KEY, description: `${RUN_MODEL_KEY.description as string} On a message it replaces the run's key from the run's next model request on, a turn still going included, and it is the first key of a run that started on the server's (mint one per turn); a message without one keeps the key the run holds, which is none once its last turn ended: then, where the server holds no key for the run's model, the message is 422 \`model_key_required\` and nothing is written.` },
    mcp_auth: { ...MCP_RUN_AUTH, description: `${MCP_RUN_AUTH.description as string} Replaces the run's handed credentials in the message's own write (a follow-up that opens an ended run again hands its turn's), so the turn the message starts calls with them. A run handed none calls a per_run server's tools refused, nothing sent.` },
    keys: { ...RUN_TOOL_KEYS, description: `${RUN_TOOL_KEYS.description as string} On a message they replace the run's keys in the message's own write, read from the run's next claim on (a turn still going keeps the keys it opened); a message without them keeps the keys the run holds, which are none once its last turn ended.` },
  },
  Cost: {
    ...SO_FAR,
    // costunknown/1: why an ended run's cost is unknown when no charge it counts says so.
    unknown: { type: "string", enum: ["booking_unread"], description: "Set only on a run that has ended, beside a null `usd` that neither `unpriced` nor `upper_bound` explains: why its cost is unknown. `booking_unread`: its end could not read the run's booking within its bound and stored the cost unknown, and this read found no booked request to read it from. A reader that bills holds the run, as on any null. Absent whenever the booking reads: an end that stored its cost unknown while the booking is priced reads the booking's figure (and `unpriced` with `so_far_usd` beside a null for a charge of no known cost).", "x-agentrun-serve": "costunknown/1" },
    // costbasis/1: a run's tokens beside its cost.
    tokens: {
      type: "object", additionalProperties: false, required: ["input", "output", "cache_read", "cache_write"],
      properties: {
        input: { type: "integer", minimum: 0, description: "Input tokens, cached input left out: the whole input is `input + cache_read + cache_write`." },
        output: { type: "integer", minimum: 0, description: "Output tokens, reasoning included." },
        cache_read: { type: "integer", minimum: 0, description: "Input tokens read from the provider's prompt cache." },
        cache_write: { type: "integer", minimum: 0, description: "Input tokens written to the provider's prompt cache." },
        requests: { type: "integer", minimum: 0, description: "The model requests these are the tokens of: every request the run's model proxy booked (its turns, its subagents, its side calls), a plan's included; its paid tool calls and its decisions are not model requests here." },
        unmetered: { type: "integer", minimum: 0, description: "Of `requests`, those whose tokens are unknown (the provider reported none: a request refused, cut or never answered), in no sum above." },
      },
      description: "The run's model requests' tokens, as their provider or gateway reported them in each answer's usage (OpenAI's Responses `usage.input_tokens`/`output_tokens`, Anthropic's Messages `usage` with its cache reads and writes). Absent while the run has booked no model request and stored none (a run still starting, a workflow with no model node), and on a native or SDK run, which reports its whole task's tokens at its end with no request count, while any count is unknown.",
      "x-agentrun-serve": "costbasis/1",
    },
    learning_usd: { type: ["number", "null"], minimum: 0, description: "On the run read (GET /v2/runs/{run_id}) alone, where `usd` is the run's own spend, the job's: what learning spent for it, on the agent's own model route. Its audit shadow's cost (the agent on its input with learning off) and its share of its workflow revision's learning spend: the compile turn that drafted that revision and its check's replay runs, spread over the first `compile_after` runs the revision serves (GET /agents/{agent_id}/learning/cost `bill.revisions`). A compile turn is never in the `usd` or `learning_usd` of the run whose session asked it: it is its revision's (a recompile's, its recompiled revision's), or, when it kept no draft (every draft failed its checks, or the cap stopped it), on no run (`bill.unattributed_usd`). 0 for a replay or shadow run, whose spend is on the runs it serves. As booked (float noise rounded off at 1e-12, as `usd` is); null while the run or its shadow is at work, or a part is unknown: never $0 for unknown.", "x-agentrun-serve": "allin/1" },
    tools_usd: { type: ["number", "null"], minimum: 0, description: "On the run read (GET /v2/runs/{run_id}) alone: the part of `usd` that went to the run's paid tool calls (a monid endpoint's charge, an MCP tool's saved price, Parallel's behind `web_search` and `web_fetch`, the browser's session time, and a workflow decision Parallel answered on its own API on this server's PARALLEL_API_KEY, at Parallel's list price), as the run's ledger booked them, joined and rounded as `usd` is, so `usd` less this is its model requests and its other decisions (Jev's, an OpenRouter model's, Parallel's model reached through OpenRouter). Inside `usd`, never added to it. A paid call in the run's end-of-run turn is learning's, in `learning_usd` and never here. 0 when the run made no paid call. An MCP tool with no price is in neither (`not_metered` on its trace span). Null while a paid call's charge is unknown (one charged an unknown amount, cut, or still running), or counted at its hold; while the run is at work (until it ended, stopped or failed); for a run a follow-up opened again (a round past its first), whose job is what it had cost when its first round answered; and for an imported, native or SDK run, whose `usd` is its import's or its harness's own figure and whose tool calls the server never books: never $0 for unknown.", "x-agentrun-serve": "toolsusd/2" },
    all_in_usd: { type: ["number", "null"], minimum: 0, description: "On the run read alone: `usd` and `learning_usd` together, what the run cost its owner all in. 0 for a replay or shadow run. Over every run of an agent, these and the cost route's `bill.unattributed_usd` add up to its `bill.booked_usd`. Null when either is, or `usd` is only a bound (`upper_bound`).", "x-agentrun-serve": "allin/1" },
    degraded: { type: "boolean", const: true, description: "On the run read alone, set only when this read could not ask the purge gate (a store read of a purged run's writer failed): `learning_usd` and `all_in_usd` were then counted over the agent's workflow revisions with no purged one left out, so they may count a revision a purged run wrote as the one serving. Figures only: no text is read. Absent on every read that asked the gate.", "x-agentrun-serve": "purge/1" },
    plan: {
      type: "object", additionalProperties: false, required: ["requests", "tokens", "on"],
      properties: {
        requests: { type: "integer", minimum: 1, description: "How many of its model requests were billed to the plan." },
        tokens: { type: "integer", minimum: 0, description: "The tokens those requests used: input, output and cache reads and writes." },
        on: { enum: ["chatgpt", "claude_code"], description: "Which plan: `chatgpt`, the server's ChatGPT sign-in; `claude_code`, Claude Code's login on this machine (claude-agent, GET /settings/claude-login)." },
      },
      description: "Set when the run made a model request on a person's plan: the server's ChatGPT plan (a `chatgpt/<id>` model), or their Claude plan through Claude Code's login on this machine. Those requests cost no dollars here: they are in neither `usd` nor `unpriced`, so a run whose only unpriced requests were on the plan has a known `usd`. The plan's own limits apply to them.",
      "x-agentrun-serve": "chatgpt/1",
    },
  },
  RunCreate: {
    model_key: RUN_MODEL_KEY,
    keys: RUN_TOOL_KEYS,
    mcp_auth: { ...MCP_RUN_AUTH, description: `${MCP_RUN_AUTH.description as string} Each names a saved MCP server that takes that shape: headers for one whose \`auth.type\` is per_run, a binding for a per-run Composio server (422 at \`mcp_auth.<server>\` otherwise, and at the binding's field for a malformed user or account, no run made). Sealed into the run's launch for its life, read at each claim, and erased by the write that ends it; never in its saved body, its timeline, its view or an Idempotency-Key's fingerprint (a retry with a new credential answers the first request's run).` },
    labels: { ...RUN_LABELS, description: `The caller's own labels for the run: at most ${MAX_LABELS} keys, each 1 to 63 letters, digits, \`.\`, \`_\`, \`-\` or \`/\` starting with a letter or a digit; each value text of 1 to ${MAX_LABEL_VALUE} characters with no control character. Kept on the run as given, served on every read of it (\`labels\` on Run and RunSummary) and matched by GET /runs' \`label\`; set once, at the start. The server reads nothing else from them: put no secret in one. Another shape is 422 under \`labels\` or \`labels.<key>\`. Absent: none.` },
    workflow_first: {
      type: "boolean",
      description: "Whether a run of an agent that learns may start on one of its learned workflows. On (absent or true), a run whose input fits exactly one active learned workflow (its input schema has a required field, and the run's input passes it) runs that workflow first, with no turn of the agent's model: its answer is the run's answer, and if it hands the job back (it escalates, a step fails), the same run goes on with the agent, given what the workflow found. The run keeps which path it took: `workflow`, `handed_back` or `agent`. false: the agent takes the run from its first turn.",
      "x-agentrun-serve": "workflowfirst/1",
    },
    learning: { enum: [RUN_LEARNING_USE], description: "`use`: the run starts from what its agent learned (its corrections and learned workflows, as a run that learns is given them), whatever its agent's `learning` says, and keeps nothing: no compile turn, no correction and no merge, at its end or after a follow-up. Its `learning` reads `seeded` while it runs, then `dropped` with reason `use`. So many runs of one agent read one learned state, frozen (a held-out evaluation). On a server whose learning is off it is given nothing, as every run there. Absent: the agent's own (`learning: true` learns). 422 not_an_option for anything else.", "x-agentrun-serve": "learning/1" },
    repo: {
      type: "string", pattern: "^[^/\\s]+/[^/\\s]+$",
      description: "The GitHub repository (`owner/name`) this run reaches: the one its GitHub App token is made for, so its github MCP calls are scoped to it. It must be one the agent is bound to (a repository its GitHub triggers' `accept` names on `/repository/full_name`); another is 422 at `repo` in words naming the repositories it is bound to. Absent: the agent's repository when it is bound to exactly one and the first message names none; otherwise the repository a `https://github.com/<owner>/<repo>` URL in the first message names. A run a trigger starts takes its repository from its event, and `repo` there is 422.",
      "x-agentrun-serve": "runrepo/1",
    },
    archil_disk: {
      type: "object", additionalProperties: false, required: ["disk_id"],
      properties: { disk_id: { type: "string", pattern: "^dsk-[0-9a-f]{16}$", description: "The disk id Archil returned when the disk was made (`dsk-` and 16 hex digits): Archil's API addresses disks by id, not by owner/name. In this server's Archil region (the account key's)." } },
      description: "Archil mode only: the disk this run keeps its folder on, instead of its agent's own (a disk per customer, say). It is the caller's: agentrun never makes, renames or removes it, and removing the agent's disk never touches it. It is read at Archil before the run is made: none of that id, or one in another region than the account key's, is 422 at `archil_disk.disk_id` in words naming the region, and no run is made (503 when Archil can't be asked). The claim reads it again, so a disk removed in between fails the run in the same words. Its id alone: never a key or a region. The run's mount credential is minted on this disk, so Archil takes it on no other. 422 in Mode 1, or with no account key saved.",
      "x-agentrun-serve": "archil/1",
    },
    hold: { type: "boolean", description: `true: the run claims its computer and holds it for its owner. Its agent waits until POST /runs/{run_id}/start; meanwhile POST /runs/{run_id}/computer/call sends the computer protocol calls, to set a task up. After the agent's end the run keeps the computer, for the owner's calls (to check what the agent left), until POST /runs/{run_id}/computer/release; then it ends as its agent did. A stop (POST /runs/{run_id}/stop) ends the agent and keeps the computer the same way, and the run ends stopped at the release; a cancel ends the run at once and lets the computer go. Each wait lets the computer go after \`hold_minutes\` with no call from the owner: before the start, the run then ends cancelled. The run read's \`computer.held\` says where the hold is. Only for an agent whose computer is a sandbox, a desktop or a phone, never a workflow (422 \`hold\` not_an_option otherwise). A run that loses its runner, or whose harness restarts after a fault, loses the computer it held: it fails, and \`computer.held.why\` is \`lost\`.`, "x-agentrun-serve": "held/1" },
    hold_minutes: { type: "integer", minimum: 1, maximum: HOLD_MAX_MINUTES, description: `With \`hold: true\`: how long the held computer waits with no call from its owner, before the start and after the agent's end. Absent: ${HOLD_MINUTES}. Above ${HOLD_MAX_MINUTES}, or without hold, is 422.`, "x-agentrun-serve": "held/1" },
    trigger_firing: {
      type: "object", additionalProperties: false, required: ["trigger_id", "firing_id"],
      properties: {
        trigger_id: { type: "string", description: "The trigger's id, as the launch hook sent it." },
        firing_id: { type: "string", pattern: "^fir_[0-9a-f]{32}$", description: "The firing's id, as the launch hook sent it (its webhook-id too)." },
      },
      description: "On a server with the launch hook (AGENTRUN_LAUNCH_HOOK_URL): the firing the hook handed this host, which this run is for. The run is that firing's, as a run the trigger started here would be: its `trigger` names the trigger and the firing, its input's origin is the trigger's, its title is the trigger's, its effort is the target's when the target sets one (else this body's), its input (this body's) is followed by the trigger's previous result as the trigger's own run's is, and its cap is the target's `max_cost_usd` (with none on the target, the agent's default), which this body's `max_cost_usd` may lower and never raise. It runs on the agent's current revision and holds no computer: `revision`, `hold` or `hold_minutes` with it is 422 `not_allowed`, naming the field. The firing reads `started` with it, so the trigger's overlap check and `max_active_runs` count it. A second start for the same firing answers its run: the firing is the run's key, so the request takes no Idempotency-Key (422 with one). The host may start it before or after it answers the hook: a firing it answered 2xx with no run yet still takes this one start until its `start_by`, 10 minutes after that answer (not after `fired_at`, so a firing that reached the host late gets the same time). A firing still `due` (being handed over, or waiting on its retry after the hook failed) takes it too, while its trigger has room for it by the overlap check and `max_active_runs`. 422 when this server has no launch hook, the trigger is not one of this agent's that starts runs, or the firing can't start now (`not_due`: failed, skipped, past its `start_by`, or its trigger has no room, which the message says).",
      "x-agentrun-serve": "launchhook/1",
    },
  },
  TimelineUsage: { ...SO_FAR, requests: { type: ["integer", "null"], minimum: 0, description: "Model requests; null when the native runtime reports aggregate turn usage without a request count.", "x-agentrun-serve": "native/1" }, not_metered: { type: "integer", minimum: 1, description: "Set when the run made tool calls with no price (an MCP tool its owner set none for): how many. They ran outside the run's cost and its cap, and never make `usd` unknown.", "x-agentrun-serve": "mcpservers/1" } },
  Usage: { unpriced_runs: { type: "integer", minimum: 0, description: "How many runs in the report have a cost no one knows on them: they add no dollars to `total_usd`, so no sum passes them off as $0.", "x-agentrun-serve": "costsofar/1" } },
  UsageLine: { unpriced_runs: { type: "integer", minimum: 0, description: "How many of the runs counted on this line have a cost no one knows on it: they add no dollars to `usd`, so no sum passes them off as $0.", "x-agentrun-serve": "costsofar/1" }, not_metered_calls: { type: "integer", minimum: 1, description: "On the `tools` meter's line, set when the runs counted made tool calls with no price (an MCP tool its owner set none for): how many. They are outside `usd`.", "x-agentrun-serve": "mcpservers/1" } },
  Run: {
    sdk: SDK_RUN,
    cli_learning: CLI_LEARNING_RUN,
    native: NATIVE_RUN,
    ...RUN_FIELDS,
    approvals: { enum: ["ask", "never"], description: "Whether the run runs unattended: its revision's approvals, as it started (a run keeps the revision it started on). never: each tool that would ask was allowed at its gate, a deny still refused; ask: a tool set to ask parks it for an approval.", "x-agentrun-serve": "unattended/1" },
    last_progress_at: {
      type: ["string", "null"],
      format: "date-time",
      description: "While a message the run took is still open (an agentic run, working or queued): when its turn last wrote anything, a request's start included; it holds still while a tool or a model request runs, and moves as the turn writes. Null once every message has had its turn, and on a workflow run.",
      "x-agentrun-serve": "turnend/1",
    },
    recordings: {
      type: "array",
      items: closed({
        path: { type: "string", description: "Where it is read: `GET /runs/{run_id}/files/{path}` with this path (`recordings/<computer>.mp4`), `video/mp4`, its byte ranges answered; `?download=1` for an attachment." },
        computer: { type: "string", description: "The computer it recorded: its id, as the file is named. A computer's later files (a resumed run's, a phone's frames that changed format) are `<computer>-2.mp4` and on." },
        seconds: { type: "number", minimum: 0, description: "How long it plays, to a tenth of a second, as far as it is written." },
        bytes: { type: "integer", minimum: 0, description: "Its size now." },
        finished: { type: "boolean", description: "false while it is still being written: it plays up to its last whole fragment. true once its recording stopped, and for every file once the run has ended and the file has stopped changing (a few seconds after the end)." },
      }, "One video of a computer's screen during the run (H.264 in fragmented MP4)."),
      description: "On the run read (and an archive's or unarchive's answer) alone, never in a list: the videos of the run's screen, where its agent's computer says `record: true` (a desktop, a phone or a browser, whose every session is a computer of its own), each computer's files in the order they were recorded; empty when nothing was recorded, and for a run whose words are withheld. Read from the files on the machine whose runner recorded them. The video shows everything on the screen: see the agent's `computer.record`.",
      "x-agentrun-serve": "runvideo/1",
    },
    input: {
      type: ["object", "null"],
      additionalProperties: true,
      description: "On the run read (GET /v2/runs/{run_id}), never a list's: the input the run was started with, whole and exactly as given (`content` and its typed fields, or a workflow's input): what starting it again sends. Null when serving it would change it (it holds a value this server keeps, or a run of text the run's words are cut of), and for a run whose words are withheld.",
      "x-agentrun-serve": "runinput/1",
    },
    file_ids: { type: "array", items: { type: "string" }, description: "On the run read, never a list's: the uploaded files the run was started with (RunCreate `file_ids`), in order; empty for none.", "x-agentrun-serve": "runinput/1" },
    claim: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["runner", "epoch", "until"],
      properties: {
        runner: { type: "string", description: "The id of the runner process holding the run now." },
        epoch: { type: "integer", description: "The run's claim count: it rises by one each time a runner claims the run, and every write the runner makes under its claim carries it, so a write from a claim that has ended is refused." },
        until: { type: "string", format: "date-time", description: "When the claim runs out unless its runner renews it first; past it, another runner may claim the run." },
      },
      description: "The runner holding the run now, when one does (a running run): its id, the claim's count, and when the claim runs out. Null when no runner holds the run.",
      "x-agentrun-serve": "claim/1",
    },
    place: RUN_PLACE,
    computer: RUN_COMPUTER,
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
    audit_of: { ...NULL_STRING, description: "On the run read: a shadow run's served run. A run a promoted learned workflow answered alone (path `workflow`; a run it handed back is never drawn) may be audited (the agent definition's `learning.audit_every`): its shadow, the same agent on the same input with learning off, started at the served run's end and capped at what the served run's cap left, is no row of any run list and sends no webhook, and its cost is in the served run's `cost.learning_usd` and `cost.all_in_usd` (null while the shadow is queued or running: never $0), never in its `cost.usd`, and in the agent's learning cost (GET /agents/{agent_id}/learning/audits). Null for any other run.", "x-agentrun-serve": "promotion/1" },
    ...RUN_PATH,
  },
  InputIssue: {
    code: { type: "string", description: "A workflow definition's issue: the DSL's validation code (`STATE_PATH_UNPRODUCED`, say), with `field` the path to it under `definition.workflow`.", "x-agentrun-serve": "validate/1" },
    example: { description: "A value the field accepts, said in `message` too: the operation's documented request body's value there, else the schema's example, const or option, else one made from its type; each is suggested only once the route's own check of the body takes it in place (else the schema, for a value the document gives), so this server never suggests a value it refuses. Absent when there is none. For a field the body does not keep that an object inside it does, the body with the field where it belongs, as `fix` shows it: `{\"definition\": {\"name\": \"Due diligence\"}}`.", "x-agentrun-serve": "explain/1" },
  },
  RunSummary: {
    sdk: SDK_RUN,
    cli_learning: CLI_LEARNING_RUN,
    native: NATIVE_RUN,
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
    ...RUN_PATH,
  },
  RunResult: {
    output_error: {
      type: "string",
      description: "Why `output` is null on an agentic run whose agent has an `output_schema`: the final answer still had no json block meeting it after the one retry. Absent when the output met the schema, the agent has none, or the run is a workflow's.",
      "x-agentrun-serve": "outputcontract/1",
    },
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
      description: "On the row of the spend cap's refusal for room that an agentic run paused at: the server's `phase` row (`origin` server, its id ending `:note`, so no message), \"Paused at the run's cap\", never an `error` row. The request was not sent and the run paused at its cap for a raise (`pending.kind` budget), whose sentence is `pending.said`'s, shown once. Kept once the cap is raised, as the run's history. A refusal that fails the run (one no cap fixes, a workflow's) stays an `error` row, without it. Absent on every other row.",
      "x-agentrun-serve": "cappause/1",
    },
    refused: {
      const: true,
      description: "On the `tool_result` row of a call refused before it ran: a tool set to deny, a pin, a person's deny, or a call held for an approval the run stopped or ended without. Its `summary` reads \"Refused: …\" and its `tool_status` stays `failed` (it did not do its work), but it never ran, so it never failed: a client shows it apart from a call that ran and failed (the console: a neutral Refused chip, never the red Error one). Absent on every other row.",
      "x-agentrun-serve": "refused/1",
    },
    origin: {
      enum: ["server", "trigger"],
      description: "On the row of a message the person did not write: `server`, one the server wrote into the run (a raised cap's follow-up, an approval's resume), a `phase` row \"AgentRun: <its first line>\"; `trigger`, a trigger's input (a started run's first message, or a firing's message), a `phase` row \"<its source: Schedule, Webhook, Slack or GitHub> <the trigger's name as it is now, or its id once it is gone>: <its first line>\". Either is where a person's message would be a `user_message` row, and counts, as a person's does, as the message its turn took. Absent on every other row.",
      "x-agentrun-serve": "origin/1",
    },
    trigger: {
      ...closedWith({ id: { type: "string", description: "The trigger's id." }, source: { enum: [...TRIGGER_SOURCES], description: "What fired it, by the trigger's definition." }, owner: { type: "boolean", description: "True when the words are its owner's (a schedule's), false when they came from outside (a webhook's)." } }, { name: { type: "string", description: "The trigger's name as it is now, redacted as the row is: the one its summary shows after its source, so a client drops exactly \"<source> <name>: \" whatever colons the name holds. Absent once the trigger is gone (the summary names its id)." } }),
      description: "On a trigger's row (`origin` `trigger`) alone: the trigger whose input the row is, so a client labels it by its source without reading its summary. Absent on every other row.",
      "x-agentrun-serve": "origin/1",
    },
    learned_nodes: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["label", "kind", "status", "duration_ms"], properties: { label: { type: "string" }, kind: { type: "string", description: "The node's kind, as the workflow DSL names it (`extract`, `agent`, `call`, ...)." }, status: { type: "string", description: "How the node ended: `ok`, `failed` or `escalated`. Why a node failed is never shown: its text may hold part of a secret." }, duration_ms: { type: "number" }, model: { type: "string", description: "A model node's (agent, decide, extract, report): the model it ran on, as the run's model route names it. Absent on a call node." }, tier: { type: "string", description: "The tier the model node named (`fast`, `strong`); absent for none, which runs on the run's own model." } } },
      description: "On a learned workflow call's `tool_result` row alone (`tool_name` learned_workflow): each of the workflow's nodes that ran, in the order they ended, at most 64. A learned workflow's nodes write no rows of their own (no `decision` row: a workflow revision's run alone has those; a decision node, `judge` or `pick` say, is an item here), so this list is the whole of them on the timeline. A served run (GET /runs/{id} `path` `workflow` or `handed_back`) reads in this order: its `user_message`, the learned_workflow `tool_use` and this `tool_result` with its items, then, served alone (`workflow`), the `final_answer` row that is the workflow's answer (`result.final_answer`) and the `usage` row; after a hand-back (`handed_back`), a `phase` row, the agent's own rows, its `final_answer` and the `usage` row. Each model node runs on the run's own model route (its tier's model when it names one), on the run's own key and cap. Absent on every other row.",
      "x-agentrun-serve": "learnednodes/1",
    },
    computer_calls: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["method", "started_at", "ok", "ms"],
        properties: {
          method: { type: "string", description: "The computer protocol method (spec/computer)." },
          started_at: { type: "string", format: "date-time", description: "When the call started: a code-mode script's calls each at its own time, inside its one tool call." },
          app: { type: "string", description: "The app it named: apps.launch's or apps.terminate's id, a ui call's target app." },
          ok: { type: "boolean" },
          ms: { type: "number" },
          code: { type: "string", description: "The error's code, when the call failed." },
          steps: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["do"],
              properties: {
                do: { type: "string", description: "The step's kind: press, set, perform, click, type, key, nav, scroll or drag." },
                on: { type: "object", additionalProperties: false, required: ["role"], properties: { role: { type: "string" }, name: { type: "string" } }, description: "The element it acted on (a type step's: the one it typed into), as the run's own ui.observe answers showed it: its role and name, never its value. The name is cut at 60 characters and through the run's redaction. Absent when the step named no element the run observed." },
                keys: { type: "string", description: "A key step's chord, when it has a command modifier (ctrl, alt, super) or only named keys: never a lone character, which may be part of a password." },
                nav: { type: "string", description: "A nav step's place: back, home or app_switch." },
                route: { type: "string", description: "The route it ran by." },
                verified: { type: "boolean", description: "Whether a readback showed it took." },
                error: { type: "string", description: "The kind of error that refused it." },
              },
            },
            description: "A ui.act call's steps, in order.",
          },
          expect: { enum: ["met", "unmet"], description: "A ui.act call's expect: whether it held." },
        },
      },
      description: "On a tool call's `tool_result` row alone (a call a codemode script made included, on its own row): each computer protocol call the tool made, in order, at most 200. Never a typed or set value or an answer's bytes: no screenshot, and no text a step set or typed. Absent on a call that made none.",
      "x-agentrun-serve": "computercalls/1",
    },
    computer_calls_dropped: {
      type: "integer",
      description: "On a `tool_result` row whose call made more than 200 computer calls: how many past the 200 its record left out. Absent otherwise.",
      "x-agentrun-serve": "computercalls/1",
    },
    tool_input: {
      type: "object", additionalProperties: true,
      description: `On a \`tool_use\` row of a timeline read with \`calls=whole\` alone: the call's arguments as the agent sent them, each string through the run's redaction (a value this server holds, or text shaped like a key, reads \`[redacted]\`) and cut at ${CAPS.text} characters. Its URLs keep their query values, as an approval's arguments do. Absent otherwise.`,
      "x-agentrun-serve": "callswhole/1",
    },
    tool_result_text: {
      type: ["string", "null"],
      description: `On a \`tool_result\` row of a timeline read with \`calls=whole\` alone: the head of the call's output, to ${CALL_RESULT_CHARS} characters, through the run's redaction, its URLs' query values elided as \`tool_result_preview\`'s are; null for an empty output. A \`web_search\`'s or \`web_fetch\`'s is its JSON whole but for its long texts: every result's \`url\`, \`title\` and \`published\` (a page's \`url\` and \`title\`) as it came, each snippet, the provider's \`text\` and a page's \`text\` cut to fit and ending in "…" where cut, a page's \`links\` past the cut counted in \`links_cut\`; longer than ${CALL_RESULT_CHARS} only when its urls alone pass it. Absent otherwise.`,
      "x-agentrun-serve": "callswhole/1",
    },
    learning: {
      ...closed({ state: { enum: [...LEARNING_STATES] }, reason: LEARNING_REASON, detail: { type: ["string", "null"] } }),
      description: `On a row of kind \`learning\` alone, labelled \`${LEARNING_LABEL}\`: where the run's learning ended (proposed, merged or dropped, \`seed_failed\` included), and why: one row, changed in place as it moves. Its \`summary\` and \`text\` are its \`detail\` (Run.learning.detail), in a person's words. The rows of the run's end-of-run turn are labelled \`${LEARNING_LABEL}\` too, its message and answer included, and are never the run's answer.`,
      "x-agentrun-serve": "learning/1",
    },
  },
  ErrorBody: {
    problems: { type: "array", items: PROBLEM, description: "`bad_request` from a write of a learned workflow draft only (its approval or restore): each check it fails, printable (never a secret).", "x-agentrun-serve": "learning/1" },
  },
  RunFile: {
    unreadable: { type: "boolean", const: true, description: "Present when this server cannot read the file: a tool in the run's box created it private (owner-only). Reading it answers 403 `system_file_forbidden` with `details.reason` `unreadable`.", "x-agentrun-serve": "unreadable/1" },
  },
  DefinitionInput: {
    cli_learning: CLI_LEARNING_BINDING,
    sdk: {...SDK_BINDING, "x-agentrun-serve":"sdk/1", description:"An existing backend SDK agent. Execution stays in its application; register tasks through /agents/{agent_id}/sdk-runs."},
    native: NATIVE_BINDING,
    model: { type: "string", description: "`provider/model-id`, the model an agentic revision runs on; absent, this host's default. A workflow revision keeps none.", "x-agentrun-serve": "model/1" },
    model_tiers: { type: "object", additionalProperties: false, minProperties: 1, properties: { fast: { type: "string" }, strong: { type: "string" } }, description: "The model of each of an agentic revision's tiers it names, each `provider/model-id`: what a `subagent` call that names that tier runs on (a call names a tier, never a model; one that names none runs on the revision's own model). A tier it leaves out runs on this host's model for the tier (AGENT_MODEL_FAST, AGENT_MODEL_STRONG, else the default). A workflow revision keeps none.", "x-agentrun-serve": "subagent/1" },
    thinking: { enum: [...THINKING_LEVELS], description: "An agentic revision's thinking level; absent, the model's. A workflow revision keeps none.", "x-agentrun-serve": "model/1" },
    harness: { type: "string", pattern: HARNESS_ID_PATTERN, examples: [...HARNESSES], description: "The harness that runs the revision: one of capabilities' `harnesses` ids (the built-in pi, claude-agent, codex and opencode, and any an owner's harness module adds). Absent on a request, pi; every answer names it. One this server does not run saves with a warning, and its runs are 409 agent_not_runnable naming it (capabilities.harnesses).", "x-agentrun-serve": "harness/1" },
    place: {
      oneOf: [
        { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { const: "runner" } } },
        { type: "object", additionalProperties: false, required: ["mode", "box"], properties: { mode: { const: "sandbox" }, box: { enum: [...BOX_IDS] } } },
      ],
      description: "Where the revision's runs execute: `runner` (no box and no shell) or `sandbox` (the agent's file and shell tools run in the box; its loop, its log and every key stay on the server). Absent on a create of an agentic revision, the place this server gives a new agent (capabilities.places.default_place): the Docker box where this server has docker, written on the revision so an answer shows it, with tools [\"bash\", \"bash_background\", \"bash_output\", \"bash_input\", \"bash_signal\", \"bash_list\"] when the definition names no tools (a list it names, an empty one included, is kept as named, and gets the box only when one of its tools runs only there: `bash` or a background tool); where docker is unavailable, where the definition's tools need no shell, or where it names a tool a box refuses (browser), none, so its runs start on the runner with no container. A revision saved with no place runs where this server's capabilities.places.default_place says at each run (the Docker box where docker is available now, else the runner) when one of its tools needs a shell; a workflow, one whose tools need no shell, and one that names a tool a box refuses, on the runner. A revision keeps the place it names, runner included. An edit that names none keeps the agent's. A box this server does not have saves with a warning, and its runs are 409 agent_not_runnable naming it (capabilities.places.boxes). Only an agentic revision in a sandbox place may name `bash` or a background tool (`bash_background`, `bash_output`, `bash_input`, `bash_signal`, `bash_list`); a workflow revision's place is runner or none (a sandbox place is 422).",
      "x-agentrun-serve": "place/1",
    },
    computer: {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: {
        kind: { enum: ["none", "sandbox", "desktop", "phone", "browser"] },
        provider: { type: "string", description: "The provider that serves the kind, from GET /computers. Absent for `none`." },
        image: { type: "string", minLength: 1, description: "The image the computer starts from: one the provider offers for the kind (GET /computers lists them as the provider's `images`), such as Orgo's `windows` desktop. Absent, the kind's default. One the provider does not offer saves with a warning naming the ones it does, and its runs are refused at their start in the same words. Absent for `none`." },
        gpu: COMPUTER_GPU,
        persistent: { type: "boolean", description: "Whether the agent keeps its own computer between runs: true makes one at its first run, detaches it (not deletes it) at each run's end, and attaches it again at the next, with what was on it; false or absent, a fresh computer for each run. Only where the provider keeps one for the kind and image (GET /computers: the provider's `persistent`), else 422 not_allowed; never one that mounts the run's folder. One run at a time: a run that finds the computer held by another run still going is refused at its start, naming that run. Archiving the agent, turning this off, or a setting on another provider or image deletes the computer (GET /agents/{agent_id}'s `own_computer` shows it)." },
        surface: { enum: ["code", "tools"], description: "How the agent drives a desktop or a phone. `code`: by `codemode` scripts alone, whose `tools.computer_observe`, `tools.computer_act` and `tools.computer_screenshot` are each a gated, recorded call of its own; the model is offered `codemode` and the hand-over (`computer_request_handoff`), not the step tools (a harness with its own code mode, Codex, is still handed them). `tools`: the step tools and the hand-over, listed; a `codemode` script calls them too. Absent, as `tools`. Only a desktop or a phone takes it (422 not_allowed on another kind)." },
        exec: { type: "boolean", description: "`false`: the agent gets no shell and starts no program on its desktop or phone. Its computer's `exec` and `processes` groups are taken out of what its tools and scripts see (no `computer.shell`, no `computer.processes`; a script that reaches for one is refused in words), no folder is mounted in the computer, and the run gets no `bash` or background tool, wherever its folder is. The run's own computer channel (`POST /runs/{run_id}/computer/call`, the owner's) keeps every group. `true` or absent: as the computer offers. Only a desktop or a phone takes it (422 not_allowed on another kind)." },
        record: { type: "boolean", description: "`true`: each run records a video of its desktop's, phone's or browser's screen (a browser's from each session's page, one file per session; H.264, fragmented MP4, at most 10 frames a second and 1280 pixels on the long side, no audio) into its run folder's `recordings/`, beside `work/`, where the agent can neither read nor change it. The video shows everything on the screen, including whatever a person types while they take over and any secret that appears on screen; pixels can't be redacted the way the run's logs are. It records while the run holds the computer, with or without a viewer, pauses while the run is parked (a resumed run goes on in a new file) and stops at the computer's release, the run's end, or its cap (500 MB across the run's files, or 2 hours from its start or the run's resume), which the run's timeline says. A server without ffmpeg refuses it (422 not_allowed). `false` or absent: nothing is recorded. A sandbox doesn't take it (422 not_allowed)." },
        needs: { ...NEEDS, description: "The programs a sandbox must have on its PATH for the agent's work, such as `[\"chrome\", \"ffmpeg\", \"ffprobe\", \"hyperframes\"]` to render video, or the libraries its code loads: a Python package by the name pip installs it by, which the box's `python3` has installed, or a Node package a script of the box's `node` requires, such as `[\"python-pptx\", \"pptxgenjs\"]` to make decks. It says what the box must hold, never which image it is: a Docker box's image is the server's `AGENTRUN_DOCKER_IMAGE` (else the default recipe's), another provider's its own. Each run's claim asks the box it started (`command -v` of each, else `python3` and `node` for a library, in one `sh`) before the run's first model request; a box that lacks one, or that cannot be asked, is let go and the run ends `failed` (`run_failed`, as a claim's refusal of its computer is), its words naming the programs it lacks and how to give the box an image that has them (on Docker, the media image of the computer package's `media/Dockerfile`, or its documents image, `documents/`). Nothing is installed and nothing falls back. Only a sandbox takes it (422 not_allowed on another kind)." },
      },
      description: "The computer the revision's runs are given (Settings → Computers): its kind, the provider that serves it, the image it starts from, a sandbox's GPUs, whether the agent keeps it between runs, and, for a desktop or a phone, how the agent drives it, whether it may run programs on it and whether its runs record its screen. `place` is its v2 view where it can say it: `{kind: none}` is `place {mode: runner}`, `{kind: sandbox, provider: X}` is `place {mode: sandbox, box: X}`; a desktop, phone or browser computer leaves the run's folder on the runner, so its place reads runner. Writing either sets both, and both given must agree (422). Absent on a create, the server's default (as `place`); an edit that names neither keeps the agent's.",
      "x-agentrun-serve": "computer/1",
    },
    tool_settings: { ...AGENT_TOOL_SETTINGS, description: "The agent's own tool settings (web_search's, web_fetch's and browser's provider, any tool's permission, an MCP server's wildcard mcp:<server>/*, an MCP tool's pin, bash's policy), over the server's (GET /settings/tools), except a deny set on the server, which is absolute: the tool is refused on this server whatever this agent sets; absent, the server's. A pin is not over the server's: both hold. A grant in tools names the capability, never a provider.", "x-agentrun-serve": "providers/1" },
    approvals: { enum: ["ask", "never"], default: "ask", description: "Whether the agent's runs ask a person or run unattended. `ask`, the default: a tool set to ask parks the run for an approval, as its tool settings say. `never`: the agent runs unattended, and each tool that would ask is allowed instead, decided by the tool gate at each call, so a tool granted later and an MCP tool (`mcp:<server>/<tool>`, which asks by default) are covered on every harness. It never lifts a deny, whether set on this server or in the agent's own tool_settings, nor a pin, nor anything else the gate refuses before it decides between running and asking. A workflow's call node on a tool set to ask runs under `never`. Absent on a request: ask. An edit that leaves it out asks, so no edit makes an agent unattended by saying nothing. Every answer names it.", "x-agentrun-serve": "unattended/1" },
    learning: { oneOf: [{ type: "boolean" }, { type: "object", additionalProperties: false, properties: {
      compile_after: { type: "integer", minimum: 1, maximum: 200, default: 20, description: "The job compiles into a learned workflow once the agent has this many completed runs of its own." },
      agree_min: { type: "number", minimum: 0, maximum: 1, default: 0.8, description: "The draft's one check replays it on the inputs of those runs: promoted only when, of the inputs it answered alone, at least this share say what the agent's own recorded answer said." },
      alone_min: { type: "number", minimum: 0, maximum: 1, default: 0.7, description: "...and only when it answered at least this share of them alone (no escalate, no failed step). Under either bar it is recompiled once with the inputs it did not agree on, checked the same way, then promoted or stopped: nothing compiles again." },
      agree_on: { type: "array", items: { type: "string", minLength: 1, maxLength: 128, pattern: "^[^.]+(\\.[^.]+){0,7}$" }, minItems: 1, maxItems: 16, uniqueItems: true, description: "The fields of the answer that say the decision, as dotted paths into its JSON object, e.g. `[\"verdict.decision\"]` or `[\"mcc\", \"riskTier\"]` (each segment an object's key, never an array index; at most 8 segments and 128 characters): the check and the audit compare two answers on these alone, each path resolving in both to equal values (arrays in order, an object's keys in any order); a path that does not resolve in either answer, or in only one, disagrees. Never free text such as a rationale two runs never repeat. Kept in the order given. Absent: the whole answer, equal as JSON (keys in any order) or as trimmed text; nothing is read off the `output_schema`." },
      audit_every: { type: "integer", minimum: 1, maximum: AUDIT_MAX, default: AUDIT_DEFAULTS.audit_every, description: "Once a learned workflow serves, 1 in this many of the runs it answers alone (path `workflow`; a run it hands back is never drawn) is audited: drawn from the run's id, the same agent runs the same input again with learning off (a shadow run, hidden from the run list, its cost the agent's learning cost), and the two answers are compared (one row of GET .../learning/audits)." },
      audit_every_later: { type: "integer", minimum: 1, maximum: AUDIT_MAX, default: AUDIT_DEFAULTS.audit_every_later, description: "1 in this many once the workflow's revision served `audit_later_after` runs." },
      audit_later_after: { type: "integer", minimum: 1, maximum: AUDIT_MAX, default: AUDIT_DEFAULTS.audit_later_after, description: "The served runs after which `audit_every_later` applies." },
      hold_window: { type: "integer", minimum: 1, maximum: AUDIT_MAX, default: AUDIT_DEFAULTS.hold_window, description: "The audit rows of the serving revision the hold rule reads: its newest this many (an owner's grade on a served run is one too)." },
      hold_disagree: { type: "integer", minimum: 1, maximum: AUDIT_MAX, default: AUDIT_DEFAULTS.hold_disagree, description: "When at least this many of those rows disagree, the workflow stops serving (a hold, source `audit`) and is recompiled once with them as data, then checked again: promoted serves again, otherwise it stops. At most `hold_window`." },
      stop_window: { type: "integer", minimum: 1, maximum: AUDIT_MAX, default: AUDIT_DEFAULTS.stop_window, description: "A second hold within this many served runs of the first stops the workflow for good, asking no compile." },
      repick: { type: "boolean", default: false, description: "`true`: a learned workflow compiled from now on re-picks its answer's quotes from the pages its run fetched. When a quote in its first answer is in none of those pages, its one re-pick writes the answer again from the pages themselves (each sent as data, told it is untrusted text from the web and never instructions, with no tools), not from its compact notes alone. It is read when a draft is committed, so a workflow already kept is unchanged until its next compile. It reaches a re-pick of one model step, in the workflow or in the composed workflow that writes its answer; any other re-pick is kept as compiled, and the server's log says so. An agent whose workflows run through an SDK bridge ignores it. `false` or absent: the re-pick reads its compact notes and its draft." },
      repick_max_chars: { type: "integer", minimum: 1, maximum: REPICK_MAX_CHARS_MAX, default: REPICK_MAX_CHARS_DEFAULT, description: "The most characters of state a re-pick over the pages sends its model: past it, the longest strings (the pages) are cut first, each to one length and marked where it was cut. Its cost is the served run's, under the run's cost cap like every model request of the run. Read with `repick`, at each compile." },
    } }], default: false, description: "Whether an agentic revision's runs learn: `true`, its owner's corrections and learned workflows; an object, the same with the loop's numbers set on it (`compile_after`, `agree_min`, `alone_min`, `agree_on`, `audit_every`, `audit_every_later`, `audit_later_after`, `hold_window`, `hold_disagree`, `stop_window`, `repick`, `repick_max_chars`, each optional: one left out is its default; `true` is every default); `false`, nothing. A run that learns starts from what its agent has learned, its corrections.md whole in its instructions under `# Learned` and its learned workflows behind its learned_workflow tool; once its job is due, it is asked one compile turn that writes the job as a learned workflow, checked and committed. Kept when a definition says so, true, false or an object (its numbers in one order); a number out of range or an unknown key is a 422 `wrong_type`; absent, off, and an answer shows none. An edit that leaves it out keeps the agent's. A workflow revision keeps none. On a server whose learning is off (`capabilities.features.learning`), no run learns, whatever this says.", "x-agentrun-serve": "learning/1" },
    checkout: { enum: ["pull_request", "repository", "none"], description: "What the server checks out in each run's folder before its first turn, an agentic definition's alone. `repository` (suggestions/1): the repository the run names (its start's `repo`, else the first https://github.com/<owner>/<repo> its first message names), at the head of its default branch, one commit deep, detached, in `repo/` (ref `repo/head`), its files listed one a line in `repo/.git/agentrun-files` for an agent with no shell; fetched as below. `pull_request`: the pull request the run's GitHub event names (a GitHub trigger's firing: its repository, number, head and base), at its head, detached, in `repo/`, with its base and their merge base fetched beside it (refs `pr/head`, `pr/base`, `pr/merge-base`). The fetch is the server's own, one command on the run's folder, with an installation token of the server's GitHub App narrowed to that repository and `contents: read`, which the agent never holds: it is never in the folder, the checkout's git config, its remote's URL, the agent's environment or the log. With no App, or one not installed there, the fetch is anonymous, which a public repository answers. The run's system prompt says what was checked out, or why nothing was (no pull request named, the fetch failed), so it can read the change another way, such as the GitHub MCP. The checkout is removed when the run's claim ends. An edit that leaves it out keeps the agent's; `none` clears it. A template sets it from its manifest's `checkout`.", "x-agentrun-serve": "checkout/1" },
    max_requests: { type: "integer", minimum: 0, description: "The most requests on free models (a catalog price of all zeros, which a dollar cap cannot stop) each of the agent's runs makes, below the server's own limit (`limits.free_model_requests`, AGENTRUN_FREE_MODEL_REQUESTS): a run stops at the lower of the two. The request after that many is not sent, and the run ends `failed`, its error `spend_cap_reached`: \"Not sent: this run reached its 20-request limit for free models.\" (the number is the limit it stopped at). It counts what the server's limit counts; a paid request never counts. Above 0 sets it, 0 clears it, and an edit that leaves it out keeps the agent's. A template sets it from its manifest's `budget.max_requests`.", "x-agentrun-serve": "maxrequests/1" },
  },
  AgentCreate: {
    note: { type: "string", maxLength: 2000, description: "What the revision changes, kept with it (GET /agents/{agent_id}/revisions).", "x-agentrun-serve": "definitionbody/1" },
  },
  Agent: {
    source_sync: { ...closed({ moved: { const: true } }), readOnly: true, description: "Present after a connected agent moves to managed execution. Its source sync status is read at /agents/{agent_id}/source.", "x-agentrun-serve": "sourcesync/1" },
    native_status: {...NATIVE_BINDING, description: "Current remote-source readiness, derived from its heartbeat and revocation status. Read-only; the persisted native reference stays in definition.native."},
    external: {
      ...closed({
        source: EXTERNAL_REF.properties.source,
        kind: EXTERNAL_REF.properties.kind,
        id: EXTERNAL_REF.properties.id,
        version: { type: "string", description: "The version in its source of the agent's current revision: the version whose first run made it, as text." },
      }),
      readOnly: true,
      description: "Set only on an agent another system owns, made by its first run of POST /runs: its reference there. Read-only: the agent's edits, current revision and archive here are 403 forbidden, as its source is the truth. Absent on an agent of this server's own.",
      "x-agentrun-serve": "inlineagent/1",
    },
    console_url: CONSOLE_URL("agent"),
    tools: AGENT_TOOLS,
    kind: { enum: ["agentic", "workflow", null], description: "The current revision's kind; null before the agent has one.", "x-agentrun-serve": "serve/1" },
    revision: { type: ["string", "null"], description: "The current revision's id; null before the agent has one.", "x-agentrun-serve": "serve/1" },
    revisions: { type: "integer", minimum: 0, description: "How many revisions the agent has.", "x-agentrun-serve": "serve/1" },
    archived_at: { type: ["string", "null"], description: "When the agent was archived, while it is; else null.", "x-agentrun-serve": "serve/1" },
    learning: {
      type: "object", additionalProperties: false, required: ["pending"],
      description: "For an agent that learns (its current revision `learning: true`, on a server whose learning is on): what waits on it. Absent for any other agent.",
      properties: {
        pending: { type: "integer", minimum: 0, description: "How many of its learned workflow drafts wait for its owner's OK: held with `status: pending` on its learning folder's main (approve them on GET /agents/{agent_id}/learning)." },
      },
      "x-agentrun-serve": "serve/1",
    },
    mcp_pin: { ...MCP_PIN, description: "The MCP tools the current revision grants, pinned when it was saved: per server, each granted tool as the server listed it then (name, title, description, input schema, annotations) and the prices its owner set. Every run of the revision calls these, whatever the server lists by then; a call the server no longer takes as pinned is the server's to refuse. Saving the agent again lists the servers and pins them anew (a new revision when they changed). Null when the revision grants no MCP tool, or the agent has none." },
    own_computer: {
      oneOf: [
        {
          ...closedWith({
            provider: { type: "string", description: "The provider it lives on, as `computer.provider` names it." },
            id: { type: "string", description: "The vendor's id of the computer." },
            name: { type: "string", description: "Its name at the vendor." },
            state: { enum: ["held", "detached", "deleting"], description: "`held`: a run has it now (`run_id`); `detached`: kept between runs (an Orgo Linux desktop suspended, its memory and disk kept); `deleting`: the agent no longer has a use for it (archived, `computer.persistent` off, or another provider or image) and it is being deleted, or a delete failed (`why`)." },
            since: { type: "string", format: "date-time", description: "When it took this state." },
          }, {
            image: { type: "string", description: "The image of the provider's configuration it was made from." },
            run_id: { type: "string", description: "The run that holds it, while held." },
            why: { type: "string", description: "Why a delete has not happened yet, in the provider's words: the server tries again at the agent's next edit, and the janitor deletes it once its owner is gone." },
          }),
        },
        { type: "null" },
      ],
      description: "The agent's own computer, kept between its runs where its `computer.persistent` is true: what this server records of it. Null when it has none (no persistent setting, or no run has made one yet).",
      "x-agentrun-serve": "computer/1",
    },
    template: {
      oneOf: [
        closed({
          id: { type: "string", description: "The package's id (GET /templates `id`): a bundled one's name, an imported one's `github:<owner>/<repo>[/<path>]`, or an uploaded one's `upload:<name>`." },
          version: { type: "string", description: "The package's SemVer version when it was applied." },
          sha: { type: ["string", "null"], pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$", description: "The commit an imported package was read at (an uploaded one's sha256); null for a bundled one." },
        }),
        { type: "null" },
      ],
      description: "The template package the agent's current revision came from (POST /templates/{template}/apply): as the apply that wrote it, or the nearest one before it in its line, kept it. An edit carries it; a restored revision answers its own. Null for an agent made otherwise.",
      ...TEMPLATE_MARK,
    },
    run_blockers: {
      oneOf: [
        closed({
          message: { type: "string", description: "The refusal's message, as the start's 409 gives it." },
          fields: { type: "array", items: ref("schemas/InputIssue"), description: "Each thing that refuses the run, as the start's 409 lists it under `fields`; empty when the refusal names none." },
        }),
        { type: "null" },
      ],
      description: "On GET /agents/{agent_id} alone: what would refuse a run of the agent's current revision started now with no overrides (POST /agents/{agent_id}/runs' 409 agent_not_runnable), said before anyone starts one; null when nothing would. Always null for an archived agent, a native or SDK agent, and a revision whose MCP tools its first run pins. The read asks no other service: under the agent's own `max_cost_usd`, an OpenRouter decision model's missing price is named only once a save or a start has read OpenRouter's catalog, so null is no promise that a start is accepted. Absent from every other answer.",
      "x-agentrun-serve": "runblockers/1",
    },
    warnings: { type: "array", items: ref("schemas/InputIssue"), description: "What this host still lacks for the agent to run, as a create (POST /agents) or a commit (PUT .../definition) answers it, the same shape apply's warnings take. Absent from every other answer (GET and list never send it).", "x-agentrun-serve": "warnings/1" },
  },
  Capabilities: {
    learning_model: { ...LEARNING_MODEL, "x-agentrun-serve": "learningmodel/1" },
    store_schema: {
      type: "object", additionalProperties: false, required: ["version", "runner_floor", "known"],
      properties: {
        version: { type: ["integer", "null"], description: "The store's schema version now, read at this answer; null when none is set up." },
        runner_floor: { type: ["integer", "null"], description: "The oldest schema version a runner's build must know to run on this store: the newest migration that breaks earlier runners (on SQLite, the version itself). A runner whose build knows less claims nothing more, hands its runs back and exits 3." },
        known: { type: "integer", description: "The schema version this server's build knows. A build that knows less than `version` cannot be deployed on this store: its server refuses it." },
      },
      description: "The store's schema and runner floor beside this server's own, for a deploy's check that refuses a build older than the store. `agentrun-serve store-schema --build` prints a build's `known` without a store.",
      "x-agentrun-serve": "runnerfloor/1",
    },
    learning: {
      type: "object", additionalProperties: false, required: ["pending", "approve"],
      properties: {
        pending: { type: "boolean", const: true, description: "A learned workflow draft that calls a tool with no price is kept to wait for its owner's OK: committed with `status: pending` in its README.md, and given to no run. Its owner approves it (POST /agents/{agent_id}/learning/files/{file}/approve) or retires it." },
        approve: { type: "boolean", description: "Whether this caller can approve a workflow draft that waits for its owner's OK: true only for the owner's password session in the console. A token (the server's own included), a run, and every caller on a server with accounts off (AGENTRUN_ACCOUNTS=0) read false." },
        approve_needs: { type: "string", enum: ["password"], description: "Present when `approve` is false: what approving needs, the owner's password sign-in (set one in Settings, or sign in with it)." },
      },
      description: "Who approves what a run's learning holds for its owner's OK.",
      "x-agentrun-serve": "learning/1",
    },
    places: {
      type: "object", additionalProperties: false, required: ["modes", "boxes", "allow"],
      properties: {
        modes: { type: "array", items: { enum: [...PLACE_MODES] } },
        boxes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "available", "state"], properties: { id: { enum: [...BOX_IDS] }, available: { type: "boolean" }, state: { enum: [...BOX_STATES], description: "`ready`, or `unavailable` with the `reason`." }, reason: { type: "string", description: "Why the box is unavailable. Docker is set up by default (AGENTRUN_BOXES not set), so docker's reason says first, in plain words, what is wrong on this machine, then what to do (`Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun`); every other box AGENTRUN_BOXES does not list says the setting that lists it." }, network: { enum: [...BOX_NETWORKS], description: "What an available box reaches: `allowlist`, the hosts in `allow`, and nothing else (a Docker computer through its egress proxy; a program that skips the proxy has no route), or `none`. A Daytona or Modal box reaches them through the egress proxy its computer's init starts. A Docker box's `none` comes with `network_reason` too.", "x-agentrun-serve": "place/2" }, network_reason: { type: "string", description: "Why an available box has no network for a cause of its own: AGENTRUN_BOX_ALLOW is none (Docker).", "x-agentrun-serve": "place/2" }, host_addresses: { type: "array", items: { type: "string" }, description: "Docker's alone, for a server in a container of its Docker's (compose.yaml) under an allow-list: the Docker host's own IP addresses its computers' egress proxy refuses as the host's, the union of what the server read through Docker's socket at its start (the host's interfaces, and host.docker.internal's on Docker Desktop or OrbStack) and AGENTRUN_DOCKER_HOST_ADDRESSES. Absent on a host, where the proxy reads the host's own." } } } },
      },
      description: "The places a revision may name, this host's default, each box (whether this server has it, its state: ready or unavailable, and when not, why) and the hosts a box may reach.",
      "x-agentrun-serve": "place/1",
    },
    harnesses: {
      type: "array",
      description: "Each harness a revision may name, and whether this server runs it; when not, why. A harness whose one run needs more memory than this server has for runs is unavailable, its reason naming the numbers, and its runs are 409 agent_not_runnable.",
      items: { type: "object", additionalProperties: false, required: ["id", "label", "promises", "available", "steer", "default_model", "models", "free_models", "run_memory_mib", "max_concurrent_runs"], properties: { id: { type: "string", pattern: HARNESS_ID_PATTERN, examples: [...HARNESSES], description: "The harness's id: a built-in one (pi, claude-agent, codex, opencode), or one an owner's harness module adds (`agentrun-serve --harness-module`), listed after them." }, label: { type: "string", description: "Its name in a sentence (`Pi`, `Claude`, `Codex`, `OpenCode`).", "x-agentrun-serve": "harness-table/1" }, promises: HARNESS_PROMISES, available: { type: "boolean", description: "Whether a run of it starts here now, on some model in `models`. False where it does not run here, and where none of its models runs for want of a model key (`needs` says what would give it one: pi with no key and no ChatGPT sign-in). True where its default model lacks a key while another of its models runs: a definition that names that model runs." }, free_models: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "context_window"], properties: { id: { type: "string", description: "The model, as it is in `models`." }, context_window: { type: "integer", minimum: 1, description: "Its context window, in tokens." } } }, description: "The models in `models` that run at $0: those whose catalog price is all zeros (input, output and cache), with each one's context window. Today OpenRouter's free models on pi, on OpenRouter's key (`openrouter/inclusionai/ling-3.2-flash:free`, `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`). Never a router that picks a model per request (`openrouter/auto`, `openrouter/free`): its price is the routed model's. A free model's provider may still limit its requests per minute and per day. Empty for a harness with none." }, models:{ type: "array", items: { type: "string" }, description: "The current models a person may pick for this harness, each in the exact form a definition's `model` takes on it here (`anthropic/claude-sonnet-5-5` on a provider's own key; `openrouter/anthropic/claude-sonnet-5.5` when OpenRouter's is the only key; behind a gateway, the host's own model ids that are `provider/model-id`, for the harnesses that go through it; the save takes no other form). Only those this harness runs here: a model its catalog does not know is not listed. Empty when the harness does not run here. Any other model a definition names is still saved if the harness runs it." }, run_memory_mib: { type: "integer", minimum: 1, description: "The memory a run of this harness reserves while its process lives, in MiB, measured. A start is admitted while the runs going and it fit in this server's memory less its own; over that, 429 rate_limited with retry-after, as over `limits.max_concurrent_runs`." }, max_concurrent_runs: { type: "integer", minimum: 0, description: "The most runs of this harness alone at once here: by memory and by the cap on the count, whichever is fewer. 0 when one never fits. `limits.max_concurrent_runs` is pi's, the smallest run." }, default_model: { type: ["string", "null"], description: "The model this server runs for the harness when a definition names none (provider/model-id), or null when it runs none: the harness does not run here, or no default model here runs on it." }, steer: { type: "boolean", description: "Whether a message sent while the run works lands mid-turn (`steer`); when false, it waits for the turn's end and the answer's mode is `follow_up`." }, reason: { type: "string", description: "Why it does not run here, in words a person acts on; on one that runs here but has no default model for want of a key (pi with no key), why it has none. Where the ChatGPT sign-in would run it (`needs` lists `chatgpt`), it says so: \"or sign in with ChatGPT (Settings → Model keys) to run it on your ChatGPT plan\", or, signed in no longer, \"your ChatGPT sign-in expired: sign in again (Settings → Model keys)\"." }, needs: { type: "array", items: { enum: ["key", "chatgpt"] }, minItems: 1, uniqueItems: true, description: "Present on a harness with no default model here for want of a model key (`default_model` null): what would give it one, any one of them; with `available` false, none of its models runs until then. `key`: a model key (Settings → Model keys). `chatgpt`: the ChatGPT sign-in (codex and pi, on a server that signs in with ChatGPT, not signed in or signed in no longer, and whose AGENT_MODEL names no key's model the harness runs: that model stays its default signed in or not). Absent where it runs, and where no key would make it run.", "x-agentrun-serve": "harness-needs/1" }, installs: { const: "on_first_use", description: "claude-agent and codex only, while that harness's CLI is not installed in this server's data: it installs on first use. The first run on it, or the first agent saved on it, installs the version AgentRun pins (claude-agent: the Claude Agent SDK; codex: Codex) from npm into `<data>/harnesses/<harness>`, by the lock AgentRun ships, once (every run that needs it waits for that one install); a run shows a `phase` row, `Installing Claude Code (first use)…` or `Installing Codex (first use)…`, while it does. When npm fails the run fails, and its error names the command that installs it by hand. Absent once it is installed.", "x-agentrun-serve": "firstuse/1" }, card: { type: "string", description: "What its owner reads before running it, on a harness its vendor bills to the owner's own plan (`promises.billing` `plan`: Cursor): whose key and terms it runs on, that this server caps none of its spend, the turn and tool-call limits that stop a run, and what it may not do (Cursor makes no file edits). Absent on a harness that runs on this server's keys and cap.", "x-agentrun-serve": "harness-card/1" } } },
      // harness/2: each entry took on its memory and count (run_memory_mib, max_concurrent_runs). A client that validates
      // against harness/1 refuses them, so it is a mark of its own. harness/3: each entry also lists its `models`
      // (required), which a harness/2 shape disallows. harness/4: an entry may say what it `needs`. harness/5: each entry
      // also lists its `free_models` (required).
      "x-agentrun-serve": "harness/5",
    },
    tools: {
      type: "array",
      description: "Every tool a revision may name (this server's closed table): whether a workflow's model nodes may use it (`nodes`), whether its code may call it (`calls`), and whether it runs here, else the variables it is missing; and its permission (the server's, its default and those offered).",
      items: {
        type: "object", additionalProperties: false, required: ["name", "summary", "nodes", "calls", "available", "harnesses", "permission", "default_permission", "permissions"],
        properties: {
          name: { type: "string" }, summary: { type: "string" }, blurb: { type: "string", description: "One short line for people (the editor's Tools grid); the model never sees it. Absent for an MCP server's tool.", "x-agentrun-serve": "tool-blurb/1" }, nodes: { type: "boolean" }, calls: { type: "boolean" }, call_only: { type: "boolean", description: "Only a workflow's call node runs it (pdf_pages, llm): no agentic revision or model node names it." }, meta: { type: "boolean", description: "A host tool over the run's own tools (tools_search, tools_call, codemode): no revision, model node or call node names it, so it is no grant; Settings → Tools sets it (allow or deny: a deny is not offered)." }, sandbox_only: { type: "boolean", description: "Only an agent whose place is a sandbox names it (bash, and the background tools bash_background, bash_output, bash_input, bash_signal and bash_list): it runs in the box, and a runner has no shell, except in Mode 2, where bash alone runs on Archil's serverless exec." }, available: { type: "boolean" }, reason: { type: "string", description: "Why the tool is unavailable here, present whenever `available` is false: a provider pick's own words (`web_search is turned off in settings`, `parallel picked, no PARALLEL_API_KEY`), or `Needs` and the variables it is missing; for a sandbox-only tool (bash, the background tools) that no box this server has can run, `no box is set up on this server: …` with each box's own reason (`places.boxes`); in Mode 2 bash is available with no box." }, missing: { type: "array", items: { type: "string" } },
          harnesses: { type: "array", items: { type: "string", pattern: HARNESS_ID_PATTERN, examples: [...HARNESSES] }, description: "The harnesses that run the tool here, ids of capabilities' `harnesses`: a host tool, every one; another tool, pi and any harness an owner's harness module adds without adapter facts (it runs pi's tools). A revision naming it on another harness saves with a warning and its runs are 409 agent_not_runnable.", "x-agentrun-serve": "tool-harness/1" },
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
        host_owned: { type: "array", items: { type: "string" }, description: "The paths in a home only the server writes, never served here: each that is there is one entry of the list (`host_owned: true`), and a GET, PUT or DELETE at or under one, matched by its name folded (compatibility form, any case, no combining marks), is 403 `system_file_forbidden`." },
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
    run_isolation: {
      enum: ["uid", "process"],
      description: "How this host keeps one run from another: each run is a process of its own under the runner, and with `uid` each runs as a user of its own (the image's helper, a uid from 1001 per slot), so a run's tools read no other run's folder or memory, nor the data directory's store. `process`: every run as the runner's own user, where the host has no helper (a local install) or `AGENTRUN_RUN_USER=same` says so.",
      "x-agentrun-serve": "serve/1",
    },
    runner_refused: {
      type: ["string", "null"],
      description: "Why no runner here can take a run, in the runners' own words and their fix (`AGENTRUN_RUN_USER=same`, for one), while every runner here refused to claim any run (its run isolation refused); null while one can, or while none is there yet (a server with `--no-runner` whose runner has not started). While it is set a run's start is 503 `runner_refused` and a run still queued fails with that code.",
      "x-agentrun-serve": "runners/1",
    },
    switches: {
      type: "object",
      additionalProperties: {
        type: "object", additionalProperties: false, required: ["on", "value", "allows"],
        properties: {
          on: { type: "boolean", description: "Whether the operator set it: a yes-or-no switch to 1, any other to a value." },
          value: { type: ["string", "null"], description: "What the server read: `1` for a yes-or-no switch that is on, a comma list of hosts or `none` (AGENTRUN_BOX_ALLOW, lower-cased, each host once), or a size (AGENTRUN_BOX_CPUS, _MEMORY, _PIDS); null when unset. Never a secret: no switch holds one." },
          allows: { type: "string", description: "What it allows, in an operator's words, with where it is safe to set." },
        },
      },
      description: "The switches only the server's operator sets, as environment variables at its start, by name: AGENTRUN_MCP_ALLOW_LOOPBACK (an MCP server on this machine's loopback), AGENTRUN_WEBHOOK_PRIVATE_TARGETS (the outbound webhook to a private network or this machine), AGENTRUN_PRIVATE_HOSTS (the private-network hosts an owner may allow an MCP server or a calendar on: unset the owner's list, none, or address ranges), AGENTRUN_BOX_ALLOW (the hosts a run's computer may reach) and AGENTRUN_BOX_CPUS, AGENTRUN_BOX_MEMORY and AGENTRUN_BOX_PIDS (a Docker computer's size). No route and no console page sets them, so no caller of the API can widen what the server reaches; each takes a restart. A refusal one of them causes names it, the value that allows it and the restart (`restart the server with AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1 to allow it, only on a machine you alone use`), its error code unchanged.",
      "x-agentrun-serve": "switches/1",
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
      description: "The place a NEW agentic agent that names none and has a shell is saved with, written on its revision at its create: the Docker box (`{\"mode\": \"sandbox\", \"box\": \"docker\"}`) where this server has docker, with tools [\"bash\", \"bash_background\", \"bash_output\", \"bash_input\", \"bash_signal\", \"bash_list\"] when the definition names no tools; else the runner, with `default_reason`. One whose named tools need no shell is saved with no place and runs on the runner. It is also where an agentic revision saved with no place and a shell tool runs, resolved at each run: a workflow, a revision whose tools need no shell, and a revision that names a tool a box refuses, run on the runner. (It replaces `places.default`, which said `runner`.)",
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
    ready: { type: "boolean", description: "Whether a revision that names no model runs here: the host names a default (`AGENT_MODEL`), or a model provider's key is here, saved (`PUT /settings/tool-keys/{key_id}`, a `model` key) or the server's own, and gives its default model, the first of anthropic, openai, particle, openrouter that has one (Particle runs on Pi).", "x-agentrun-serve": "toolkeys/1" },
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
    browser_live: {
      type: "object", additionalProperties: false, required: ["read_only", "take_over", "ask"],
      properties: {
        read_only: { type: "boolean", description: "The viewer watches and never drives. False here: it drives after Take over." },
        take_over: { type: "boolean", description: "The viewer's Take over holds the browser for the owner until they hand it back, the viewer is gone 2 minutes, or 15 minutes pass with no input; outside a hold its input is dropped by the run. The agent's browser calls wait meanwhile and are then told the person had the browser; the run stays working. The owner's time is held under the run's cap first (15 minutes at the provider's price), and again every 15 minutes while input keeps the take-over alive: with no room, Take over is refused, or the browser goes back to the agent, in the cap's words." },
        ask: { type: "boolean", description: "The agent may ask for the owner in its browser: the run waits (pending.kind browser) until POST /runs/{run_id}/browser/hand-back answers or 15 minutes pass." },
      },
      description: "The owner watches a run's browser live from the console (GET /runs/{run_id}/browser), takes it over and hands it back.",
      "x-agentrun-serve": "liveview/2",
    },
    computers: {
      type: "object", additionalProperties: false, required: ["kinds"],
      properties: { kinds: { type: "array", items: COMPUTER_KIND, description: "The kinds of computer this server offers now (GET /computers says why another is not)." } },
      description: "Settings → Computers: the computer kinds an agent's `computer` may name here.",
      ...COMPUTER_MARK,
    },
    claude_login: {
      type: "boolean",
      description: "Whether /settings/claude-login answers here. False when AGENTRUN_CLAUDE_CODE_LOGIN=off, when the server listens past loopback (Docker) without AGENTRUN_CLAUDE_CODE_LOGIN=on, or on an API-only server (AGENTRUN_API_ONLY=1): those routes are then 404, so a client asks this first.",
      "x-agentrun-serve": "claudelogin/1",
    },
    tool_keys: {
      type: "object", additionalProperties: false, required: ["routes", "at_rest"],
      properties: { routes: { type: "boolean" }, at_rest: { const: "sealed" } },
      description: "GET, PUT and DELETE /settings/tool-keys: a tool's key saved by name, kept `sealed` under the server's seal key, which it always has (handed, or made at its first start).",
      "x-agentrun-serve": "toolkeys/1",
    },
    harness_keys: {
      type: "object", additionalProperties: false, required: ["routes", "at_rest", "harnesses"],
      properties: { routes: { type: "boolean" }, at_rest: { const: "sealed" }, harnesses: { type: "array", items: { type: "string", pattern: HARNESS_ID_PATTERN }, description: "The plan-billed harness recipes this server is started with (--harness-recipe), whose keys GET /settings/harness-keys lists. Empty when it names none." } },
      description: "GET /settings/harness-keys and PUT/DELETE /settings/harness-keys/{harness_id}/{key}: the keys a plan-billed harness recipe runs on, each kept `sealed` for that harness alone, opened at the claim of a run on it and never handed to another harness or to any run's tools.",
      "x-agentrun-serve": "harnesskeys/1",
    },
    mcp_client: {
      type: "object", additionalProperties: false, required: ["transports", "auth", "at_rest", "harnesses"],
      properties: { transports: { type: "array", items: { const: "streamable-http" } }, auth: { type: "array", items: { enum: [...MCP_AUTH_TYPES] } }, at_rest: { const: "sealed" }, harnesses: { type: "array", items: { type: "string" }, description: "The harnesses whose agents call a saved server's tools, each granted as mcp:<server>/<tool> in definition.tools."} },
      description: "/settings/mcp-servers: remote MCP servers over Streamable HTTP, previewed and saved with the auth types listed; a credential kept `sealed` under the server's seal key, which always exists.",
      "x-agentrun-serve": "mcpservers/1",
    },
    tool_permissions: { type: "boolean", description: "Whether a tool setting may carry a permission (allow, ask, deny), which the tool gate holds every tool call to.", "x-agentrun-serve": "providers/1" },
    webhooks: {
      type: "object", additionalProperties: false, required: ["routes", "events", "signing", "at_rest"],
      properties: { routes: { type: "boolean" }, events: { type: "array", items: { enum: [...WEBHOOK_EVENTS] } }, signing: { const: "standard-webhooks/v1" }, at_rest: { const: "sealed" } },
      description: "/settings/webhook: one URL each of `events` is POSTed to, signed by the Standard Webhooks spec; its secret kept `sealed` under the seal key the server was handed, `unavailable` with none, when no webhook is set.",
      "x-agentrun-serve": "webhook/1",
    },
    slack: {
      type: "object", additionalProperties: false, required: ["routes", "events", "at_rest"],
      properties: { routes: { type: "boolean" }, events: { type: "array", items: { enum: [...SLACK_EVENTS] } }, at_rest: { const: "sealed" } },
      description: "/settings/slack: one Slack incoming-webhook URL each of `events` is posted to as a readable message; the URL kept `sealed` under the seal key, never shown.",
      "x-agentrun-serve": "slack/1",
    },
    triggers: {
      ...closedWith({ routes: { type: "boolean" }, sources: { type: "array", items: { enum: [...SOURCE_KINDS] } }, targets: { type: "array", items: { enum: [...TARGET_KINDS] } }, min_every_s: { type: "integer" }, history_kept: { type: "integer" }, catchup_window_s: { type: "integer" }, failures_to_pause: { type: "integer" }, webhook: closed({ signing: { const: "standard-webhooks/v1" }, signatures: { type: "array", items: { enum: [...SCHEME_NAMES] }, description: "The signature schemes a webhook trigger's `signature` may name." }, tolerance_s: { type: "integer" }, max_body_bytes: { type: "integer" }, payload_kept_bytes: { type: "integer" }, at_rest: { const: "sealed" } }) }, { public_url: { type: "boolean", description: "Whether this server has a public address (AGENTRUN_PUBLIC_URL) a sender such as Composio can reach: without one, a Composio trigger is refused 409 composio_no_public_url. The address itself is never answered here. On GET /capabilities." } }),
      description: "/triggers: schedules and signed webhooks that start an agent's capped runs or message a run: the source and target kinds this server takes, the shortest interval, how many firings each trigger keeps, the default catch-up window, and how many failed firings in a row turn a trigger off.",
      ...TRIGGER_MARK,
    },
    sdk_runs: {
      type: "object", additionalProperties: false, required: ["started_at", "title", "labels", "max_open_s"],
      properties: {
        started_at: { type: "boolean", description: "An SDK run's start (POST /agents/{agent_id}/sdk-runs) takes `started_at`, the run's created_at." },
        title: { type: "boolean", description: "An SDK run's start takes `title`." },
        labels: { type: "boolean", description: "An SDK run's start takes `labels`, as RunCreate.labels." },
        max_open_s: { type: "integer", description: "The longest an SDK run takes evidence and its completion, in seconds after its start: each events batch keeps it open an hour more, up to this. Not how long one nobody sends to stays open: a run that gets no events batch closes an hour after its start, and fails as not completed before its deadline." },
      },
      description: "Backend SDK runs: what their start takes, and how long one may stay open.",
      "x-agentrun-serve": "sdk/1",
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
    harness: { type: "string", pattern: HARNESS_ID_PATTERN, examples: [...HARNESSES], description: "The revision's harness, when this server does not run it (capabilities.harnesses)." },
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
  createInlineRun: {
    agentic: {
      summary: "A run, capped at $1, of version 3 of an agent another system owns, given inline",
      value: {
        external: { source: "grep", kind: "expert", id: "due-diligence", version: 3 },
        definition: { name: "Due diligence", instructions: "Research the company you are given on the web and write a short brief: what it does, who runs it, red flags, and the sources you read.", tools: ["web_search", "web_fetch"] },
        input: { content: "Research https://stripe.com and write the brief." },
        max_cost_usd: 1,
      },
    },
  },
  createTrigger: {
    schedule: {
      summary: "A capped run of an agent every Monday at 09:00 UTC",
      value: { name: "Weekly brief", source: { kind: "schedule", cron: "0 9 * * 1" }, target: { kind: "start_run", agent_id: "due-diligence", input: { content: "Research https://stripe.com again and say what changed this week." }, max_cost_usd: 1 } },
    },
  },
};

/** `doc` with every source schema and firing `by` the registry gives made `adapters'`, and a hook path for each pushed
 *  source whose settings are the server's: a server given other sources (a test's) documents its own. */
function withAdapters(doc: Json, adapters: readonly TriggerAdapter[]): void {
  const [source, sent, by] = [JSON.stringify(TRIGGER_SOURCE), JSON.stringify(TRIGGER_SOURCE_SENT), JSON.stringify(firedByOf(TRIGGER_ADAPTERS))];
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const text = JSON.stringify(value);
    if (text === source) return sourceSchemaOf(adapters);
    if (text === sent) return sentOf(adapters);
    if (text === by) return firedByOf(adapters);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
  };
  doc.paths = walk(doc.paths);
}

/** POST /hooks/{source}, for each pushed source of `adapters` whose settings are the server's (push-handler.ts): its own
 *  check, its own body limit, and the firings its events made. */
function serverHooks(adapters: readonly TriggerAdapter[]): Record<string, Json> {
  const paths: Record<string, Json> = {};
  for (const adapter of adapters) {
    const push = adapter.push;
    if (!push || adapter.settings?.scope !== "server") continue;
    const handshake = push.handshake ? " A handshake its sender asks for (a URL check) is answered as the source answers it, after the check, never before." : "";
    // Its firings name the sources the server has, its own among them.
    const made = hookFiringsOf(adapters);
    // A source that keeps its key per scope is served under it alone (/hooks/composio/{hook}): its scope's key checks it.
    const scoped = push.scoped === true;
    paths[scoped ? `/hooks/${adapter.id}/{hook}` : `/hooks/${adapter.id}`] = {
      post: {
        operationId: `receiveHook_${adapter.id}`, tags: ["local"], summary: `Fire a ${adapter.label}: a request it checks, no token`,
        ...(scoped ? { parameters: [{ name: "hook", in: "path", required: true, description: "The id of the route this server made for it (the trigger's `source.hook`): its key is that route's, kept here when the route was made.", schema: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" } }] } : {}),
        description: `A pushed source's own route, with no token: the request is checked by the source's own check against its settings' \`${push.key}\` (${scoped ? "the one this server keeps for `hook`, never written by a person" : "the server's, PUT through its settings"}), on the raw body before anything else. The body is at most ${push.maxBodyBytes} bytes (413 at once past it, the socket closed) and arrives within ${HOOK_BODY_MS / 1000} s (408). Every refusal is the same 401. Each event the request holds fires the one trigger of this source that listens where it happened; an event no trigger takes, and a request with none, is answered 200 with no firing for it, and said in the server's log.${handshake}`,
        security: [],
        requestBody: { required: true, content: { "*/*": { schema: {} } } },
        // A handshake's answer is any object but a firings one or the ignored answer, so each answer is exactly one of the
        // 200's shapes, and a handshake of the source's own, {ok: true} say, is one.
        responses: { "202": json(made, "Recorded: each firing's run starts (or its message goes) after this answer."), "200": json(push.handshake ? { oneOf: [made, HOOK_IGNORED, { type: "object", not: { anyOf: [{ required: ["firings"] }, HOOK_IGNORED] }, description: "The source's handshake answer." }] } : { oneOf: [made, HOOK_IGNORED] }, "Nothing new: each event's firing as it stands (a key seen within its day whose firing is no longer kept, `{ok: \"duplicate\"}`), or none; or `{ok: \"ignored\"}`, a request the source's own filter does not take."), "408": HOOK_TIMEOUT, ...errors(401, 413, 429, 500, 503) },
        ...TRIGGER_MARK,
      },
    };
  }
  return paths;
}

export function openapiDocument(capabilityOf: (operationId: string) => string | undefined, adapters: readonly TriggerAdapter[] = TRIGGER_ADAPTERS): Json {
  const doc = structuredClone(contract()) as Json & { info: Json; paths: Record<string, Record<string, Json>> };
  const notServed: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!NOT_SERVED.includes(op.operationId as string)) continue;
      delete item[method];
      notServed.push(`${method.toUpperCase()} ${path}`);
    }
    // A path left with no operation goes with them; one with a parameters list alone is no operation either.
    if (!Object.keys(item).some((key) => key !== "parameters" && !key.startsWith("x-"))) delete doc.paths[path];
  }
  const unsupported: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const capability = typeof op.operationId === "string" ? capabilityOf(op.operationId) : undefined;
      if (capability === undefined) continue;
      op["x-agentrun-serve-unsupported"] = { capability, reason: UNSUPPORTED[capability] ?? "This server does not offer it." };
      unsupported.push(`${method.toUpperCase()} ${path}`);
    }
  }
  // The console's password session, the one credential approving a workflow draft takes (approveLearningFile).
  ((doc.components as Json).securitySchemes as Record<string, Json>).ownerSession = {
    type: "apiKey", in: "cookie", name: "agentrun-<port>",
    description: "The owner's console session: the cookie `agentrun-<port>`, this server's port (the document as served names it), that the console sets when the owner signs in with their password (accounts on). Sent from this server's own origin; a token never stands for it.",
    "x-agentrun-serve": "learning/2",
  };
  const schemas = (doc.components as Json).schemas as Record<string, Json>;
  // The one shape every secret's view answers (secret-writes.ts secretMeta): a component each plane's view refers to.
  schemas.SecretMeta = structuredClone(SECRET_META_SCHEMA) as unknown as Json;
  // composioperrun/1: mcp_auth's second choice, a component so the first (the per_run headers) keeps the name each client
  // generated for it before (RunCreateMcpAuthValue and the rest).
  schemas.ComposioRunBinding = structuredClone(COMPOSIO_RUN_BINDING);
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
  // email/1: the email read tools' scope, inside an agent's own tool settings (AGENT_TOOL_SETTINGS).
  fields.push(...SCOPED_TOOLS.map((name) => `DefinitionInput.tool_settings.${name}.scope`));
  // inlineagent/1: POST /runs' body, the run fields of POST /agents/{agent_id}/runs (RunCreate, as extended above) but a
  // pinned revision and a trigger firing (an inline agent has no trigger), with the agent given inline as POST /agents takes
  // one and its reference in the system that owns it.
  const runCreate = schemas.RunCreate as Json & { properties: Record<string, Json> };
  const agentCreate = schemas.AgentCreate as Json & { properties: Record<string, Json> };
  const { revision: _pinned, trigger_firing: _firing, ...runFields } = runCreate.properties;
  schemas.ExternalRef = { ...EXTERNAL_REF, "x-agentrun-serve": "inlineagent/1" };
  schemas.RunCreateInline = {
    type: "object", additionalProperties: false, required: ["external", "definition", "input"],
    description: "A run of an agent another system owns, given inline (POST /runs): POST /agents/{agent_id}/runs' run fields, with the agent as POST /agents takes it and its reference in its source.",
    properties: {
      external: ref("schemas/ExternalRef"),
      definition: { ...agentCreate.properties.definition, description: "The agent's definition as POST /agents takes one, checked as it checks one (its 422s name `definition.<field>`), but its `id` (this server's, one per external reference) and its `version` (`external.version`), which it does not take." },
      ...(agentCreate.properties.skills ? { skills: agentCreate.properties.skills } : {}),
      ...(agentCreate.properties.note ? { note: { ...agentCreate.properties.note, description: "What the version changes, kept with its revision by the version's first run (GET /agents/{agent_id}/revisions); not part of its definition." } } : {}),
      ...runFields,
    },
    "x-agentrun-serve": "inlineagent/1",
  };
  // This server's own run fields it always sends, on a run and in a list (runs.ts view and summary): required with the
  // contract's, so a client may read them as there.
  for (const name of ["Run", "RunSummary"]) {
    const schema = schemas[name] as Json & { required: string[] };
    schema.required = [...schema.required, ...RUN_FIELDS_SENT];
  }
  // A run's place, which its view always sends (store-view.ts viewOverStore: the launch's, else the runner).
  const runSchema = schemas.Run as Json & { required: string[] };
  runSchema.required = [...runSchema.required, "place"];
  // An agent's own fields this server always sends (agents-store.ts agentView), on a read, a list and a write's answer.
  const agentSchema = schemas.Agent as Json & { required: string[] };
  agentSchema.required = [...agentSchema.required, ...AGENT_FIELDS_SENT];
  // The capabilities this server always sends (server.ts capabilitiesWith: models, places, tools, learning, switches and harnesses; place.ts placesOf:
  // places.default_place), required with the contract's, so a client may read them as there.
  const capabilities = schemas.Capabilities as Json & { required: string[]; properties: Record<string, Json & { required: string[] }> };
  capabilities.required = [...capabilities.required, ...CAPABILITIES_SENT];
  capabilities.properties.places!.required = [...capabilities.properties.places!.required, "default_place"];
  // The contract's definition fields this server refuses (validate.ts), each marked with the reason its 422 gives.
  const definition = schemas.DefinitionInput as Json & { properties: Record<string, Json>; required: string[] };
  const refused: string[] = [];
  for (const field of Object.keys(definition.properties)) {
    if (DEFINITION_FIELDS.includes(field)) continue;
    definition.properties[field] = { ...definition.properties[field], "x-agentrun-serve-unsupported": { reason: `The definition keeps no field ${field}.` } };
    refused.push(`DefinitionInput.${field}`);
  }
  // A contract field this server takes with a meaning of its own, said on it.
  definition.properties.max_cost_usd = { ...definition.properties.max_cost_usd, "x-agentrun-serve-note": "The agent's default cap of each run started without a max_cost_usd of its own (a run's own wins), kept with its revision: above 0 sets it, 0 clears it (no default), and an edit that leaves the field out keeps the agent's, so leaving a field out never removes a spend limit. An agentic definition's or a workflow's alike." };
  definition.properties.output_schema = { ...definition.properties.output_schema, "x-agentrun-serve-note": "An agentic definition's alone (a workflow's output is its workflow's): the JSON Schema its final answer's last fenced json block meets, at most 64 KiB, refused at save when it does not compile. A completed run's result.output is that block's value when it meets the schema, else null. An edit that leaves the field out keeps the agent's. A template's answer schema (its manifest's `output`) is set here at apply. Over 32 KiB, a scheduled run is handed only the fields the producing run's schema names in `x-carried`; carried arrays lose entries from the front until they fit, and the run is told how many. A save refuses an `x-carried` that is not unique root property names." };
  definition.properties.input_schema = { ...definition.properties.input_schema, "x-agentrun-serve-note": "An agentic definition's alone (a workflow's input is its workflow's own schema): a JSON Schema object schema (`type: object`), at most 64 KiB, refused at save when it does not compile. Every run's `input` is checked against it with the full compiler, by POST /agents/{agent_id}/runs, a trigger's start_run target (at save and when it fires) and a template's triggers, and refused 422 `input_invalid` with an issue at each path (`input.company`, `input.topics.1`). `content` is reserved: named, it is `{type: string}`; it is always taken as text (the run's message). It is required when the schema has no field of its own; when the schema's own fields are all optional, a run gives `content` or one of them, and an input with none is refused at `input.content`. The run's first message is `content`, then the other fields as one fenced json block under the line `Input:`. Absent: `{content: string}`. An edit that leaves the field out keeps the agent's. A template's `inputs` are set here at apply." };
  const runResult = schemas.RunResult as Json & { properties: Record<string, Json> };
  runResult.properties.output = { ...runResult.properties.output, "x-agentrun-serve-note": "A workflow run's output, as its workflow ended; an agentic run's, its final answer's last fenced json block when it meets the agent's output_schema, else null (no schema, no block, not JSON, or a value the schema refuses). The runner gives the model the schema in its instructions on every harness, and asks once more, in the same session under the same cap, when the answer misses it; output_error says why one still missed." };
  // instructions XOR workflow (validate.ts): a workflow revision has none. version, skills and tools: this server
  // mints or keeps them when a write leaves them out (agents-store.ts definitionOf), so none of the four is required of a
  // write; only instructions ever misses from an answer (a workflow revision's), so Definition keeps the rest required.
  definition.properties.instructions = { ...definition.properties.instructions, "x-agentrun-serve-note": "An agentic revision's own: this or `workflow`, not both. Neither is 422 `definition.instructions` `missing`; both is 422 `definition.workflow` `not_allowed`. Absent on a workflow revision's own answer." };
  definition.properties.workflow = { ...definition.properties.workflow, "x-agentrun-serve-note": "A workflow revision's own, in place of `instructions`: see `instructions` for the 422s either's absence or both's presence gives." };
  definition.properties.version = { ...definition.properties.version, "x-agentrun-serve-note": "Absent on a create: this server mints 1. This contract's own `PUT .../definition` body (not this server's own `{definition, skills?, note?}` form) requires it, greater than the current revision's; left out there, or not greater, is 422 `definition.version`. Always sent on an answer." };
  definition.properties.skills = { ...definition.properties.skills, "x-agentrun-serve-note": "Absent: none. Always sent on an answer (`[]` when the revision names none)." };
  // The name is the agent's identity beside its id; the description is a label (agents-store.ts commitAgent).
  definition.properties.name = { ...definition.properties.name, "x-agentrun-serve-note": "The agent's, from its creation: an edit (`PUT .../definition`) that names another is 422 `definition.name` `not_allowed`." };
  definition.properties.description = { ...definition.properties.description, "x-agentrun-serve-note": "The agent's, not its revision's: an edit (`PUT .../definition`) that names another writes it with the new revision in one commit (a new revision even when nothing else changed), so an edit refused or stale (412) changes neither; one that leaves it out keeps it. Every read of the agent, its list and its revisions answers the current one." };
  definition.properties.tools = { ...definition.properties.tools, "x-agentrun-serve-note": "Absent: none. Always sent on an answer (`[]` when the revision grants none)." };
  definition.required = definition.required.filter((field) => !DEFINITION_INPUT_OPTIONAL.includes(field));
  const definitionRead = schemas.Definition as Json & { required: string[] };
  definitionRead.required = definitionRead.required.filter((field) => !DEFINITION_OPTIONAL.includes(field));
  // A row's usage: the contract's shape, on more rows here than the usage row (timeline/, BROWSER_CHARGE).
  const timelineRow = schemas.TimelineRow as Json & { properties: Record<string, Json> };
  timelineRow.properties.usage = { ...timelineRow.properties.usage, "x-agentrun-serve-note": "On the `usage` row, the run's cost so far. On a paid tool's charge row (a `phase` row, \"Tool cost: monid charged $0.0260 for monid:apollo/people/match\", `tool_name` the tool, `tool_use_id` the call), that charge alone. On a browser call's `tool_use` row (`tool_name` one of the browser's tools: snapshot, run, browser_read, ...), the browser session time booked under that call: what the session ran since its last charge, and, on the session's last call, its release's charge topped up to the provider's minimum. A browser charge has no row of its own. A charge booked after the row was served (a release after the answer) is served as a change of that row, with the same `id` and its new `usage`. `requests` is 0 on every row but the usage row; `usd` is null once a charge on the row has no price, with `so_far_usd` and `unpriced` saying what is known; on the usage row, `free` says a $0 is because every model request went to a free model (\"Cost: $0 · free model over 3 model requests\"). The run's cost counts each charge once, wherever it shows: summing every row's `usage` but the usage row's gives what its paid tools charged." };
  // ErrorBody.fields beyond `input_invalid`: a 409 agent_not_runnable names each thing that keeps the run from starting.
  const errorBody = schemas.ErrorBody as Json & { properties: Record<string, Json> };
  errorBody.properties.fields = { ...errorBody.properties.fields, "x-agentrun-serve-note": "Also on `agent_not_runnable` (409) here: each thing that keeps the run from starting, by the field it is about, its reason, its message and the fix when there is one (such as AGENT_MODEL_PRICE for a capped run on a model with no price), as a 422 names each field." };
  const noted = ["DefinitionInput.max_cost_usd", "DefinitionInput.input_schema", "DefinitionInput.output_schema", "RunResult.output", "DefinitionInput.instructions", "DefinitionInput.workflow", "DefinitionInput.version", "DefinitionInput.skills", "DefinitionInput.tools", "DefinitionInput.name", "DefinitionInput.description", "TimelineRow.usage", "ErrorBody.fields"];
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
  timeline.parameters = [
    ...(timeline.parameters as Json[]),
    { name: "limit", in: "query", required: false, description: "At most this many rows in a page (1 to 500, default 500); has_more says when another waits.", schema: { type: "integer", minimum: 1, maximum: 500, default: 500 } },
    { name: "calls", in: "query", required: false, description: `\`whole\`: each \`tool_use\` row carries its call's arguments (\`tool_input\`) and each \`tool_result\` row the head of its output to ${CALL_RESULT_CHARS} characters (\`tool_result_text\`; a web call's every url, only its long texts cut), both through the run's redaction, for a reader that grades the run (a template eval). Its rows are another page sequence: a cursor (\`after\`, \`Last-Event-ID\`) from one read goes with the same \`calls\`.`, schema: { enum: ["whole"] } },
  ];
  timeline["x-agentrun-serve-changed"] = { limit: "timelinelimit/1", calls: "callswhole/1" };
  changed.push("GET /runs/{run_id}/timeline");
  // GET /agents also takes `archived`, as GET /runs already does (server.ts archivedParam, shared by both routes):
  // true lists only archived agents, false (the default) the others.
  const listAgents = (doc.paths["/agents"] as Json).get as Json & { parameters: Json[] };
  listAgents.parameters = [...listAgents.parameters, { name: "archived", in: "query", required: false, description: "true lists only archived agents; false, the default, the others.", schema: { type: "boolean" } }];
  listAgents["x-agentrun-serve-changed"] = { archived: "archivedparam/1" };
  changed.push("GET /agents");
  // GET /agents/{agent_id}/runs takes GET /runs' `label` filter too (server.ts runsPage, shared by both routes).
  const listAgentRuns = (doc.paths["/agents/{agent_id}/runs"] as Json).get as Json & { parameters: Json[] };
  listAgentRuns.parameters = [...listAgentRuns.parameters, LABEL_PARAMETER];
  listAgentRuns["x-agentrun-serve-changed"] = { ...(listAgentRuns["x-agentrun-serve-changed"] as Json | undefined), label: "runlabels/1" };
  changed.push("GET /agents/{agent_id}/runs");
  // GET /agents/{agent_id} always sends the agent's `tools` (server.ts getAgent; [] before it has a revision), which the
  // agent in a list, a create or a save does not: its 200 is the contract's Agent with `tools` required.
  const getAgent = (doc.paths["/agents/{agent_id}"] as Json).get as Json & { responses: Record<string, Json & { content: Record<string, Json> }> };
  const agentAnswer = getAgent.responses["200"]!.content["application/json"]!;
  agentAnswer.schema = { allOf: [agentAnswer.schema as Json, { type: "object", required: ["tools"], properties: { tools: AGENT_TOOLS } }] };
  getAgent["x-agentrun-serve-changed"] = { responses: "agenttools/1" };
  changed.push("GET /agents/{agent_id}");
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
  // A hidden run's files are refused, as its graph is: 403 forbidden while the server can't read its browser sign-in.
  for (const path of ["/runs/{run_id}/files", "/runs/{run_id}/files/{path}"]) {
    const files = (doc.paths[path] as Json).get as Json & { responses: Record<string, Json> };
    files.description = `${String(files.description ?? "").trimEnd()}\nHere \`403 forbidden\` while this server can't read the browser sign-in the run was handed (its seal key changed or is missing): a page it saved signed in holds what it saw there, so none of its files is listed or read until the sign-in opens again.\n`;
    const added = files.responses["403"] === undefined;
    if (added) files.responses["403"] = ref("responses/Forbidden");
    files["x-agentrun-serve-changed"] = { description: "signins/1", ...(added ? { responses: "signins/1" } : {}) };
    changed.push(`GET ${path}`);
  }
  // runvideo/1: a run's screen recordings are read under recordings/, as video/mp4, their byte ranges answered.
  const readFile = (doc.paths["/runs/{run_id}/files/{path}"] as Json).get as Json & { responses: Record<string, Json & { content: Record<string, Json> }> };
  readFile.description = `${String(readFile.description).trimEnd()}\nHere a path under \`recordings/\` is one of the run's screen recordings (the run read's \`recordings\`, made where its agent's computer says \`record: true\`), never a file the run made: \`video/mp4\`, inline unless \`?download=1\`, read-only, to whoever may read the run's other files. A folder the run made named \`recordings\` is neither listed nor served. A recording still being written is served as it stands: a fragmented MP4 plays up to its last whole fragment. \`Range\` is honoured for every file (\`features.files.range\`): one byte range, \`206\` with \`Content-Range\`, so a \`<video>\` can seek; one that starts past the end is \`416 range_not_satisfiable\`.\n`;
  for (const code of ["200", "206"]) readFile.responses[code]!.content = { "video/mp4": { schema: { type: "string", contentMediaType: "video/mp4" } }, ...readFile.responses[code]!.content };
  readFile["x-agentrun-serve-changed"] = { ...(readFile["x-agentrun-serve-changed"] as Json), responses: "runvideo/1" };
  // filecut/1: `?cut=run` reads a text file under the run's own cut, as its timeline's calls are cut, never raw. Its
  // text/plain answer is one of the 200's `*/*`, so a client reads it as it reads any file (bytes, or a stream).
  const readFileOp = (doc.paths["/runs/{run_id}/files/{path}"] as Json).get as Json & { parameters: Json[]; responses: Record<string, Json> };
  readFileOp.parameters = [
    ...readFileOp.parameters,
    query("cut", `\`run\`: the file's text cut of every value the run's own cut holds (the server's keys, the keys a person saved, its secret stores' values, the sign-in refs the run was handed), each one and each secret shape replaced by \`[redacted]\` in place, as the run's timeline cuts its calls; the text is \`[redacted]\` whole when a value still shows in a form not cut in place. Answered \`text/plain; charset=utf-8\` with \`x-agentrun-cut: run\` (a server that doesn't know \`cut\` answers the raw bytes, without it), the whole file (\`Range\` is not read). A file whose type is not text (text/*, JSON, NDJSON, or an extension the server doesn't type), or whose bytes are not UTF-8 or hold a NUL, is \`415 unsupported_media_type\`; one over ${RUN_FILE_CUT_MAX} bytes is \`413 payload_too_large\`; a run whose cut can't be read (the sign-in it was handed doesn't open) is \`403 forbidden\`. Without \`cut\`, the file's bytes as written.`, { type: "string", enum: ["run"] }),
  ];
  readFileOp.responses["413"] = ref("responses/PayloadTooLarge");
  readFileOp.responses["415"] = ref("responses/UnsupportedMediaType");
  readFile["x-agentrun-serve-changed"] = { ...(readFile["x-agentrun-serve-changed"] as Json), parameters: "filecut/1" };
  // An agentic run's cancel is its end at once: the 202 reads `cancelled`, and no later end of its turn moves it.
  const cancel = (doc.paths["/runs/{run_id}/cancel"] as Json).post as Json;
  cancel.description = `${String(cancel.description).trimEnd()}\nHere an agentic run reads \`cancelled\` from the 202 on, \`final\` once it has stopped: a run's first terminal status is its last, so nothing its cut turn writes later (an answer, a cost over its cap) moves it. A workflow run reads \`cancelled\` once its workflow has stopped.\n`;
  cancel["x-agentrun-serve-changed"] = { description: "turnend/1" };
  changed.push("POST /runs/{run_id}/cancel");
  // A stopped turn says so in the run's read: pending kind stopped, as its run.needs_input does.
  const stop = (doc.paths["/runs/{run_id}/stop"] as Json).post as Json;
  stop.description = `${String(stop.description).trimEnd()}\nHere its status becomes \`input_required\` with state \`idle\` and \`pending\` kind \`stopped\`, in the run's read, in the run list and in its \`run.needs_input\` webhook, until a message starts its next turn.\n`;
  stop["x-agentrun-serve-changed"] = { description: "stoppedpending/1" };
  changed.push("POST /runs/{run_id}/stop");
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
    modelsSource.description = "Where this server's models come from. `gateway`: every model through the OpenAI-compatible gateway at `AGENT_MODEL_BASE_URL`, its ids under `route_prefix`. `providers`: each model from its own provider, with that provider's key. `faux`: a scripted model, with no key and no network. `chatgpt`: no key, and a person's ChatGPT plan signed in here (GET /settings/chatgpt), which runs codex and pi on its models (`chatgpt/<model-id>`) and no other harness (each harness's `reason` says it needs a key). `managed` and `env` are the hosted API's.";
    modelsSource["x-agentrun-serve"] = "models/2";
    fields.push(...sourcesAdded.map((value) => `Capabilities.models.source.${value}`));
  }
  // browser/1: the browser tool runs on the computer registry's browser providers (Browserbase, Kernel), picked per
  // server and per agent (tool-plane.ts), so capabilities' `features.browser` names the one the server's settings resolve
  // to, which the contract's enum (browserbase, chrome, none) may lack.
  const browser = ((schemas.Features as Json).properties as Record<string, Json>).browser as Json & { enum?: string[] };
  const lacking = Array.isArray(browser.enum) ? BROWSER_VENDOR_IDS.filter((id) => !browser.enum!.includes(id)) : [];
  if (lacking.length > 0) {
    browser.enum = [...browser.enum!, ...lacking];
    browser["x-agentrun-serve"] = "browser/1";
    fields.push(...lacking.map((id) => `Features.browser.${id}`));
  }
  // signins/1: a saved sign-in whose pointer does not open under this server's seal key (sign-ins-store.ts) reads `unreadable`,
  // which the contract's SignIn.state (ready, held) lacks.
  const signInState = ((schemas.SignIn as Json).properties as Record<string, Json>).state as Json & { enum?: string[] };
  if (Array.isArray(signInState.enum) && !signInState.enum.includes("unreadable")) {
    signInState.enum = [...signInState.enum, "unreadable"];
    signInState.description = "`held` while a run holds its save lease, else `ready`. `unreadable` (this server's own): its pointer does not open under this server's seal key (sealed under another), so runs start signed out and none is made in its place until it is forgotten (DELETE /agents/{agent_id}/sign-ins/{key}); its `held_by` names a run that still holds its lease, else null.";
    signInState["x-agentrun-serve"] = "signins/1";
    fields.push("SignIn.state.unreadable");
    // An unreadable sign-in still names a run that holds its lease (held_by), as a held one does; a ready one never.
    const signIn = schemas.SignIn as Json & { else?: Json };
    if (signIn.else) {
      signIn.else = { if: { properties: { state: { const: "unreadable" } } }, then: { properties: { held_by: { oneOf: [ref("schemas/Id"), { type: "null" }] } } }, else: signIn.else, "x-agentrun-serve": "signins/1" };
      fields.push("SignIn.else");
    }
  }
  // secrets/1: each saved sign-in carries its one secret under `secret`, in the secret metadata shape every plane gives
  // (sign-ins-secrets.ts), always sent: named sign-in:<agent_id>:<provider>, set, from a sign-in, changed when its pointer
  // was saved. Never the pointer.
  const signInSchema = schemas.SignIn as Json & { properties: Record<string, Json>; required: string[] };
  if (signInSchema.properties.secret === undefined) {
    signInSchema.properties.secret = {
      $ref: "#/components/schemas/SecretMeta",
      description: "The sign-in's one secret, its vendor pointer, as metadata alone (SecretMeta): named `sign-in:<agent_id>:<provider>`, set, from a `sign-in`, changed when its pointer was saved (not a run's verify, `verified_at`). Never the pointer, a prefix, a length or a hash.",
      "x-agentrun-serve": "secrets/1",
    };
    fields.push("SignIn.secret");
    signInSchema.required = [...signInSchema.required, ...SIGN_IN_FIELDS_SENT];
  }
  // costbasis/1: how a run's cost was reached (metrics.ts CostBasis), beside the contract's `charge` and `estimate`, and the
  // same words on GET /usage.
  const costBasis = ((schemas.Cost as Json).properties as Record<string, Json>).basis as Json & { enum?: string[] };
  const usageBasis = ((schemas.Usage as Json).properties as Record<string, Json>).basis as Json & { enum?: string[] };
  for (const [name, schema] of [["Cost", costBasis], ["Usage", usageBasis]] as const) {
    if (!Array.isArray(schema.enum)) continue;
    for (const value of COST_BASES) {
      if (schema.enum.includes(value)) continue;
      schema.enum = [...schema.enum, value];
      fields.push(`${name}.basis.${value}`);
    }
    schema["x-agentrun-serve"] = "costbasis/1";
  }
  costBasis.description = "How `usd` was reached. `charge`: what the account pays (hosted). On this server, by how the run's model requests were priced: `reported` when every request priced had its provider's or gateway's own figure (LiteLLM's `x-litellm-response-cost` header, OpenRouter's usage `cost`); `estimate` when any was priced from a price table (the model catalog, AGENT_MODEL_PRICE, a cut request counted at its hold; a native, SDK or imported run's figure, its harness's own); `unpriced` when no request was priced (none sent, refused at $0, or none with a known figure). A run's paid tool calls and decisions are charged at their own figures and do not change it. A streamed answer through LiteLLM states no cost in its headers, so such a run reads `estimate`.";
  usageBasis.description = "How the runs' costs were reached (Cost.basis over the runs in the window): `estimate` when any run's is, else `reported` when any run's is, else `unpriced`. `charge`: hosted.";
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
  // mcpservers/1: the reasons a saved MCP server's 422 gives beside the contract's (mcp-probe.ts): a URL that redirects
  // (never followed) or is plain http off loopback, a server listing too many tools or too much of them, a name kept for
  // AgentRun's own tools, a sign-in that expired.
  for (const reason of MCP_ISSUE_REASONS) {
    if (!Array.isArray(issueReason.enum) || issueReason.enum.includes(reason)) continue;
    issueReason.enum = [...issueReason.enum, reason];
    fields.push(`InputIssue.reason.${reason}`);
  }
  // A save's warning for each monid endpoint priced by usage it pins (monid.ts usageWords).
  if (Array.isArray(issueReason.enum) && !issueReason.enum.includes(PRICED_BY_USAGE)) {
    issueReason.enum = [...issueReason.enum, PRICED_BY_USAGE];
    fields.push(`InputIssue.reason.${PRICED_BY_USAGE}`);
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
  // A run's learning row beside the contract's row kinds, and GET /usage's `learning` meter: what a run's grade spends
  // on this server, outside any run.
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
    // The newest addition that widened it: a client that validates against runners/1 refuses run_not_final, purged and
    // agent_not_archived.
    errorCode["x-agentrun-serve"] = "purge/1";
    fields.push(...own.map((code) => `ErrorCode.${code}`));
  }
  // A start (or a message) while every runner here refused to claim any run: 503 runner_refused, not retryable, in the
  // runners' words and their fix (runner/presence.ts).
  const errorBodyCode = ((schemas.ErrorBody as Json).properties as Record<string, Json>).code!;
  errorBodyCode["x-agentrun-serve-note"] = `503 \`${RUNNER_REFUSED_CODE}\` (POST /agents/{agent_id}/runs, POST /runs, a learned workflow's replay, POST /agents/{agent_id}/sdk-runs, POST /runs/{run_id}/messages): every runner of this server refused to claim any run (its run isolation refused), so the run would wait queued for good. Not retryable: no try again changes it until a runner that can claim is started. Its message is the runners' own words and their fix (\`set AGENTRUN_RUN_USER=same\`, for one), as \`GET /capabilities\`' \`runner_refused\` says them; a trigger's firing fails with the same code and words.`;
  noted.push("ErrorBody.code");
  // A failed run's own codes beside the contract's (store-view.ts errorOfRow): a run whose sandbox was lost more times than
  // its claim starts new ones (computer-lost.ts), and a run still queued while every runner here refused to claim
  // (runner/presence.ts).
  const runErrorCode = schemas.RunErrorCode as Json & { enum?: string[] };
  const runOwn = [COMPUTER_UNAVAILABLE_CODE, RUNNER_REFUSED_CODE].filter((code) => Array.isArray(runErrorCode.enum) && !runErrorCode.enum.includes(code));
  if (runOwn.length) {
    runErrorCode.enum = [...runErrorCode.enum!, ...runOwn];
    runErrorCode["x-agentrun-serve"] = "runners/1";
    fields.push(...runOwn.map((code) => `RunErrorCode.${code}`));
  }
  const details = ((schemas.ErrorBody as Json).properties as Record<string, Json>).details!;
  details["x-agentrun-serve-details"] = {
    agent_not_runnable: NOT_RUNNABLE_DETAILS, system_file_forbidden: FORBIDDEN_DETAILS,
    external_body_conflict: closed({ external: closed({ source: { type: "string" }, kind: { type: "string" }, id: { type: "string" }, version: { type: "string", description: "The version already run with another definition, as text." } }, "The reference and version POST /runs named.") }),
    auth_required: closedWith({
      auth: { enum: ["bearer", "oauth"], description: "What the MCP server asks for: `oauth` when it names protected-resource metadata, else `bearer`." },
      status: { enum: [401, 403] },
    }, {
      oauth: { ...MCP_SIGN_IN_CLIENT, description: "With `auth: oauth`, when the sign-in's discovery could be made." },
    }),
    input_invalid: { type: "object", additionalProperties: false, properties: { oauth: { ...MCP_SIGN_IN_CLIENT, description: "With field `client_id`, reason `registration_unavailable` (POST .../oauth/start): as a preview's `details.oauth`, `registration` false." }, composio: { type: "string", description: "A Composio preset save refused on a field (PUT .../composio) whose removal of what it made there Composio refused too: what is left there and where to remove it, in words, as its message ends." } } },
    upstream_failed: { type: "object", additionalProperties: false, properties: { status: { type: "integer", description: "The MCP server's HTTP status, when it answered one." } } },
    sign_in_held: { type: "object", additionalProperties: false, minProperties: 1, maxProperties: 1, properties: { held_by: { type: "string", description: "The run that holds the sign-in's save lease." }, handed_to: { type: "string", description: "A run still going that was handed the sign-in (signins/1)." } } },
    wrong_origin: closed({ open: { type: "string", format: "uri", description: "Where to open the console to sign in: the address the authorization server sends the browser back to." } }),
    forbidden: closed({ console_url: { type: "string", format: "uri", description: "A secret write refused to the API token (`x-agentrun-secret` operations): the console page where the owner's signed-in session finishes it, at the server's public URL or the address the request reached. The message ends \"Finish it in the console: <console_url>\". For an MCP server's save or sign-in it opens the add form (`#/settings/mcp?add=<name>`, or `change=<name>` for a saved server) filled with what the request held that is no secret: `url` only when nothing in it could be a credential (no user or password, no query parameter named like one, no key-shaped segment or value, no key spanning path segments or a query's `+`, no host label that could be an id), `auth` (the kind of credential: `none` for a save with no auth; a kind the form can't fill, such as `per_run`, links to the page alone), `toolkit`; for a Composio save, its toolkit and actions, under `change=<name>` when it replaces a saved server. Never a token, a header, a client secret or a key: the person pastes that there. Absent where the console has no page for the operation, and on every other 403." } }, "Where a refused secret write is finished."),
    composio_subscription_elsewhere: closed({ webhook_url: { type: "string", description: "Where the Composio project's webhook subscription sends its events now." } }),
    composio_not_connected: closedWith({ server: { type: "string" }, user_id: { type: "string", description: "The Composio user the server runs as." } }, { connect_url: { type: "string", format: "uri", description: "Composio's page to connect the account." } }),
    composio_account_ambiguous: closed({ server: { type: "string" }, user_id: { type: "string", description: "The Composio user the server runs as." }, accounts: { type: "array", items: closed({ id: { type: "string", description: "Composio's id for the connected account." }, created_at: { type: "string", description: "When it was connected, as Composio says." } }), description: "The user's ACTIVE accounts for the toolkit, oldest first." } }),
    composio_in_use: closed({ triggers: { type: "array", items: closed({ id: { type: "string" }, name: { type: "string" } }), description: "The composio triggers that use it." } }),
    runs_in_flight: closed({ runs: { type: "array", items: { type: "string" }, description: "The agent's runs not ended (DELETE /agents/{agent_id})." } }),
    learning_busy: closed({ runs: { type: "array", items: { type: "string" }, description: "What of the agent's learning is at work (DELETE /agents/{agent_id}, DELETE /agents/{agent_id}/learning): each run of it not ended (a run of its own, whose compile turn and look-back are at its end, a check's replay or an audit's shadow among them), by its id." } }),
    run_not_final: closed({ runs: { type: "array", items: { type: "string" }, description: "What is live (DELETE /runs/{run_id}, and an archived agent's DELETE /agents/{agent_id}): the run itself, each run made from it that is live, or each live run of the agent, by its id." } }),
    purged: {
      oneOf: [
        closed({
          run_id: { type: "string" }, agent_id: { type: "string" },
          state: { enum: ["ended", "stopped", "failed"], description: "The run's state as its row kept it: only a run that is not live is purged." },
          started_at: { type: "string", format: "date-time" }, ended_at: { type: ["string", "null"], format: "date-time" },
          cost_usd: { type: ["number", "null"], minimum: 0, description: "What it cost, as `/usage` sums it: its known cost, else its upper bound." },
          cost_upper_bound: { type: "boolean", description: "`cost_usd` is an upper bound, not a known cost." },
          tools_usd: { type: ["number", "null"], minimum: 0, description: "What its paid tools cost, as `/usage`'s tools meter read it; null when none was read." },
          purged_at: { type: "string", format: "date-time" },
        }, "A purged run's tombstone (every route of /runs/{run_id})."),
        closed({ agent_id: { type: "string" }, archived_at: { type: ["string", "null"], format: "date-time" }, purged_at: { type: "string", format: "date-time" } }, "A purged agent's tombstone (every route of /agents/{agent_id})."),
      ],
    },
  };
  const extensions: string[] = [];
  for (const [path, item] of Object.entries(EXTENSIONS)) {
    for (const [method, op] of Object.entries(item)) {
      (doc.paths[path] ??= {})[method] = { "x-agentrun-serve": true, ...op };
      extensions.push(`${method.toUpperCase()} ${path}`);
    }
  }
  // purge/1: every route of a purged run or agent (DELETE /runs/{run_id}, DELETE /agents/{agent_id}) answers 410 purged
  // with its tombstone, its DELETE alone 204 again. A contract operation that gains the 410 is changed, and says so.
  (doc.components as Json).responses = {
    ...((doc.components as Json).responses as Record<string, Json>),
    Gone: {
      description: "`purged`: the run or agent was purged (`DELETE /runs/{run_id}`, `DELETE /agents/{agent_id}`); `details` is its tombstone. On a learned workflow's file (`readLearningFile`, its approve and restore): the run that wrote its workflow.json was purged, and `details` is that run's tombstone.",
      headers: { "X-Request-Id": ref("headers/RequestId") },
      content: { "application/json": { schema: ref("schemas/Error") } },
      "x-agentrun-serve": "purge/1",
    },
  };
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
    description: "Served by @parcha/agentrun-serve: the contract as vendored, unchanged, with this server's marks. Operations and schema properties marked x-agentrun-serve are this server's own, outside the contract (fields lists the properties, each marked with the addition that made it); operations marked x-agentrun-serve-unsupported answer 501 unsupported_here here; the contract's operations in not_served are left out, and answer 404 here; operations marked x-agentrun-serve-changed take more than the contract gives, each change named (changed lists them); a contract property marked x-agentrun-serve-unsupported is one this server refuses (unsupported_fields, with why); x-agentrun-serve-details gives what a code's details hold here (details lists where); x-agentrun-serve-note says what a contract property means here (notes lists them). servers is this server, relative to this document; the contract's own are in contract_servers.",
    extensions,
    changed,
    fields,
    unsupported_fields: refused,
    details: ["ErrorBody.details"],
    notes: noted,
    unsupported,
    not_served: notServed,
    contract_servers: doc.servers,
  };
  // This document is read from the server it describes, wherever it is published: a client generated from it calls
  // that server, not the first of the contract's.
  doc.servers = [{ url: "/v2", description: "This server." }];
  if (adapters !== TRIGGER_ADAPTERS) withAdapters(doc, adapters);
  // Every server-wide pushed source's own hook, the registry's as a test's: this server's own, and listed so.
  const hooks = serverHooks(adapters);
  Object.assign(doc.paths, hooks, NATIVE_PATHS, SDK_PATHS, CLI_LEARNING_PATHS, OBSERVATION_PATHS);
  ((doc.info["x-agentrun-serve"] as Json).extensions as string[]).push(...Object.entries({...NATIVE_PATHS,...SDK_PATHS,...CLI_LEARNING_PATHS,...OBSERVATION_PATHS}).flatMap(([path,item])=>Object.keys(item).map(method=>`${method.toUpperCase()} ${path}`)));
  ((doc.info["x-agentrun-serve"] as Json).extensions as string[]).push(...Object.keys(hooks).map((path) => `POST ${path}`));
  // purge/1, on every operation there is by now (each rewritten, never a shared constant's own object changed); `changed`
  // is info's own list. Every route of a purged run or agent, and each that writes to an agent its body names (a trigger
  // made for it or moved to it, a template applied onto it), which a purged one refuses.
  const namesAgent = new Set(["createTrigger", "updateTrigger", "applyTemplate"]);
  for (const [path, item] of Object.entries(doc.paths)) {
    const ofPurgeable = /^\/(runs\/\{run_id\}|agents\/\{agent_id\})(\/|$)/.test(path);
    if (!ofPurgeable && !Object.values(item).some((op) => typeof op === "object" && op !== null && namesAgent.has((op as Json).operationId as string))) continue;
    const ops = { ...item } as Record<string, Json & { responses?: Record<string, Json> }>;
    for (const [method, op] of Object.entries(ops)) {
      if (method === "parameters" || method.startsWith("x-") || !op.responses) continue;
      if (op.operationId === "deleteRun" || op.operationId === "deleteAgent") continue;
      if (!ofPurgeable && !namesAgent.has(op.operationId as string)) continue;
      ops[method] = { ...op, responses: { ...op.responses, "410": ref("responses/Gone") } };
      if (op["x-agentrun-serve"] !== undefined) continue;
      // An operation whose responses an earlier addition changed keeps that one's mark, as a schema two additions widen does.
      const marks = (op["x-agentrun-serve-changed"] ?? {}) as Json;
      ops[method]!["x-agentrun-serve-changed"] = { ...marks, responses: marks.responses ?? "purge/1" };
      if (!changed.includes(`${method.toUpperCase()} ${path}`)) changed.push(`${method.toUpperCase()} ${path}`);
    }
    doc.paths[path] = ops;
  }
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
