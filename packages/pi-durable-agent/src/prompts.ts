import { checkPrompts, OTHER_OPTION } from "./home.js";
import type { PromptVariant } from "./kinds.js";

/** A choice question, as Jev's `runJudge` takes it: instructions, and each option by name with its description. */
export type PromptQuestion = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
/** What `choosePrompt` asks of a judge: one choice question about `state`. A Jev runner (`createJevRunner`) is one. */
export type PromptJudge = (params: {
  label: string;
  kind: "judge";
  state: Record<string, unknown>;
  questions: Record<string, PromptQuestion>;
  signal?: AbortSignal;
}) => Promise<{ answers: Record<string, unknown>; model?: string | null; cost_usd?: number | null }>;
/** Where a lookup's text came from. */
export type PromptLookupSource = { via: string; url: string; title?: string | null };
/** What a lookup found for the input: text for the judge's second pass, and its sources. Null when it found nothing. */
export type PromptLookup = (query: string, context: { input: unknown; signal?: AbortSignal }) => Promise<string | { text: string; sources?: PromptLookupSource[] } | null>;

/** One pass of the question: Jev's top option, each option's probability, its confidence, and what the call cost. */
export type PromptPass = { choice: string; probabilities: Record<string, number>; confidence: number; model: string | null; cost_usd: number | null; latency_ms: number };
/** The choice for a run: the variant's id, the instructions it gets (the base's text, then the variant's), each pass,
 *  whether a lookup ran and what it read (never its text), and a reason that names every step. */
export type PromptChoice = {
  variant: string;
  instructions: string;
  passes: PromptPass[];
  lookup: { used: boolean; chars: number; sources: PromptLookupSource[] };
  reason: string;
};

/** The most characters of a lookup's text the second pass carries. */
export const LOOKUP_TEXT_MAX = 3_000;
const QUERY_MAX = 200;

const percent = (p: number) => `${Math.round(p * 100)}%`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The words of `input` to look up: the text itself, or the string values of a JSON input in order. */
function queryOf(input: unknown): string {
  const words: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") words.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(input);
  return words.join(" ").replace(/\s+/g, " ").trim().slice(0, QUERY_MAX);
}

/** A judge's answer to the question, or a refusal saying what was wrong with it. */
function answerOf(result: Awaited<ReturnType<PromptJudge>>, question: string): Pick<PromptPass, "choice" | "probabilities" | "confidence"> {
  const answer = result?.answers?.[question] as { choice?: unknown; probabilities?: unknown; confidence?: unknown } | undefined;
  const probabilities = answer?.probabilities;
  if (typeof answer?.choice !== "string" || !probabilities || typeof probabilities !== "object" || typeof answer.confidence !== "number"
    || !Object.values(probabilities).every((p) => typeof p === "number" && Number.isFinite(p))) {
    throw new Error(`the judge gave no choice for ${question}`);
  }
  return { choice: answer.choice, probabilities: { ...(probabilities as Record<string, number>) }, confidence: answer.confidence };
}

/**
 * The prompt a run starts with, chosen by the host before the run's first turn. The judge answers the set's question
 * about `{ input }`; the overlay whose option's probability is at least that overlay's threshold is chosen (the highest
 * such probability wins). When none is and `lookup` is given, it runs once on words of the input, and the judge
 * answers again about `{ input, lookup }` (the text cut to `LOOKUP_TEXT_MAX`) by the same rule. Otherwise the generic.
 * A judge or lookup failure never throws: the run gets the generic, and `reason` says why. A set `setPrompts` would
 * refuse is refused here too (`AgentHomeError` `invalid`).
 */
export async function choosePrompt(prompts: Record<string, PromptVariant>, input: unknown, options: { judge: PromptJudge; lookup?: PromptLookup; signal?: AbortSignal }): Promise<PromptChoice> {
  const set = checkPrompts(Object.entries(prompts ?? {}).map(([id, variant]) => ({ ...variant, id })));
  const [baseId] = set.find(([, variant]) => variant.role === "base")!;
  const [genericId] = set.find(([, variant]) => variant.role === "generic")!;
  const question = set.find(([, variant]) => variant.role === "question");
  const overlays = set.filter(([, variant]) => variant.when);
  const text = (id: string) => `${prompts[baseId]!.text.trim()}\n\n${prompts[id]!.text.trim()}`;
  const passes: PromptPass[] = [];
  const steps: string[] = [];
  const lookup: PromptChoice["lookup"] = { used: false, chars: 0, sources: [] };
  const done = (variant: string, last?: string): PromptChoice => {
    if (last) steps.push(last);
    return { variant, instructions: text(variant), passes, lookup, reason: steps.join("; ") };
  };
  if (!question || overlays.length === 0) return done(genericId, "no overlay has a rule, so the generic prompt");

  const [questionId, { text: instructions, criteria = {} }] = question;
  const criteriaOf = Object.fromEntries([...overlays.map(([, variant]) => variant.when!.option), OTHER_OPTION].map((option) => [option, criteria[option] ?? null]));
  const ask = async (state: Record<string, unknown>): Promise<PromptPass> => {
    const started = Date.now();
    const result = await options.judge({ label: questionId, kind: "judge", state, questions: { [questionId]: { type: "choice", instructions, criteria: criteriaOf } }, ...(options.signal ? { signal: options.signal } : {}) });
    return { ...answerOf(result, questionId), model: result.model ?? null, cost_usd: result.cost_usd ?? null, latency_ms: Date.now() - started };
  };
  /** The overlay a pass chooses, or undefined, and what the pass said. */
  const pick = (pass: PromptPass, after: string): string | undefined => {
    const probability = (option: string) => pass.probabilities[option] ?? 0;
    const chosen = overlays
      .filter(([, variant]) => probability(variant.when!.option) >= variant.when!.threshold)
      .sort(([a, x], [b, y]) => probability(y.when!.option) - probability(x.when!.option) || (a < b ? -1 : 1))[0];
    if (chosen) {
      const { option, threshold } = chosen[1].when!;
      steps.push(`${after}Jev: ${option} at ${percent(probability(option))}, at or over ${percent(threshold)}`);
      return chosen[0];
    }
    const top = overlays.find(([, variant]) => variant.when!.option === pass.choice)?.[1].when;
    steps.push(`${after}Jev: ${pass.choice} at ${percent(probability(pass.choice))}${top ? `, under ${percent(top.threshold)}` : " (no prompt for it)"}`);
    return undefined;
  };

  try {
    passes.push(await ask({ input }));
  } catch (error) {
    return done(genericId, `Jev failed (${messageOf(error)}), so the generic prompt`);
  }
  const first = pick(passes[0]!, "");
  if (first) return done(first);
  if (!options.lookup) return done(genericId, "so the generic prompt");

  let found: string | null = null;
  lookup.used = true;
  try {
    const result = await options.lookup(queryOf(input), { input, ...(options.signal ? { signal: options.signal } : {}) });
    if (typeof result === "string") found = result;
    else if (result && typeof result.text === "string") {
      found = result.text;
      lookup.sources = (result.sources ?? []).map(({ via, url, title }) => ({ via, url, ...(title !== undefined ? { title } : {}) }));
    }
    if (!found?.trim()) {
      found = null;
      steps.push("the lookup found nothing");
    }
  } catch (error) {
    steps.push(`the lookup failed (${messageOf(error)})`);
  }
  if (found === null) return done(genericId, "so the generic prompt");
  const carried = found.slice(0, LOOKUP_TEXT_MAX);
  lookup.chars = carried.length;
  try {
    passes.push(await ask({ input, lookup: carried }));
  } catch (error) {
    return done(genericId, `Jev failed after the lookup (${messageOf(error)}), so the generic prompt`);
  }
  const second = pick(passes[1]!, "after the lookup, ");
  return second ? done(second) : done(genericId, "so the generic prompt");
}
