// The host tools of a run on a harness other than pi: its coding tools, from the run's coding source (coding-tools.ts:
// pi's own read, write and edit on the run's environment, or in a box those and bash on the box's), so their arguments,
// their confinement and their refusals are pi's, word for word, pi's web_fetch (also under its legacy name,
// fetch_page), the public-host guard included, web_search, and monid's three (monid.ts), which stay on this machine.
// pi's tools take only the environment, their output and their diagnostics from a call's API, and a paid one its call's
// id and the run's store, so that is all a call here gives them: the output's tail or head as the tool keeps it (pi's
// limits), then the diagnostics, also when the tool failed. read, the web tools, monid.discover and monid.inspect may
// run again after a crash; write, edit, bash and monid.run never: the kernel records each one's intent before it runs,
// and a call a crash cut off is answered interrupted, not run again. A tool is named by its catalog name here and goes
// to the harness under its wire name (catalog.ts: `monid.run` is `monid_run`), which the harness calls and journals. A
// refusal, an error and a write's or edit's result name a path in the workspace relative to it (`hello.md`), never by
// the server's data directory (`workspaceRelative`); in a box they name the box's paths. Each call passes the run's tool
// gate first (tool-gate.ts): a denied call is refused, an asked one parked, and the harness is told so it ends the turn.
import { StringDecoder } from "node:string_decoder";
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import type { HostTool } from "@parcha/agentrun-kernel";
import type { DurableRun } from "@parcha/pi-durable-disk";
import { wireName } from "./catalog.js";
import { BOXED_TOOLS, CodingTools } from "./coding-tools.js";
import { FETCH_PAGE_TOOL } from "./fetch-page.js";
import { monidTools } from "./monid.js";
import { booking } from "./paid-calls.js";
import { withSecrets } from "./secrets.js";
import { WEB_FETCH_TOOL, webFetchTool } from "./web-fetch.js";
import { WEB_SEARCH_TOOL, webSearchTool } from "./web-search.js";
import { realOf, workspaceRelative } from "./workspace-paths.js";
import type { Park, RunGate } from "./tool-gate.js";

export { workspaceRelative } from "./workspace-paths.js";

/** Each tool a harness other than pi runs here, by catalog name, and whether a call a crash cut off may run again. */
export const REPLAY: Record<string, "safe" | "never"> = { read: "safe", write: "never", edit: "never", bash: "never", [FETCH_PAGE_TOOL]: "safe", [WEB_FETCH_TOOL]: "safe", [WEB_SEARCH_TOOL]: "safe", "monid.discover": "safe", "monid.inspect": "safe", "monid.run": "never" };

/** pi's limits on a tool's output (its DEFAULT_MAX_BYTES and DEFAULT_MAX_LINES), unless the tool names its own: read's
 *  head and bash's tail are held to them (the host-bounds test reads pi's own words for them). */
export const MAX_BYTES = 50 * 1024;
export const MAX_LINES = 2000;

/** Whether `byte` continues a UTF-8 character (0b10xxxxxx), so a cut before it would split one. */
const continues = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

/** `bytes` (UTF-8) cut to at most `max` bytes, its tail or its head, at a character boundary: a character the limit
 *  would split is left out whole, so the text never ends or starts in a U+FFFD. */
export function cutUtf8(bytes: Uint8Array, max: number, tail: boolean): Uint8Array {
  if (bytes.length <= max) return bytes;
  if (tail) {
    let start = bytes.length - max;
    while (continues(bytes[start])) start++;
    return bytes.subarray(start);
  }
  // The byte at `end` is the first one left out: while it continues a character, that character goes too.
  let end = max;
  while (end > 0 && continues(bytes[end])) end--;
  return bytes.subarray(0, end);
}

/** A call's output, held within the tool's limits as it arrives: its tail (bash's) or its head. */
function bounded(limits: ToolRegistration["outputLimits"]) {
  const maxBytes = limits?.maxBytes ?? MAX_BYTES;
  const maxLines = limits?.maxLines ?? MAX_LINES;
  const tail = limits?.retain === "tail";
  // Bytes are decoded as one stream: a character whose bytes arrive in two chunks is one character.
  const decoder = new StringDecoder("utf8");
  let kept = "";
  let cut = false;
  const trim = (text: string): string => {
    const lines = text.split("\n");
    let out = lines.length > maxLines ? (tail ? lines.slice(-maxLines) : lines.slice(0, maxLines)).join("\n") : text;
    const bytes = Buffer.from(out, "utf8");
    if (bytes.length > maxBytes) out = Buffer.from(cutUtf8(bytes, maxBytes, tail)).toString("utf8");
    if (out !== text) cut = true;
    return out;
  };
  return {
    push(chunk: string | Uint8Array) {
      const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
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

/** The tools whose result is pi's own words about a path (`Successfully wrote to <path>`), never a file's text. */
const SAYS_PATH = new Set(["write", "edit"]);


const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "")).join("") : "";


/** The host tools `names` names, on the run's coding source `coding`. `gated`: the run's tool gate, which every call
 *  passes, and the park it takes (harness-app.ts), told of a call it parked, whose turn the harness ends; none (the
 *  gate's own run of an approved call), each call runs as asked. */
export function hostTools(run: DurableRun, names: readonly string[], context: Context, results: ToolResults, coding: readonly ToolRegistration[] = CodingTools.tools ?? [], gated?: { gate: RunGate; park: Park }): HostTool[] {
  // The coding source gives the coding tools and nothing else: the network tools are this machine's own, below.
  const stray = coding.map((tool) => tool.name).filter((name) => !BOXED_TOOLS.includes(name));
  if (stray.length) throw new Error(`the coding source holds ${stray.join(", ")}, which is no coding tool`);
  // Their paid requests (Parallel's) are booked under the call, in the run's store, as pi's are (paid-calls.ts).
  const web = [webFetchTool(process.env), webFetchTool(process.env, FETCH_PAGE_TOOL), webSearchTool(process.env)].map(booking) as unknown as ToolRegistration[];
  // monid's, only for a run that names one: its key is the one this process was handed over its pipe (secrets.ts),
  // never in its environment, and its long answers go in the run's work/, the claim's as pi's (`where.work`), read at
  // the call. They are outside the coding source, which holds the coding tools only.
  const monid = names.some((name) => name.startsWith("monid.")) ? monidTools(withSecrets(process.env), () => run.claim.work) : [];
  const tools = new Map([...coding, ...web, ...monid].map((tool) => [tool.name, tool as ToolRegistration] as const));
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
        const refused = await gated?.gate.enter(name, args, callId, gated.park);
        if (refused) {
          const answer = { text: refused.text, isError: refused.isError };
          results.set(callId, answer);
          return answer;
        }
        const out = bounded(tool.outputLimits);
        const notes: string[] = [];
        const env = await run.env({ conversationId: ROOT_CONVERSATION_ID, read: undefined as never }, context);
        // The call's id and the run's store, as pi's: a paid call marks and books its charge there (monid.ts).
        const api = { env, callId, commit: (change: never, at: Context) => run.harness.commit(change, at), output: (chunk: string | Uint8Array) => out.push(chunk), outputWindow: undefined, retainedOutput: () => out.retained(), diagnostic: (note: { message: string }) => void notes.push(note.message) };
        // A tool that throws (bash on a non-zero exit or a timeout) still answers with its output, as pi's harness does;
        // monid's answer a failure as an error result, which is kept as it is.
        const result = await tool.execute(args as never, api as never, withAbortSignal(signal, context)).catch((error: Error) => ({ failed: error.message, isError: true }));
        // pi 1.1 names the result's blocks `content`, pi 1.2 and later `output`; pi 1.2's bash answers its exit as a
        // result's diagnostic, where 1.1 threw it.
        const given = result as unknown as { content?: unknown; output?: unknown; isError?: boolean; failed?: string; diagnostics?: readonly { message: string }[] };
        const said = [textOf(given.content ?? given.output) || out.text(), given.failed, ...notes, ...(given.diagnostics ?? []).map((note) => note.message)].filter((part) => part).join("\n\n");
        const isError = given.isError === true;
        const work = (env as { cwd?: unknown }).cwd;
        const works = typeof work === "string" ? [work, realOf(work)] : [];
        const answer = { text: isError || SAYS_PATH.has(name) ? workspaceRelative(said, works) : said, isError };
        results.set(callId, answer);
        return answer;
      },
    };
    return [host];
  });
}
