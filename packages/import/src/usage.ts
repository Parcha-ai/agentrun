// One reading of a request's token counts for every provider, so every number this package (and what imports it)
// publishes agrees: `input` is the input neither read from nor written to the cache.
//   anthropic  input_tokens already leaves the cache out; cache_creation.ephemeral_1h_input_tokens is the 1h part.
//   openai     input_tokens holds cached_input_tokens (and a cache write where one is counted): subtracted. output_tokens
//              holds reasoning_output_tokens, kept as `reasoning` beside it. Codex writes OpenAI's counts.
//   pi         already split as Usage is, cacheWrite1h included.
//   droid      Factory Droid's tokenUsage {inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, thinkingTokens}:
//              inputTokens already leaves the cache out; thinkingTokens is part of outputTokens, kept as `reasoning`.
import { isObject } from "./text.js";
import type { Usage } from "./types.js";

export type UsageFormat = "anthropic" | "openai" | "pi" | "droid";

/** Each format's names for input, cache read, cache write and output, and whether its input holds its cache counts. */
const NAMES: Record<UsageFormat, { input: string; cacheRead: string; cacheWrite: string; output: string; cachedIn: boolean }> = {
  anthropic: { input: "input_tokens", cacheRead: "cache_read_input_tokens", cacheWrite: "cache_creation_input_tokens", output: "output_tokens", cachedIn: false },
  openai: { input: "input_tokens", cacheRead: "cached_input_tokens", cacheWrite: "cache_write_input_tokens", output: "output_tokens", cachedIn: true },
  pi: { input: "input", cacheRead: "cacheRead", cacheWrite: "cacheWrite", output: "output", cachedIn: false },
  droid: { input: "inputTokens", cacheRead: "cacheReadTokens", cacheWrite: "cacheCreationTokens", output: "outputTokens", cachedIn: false },
};

const count = (value: unknown): number | undefined => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined);

/** A request's usage as `format` writes it, as Usage; undefined unless input and output are counts (an absent cache
 *  count is 0) and the input left is not negative. The 1h part of the cache write, or the reasoning part of the output,
 *  is kept only when it is a count of at most the whole. */
export function normalizeUsage(format: UsageFormat, raw: unknown): Usage | undefined {
  if (!isObject(raw)) return undefined;
  const names = NAMES[format];
  const usage = { input: count(raw[names.input]), output: count(raw[names.output]), cacheRead: count(raw[names.cacheRead] ?? 0), cacheWrite: count(raw[names.cacheWrite] ?? 0) };
  if (usage.input === undefined || usage.output === undefined || usage.cacheRead === undefined || usage.cacheWrite === undefined) return undefined;
  if (names.cachedIn) usage.input -= usage.cacheRead + usage.cacheWrite;
  if (usage.input < 0) return undefined;
  const out: Usage = usage as Usage;
  const long = count(format === "anthropic" ? (isObject(raw.cache_creation) ? raw.cache_creation.ephemeral_1h_input_tokens : undefined) : format === "pi" ? raw.cacheWrite1h : undefined);
  if (long !== undefined && long <= out.cacheWrite) out.cacheWrite1h = long;
  const reasoning = format === "openai" ? count(raw.reasoning_output_tokens) : format === "droid" ? count(raw.thinkingTokens) : undefined;
  if (reasoning !== undefined && reasoning <= out.output) out.reasoning = reasoning;
  return out;
}

/** The buckets a total of requests keeps, each a sum; cacheWrite1h is 0 when no request named one. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number };
export const noTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
export function addTokens(into: Tokens, usage: Usage): Tokens {
  into.input += usage.input;
  into.output += usage.output;
  into.cacheRead += usage.cacheRead;
  into.cacheWrite += usage.cacheWrite;
  into.cacheWrite1h += usage.cacheWrite1h ?? 0;
  return into;
}
