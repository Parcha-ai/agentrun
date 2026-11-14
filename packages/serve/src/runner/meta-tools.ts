// Three host tools over the run's own tools, on every harness: tools_search finds the run's tools by what they do,
// tools_call calls one by name, and codemode runs a script that calls them (not on Codex, which keeps its own code mode).
//
// None of them is a door around the gate. Each call they make is a call of its own nested in theirs (NestedCalls, which
// each harness gives a tool that `nests`): asked about at the gate as the tool it calls, by that tool's name, its intent
// and outcome recorded under `<callId>/<key>`, its paid requests booked under that id as a call the model made would be.
// A call the record finished answers from the record and never runs twice, across a park, a resume or a crash: a rerun
// of the calling tool replays them.
//
// A script follows Codex's rule for an ask inside it: the nested call the gate parks parks the run; once a person
// answers, the script runs again from its start, its recorded calls answered from their records, the parked call runs
// once (or is refused), its outcome is the script's output, and the rest of the script does not run. A refusal of any
// nested call ends the script with the refusal's words. The script sees the tools and the answers its calls get, nothing
// else of the run: no environment, no key, no file.
import { randomBytes } from "node:crypto";
import { CodemodeSandbox, type CodemodeHostCall, type CodemodeOutcome, type CodemodeOutputItem, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import type { HostTool, JsonValue, NestedCalls, NestedResult, ToolImage } from "@parcha/agentrun-kernel";

import { CODEMODE, META_TOOLS, TOOLS_CALL, TOOLS_SEARCH } from "../meta-tool-names.js";

export { CODEMODE, META_TOOLS, TOOLS_CALL, TOOLS_SEARCH };

/** How many tools a search answers with when its call names no limit, and the most it may name. */
export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 25;
/** A script's whole run, its nested calls' time included, and the memory its VM may take. */
export const CODEMODE_MS = 600_000;
const CODEMODE_MEMORY_BYTES = 256 * 1024 * 1024;

type SearchDocument = { readonly name: string; readonly text: string };
type Rank = (query: string, documents: readonly SearchDocument[], limit: number) => string[];
/** pi-durable's BM25 ranking (its tool_search's and code mode's searchTools'), the same file its own tools rank with: the
 *  package exports its tools but not the ranker, so it is read from beside the package's entry. */
const rankDocuments: Rank = ((await import(new URL("./search.js", import.meta.resolve("@earendil-works/pi-durable")).href)) as { rankDocuments: Rank }).rankDocuments;

/** A tool as a search answers it: its name, what it does and its input's schema. */
export interface FoundTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** The words of a tool's schema a search reads beside its description: its arguments' names and their descriptions. */
function schemaWords(schema: Record<string, unknown>): string {
  const properties = (schema.properties ?? {}) as Record<string, { description?: unknown }>;
  return Object.entries(properties).map(([name, property]) => `${name} ${typeof property?.description === "string" ? property.description : ""}`).join(" ");
}

/** The tools of `tools` (the run's own, none of the three here) whose names `granted` holds, ranked for `query`. */
export async function searchTools(query: string, tools: readonly HostTool[], granted: (name: string) => Promise<boolean>, limit = SEARCH_DEFAULT_LIMIT): Promise<FoundTool[]> {
  const searched: HostTool[] = [];
  for (const tool of tools) if (!META_TOOLS.has(tool.name) && (await granted(tool.name))) searched.push(tool);
  const byName = new Map(searched.map((tool) => [tool.name, tool]));
  const names = rankDocuments(query, searched.map((tool) => ({ name: tool.name, text: `${tool.description} ${schemaWords(tool.inputSchema)}` })), limit);
  return names.flatMap((name) => {
    const tool = byName.get(name);
    return tool ? [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }] : [];
  });
}

/** The run's tool a model's name for it names: its own name, or one a harness gives it on its tool channel (claude-agent's
 *  `mcp__hands__<name>`, OpenCode's `hands_<name>`, Codex's `mcp_<server>__<tool>` for an MCP tool). */
export function toolNamed(name: string, tools: readonly HostTool[]): HostTool | undefined {
  const candidates = [name, name.replace(/^mcp__hands__/, ""), name.replace(/^hands_/, ""), name.replace(/^mcp_(?!_)/, "mcp__")];
  for (const candidate of candidates) {
    const tool = tools.find((one) => one.name === candidate);
    if (tool) return tool;
  }
  return undefined;
}

/** Why `name` can't be called through tools_call or a script, or undefined: one of the three, or no tool of this run. */
export function refusedName(caller: string, name: string, tools: readonly HostTool[]): string | undefined {
  const own = name.replace(/^mcp__hands__/, "").replace(/^hands_/, "");
  if (META_TOOLS.has(own)) return `${caller} can't call ${own}: ${TOOLS_SEARCH}, ${TOOLS_CALL} and ${CODEMODE} are called by the model itself, never through each other. Nothing was run.`;
  if (!toolNamed(name, tools)) return `${caller} can't call ${JSON.stringify(name).slice(0, 120)}: this run has no tool by that name. Find the run's tools with ${TOOLS_SEARCH}. Nothing was run.`;
  return undefined;
}

const NO_NESTED = (caller: string) => `${caller} can't run here: this harness gives it no way to call the run's tools. Nothing was run.`;

/** A nested answer as a tool's answer. */
const answered = (result: NestedResult) => ({ text: result.text, ...(result.isError ? { isError: true } : {}), ...(result.images?.length ? { images: result.images } : {}), ...(result.structured !== undefined ? { structured: result.structured } : {}) });

export interface MetaToolsOptions {
  /** The run's tools as the session gives them, the three left out (each call reads them now). */
  tools: () => readonly HostTool[];
  /** Whether a tool is granted to search: its setting is not deny. */
  granted: (name: string) => Promise<boolean>;
  /** Whether to offer codemode (every harness but Codex, which keeps its own). */
  codemode: boolean;
}

/** The three tools for a session: each `nests` (but the search, which calls nothing). */
export function metaTools(options: MetaToolsOptions): HostTool[] {
  const own = () => options.tools().filter((tool) => !META_TOOLS.has(tool.name));
  const search: HostTool = {
    name: TOOLS_SEARCH,
    description: `Search this run's tools by what they do, and get each match's name, description and input schema, best match first. Call a match with ${TOOLS_CALL}${options.codemode ? `, or from a ${CODEMODE} script` : ""}.`,
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What the tool should do, in a few words, or its name." }, limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX_LIMIT, description: `How many tools to answer with (default ${SEARCH_DEFAULT_LIMIT}).` } }, required: ["query"], additionalProperties: false },
    replay: "safe",
    call: async (args) => {
      const { query, limit } = (args ?? {}) as { query?: unknown; limit?: unknown };
      if (typeof query !== "string" || query.trim() === "") return { text: `${TOOLS_SEARCH} needs a query: what the tool should do.`, isError: true };
      const most = typeof limit === "number" && Number.isInteger(limit) ? Math.min(Math.max(limit, 1), SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
      const found = await searchTools(query, own(), options.granted, most);
      return { text: found.length ? JSON.stringify(found) : `No tool of this run matches ${JSON.stringify(query)}.`, structured: found as unknown as JsonValue };
    },
  };
  const call: HostTool = {
    name: TOOLS_CALL,
    description: `Call one of this run's tools by its name (as ${TOOLS_SEARCH} gives it) with its arguments. The call is asked about and recorded as that tool's own: a tool that needs a person's approval waits for it.`,
    inputSchema: { type: "object", properties: { name: { type: "string", description: "The tool's name." }, args: { type: "object", description: "The tool's arguments, as its input schema says.", additionalProperties: true } }, required: ["name"], additionalProperties: false },
    replay: "safe",
    nests: true,
    call: async (args, context) => {
      const { name, args: given } = (args ?? {}) as { name?: unknown; args?: unknown };
      if (typeof name !== "string" || name === "") return { text: `${TOOLS_CALL} needs the name of the tool to call.`, isError: true };
      if (given !== undefined && (given === null || typeof given !== "object" || Array.isArray(given))) return { text: `${TOOLS_CALL}'s args must be an object of the tool's arguments.`, isError: true };
      const tools = own();
      const refused = refusedName(TOOLS_CALL, name, tools);
      if (refused) return { text: refused, isError: true };
      if (!context.nested) return { text: NO_NESTED(TOOLS_CALL), isError: true };
      return answered(await context.nested.call(toolNamed(name, tools)!.name, (given ?? {}) as Record<string, unknown>, "call"));
    },
  };
  const codemode: HostTool = {
    name: CODEMODE,
    description: [
      `Run a JavaScript script (the body of an async function: top-level await and return work) that calls this run's tools as \`await tools.<name>(args)\`; find them with ${TOOLS_SEARCH}, and \`ALL_TOOLS\` lists them. A call answers its value, and a call that fails throws.`,
      "The script's text(...) and console output, and its returned value, are the answer. It has no timers, network or files of its own: only the tools.",
      "Each call is asked about and recorded as that tool's own. A call that needs a person's approval stops the script: once they answer, that call runs (or is refused), its outcome is the answer, and the rest of the script does not run. A refused call ends the script with the refusal.",
    ].join(" "),
    inputSchema: { type: "object", properties: { script: { type: "string", description: "The script: the body of an async function." } }, required: ["script"], additionalProperties: false },
    replay: "safe",
    nests: true,
    call: async (args, context) => {
      const { script } = (args ?? {}) as { script?: unknown };
      if (typeof script !== "string" || script.trim() === "") return { text: `${CODEMODE} needs a script: the body of an async function.`, isError: true };
      if (!context.nested) return { text: NO_NESTED(CODEMODE), isError: true };
      return runScript(script, own(), context.nested, context.signal);
    },
  };
  return options.codemode ? [search, call, codemode] : [search, call];
}

/** One nested call's line in a script's stopped answer, as Codex's code mode words its recovered calls. */
function lineOf(index: number, name: string, result: NestedResult): string {
  const said = JSON.stringify(result.text.length > 2_000 ? `${result.text.slice(0, 2_000)}…` : result.text);
  const label = `${index}. ${name}`;
  if (result.refused) return `${label} was refused: ${said}. It did not run.`;
  if (result.interrupted) return `${label} was started and did not report a result, so it may have taken effect: check before calling it again. It was not run again.`;
  if (result.isError) return `${label} failed: ${said}. It was not run again.`;
  return `${label} completed: ${said}. Its effect is done; it was not run again.`;
}

/** The script's output and value, as the model reads them, and the images it showed. */
function shownOf(output: readonly CodemodeOutputItem[], value: unknown): { text: string; images: ToolImage[] } {
  const words: string[] = [];
  const images: ToolImage[] = [];
  for (const item of output) {
    if (item.type === "text") words.push(item.text);
    else images.push({ data: item.data, mimeType: item.mimeType });
  }
  if (value !== undefined) words.push(typeof value === "string" ? value : JSON.stringify(value));
  return { text: words.join("\n"), images };
}

/**
 * Run `script` deterministically (pi-codemode's `start`: its clock, its randomness and its tools fixed by the call's first
 * run, memoized), each of its tool calls a nested call, answered one at a time in the order the script made them. A rerun
 * of the call (after a park or a crash) makes the same calls: the recorded ones are answered from their records, and the
 * first one that runs now ends the script with its outcome (Codex's rule), as does any refusal or interrupted call.
 */
async function runScript(script: string, tools: readonly HostTool[], nested: NestedCalls, signal: AbortSignal): Promise<{ text: string; isError?: boolean; images?: readonly ToolImage[]; structured?: JsonValue }> {
  const nonce = randomBytes(8).toString("hex");
  const first = await nested.memo("start", { startedAt: Date.now(), seed: randomBytes(4).readUInt32BE(0), nonce, tools: tools.map((tool) => [tool.name, toCodemodeIdentifier(tool.name)]) } as unknown as JsonValue);
  const start = first as unknown as { startedAt: number; seed: number; nonce: string; tools: [string, string][] };
  const rerun = start.nonce !== nonce;
  const declared = new Map(tools.map((tool) => [tool.name, tool]));
  const stop = new AbortController();
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: CODEMODE_MEMORY_BYTES });
  const calls: CodemodeHostCall[] = [];
  const told: { name: string; result: NestedResult }[] = [];
  let ended: { text: string; isError: boolean; images?: readonly ToolImage[] } | undefined;
  let failed: unknown;
  let wake: () => void = () => {};
  try {
    const run = sandbox.start(script, {
      startedAt: start.startedAt,
      seed: start.seed,
      // The tools the first run declared, by the names it gave them, that this run still has.
      tools: start.tools.filter(([name]) => declared.has(name)).map(([name, jsName]) => ({ name, jsName, description: declared.get(name)!.description })),
      signal: AbortSignal.any([signal, stop.signal]),
      timeoutMs: CODEMODE_MS,
      onCall: (call) => {
        calls.push(call);
        wake();
      },
    });
    // The calls answered one at a time, in the order the script made them: the same order, and the same keys, in a rerun.
    let seq = 0;
    const answering = (async () => {
      while (!run.finished && !ended) {
        const call = calls.shift();
        if (!call) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            void run.result.then(() => resolve(), () => resolve());
          });
          continue;
        }
        const tool = toolNamed(call.name, tools);
        const refused = call.target !== "tool" ? `${call.name} is no tool of this run.` : refusedName(CODEMODE, call.name, tools);
        const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? (call.args as Record<string, unknown>) : {};
        const result: NestedResult = refused || !tool ? { text: refused ?? `${call.name} is no tool of this run.`, isError: true, refused: true, fresh: true } : await nested.call(tool.name, args, `s${call.id}`);
        told.push({ name: tool?.name ?? call.name, result });
        // A refusal, a call cut by a crash, or (in a rerun) the first call that ran now: the script ends with it.
        if (result.refused || result.interrupted || (rerun && result.fresh)) {
          ended = endedWith(told, result, rerun && result.fresh && !result.refused);
          stop.abort();
          break;
        }
        seq += 1;
        const outcome: CodemodeOutcome = result.isError ? { ok: false, message: result.text } : { ok: true, value: scriptValue(result) };
        if (!run.finished) run.deliver(seq, start.startedAt, call.id, outcome);
      }
    })().catch((error: unknown) => {
      failed = error;
      stop.abort();
    });
    const result = await run.result;
    await answering;
    // A nested call that parked (the session let go) or a drive that halted: the call has no answer here.
    if (failed !== undefined) throw failed;
    if (signal.aborted) throw signal.reason ?? new Error(`${CODEMODE} was stopped`);
    if (ended) return ended;
    const shown = shownOf(result.output, result.ok ? result.value : undefined);
    if (!result.ok) {
      const why = result.error.kind === "timeout" ? `the script ran past ${CODEMODE_MS} ms: ${result.error.message}` : result.error.message;
      return { text: [shown.text, `The script failed: ${why}`].filter(Boolean).join("\n"), isError: true, ...(shown.images.length ? { images: shown.images } : {}) };
    }
    return { text: shown.text || "(the script returned nothing and showed nothing)", ...(shown.images.length ? { images: shown.images } : {}), ...(result.value !== undefined ? { structured: result.value as JsonValue } : {}) };
  } finally {
    await sandbox.close();
  }
}

/** A nested call's value in a script: its structured value (an MCP result's structuredContent) when it has one; else, when
 *  its answer is one text part (no image beside it) whose text parses as a JSON object or array, that value (a Composio
 *  answer comes as one); else its text. The text the model reads of the call is its text either way. */
function scriptValue(result: NestedResult): unknown {
  if (result.structured !== undefined) return result.structured;
  const text = result.text.trim();
  if (result.images?.length || !(text.startsWith("{") || text.startsWith("["))) return result.text;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? value : result.text;
  } catch {
    return result.text;
  }
}

/** The answer of a script that ended at `last`: a refusal's words, or (`ranNow`: the first call that ran on the script's
 *  rerun, after a person's answer or a crash) that call's outcome, with every call before it as recorded. */
function endedWith(told: readonly { name: string; result: NestedResult }[], last: NestedResult, ranNow: boolean): { text: string; isError: boolean; images?: readonly ToolImage[] } {
  const lines = told.map(({ name, result }, i) => lineOf(i + 1, name, result));
  if (last.refused) return { text: `${last.text}\nThe script stopped at this refused call, and nothing after it ran. Its calls, in order:\n${lines.join("\n")}`, isError: true };
  if (!ranNow) return { text: `The script stopped at a call cut off before it reported a result, and nothing after it ran. Its calls, in order:\n${lines.join("\n")}`, isError: true };
  const head = `The script was stopped (it waited for a person's answer, or the session stopped), and run again only as far as its next call, which ran once: ${last.isError ? "it failed" : "its outcome is below"}. The rest of the script did not run; run what is still needed again.`;
  return { text: `${head}\nIts calls, in order:\n${lines.join("\n")}`, isError: Boolean(last.isError), ...(last.images?.length ? { images: last.images } : {}) };
}
