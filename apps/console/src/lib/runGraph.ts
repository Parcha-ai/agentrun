// A workflow run as GET /v2/runs/{id}/graph gives it (the sprint's contract C4), and what the graph view draws from it:
// each node's state, the route branches taken, each map's item cells, a decision's verdict on its card, and, for one
// selected map item, its body's nodes in that item's states.
import type { WorkflowGraph } from "@dsl/graph";
import type { GraphMarks, ItemMark } from "./wfGraph";
import { nodeMeta, type NodeMeta } from "./workflowDoc";

export type NodeRunStatus = "pending" | "working" | "done" | "failed" | "stopped" | "escalated" | "not_run" | "needs_review";
/** `branches`: each route inside the map's body that ran for this item, and the branch it took (by its graph path). */
export type RunItem = { index: number; status: NodeRunStatus; executionPath: string; label?: string; branches?: Record<string, string> };
export type NodeRun = { status: NodeRunStatus; startedAt?: string; endedAt?: string; branch?: string; items?: RunItem[] };

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "box"; instructions: string };
export type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: "box"; box: { top: number; bottom: number; left: number; right: number }; confidence: number | null }
  | { type: "refusal" };
export type Rule =
  | { kind: "judge" }
  | { kind: "pick"; options: string[]; none: string | null }
  | { kind: "route"; branches?: string[]; unsure: { gte: number; branch: string } | null }
  | { kind: "sift"; items: number; ids: string[]; keep: { id: string; measure: "confidence" | "value"; gte: number } | null }
  | { kind: "ask"; gte: number }
  | { kind: "verify"; thresholds: Record<string, number | null>; present: string[] };
export type Evidence = { url: string; title: string | null; excerpts: string[]; scope?: string };

/** A decision receipt as the graph route gives it. serve passes a field the receipt lacks as null, so every reader here
 *  takes null for an absent answer set, node, latency or cost. */
export type Decision = {
  id: string | null;
  node: string | null;
  executionPath: string;
  item: number | null;
  kind: string;
  provider: string | null;
  model: string | null;
  status: "answered" | "failed" | "cancelled";
  questions: Record<string, Question> | null;
  answers: Record<string, Answer> | null;
  evidence?: Evidence[] | null;
  rule: Rule | null;
  action: unknown;
  cost_usd: number | null;
  cost_basis?: string | null;
  latency_ms: number | null;
  state?: unknown;
  state_truncated?: boolean;
  images?: { token: string; ref: string; url?: string | null; sha256?: string | null; mime?: string | null; bytes?: number | null }[];
  error?: string;
};
export type Effect = { node: string | null; executionPath: string; item: number | null; tool: string; status: string; input: unknown; output: unknown; error?: string | null; startedAt?: string; endedAt?: string | null };

export type RunGraph = {
  run: { id: string; agent: string; revision: string; status: string; paused: boolean; startedAt: string; endedAt: string | null };
  workflow: unknown;
  graph: WorkflowGraph;
  nodes: Record<string, NodeRun>;
  decisions: Decision[];
  effects: Effect[];
  totals: { cost_usd: number | null; decisions: number; effects: number; elapsed_ms: number | null };
  /** The server's last good view, given again while the run's store is busy; `read_at` is when that view was read. */
  stale?: boolean;
  read_at?: string | null;
};

/** The drawing's word for a run's state. */
export const markOf = (s: string | undefined): string | undefined =>
  s === "not_run" ? "not-run" : s === "needs_review" ? "review" : s;

const seg = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
export const isFinal = (status: string) => ["completed", "failed", "cancelled", "stopped", "escalated"].includes(status);

/** Every node's meta, from the graph node when it carries it, else from the workflow. */
export function metaOf(workflow: unknown, graph: WorkflowGraph): Record<string, NodeMeta> {
  return Object.fromEntries(graph.nodes.map((n) => [n.path, nodeMeta(workflow, n.path, n as unknown as Record<string, unknown>)]));
}

const pct = (p: number) => (p >= 0.995 ? "1.00" : p.toFixed(2));

/** A decision's answer in a few characters: the chosen option or branch and its probability, yes/no with P(yes). Of
 *  several answers, the least sure one; `short` leaves out its yes/no (the probability is P(yes)), for a card. */
export function verdictOf(d: Decision, short = false): string | undefined {
  if (d.status === "failed") return "failed";
  if (d.status === "cancelled") return "interrupted";
  const answers = d.answers ?? {};
  const a = d.action as { taken?: string; branch?: string } | null;
  if (d.rule?.kind === "route" && a && typeof a === "object" && (a.taken || a.branch)) {
    const ans = answers.branch;
    const conf = ans && ans.type === "choice" ? ans.confidence : undefined;
    const unsure = (a as { unsure?: boolean }).unsure;
    return unsure ? `${a.taken} (unsure)` : `${a.taken ?? a.branch}${conf !== undefined ? ` ${pct(conf)}` : ""}`;
  }
  const ids = Object.keys(answers);
  if (!ids.length) return undefined;
  const one = (id: string) => {
    const x = answers[id];
    if (x.type === "choice") return `${optionName(d, id, x.choice)} ${pct(x.probabilities[x.choice] ?? x.confidence)}`;
    if (x.type === "noul") return `${x.noul >= 0.5 ? "yes" : "no"} ${pct(x.noul)}`;
    if (x.type === "score") return `${x.score} ${pct(x.confidence)}`;
    if (x.type === "refusal") return "refused";
    return "box";
  };
  if (ids.length === 1) return one(ids[0]);
  // Several answers: the least sure one, which is the one a reader checks first.
  const sure = (id: string) => {
    const x = answers[id];
    return x.type === "noul" ? Math.abs(x.noul - 0.5) * 2 : "confidence" in x && typeof x.confidence === "number" ? x.confidence : 1;
  };
  const weakest = ids.reduce((w, id) => (sure(id) < sure(w) ? id : w), ids[0]);
  const w = answers[weakest];
  return short && w.type === "noul" ? `${weakest} ${pct(w.noul)}` : `${weakest} ${one(weakest)}`;
}

/** A choice's name as the reader knows it: a pick numbers its options (item_0, item_1, ...), so its option's own text
 *  names it; any other choice is its own name. */
export function optionName(d: Decision, id: string, choice: string): string {
  const q = d.questions?.[id];
  const text = d.kind === "pick" && q?.type === "choice" ? q.criteria?.[choice] : null;
  return typeof text === "string" && text ? text : choice;
}

/** The body paths of a map, in document order. */
const bodyOf = (graph: WorkflowGraph, map: string) => graph.nodes.filter((n) => n.path.startsWith(`${map}/body`)).map((n) => n.path);

/** One map item's view of the map's body: each body node's state for that item, read from its decisions and effects.
 *  A node with no record is done in a done item, working where a working item is up to, and pending or not run after. */
export function itemStates(g: RunGraph, map: string, index: number): Record<string, string> {
  const item = g.nodes[map]?.items?.find((x) => x.index === index);
  const out: Record<string, string> = {};
  if (!item) return out;
  const containers = new Set(["chain", "parallel", "route", "map", "loop", "workflow"]);
  const kindOf = new Map(g.graph.nodes.map((n) => [n.path, n.kind]));
  const body = bodyOf(g.graph, map).filter((p) => !containers.has(kindOf.get(p) ?? ""));
  let reached = -1;
  body.forEach((p, k) => {
    const ds = g.decisions.filter((d) => d.node === p && d.item === index);
    const es = g.effects.filter((e) => e.node === p && e.item === index);
    if (!ds.length && !es.length) return;
    reached = k;
    if (ds.some((d) => d.status === "failed") || es.some((e) => e.status === "failed")) out[p] = "failed";
    else if (ds.some((d) => d.status === "cancelled")) out[p] = "review";
    else if (es.some((e) => !e.endedAt)) out[p] = es.some((e) => e.status === "stopped") ? "stopped" : "working";
    else out[p] = "done";
  });
  const s = markOf(item.status) ?? "pending";
  let next = !Object.values(out).includes("working");
  body.forEach((p, k) => {
    if (out[p]) return;
    if (k < reached || s === "done") out[p] = "done";
    else if (s === "working") { out[p] = next ? "working" : "pending"; next = false; }
    else if (s === "pending") out[p] = "pending";
    else out[p] = "not-run";
  });
  return out;
}

export type Selection = { path: string; item?: number | null } | null;

/** The marks the graph draws for a run: states, branches taken, the fired exit, item cells, verdicts, the selection. With
 *  a map item selected, that map's body shows the item's states and verdicts. */
export function runMarks(g: RunGraph, selected: Selection): GraphMarks {
  const status: Record<string, string> = {};
  const taken: string[] = [];
  const items: Record<string, ItemMark[]> = {};
  let fired: string | null = null;
  const kindOf = new Map(g.graph.nodes.map((n) => [n.path, n.kind]));
  for (const [path, n] of Object.entries(g.nodes)) {
    const s = markOf(n.status);
    if (s) status[path] = s;
    if (n.branch) taken.push(`${path}/branches/${seg(n.branch)}/body`);
    if (n.items) items[path] = n.items.map((it) => ({ index: it.index, status: markOf(it.status) ?? "pending", label: itemLabel(g, path, it.index), ...itemOutcome(g, path, it) }));
    if (n.status === "escalated" && kindOf.get(path) === "escalate") fired = path;
  }
  // A verdict on a card: the node's one decision outside a map, or the selected item's inside one.
  const verdict: Record<string, string> = {};
  const inMap = (p: string) => /\/body(\/|$)/.test(p) && g.graph.nodes.some((n) => n.kind === "map" && p.startsWith(`${n.path}/body`));
  for (const d of g.decisions) {
    if (!d.node || d.item !== null || inMap(d.node)) continue;
    const v = verdictOf(d, true);
    if (v) verdict[d.node] = v;
  }
  if (selected && selected.item != null && kindOf.get(selected.path) === "map") {
    Object.assign(status, itemStates(g, selected.path, selected.item));
    // The item's own path through its routes: the branch it took is drawn taken, the others not run.
    const own = g.nodes[selected.path]?.items?.find((x) => x.index === selected.item)?.branches ?? {};
    for (const [route, branch] of Object.entries(own)) {
      const prefix = `${route}/branches/`;
      const took = `${prefix}${seg(branch)}/body`;
      for (let k = taken.length - 1; k >= 0; k--) if (taken[k].startsWith(prefix)) taken.splice(k, 1);
      taken.push(took);
      for (const n of g.graph.nodes) if (n.path.startsWith(prefix) && !(n.path === took || n.path.startsWith(`${took}/`))) status[n.path] = "not-run";
    }
    for (const d of g.decisions) if (d.node && d.item === selected.item && d.node.startsWith(`${selected.path}/body`)) { const v = verdictOf(d, true); if (v) verdict[d.node] = v; }
  }
  // A paused run's working nodes and items are held: nothing new starts until it resumes. Last, so a selected item's
  // own states are held too.
  if (g.run.paused) {
    for (const [p, s] of Object.entries(status)) if (s === "working") status[p] = "held";
    for (const list of Object.values(items)) for (const it of list) if (it.status === "working") it.status = "held";
  }
  return { status, taken, items, fired, verdict, meta: metaOf(g.workflow, g.graph), selected };
}

/** How an outcome reads, for a cell's colour only: words a workflow's branches commonly use. An outcome not listed here
 *  is drawn in the item's state. */
const TONE: Record<string, "good" | "warn" | "bad"> = {
  accept: "good", accepted: "good", approve: "good", approved: "good", valid: "good", pass: "good", auto: "good", agree: "good", ok: "good", clear: "good", low: "good",
  review: "warn", hold: "warn", doubtful: "warn", borderline: "warn", unsure: "warn", human: "warn", escalate: "warn", edd: "warn", medium: "warn", second_look: "warn", disagree: "warn",
  reject: "bad", rejected: "bad", decline: "bad", declined: "bad", invalid: "bad", fail: "bad", deny: "bad", high: "bad", block: "bad",
};
export const toneOf = (outcome: string | undefined) => {
  if (!outcome) return undefined;
  const w = outcome.toLowerCase();
  return TONE[w] ?? TONE[w.split(/[_\s-]/)[0]] ?? TONE[w.split(/[_\s-]/).at(-1) ?? ""];
};

/** How sure a decision is of what it decided, as a probability: a route's or a choice's confidence, else that of its least
 *  sure yes/no (the probability of the answer it took). With the question it belongs to, for the cell's title. */
function decidingP(d: Decision): { p: number; note: string } | undefined {
  if (d.status !== "answered" || !d.answers) return undefined;
  const a = d.action as { taken?: string } | null;
  const branch = d.answers.branch;
  if (a && typeof a === "object" && a.taken && branch?.type === "choice") return { p: branch.confidence, note: `${d.kind} confidence` };
  let worst: { p: number; note: string; sure: number } | undefined;
  for (const [id, x] of Object.entries(d.answers)) {
    const v = x.type === "noul" ? { p: Math.max(x.noul, 1 - x.noul), note: `${id}: ${x.noul >= 0.5 ? "yes" : "no"}, P(yes) ${x.noul.toFixed(2)}`, sure: Math.abs(x.noul - 0.5) } : x.type === "choice" || x.type === "score" ? { p: x.confidence, note: `${id} confidence`, sure: x.confidence - 0.5 } : undefined;
    if (v && (!worst || v.sure < worst.sure)) worst = v;
  }
  return worst && { p: worst.p, note: `least sure: ${worst.note}` };
}

/** A map item's outcome: the branch its last route took (the server's per-item branches, else a judged route's own
 *  decision), the probability behind it, and its tone; a failed or held item is bad or warn whatever it decided. */
export function itemOutcome(g: RunGraph, map: string, it: RunItem): Pick<ItemMark, "outcome" | "p" | "pNote" | "tone"> {
  const order = bodyOf(g.graph, map);
  const rank = (p: string | null) => (p ? order.indexOf(p) : -1);
  const mine = g.decisions.filter((d) => d.item === it.index && !!d.node?.startsWith(`${map}/body`)).sort((a, b) => rank(a.node) - rank(b.node));
  let outcome: string | undefined;
  let from: string | undefined;
  const routes = Object.entries(it.branches ?? {}).sort(([a], [b]) => rank(a) - rank(b));
  if (routes.length) [from, outcome] = routes[routes.length - 1];
  else {
    const judged = mine.filter((d) => d.status === "answered" && (d.action as { taken?: string } | null)?.taken).at(-1);
    if (judged) { outcome = (judged.action as { taken: string }).taken; from = judged.node ?? undefined; }
  }
  const deciding = (from && mine.filter((d) => d.node === from).at(-1)) || mine.filter((d) => d.status === "answered").at(-1);
  const dp = deciding ? decidingP(deciding) : undefined;
  const tone = it.status === "failed" ? "bad" : it.status === "needs_review" || it.status === "escalated" ? "warn" : toneOf(outcome);
  return { ...(outcome ? { outcome } : {}), ...(dp ? { p: dp.p, pNote: dp.note } : {}), ...(tone ? { tone } : {}) };
}

/** A map item's name: the server's label, else what its first tool call was given (a file's path, a page's URL). */
export function itemLabel(g: RunGraph, map: string, index: number): string | undefined {
  const it = g.nodes[map]?.items?.find((x) => x.index === index);
  if (it?.label) return it.label;
  const e = g.effects.find((x) => x.item === index && !!x.node?.startsWith(`${map}/body`));
  const input = e?.input as { path?: unknown; url?: unknown } | null | undefined;
  const named = input?.path ?? input?.url;
  return typeof named === "string" ? named : undefined;
}

/** Counts of a map's items by state. */
export function itemCounts(items: RunItem[] = []) {
  const c = { total: items.length, done: 0, working: 0, failed: 0, review: 0, pending: 0 };
  for (const it of items) {
    if (it.status === "done") c.done++;
    else if (it.status === "working") c.working++;
    else if (it.status === "failed") c.failed++;
    else if (it.status === "needs_review" || it.status === "escalated") c.review++;
    else c.pending++;
  }
  return c;
}

/** A run's cost as its graph totals give it: the server's total, else (one unknown makes it unknown) the sum of the
 *  priced decisions with a count of the unpriced. The run's header and its totals bar both read it. */
export function costOf(g: RunGraph): { usd: number; unknown: number } {
  const unknown = g.decisions.filter((d) => d.cost_usd === null).length;
  return { usd: g.totals.cost_usd ?? g.decisions.reduce((a, d) => a + (d.cost_usd ?? 0), 0), unknown: g.totals.cost_usd === null ? unknown : 0 };
}

export const usd = (v: number | null | undefined) => (v == null ? "Unknown" : v > 0 && v < 0.0001 ? "<$0.0001" : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
export const ms = (v: number | null | undefined) => (v == null ? "—" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} s`);
export function elapsed(msTotal: number) {
  const s = Math.max(0, Math.floor(msTotal / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** The run's elapsed time: the server's total as read, and, while the run goes, the time since that read (the browser's
 *  clock never compared with the server's). */
export const elapsedNow = (g: RunGraph, readAt: number, now: number) => {
  const base = g.totals.elapsed_ms ?? (Date.parse(g.run.endedAt ?? "") || readAt) - Date.parse(g.run.startedAt);
  return isFinal(g.run.status) || g.run.paused ? base : base + Math.max(0, now - readAt);
};
