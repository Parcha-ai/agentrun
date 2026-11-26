import { isLocalModel, runModel } from "./models";
import type { Run, RunTrace, RunUsage, UsageLine } from "./v2";

// A completed free run's receipt: the one place the run's reads (GET /v2/runs/{id}, /usage, /trace) become the facts a
// receipt card shows, and the rule for when there is one. components/Receipt.tsx renders them; any renderer that takes
// ReceiptFacts can replace it.

/** Why a run cost $0: every request on this machine's Ollama (`local`), every one on a free catalog model (`free_model`),
 *  or some of each. */
export type FreeReason = "local" | "free_model" | "local_and_free_model";

/** What a receipt says of a run. `wall_s`: from its creation to its end. `cost.free_words`: the reason in the console's
 *  words. `model`: the one most of its requests went to, as the server booked it (`qwen3:8b` from `ollama`). `tools`:
 *  each tool's calls, one entry per thing they went through (`via` on web_fetch's result, `provider` on web_search's),
 *  and one without `via` for the calls whose result does not say, in the order first called. */
export type ReceiptFacts = {
  run_id: string;
  agent_name: string;
  finished_at: string;
  wall_s: number;
  cost: { usd: number; basis: "known"; free: true; free_reason: FreeReason; free_words: string };
  model: { id: string; provider: string; local: boolean };
  requests: number;
  tokens: { input: number; output: number };
  tools: { name: string; calls: number; via?: string }[];
  /** The trace rows past its cap (RunTrace `dropped`), present only when there are some: `tools` counts the calls in
   *  the trace's first rows only, so each count is a floor and the receipt says so. */
  tools_uncounted?: number;
};

/** Whether a run has a receipt: it completed, its cost is known to be $0, and the server says that is because every
 *  model request went to a free model (`cost.free`). A receipt is shared, so a failed or cancelled run has none, nor
 *  does an unknown cost (`usd: null`) or a paid one. */
export function showsReceipt(run: Pick<Run, "status" | "cost">): boolean {
  return run.status === "completed" && run.cost?.usd === 0 && run.cost.free === true;
}

/** What a tool call went through, read from its result's head (the trace's `result_preview`): its top-level `via`
 *  (web_fetch) or `provider` (web_search). A head cut before the field says none. */
function viaOf(preview: string | null): string | undefined {
  if (!preview) return undefined;
  try {
    const body = JSON.parse(preview) as Record<string, unknown>;
    const via = body?.via ?? body?.provider;
    return typeof via === "string" ? via : undefined;
  } catch {
    // A head cut short is no whole JSON: the field is read where it stands unescaped (never inside a quoted page text).
    return /(?<!\\)"(?:via|provider)":"([^"\\]+)"/.exec(preview)?.[1];
  }
}

/** The reason's words. `freeRequests`: the server's limit on a run's free-model requests (capabilities'
 *  `limits.free_model_requests`), said where a free catalog model ran; a local model's requests count toward none. */
function freeWords(reason: FreeReason, freeRequests: number | undefined): string {
  // Not "on your machine": OLLAMA_HOST may put the server's Ollama on another one, which a run's reads do not say.
  const local = "local model (Ollama)";
  const free = typeof freeRequests === "number" ? `free model, up to ${freeRequests} requests a run` : "free model";
  return reason === "local" ? local : reason === "free_model" ? free : `${local} and ${free}`;
}

/** Whether a run's usage says it cost nothing at all: a usage total of exactly $0, and every line at exactly $0 with
 *  nothing left out of it. `cost.free` speaks of model requests only, so a run that also used computer or browser time,
 *  or tool calls, that nothing priced or booked is no free run: a line with no figure (`usd` null, `basis` unpriced:
 *  computer time no price was set for, or a paid computer's time no claim booked), MCP calls no price meters
 *  (`not_metered_calls`), or model requests none meters (`unmetered_requests`), or computer time no claim held
 *  (`unheld_quantity`; the server reads it 0 for a computer that bills nothing, Docker, whose time is $0 held or not). */
export function usageAllFree(usage: Pick<RunUsage, "lines" | "total"> | undefined): boolean {
  if (!usage || usage.total?.usd !== 0 || (usage.total.unpriced ?? 0) > 0) return false;
  return (usage.lines ?? []).every((line: UsageLine) => line.usd === 0 && line.basis !== "unpriced" && !(line.unpriced ?? 0)
    && !(line.not_metered_calls ?? 0) && !(line.unmetered_requests ?? 0) && !(line.unheld_quantity ?? 0));
}

/** The receipt's facts from the run, its usage (the model, its requests and tokens, every attempt's line summed) and its
 *  trace (the tool calls; a trace cut at its cap carries how many rows it left out, `tools_uncounted`). Null for a run with no receipt (showsReceipt), for one whose usage says
 *  anything it used was unpriced, unbooked or above $0 (usageAllFree), and for one whose usage names no model: a receipt
 *  never guesses one. */
export function receiptFacts(run: Run, agentName: string, usage: Pick<RunUsage, "lines" | "total"> | undefined, trace: Pick<RunTrace, "spans"> & Partial<Pick<RunTrace, "dropped">> | undefined, freeRequests?: number): ReceiptFacts | null {
  if (!showsReceipt(run) || !run.ended_at || !usageAllFree(usage)) return null;
  const top = runModel(usage);
  if (!top) return null;
  let requests = 0, input = 0, output = 0, local = false, catalog = false;
  for (const line of usage?.lines ?? []) {
    if (line.meter !== "tokens" || !line.model) continue;
    requests += line.requests ?? 0;
    input += line.tokens?.input ?? 0;
    output += line.tokens?.output ?? 0;
    if (line.provider && isLocalModel(`${line.provider}/${line.model}`)) local = true; else catalog = true;
  }
  const reason: FreeReason = local && catalog ? "local_and_free_model" : local ? "local" : "free_model";
  const slash = top.indexOf("/");
  const tools: ReceiptFacts["tools"] = [];
  for (const span of trace?.spans ?? []) {
    if (span.kind !== "tool") continue;
    const via = viaOf(span.result_preview);
    const entry = tools.find((t) => t.name === span.name && t.via === via);
    if (entry) entry.calls += 1;
    else tools.push({ name: span.name, calls: 1, ...(via ? { via } : {}) });
  }
  return {
    run_id: run.run_id, agent_name: agentName, finished_at: run.ended_at,
    wall_s: Math.max(0, (Date.parse(run.ended_at) - Date.parse(run.created_at)) / 1000),
    cost: { usd: 0, basis: "known", free: true, free_reason: reason, free_words: freeWords(reason, freeRequests) },
    model: { id: slash > 0 ? top.slice(slash + 1) : top, provider: slash > 0 ? top.slice(0, slash) : "", local: isLocalModel(top) },
    requests, tokens: { input, output }, tools,
    ...(trace?.dropped ? { tools_uncounted: trace.dropped } : {}),
  };
}
