// web_search: the web searched by the provider the run's plane resolves it to (tool-plane.ts), through the run's Web
// (web-run.ts webOf). The agent tool's breakers are its binding's, so another run starts with them closed; a call node's
// are its call's own.
import type { TSchema } from "typebox";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { type Breaker, breakers, fitSearch, type Search, type SearchBounds, type SearchProvider, searchArgs, searchText, serves, WEB_SEARCH_DESCRIPTION, WEB_SEARCH_PARAMETERS } from "@parcha/agentrun-web";
import { forModel } from "./result.js";
import { planeOf, searchChainOf, whyUnavailable } from "./tool-plane.js";
import { WEB_FETCH_TOOL } from "./web-fetch.js";
import { logReceipt, ordersOf, type SearchOn, searchingOn, webOf } from "./web-run.js";

export type { SearchOn };

export const WEB_SEARCH_TOOL = "web_search";
/** The tools that reach the web, each through the provider its run's plane resolves it to. */
export const WEB_TOOLS: readonly string[] = [WEB_FETCH_TOOL, WEB_SEARCH_TOOL];

/** `args` searched as the run's web_search, on fresh breakers: a call node's search falls to the next backend as the
 *  agent's does, and holds nothing after. */
export async function searchFor(env: NodeJS.ProcessEnv, args: Record<string, unknown>, signal?: AbortSignal, models?: SearchOn): Promise<Search> {
  return searched(env, args, breakers(), signal, models);
}

async function searched(env: NodeJS.ProcessEnv, args: Record<string, unknown>, breakerOf: (name: string) => Breaker, signal?: AbortSignal, models?: SearchOn, keyLimits: "web" | "call" = "call", bounds?: SearchBounds): Promise<Search> {
  const resolved = planeOf(env).web_search;
  // The chain table (tool-plane.ts searchChainOf) is the one source of what a resolution searches.
  if (!searchChainOf(resolved).length) return { error: `web_search does not run here: ${resolved === undefined ? "no provider was resolved for it" : whyUnavailable(resolved)}` };
  const { objective, queries, n } = searchArgs(args);
  // Under --faux, an order with every keyless provider left out (web-run.ts ordersOf) asks none.
  if (objective && !ordersOf(env).search.length) return { error: "web_search: under --faux, the keyless search endpoints are fakes', and this server names none" };
  // Its receipt goes on the server's log (web-run.ts logReceipt); the model reads the answer alone.
  const { answer, receipt } = await searchingOn.run(models, () => webOf(env).search({ objective, queries, n }, { n, breakers: breakerOf, keyLimits, ...(signal ? { signal } : {}), ...(bounds ? { bounds } : {}) }));
  logReceipt(receipt);
  return answer;
}

/** The agent's tool. The run's Web is made as the tool is bound, so a run whose web_search resolves to Parallel reads its
 *  key when the run opens. `fake`: what answers each search in the provider's place (a template eval's web fake,
 *  web-fake.ts). `now` and `bounds`: a test's breaker clock and this binding's search deadlines, held by its calls
 *  alone. */
export function webSearchTool(env: NodeJS.ProcessEnv, models?: SearchOn, fake?: (args: Record<string, unknown>, provider: Exclude<Search, { error: string }>["provider"]) => Search, now: () => number = Date.now, bounds?: SearchBounds): ToolRegistration<TSchema, JsonValue> {
  const provider = planeOf(env).web_search;
  if (!fake) webOf(env);
  const breakerOf = breakers(now);
  const named: SearchProvider = serves(provider, "search") ? (provider as SearchProvider) : "firecrawl-keyless";
  return defineTool({
    name: WEB_SEARCH_TOOL,
    description: WEB_SEARCH_DESCRIPTION,
    parameters: WEB_SEARCH_PARAMETERS as unknown as TSchema,
    replay: "safe",
    execute: async (args, _api, context) => {
      const answer = fake ? fitSearch(fake(args as Record<string, unknown>, named)) : await searched(env, args as Record<string, unknown>, breakerOf, context?.abortSignal, models, "web", bounds);
      return forModel(searchText(answer), { details: answer });
    },
  });
}
