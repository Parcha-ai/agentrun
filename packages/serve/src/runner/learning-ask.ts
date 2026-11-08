// The learning run's grader call (learning-loop.ts LearningLoopDeps.ask). This first form calls the provider raw: one
// Messages request straight to its origin, priced from its usage, booked nowhere and asked of no cap.
import type { BeforeRequest } from "@parcha/agentrun-kernel";
import type { Tokens } from "../learning.js";
import type { LearningLoopDeps } from "./learning-loop.js";

/** Where the grader's request goes: Anthropic's Messages API at `origin`, for `model`, priced by `price`. */
export interface GraderRoute {
  readonly provider: { readonly api: "anthropic-messages"; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>> };
  readonly model: string;
  /** A request's price from its usage (the proxy's booking reads it). */
  readonly price?: (model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => number | null;
  /** The upstream fetch (a test's scripted origin). */
  readonly fetch?: typeof fetch;
}

export interface BookedAskOptions extends GraderRoute {
  /** The learning run's cap: the host's check before each paid request (the kernel cap's beforeRequestOf). */
  readonly beforeRequest?: BeforeRequest;
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function bookedAsk(options: BookedAskOptions): LearningLoopDeps["ask"] {
  return async (request, signal) => {
    const send = options.fetch ?? fetch;
    const response = await send(`${options.provider.origin}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": await options.provider.credential(), ...(options.provider.headers ?? {}) },
      body: JSON.stringify({ model: options.model, max_tokens: request.maxTokens, stream: true, messages: [{ role: "user", content: request.prompt }] }),
      signal,
    });
    let text = "";
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const line of (await response.text()).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6)) as { type?: string; delta?: { text?: string }; message?: { usage?: Record<string, number> }; usage?: Record<string, number> };
      if (event.type === "content_block_delta") text += event.delta?.text ?? "";
      const seen = event.message?.usage ?? event.usage;
      if (seen?.input_tokens !== undefined) usage.input = seen.input_tokens;
      if (seen?.output_tokens !== undefined) usage.output = seen.output_tokens;
      if (seen?.cache_read_input_tokens !== undefined) usage.cacheRead = seen.cache_read_input_tokens;
      if (seen?.cache_creation_input_tokens !== undefined) usage.cacheWrite = seen.cache_creation_input_tokens;
    }
    const tokens: Tokens = { input: usage.input, cache_read: usage.cacheRead, cache_write: usage.cacheWrite, output: usage.output };
    return { text, usd: options.price?.(options.model, usage) ?? null, tokens };
  };
}
