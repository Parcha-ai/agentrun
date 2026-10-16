// The graph of a workflow document, and what a run has done in it. This module imports nothing, so a reader with no Node
// (the static viewer inlines it) and the pi session's text view draw the same graph; nothing here validates, runs or
// reads a store. `workflowGraph` reads the workflow JSON as written; `nodeStatus` reads the driver's record of a run
// (the `agentrun.driver` frame of the frozen snapshot, and the `agentrun.items` of a keyed-layout run) and says, for
// each node of that graph, whether it is done, working, failed or not run.

/** One node of the workflow as written. `path` is a JSON Pointer (RFC 6901) into the document: `/root` is the root,
 *  `/root/steps/1` a chain's second step, `/root/branches/<name>/body` a route's branch, `/root/body` a map's or a
 *  loop's body, `/root/workflow/root` a child workflow's root: the pointers `inspectWorkflow` and a validation issue
 *  use for the same node. `label` is the node's label, or its kind when it has none. `via` is a `call` node's transport. */
export type GraphNode = { path: string; kind: string; label: string; via?: string };

/** How control reaches `to` from `from`.
 *  - `next`: a chain enters its first step and each step is followed by the next; a loop enters its body, which runs again
 *    until the loop ends.
 *  - `branch`: a parallel node starts each of its branches.
 *  - `route`: a route node takes one of its branches (the branch's name is the last pointer segment before `/body`).
 *  - `item`: a map runs its body once for each item.
 *  - `child`: a workflow node runs the child workflow's root. */
export type GraphEdgeKind = "next" | "branch" | "route" | "item" | "child";
export type GraphEdge = { from: string; to: string; kind: GraphEdgeKind };
export type WorkflowGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const pointer = (part: string): string => part.replace(/~/g, "~0").replace(/\//g, "~1");
/** The nesting depth `validateWorkflow` and `inspectWorkflow` accept (128 JSON levels): a node nests at least one level deeper than its parent, so every node of such a document is within it. */
const MAX_DEPTH = 128;

/** The graph of `workflow`, computed from its JSON alone: nodes in document order (a node, then its descendants), and the
 *  edges between them. A value that is not a workflow, or a node the walk does not know, adds nothing and never throws:
 *  validation is `validateWorkflow`'s. */
export function workflowGraph(workflow: unknown): WorkflowGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (!isObject(node) || typeof node.node !== "string" || depth > MAX_DEPTH) return;
    nodes.push({ path, kind: node.node, label: typeof node.label === "string" ? node.label : node.node,
      ...(node.node === "call" && typeof node.via === "string" ? { via: node.via } : {}) });
    const child = (target: unknown, at: string, kind: GraphEdgeKind, from = path): void => {
      if (!isObject(target) || typeof target.node !== "string" || depth + 1 > MAX_DEPTH) return;
      edges.push({ from, to: at, kind });
      visit(target, at, depth + 1);
    };
    switch (node.node) {
      case "chain":
        if (Array.isArray(node.steps)) node.steps.forEach((step, index) => child(step, `${path}/steps/${index}`, "next", index === 0 ? path : `${path}/steps/${index - 1}`));
        break;
      case "parallel":
        if (Array.isArray(node.branches)) node.branches.forEach((branch, index) => child(branch, `${path}/branches/${index}`, "branch"));
        break;
      case "map": child(node.body, `${path}/body`, "item"); break;
      case "loop": child(node.body, `${path}/body`, "next"); break;
      case "route":
        if (isObject(node.branches)) for (const [name, branch] of Object.entries(node.branches)) if (isObject(branch)) child(branch.body, `${path}/branches/${pointer(name)}/body`, "route");
        break;
      case "workflow": if (isObject(node.workflow)) child(node.workflow.root, `${path}/workflow/root`, "child"); break;
    }
  };
  visit(isObject(workflow) ? workflow.root : undefined, "/root", 0);
  return { nodes, edges };
}

/** What a run has done at a node. A node inside a map's or a loop's body stands for every item or iteration, and the record names
 *  only those that started, so it is `done` only once the map or loop is: until then it is `working`, and a done node never
 *  goes back. A container (chain, parallel, map, loop, route, workflow) is `working` while some of
 *  its descendants are, or some are done and it is not; a node a run never reached, a branch a route did not take among
 *  them, is `not-run`. */
export type NodeState = "done" | "working" | "failed" | "not-run";

type Frame = { done?: unknown; steps?: unknown; inputs?: unknown; partial?: unknown };
/** The part of an `agentrun.items` value the status reads: the map item's `status` and its frame. */
export type ItemRecordLike = { map?: unknown; index?: unknown; status?: unknown; frame?: Frame };
/** What `nodeStatus` reads: a driver frame (the `pin` of a frozen snapshot: `done`, `steps`, `inputs`), a frozen snapshot
 *  (its `pin`), or the map items' records, alone or together with the driver's record (`{ pin, items }`). */
export type StatusSource = Frame | { pin: Frame; items?: readonly ItemRecordLike[] } | readonly ItemRecordLike[];

/** The execution path an instance of a node ran at, as the node's path in the document: a map's item and a loop's
 *  iteration have no node of their own. */
const definitionPath = (path: string): string => path.replace(/\/items\/\d+\/body/g, "/body").replace(/\/iterations\/\d+(?=\/|$)/g, "");

const RANK: Record<"working" | "failed" | "done", number> = { working: 1, done: 2, failed: 3 };

/** `item`: the source is one map item's (or loop iteration's) record, read on its own, and this is its execution path
 *  (`<map path>/items/<index>`, `<loop path>/iterations/<index>`). That item is then the instance, not one of many: its body is done
 *  when the item is, whether or not the map is. A map or loop inside the item still stands for all of its own items. */
export type StatusOptions = { item?: string };

/** For every node of `graph`, the state the record shows. `source` is what the driver kept: its frame and, in the keyed
 *  layout, the records of the map items (a run's whole story is the frame and the items together). A source that is not
 *  one of those shows no node run. */
export function nodeStatus(graph: WorkflowGraph, source: StatusSource, options: StatusOptions = {}): Record<string, NodeState> {
  const instances = new Map<string, "working" | "done" | "failed">();
  const note = (path: unknown, state: "working" | "done" | "failed"): void => {
    if (typeof path !== "string") return;
    const held = instances.get(path);
    if (held === undefined || RANK[state] > RANK[held]) instances.set(path, state);
  };
  const readFrame = (frame: unknown): void => {
    if (!isObject(frame)) return;
    if (isObject(frame.inputs)) for (const path of Object.keys(frame.inputs)) note(path, "working");
    if (isObject(frame.steps)) for (const [path, step] of Object.entries(frame.steps)) {
      const status = isObject(step) ? step.status : undefined;
      note(path, status === "failed" ? "failed" : "working");
    }
    if (Array.isArray(frame.done)) for (const path of frame.done) note(path, "done");
    // A map that ended on an item's failure is kept as `partial` (its path and the finished items' results); no step or item says failed.
    if (isObject(frame.partial) && typeof frame.partial.path === "string") note(frame.partial.path, "failed");
  };
  const readItem = (item: unknown): void => {
    if (!isObject(item)) return;
    readFrame(item.frame);
    if (typeof item.map === "string" && Number.isInteger(item.index)) {
      const body = `${item.map}/items/${item.index}/body`;
      note(body, item.status === "committed" ? "done" : item.status === "failed" ? "failed" : "working");
    }
  };
  const raw: unknown = source;
  if (Array.isArray(raw)) raw.forEach(readItem);
  else if (isObject(raw) && isObject(raw.pin)) { readFrame(raw.pin); if (Array.isArray(raw.items)) raw.items.forEach(readItem); }
  else readFrame(raw);

  // A done mark outranks a working one at the same path (a step's record stays after its node commits); a failure outranks both.
  const byNode = new Map<string, Array<"working" | "done" | "failed">>();
  for (const [path, state] of instances) {
    const at = definitionPath(path), list = byNode.get(at) ?? [];
    list.push(state); byNode.set(at, list);
  }
  const below = (path: string): Array<"working" | "done" | "failed"> => {
    const found: Array<"working" | "done" | "failed"> = [];
    for (const [at, list] of byNode) if (at.startsWith(`${path}/`)) found.push(...list);
    return found;
  };
  const out: Record<string, NodeState> = {};
  for (const node of graph.nodes) {
    const own = byNode.get(node.path) ?? [], inside = below(node.path);
    out[node.path] = own.includes("failed") || inside.includes("failed") ? "failed"
      : own.length && own.every((state) => state === "done") ? "done"
      : own.includes("working") || inside.includes("working") ? "working"
      : inside.length ? "working"
      : own.length ? "working"
      : "not-run";
  }
  // A chain is never recorded as done itself: the driver commits its steps. It is done when its steps all are, which a
  // run that ended on its last step shows. Children are finished before their parents: the nodes are walked from the end.
  for (const node of [...graph.nodes].reverse()) {
    if (node.kind !== "chain" || byNode.has(node.path)) continue;
    const prefix = `${node.path}/steps/`;
    const steps = graph.nodes.filter((other) => other.path.startsWith(prefix) && /^\d+$/.test(other.path.slice(prefix.length)));
    if (steps.length && steps.every((step) => out[step.path] === "done")) out[node.path] = "done";
  }
  // A node inside a map's or a loop's body stands for every item or iteration, and the record names only those that started: it is
  // done only when the map or loop is. Parents come before their descendants in the node list, so the container is settled first.
  // The map or loop an `item` belongs to is the exception, and so is every one that encloses it: that item is the instance, and
  // the source holds nothing of the items around it. A map or loop inside the item still stands for its own items.
  const owner = typeof options.item === "string" ? definitionPath(options.item.replace(/\/(?:items|iterations)\/\d+$/, "")) : undefined;
  const containers = graph.nodes.filter((node) => (node.kind === "map" || node.kind === "loop")
    && !(owner !== undefined && (node.path === owner || owner.startsWith(`${node.path}/body`))));
  for (const node of graph.nodes) {
    if (out[node.path] !== "done") continue;
    if (containers.some((container) => node.path.startsWith(`${container.path}/body`) && out[container.path] !== "done")) out[node.path] = "working";
  }
  return out;
}
