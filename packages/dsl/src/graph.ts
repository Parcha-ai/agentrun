// The graph of a workflow document, and what a run has done in it. This module imports nothing, so a reader with no Node
// (the static viewer inlines it) and the pi session's text view draw the same graph; nothing here validates, runs or
// reads a store. `workflowGraph` reads the workflow JSON as written; `nodeStatus` reads the driver's record of a run
// (the `agentrun.driver` frame of the frozen snapshot, and the `agentrun.items` of a keyed-layout run) and says, for
// each node of that graph, whether it is done, working, failed or not run, or, given the run's terminal result, where an
// escalation stopped it; `graphNodeOf` names the node an execution path ran
// at, and the map items and loop iterations around it; `graphDiff` says what changed between two graphs of a workflow.

/** One node of the workflow as written. `path` is a JSON Pointer (RFC 6901) into the document: `/root` is the root,
 *  `/root/steps/1` a chain's second step, `/root/branches/<name>/body` a route's branch, `/root/body` a map's or a
 *  loop's body, `/root/workflow/root` a child workflow's root: the pointers `inspectWorkflow` and a validation issue
 *  use for the same node. `label` is the node's label, or its kind when it has none. `via` is a `call` node's transport.
 *  `changeCheck` detects a change to the node's own fields from one graph to another: 8 hex digits, the FNV-1a hash of
 *  the canonical JSON (keys sorted) of the node with its children left out as the walk leaves them out (a chain's steps,
 *  a parallel's branches, a map's or a loop's body, each route branch's body, a child workflow's root). A route's branch
 *  names are its own fields, since they decide which branch runs, so a route that gains or loses a branch is rewritten. It
 *  is not an identity and not a saved revision's sha256: two nodes with the same check are not the same node, and a check
 *  that stayed only means no change was seen. A graph built by hand may leave it out. */
export type GraphNode = { path: string; kind: string; label: string; via?: string; changeCheck?: string } & GraphDecision;

/** One typed question a decision node asks, as a viewer shows it: its id, its type (`unknown` when its schema is not a
 *  question the reader recognizes), its instructions, and a choice's options. */
export type GraphQuestion = { id: string; type: "noul" | "choice" | "score" | "unknown"; instructions: string; options?: string[] };
/** What a decision node (judge, pick, sift, a judged route, or a loop or escalate whose predicate is `ask`) says about
 *  its decision, read from the document: the provider and model it names (absent when it names none), its questions, and
 *  the tokens of the images it sends. A graph of another node carries none of these. */
export type GraphDecision = { provider?: string; model?: string; questions?: GraphQuestion[]; images?: string[] };

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

/** A value as canonical JSON: object keys sorted, undefined members left out, other values as JSON writes them. Deeper
 *  than `MAX_DEPTH` a value is written as one marker, so a value that is not JSON (a cycle) still ends. A leaf JSON
 *  cannot encode (a bigint, a symbol) is written as a marker of its type, so changeCheck is total: `workflowGraph` never
 *  throws on a node the validator accepts, and such a leaf still changes the check when it changes value. */
const leaf = (value: unknown): string => {
  try { return JSON.stringify(value) ?? "null"; }
  catch { return JSON.stringify(`[${typeof value}:${String(value)}]`); }
};
const canonicalJson = (value: unknown, depth = 0): string => {
  if (depth > MAX_DEPTH) return '"…"';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
  return leaf(value);
};
/** FNV-1a (32 bits) over the UTF-16 code units of `text`, as 8 hex digits. */
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const without = (value: Json, key: string): Json => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
/** A node's own fields: the node with the children the walk visits left out. */
const ownFields = (node: Json): Json => {
  switch (node.node) {
    case "chain": return without(node, "steps");
    case "parallel": return without(node, "branches");
    case "map": case "loop": return without(node, "body");
    case "route": return isObject(node.branches)
      ? { ...node, branches: Object.fromEntries(Object.entries(node.branches).map(([name, branch]) => [name, isObject(branch) ? without(branch, "body") : branch])) }
      : node;
    case "workflow": return isObject(node.workflow) ? { ...node, workflow: without(node.workflow, "root") } : node;
    default: return node;
  }
};

/** The graph of `workflow`, computed from its JSON alone: nodes in document order (a node, then its descendants), and the
 *  edges between them. A value that is not a workflow, or a node the walk does not know, adds nothing and never throws:
 *  validation is `validateWorkflow`'s. */
export function workflowGraph(workflow: unknown): WorkflowGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const visit = (node: unknown, path: string, depth: number, schemas: Json): void => {
    if (!isObject(node) || typeof node.node !== "string" || depth > MAX_DEPTH) return;
    nodes.push({ path, kind: node.node, label: typeof node.label === "string" ? node.label : node.node,
      ...(node.node === "call" && typeof node.via === "string" ? { via: node.via } : {}), changeCheck: fnv1a(canonicalJson(ownFields(node))),
      ...decisionOf(node, schemas) });
    const child = (target: unknown, at: string, kind: GraphEdgeKind, from = path, inner = schemas): void => {
      if (!isObject(target) || typeof target.node !== "string" || depth + 1 > MAX_DEPTH) return;
      edges.push({ from, to: at, kind });
      visit(target, at, depth + 1, inner);
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
      case "workflow": if (isObject(node.workflow)) child(node.workflow.root, `${path}/workflow/root`, "child", path, isObject(node.workflow.schemas) ? node.workflow.schemas : {}); break;
    }
  };
  visit(isObject(workflow) ? workflow.root : undefined, "/root", 0, isObject(workflow) && isObject(workflow.schemas) ? workflow.schemas : {});
  return { nodes, edges };
}

/** The questions of a question schema (`out` of a judge or sift): a flat object whose properties are the questions, a
 *  string enum a choice, a boolean a noul, an integer a score; a local `#/definitions/<id>` reference is followed. */
const schemaQuestions = (schemaId: unknown, schemas: Json): GraphQuestion[] => {
  const root = typeof schemaId === "string" && Object.hasOwn(schemas, schemaId) ? schemas[schemaId] : undefined;
  const resolve = (spec: unknown): unknown => {
    for (let hops = 0; isObject(spec) && typeof spec.$ref === "string" && hops < 8; hops += 1) {
      const id = /^#\/definitions\/(.+)$/.exec(spec.$ref)?.[1];
      const inline = isObject(root) && isObject(root.definitions) ? root.definitions : {};
      spec = id === undefined ? undefined : Object.hasOwn(inline, id) ? inline[id] : Object.hasOwn(schemas, id) ? schemas[id] : undefined;
    }
    return spec;
  };
  const object = resolve(root);
  if (!isObject(object) || !isObject(object.properties)) return [];
  return Object.entries(object.properties).map(([id, raw]) => {
    const spec = resolve(raw);
    const instructions = isObject(spec) && typeof spec.description === "string" ? spec.description : "";
    const types = isObject(spec) ? (Array.isArray(spec.type) ? spec.type : [spec.type]).filter((type) => type !== "null") : [];
    if (isObject(spec) && Array.isArray(spec.enum)) return { id, type: "choice" as const, instructions, options: spec.enum.map(String) };
    if (types.length === 1 && types[0] === "boolean") return { id, type: "noul" as const, instructions };
    if (types.length === 1 && types[0] === "integer") return { id, type: "score" as const, instructions };
    return { id, type: "unknown" as const, instructions };
  });
};

/** A decision node's provider, model, questions and image tokens, as written. */
const decisionOf = (node: Json, schemas: Json): GraphDecision => {
  let source: Json = node;
  let questions: GraphQuestion[] | undefined;
  const text = (value: unknown): string => typeof value === "string" ? value : "";
  switch (node.node) {
    case "judge": case "sift": questions = schemaQuestions(node.out, schemas); break;
    case "pick": questions = [{ id: "pick", type: "choice", instructions: text(node.instructions) }]; break;
    case "route":
      if (node.valuePath !== undefined) return {};
      questions = [{ id: "branch", type: "choice", instructions: text(node.instructions), options: isObject(node.branches) ? Object.keys(node.branches) : [] }];
      break;
    case "loop": case "escalate": {
      const predicate = node.node === "loop" ? node.until : node.when;
      if (!isObject(predicate) || predicate.predicate !== "ask") return {};
      source = predicate;
      questions = [{ id: "holds", type: "noul", instructions: text(predicate.instructions) }];
      break;
    }
    default: return {};
  }
  return {
    ...(typeof source.provider === "string" ? { provider: source.provider } : {}),
    ...(typeof source.model === "string" ? { model: source.model } : {}),
    questions,
    ...(isObject(source.images) && Object.keys(source.images).length ? { images: Object.keys(source.images) } : {}),
  };
};

/** What a run has done at a node. A node inside a map's or a loop's body stands for every item or iteration, and the record names
 *  only those that started, so it is `done` only once the map or loop is: until then it is `working`, and a done node never
 *  goes back. A container (chain, parallel, map, loop, route, workflow) is `working` while some of
 *  its descendants are, or some are done and it is not; a node a run never reached, a branch a route did not take among
 *  them, is `not-run`. `escalated` is where the run ended on an escalation: the escalate node that fired and each container
 *  on its path. It is read from the run's terminal result, never from the frame, which holds no mark for that node. */
export type NodeState = "done" | "working" | "failed" | "not-run" | "escalated";

type Frame = { done?: unknown; steps?: unknown; inputs?: unknown; partial?: unknown };
/** The part of an `agentrun.items` value the status reads: the map item's `status` and its frame. */
export type ItemRecordLike = { map?: unknown; index?: unknown; status?: unknown; frame?: Frame };
/** The part of a run's terminal result the status reads: its `status` and, for an escalation, the execution path of the
 *  node it stopped at (`escalation.executionPath`, as `runWorkflow` returns it). */
export type TerminalResultLike = { status?: unknown; escalation?: { executionPath?: unknown } };
/** What `nodeStatus` reads: a driver frame (the `pin` of a frozen snapshot: `done`, `steps`, `inputs`), a frozen snapshot
 *  (its `pin`), or the map items' records, alone or together with the driver's record (`{ pin, items }`), and with it the
 *  run's terminal `result` once the run has ended. */
export type StatusSource = Frame | { pin: Frame; items?: readonly ItemRecordLike[]; result?: TerminalResultLike | null } | readonly ItemRecordLike[];

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
 *  one of those shows no node run. With the run's terminal `result`, an escalation that names a node of the graph marks
 *  that node and every container on its path `escalated`, and the maps and loops on that path have ended, so what finished
 *  inside them is done; without one, or when it names no node of the graph, nothing else changes. */
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
  // The node a run's escalation ended at, from its terminal result: by its execution path, as the node it ran as.
  const result = isObject(raw) && isObject(raw.pin) && isObject(raw.result) ? raw.result : undefined;
  const escalation = result?.status === "escalated" && isObject(result.escalation) ? result.escalation : undefined;
  const escalatedExecPath = typeof escalation?.executionPath === "string" ? escalation.executionPath : undefined;
  // When one map item or loop iteration is read on its own (`options.item`), the escalation belongs to this view only if
  // it fired inside that same instance: another item's escalation, reduced to the shared body, must not mark this one's
  // body escalated. The item index is in the raw execution path, which `definitionPath` then strips.
  const itemScope = typeof options.item === "string" ? options.item.replace(/\/$/, "") : undefined;
  const inThisItem = escalatedExecPath !== undefined
    && (itemScope === undefined || escalatedExecPath === itemScope || escalatedExecPath.startsWith(`${itemScope}/`));
  const stoppedAt = escalatedExecPath !== undefined && inThisItem ? definitionPath(escalatedExecPath) : undefined;
  const ended = stoppedAt !== undefined && graph.nodes.some((node) => node.path === stoppedAt) ? stoppedAt : undefined;
  const onPath = (path: string): boolean => ended !== undefined && (path === ended || ended.startsWith(`${path}/`));

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
  // A map or loop on an escalation's path has ended: no other item or iteration will run, so what finished inside it is done.
  const containers = graph.nodes.filter((node) => (node.kind === "map" || node.kind === "loop") && !onPath(node.path)
    && !(owner !== undefined && (node.path === owner || owner.startsWith(`${node.path}/body`))));
  for (const node of graph.nodes) {
    if (out[node.path] !== "done") continue;
    if (containers.some((container) => node.path.startsWith(`${container.path}/body`) && out[container.path] !== "done")) out[node.path] = "working";
  }
  // The run ended at the escalate node that fired, and in each container on its path; a failure recorded below a container
  // still shows.
  for (const node of graph.nodes) if (onPath(node.path) && (node.path === ended || out[node.path] !== "failed")) out[node.path] = "escalated";
  return out;
}

/** Where an execution path is in the graph: the node it ran at (`path`, a node of the graph) and the map items and loop
 *  iterations it ran in, outermost first. */
export type GraphNodeAt = { path: string; at: { kind: "item" | "iteration"; index: number }[] };

/** An item or iteration index as an execution path writes it: a whole number with no sign and no leading zero. */
const indexOf = (segment: string | undefined): number | undefined =>
  segment !== undefined && /^(0|[1-9][0-9]*)$/.test(segment) && Number.isSafeInteger(Number(segment)) ? Number(segment) : undefined;

/** The graph node an execution path ran at. An execution path is the node's JSON Pointer with two runtime segments added:
 *  a map's item (`items/<i>` before the map's `body`) and a loop's iteration (`iterations/<i>` before the loop's `body`); the
 *  graph has `/body` for both, and the indexes are returned in `at`. The path is read by walking the graph from `/root`, by
 *  each node's kind, never by matching its text, so a route branch named `items` or `iterations` is a branch. Undefined for
 *  a path the graph does not have, or one that is not an execution path (a map's `body` without an item, an item without
 *  its `body`). */
export function graphNodeOf(graph: WorkflowGraph, executionPath: string): GraphNodeAt | undefined {
  if (typeof executionPath !== "string") return undefined;
  const kinds = new Map(graph.nodes.map((node) => [node.path, node.kind]));
  const parts = executionPath.split("/");
  if (parts[0] !== "" || parts[1] !== "root" || !kinds.has("/root")) return undefined;
  let path = "/root";
  const at: GraphNodeAt["at"] = [];
  for (let i = 2; i < parts.length;) {
    const [first, second, third] = [parts[i], parts[i + 1], parts[i + 2]];
    let next: string | undefined;
    switch (kinds.get(path)) {
      case "chain":
        if (first === "steps" && indexOf(second) !== undefined) { next = `${path}/steps/${second}`; i += 2; }
        break;
      case "parallel":
        if (first === "branches" && indexOf(second) !== undefined) { next = `${path}/branches/${second}`; i += 2; }
        break;
      case "route":
        // The branch's name, pointer-escaped as in the graph, whatever it is: `items`, `iterations`, `0`, and the empty name a
        // route Jev chooses may give a branch, included.
        if (first === "branches" && second !== undefined && third === "body") { next = `${path}/branches/${second}/body`; i += 3; }
        break;
      case "workflow":
        if (first === "workflow" && second === "root") { next = `${path}/workflow/root`; i += 2; }
        break;
      case "map": {
        const index = indexOf(second);
        if (first === "items" && index !== undefined && third === "body") { at.push({ kind: "item", index }); next = `${path}/body`; i += 3; }
        break;
      }
      case "loop": {
        const index = indexOf(second);
        if (first === "iterations" && index !== undefined && third === "body") { at.push({ kind: "iteration", index }); next = `${path}/body`; i += 3; }
        break;
      }
    }
    if (next === undefined || !kinds.has(next)) return undefined;
    path = next;
  }
  return { path, at };
}

/** A node as `graphDiff` reports it: its path in the graph it is in, its kind and its label. */
export type GraphDiffNode = { path: string; kind: string; label: string };
/** What changed from one graph to the next. `added` holds nodes of `next` only (paths in `next`), `removed` nodes of `prev`
 *  only (paths in `prev`); `changed` the same node at the same path with a new kind or label; `moved` the same node at a
 *  new path; `rewritten` the same node, its kind and label as they were, with other own fields changed (its `changeCheck`
 *  differs: new instructions, a new budget), at its path in each graph; `edges.added` edges of `next` only and
 *  `edges.removed` edges of `prev` only, each in its own graph's paths. */
export type GraphDiff = {
  added: GraphDiffNode[];
  removed: GraphDiffNode[];
  changed: { prev: string; next: string; was: { kind: string; label: string }; now: { kind: string; label: string } }[];
  moved: { prev: string; next: string }[];
  rewritten: { prev: string; next: string; kind: string; label: string }[];
  edges: { added: GraphEdge[]; removed: GraphEdge[] };
};

/** What changed between two graphs of a workflow, such as two saved revisions of one. A node is the same in both when its
 *  `(kind, label)` is unique in each graph, wherever it is: a step inserted before others is one `added` node and the rest
 *  `moved`, never a run of changes. A node whose `(kind, label)` repeats in either graph, or is in one only, is the same
 *  as the other graph's node at its path, unless that node is already matched by its identity; with a new kind or label
 *  it is `changed`. A matched node with its kind and label as they were and another `changeCheck` is `rewritten`; a node
 *  without a check in either graph is never reported rewritten. An edge is the same when both its ends are the same nodes
 *  and its kind is the same. Every list is in its graph's node or edge order. */
export function graphDiff(prev: WorkflowGraph, next: WorkflowGraph): GraphDiff {
  const identity = (node: GraphNode): string => JSON.stringify([node.kind, node.label]);
  const counts = (graph: WorkflowGraph): Map<string, number> => {
    const count = new Map<string, number>();
    for (const node of graph.nodes) count.set(identity(node), (count.get(identity(node)) ?? 0) + 1);
    return count;
  };
  const [inPrev, inNext] = [counts(prev), counts(next)];
  const unique = (node: GraphNode): boolean => inPrev.get(identity(node)) === 1 && inNext.get(identity(node)) === 1;
  // The matched nodes, each way: a path of `next` to its node's path in `prev`, and back.
  const prevOf = new Map<string, string>();
  const nextOf = new Map<string, string>();
  const match = (from: string, to: string): void => { prevOf.set(to, from); nextOf.set(from, to); };
  const uniqueInPrev = new Map(prev.nodes.filter(unique).map((node) => [identity(node), node.path]));
  for (const node of next.nodes) {
    const at = unique(node) ? uniqueInPrev.get(identity(node)) : undefined;
    if (at !== undefined) match(at, node.path);
  }
  const prevAt = new Map(prev.nodes.map((node) => [node.path, node]));
  const changed: GraphDiff["changed"] = [];
  for (const node of next.nodes) {
    const old = prevAt.get(node.path);
    if (prevOf.has(node.path) || old === undefined || nextOf.has(old.path)) continue;
    match(old.path, node.path);
    if (old.kind !== node.kind || old.label !== node.label) {
      changed.push({ prev: old.path, next: node.path, was: { kind: old.kind, label: old.label }, now: { kind: node.kind, label: node.label } });
    }
  }
  const rewritten: GraphDiff["rewritten"] = [];
  for (const node of next.nodes) {
    const from = prevOf.get(node.path);
    const old = from === undefined ? undefined : prevAt.get(from);
    if (old === undefined || old.kind !== node.kind || old.label !== node.label) continue;
    if (old.changeCheck !== undefined && node.changeCheck !== undefined && old.changeCheck !== node.changeCheck) {
      rewritten.push({ prev: old.path, next: node.path, kind: node.kind, label: node.label });
    }
  }
  const reported = ({ path, kind, label }: GraphNode): GraphDiffNode => ({ path, kind, label });
  const edgeKey = (from: string, to: string, kind: GraphEdgeKind): string => JSON.stringify([from, to, kind]);
  const prevEdges = new Set(prev.edges.map((edge) => edgeKey(edge.from, edge.to, edge.kind)));
  const nextEdges = new Set(next.edges.map((edge) => edgeKey(edge.from, edge.to, edge.kind)));
  // Whether the other graph has this edge: both its ends matched there, joined by an edge of the same kind.
  const theirs = (edge: GraphEdge, map: Map<string, string>, edges: Set<string>): boolean => {
    const [from, to] = [map.get(edge.from), map.get(edge.to)];
    return from !== undefined && to !== undefined && edges.has(edgeKey(from, to, edge.kind));
  };
  return {
    added: next.nodes.filter((node) => !prevOf.has(node.path)).map(reported),
    removed: prev.nodes.filter((node) => !nextOf.has(node.path)).map(reported),
    changed,
    moved: next.nodes.flatMap((node) => {
      const from = prevOf.get(node.path);
      return from !== undefined && from !== node.path ? [{ prev: from, next: node.path }] : [];
    }),
    rewritten,
    edges: {
      added: next.edges.filter((edge) => !theirs(edge, prevOf, prevEdges)).map(({ from, to, kind }) => ({ from, to, kind })),
      removed: prev.edges.filter((edge) => !theirs(edge, nextOf, nextEdges)).map(({ from, to, kind }) => ({ from, to, kind })),
    },
  };
}
