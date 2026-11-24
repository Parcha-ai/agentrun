// web_fetch: the page read by the provider the run's plane resolves the tool to (tool-plane.ts), through the run's Web
// (web-run.ts webOf), with the guarded direct fetch behind it. A URL goes to Parallel or Firecrawl only once the
// public-host guard's check passes it.
import type { JsonValue } from "@earendil-works/chord/json";
import type { TSchema } from "typebox";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { clip, type FetchOptions, type FoundPage, HTML_READ_CHARS, MAX_CHARS_MIN, PAGE_CHARS, PAGE_READ_MAX_CHARS, type Page, type Part, partProblem, providerOf, TEXT_CAP, URL_MAX, webFetchText, type WebPage } from "@parcha/agentrun-web";
import { fetchOptions, ordersOf, URL_PARAMETERS, webOf } from "./web-run.js";
import { FAUX_ENV } from "./model.js";
import { forModel } from "./result.js";
import { isUnavailable, planeOf, whyUnavailable } from "./tool-plane.js";

export const WEB_FETCH_TOOL = "web_fetch";

/** The part `options` names of the page at `url`, through the run's Web (where `options.lookingFor` is given and a
 *  decider runs, the page's likeliest chunks); a failed Page saying why where web_fetch does not run here. A part a
 *  call may not ask for is refused first. */
export async function fetchFor(env: NodeJS.ProcessEnv, url: unknown, options: FetchOptions = {}): Promise<WebPage | Page | FoundPage> {
  const resolved = planeOf(env).web_fetch;
  if (isUnavailable(resolved) && !partProblem(options)) return { ok: false, url: typeof url === "string" ? clip(url, URL_MAX) : "", status: 0, title: "", text: "", links: [], error: `web_fetch does not run here: ${whyUnavailable(resolved)}` };
  return (await webOf(env).fetch(url, options)).answer;
}

/** The agent's tool, named `name`. A run whose web_fetch asks a keyed provider reads its key as the tool is made, when
 *  the run opens. `fake`: what reads each page in the provider's place (a template eval's web fake, web-fake.ts). */
export function webFetchTool(env: NodeJS.ProcessEnv, name = WEB_FETCH_TOOL, fake?: (url: unknown, part: Part & { signal?: AbortSignal }) => Promise<WebPage | Page>): ToolRegistration<TSchema, JsonValue> {
  if (!fake && ordersOf(env).fetch.some((id) => providerOf(id).key)) webOf(env);
  return defineTool({
    name,
    description: `Read one web page from a public host, a part at a time. It has no cookies, sign-ins or session: it reads one page cold, so a page behind a sign-in, or one that depends on an earlier page, needs the browser tool, where this run has it. Answers JSON: ok, the final url, the HTTP status, the page's title, text (a part of its readable text as markdown: about max_chars characters from offset, ${PAGE_CHARS.toLocaleString("en-US")} by default, at least ${MAX_CHARS_MIN} and at most ${TEXT_CAP.toLocaleString("en-US")}) and chars (that part's length), the absolute links the page holds (its link targets and the URLs written out in its text, a JSON body's strings and an XML feed's links among them, where an HTML page fetched directly gives its link targets alone; with the part at offset 0; links_omitted counts those its caps left out), and via: parallel when Parallel's extract read it, firecrawl-keyless when Firecrawl's keyless service read it (it is sent the URL), direct when it was fetched from the host, stopped when the call was stopped before its page arrived; a provider picked ahead that gave no page says why under its own name (parallel, firecrawl-keyless). A part that is not the whole page says so: truncated is true while more follows, next_offset is where the rest begins, original_chars is the page's whole length where it is known, and a line after the JSON says which characters these are; call again with offset to read on. A page whose HTML is longer than ${HTML_READ_CHARS.toLocaleString("en-US")} characters (scripts and styles aside) is cut before it is read: html_chars gives its whole length on every part, its text is only the start of the page, and the last part's line says it was cut. converted is "text" when the text is the page's plain text, its conversion to markdown having run out of time. A page is read to its first ${PAGE_READ_MAX_CHARS.toLocaleString("en-US")} characters (beyond_read on the last part says it goes on). A page is fetched once a run, at its first call: its later parts come from that read, with no request (through Parallel, one billed extract a page). A private or local address, a port other than 80 or 443, or a scheme other than http(s) is refused, never read and never sent to a third party (ok false, with refused saying why); so is a page fetched directly that is not text.`,
    parameters: URL_PARAMETERS,
    replay: "safe",
    execute: async (args, _api, context) => {
      const { url, offset, max_chars } = args as { url?: unknown; offset?: number; max_chars?: number };
      const signal = context?.abortSignal ? { signal: context.abortSignal } : {};
      const page = fake ? await fake(url, { offset, maxChars: max_chars, ...signal }) : await fetchFor(env, url, { ...(await fetchOptions(env, FAUX_ENV)), offset, maxChars: max_chars, ...signal });
      return forModel(webFetchText(page, name), { details: page });
    },
  });
}
