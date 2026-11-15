/** Console read model. The compatibility ingestion API lives at /api/v2/control and advertises its own capabilities. */
import { NATIVE_OBSERVATION_HARNESSES } from "../native/runtimes.js";
const text = { type: "string" };
const count = { type: "integer", minimum: 0 };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required });
const usage = object({
  input_tokens: count,
  output_tokens: count,
  cache_read_tokens: { type: ["integer", "null"], minimum: 0 },
  cache_write_tokens: { type: ["integer", "null"], minimum: 0 },
  total_tokens: count,
  cache_hit_rate: { type: ["number", "null"], minimum: 0, maximum: 1 },
  overflow: { type: "boolean" },
});
const connection = { enum: ["online", "offline", "disconnected"] };
const activity = {
  enum: [
    "unknown",
    "working",
    "idle",
    "waiting_input",
    "finished",
    "failed",
    "stopped",
  ],
};
export const OBSERVATION_PATHS = {
  "/observations": {
    get: {
      operationId: "getObservations",
      summary:
        "Read activity and token usage reported by externally running agents",
      description:
        "Observation-only sessions retain the original harness. They are not executable agent definitions and do not enable learning. Tokens include cache in input; absent cache counters are null. Receipts have a seven-day replay window; older source timestamps cannot create activity or usage. Sessions and received-day usage are retained for 90 days. Capacity overflow is explicitly refused. Cross-connector totals outside exact integer range are null with overflow true. CLI ingestion is at /api/v2/control; /api/v2/control/connectors/capabilities advertises the supported wire formats.",
      tags: ["Observations"],
      security: [{ bearer: [] }],
      "x-agentrun-serve": "observations/1",
      parameters: [
        {
          in: "query",
          name: "days",
          schema: { type: "integer", minimum: 1, maximum: 31, default: 30 },
          description:
            "UTC calendar days including today; session details remain visible for their full retention period.",
        },
        { in: "query", name: "session_id", schema: text },
      ],
      responses: {
        200: {
          description:
            "Connected sources, observed sessions and inclusive reported token totals.",
          content: {
            "application/json": {
              schema: object({
                connectors: {
                  type: "array",
                  items: object({
                    id: text,
                    display_name: text,
                    connection_state: connection,
                    ingestion_mode: { enum: ["polling", "otlp"] },
                    last_heartbeat_at: { type: ["string", "null"] },
                    receipt_count: count,
                    receipt_capacity: count,
                    storage_full: { type: "boolean" },
                  }),
                },
                sessions: {
                  type: "array",
                  items: object({
                    id: text,
                    connector_id: text,
                    source_id: text,
                    external_session_id: text,
                    harness: { enum: [...NATIVE_OBSERVATION_HARNESSES] },
                    activity,
                    reported_activity: activity,
                    connection_state: connection,
                    selection_active: { type: "boolean" },
                    occurred_at: text,
                    received_at: text,
                    created_at: text,
                    updated_at: text,
                    sequence: count,
                    display_name: text,
                    models: { type: "array", items: text },
                    usage: {
                      ...usage,
                      properties: {
                        ...usage.properties,
                        status: { enum: ["reported", "unavailable"] },
                      },
                      required: [...usage.required, "status"],
                    },
                    observation_only: { const: true },
                  }),
                },
                usage: {
                  ...usage,
                  properties: {
                    ...usage.properties,
                    input_tokens: { type: ["integer", "null"], minimum: 0 },
                    output_tokens: { type: ["integer", "null"], minimum: 0 },
                    total_tokens: { type: ["integer", "null"], minimum: 0 },
                    status: { enum: ["partial", "unavailable"] },
                    models: {
                      type: "array",
                      items: {
                        ...usage,
                        properties: {
                          ...usage.properties,
                          model: text,
                          input_tokens: {
                            type: ["integer", "null"],
                            minimum: 0,
                          },
                          output_tokens: {
                            type: ["integer", "null"],
                            minimum: 0,
                          },
                          total_tokens: {
                            type: ["integer", "null"],
                            minimum: 0,
                          },
                        },
                        required: [...usage.required, "model"],
                      },
                    },
                    daily: {
                      type: "array",
                      items: object({
                        date: text,
                        total_tokens: { type: ["integer", "null"], minimum: 0 },
                      }),
                    },
                  },
                  required: [...usage.required, "status", "models", "daily"],
                },
                limits: object({
                  max_receipts_per_connector: count,
                  max_sessions_per_connector: count,
                  receipt_retention: text,
                  receipt_window_seconds: count,
                  session_retention_days: count,
                  usage_retention_days: count,
                }),
              }),
            },
          },
        },
        401: {
          description: "An owner API token or console session is required.",
        },
        422: { description: "Invalid requested date window." },
      },
    },
  },
};
