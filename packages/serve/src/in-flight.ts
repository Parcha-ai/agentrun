// What a live run is waiting on now (GRE-4835): every request it has sent and not had back, from the moment it was sent,
// on every harness. A model request is its booking's record (the kernel's `runner.request`, written and stamped `at`
// before the request leaves) with no `runner.turn` yet: the booking writes both for pi and for every CLI harness, in each
// model session's conversation. A tool call (MCP, web, a subagent's, a sandbox command, one held for approval) is its
// Timeline `tool_use` row with no `tool_result` row yet. A timeline page carries the list beside its rows
// (run-reads-over-store.ts), so a run page shows "inkling-2-mini · 2:13" while a slow local model reads its prompt, where
// before nothing showed until the answer came back.
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import type { EntryLike, TimelineEvent } from "./timeline/index.js";

/** One request in flight. `name`: the model, by the id its request names (`inkling-2-mini`), or the tool. `started_at`: when it was sent (null for a model request a
 *  booking recorded before requests were stamped). `for_tool`: a tool's own model request (a web search's, a learned
 *  node's), which runs inside that call. `input_tokens_max`: the input a model request was admitted with, at most. */
export type InFlight = { kind: "model" | "tool"; name: string; started_at: string | null; tool_use_id?: string; for_tool?: string; input_tokens_max?: number };

const turnKey = (conversation: number | undefined, turn: number) => `${conversation ?? 0}:${turn}`;

/** The model requests a run's sessions sent and have not had answered: each `runner.request` with no `runner.turn` of its
 *  turn in its conversation. A paid tool's charge (`paid`, its model `paid:<tool>`) is no model request: its call's row
 *  says it. A decision's request (`decision:<model>`) is its model's. */
export function modelsInFlight(entries: readonly EntryLike[]): InFlight[] {
  const answered = new Set<string>();
  for (const e of entries) {
    const turn = e.kind === RUNNER_RECORDS.turn ? (e.data as { turn?: unknown } | undefined)?.turn : undefined;
    if (typeof turn === "number") answered.add(turnKey(e.conversationId, turn));
  }
  const out: InFlight[] = [];
  for (const e of entries) {
    if (e.kind !== RUNNER_RECORDS.request) continue;
    const d = (e.data ?? {}) as { turn?: unknown; model?: unknown; at?: unknown; inputTokensMax?: unknown; host?: unknown; paid?: unknown };
    if (typeof d.turn !== "number" || typeof d.model !== "string" || d.paid === true || d.model.startsWith("paid:")) continue;
    if (answered.has(turnKey(e.conversationId, d.turn))) continue;
    out.push({
      kind: "model", name: d.model.startsWith("decision:") ? d.model.slice("decision:".length) : d.model,
      started_at: typeof d.at === "string" ? d.at : null,
      ...(typeof d.host === "string" && d.host ? { for_tool: d.host } : {}),
      ...(typeof d.inputTokensMax === "number" && Number.isFinite(d.inputTokensMax) ? { input_tokens_max: d.inputTokensMax } : {}),
    });
  }
  return out;
}

/** The tool calls a run made and has not had back: each `tool_use` row with no `tool_result` row of its id in its
 *  conversation. A call's id is its session's own (an ACP agent may number its calls from 1), so two sessions' calls can
 *  share one. */
export function toolsInFlight(rows: readonly TimelineEvent[]): InFlight[] {
  const callKey = (r: TimelineEvent) => `${r.conversation_id ?? 0}:${r.tool_use_id}`;
  const returned = new Set(rows.filter((r) => r.kind === "tool_result" && r.tool_use_id).map(callKey));
  return rows.filter((r) => r.kind === "tool_use" && r.tool_use_id && !returned.has(callKey(r)))
    .map((r) => ({ kind: "tool" as const, name: r.tool_name ?? "tool", started_at: r.timestamp || null, tool_use_id: r.tool_use_id! }));
}

/** Both, oldest first (one with no start time last), and the key a page's change log reads them by: a request sent or
 *  answered is a change of the page, so a reader waiting on the page wakes for it, as for a new row. */
export function inFlightOf(models: readonly InFlight[], tools: readonly InFlight[]): { list: InFlight[]; key: string } {
  const list = [...models, ...tools].sort((a, b) => (a.started_at ?? "￿").localeCompare(b.started_at ?? "￿"));
  return { list, key: list.map((f) => `${f.kind}:${f.tool_use_id ?? f.name}@${f.started_at ?? ""}`).join(",") };
}
