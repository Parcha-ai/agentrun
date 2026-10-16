// The workflow graph: the job's workflow drawn as its nodes and edges (the DSL's `workflowGraph`, from the job blob the
// manifest names), each node marked by what the run did there at the stop: done, running, failed or not reached. Its
// status comes from the durable lines (the driver's checkpoint, `agentrun.driver`, and in the keyed layout each map item's
// `agentrun.items` record) and from the live workflow events (a node started and not ended). A panel (PANELS.md): `accepts`,
// `reduce` and `view` are pure, so a scrub is a replay. A recording whose manifest names no job is not drawn.
import { under, type Json, type Manifest } from './format.ts';
import { docOf } from './durable.ts';
import { graphPathOf, nodeStatusAccepts, nodeStatuses, nodeStatusInit, nodeStatusReduce, type NodeStatus, type NodeStatusState } from './node-status.ts';
import { h, register, type Node, type Panel } from './panels.ts';

/** A node of the workflow: `path` is a JSON Pointer into the workflow document, `kind` its node kind, `via` what it goes
 *  through when it has one (a tool, a child workflow). */
export type GraphNode = { path: string; kind: string; label: string; via?: string };
/** An edge: `next` in a chain, `branch` into a parallel branch, `route` into a route's branch, `item` into a map's body,
 *  `child` into a child workflow. */
export type GraphEdge = { from: string; to: string; kind: 'next' | 'branch' | 'route' | 'item' | 'child' };
export type WorkflowGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

const wgIsObj = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
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
export function workflowGraphPanel(graphOf: GraphOf): Panel<NodeStatusState> {
  return {
    id: 'workflow-graph',
    title: 'The workflow',
    init: nodeStatusInit,
    accepts: nodeStatusAccepts,
    showsFor: (manifest: Manifest) => typeof manifest.job?.blob === 'string',
    shows: (line) => { const doc = docOf(line); return doc !== undefined && doc.doc === 'agentrun.driver'; },
    reduce: nodeStatusReduce,
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
