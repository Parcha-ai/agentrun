// A demo run's story, written as beats (what the agent thought, said, called and asked) and turned into the rows, spans
// and cost the server would have sent for it. A run that is still going shows only the beats its clock has reached, so the
// same story plays live on the run page; one that waits for a person stops at its question until the demo's backend is
// given the answer.
import type { Cost, PendingApproval, Run, RunTrace, RunUsage, TimelineRow } from "@/lib/v2";

export type Beat = { /** Milliseconds before this beat, in place of its kind's usual pause. */ wait?: number } & (
  | { k: "user"; text: string }
  | { k: "think"; text: string }
  | { k: "say"; text: string }
  /** A tool call and its result: `label` is the row's line ("Read orders/1001.json"), `ms` how long the call took. */
  | { k: "tool"; tool: string; label: string; input?: string; result: string; ms?: number; failed?: boolean; saved?: string; nodes?: NonNullable<TimelineRow["learned_nodes"]> }
  /** The agent asks its person a question and waits for the answer. */
  | { k: "ask"; question: string }
  /** A call to a tool set to ask: the run waits for the owner's allow or deny. */
  | { k: "approval"; tool: string; label: string; args: Record<string, unknown>; because: string; result: string; denied: string; price?: PendingApproval["price"] }
  | { k: "final"; text: string }
  | { k: "error"; text: string }
  | { k: "learning"; state: "merged" | "dropped"; reason: "empty" | null; detail: string }
);

/** What a person answered at a gate (a question or an approval), and when. */
export type GateAnswer = { at: number; text?: string; decision?: "allow" | "deny" };

/** Where a played story stands at `now`. */
export type Played = {
  rows: TimelineRow[];
  /** The gate the run waits at, when it waits. */
  pending: NonNullable<Run["pending"]> | null;
  /** Every beat has played. */
  done: boolean;
  /** When the last beat played (the run's end, once done). */
  lastAt: number;
  /** How many model requests the played beats took, and of how many in the whole story. */
  requests: number;
  requestsInAll: number;
  failed: boolean;
};

const PAUSE: Record<Beat["k"], number> = { user: 0, think: 1400, say: 900, tool: 1100, ask: 1200, approval: 1300, final: 1600, error: 900, learning: 700 };
const iso = (ms: number) => new Date(ms).toISOString();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A row with every field the server sends, the unused ones null. */
function row(id: string, at: number, seq: number, kind: TimelineRow["kind"], summary: string, rest: Partial<TimelineRow> = {}): TimelineRow {
  return { id, timestamp: iso(at), created_at: iso(at), kind, summary, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: null, seq, conversation_id: 1, ...rest };
}

/** A beat that takes a model request of its own: the first after the person or a tool spoke. */
const opensTurn = (beats: readonly Beat[], i: number) => {
  const b = beats[i];
  if (b.k === "user" || b.k === "learning") return false;
  const before = beats[i - 1];
  return !before || before.k === "user" || before.k === "tool" || before.k === "ask" || before.k === "approval";
};
export const requestsOf = (beats: readonly Beat[]) => beats.filter((_, i) => opensTurn(beats, i)).length;

/** Plays `beats` from `start` up to `now`: the rows so far and where the story stands. `answers` are the gates answered,
 *  in order; `stopAt`, when the run was stopped or cancelled, after which nothing plays. */
export function play(beats: readonly Beat[], { start, now, answers = [], stopAt }: { start: number; now: number; answers?: readonly GateAnswer[]; stopAt?: number }): Played {
  const rows: TimelineRow[] = [];
  const until = stopAt === undefined ? now : Math.min(now, stopAt);
  const push = (id: string, at: number, kind: TimelineRow["kind"], summary: string, rest?: Partial<TimelineRow>) => { rows.push(row(id, at, rows.length, kind, summary, rest)); };
  let t = start;
  let gate = 0;
  let requests = 0;
  let pending: Played["pending"] = null;
  let failed = false;
  let played = 0;
  for (const [i, b] of beats.entries()) {
    const at = t + (b.wait ?? PAUSE[b.k]);
    if (at > until) break;
    t = at;
    if (opensTurn(beats, i)) requests += 1;
    const id = `1:${i + 1}`;
    if (b.k === "user") push(id, t, "user_message", `You: ${clip(b.text, 160)}`, { text: b.text });
    else if (b.k === "think") push(id, t, "thinking", `Thinking: ${clip(b.text, 80)}`, { text: b.text });
    else if (b.k === "say") push(id, t, "text_block", clip(b.text, 160), { text: b.text });
    else if (b.k === "final") push(id, t, "final_answer", clip(b.text, 160), { text: b.text });
    else if (b.k === "error") { push(id, t, "error", clip(b.text, 160), { text: b.text }); failed = true; }
    else if (b.k === "learning") push("learning", t, "learning", b.detail, { agent_label: "learning", text: b.detail, learning: { state: b.state, reason: b.reason, detail: b.detail } });
    else if (b.k === "tool") {
      const use = `toolu_demo_${i + 1}`;
      push(`${id}:0`, t, "tool_use", b.label, { tool_name: b.tool, tool_use_id: use, tool_input_preview: b.input ?? null, round: i + 1 });
      const ended = t + (b.ms ?? 900);
      // The call is still running: its result comes once its time has passed.
      if (ended > until) { played = i; return { rows, pending: null, done: false, lastAt: t, requests, requestsInAll: requestsOf(beats), failed }; }
      t = ended;
      push(`${id}:r`, t, "tool_result", `${b.label}${b.failed ? ` failed: ${clip(b.result, 120)}` : ": ok"}`, { tool_name: b.tool, tool_use_id: use, tool_status: b.failed ? "failed" : "success", tool_result_preview: clip(b.result, 500), tool_result_size_bytes: b.result.length, round: i + 1, ...(b.nodes ? { learned_nodes: b.nodes } : {}) });
      if (b.saved) push(`${id}:saved:0`, t, "phase", `Saved ${b.saved}`, { path: b.saved });
    } else if (b.k === "ask") {
      const use = `toolu_demo_${i + 1}`;
      push(`${id}:0`, t, "tool_use", `Asked you: ${b.question}`, { tool_name: "ask_person", tool_use_id: use, round: i + 1 });
      push(`${id}:r`, t, "tool_result", `Asked you: ${b.question}: ok`, { tool_name: "ask_person", tool_use_id: use, tool_status: "success", tool_result_preview: `Asked the person: ${b.question}. Waiting for their answer.`, tool_result_size_bytes: b.question.length + 46, round: i + 1 });
      push(`${id}:waiting`, t, "waiting", `Waiting for you: ${b.question}`, { text: b.question, round: i + 1 });
      const answer = answers[gate++];
      if (!answer || answer.at > until) { pending = stopAt === undefined ? { kind: "question", question: b.question, asked_at: iso(t) } : null; played = i; break; }
      t = answer.at;
      push(`${id}:answer`, t, "user_message", `You: ${clip(answer.text ?? "", 160)}`, { text: answer.text ?? "" });
    } else {
      const use = `toolu_demo_${i + 1}`;
      const args = JSON.stringify(b.args);
      push(`${id}:0`, t, "tool_use", b.label, { tool_name: b.tool, tool_use_id: use, tool_input_preview: clip(args, 500), round: i + 1 });
      const answer = answers[gate++];
      const waits = !answer || answer.at > until;
      push(`approval:${use}`, t, "tool_approval_requested", `${waits ? "Waiting for your approval" : "Asked your approval"}: ${b.tool} ${clip(args, 400)}`, { text: args, tool_name: b.tool, tool_use_id: use, tool_input_preview: clip(args, 500) });
      if (waits) {
        pending = stopAt === undefined ? { kind: "approval", id: `apr_demo_${i + 1}`, tool: b.tool, call_id: use, args_preview: args, summary: b.label, asks_because: b.because, requested_at: iso(t), ...(b.price === undefined ? {} : { price: b.price }) } : null;
        played = i;
        break;
      }
      t = answer.at + 800;
      const allowed = answer.decision !== "deny";
      push(`${id}:r`, t, "tool_result", `${b.label}${allowed ? ": ok" : " refused"}`, { tool_name: b.tool, tool_use_id: use, tool_status: allowed ? "success" : "failed", tool_result_preview: allowed ? b.result : b.denied, tool_result_size_bytes: (allowed ? b.result : b.denied).length, round: i + 1, ...(allowed ? {} : { refused: true as const }) });
      push(`approval:${use}:after:outcome`, t, "phase", allowed ? `You allowed ${b.tool}. It ran.` : `You declined ${b.tool}. It did not run.`, { origin: "server", text: allowed ? b.result : b.denied });
    }
    played = i + 1;
  }
  return { rows, pending, done: played === beats.length, lastAt: t, requests, requestsInAll: requestsOf(beats), failed };
}

/** The whole story's length when nobody keeps it waiting: its gates answered `gateMs` after they are asked. */
export function lengthOf(beats: readonly Beat[], gateMs = 0): number {
  let t = 0;
  for (const b of beats) t += (b.wait ?? PAUSE[b.k]) + (b.k === "tool" ? b.ms ?? 900 : b.k === "ask" ? gateMs : b.k === "approval" ? gateMs + 800 : 0);
  return t;
}

/** A run's token counts for a cost, at the shape of a run that caches most of its prompt. */
export function tokensFor(usd: number, requests: number): NonNullable<Cost["tokens"]> {
  const scale = Math.max(usd, 0.0004) * 240_000;
  return { input: Math.round(scale * 0.22), output: Math.round(scale * 0.06), cache_read: Math.round(scale * 0.58), cache_write: Math.round(scale * 0.14), requests, unmetered: 0 };
}

/** The usage row a run's timeline ends with. */
export function usageRow(at: number, seq: number, usd: number, requests: number, ended: boolean): TimelineRow {
  return row("1:usage", at, seq, "usage", `${ended ? "Cost" : "Cost so far"}: $${usd.toFixed(4)} over ${requests} model request${requests === 1 ? "" : "s"}`, { usage: { usd, requests } as TimelineRow["usage"] });
}

/** The run's trace as its Dev tools tab reads it: a span for each model request and each tool call, from its rows. */
export function traceOf(runId: string, rows: readonly TimelineRow[], model: string, usd: number, requests: number): RunTrace {
  const spans: RunTrace["spans"] = [];
  const tokens = tokensFor(usd, requests);
  const share = (n: number) => Math.round(n / Math.max(requests, 1));
  const results = new Map(rows.filter((r) => r.kind === "tool_result").map((r) => [r.tool_use_id, r]));
  let turn = 0;
  let turnOpen = false;
  for (const r of rows) {
    if (r.kind === "user_message" || r.kind === "tool_result") { turnOpen = false; continue; }
    if (["thinking", "text_block", "tool_use", "final_answer"].includes(r.kind) && !turnOpen) {
      turnOpen = true;
      turn += 1;
      const started = Date.parse(r.timestamp);
      spans.push({ id: `m:${turn}`, kind: "model", parent_id: null, name: model.split("/").pop() ?? model, agent_label: null, started_at: iso(started - 1200), ended_at: r.timestamp, status: "ok", stop_reason: r.kind === "final_answer" ? "stop" : "tool_use", tokens: { input: share(tokens.input), cache_read: share(tokens.cache_read), cache_write: share(tokens.cache_write), output: share(tokens.output) }, usd: usd / Math.max(requests, 1), decision: false, charged: true, not_metered: false, tool_use_id: null, input_preview: null, result_preview: null, result_size_bytes: null });
    }
    if (r.kind !== "tool_use") continue;
    const result = results.get(r.tool_use_id);
    spans.push({ id: `t:${r.id}`, kind: "tool", parent_id: `m:${turn}`, name: r.tool_name ?? "tool", agent_label: null, started_at: r.timestamp, ended_at: result?.timestamp ?? null, status: !result ? "running" : result.refused ? "refused" : result.tool_status === "failed" ? "failed" : "ok", stop_reason: null, tokens: null, usd: null, decision: false, charged: false, not_metered: true, tool_use_id: r.tool_use_id, input_preview: r.tool_input_preview, result_preview: result?.tool_result_preview ?? null, result_size_bytes: result?.tool_result_size_bytes ?? null });
  }
  return { run_id: runId, model_requests: "priced", spans, dropped: 0 };
}

/** The run's usage as its Used tab reads it: one line for its model's tokens. */
export function usageOf(run: Pick<Run, "run_id" | "ended_at" | "cost">, model: string): RunUsage {
  const usd = run.cost.usd ?? 0;
  const tokens = run.cost.tokens ?? tokensFor(usd, 1);
  const [provider, name] = model.includes("/") ? [model.split("/")[0], model.split("/").slice(1).join("/")] : [null, model];
  return {
    run_id: run.run_id, ended_at: run.ended_at, currency: "USD", total: { usd },
    lines: [{ meter: "tokens", model: name, provider, charged_by: null, quantity: tokens.input + tokens.output + tokens.cache_read + tokens.cache_write, unit: "token", basis: "estimate", attempt: 1, billable: true, usd, requests: tokens.requests ?? 1, tokens: { input: tokens.input, output: tokens.output, cache_read: tokens.cache_read, cache_write: tokens.cache_write }, unmetered_requests: 0 }],
    browser_sessions: [], computer_intervals: [], infra_usd: 0, reason: run.ended_at ? null : "running",
  };
}
