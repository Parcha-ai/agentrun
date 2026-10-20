// The prompt a run starts with, picked by the host before the first model turn: @parcha/pi-durable-agent's
// `choosePrompt`, on the home's variants (a question row, overlays, a base and a generic), with Jev as its judge and,
// when Jev is unsure, one lookup: a Browserbase web search and Wikipedia's keyless search and summary, both at once.
// Here: the judge, the lookups, the run's guide (the base and the chosen variant) and `prompt.json`'s record.
import { createJevRunner, type JevJudge } from "@parcha/agentrun-jev";
import type { SearchRequest, SearchResult } from "@parcha/pi-browser";
import { choosePrompt, type PromptChoice, type PromptVariant } from "@parcha/pi-durable-agent";

/** A page a lookup read, or a search result it listed. */
export type LookupSource = { via: "browserbase_search" | "wikipedia"; url: string; title: string | null };
export type Lookup = { text: string; sources: LookupSource[] };
/** The home's variants, as `readAgentHome(home).prompts` gives them: a record by id. */
export type StoredPrompts = Record<string, PromptVariant>;

/** The run's guide: the home's base prompt, then the chosen variant (an overlay, or the generic prompt), by id. */
export function composePrompt(stored: StoredPrompts, variant: string): string {
  const base = Object.values(stored).find((v) => v.role === "base");
  const chosen = stored[variant];
  if (!base) throw new Error("the prompts have no base");
  if (!chosen || (chosen.role !== "overlay" && chosen.role !== "generic")) throw new Error(`the prompts have no variant ${variant}`);
  return `${base.text.trim()}\n\n${chosen.text.trim()}`;
}

/** `prompt.json` beside a run: `choosePrompt`'s choice without the instructions (the variant's id, each Jev pass, the
 *  lookup and what it read, the reason), with the question it answered, the input and when. */
export type PromptRecord = Omit<PromptChoice, "instructions"> & { version: 1; question: string | null; input: string; selected_at: string };

/** The run's prompt, before it starts: what `startRun` records (`prompt: { id, reason }`) and what `prompt.json` holds.
 *  Null when the home keeps no prompts. */
export async function promptForRun(options: { stored: StoredPrompts | undefined; input: string; judge: JevJudge; lookup: (name: string) => Promise<Lookup | null>; now?: () => Date }): Promise<{ prompt: { id: string; reason: string }; record: PromptRecord } | null> {
  const { stored } = options;
  if (!stored || !Object.keys(stored).length) return null;
  const { instructions: _, ...choice } = await choosePrompt(stored, options.input, { judge: options.judge as never, lookup: (query) => options.lookup(query) });
  const question = Object.entries(stored).find(([, v]) => v.role === "question")?.[0] ?? null;
  return { prompt: { id: choice.variant, reason: choice.reason }, record: { version: 1, question, input: options.input, ...choice, selected_at: (options.now?.() ?? new Date()).toISOString() } };
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
