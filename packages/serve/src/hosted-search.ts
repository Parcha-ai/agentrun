// pi's native web_search: ONE standalone request to the run's own model provider with its hosted search tool, as
// Claude's CLI runs its WebSearch. The request is one user turn carrying the query and a short instruction to answer
// with sources, on the run's model and key, sent through the run's models (marked and capped as each of its requests is:
// request-start.ts, cap.ts), with the provider's hosted tool added to the body (pi-ai's onPayload) and nothing else:
// Anthropic's `web_search_20250305` with at most 5 searches, or OpenAI's Responses `web_search`. pi-ai keeps none of the
// provider's search blocks, so the results, their citations and the search count are read from the provider's own
// events (onProviderStreamEvent). Nothing of it enters the run's conversation but the tool's answer, so nothing needs
// replaying. A `pause_turn` (Anthropic pausing a long search turn) answers what it has; nothing is retried.
//
// It is booked through the run's request-cost path as a side request labelled web_search: its tokens at the model's
// price plus each search at $10 per 1,000 (Anthropic's per search, OpenAI's per call). Under the run's cap its input is
// held at its context plus HOSTED_SEARCH_ALLOWANCE_TOKENS.
import type { AssistantMessage, Context, Models } from "@earendil-works/pi-ai";
import { clip, TITLE_CAP } from "./fetch-page.js";
import { sideRequests } from "./cap.js";
import { ANSWER_MAX, type Hit, type Search, snippetOf } from "./web-search.js";

export const HOSTED_MAX_USES = 5;
/** One search's results billed as input: about 25,000 tokens, a working estimate. */
export const SEARCH_INPUT_TOKENS = 25_000;
/** What the request may read into its input beyond its context, for the run's cap: each of its searches' results. */
export const HOSTED_SEARCH_ALLOWANCE_TOKENS = HOSTED_MAX_USES * SEARCH_INPUT_TOKENS;
export const ANTHROPIC_SEARCH_TOOL = Object.freeze({ type: "web_search_20250305", name: "web_search", max_uses: HOSTED_MAX_USES });
/** OpenAI's hosted search, as Codex's own live search asks for it: one shape whether the run's models send it or a CLI
 *  harness's session proxy does, which admits that shape alone (run-adapters-codex's policy, LIVE_SEARCH). */
export const OPENAI_SEARCH_TOOL = Object.freeze({ type: "web_search", external_web_access: true });
/** OpenAI's hosted search has no per-tool limit: the Responses API's `max_tool_calls` caps the built-in tool calls of the
 *  request at the HOSTED_MAX_USES its fee is reserved for, as Anthropic's tool's `max_uses` does. */
export const OPENAI_SEARCH_LIMIT = Object.freeze({ max_tool_calls: HOSTED_MAX_USES });
/** $10 per 1,000 searches (Anthropic) or calls (OpenAI). */
export const SEARCH_USD = 0.01;
/** OpenAI's models that bill each call's search content as a fixed block of 8,000 input tokens apart from the response's
 *  usage: the block is added to the fee at the model's input price. */
const BLOCK_BILLED = /^gpt-(?:4o|4\.1)-mini(?:-|$)/;
const ANSWER_TOKENS = 2_048;
/** As Exa's and Parallel's searches stop. */
const TIMEOUT_MS = 60_000;

let runModels: Models | undefined;
/** The run's models, marked and capped, handed over by the run's app before its tools are bound. */
export function searchOn(models: Models): void {
  runModels = models;
}

type Event = { type?: string; index?: number; content_block?: Record<string, unknown>; delta?: Record<string, unknown>; usage?: Record<string, unknown>; item?: Record<string, unknown>; response?: Record<string, unknown> };
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((item) => typeof item === "object" && item !== null) : []);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** What a provider's events say of the search: its results by URL, first seen first, and how many searches it ran. */
function reader(anthropic: boolean) {
  const hits = new Map<string, { title?: string; snippet?: string; published?: string }>();
  const add = (url: unknown, found: { title?: string; snippet?: string; published?: string }) => {
    if (typeof url !== "string" || !URL.canParse(url)) return;
    const hit = hits.get(url) ?? {};
    hits.set(url, { ...found, ...Object.fromEntries(Object.entries(hit).filter(([, value]) => value)) });
  };
  let reported: number | undefined;
  let calls = 0;
  let failed: string | undefined;
  const anthropicEvent = (event: Event) => {
    const block = event.content_block;
    if (event.type === "content_block_start" && block?.type === "server_tool_use" && block.name === "web_search") calls += 1;
    if (event.type === "content_block_start" && block?.type === "web_search_tool_result") {
      if (!Array.isArray(block.content)) failed = text((block.content as { error_code?: unknown } | undefined)?.error_code) ?? "the search failed";
      for (const result of list(block.content)) if (result.type === "web_search_result") add(result.url, { title: text(result.title), published: text(result.page_age) });
    }
    const citation = event.delta?.type === "citations_delta" ? (event.delta.citation as Record<string, unknown> | undefined) : undefined;
    if (citation) add(citation.url, { title: text(citation.title), snippet: text(citation.cited_text) });
    const used = (event.usage?.server_tool_use as { web_search_requests?: unknown } | undefined)?.web_search_requests;
    if (event.type === "message_delta" && typeof used === "number") reported = used;
  };
  const openaiEvent = (event: Event) => {
    const item = event.item;
    if (event.type === "response.output_item.done" && item?.type === "web_search_call") {
      calls += 1;
      for (const source of list((item.action as { sources?: unknown } | undefined)?.sources)) add(source.url, {});
    }
    if (event.type === "response.output_item.done" && item?.type === "message") {
      for (const part of list(item.content)) {
        const said = text(part.text) ?? "";
        for (const note of list(part.annotations)) {
          if (note.type !== "url_citation") continue;
          // The sentence the citation follows: OpenAI marks the cited source after the claim it supports.
          const before = said.slice(0, typeof note.start_index === "number" ? note.start_index : 0).trimEnd();
          add(note.url, { title: text(note.title), snippet: before.slice(Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n")) + 1).trim() });
        }
      }
    }
    const used = ((event.response?.tool_usage as { web_search?: { num_requests?: unknown } } | undefined)?.web_search)?.num_requests;
    if ((event.type === "response.completed" || event.type === "response.incomplete") && typeof used === "number") reported = used;
  };
  return {
    event: (event: unknown) => (anthropic ? anthropicEvent : openaiEvent)((event ?? {}) as Event),
    /** The searches the provider reported, else the search calls its answer held. */
    searches: () => reported ?? calls,
    failed: () => (hits.size ? undefined : failed),
    hits: (): Hit[] => [...hits].map(([url, hit]) => ({ url, title: clip(hit.title ?? "", TITLE_CAP), snippet: snippetOf(hit.snippet ?? ""), ...(hit.published ? { published: hit.published } : {}) })),
  };
}

/** `query` searched by `ref`'s provider (`provider/model-id`, the model the server resolved web_search on) through the
 *  run's models, at most `n` results: a Search. `models`: the run's (searchOn). */
export async function hostedSearch(query: string, n: number, ref: string | undefined, signal?: AbortSignal, models = runModels): Promise<Search> {
  const slash = ref?.indexOf("/") ?? -1;
  const provider = ref && slash > 0 ? ref.slice(0, slash) : undefined;
  const id = ref && slash > 0 ? ref.slice(slash + 1) : undefined;
  // The name as written, else Anthropic's own id for it (dots as dashes, as claude-agent prepares a dotted name:
  // adapters.ts claudeModelId), the one the run's models hold.
  const model = models && provider && id ? (models.getModel(provider, id) ?? (provider === "anthropic" ? models.getModel(provider, id.replaceAll(".", "-")) : undefined)) : undefined;
  if (!models || !model) return { error: `web_search has no model to search on in this run${ref ? ` (${ref})` : ""}` };
  const anthropic = model.api === "anthropic-messages";
  if (!anthropic && model.api !== "openai-responses") return { error: `web_search: ${ref} has no hosted web search here` };
  const read = reader(anthropic);
  const context: Context = { messages: [{ role: "user", content: [{ type: "text", text: `Search the web for: ${query}\n\nAnswer briefly from what the search finds, and name each source by its URL.` }], timestamp: Date.now() }] };
  const block = BLOCK_BILLED.test(model.id) ? (8_000 * (model.cost?.input ?? 0)) / 1e6 : 0;
  sideRequests.set(context, { label: "web_search", extraInputTokens: HOSTED_SEARCH_ALLOWANCE_TOKENS, maxFeeUsd: HOSTED_MAX_USES * (SEARCH_USD + block), feeUsd: () => read.searches() * (SEARCH_USD + block) });
  let answer: AssistantMessage;
  try {
    answer = await models.completeSimple(model, context, {
      maxTokens: ANSWER_TOKENS,
      maxRetries: 0,
      timeoutMs: TIMEOUT_MS,
      ...(signal ? { signal } : {}),
      // The hosted tool, exactly, and no other: the context offers none of its own.
      onPayload: (payload) => {
        const body = payload as Record<string, unknown>;
        return anthropic ? { ...body, tools: [ANTHROPIC_SEARCH_TOOL] } : { ...body, ...OPENAI_SEARCH_LIMIT, tools: [OPENAI_SEARCH_TOOL], include: [...(Array.isArray(body.include) ? body.include : []), "web_search_call.action.sources"] };
      },
      onProviderStreamEvent: (event) => read.event(event),
    });
  } catch (error) {
    return { error: `the provider's search failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
  }
  if (answer.stopReason === "error" || answer.stopReason === "aborted") return { error: answer.stopReason === "aborted" ? "the search was stopped" : `the provider's search failed: ${(answer.errorMessage ?? "no detail").slice(0, 300)}` };
  const failed = read.failed();
  if (failed) return { error: `the provider's search failed: ${failed}` };
  const said = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
  return { provider: "native", query, results: read.hits().slice(0, n), ...(said ? { text: clip(said, ANSWER_MAX) } : {}) };
}
