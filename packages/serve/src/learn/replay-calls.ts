// What a replay run's learned workflow does at each call node (SPEC B4: "re-run the draft offline on recorded inputs/
// outputs where possible, else live at workflow cost"; runner/promotion.ts starts the replay runs). Every tool is a read
// or a write (toolClassOf): an MCP tool by its server's own annotations (readOnlyHint true and not destructiveHint: read),
// a built-in by the fixed list READ_TOOLS, anything else a write.
//   - A read runs live through a cache keyed by (tool, canonical args), seeded from the graded run's recorded calls: a
//     hit, recorded or already run in this replay, costs nothing and is never sent again.
//   - A write is NEVER run in a replay: it is answered from the graded run's recording when a call there has the same
//     tool and canonical args (its answer, an error included), else the replay of that input stops there and is skipped
//     (SKIPPED_WRITE): no evidence either way, never scored wrong or failed (learn/promote.ts scoredRows).
// The recording is the graded run's own journal (a CLI's record shaped as pi's), each tool call by the wire name the
// harness called it by (catalog.ts wireName): a call node names its tool by catalog name, matched through the same map.
// Prior art: MCP's tool annotations (readOnlyHint, destructiveHint, 2025-03-26 spec) for the read/write line; VCR-style
// record/replay of HTTP interactions (Ruby's VCR, Python's vcrpy: a cassette answers a request that matches one recorded,
// a new one is refused in "none" record mode) for answering writes from the recording and refusing the rest.
import { wireName } from "../catalog.js";
import { LLM_TOOL } from "../llm.js";
import { PDF_PAGES_TOOL } from "../pdf-pages.js";
import { WEB_FETCH_TOOL } from "../web-fetch.js";
import { WEB_SEARCH_TOOL } from "../web-search.js";
import { CALL_REFUSED } from "../timeline/timeline.js";

/** The built-in tools a call node may run that read only: they change nothing outside the run (a web page or search read,
 *  a document's pages drawn into the run's own work/, one model completion). Every other built-in is a write. */
export const READ_TOOLS: readonly string[] = [WEB_FETCH_TOOL, WEB_SEARCH_TOOL, PDF_PAGES_TOOL, LLM_TOOL];

/** Why a replayed input is skipped, word for word: what a PromotionRecord's reason and the replay's row say. */
export const SKIPPED_WRITE = "needs a write the recording doesn't have";

export type ToolClass = "read" | "write";

/** An MCP tool's catalog name, `mcp:<server>/<tool>`. */
const MCP_TOOL = /^mcp:([^/]+)\/(.+)$/;

/** Whether `tool` (a catalog name) reads or writes: an MCP tool by `annotations` (its server's listing as the run's pin
 *  holds it): read only when readOnlyHint is true and destructiveHint is not; a built-in by READ_TOOLS; else write. */
export function toolClassOf(tool: string, annotations?: (tool: string) => Readonly<Record<string, unknown>> | undefined): ToolClass {
  if (MCP_TOOL.test(tool)) {
    const said = annotations?.(tool);
    return said?.readOnlyHint === true && said.destructiveHint !== true ? "read" : "write";
  }
  return READ_TOOLS.includes(tool) ? "read" : "write";
}

/** `value` as JSON with every object's keys sorted, at every depth: two argument objects that differ only in key order
 *  read the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((one) => canonical(one === undefined ? null : one)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A call's key: the tool's wire name (a catalog name or a wire name alike) and its canonical arguments. */
export const callKey = (tool: string, args: unknown): string => `${wireName(tool)}\n${canonical(args ?? {})}`;

/** One recorded call's answer: its text, the structured details pi kept beside it (a built-in's whole value), and whether
 *  it ended an error. */
export type Recorded = { readonly text: string; readonly details?: unknown; readonly isError: boolean };

type EntryLike = { readonly kind: string; readonly model?: readonly unknown[] };

/** A tool result's text: a string, or its text blocks joined. */
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part) => (typeof (part as { text?: unknown })?.text === "string" ? [(part as { text: string }).text] : [])).join("\n\n") : "";

/** The calls a run's journal recorded (`entries`, pi-shaped: store-reads/journal.ts piShaped for a CLI's record), by
 *  callKey: each call's answer, the first one when a run made the same call twice. A call refused before it ran (its
 *  gate's deny) recorded no answer and is left out. */
export function recordedCalls(entries: readonly EntryLike[]): Map<string, Recorded> {
  const asked = new Map<string, { name: string; args: unknown }>();
  const out = new Map<string, Recorded>();
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      const one = (message ?? {}) as { content?: unknown; toolCallId?: unknown; isError?: unknown; details?: unknown };
      if (entry.kind === "pi.assistant" && Array.isArray(one.content)) {
        for (const part of one.content) {
          const call = (part ?? {}) as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
          if (call.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string") asked.set(call.id, { name: call.name, args: call.arguments ?? {} });
        }
      }
      if (entry.kind !== "pi.tool-result" || typeof one.toolCallId !== "string") continue;
      const call = asked.get(one.toolCallId);
      const details = one.details as Record<string, unknown> | undefined;
      if (!call || details?.[CALL_REFUSED] === true) continue;
      const key = callKey(call.name, call.args);
      if (!out.has(key)) out.set(key, { text: textOf(one.content), ...(details !== undefined ? { details } : {}), isError: one.isError === true });
    }
  }
  return out;
}

/** A recorded answer as the value a call node of `tool` takes: an MCP tool's text as JSON when it parses, else `{ text }`
 *  (learned-workflow.ts mcpValue, as its live call gives it); a built-in's structured details, as its effect returns
 *  them, else none (its text is what a model read, not its value). */
const recordedValue = (tool: string, recorded: Recorded): { value: unknown } | undefined => {
  if (MCP_TOOL.test(tool)) {
    try {
      return { value: JSON.parse(recorded.text) };
    } catch {
      return { value: { text: recorded.text } };
    }
  }
  return recorded.details && typeof recorded.details === "object" ? { value: recorded.details } : undefined;
};

/** A replay's call nodes (learned-workflow.ts runLearned's `run.replay`): `call` runs each by the rules above. `skipped`:
 *  the write that stopped it, once one did; `stop` aborts the workflow's run there. `live`: how many reads ran live. */
export interface ReplayCalls {
  call(node: { readonly label: string; readonly tool: string }, args: unknown, live: () => Promise<unknown>): Promise<unknown>;
  readonly skipped: { readonly tool: string; readonly step: string } | undefined;
  readonly stop: AbortSignal;
  readonly live: number;
}

/** What a call node throws when its write has no recording: the replay of this input stops. */
export class ReplaySkipped extends Error {
  override name = "ReplaySkipped";
}

/** The replay's call nodes over `recorded` (recordedCalls of the graded run), each tool classed by `classOf`. */
export function replayCalls(recorded: ReadonlyMap<string, Recorded>, classOf: (tool: string) => ToolClass): ReplayCalls {
  const cache = new Map<string, Promise<unknown>>();
  const stop = new AbortController();
  let skipped: ReplayCalls["skipped"];
  let live = 0;
  return {
    get skipped() {
      return skipped;
    },
    stop: stop.signal,
    get live() {
      return live;
    },
    async call(node, args, run) {
      const key = callKey(node.tool, args);
      const said = recorded.get(key);
      if (classOf(node.tool) === "write") {
        // Never run: the recording's answer, or the input is skipped here.
        const value = said ? recordedValue(node.tool, said) : undefined;
        if (said && value) {
          if (said.isError) throw new Error(said.text);
          return value.value;
        }
        skipped ??= { tool: node.tool, step: node.label };
        stop.abort(new ReplaySkipped(`${node.tool} ${SKIPPED_WRITE}`));
        throw new ReplaySkipped(`call node "${node.label}": ${node.tool} ${SKIPPED_WRITE}`);
      }
      // A read: the recording's answer (an error there is run live instead), else this replay's own, else live once.
      const value = said && !said.isError ? recordedValue(node.tool, said) : undefined;
      if (value) return value.value;
      const known = cache.get(key);
      if (known) return known;
      live += 1;
      const running = run();
      cache.set(key, running);
      // A read that failed is not kept: the next call of it runs live again.
      running.catch(() => cache.delete(key));
      return running;
    },
  };
}
