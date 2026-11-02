// The host tools of a run on a harness other than pi: its coding tools, from the run's coding source (coding-tools.ts:
// pi's own read, write and edit on the run's environment, or in a box those and bash on the box's), so their arguments,
// their confinement and their refusals are pi's, word for word, and pi's fetch_page and web_fetch, the public-host guard
// included, which stay on this machine. pi's tools take only the environment, their output and their diagnostics from a
// call's API, so that is all a call here gives them: the output's tail or head as the tool keeps it (pi's limits), then
// the diagnostics, also when the tool failed. read, fetch_page and web_fetch may run again after a crash; write, edit and
// bash never: the kernel records each one's intent before it runs, and a call a crash cut off is answered interrupted,
// not run again.
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import type { HostTool } from "@parcha/agentrun-adapters";
import type { DurableRun } from "@parcha/pi-durable-disk";
import { BOXED_TOOLS, CodingTools } from "./coding-tools.js";
import { FETCH_PAGE_TOOL, fetchOptions, fetchPageTool } from "./fetch-page.js";
import { FAUX_ENV } from "./model.js";
import { WEB_FETCH_TOOL, webFetchTool } from "./web-fetch.js";

/** Each tool a harness other than pi runs here, and whether a call a crash cut off may run again. */
export const REPLAY: Record<string, "safe" | "never"> = { read: "safe", write: "never", edit: "never", bash: "never", [FETCH_PAGE_TOOL]: "safe", [WEB_FETCH_TOOL]: "safe" };

/** pi's limits on a tool's output (its DEFAULT_MAX_BYTES and DEFAULT_MAX_LINES), unless the tool names its own. */
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

/** A call's output, held within the tool's limits as it arrives: its tail (bash's) or its head. */
function bounded(limits: ToolRegistration["outputLimits"]) {
  const maxBytes = limits?.maxBytes ?? MAX_BYTES;
  const maxLines = limits?.maxLines ?? MAX_LINES;
  const tail = limits?.retain === "tail";
  let kept = "";
  let cut = false;
  const trim = (text: string): string => {
    const lines = text.split("\n");
    let out = lines.length > maxLines ? (tail ? lines.slice(-maxLines) : lines.slice(0, maxLines)).join("\n") : text;
    const bytes = Buffer.from(out, "utf8");
    if (bytes.length > maxBytes) out = (tail ? bytes.subarray(bytes.length - maxBytes) : bytes.subarray(0, maxBytes)).toString("utf8");
    if (out !== text) cut = true;
    return out;
  };
  return {
    push(chunk: string | Uint8Array) {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (!tail && cut) return;
      kept += text;
      // Trimmed once it is twice the limit, so a long output costs a bounded amount of memory and work.
      if (kept.length > 2 * maxBytes) kept = trim(kept);
    },
    /** What is kept so far, and whether any was cut: pi 1.2's `retainedOutput`. */
    retained: () => {
      const text = trim(kept);
      return { text, truncated: cut };
    },
    text(): string {
      const out = trim(kept);
      return cut ? (tail ? `[earlier output omitted]\n${out}` : `${out}\n[later output omitted]`) : out;
    },
  };
}

/** One call's result, kept by its call id for the run's timeline (an adapter's tool_end carries none). */
export type ToolResults = Map<string, { text: string; isError: boolean }>;

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "")).join("") : "";

export function hostTools(run: DurableRun, names: readonly string[], context: Context, results: ToolResults, coding: readonly ToolRegistration[] = CodingTools.tools ?? []): HostTool[] {
  // The coding source gives the coding tools and nothing else: the network tools are this machine's own, below.
  const stray = coding.map((tool) => tool.name).filter((name) => !BOXED_TOOLS.includes(name));
  if (stray.length) throw new Error(`the coding source holds ${stray.join(", ")}, which is no coding tool`);
  const fetchPage = fetchPageTool(() => fetchOptions(process.env, FAUX_ENV)) as unknown as ToolRegistration;
  const webFetch = webFetchTool(process.env) as unknown as ToolRegistration;
  const tools = new Map([...coding, fetchPage, webFetch].map((tool) => [tool.name, tool as ToolRegistration] as const));
  return names.flatMap((name) => {
    const tool = tools.get(name);
    const replay = REPLAY[name];
    if (!tool || !replay) return [];
    const host: HostTool = {
      name,
      description: tool.description,
      inputSchema: tool.parameters as unknown as Record<string, unknown>,
      replay,
      async call(args, { callId, signal }) {
        const out = bounded(tool.outputLimits);
        const notes: string[] = [];
        const env = await run.env({ conversationId: ROOT_CONVERSATION_ID, read: undefined as never }, context);
        const api = { env, output: (chunk: string | Uint8Array) => out.push(chunk), outputWindow: undefined, retainedOutput: () => out.retained(), diagnostic: (note: { message: string }) => void notes.push(note.message) };
        // A tool that throws (bash on a non-zero exit or a timeout) still answers with its output, as pi's harness does.
        const result = await tool.execute(args as never, api as never, withAbortSignal(signal, context)).catch((error: Error) => ({ failed: error.message, isError: true }));
        // pi 1.1 names the result's blocks `content`, pi 1.2 and later `output`; pi 1.2's bash answers its exit as a
        // result's diagnostic, where 1.1 threw it.
        const given = result as unknown as { content?: unknown; output?: unknown; isError?: boolean; failed?: string; diagnostics?: readonly { message: string }[] };
        const said = [textOf(given.content ?? given.output) || out.text(), given.failed, ...notes, ...(given.diagnostics ?? []).map((note) => note.message)].filter((part) => part).join("\n\n");
        const answer = { text: said, isError: given.isError === true };
        results.set(callId, answer);
        return answer;
      },
    };
    return [host];
  });
}
