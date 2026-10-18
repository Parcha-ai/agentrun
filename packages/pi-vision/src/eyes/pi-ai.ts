// Eyes on a pi-ai model the host builds: one `completeSimple` request a look, thinking at the level the host names and
// never off, cut at `SEE_TIMEOUT_MS`, with its usage and price on the answer. The host keeps the credential: it passes a
// function that returns the key at each request, and nothing the eyes return carries it. pi-ai is loaded at the first
// look, so importing this entry loads nothing.
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { Eyes, EyesAnswer } from "../core/host.js";
import { resolveLimits, SEE_TIMEOUT_MS, type LimitsOverride } from "../core/limits.js";
import type { Part } from "../core/plan.js";

/** What the host gives `piAiEyes` beyond the model: how the key is read, the thinking level, a view of the payload, a timeout and limits. */
export type PiAiEyesOptions = {
  /** The key for each request, read when the request is made. */
  readonly apiKey?: () => string | undefined;
  /** pi's thinking level for the look. Every look thinks: "off", an unknown level or none asks for "minimal". */
  readonly reasoning?: string;
  /** The host's view of each request's payload before it is sent; a value it returns replaces the payload. */
  readonly onPayload?: (payload: unknown) => unknown;
  /** Default `SEE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Over the model's own `inputLimits`; `video.native` says the model takes video. */
  readonly limits?: LimitsOverride;
};

const LEVELS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** A part as pi-ai content: a video goes as an image block with its video MIME type. */
const content = (part: Part) => (part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image" as const, data: part.data, mimeType: part.mimeType });

/** Eyes on a pi-ai `model` the host built. One `completeSimple` request a look, at the thinking level in `options` and never
 *  off, cut at the timeout, with its usage and its price on the answer (null when the model has no rates). The key comes from
 *  `options.apiKey`, read at each request; without it pi-ai reads the provider's own variable. Either way the key is taken out of
 *  any error's words. */
export function piAiEyes(model: Model<Api>, options: PiAiEyesOptions = {}): Eyes {
  const limits = resolveLimits(model, options.limits);
  const reasoning = (LEVELS.includes(options.reasoning ?? "") ? options.reasoning : "minimal") as ThinkingLevel;
  const timeoutMs = options.timeoutMs ?? SEE_TIMEOUT_MS;
  // A model with no rate in its catalog entry has no known price: its looks cost null, never 0.
  const priced = model.cost.input > 0 || model.cost.output > 0;
  return {
    model: model.id,
    accepts: { image: model.input.includes("image"), video: limits.video.native, pdf: false },
    limits,
    async see({ parts, ask, context }, signal): Promise<EyesAnswer> {
      const { completeSimple, calculateCost } = await import("@earendil-works/pi-ai/compat");
      // A timer that holds the process open, so a request nothing else waits on is still cut; every exit clears it.
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      const text = context ? `Context: ${context}\n\n${ask}` : ask;
      let message: Awaited<ReturnType<typeof completeSimple>>;
      // The key never leaves in an error's words: every copy of that exact string is taken out of them.
      let key: string | undefined;
      const scrub = (words: string) => (key ? words.split(key).join("[key]") : words);
      try {
        key = options.apiKey?.();
        message = await completeSimple(model, { messages: [{ role: "user", content: [{ type: "text", text }, ...parts.map(content)], timestamp: Date.now() }] }, {
          apiKey: key,
          reasoning,
          signal: AbortSignal.any([signal, timeout.signal]),
          timeoutMs,
          ...(options.onPayload ? { onPayload: (payload: unknown) => options.onPayload!(payload) } : {}),
        });
      } catch (error) {
        const words = String((error as Error)?.message ?? error);
        if (key && words.includes(key)) throw new Error(scrub(words));
        throw error;
      } finally { clearTimeout(timer); }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        if (timeout.signal.aborted && !signal.aborted) throw new Error(`the ${model.id} request was cut after ${timeoutMs / 1000} s`);
        throw new Error(scrub(message.errorMessage || `the ${model.id} request ended with ${message.stopReason}`));
      }
      const usage = { ...message.usage, cost: { ...message.usage.cost } };
      const costUsd = priced ? calculateCost(model, usage).total : null;
      const answer = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
      return { text: answer, model: model.id, usage, costUsd };
    },
  };
}
