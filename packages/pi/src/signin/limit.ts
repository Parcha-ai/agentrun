// The ChatGPT plan's usage limit (five hours on Plus, shared with every other app the user signed in to). OpenAI answers
// a request past it with 429 `subscription_sharing_usage_limit_exceeded`, at the start or mid-stream. It resets after
// hours, not seconds, so it is never retried: pi-ai sends a request once by default and classes the code as not
// retryable, and this maps it to one typed error.

export const USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";

export class UsageLimitError extends Error {
  readonly code = "USAGE_LIMIT";
  constructor(options?: { cause?: unknown }) {
    super("Your ChatGPT plan's usage limit is reached; wait, or set a provider key.", options);
    this.name = "UsageLimitError";
  }
}

/** The typed limit error when `value` (an error, an assistant message from a failed request, or its text) is the plan's
 *  usage limit; undefined otherwise. */
export function usageLimitError(value: unknown): UsageLimitError | undefined {
  if (value instanceof UsageLimitError) return value;
  const text = typeof value === "string" ? value
    : value instanceof Error ? value.message
    : value && typeof value === "object" && "errorMessage" in value ? String((value as { errorMessage?: unknown }).errorMessage ?? "")
    : "";
  return text.includes(USAGE_LIMIT_CODE) ? new UsageLimitError({ cause: value }) : undefined;
}
