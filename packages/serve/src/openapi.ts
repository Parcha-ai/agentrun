// The OpenAPI document this server serves at GET /v2/openapi.json: the agentrun.v2/0 contract as vendored in
// src/openapi/agentrun-v2.openapi.json (its source is in its info), with this server's marks. The contract's operations are
// not changed: an operation answered 501 here carries `x-agentrun-serve-unsupported` with the reason, and this server's
// own routes are added as operations marked `x-agentrun-serve` (true, or the addition that made it, as `stats/1`), listed
// in `info.x-agentrun-serve`.
import { readFileSync } from "node:fs";
import { ERROR_STATUS } from "./errors.js";
import { LAUNCH_LOST } from "./files.js";
import { HARNESSES } from "./harness.js";
import { THINKING_LEVELS } from "./model.js";
import { TOOL_KEYS, UNREADABLE } from "./tool-keys.js";
import { DEFINITION_FIELDS, NOT_KEPT } from "./validate.js";

type Json = Record<string, unknown>;

/** Why each capability this server turns off answers 501, by the route's capability. */
export const UNSUPPORTED: Readonly<Record<string, string>> = {
  "home.export": "This server does not export a home yet.",
  "home.import": "This server does not import a home yet.",
  "runs.kill": "This server does not kill a run's process yet.",
  "files.upload": "This server takes no uploads yet.",
  quotes: "This server has no billing, so it gives no quotes.",
};

const ref = (name: string) => ({ $ref: `#/components/${name}` });
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [String(code), ref(`responses/${{ 400: "BadRequest", 401: "Unauthenticated", 404: "NotFound", 409: "Conflict", 415: "UnsupportedMediaType", 422: "Unprocessable", 429: "RateLimited", 500: "Internal" }[code]}`)]));
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
/** GET /stats's answer (stats.ts). */
const STATS = closed({
  agents: { ...COUNT, description: "Agents not archived." },
  runs: closed(
    { total: COUNT, active: COUNT, needs_input: COUNT, failed: COUNT, status_unknown: COUNT },
    "Runs not archived. `total` counts them all; a completed or cancelled run is counted in `total` alone. `failed` includes escalated. Each running run is in exactly one of `active` (this server holds it, queued, working or paused), `needs_input` (it holds it, input_required) and `status_unknown` (it does not hold it, or holds it as ended before its end is written).",
  ),
  per_agent: {
    type: "array", description: "Each agent not archived, by name then id, with how many of its runs are not archived; an agent with no runs is listed with 0.",
    items: closed({ agent_id: ref("schemas/Id"), name: { type: "string" }, runs: COUNT }),
  },
  cost: closed(
    {
      usd: { type: ["number", "null"], minimum: 0, description: "The sum of the known costs, rounded to 1e-6; null when no run's cost is known, never 0 for unknown." },
      basis: { type: ["string", "null"], enum: ["estimate", null], description: "`estimate` (the model cost the runs report) when `usd` is a number; null when it is null." },
      unknown_runs: COUNT,
    },
    "Over the runs not archived: `usd` sums the cost of each run that ended with one; every other run (running, or ended with no cost) is in `unknown_runs`.",
  ),
  archived: closed({ agents: COUNT, runs: COUNT }, "Agents archived, and runs archived or of an archived agent: counted here and in nothing else."),
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
      id: { enum: TOOL_KEYS.map((row) => row.id) }, label: { type: "string" }, unlocks: { type: "array", items: { type: "string" } }, harnesses: { type: "array", items: { enum: [...HARNESSES] } },
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
    }),
  },
  reenter: {
    oneOf: [closed({ reason: { enum: [...UNREADABLE] }, fields: { type: "array", items: { type: "string" } } }), { type: "null" }],
    description: "The stored values that do not open here, to be entered again (a PUT seals them under the current key), and why: `seal_key_missing` (the server was handed no seal key), `seal_key_changed` (sealed under another), `file_unreadable` (damaged; `fields` is empty when the file as a whole does not read). Null when every stored value opens.",
  },
});
const KEY_ID = { name: "key_id", in: "path", required: true, description: "The tool key: one of GET /settings/tool-keys' ids.", schema: { type: "string" } };
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

/** This server's own routes, outside the contract. */
const EXTENSIONS: Record<string, Record<string, Json>> = {
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
      description: "Read from the agent store's aggregates alone: no run's files are opened. Archived agents and runs are left out of every number but their own counts.",
      responses: { "200": json(STATS, "The counts and the cost."), ...errors(401, 429, 500) },
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
      description: "Each value is sealed under the server's seal key and kept in the data directory as ciphertext alone; the key's other fields stay as they are. 422 for an unknown key or field, or a value that is empty, holds a control character or is over 1024 bytes; 409 key_set_by_server for a field the server is started with; 409 no_sealing_key when the server was handed no seal key.",
      parameters: [KEY_ID],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["values"], properties: { values: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } } } } } } },
      responses: { "204": { description: "Saved." }, ...errors(400, 401, 409, 415, 422, 429, 500) },
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
  ...archiving("agents", "Agent", ref("parameters/AgentId"), "The agent, with archived_at."),
  ...archiving("runs", "Run", ref("parameters/RunId"), "The run, with archived_at."),
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
/** This server's own properties on the contract's objects, outside the contract, by where they go (a schema of
 *  components.schemas, then property names down to the object that takes them). Each is marked x-agentrun-serve with
 *  the addition that made it: `harness/1` is the one a later contract version would take on; `model/1` and `serve/1`
 *  are what this server added before it marked them. */
const FIELD_EXTENSIONS: Record<string, Record<string, Json>> = {
  Run: {
    review: REVIEW,
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
    review: REVIEW,
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
  RunFile: {
    unreadable: { type: "boolean", const: true, description: "Present when this server cannot read the file: a tool in the run's box created it private (owner-only). Reading it answers 403 `system_file_forbidden` with `details.reason` `unreadable`.", "x-agentrun-serve": "unreadable/1" },
  },
  DefinitionInput: {
    model: { type: "string", description: "`provider/model-id`, the model an agentic revision runs on; absent, this host's default. A workflow revision keeps none.", "x-agentrun-serve": "model/1" },
    thinking: { enum: [...THINKING_LEVELS], description: "An agentic revision's thinking level; absent, the model's. A workflow revision keeps none.", "x-agentrun-serve": "model/1" },
    harness: { enum: [...HARNESSES], description: "The harness that runs the revision. Absent on a request, pi; every answer names it. One this server does not run saves with a warning, and its runs are 409 agent_not_runnable naming it (capabilities.harnesses).", "x-agentrun-serve": "harness/1" },
  },
  AgentCreate: {
    note: { type: "string", maxLength: 2000, description: "What the revision changes, kept with it (GET /agents/{agent_id}/revisions).", "x-agentrun-serve": "definitionbody/1" },
  },
  Agent: {
    kind: { enum: ["agentic", "workflow", null], description: "The current revision's kind; null before the agent has one.", "x-agentrun-serve": "serve/1" },
    revision: { type: ["string", "null"], description: "The current revision's id; null before the agent has one.", "x-agentrun-serve": "serve/1" },
    revisions: { type: "integer", minimum: 0, description: "How many revisions the agent has.", "x-agentrun-serve": "serve/1" },
    archived_at: { type: ["string", "null"], description: "When the agent was archived, while it is; else null.", "x-agentrun-serve": "serve/1" },
  },
  Capabilities: {
    harnesses: {
      type: "array",
      description: "Each harness a revision may name, and whether this server runs it; when not, why.",
      items: { type: "object", additionalProperties: false, required: ["id", "available", "steer"], properties: { id: { enum: [...HARNESSES] }, available: { type: "boolean" }, steer: { type: "boolean", description: "Whether a message sent while the run works lands mid-turn (`steer`); when false, it waits for the turn's end and the answer's mode is `follow_up`." }, reason: { type: "string" } } },
      "x-agentrun-serve": "harness/1",
    },
    tools: {
      type: "array",
      description: "Every tool a revision may name (this server's closed table): whether a workflow's model nodes may use it (`nodes`), whether its code may call it (`calls`), and whether it runs here, else the variables it is missing.",
      items: {
        type: "object", additionalProperties: false, required: ["name", "summary", "nodes", "calls", "available", "harnesses"],
        properties: {
          name: { type: "string" }, summary: { type: "string" }, nodes: { type: "boolean" }, calls: { type: "boolean" }, call_only: { type: "boolean", description: "Only a workflow's call node runs it (pdf_pages, llm): no agentic revision or model node names it." }, available: { type: "boolean" }, missing: { type: "array", items: { type: "string" } },
          harnesses: { type: "array", items: { enum: [...HARNESSES] }, description: "The harnesses that run the tool here; a revision naming it on another harness saves with a warning and its runs are 409 agent_not_runnable.", "x-agentrun-serve": "tool-harness/1" },
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
  },
  Features: {
    archive: {
      type: "object", additionalProperties: false, required: ["agents", "runs", "list_param", "routes"],
      properties: { agents: { type: "boolean" }, runs: { type: "boolean" }, list_param: { type: "string" }, routes: { type: "array", items: { type: "string" } } },
      description: "Archiving agents and runs: hidden from the lists, kept with their history.",
      "x-agentrun-serve": "serve/1",
    },
    thinking: { type: "array", items: { type: "string" }, description: "The thinking levels an agentic revision may name.", "x-agentrun-serve": "serve/1" },
    tool_keys: {
      type: "object", additionalProperties: false, required: ["routes", "at_rest"],
      properties: { routes: { type: "boolean" }, at_rest: { enum: ["sealed", "unavailable"] } },
      description: "GET, PUT and DELETE /settings/tool-keys: a tool's key saved by name, kept `sealed` under the seal key the server was handed; `unavailable` with none, when nothing is kept.",
      "x-agentrun-serve": "toolkeys/1",
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
  // A workflow run pauses here (POST /runs/{run_id}/pause): its status reads `paused` until it is resumed.
  const runStatus = schemas.RunStatus as Json & { enum?: string[] };
  if (Array.isArray(runStatus.enum) && !runStatus.enum.includes("paused")) {
    runStatus.enum = [...runStatus.enum.slice(0, runStatus.enum.indexOf("working") + 1), "paused", ...runStatus.enum.slice(runStatus.enum.indexOf("working") + 1)];
    runStatus["x-agentrun-serve"] = "pause/1";
    fields.push("RunStatus.paused");
  }
  // This server's own error codes (errors.ts), beside the contract's closed list.
  const errorCode = schemas.ErrorCode as Json & { enum?: string[] };
  const own = Object.keys(ERROR_STATUS).filter((code) => Array.isArray(errorCode.enum) && !errorCode.enum.includes(code));
  if (own.length) {
    errorCode.enum = [...errorCode.enum!, ...own];
    errorCode["x-agentrun-serve"] = "toolkeys/1";
    fields.push(...own.map((code) => `ErrorCode.${code}`));
  }
  const details = ((schemas.ErrorBody as Json).properties as Record<string, Json>).details!;
  details["x-agentrun-serve-details"] = { agent_not_runnable: NOT_RUNNABLE_DETAILS };
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
