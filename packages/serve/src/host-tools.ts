// The host tools of a run on a harness other than pi: pi's own read, write and edit (ArchilCodingTools), called with
// the run's environment, so their arguments, their confinement to the run's work/ and their refusals are pi's, word for
// word, pi's fetch_page and web_fetch, the public-host guard included, and monid's three (monid.ts). pi's tools take
// only the environment, their output and their diagnostics from a call's API, so that is all a call here gives them.
// read, fetch_page, web_fetch, monid.discover and monid.inspect may run again after a crash; write, edit and monid.run
// never: the kernel records each one's intent before it runs, and a call a crash cut off is answered interrupted, not
// run again. A tool is named by its catalog name here and goes to the harness under its wire name (catalog.ts:
// `monid.run` is `monid_run`), which the harness calls and journals.
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import type { HostTool } from "@parcha/agentrun-kernel";
import { ArchilCodingTools, type DurableRun } from "@parcha/pi-durable-disk";
import { wireName } from "./catalog.js";
import { FETCH_PAGE_TOOL, fetchOptions, fetchPageTool } from "./fetch-page.js";
import { FAUX_ENV } from "./model.js";
import { monidTools } from "./monid.js";
import { withSecrets } from "./secrets.js";
import { WEB_FETCH_TOOL, webFetchTool } from "./web-fetch.js";

/** Each tool a harness other than pi runs here, by catalog name, and whether a call a crash cut off may run again. */
export const REPLAY: Record<string, "safe" | "never"> = { read: "safe", write: "never", edit: "never", [FETCH_PAGE_TOOL]: "safe", [WEB_FETCH_TOOL]: "safe", "monid.discover": "safe", "monid.inspect": "safe", "monid.run": "never" };

/** One call's result, kept by its call id for the run's timeline (an adapter's tool_end carries none). */
export type ToolResults = Map<string, { text: string; isError: boolean }>;

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "")).join("") : "";

export function hostTools(run: DurableRun, names: readonly string[], context: Context, results: ToolResults): HostTool[] {
  const fetchPage = fetchPageTool(() => fetchOptions(process.env, FAUX_ENV)) as unknown as ToolRegistration;
  const webFetch = webFetchTool(process.env) as unknown as ToolRegistration;
  // monid's, only for a run that names one: its key is the one this process was handed over its pipe (secrets.ts),
  // never in its environment, and its long answers go in the run's work/, the claim's as pi's (`where.work`), read at
  // the call.
  const monid = names.some((name) => name.startsWith("monid.")) ? monidTools(withSecrets(process.env), () => run.claim.work) : [];
  const tools = new Map([...(ArchilCodingTools.tools ?? []), fetchPage, webFetch, ...monid].map((tool) => [tool.name, tool as ToolRegistration] as const));
  return names.flatMap((name) => {
    // The registrations are keyed by their wire names: the same name for every tool here but monid's.
    const tool = tools.get(wireName(name));
    const replay = REPLAY[name];
    if (!tool || !replay) return [];
    const host: HostTool = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as unknown as Record<string, unknown>,
      replay,
      async call(args, { callId, signal }) {
        const out: string[] = [];
        const env = await run.env({ conversationId: ROOT_CONVERSATION_ID, read: undefined as never }, context);
        // The call's id and the run's store, as pi's: a paid call marks and books its charge there (monid.ts).
        const api = { env, callId, commit: (change: never, at: Context) => run.harness.commit(change, at), output: (chunk: string | Uint8Array) => void out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")), outputWindow: undefined, diagnostic: () => {} };
        const result = await tool.execute(args as never, api as never, withAbortSignal(signal, context)).catch((error: Error) => ({ content: [{ type: "text", text: error.message }], isError: true }));
        // pi 1.1 names the result's blocks `content`, pi 1.2 and later `output`.
        const given = result as unknown as { content?: unknown; output?: unknown; isError?: boolean };
        const answer = { text: textOf(given.content ?? given.output) || out.join(""), isError: given.isError === true };
        results.set(callId, answer);
        return answer;
      },
    };
    return [host];
  });
}
