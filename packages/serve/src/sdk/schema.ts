const text = { type: "string" };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
export const SDK_BINDING = object({ runtime: { enum: ["claude-agent-sdk", "codex-sdk"] } });
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
  ...object({
    runtime: SDK_BINDING.properties.runtime,
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
    object(
      {
        type: { const: "tool" },
        id: { ...text, maxLength: 256 },
        name: { ...text, maxLength: 256 },
        status: { enum: ["started", "completed", "failed"] },
        input: {},
        output: {},
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
  context: text,
  skills: { type: "array", items: object({ name: text, files: { type: "object", additionalProperties: text } }) },
  workflows: { type: "array", items: object({ name: text, workflow: text, description: text }), description: "Approved, capability-compatible workflows pinned to this run; empty without a backend workflow bridge or when learning is notes-only or Off." },
});
export const SDK_PATHS = {
  "/agents/{agent_id}/sdk-runs": {
    post: {
      ...mark,
      operationId: "startSdkRun",
      summary: "Register a task executed by an existing backend SDK",
      description:
        "Requires an SDK agent definition. Captures the actual original policy and input, pins approved learning, and returns a credential scoped to this run. The backend retains all model/tool/auth settings. Learning requires a configured server reflection/grading model; learning Off needs no server model key.",
      parameters: [id("agent_id"), { ...key, required: true }],
      requestBody: body(
        object(
          {
            runtime: SDK_BINDING.properties.runtime,
            input: { ...text, maxLength: 128000 },
            instructions: { ...text, maxLength: 128000 },
            model: { ...text, maxLength: 256 },
            workflow_tools: { type: "array", maxItems: 64, description: "Opts into backend workflow learning. Explicit callback catalog, at most 64 KiB JSON. Credentials and implementations stay in the application.", items: object({
              name: { ...text, maxLength: 256, pattern: "^mcp:[a-z][a-z0-9-]{0,31}/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$" },
              description: { ...text, minLength: 1, maxLength: 4000 },
              input_schema: { type: "object", additionalProperties: true },
              output_schema: { type: "object", additionalProperties: true },
              permission: { enum: ["allow", "ask", "deny"] },
              price_usd: { type: "number", minimum: 0 },
            }, ["name", "description", "input_schema", "permission"]) },
            workflow_adapters: { type: "array", maxItems: 2, uniqueItems: true, items: { enum: ["runNode", "runJudge"] }, description: "Optional backend callbacks available for workflow model and decision nodes. Default empty; requires workflow_tools." },
          },
          ["runtime", "input", "instructions"],
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
      },
    },
  },
  "/sdk-runs/{run_id}": {
    get: {
      ...mark,
      operationId: "getSdkRun",
      summary: "Read SDK run and learning state",
      description:
        "Use the scoped token returned by startSdkRun. A completed task can still have proposed learning awaiting its separate grader. The learning field is the ordinary run learning view.",
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
        "Use the scoped run token. Batches are contiguous from sequence 1, at most 100 events and 256 KB each, 4 MB total per run. Exact retries are idempotent; conflicting retries and events after completion are refused. Evidence never authorizes or executes a tool.",
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
