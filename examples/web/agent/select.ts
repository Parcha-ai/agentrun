// Which prompt a run starts with, decided by the host before the first model turn. Jev answers one choice question on the
// person's input; an overlay whose option is Jev's top answer, at or over that overlay's threshold, is the prompt. Under
// it, the host looks the name up once (a Browserbase web search, and Wikipedia's keyless search and summary) and asks
// Jev again with what it found; still under, the run gets the generic prompt.
import { createJevRunner, type JevJudge } from "@parcha/agentrun-jev";
import type { SearchRequest, SearchResult } from "@parcha/pi-browser";

export type PromptVariant = {
  role: "base" | "overlay" | "generic";
  label: string;
  text: string;
  when?: { question: string; option: string; threshold: number };
};
export type ChoiceQuestion = { id: string; instructions: string; criteria: Record<string, string> };
export type PromptSet = { variants: readonly PromptVariant[]; question: ChoiceQuestion };

/** One Jev answer: its top option, every option's probability, and Jev's own confidence. */
export type Pass = { choice: string; probabilities: Record<string, number>; confidence: number };
/** A page a lookup read, or a search result it listed. */
export type LookupSource = { via: "browserbase_search" | "wikipedia"; url: string; title: string | null };
export type Lookup = { text: string; sources: LookupSource[] };
/** What `prompt.json` holds: the variant chosen, each pass, and whether a lookup ran and what it read. */
export type Selection = { variant: string; passes: Pass[]; lookup: { used: boolean; sources: LookupSource[] }; reason: string };

export const GENERIC = "generic";
const LOOKUP_TEXT_MAX = 3_000;

const percent = (p: number) => `${Math.round(p * 100)}%`;

/** The overlay a pass selects, or null: the overlay for its top option, when that option's probability meets the
 *  overlay's threshold. */
export function overlayOf(prompts: PromptSet, pass: Pass): PromptVariant | null {
  const overlay = overlayFor(prompts, pass.choice);
  return overlay && (pass.probabilities[pass.choice] ?? 0) >= overlay.when!.threshold ? overlay : null;
}

const overlayFor = (prompts: PromptSet, option: string) =>
  prompts.variants.find((v) => v.role === "overlay" && v.when?.question === prompts.question.id && v.when.option === option);

/** One pass of the question on `state`. */
async function ask(judge: JevJudge, prompts: PromptSet, state: Record<string, unknown>): Promise<Pass> {
  const { id, instructions, criteria } = prompts.question;
  const result = await judge({ label: id, kind: "judge", state, questions: { [id]: { type: "choice", instructions, criteria } } } as never);
  const answer = (result.answers as Record<string, { type: string; choice: string; probabilities: Record<string, number>; confidence: number }>)[id];
  if (answer?.type !== "choice") throw new Error(`Jev answered ${id} with no choice`);
  return { choice: answer.choice, probabilities: { ...answer.probabilities }, confidence: answer.confidence };
}

function said(prompts: PromptSet, pass: Pass): string {
  const threshold = overlayFor(prompts, pass.choice)?.when?.threshold;
  return `${pass.choice} at ${percent(pass.probabilities[pass.choice] ?? 0)}${threshold === undefined ? " (no prompt for it)" : overlayOf(prompts, pass) ? "" : `, under ${percent(threshold)}`}`;
}

/** Picks the run's prompt for `input`. A Jev or lookup failure never stops the run: it gets the generic prompt, and the
 *  reason says why. */
export async function selectPrompt(options: { input: string; prompts: PromptSet; judge: JevJudge; lookup: (name: string) => Promise<Lookup | null> }): Promise<Selection> {
  const { input, prompts, judge } = options;
  const passes: Pass[] = [];
  const steps: string[] = [];
  const done = (variant: string, lookup: Selection["lookup"]) => ({ variant, passes, lookup, reason: steps.join("; ") });
  try {
    const first = await ask(judge, prompts, { input });
    passes.push(first);
    steps.push(`Jev: ${said(prompts, first)}`);
    const sure = overlayOf(prompts, first);
    if (sure) return done(sure.label, { used: false, sources: [] });
  } catch (error) {
    steps.push(`Jev failed (${(error as Error).message}), so the generic prompt`);
    return done(GENERIC, { used: false, sources: [] });
  }
  let found: Lookup | null = null;
  try {
    found = await options.lookup(input);
    if (!found) steps.push("the lookup found nothing");
  } catch (error) {
    steps.push(`the lookup failed (${(error as Error).message})`);
  }
  if (!found) {
    steps.push("so the generic prompt");
    return done(GENERIC, { used: true, sources: [] });
  }
  try {
    const second = await ask(judge, prompts, { input, lookup: found.text.slice(0, LOOKUP_TEXT_MAX) });
    passes.push(second);
    steps.push(`after the lookup, Jev: ${said(prompts, second)}`);
    const sure = overlayOf(prompts, second);
    if (sure) return done(sure.label, { used: true, sources: found.sources });
    steps.push("so the generic prompt");
  } catch (error) {
    steps.push(`Jev failed after the lookup (${(error as Error).message}), so the generic prompt`);
  }
  return done(GENERIC, { used: true, sources: found.sources });
}

/** The run's guide: the base prompt, then the chosen variant (an overlay, or the generic prompt). */
export function composePrompt(prompts: PromptSet, variant: string): string {
  const base = prompts.variants.find((v) => v.role === "base");
  const chosen = prompts.variants.find((v) => v.label === variant && v.role !== "base");
  if (!base) throw new Error("the prompts have no base");
  if (!chosen) throw new Error(`the prompts have no variant ${variant}`);
  return `${base.text.trim()}\n\n${chosen.text.trim()}`;
}

const WIKIPEDIA = "https://en.wikipedia.org";
const USER_AGENT = "agentrun-example/0.1 (https://github.com/Parcha-ai/agentrun)";
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

/** Wikipedia's keyless search for `name` (the top three pages, each with its one-line description), then the first
 *  page's summary. Null when the search finds no page. */
export function wikipediaLookup(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const get = async (url: string) => {
    const res = await (options.fetch ?? fetch)(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    if (!res.ok) throw new Error(`Wikipedia answered ${res.status}`);
    return (await res.json()) as Record<string, any>;
  };
  return async (name: string): Promise<Lookup | null> => {
    const search = await get(`${WIKIPEDIA}/w/rest.php/v1/search/page?q=${encodeURIComponent(name)}&limit=3`);
    const pages = (search.pages ?? []) as Array<{ key: string; title: string; description?: string | null; excerpt?: string }>;
    if (!pages.length) return null;
    const summary = await get(`${WIKIPEDIA}/api/rest_v1/page/summary/${encodeURIComponent(pages[0].key)}`);
    const text = [
      `Wikipedia's top pages for "${name}":`,
      ...pages.map((p) => `- ${p.title}${p.description ? `: ${p.description}` : ""}`),
      `The first, ${summary.title}${summary.type === "disambiguation" ? " (a disambiguation page)" : ""}: ${plain(String(summary.extract ?? ""))}`,
    ].join("\n");
    return { text, sources: [{ via: "wikipedia", url: summary.content_urls?.desktop?.page ?? `${WIKIPEDIA}/wiki/${encodeURIComponent(pages[0].key)}`, title: summary.title ?? pages[0].title }] };
  };
}

/** A web search for `name` (pi-browser's Browserbase provider's `search`): the top results' titles and addresses. Null
 *  when it finds nothing. */
export function searchLookup(search: (request: SearchRequest, signal?: AbortSignal) => Promise<SearchResult>, options: { n?: number; timeoutMs?: number } = {}) {
  return async (name: string): Promise<Lookup | null> => {
    const { results } = await search({ query: name, n: options.n ?? 5 }, AbortSignal.timeout(options.timeoutMs ?? 15_000));
    if (!results.length) return null;
    return {
      text: [`Web search results for "${name}":`, ...results.map((r) => `- ${r.title ?? "(no title)"} (${r.url})`)].join("\n"),
      sources: results.map((r) => ({ via: "browserbase_search" as const, url: r.url, title: r.title })),
    };
  };
}

/** Every lookup at once, what each found in order. Null when none found anything; a failure only when all failed. */
export function lookups(...each: Array<(name: string) => Promise<Lookup | null>>) {
  return async (name: string): Promise<Lookup | null> => {
    const settled = await Promise.allSettled(each.map((lookup) => lookup(name)));
    const found = settled.flatMap((s) => (s.status === "fulfilled" && s.value ? [s.value] : []));
    const failed = settled.flatMap((s) => (s.status === "rejected" ? [(s.reason as Error).message] : []));
    if (!found.length && failed.length === settled.length) throw new Error(failed.join("; "));
    return found.length ? { text: found.map((f) => f.text).join("\n\n"), sources: found.flatMap((f) => f.sources) } : null;
  };
}

/** Jev's runner options, as the run's host reaches it: through the model gateway's TypeSafe pass-through
 *  (`<root>/typesafe`) on the gateway's key when `AGENT_MODEL_BASE_URL` is set, else TypeSafe itself on
 *  `TYPESAFE_API_KEY`. `TYPESAFE_API_KEY` wins when both are given. */
export function jevOptionsOf(env: NodeJS.ProcessEnv) {
  const root = env.AGENT_MODEL_BASE_URL?.replace(/\/v1\/?$/, "");
  return {
    apiKey: env.TYPESAFE_API_KEY || (root ? env.AGENT_MODEL_API_KEY : undefined) || undefined,
    pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 },
    ...(root ? { baseURL: `${root}/typesafe` } : {}),
  };
}

export const judgeOf = (env: NodeJS.ProcessEnv): JevJudge => createJevRunner(jevOptionsOf(env));
