import type { LearningProblem } from "./learning";
import type { ApiError, InputIssue } from "./v2";

/** A refusal's issue at one field, as the server names it (with its `fix`, when it says one). Its `reason` is any string, as
 *  ApiError's `code` is: the server also sends reasons its document does not list yet (an MCP server's `url` "redirect"). */
export type FieldIssue = InputIssue;

/** A request AgentRun Server refused: its HTTP status and its typed error (`code`, `message`, `retryable`). */
export class ClientError extends Error {
  /** A 422's issues, by field, as the server names them. */
  fields?: FieldIssue[];
  /** A retryable refusal's wait before asking again, when the server named one (a busy store). */
  retryAfterMs?: number;
  /** What the server says beyond the message (`error.details`): a 409 `agent_not_runnable` names the box it lacks. */
  details?: Record<string, unknown>;
  /** A learning write the server's checks refused (400): each check it fails, printable. */
  problems?: LearningProblem[];
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false, readonly requestId?: string) {
    super(message);
    this.name = "ClientError";
  }
  toApiError(): ApiError { return { code: this.code, message: this.message, retryable: this.retryable, request_id: this.requestId, ...(this.details ? { details: this.details } : {}) }; }
}
