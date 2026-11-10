// The reads the server made from a run's own database, now from A's journal (store.readJournal): a run's entries in log
// order, its timeline (the renderer unchanged), and what was said to it (its hearing). The old path read each run's
// its own database file ("SELECT record FROM entries ORDER BY id") and fed the same pure renderer; these read the one store instead.
// The renderer and the hearing keep their words; only where the entries come from changes.
import type { Context } from "@earendil-works/chord";
import type { EntryLike, TimelineEvent, TimelineOptions } from "@parcha/pi-durable-agent/timeline";
import { timelineOf, TOOL_COST } from "@parcha/pi-durable-agent/timeline";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import { Hearing } from "../heard.js";
import { labelled, type Reflect } from "../learning-run.js";
import { reflectFrom } from "../runner/end-of-run.js";
import { journalEntries, journalRecords } from "../runner/journal-reader.js";
import { KINDS } from "../runner/journal-kinds.js";
import type { Store } from "../store/store.js";

/** A run's entries from the one store, in log order (by id across every conversation), as the old "SELECT record FROM
 *  entries ORDER BY id" read them for a settled run. A run with no journal reads as none. */
export async function runEntries(store: Store, runId: string, context: Context): Promise<EntryLike[]> {
  const entries = (await journalEntries(store.readJournal(runId), context)) as unknown as EntryLike[];
  return entries.slice().sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
}

/** Where a run's end-of-run turn is in its journal, as the server's Reflect names it for labelled(): `after`, the entry
 *  before its input; `until`, the run's end entry once written. Undefined for a run that asked none. */
export async function runReflect(store: Store, runId: string, context: Context): Promise<Pick<Reflect, "after" | "until"> | undefined> {
  const records = await journalRecords(store.readJournal(runId), context);
  const from = reflectFrom(records.submissions ?? []);
  if (from === undefined) return undefined;
  const end = records.entries.find((entry) => entry.kind === KINDS.end && Number(entry.id) >= from);
  return { after: from - 1, ...(end ? { until: Number(end.id) } : {}) };
}

/** The CLI record (a harness whose own records are resume log only, record "loop": adapter-loop.ts openCliRecord) as the
 *  pi-shaped entries the timeline renderer reads: a model message is an assistant turn, a person message a user turn, and a
 *  tool call its assistant tool-call and its result. So a claude-agent / codex / opencode run reads the same rows, words
 *  and final answer as a pi run of the same conversation. A run's own pi entries and its end-of-run turn (already model
 *  shaped) pass through unchanged, so a pi run is untouched. */
function piShaped(entries: readonly EntryLike[]): EntryLike[] {
  return entries.map((entry) => {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    // When the record's entry was written (`at`), as pi's own message carries its timestamp: the Timeline dates the row by it.
    const timestamp = typeof data.at === "number" ? { timestamp: data.at } : {};
    if (entry.kind === KINDS.message) {
      const text = typeof data.text === "string" ? data.text : "";
      if (data.role === "person") return { ...entry, kind: "pi.user", model: [{ role: "user", content: text, ...timestamp }] };
      // A model turn's text; its stop reason is the answer's (a cut at the output limit reads "length", as pi's does).
      const stopReason = data.stopReason === "length" ? "length" : "stop";
      return { ...entry, kind: "pi.assistant", model: [{ role: "assistant", stopReason, content: [{ type: "text", text }], ...(typeof data.outputTokens === "number" ? { usage: { output: data.outputTokens } } : {}), ...timestamp }] };
    }
    if (entry.kind === KINDS.callStart) {
      return { ...entry, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: String(data.callId ?? ""), name: String(data.tool ?? "tool"), arguments: data.input ?? {} }], ...timestamp }] };
    }
    if (entry.kind === KINDS.callEnd) {
      // A call that did not finish done is an error result, as a failed pi tool call is; its output is the result's text.
      const failed = data.status !== undefined && data.status !== "done";
      return { ...entry, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: String(data.callId ?? ""), content: data.output ?? "", ...(failed ? { isError: true } : {}), ...timestamp }] };
    }
    return entry;
  });
}

/** The paid tool charges a run booked, read back from its paid-tools session (the kernel cap's TOOL_SESSION) as the
 *  TOOL_COST entries the timeline renders, which the file-backed path had on the run's root (the paid-call ledger). Each
 *  paid request's runner.request names its tool (its model "paid:<name>") and the call it ran under (`call`, written by the
 *  cap so the view puts the charge under that call); its runner.turn carries the cost: a charge at what it charged, $0
 *  included, or of an unknown amount when it says none (null), as main's TOOL_COST renders it. Not metered (main's
 *  TOOL_UNMETERED) is a tool with no price set, which books no paid record on the runner, so none is read here. A hold
 *  given back unused shows nothing. Each charge is placed right after its call's result, joined by `call`, as the ledger
 *  wrote it there. A run with no paid-tools session reads unchanged. */
export function withPaidCosts(entries: readonly EntryLike[]): EntryLike[] {
  const session = entries.find((e) => e.kind === KINDS.sessionKey && (e.data as { key?: unknown } | undefined)?.key === TOOL_SESSION);
  const conv = session ? (session.data as { conversation?: unknown }).conversation : undefined;
  if (typeof conv !== "number") return [...entries];
  // Each paid request's tool and the call it ran under, by its turn; then each turn's cost, paired by turn.
  const named = new Map<number, { tool: string; call?: string; chargedBy?: string }>();
  for (const e of entries) {
    if (e.conversationId !== conv || e.kind !== RUNNER_RECORDS.request) continue;
    const d = (e.data ?? {}) as { turn?: number; model?: string; call?: string; charged_by?: string };
    if (typeof d.turn === "number" && typeof d.model === "string" && d.model.startsWith("paid:")) named.set(d.turn, { tool: d.model.slice("paid:".length), ...(typeof d.call === "string" ? { call: d.call } : {}), ...(typeof d.charged_by === "string" && d.charged_by ? { chargedBy: d.charged_by } : {}) });
  }
  const charges: { tool: string; call?: string; chargedBy?: string; usd: number | null }[] = [];
  for (const e of entries) {
    if (e.conversationId !== conv || e.kind !== RUNNER_RECORDS.turn) continue;
    const d = (e.data ?? {}) as { turn?: number; usd?: number | null; givenBack?: boolean };
    const req = typeof d.turn === "number" ? named.get(d.turn) : undefined;
    // Three outcomes, as main's records keep them apart: a hold given back unused (nothing sent) shows no row; a request
    // that ran is a charge at what it charged, $0 included (main's TOOL_COST of usd 0, a Parallel 4xx); one whose charge
    // is unknown (null) is a charge of an unknown amount (main's TOOL_COST with no usd).
    if (!req || d.givenBack === true) continue;
    charges.push({ ...req, usd: typeof d.usd === "number" && Number.isFinite(d.usd) && d.usd >= 0 ? d.usd : null });
  }
  if (!charges.length) return [...entries];
  const out = [...entries];
  for (const charge of charges) {
    // Who charged: the request's own charged_by, which the cap writes as main's charge label names it (parallel, monid, an
    // MCP server, a browser vendor).
    const by = charge.chargedBy;
    const at = charge.call === undefined ? -1 : out.findIndex((e) => e.kind === "pi.tool-result" && String((e.model?.[0] as { toolCallId?: unknown } | undefined)?.toolCallId ?? "") === charge.call);
    const data = { tool: charge.tool, ...(by ? { charged_by: by } : {}), ...(charge.call ? { call: charge.call } : {}), ...(charge.usd !== null ? { usd: charge.usd } : {}) };
    const entry = { conversationId: at >= 0 ? out[at]!.conversationId : conv, kind: TOOL_COST, data, id: `paid:${charge.call ?? charge.tool}` } as unknown as EntryLike;
    out.splice(at >= 0 ? at + 1 : out.length, 0, entry);
  }
  return out;
}

/** A run's timeline rows, the renderer (timelineOf) unchanged, over the one store's entries, with a CLI harness's record
 *  rendered as its pi-shaped entries (piShaped) and its paid tool charges read back from the paid-tools session
 *  (withPaidCosts). The usage row the renderer folds from the model turns is dropped for a CLI run: its record carries no
 *  per-request cost, so the run's cost reads from its stored total (costView over no usage row), as it did before this
 *  rendering existed, never a $0/unknown usage row. The end-of-run turn's rows are labelled as the server labels them
 *  (learning-run.ts labelled). */
export async function runTimeline(store: Store, runId: string, context: Context, options: TimelineOptions = {}): Promise<TimelineEvent[]> {
  const entries = await runEntries(store, runId, context);
  const cli = entries.some((entry) => entry.kind === KINDS.message || entry.kind === KINDS.callStart || entry.kind === KINDS.callEnd);
  const rows = timelineOf(withPaidCosts(cli ? piShaped(entries) : entries), options).filter((row) => !cli || row.kind !== "usage");
  return labelled((await runReflect(store, runId, context)) as Reflect | undefined, await datedRows(store, runId, rows));
}

/** `rows` with none dated 1970: a row the renderer found no time for (an entry of a CLI record written before its entries
 *  carried `at`; the store's entry rows keep no write time of their own) reads the run's start, the earliest time it can
 *  have, never epoch 0. Every other row is as the renderer dated it. */
async function datedRows(store: Store, runId: string, rows: TimelineEvent[]): Promise<TimelineEvent[]> {
  if (!rows.some((row) => Date.parse(row.timestamp) === 0)) return rows;
  const run = await store.runs.get(runId);
  if (!run) return rows;
  const started = new Date(run.startedAt).toISOString();
  return rows.map((row) => (Date.parse(row.timestamp) === 0 ? { ...row, timestamp: started, created_at: started } : row));
}

/** What was said to a run (its hearing), from the one store's entries, as runs.ts noteTurns fed it from the stream: each
 *  user entry noted in log order, its origin read by the same matcher. */
export async function runHearing(store: Store, runId: string, context: Context): Promise<Hearing> {
  const hearing = new Hearing();
  for (const entry of await runEntries(store, runId, context)) hearing.note(entry);
  return hearing;
}
