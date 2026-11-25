// One reading of a request's token counts for every provider, so every number this package (and what imports it)
// publishes agrees: `input` is the input neither read from nor written to the cache.
//   anthropic  input_tokens already leaves the cache out; cache_creation.ephemeral_1h_input_tokens is the 1h part.
//   openai     input_tokens holds cached_input_tokens (and a cache write where one is counted): subtracted. output_tokens
//              holds reasoning_output_tokens, kept as `reasoning` beside it. Codex writes OpenAI's counts.
//   pi         already split as Usage is, cacheWrite1h included.
//   openrouter Chat Completions' names: prompt_tokens holds prompt_tokens_details.cached_tokens and .cache_write_tokens,
//              subtracted; completion_tokens holds completion_tokens_details.reasoning_tokens, kept beside it.
//   opencode   {input, output, reasoning, cache: {read, write}, total?}: input already leaves the cache out. Since
//              OpenCode 1.3.16 output leaves the reasoning out (anomalyco/opencode 280eb16e77, #21047: "ensure reasoning
//              tokens arent double counted"; AI SDK 6 came in 1.3.4, and output was still the SDK's whole outputTokens
//              until then), so output is output + reasoning (reasoning kept beside it, as OpenAI's). Before it, output
//              held the reasoning already: a session's `version` older than 1.3.16 keeps output as it is. Where a step
//              records its `total`, output is what the total leaves after the input and the cache, when that is at
//              least the output, whatever the version. All nought is no usage: a request cut before its usage came.
//   copilot    GitHub Copilot CLI's {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}:
//              inputTokens holds the cache read and write (github/copilot-sdk docs/features/usage-and-billing.md),
//              subtracted; reasoningTokens is part of outputTokens, kept as `reasoning` beside it.
// A trace exporter's figure is otelUsage's: the same counts, its input inclusive of the cache.
import { isObject } from "./text.js";
import type { Usage } from "./types.js";

export type UsageFormat = "anthropic" | "openai" | "pi" | "openrouter" | "opencode" | "copilot";
/** What a format's reading may need beyond the counts: the version of the program that wrote them (OpenCode's). */
export type UsageOptions = { version?: string };

/** The first OpenCode whose output leaves the reasoning out. */
const OPENCODE_SPLIT = [1, 3, 16];
/** Whether `version` ("1.2.3", a pre-release after it) is an OpenCode older than 1.3.16; unknown is not. */
function beforeSplit(version: string | undefined): boolean {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!parts) return false;
  for (let i = 0; i < 3; i += 1) {
    const [at, split] = [Number(parts[i + 1]), OPENCODE_SPLIT[i]!];
    if (at !== split) return at < split;
  }
  return false;
}

/** Each format's names for input, cache read, cache write, output and the reasoning part of the output (a dotted name is
 *  a nested one), and whether its input holds its cache counts. */
const NAMES: Record<Exclude<UsageFormat, "opencode">, { input: string; cacheRead: string; cacheWrite: string; output: string; reasoning?: string; cachedIn: boolean }> = {
  anthropic: { input: "input_tokens", cacheRead: "cache_read_input_tokens", cacheWrite: "cache_creation_input_tokens", output: "output_tokens", cachedIn: false },
  openai: { input: "input_tokens", cacheRead: "cached_input_tokens", cacheWrite: "cache_write_input_tokens", output: "output_tokens", reasoning: "reasoning_output_tokens", cachedIn: true },
  pi: { input: "input", cacheRead: "cacheRead", cacheWrite: "cacheWrite", output: "output", cachedIn: false },
  openrouter: { input: "prompt_tokens", cacheRead: "prompt_tokens_details.cached_tokens", cacheWrite: "prompt_tokens_details.cache_write_tokens", output: "completion_tokens", reasoning: "completion_tokens_details.reasoning_tokens", cachedIn: true },
  copilot: { input: "inputTokens", cacheRead: "cacheReadTokens", cacheWrite: "cacheWriteTokens", output: "outputTokens", reasoning: "reasoningTokens", cachedIn: true },
};

const count = (value: unknown): number | undefined => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined);
/** The value at a dotted name in `raw`, undefined where any part is missing. */
const at = (raw: Record<string, unknown>, name: string): unknown => name.split(".").reduce<unknown>((value, part) => (isObject(value) ? value[part] : undefined), raw);

/** A request's usage as `format` writes it, as Usage; undefined unless input and output are counts (an absent cache
 *  count is 0) and the input left is not negative. The 1h part of the cache write, or the reasoning part of the output,
 *  is kept only when it is a count of at most the whole. */
export function normalizeUsage(format: UsageFormat, raw: unknown, options: UsageOptions = {}): Usage | undefined {
  if (!isObject(raw)) return undefined;
  if (format === "opencode") return openCodeUsage(raw, beforeSplit(options.version));
  const names = NAMES[format];
  const usage = { input: count(at(raw, names.input)), output: count(at(raw, names.output)), cacheRead: count(at(raw, names.cacheRead) ?? 0), cacheWrite: count(at(raw, names.cacheWrite) ?? 0) };
  if (usage.input === undefined || usage.output === undefined || usage.cacheRead === undefined || usage.cacheWrite === undefined) return undefined;
  if (names.cachedIn) usage.input -= usage.cacheRead + usage.cacheWrite;
  if (usage.input < 0) return undefined;
  const out: Usage = usage as Usage;
  const long = count(format === "anthropic" ? (isObject(raw.cache_creation) ? raw.cache_creation.ephemeral_1h_input_tokens : undefined) : format === "pi" ? raw.cacheWrite1h : undefined);
  if (long !== undefined && long <= out.cacheWrite) out.cacheWrite1h = long;
  const reasoning = names.reasoning === undefined ? undefined : count(at(raw, names.reasoning));
  if (reasoning !== undefined && reasoning <= out.output) out.reasoning = reasoning;
  return out;
}

function openCodeUsage(raw: Record<string, unknown>, holdsReasoning: boolean): Usage | undefined {
  const cache = isObject(raw.cache) ? raw.cache : {};
  const [input, output, reasoning, cacheRead, cacheWrite] = [raw.input, raw.output, raw.reasoning ?? 0, cache.read ?? 0, cache.write ?? 0].map(count);
  if (input === undefined || output === undefined || reasoning === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  const total = count(raw.total);
  const left = total === undefined ? -1 : total - input - cacheRead - cacheWrite;
  const usage: Usage = { input, output: left >= output ? left : holdsReasoning ? output : output + reasoning, cacheRead, cacheWrite };
  if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return undefined;
  if (raw.reasoning !== undefined && reasoning <= usage.output) usage.reasoning = reasoning;
  return usage;
}

/** A request's tokens as an OpenTelemetry GenAI span carries them: `input` INCLUSIVE of the cache (the uncached input, the
 *  cache read and the cache write together), as gen_ai.usage.input_tokens is defined and as Sentry reads it (it takes
 *  the cache counts out of it again, so an exclusive figure would go negative). The other counts as Usage has them. */
export type OtelUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number };
export function otelUsage(usage: Usage): OtelUsage {
  return { input: usage.input + usage.cacheRead + usage.cacheWrite, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }) };
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
