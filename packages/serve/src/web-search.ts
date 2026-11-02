// web_search on pi: the web searched through Exa's keyless MCP endpoint (exa-keyless.ts), with no key: the default
// for a harness with no native search when no search key is saved. Only the search query and the number of results
// asked for leave this server, to https://mcp.exa.ai/mcp over IPv4; nothing else from the run goes with them. The answer
// is `{provider: "exa-keyless", query, results: [{url, title, snippet, published?}]}`, followed for the model by one
// line asking it to cite the URLs it relies on; or `{error}`, a tool error the model reads: no query, Exa's free rate
// limit (429, with its Retry-After), a refusal, nothing within 60 s. Nothing is retried and nothing else is searched instead. The query is cut at 200 characters, 1 to 8
// results (5 by default), and a result's snippet (its excerpts joined, links reduced to their text) is cut at 3,000
// characters.
import type { TSchema } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { fauxFetch } from "./decisions.js";
import { exaSearch, FAUX_EXA_ENV } from "./exa-keyless.js";
import { FAUX_ENV } from "./model.js";
import { forModel } from "./result.js";

export const WEB_SEARCH_TOOL = "web_search";
export const QUERY_MAX = 200;
/** The most results asked for: Exa's keyless search answers at most 8. */
export const RESULTS_MAX = 8;
const RESULTS_DEFAULT = 5;
/** The most of a result's text its snippet keeps. */
export const SNIPPET_MAX = 3_000;

export type Hit = { url: string; title: string; snippet: string; published?: string };
export type Search = { provider: "exa-keyless"; query: string; results: Hit[] } | { error: string };
/** The line that ends a search's answer to the model, as Claude Code's WebSearch ends its own. */
export const CITE = "Cite the URL of each result you rely on.";

/** A result's text as its snippet: links reduced to their text, whitespace collapsed, cut at SNIPPET_MAX on a word. */
export function snippetOf(raw: string): string {
  const text = raw.replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1").replace(/\s+/g, " ").trim();
  if (text.length <= SNIPPET_MAX) return text;
  const cut = text.slice(0, SNIPPET_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > SNIPPET_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `{query, n?}`: the query trimmed and cut at QUERY_MAX, n 1 to RESULTS_MAX. */
export const searchArgs = (args: Record<string, unknown>) => ({
  query: typeof args.query === "string" ? args.query.trim().slice(0, QUERY_MAX) : "",
  n: Math.max(1, Math.min(RESULTS_MAX, Math.floor(Number(args.n) || RESULTS_DEFAULT))),
});

/** `{query, n?}` searched on Exa's keyless endpoint, as a Search. */
export async function searchFor(env: NodeJS.ProcessEnv, args: Record<string, unknown>, signal?: AbortSignal): Promise<Search> {
  const { query, n } = searchArgs(args);
  if (!query) return { error: "web_search needs a query" };
  // Under --faux, Exa is the faux module's or none: a test never reaches the network.
  const faux = await fauxFetch(env, FAUX_EXA_ENV);
  if (env[FAUX_ENV] && !faux) return { error: "web_search: under --faux, Exa's endpoint is a faux module's, and this server names none" };
  return exaSearch(query, n, { send: faux ?? fetch, ...(signal ? { signal } : {}) });
}

/** The agent's tool: the Search as JSON text, a tool error when it is `{error}`. */
export function webSearchTool(env: NodeJS.ProcessEnv): ToolRegistration<TSchema, JsonValue> {
  return defineTool({
    name: WEB_SEARCH_TOOL,
    description: `Search the web (through Exa, with no key). Answers JSON: the query and its results, each with its url, title, a snippet and when it was published, if known. Cite the URL of each result you rely on. Use web_fetch to read a result's page.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, description: `What to search for, in a few words (cut at ${QUERY_MAX} characters).` },
        n: { type: "number", description: `Results to return, 1-${RESULTS_MAX} (default ${RESULTS_DEFAULT}).` },
      },
      required: ["query"],
    } as unknown as TSchema,
    replay: "safe",
    execute: async (args, _api, context) => {
      const answer = await searchFor(env, args as Record<string, unknown>, context?.abortSignal);
      return "error" in answer ? forModel(JSON.stringify(answer), { isError: true, details: answer }) : forModel(`${JSON.stringify(answer)}\n${CITE}`, { details: answer });
    },
  });
}
