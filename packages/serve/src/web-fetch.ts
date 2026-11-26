// web_fetch: the page read by the provider the run's plane resolves the tool to (tool-plane.ts), through the run's Web
// (web-run.ts webOf), with the guarded direct fetch behind it. A URL goes to Parallel or Firecrawl only once the
// public-host guard's check passes it.
import type { JsonValue } from "@earendil-works/chord/json";
import type { TSchema } from "typebox";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { askedUrl, type FetchOptions, type FoundPage, type Page, type Part, partProblem, WEB_FETCH_DESCRIPTION, WEB_FETCH_PARAMETERS, webFetchText, type WebPage } from "@parcha/agentrun-web";
import { fetchOptions, webOf } from "./web-run.js";
import { FAUX_ENV } from "./model.js";
import { forModel } from "./result.js";
import { isUnavailable, planeOf, whyUnavailable } from "./tool-plane.js";

export const WEB_FETCH_TOOL = "web_fetch";

/** The part `options` names of the page at `url`, through the run's Web (where `options.objective` is given and a
 *  decider runs, the page's likeliest chunks); a failed Page saying why where web_fetch does not run here. A part a
 *  call may not ask for is refused first. */
export async function fetchFor(env: NodeJS.ProcessEnv, url: unknown, options: FetchOptions = {}): Promise<WebPage | Page | FoundPage> {
  const resolved = planeOf(env).web_fetch;
  if (isUnavailable(resolved) && !partProblem(options)) return { ok: false, url: askedUrl(url), status: 0, title: "", text: "", links: [], error: `web_fetch does not run here: ${whyUnavailable(resolved)}` };
  return (await webOf(env).fetch(url, options)).answer;
}

/** The agent's tool, named `name`. The run's Web is made as the tool is made, when the run opens: it reads the key of
 *  any keyed provider web_fetch asks, and writes the run's start line (webOf). `fake`: what reads each page in the
 *  provider's place (a template eval's web fake, web-fake.ts). */
export function webFetchTool(env: NodeJS.ProcessEnv, name = WEB_FETCH_TOOL, fake?: (url: unknown, part: Part & { signal?: AbortSignal }) => Promise<WebPage | Page>): ToolRegistration<TSchema, JsonValue> {
  if (!fake) webOf(env);
  return defineTool({
    name,
    description: WEB_FETCH_DESCRIPTION,
    parameters: WEB_FETCH_PARAMETERS as unknown as TSchema,
    replay: "safe",
    execute: async (args, _api, context) => {
      const { url, offset, max_chars, objective } = args as { url?: unknown; offset?: number; max_chars?: number; objective?: unknown };
      const signal = context?.abortSignal ? { signal: context.abortSignal } : {};
      const page = fake ? await fake(url, { offset, maxChars: max_chars, ...signal }) : await fetchFor(env, url, { ...(await fetchOptions(env, FAUX_ENV)), offset, maxChars: max_chars, ...(typeof objective === "string" ? { objective } : {}), ...signal });
      return forModel(webFetchText(page, name), { details: page });
    },
  });
}
