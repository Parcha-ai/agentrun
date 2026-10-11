// The tab's own events for the self-tools beats, as the stage reads them. Pure. D3's 03 page tells the stage what happens in three ways: a DOM event `walkshome:<type>` on the page, the same
// as a message `{source: "walks-home-tab", type, run, ...detail}` to the stage that opened it, and `brain` entries in the transcript (chat-items.ts reads those). The stage never guesses:
// a field an event did not carry is null, a field of the wrong type is null, and an event that lacks what it is about is nothing.
import type { Checkin, Homecoming, Net, Routing, ToolRow } from "./types.ts";

type Bag = Record<string, unknown>;
const bag = (v: unknown): Bag | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Bag) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const prob = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);

export const TAB_SOURCE = "walks-home-tab";

/** A message from the tab: its type, its run and the rest of what it said. Anything that does not say it is the tab's, with a type, is nothing (the page also checks who sent it). */
export function parseTabMessage(data: unknown): { type: string; run: string | null; detail: Bag } | null {
  const o = bag(data);
  if (o === null || o.source !== TAB_SOURCE) return null;
  const type = str(o.type);
  if (type === null) return null;
  const { source: _s, type: _t, run, ...detail } = o;
  return { type, run: str(run), detail };
}

export function netFromData(d: unknown): Net | null {
  const o = bag(d);
  if (o === null || typeof o.online !== "boolean") return null;
  return { online: o.online, reason: str(o.reason) };
}

export function checkinFromData(d: unknown): Checkin | null {
  const o = bag(d);
  if (o === null || (o.phase !== "start" && o.phase !== "done" && o.phase !== "failed")) return null;
  return { phase: o.phase, head: str(o.head), files: nonNeg(o.files), changes: nonNeg(o.changes), ms: nonNeg(o.ms), message: str(o.message), code: str(o.code), resumed: o.resumed === true };
}

/** One routing decision, from the `brain.decision` event or the transcript entry's data (the same fields). A decision with no reason has nothing to put on a card. */
export function routingFromData(d: unknown): Routing | null {
  const o = bag(d);
  if (o === null || (o.brain !== "tab-local" && o.brain !== "cloud")) return null;
  const reason = str(o.reason);
  if (reason === null) return null;
  const p = bag(o.probabilities);
  const probabilities = p !== null && prob(p.local) !== null && prob(p.cloud) !== null ? { local: p.local as number, cloud: p.cloud as number } : null;
  return { brain: o.brain, answering: str(o.answering), reason, confidence: prob(o.confidence), decidedBy: o.decidedBy === "jev" || o.decidedBy === "rule" ? o.decidedBy : null, ms: nonNeg(o.ms), probabilities };
}

/** Two copies of one decision (the tab's message and its transcript entry) have the same key. */
export const routingKey = (r: Routing): string => `${r.brain}|${r.reason}|${r.confidence}|${r.decidedBy}|${r.ms}`;

/** What a homecoming fetched, from the page's `homecoming` message with `phase: "fetched"` (or the model host's own `model-homecoming`, which has no phase). Without the plan the stage does not say whether the base had to come. */
export function homecomingFromData(d: unknown): Homecoming | null {
  const o = bag(d);
  if (o === null || (o.phase !== undefined && o.phase !== "fetched")) return null;
  const plan = bag(o.plan);
  if (plan === null || typeof plan.base !== "boolean") return null;
  const adapters = Array.isArray(o.adapters) ? o.adapters : Array.isArray(plan.adapters) ? plan.adapters : [];
  return {
    baseFetched: plan.base,
    adapters: adapters.filter((a): a is string => typeof a === "string"),
    plannedBytes: nonNeg(plan.bytes),
    fetchedBytes: nonNeg(o.fetched_bytes),
    fetchMs: nonNeg(o.fetch_ms),
    loadMs: null,
    name: str(o.name),
    prefetch: o.prefetch === true,
  };
}

/** The second phase of a homecoming: the model is loaded, and how long that took. */
export function homecomingLoadedFromData(d: unknown): { loadMs: number; bytes: number | null } | null {
  const o = bag(d);
  if (o === null || o.phase !== "loaded") return null;
  const loadMs = nonNeg(o.load_ms);
  return loadMs === null ? null : { loadMs, bytes: nonNeg(o.bytes) };
}

const STATUSES = new Set(["running", "done", "error", "interrupted"]);

/**
 * The tool calls of the current task: those after the viewer's last line (a line of the server's own is not the viewer's), in the transcript's order. Nothing before the viewer has asked.
 * A status the page does not know is an error row, never a guess that the call worked.
 */
export function toolsFromItems(items: readonly unknown[], isServerTurn: (text: string) => boolean): ToolRow[] {
  let rows: ToolRow[] = [];
  for (const raw of items) {
    const item = bag(raw);
    if (item === null) continue;
    if (item.kind === "user" && typeof item.text === "string" && item.text.trim() !== "" && !isServerTurn(item.text.trim())) rows = [];
    else if (item.kind === "tool") {
      const id = str(item.id);
      const name = str(item.name);
      if (id === null || name === null) continue;
      rows.push({ id, name, args: typeof item.args === "string" ? item.args : "", output: typeof item.output === "string" ? item.output : "", status: typeof item.status === "string" && STATUSES.has(item.status) ? (item.status as ToolRow["status"]) : "error" });
    }
  }
  // Tool calls before the first viewer line belong to no task the viewer asked for.
  let asked = false;
  for (const raw of items) {
    const item = bag(raw);
    if (item?.kind === "user" && typeof item.text === "string" && item.text.trim() !== "" && !isServerTurn(item.text.trim())) asked = true;
  }
  return asked ? rows : [];
}

/** A transcript `brain` entry of stage "decision": the routing decision it carries, with the entry's id (ids only grow, so the feed says each once). */
export function routingFromItem(item: unknown): { id: string; routing: Routing } | null {
  const o = bag(item);
  if (o === null || o.kind !== "brain" || o.stage !== "decision") return null;
  const id = str(o.id);
  const routing = routingFromData(o.data);
  return id === null || routing === null ? null : { id, routing };
}

/** A transcript `brain` entry of stage "home": the run came back from offline. The entry is written once the check-in is taken, so it is a finished one. */
export function checkinFromItem(item: unknown): { id: string; checkin: Checkin } | null {
  const o = bag(item);
  if (o === null || o.kind !== "brain" || o.stage !== "home") return null;
  const id = str(o.id);
  const checkin = checkinFromData({ ...(bag(o.data) ?? {}), phase: "done" });
  return id === null || checkin === null ? null : { id, checkin };
}
