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
  agent_not_runnable: 409,
  home_busy: 409,
  idempotency_mismatch: 409,
  idempotency_in_progress: 409,
  not_continuable: 409,
  quote_invalid: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  range_not_satisfiable: 416,
  input_invalid: 422,
  home_check_failed: 422,
  rate_limited: 429,
  internal: 500,
  unsupported_here: 501,
  unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

const RETRYABLE = new Set<ErrorCode>(["home_busy", "idempotency_in_progress", "rate_limited", "internal", "unavailable"]);

export type InputIssue = { field: string; reason: string; message: string; expected?: string; fix?: string };

/** What a refusal carries beside its code and message. */
export type ErrorExtra = {
  capability?: string;
  fields?: InputIssue[];
  next_action?: Record<string, unknown>;
  details?: Record<string, unknown>;
  retry_after_ms?: number;
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

/** `422 input_invalid` with each field that is missing or wrong. */
export const invalid = (fields: InputIssue[], message = fields[0]?.message ?? "the request is not valid") => new ApiError("input_invalid", message, { fields });
