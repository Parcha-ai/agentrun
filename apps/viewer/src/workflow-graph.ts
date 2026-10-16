// The workflow graph: the job's workflow drawn as its nodes and edges (the DSL's `workflowGraph`, from the job blob the
// manifest names), each node marked by what the run did there at the stop: done, running, failed or not reached. Its
// status comes from the durable lines (the driver's checkpoint, `agentrun.driver`, and in the keyed layout each map item's
// `agentrun.items` record) and from the live workflow events (a node started and not ended). A panel (PANELS.md): `accepts`,
// `reduce` and `view` are pure, so a scrub is a replay. A recording whose manifest names no job is not drawn.
import { under, type Json, type Line, type Manifest } from './format.ts';
import { donePathsOf } from './audit-read.ts';
import { docOf } from './durable.ts';
import { h, register, type Node, type Panel } from './panels.ts';

/** A node of the workflow: `path` is a JSON Pointer into the workflow document, `kind` its node kind, `via` what it goes
 *  through when it has one (a tool, a child workflow). */
export type GraphNode = { path: string; kind: string; label: string; via?: string };
/** An edge: `next` in a chain, `branch` into a parallel branch, `route` into a route's branch, `item` into a map's body,
 *  `child` into a child workflow. */
export type GraphEdge = { from: string; to: string; kind: 'next' | 'branch' | 'route' | 'item' | 'child' };
export type WorkflowGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** The workflow node an execution path ran: the path with each instance it names taken out (a map item's or a loop
 *  iteration's index before its `body`), so every item of a map is the one node of its body. */
export const graphPathOf = (path: string): string => path.replace(/\/(?:items|iterations)\/(?:0|[1-9]\d*)(?=\/body(?:\/|$))/g, '');

type WgItem = { status: string; done: string[] };
type WgState = {
  /** The execution paths the driver's latest checkpoint lists as done. */
  done: string[];
  /** Each map item's latest `agentrun.items` record (the keyed layout), by the item's path. */
  items: Record<string, WgItem>;
  /** The item paths the driver keeps in `pin.failures` (a collecting map's failed items). */
  failures: string[];
  /** The execution paths a live `node.start` named and no `node.end` has since, in the process that is running. */
  started: string[];
  /** The commit of the open whose snapshot lines are arriving, while they arrive. */
  snapshotAt: number | undefined;
};

const wgIsObj = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
const wgStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : []);

/** Each node's count of the instances the run reached there: done, running, failed. */
export type NodeStatus = { done: number; running: number; failed: number };
export function nodeStatuses(state: WgState): Map<string, NodeStatus> {
  const out = new Map<string, NodeStatus>();
  const bump = (path: string, field: keyof NodeStatus) => {
    const at = graphPathOf(path);
    const now = out.get(at) ?? { done: 0, running: 0, failed: 0 };
    out.set(at, { ...now, [field]: now[field] + 1 });
  };
  const done = new Set(state.done);
  for (const [item, record] of Object.entries(state.items)) {
    for (const path of record.done) done.add(path);
    if (record.status === 'committed') done.add(`${item}/body`);
    else if (record.status === 'failed') bump(`${item}/body`, 'failed');
    else if (record.status === 'running' && !done.has(`${item}/body`)) bump(`${item}/body`, 'running');
  }
  for (const item of state.failures) if (!Object.hasOwn(state.items, item)) bump(`${item}/body`, 'failed');
  for (const path of done) bump(path, 'done');
  for (const path of state.started) if (!done.has(path)) bump(path, 'running');
  return out;
}

const wgStatusClass = (status: NodeStatus | undefined) =>
  !status ? 'pending' : status.failed > 0 ? 'failed' : status.running > 0 ? 'running' : status.done > 0 ? 'done' : 'pending';
const wgStatusText = (status: NodeStatus | undefined) => {
  if (!status) return 'not reached';
  const parts = [status.done && `${status.done} done`, status.running && `${status.running} running`, status.failed && `${status.failed} failed`].filter(Boolean);
  return parts.join(', ') || 'not reached';
};

/** The graph the job's workflow is, or undefined when there is none to read yet. */
export type GraphOf = (workflow: Json) => WorkflowGraph | undefined;

/** The panel, given the function that turns a workflow into its graph (the DSL's `workflowGraph`). */
export function workflowGraphPanel(graphOf: GraphOf): Panel<WgState> {
  return {
    id: 'workflow-graph',
    title: 'The workflow',
    init: () => ({ done: [], items: {}, failures: [], started: [], snapshotAt: undefined }),
    accepts: (line) => {
      if (line.source === 'host') return line.kind === 'kill' || line.kind === 'process.started';
      if (line.channel === 'live') return line.source === 'workflow' && (line.kind === 'node.start' || line.kind === 'node.end') && typeof line.path === 'string';
      const doc = docOf(line);
      return doc !== undefined && (doc.doc === 'agentrun.driver' || doc.doc === 'agentrun.items');
    },
    showsFor: (manifest: Manifest) => typeof manifest.job?.blob === 'string',
    shows: (line) => { const doc = docOf(line); return doc !== undefined && doc.doc === 'agentrun.driver'; },
    reduce(state, line) {
      // A process that ends runs nothing more; the next one's snapshot says where the run stands.
      if (line.source === 'host') return state.started.length ? { ...state, started: [] } : state;
      if (line.channel === 'live') {
        const path = line.path!;
        if (line.kind === 'node.start') return state.started.includes(path) ? state : { ...state, started: [...state.started, path] };
        return { ...state, started: state.started.filter((each) => each !== path) };
      }
      const doc = docOf(line)!;
      // An open's snapshot carries the checkpoint and every item record as they stand, so a new snapshot starts over.
      let next = state;
      if (line.snapshot === true) {
        if (state.snapshotAt !== line.commit) next = { ...state, done: [], items: {}, failures: [], snapshotAt: line.commit };
      } else if (state.snapshotAt !== undefined) next = { ...state, snapshotAt: undefined };
      if (doc.doc === 'agentrun.driver') {
        const pin = wgIsObj(doc.value) && wgIsObj(doc.value.state) ? doc.value.state.pin : undefined;
        return { ...next, done: donePathsOf(doc) ?? [], failures: wgIsObj(pin) && wgIsObj(pin.failures) ? Object.keys(pin.failures) : [] };
      }
      const item = doc.key?.split('\u0000').at(-1);
      if (item === undefined || !wgIsObj(doc.value)) return next;
      const frame = doc.value.frame;
      return { ...next, items: { ...next.items, [item]: { status: String(doc.value.status), done: wgIsObj(frame) ? wgStrings(frame.done) : [] } } };
    },
    view(state, { json, job, focus }) {
      const read = job !== undefined ? json?.(job) : undefined;
      if (read === undefined) return h('div', { class: 'workflow-graph' }, h('p', { class: 'empty' }, 'The job that ran is not read yet.'));
      const graph = wgIsObj(read) && read.workflow !== undefined ? graphOf(read.workflow) : undefined;
      if (!graph) return h('div', { class: 'workflow-graph' }, h('p', { class: 'empty' }, 'The job holds no workflow this viewer can draw.'));
      const statuses = nodeStatuses(state);
      const byPath = new Map(graph.nodes.map((node) => [node.path, node]));
      const into = new Set(graph.edges.map((edge) => edge.to));
      const nextOf = new Map(graph.edges.filter((edge) => edge.kind === 'next').map((edge) => [edge.from, edge.to]));
      const inner = (path: string) => graph.edges.filter((edge) => edge.from === path && edge.kind !== 'next');
      const seen = new Set<string>();
      const dim = (path: string) => (focus !== undefined && !under(graphPathOf(focus), path) && !under(path, graphPathOf(focus)) ? ' dim' : '');
      // A chain of nodes from `start` along its `next` edges, each with what it opens into (a branch, a route, an item, a child).
      const chain = (start: string): Node[] => {
        const out: Node[] = [];
        for (let at: string | undefined = start; at !== undefined && !seen.has(at); at = nextOf.get(at)) {
          seen.add(at);
          const node = byPath.get(at);
          if (!node) continue;
          const status = statuses.get(node.path);
          out.push(h('li', { class: `wg-node ${node.kind} ${wgStatusClass(status)}${dim(node.path)}`, title: node.path },
            h('span', { class: 'wg-kind' }, node.kind),
            h('span', { class: 'wg-label' }, node.label),
            node.via !== undefined && h('span', { class: 'wg-via' }, `via ${node.via}`),
            h('span', { class: 'wg-status' }, wgStatusText(status)),
            ...inner(node.path).map((edge) => h('div', { class: `wg-into ${edge.kind}` }, h('span', { class: 'wg-edge' }, edge.kind), h('ol', {}, ...chain(edge.to))))));
        }
        return out;
      };
      const roots = graph.nodes.filter((node) => !into.has(node.path)).map((node) => node.path);
      const drawn = roots.flatMap(chain);
      // A node no edge reaches from a root is still drawn, after the rest, so none is left out.
      const rest = graph.nodes.filter((node) => !seen.has(node.path)).flatMap((node) => chain(node.path));
      return h('div', { class: 'workflow-graph' }, h('ol', { class: 'wg-chain' }, ...drawn, ...rest));
    },
  };
}

/** The workflow's graph: the DSL's `workflowGraph` once its module is wired in; until then none, and the panel says so. */
const graphOfWorkflow: GraphOf = () => undefined;

export const workflowGraph = workflowGraphPanel(graphOfWorkflow);
register(workflowGraph);
