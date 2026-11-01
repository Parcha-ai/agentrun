// GET /v2/runs/{id}/graph: a workflow run drawn from what it has written so far. The graph is the DSL's `workflowGraph`
// of the revision's workflow; each node's state is `nodeStatus` over the journal's frame (and, once the run ended,
// `readWorkflowRun`'s, with the task's end); a map's items, a route's branch taken and the interrupted decisions come
// from the frame; the decisions are the receipts, each joined to its graph node by its execution path (`graphNodeOf`);
// the calls and the nodes' times are the run process's node log (pause.ts).
//
// Where the frame and the receipts come from: while the run goes its process holds its store exclusively, so they are
// the process's live view (pause.ts `live.json`), and the store is never opened (an open racing the process's own would
// fail it). Once the run ended, the store.
import { type NodeLine, readLiveView, readNodeLog } from "./pause.js";

export type GraphNodeStatus = "pending" | "working" | "done" | "failed" | "stopped" | "escalated" | "not_run" | "needs_review";
type Item = { index: number; status: GraphNodeStatus; executionPath: string; label?: string; branches?: Record<string, string> };
type NodeView = { status: GraphNodeStatus; startedAt?: string; endedAt?: string; branch?: string; items?: Item[] };

export type GraphInput = {
  run: { id: string; agent: string; revision: string; status: string; paused: boolean; startedAt: string; endedAt: string | null };
  /** The run has ended: a node it never reached is `not_run`, not `pending`, and its store is read. */
  ended: boolean;
  /** Read the live view even though the run ended: its store was busy. */
  liveOnly?: boolean;
  workflow: unknown;
  storeFile: string;
  /** The run's directory: its node log is there. */
  root: string;
  /** The run's input: what a map's items are read from before its state has them. */
  input: unknown;
  /** The model nodes' cost from the run's rows (read once it ended; 0 before), null when unknown. */
  modelCost: number | null;
};

type Frame = { done?: string[]; states?: Record<string, unknown>; inputs?: Record<string, unknown>; steps?: Record<string, unknown>; routes?: Record<string, { branch?: string }>; decisions?: Record<string, Record<string, { status?: string }>>; failures?: Record<string, unknown>; partial?: { path?: string } };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const at = (state: unknown, path: string): unknown => path.split(".").reduce<unknown>((value, key) => (isObject(value) ? value[key] : undefined), state);
const labelOf = (item: unknown): string | undefined => {
  if (typeof item === "string") return item.slice(0, 200);
  if (typeof item === "number") return String(item);
  if (!isObject(item)) return undefined;
  const named = item.name ?? item.label ?? item.title ?? item.id ?? item.file ?? item.path ?? item.url;
  return typeof named === "string" || typeof named === "number" ? String(named).slice(0, 200) : undefined;
};

export async function runGraph(given: GraphInput) {
  const [{ graphNodeOf, nodeStatus, workflowGraph }, { readWorkflowRun }, { durableDecisions, readJournal }] = await Promise.all([
    import("@parcha/agentrun-dsl/graph"),
    import("@parcha/pi-durable-agent/workflow"),
    import("@parcha/agentrun-pi/durable"),
  ]);
  const { id } = given.run;
  const graph = workflowGraph(given.workflow);
  let view: { status: Record<string, string>; escalatedAt?: { path: string }; escalation?: { kind: string | null } };
  let pin: Frame;
  let receipts: Array<Record<string, unknown>>;
  let readAt = new Date().toISOString();
  if (given.ended && !given.liveOnly) {
    view = await readWorkflowRun({ runId: id, storePath: given.storeFile, revision: { body: { workflow: given.workflow } } as never });
    pin = ((readJournal(given.storeFile, id)?.state as { pin?: Frame } | undefined)?.pin) ?? {};
    receipts = durableDecisions(given.storeFile);
  } else {
    const live = await readLiveView(given.root);
    pin = (live?.pin as Frame | undefined) ?? {};
    receipts = live?.receipts ?? [];
    if (live?.at) readAt = live.at;
    view = { status: nodeStatus(graph, { pin: pin as never, result: null }) as Record<string, string> };
  }
  const lines = await readNodeLog(given.root);
  const nodeAt = (path: unknown) => (typeof path === "string" ? (graphNodeOf(graph, path)?.path ?? (graph.nodes.some((n) => n.path === path) ? path : undefined)) : undefined);
  const kinds = new Map(graph.nodes.map((node) => [node.path, node.kind]));

  // Each node's state, `not-run` read as pending until the run ends.
  const nodes: Record<string, NodeView> = {};
  for (const node of graph.nodes) {
    const state = view.status[node.path] ?? "not-run";
    nodes[node.path] = { status: state === "not-run" ? (given.ended ? "not_run" : "pending") : (state as GraphNodeStatus) };
  }
  // A decision a later process found asked and never answered goes to review, never asked again.
  const interrupted = new Set<string>();
  for (const [where, requests] of Object.entries(pin.decisions ?? {})) {
    if (isObject(requests) && Object.values(requests).some((r) => isObject(r) && r.status === "interrupted")) interrupted.add(where);
  }
  for (const where of interrupted) {
    const path = nodeAt(where);
    if (path && nodes[path]) nodes[path].status = "needs_review";
  }
  if (view.escalation?.kind === "decision_interrupted" && view.escalatedAt && nodes[view.escalatedAt.path]) nodes[view.escalatedAt.path]!.status = "needs_review";

  // Times: a node's first start and, once it ended, its last end, over all its instances; a container's from what is in it.
  const starts = new Map<string, string>();
  const ends = new Map<string, string>();
  for (const line of lines) {
    if (line.t !== "node.start" && line.t !== "node.end") continue;
    const path = nodeAt(line.path);
    if (!path) continue;
    if (line.t === "node.start" && (!starts.has(path) || line.at < starts.get(path)!)) starts.set(path, line.at);
    if (line.t === "node.end" && (!ends.has(path) || line.at > ends.get(path)!)) ends.set(path, line.at);
  }
  for (const node of graph.nodes) {
    const own = nodes[node.path]!;
    const inside = [...starts.keys()].filter((path) => path === node.path || path.startsWith(`${node.path}/`));
    const first = inside.map((path) => starts.get(path)!).sort()[0];
    const last = [...ends.entries()].filter(([path]) => path === node.path || path.startsWith(`${node.path}/`)).map(([, when]) => when).sort().at(-1);
    if (first) own.startedAt = first;
    if (last && ["done", "failed", "escalated", "stopped", "needs_review"].includes(own.status)) own.endedAt = last;
  }

  // A route's branch taken: its committed decision, else the branch whose body ran (a route by value).
  for (const node of graph.nodes.filter((n) => n.kind === "route")) {
    const decided = Object.entries(pin.routes ?? {}).filter(([where]) => nodeAt(where) === node.path);
    const top = decided.find(([where]) => where === node.path) ?? decided.at(-1);
    if (top?.[1]?.branch) nodes[node.path]!.branch = top[1].branch;
    else {
      const prefix = `${node.path}/branches/`;
      const ran = graph.nodes.find((n) => n.path.startsWith(prefix) && n.path.endsWith("/body") && n.path.split("/").length === prefix.split("/").length + 1 && !["pending", "not_run"].includes(nodes[n.path]!.status));
      if (ran) nodes[node.path]!.branch = ran.path.slice(prefix.length, -"/body".length).replace(/~1/g, "/").replace(/~0/g, "~");
    }
  }

  // A map's items, for a map that runs once (not inside another map or loop): one cell per item of its list.
  const workflow = given.workflow as Record<string, unknown>;
  const definition = (path: string): Record<string, unknown> | undefined => path.split("/").slice(1).reduce<unknown>((value, part) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), workflow) as Record<string, unknown> | undefined;
  const keys = [...(pin.done ?? []), ...Object.keys(pin.states ?? {}), ...Object.keys(pin.inputs ?? {}), ...Object.keys(pin.steps ?? {}), ...Object.keys(pin.failures ?? {}), ...Object.keys(pin.decisions ?? {}), ...Object.keys(pin.routes ?? {}),
    ...lines.flatMap((line) => (typeof line.path === "string" ? [line.path] : [])), ...receipts.map((r) => String(r.execution_path ?? ""))];
  const done = new Set(pin.done ?? []);
  // The run's real input first: a map over an input list has its whole list, in order, from the start.
  const candidates = [given.input, ...Object.values(pin.states ?? {})];
  for (const node of graph.nodes.filter((n) => n.kind === "map" && graphNodeOf(graph, n.path)?.at.length === 0)) {
    const map = node.path;
    const own = nodes[map]!;
    const def = definition(map);
    const list = typeof def?.itemsPath === "string" ? candidates.map((state) => at(state, def.itemsPath as string)).find(Array.isArray) : undefined;
    const seen = new Set<number>();
    const pattern = new RegExp(`^${escape(map)}/items/(\\d+)(?:/|$)`);
    for (const key of keys) {
      const index = pattern.exec(key)?.[1];
      if (index !== undefined) seen.add(Number(index));
    }
    const count = Math.max(list?.length ?? 0, seen.size ? Math.max(...seen) + 1 : 0);
    const body = `${map}/body`;
    const steps = kinds.get(body) === "chain" ? graph.nodes.filter((n) => n.path.startsWith(`${body}/steps/`) && /^\d+$/.test(n.path.slice(`${body}/steps/`.length))).map((n) => n.path.slice(body.length)) : [""];
    const items: Item[] = [];
    const routesIn = graph.nodes.filter((n) => n.kind === "route" && n.path.startsWith(`${body}/`) || n.kind === "route" && n.path === body).map((n) => n.path);
    for (let index = 0; index < count; index++) {
      const exec = `${map}/items/${index}`;
      const inside = (key: string) => key === exec || key.startsWith(`${exec}/`);
      let status: GraphNodeStatus;
      if (pin.failures && Object.hasOwn(pin.failures, exec)) status = "failed";
      else if ([...interrupted].some(inside)) status = "needs_review";
      else if (own.status === "done" || steps.every((step) => done.has(`${exec}/body${step}`)) || isObject(pin.states) && (Object.hasOwn(pin.states, exec) || Object.hasOwn(pin.states, `${exec}/body`))) status = "done";
      else if (Object.values(pin.steps ?? {}).some((step, i) => isObject(step) && step.status === "failed" && inside(Object.keys(pin.steps!)[i]!))) status = "failed";
      else if (seen.has(index)) status = given.ended ? (own.status === "failed" ? "failed" : own.status === "escalated" ? "escalated" : "stopped") : "working";
      else status = given.ended ? "not_run" : "pending";
      const label = labelOf(list?.[index]);
      // Each route in the body that ran for this item, and its branch: the committed decision, else the branch that ran.
      const branches: Record<string, string> = {};
      for (const route of routesIn) {
        const at = `${exec}/body${route.slice(body.length)}`;
        const decided = pin.routes?.[at]?.branch;
        const ran = decided ?? keys.map((key) => (key.startsWith(`${at}/branches/`) ? key.slice(at.length + "/branches/".length).split("/")[0] : undefined)).find((name) => name !== undefined);
        if (ran) branches[route] = ran.replace(/~1/g, "/").replace(/~0/g, "~");
      }
      items.push({ index, status, executionPath: exec, ...(label !== undefined ? { label } : {}), ...(Object.keys(branches).length ? { branches } : {}) });
    }
    own.items = items;
  }

  const runFile = (ref: string) => `/v2/runs/${encodeURIComponent(id)}/files/${ref.split("/").map(encodeURIComponent).join("/")}`;
  const decisions = receipts.map((r) => {
    const images = Array.isArray(r.images) ? (r.images as Record<string, unknown>[]) : [];
    return {
      id: r.decision_id ?? r.id ?? null, node: nodeAt(r.execution_path) ?? null, executionPath: r.execution_path ?? null, item: r.item ?? null, kind: r.kind ?? null,
      provider: r.provider ?? null, model: r.model ?? null, status: r.status ?? null,
      questions: r.questions ?? null, answers: r.answers ?? null, evidence: r.evidence ?? [], rule: r.rule ?? null, action: r.action ?? null,
      cost_usd: typeof r.cost_usd === "number" ? r.cost_usd : null, cost_basis: r.cost_basis ?? null, latency_ms: r.latency_ms ?? null,
      state: r.state ?? null, state_truncated: r.state_truncated === true, error: typeof r.error === "string" ? r.error : null,
      images: images.map((image) => ({ token: image.token ?? null, ref: image.ref ?? null, url: typeof image.ref === "string" ? runFile(image.ref) : null })),
    };
  });

  // The calls, each start paired with its end in order.
  const open = new Map<string, Extract<NodeLine, { t: "effect.start" }>[]>();
  const effects: Array<{ node: string | null; executionPath: string | null; item: number | null; tool: string; status: string; input: unknown; output: unknown; error: string | null; startedAt: string; endedAt: string | null }> = [];
  const placeOf = new Map<Extract<NodeLine, { t: "effect.start" }>, number>();
  for (const line of lines) {
    if (line.t === "effect.start") {
      const key = `${line.path}\n${line.tool}\n${line.label}`;
      (open.get(key) ?? open.set(key, []).get(key)!).push(line);
      placeOf.set(line, effects.length);
      effects.push({ node: nodeAt(line.path) ?? null, executionPath: line.path, item: line.item, tool: line.tool, status: given.ended ? "stopped" : "working", input: line.input, output: null, error: null, startedAt: line.at, endedAt: null });
    } else if (line.t === "effect.end") {
      const start = open.get(`${line.path}\n${line.tool}\n${line.label}`)?.shift();
      if (!start) continue;
      const effect = effects[placeOf.get(start)!]!;
      Object.assign(effect, { status: line.status, output: line.output ?? null, error: line.error ?? null, endedAt: line.at });
    }
  }

  // The run's spend: its decisions', its llm calls' and its model nodes'; one unknown makes it unknown.
  const costs: Array<number | null> = [...decisions.map((d) => d.cost_usd), ...effects.filter((e) => e.tool === "llm" && e.status === "done").map((e) => (isObject(e.output) && typeof e.output.cost_usd === "number" ? e.output.cost_usd : null)), given.modelCost];
  const cost = costs.some((c) => c === null) ? null : Math.round((costs as number[]).reduce((a, b) => a + b, 0) * 1e8) / 1e8;
  const startedMs = Date.parse(given.run.startedAt);
  const endMs = given.run.endedAt ? Date.parse(given.run.endedAt) : Date.now();
  return {
    read_at: readAt,
    run: given.run,
    workflow: given.workflow,
    graph,
    nodes,
    decisions,
    effects,
    totals: { cost_usd: cost, decisions: decisions.length, effects: effects.length, elapsed_ms: Number.isFinite(startedMs) ? Math.max(0, endMs - startedMs) : null },
  };
}
