import { RUN_LABELS } from "../run-labels.js";
import { MCP_TOOL_KEY_PATTERN } from "../tool-names.js";
import { SDK_RUNTIMES, SDK_PLATFORM_MAX_LENGTH, SDK_PLATFORM_PATTERN } from "./runtimes.js";

const text = { type: "string" };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const platform = {
  ...text, minLength: 1, maxLength: SDK_PLATFORM_MAX_LENGTH, pattern: SDK_PLATFORM_PATTERN,
  description: "External source's display label, such as openclaw or capy. Preserved exactly; no surrounding whitespace, controls or lone surrogates. Never selects a managed harness or workflow capability.",
};
/** Closed alternatives keep platform required only for external sources in every generated client. External starts
 *  do not accept bridge fields, even an empty catalog: a platform name never confers an integration's capabilities. */
const sdkObject = (properties: Record<string, unknown> = {}, required = Object.keys(properties)) => ({
  "x-agentrun-python-preserve-object": true,
  oneOf: [
    object({ runtime: { enum: SDK_RUNTIMES.filter(runtime => runtime !== "external") }, ...properties }, ["runtime", ...required]),
    object({ runtime: { const: "external" }, platform, ...Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "workflow_tools" && key !== "workflow_adapters")) }, ["runtime", "platform", ...required]),
  ],
});
export const SDK_BINDING = sdkObject();
const usage = object(
  Object.fromEntries(
    ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd"].map((key) => [
      key,
      { type: [key === "cost_usd" ? "number" : "integer", "null"], minimum: 0 },
    ]),
  ),
  [],
);
export const SDK_RUN = {
  ...sdkObject({
    model: { type: ["string", "null"] },
    session_id: { type: ["string", "null"] },
    learning_revision: { type: ["string", "null"] },
    usage: { oneOf: [usage, { type: "null" }] },
  }),
  "x-agentrun-serve": "sdk/1",
};
const event = {
  oneOf: [
    object({ type: { const: "text" }, text: { ...text, maxLength: 128000 } }),
    object({ type: { const: "session" }, session_id: { ...text, maxLength: 256 } }),
    object({
      type: { const: "workflow_check" }, id: { ...text, maxLength: 256 }, digest: { ...text, maxLength: 256 },
      outcome: { enum: ["answered", "handed_back", "failed", "skipped_write"] },
      answer: { ...text, maxLength: 128000 }, reason: { ...text, maxLength: 8000 },
      skipped: object({ tool: { ...text, maxLength: 256 }, unmarked: { const: true } }, ["tool"]),
      fresh_reads: { type: "integer", minimum: 1, maximum: 256 },
    }, ["type", "id", "digest", "outcome"]),
    object(
      {
        type: { const: "tool" },
        id: { ...text, maxLength: 256 },
        name: { ...text, maxLength: 256 },
        status: { enum: ["started", "completed", "failed"] },
        input: {},
        output: {},
        parent_tool_use_id: { ...text, minLength: 1, maxLength: 256, description: "The open, pinned learned_workflow invocation that owns this callback. Keep the same parent on its result." },
      },
      ["type", "id", "name", "status"],
    ),
  ],
};
const response = (schema: unknown) => ({
  description: "Backend SDK run.",
  content: { "application/json": { schema } },
});
const body = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
const id = (name: string) => ({ in: "path", name, required: true, schema: text });
const key = { in: "header", name: "Idempotency-Key", schema: { type: "string", minLength: 1, maxLength: 255 } };
const mark = { "x-agentrun-serve": "sdk/1", security: [{ bearer: [] }], tags: ["SDK runs"] };
const errors = Object.fromEntries(
  [400, 401, 404, 409, 413, 422, 503].map((status) => [status, { description: "The SDK request was refused." }]),
);
const learning = object({
  enabled: { type: "boolean" },
  revision: { type: ["string", "null"] },
  context: { ...text, description: "The agent's corrections.md as the run reads it under # Learned; empty when Off or nothing is learned yet." },
  workflows: { type: "array", items: object({ name: text, workflow: text, description: text }), description: "Promoted, capability-compatible learned workflows pinned to this run; empty without a backend workflow bridge, during an independent shadow-check turn, or when learning is Off." },
  check: { ...object({ id: text, revision: text, digest: text, workflow: object({ name: text, workflow: text, description: text }) }), description: "One compiled draft reserved for a shadow check against this run's native answer. Keep outside the model context; replay only recorded tool results after the native turn and submit workflow_check evidence." },
}, ["enabled", "revision", "context", "workflows"]);
export const SDK_PATHS = {
  "/agents/{agent_id}/sdk-runs": {
    post: {
      ...mark,
      operationId: "startSdkRun",
      summary: "Register a task executed by an existing backend SDK",
      description:
        "Requires an SDK agent definition. Captures the actual original policy and input, pins promoted workflows and any compiled shadow-check candidate separately, and returns a credential scoped to this run. The backend retains all model/tool/auth settings. Learning requires a configured server reflection/grading model; learning Off needs no server model key. The run takes evidence until an hour after this request; each events batch moves that deadline to an hour after the batch, up to 24 hours after this request (capabilities.features.sdk_runs.max_open_s). An agent holds at most capabilities.features.sdk_runs.max_open_per_agent SDK runs open at once: a start past it is 429 rate_limited until one completes, is cancelled or its inbox closes.",
      parameters: [id("agent_id"), { ...key, required: true }],
      requestBody: body(
        sdkObject(
          {
            input: { ...text, maxLength: 128000 },
            instructions: { ...text, maxLength: 128000 },
            model: { ...text, maxLength: 256 },
            workflow_tools: { type: "array", maxItems: 64, description: "Opts into backend workflow learning. Explicit callback catalog, at most 64 KiB JSON. Credentials and implementations stay in the application.", items: object({
              name: { ...text, maxLength: 256, pattern: MCP_TOOL_KEY_PATTERN },
              description: { ...text, minLength: 1, maxLength: 4000 },
              input_schema: { type: "object", additionalProperties: true },
              output_schema: { type: "object", additionalProperties: true },
              permission: { enum: ["allow", "ask", "deny"] },
              price_usd: { type: "number", minimum: 0 },
            }, ["name", "description", "input_schema", "permission"]) },
            workflow_adapters: { type: "array", maxItems: 2, uniqueItems: true, items: { enum: ["runNode", "runJudge"] }, description: "Optional backend callbacks available for workflow model and decision nodes. Default empty; requires workflow_tools." },
            started_at: { ...text, format: "date-time", description: "When the backend began the task, as an RFC 3339 date-time: the run's created_at. At most 60 seconds ahead of the server's clock and at most 7 days behind it. Absent: now. The evidence deadline is still counted from this request." },
            title: { ...text, minLength: 1, maxLength: 128000, description: "The run's title, under every run's title rule: one line, whitespace collapsed, cut at 80 characters (never refused for its length). Absent: its input's." },
            labels: { ...RUN_LABELS, description: "The caller's own labels for the run, under the same rules as RunCreate.labels: kept on the run, served on every read of it and matched by GET /runs' label. Put no secret in one: a label holding a server secret is 422 under `labels.<key>`." },
          },
          ["input", "instructions"],
        ),
      ),
      responses: {
        201: response(
          object({
            run_id: text,
            agent_id: text,
            console_url: text,
            token: { ...text, description: "Bearer credential restricted to this SDK run; never pass to the model." },
            learning,
          }),
        ),
        ...errors,
        429: { description: "This agent already holds capabilities.features.sdk_runs.max_open_per_agent SDK runs open (rate_limited)." },
      },
    },
  },
  "/sdk-runs/{run_id}": {
    get: {
      ...mark,
      operationId: "getSdkRun",
      summary: "Read SDK run and learning state",
      description:
        "Use the scoped token returned by startSdkRun. A completed task can still be reflecting while its compile turn runs. The learning field is the ordinary run learning view.",
      parameters: [id("run_id")],
      responses: {
        200: response(
          object(
            {
              run_id: text,
              state: { enum: ["running", "processing", "completed", "failed", "cancelled"] },
              learning_run_id: text,
              learning: {},
            },
            ["run_id", "state", "learning"],
          ),
        ),
        ...errors,
      },
    },
  },
  "/sdk-runs/{run_id}/events": {
    post: {
      ...mark,
      operationId: "sdkRunEvents",
      summary: "Record bounded SDK execution evidence",
      description:
        "Use the scoped run token. Batches are contiguous from sequence 1, at most 100 events and 256 KB each, 4 MB total per run. Each new batch, an empty one (events: []) included, moves the run's deadline to an hour after it, up to 24 hours after the start; a run past its deadline takes no more evidence or completion and ends with an unknown outcome. Exact retries are idempotent; conflicting retries and events after completion are refused. Tool start IDs are unique per run. A nested callback names an already open, pinned learned_workflow invocation in parent_tool_use_id, and its result keeps the original call name and parent. Evidence never authorizes or executes a tool.",
      parameters: [id("run_id"), key],
      requestBody: body(
        object({ sequence: { type: "integer", minimum: 1 }, events: { type: "array", maxItems: 100, items: event } }),
      ),
      responses: { 200: response(object({ accepted: { const: true } })), ...errors },
    },
  },
  "/sdk-runs/{run_id}/complete": {
    post: {
      ...mark,
      operationId: "completeSdkRun",
      summary: "Complete a backend SDK task",
      description:
        "Completion is immutable and exact retries are idempotent. Server reflection runs without tools over captured evidence; the existing checker and independent grader decide learning. Set evidence_complete:false if any trace is missing; the task result is preserved but no learning is inferred.",
      parameters: [id("run_id"), key],
      requestBody: body(
        object(
          {
            status: { enum: ["completed", "failed", "cancelled"] },
            answer: { ...text, maxLength: 128000 },
            error: { ...text, maxLength: 8000 },
            model: { ...text, maxLength: 256 },
            session_id: { ...text, maxLength: 256 },
            usage,
            evidence_complete: { type: "boolean" },
          },
          ["status", "answer"],
        ),
      ),
      responses: { 200: response(object({ accepted: { const: true } })), ...errors },
    },
  },
};
