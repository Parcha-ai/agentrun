// llm: one chat completion for a workflow's call node `via: "tool"`. No tools, no turns, no loop: the prompt goes to the
// model a workflow's model node of the same tier runs on here (the faux module's under `--faux`), and its text comes
// back with the usage and the price pi-ai's catalog gives it, null when the model has no price (never $0).
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const LLM_TOOL = "llm";
const MAX_PROMPT = 400_000;

export type LlmAnswer = { text: string; model: string; usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number } | null; cost_usd: number | null };

/** What the run's process gives the tool: one completion on its models. */
export type Complete = (args: Record<string, unknown>, signal: AbortSignal) => Promise<LlmAnswer>;

type Models = {
  getModel(provider: string, id: string): unknown;
  completeSimple(model: never, context: never, options?: never): Promise<{ content: { type: string; text?: string }[]; usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: { total: number } }; stopReason?: string; errorMessage?: string }>;
};

/** The completer over `models`, each call on `pick(tier)`'s model at `thinking`. */
export function completer(models: Models, pick: (tier: string | undefined) => { provider: string; modelId: string } | undefined, thinking: ModelThinkingLevel): Complete {
  return async (args, signal) => {
    const { prompt, system, maxTokens, tier } = args;
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("llm: prompt is a non-empty string");
    if (prompt.length > MAX_PROMPT) throw new Error(`llm: prompt is at most ${MAX_PROMPT} characters`);
    if (system !== undefined && typeof system !== "string") throw new Error("llm: system is a string");
    if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 64_000)) throw new Error("llm: maxTokens is an integer from 1 to 64000");
    if (tier !== undefined && !["fast", "default", "strong"].includes(tier as string)) throw new Error("llm: tier is fast, default or strong");
    const ref = pick(tier as string | undefined) ?? pick(undefined);
    if (!ref) throw new Error("llm: this run has no model");
    const model = models.getModel(ref.provider, ref.modelId) as { cost?: { input: number; output: number } } | undefined;
    if (!model) throw new Error(`llm: the model ${ref.provider}/${ref.modelId} is not known here`);
    const context = { ...(system ? { systemPrompt: system } : {}), messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
    const message = await models.completeSimple(model as never, context as never, { signal, reasoning: thinking, ...(maxTokens ? { maxTokens } : {}) } as never);
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(`llm: ${message.errorMessage ?? message.stopReason}`);
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    const priced = (model.cost?.input ?? 0) + (model.cost?.output ?? 0) > 0;
    // pi-ai counts cache reads and writes apart from `input`: the prompt's tokens are all three.
    const cached = (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0);
    const usage = message.usage ? { input_tokens: message.usage.input + cached, output_tokens: message.usage.output, cached_input_tokens: cached } : null;
    const cost = priced && typeof message.usage?.cost?.total === "number" ? message.usage.cost.total : null;
    return { text, model: `${ref.provider}/${ref.modelId}`, usage, cost_usd: cost };
  };
}
