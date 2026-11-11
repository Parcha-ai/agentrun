// The /v2 error envelope: `{error: {code, message, retryable, ...}}`, with a code from the contract's closed list and
// that code's one HTTP status.

/** Each code of the closed list, with its one HTTP status. */
export const ERROR_STATUS = {
  bad_request: 400,
  invalid_file_path: 400,
  unauthenticated: 401,
  insufficient_credits: 402,
  spend_cap_reached: 402,
  forbidden: 403,
  system_file_forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  agent_exists: 409,
  name_taken: 409,
  // A trigger made on, turned on, or aimed while on, for an archived agent (triggers.ts).
  agent_archived: 409,
  agent_not_runnable: 409,
  home_busy: 409,
  idempotency_mismatch: 409,
  idempotency_in_progress: 409,
  not_continuable: 409,
  quote_invalid: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  request_timeout: 408,
  unsupported_media_type: 415,
  range_not_satisfiable: 416,
  input_invalid: 422,
  home_check_failed: 422,
  rate_limited: 429,
  internal: 500,
  unsupported_here: 501,
  unavailable: 503,
  // This server's own, beside the contract's list (openapi.ts marks them): a tool key its launcher sets, a send to a
  // webhook a 410 turned off, a write to a learning note that names no version it read, a remote MCP server that asks
  // for a credential, does not speak MCP, or fails, a message to a run paused at its cap, which takes one once its cap is
  // raised, a saved sign-in forgotten while a run holds its save lease (sign-ins-store.ts), and an answer to a browser
  // hand-over that already has a different one (browser-person.ts).
  key_set_by_server: 409,
  budget_reached: 409,
  webhook_off: 409,
  precondition_required: 428,
  auth_required: 422,
  not_mcp: 422,
  upstream_failed: 424,
  wrong_origin: 409,
  sign_in_held: 409,
  handoff_answered: 409,
  computer_not_live: 409,
  scope_taken: 409,
  // Connect GitHub (github-connection.ts): a github trigger on a server with no GitHub App, a second App, a Connect that
  // GitHub could not call back (no public address), and GitHub that
  // did not answer (a 429, a 5xx, or nothing) while a github_app MCP server's listing token was minted: tried again.
  github_not_connected: 409,
  github_already_connected: 409,
  github_no_public_url: 409,
  github_wrong_origin: 409,
  github_failed: 502,
  // A run of an agent given inline (POST /runs) under a version of its source already run here with another definition: a
  // version's definition never changes here, so the source publishes a new version.
  external_body_conflict: 409,
  // A learned workflow made into an agent of its own while it waits for its owner's OK or is retired: only an active one
  // is (learning-routes.ts promotable).
  learned_not_active: 409,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

const RETRYABLE = new Set<ErrorCode>(["home_busy", "idempotency_in_progress", "rate_limited", "internal", "unavailable", "github_failed"]);

/** A field that is missing or wrong. `example`: a value the field accepts, read from the request body's schema (explain.ts). */
export type InputIssue = { field: string; reason: string; message: string; expected?: string; fix?: string; code?: string; example?: unknown };

/** What a refusal carries beside its code and message. */
export type ErrorExtra = {
  capability?: string;
  fields?: InputIssue[];
  next_action?: Record<string, unknown>;
  details?: Record<string, unknown>;
  retry_after_ms?: number;
  /** A learning note the structural checks refuse: each problem, printable. */
  problems?: readonly unknown[];
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extra: ErrorExtra;
  readonly headers: Record<string, string>;
  constructor(code: ErrorCode, message: string, extra: ErrorExtra = {}, headers: Record<string, string> = {}) {
    super(message);
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.extra = extra;
    this.headers = headers;
  }

  body(requestId: string): { error: Record<string, unknown> } {
    return { error: { code: this.code, message: this.message, retryable: RETRYABLE.has(this.code), request_id: requestId, ...this.extra } };
  }
}

/** A feature this server does not offer: 501 naming its dotted path under `features`. */
export const unsupported = (capability: string, message: string) => new ApiError("unsupported_here", message, { capability });

/** `text` as one sentence: it ends in one full stop, whatever it ended in (a box's reason ends in none). */
export const sentence = (text: string): string => `${text.trimEnd().replace(/[.?!;:,]+$/, "")}.`;

/** `422 input_invalid` with each field that is missing or wrong. */
export const invalid = (fields: InputIssue[], message = fields[0]?.message ?? "the request is not valid") => new ApiError("input_invalid", message, { fields });
