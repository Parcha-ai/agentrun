// A workflow graph drawn as a tree of nodes, each in its chain with what it opens into (a chain's steps, a loop's body,
// a branch, a route's branches, a map's body, a child workflow) under it, and marked with the status it is given. One
// drawing for the inspection view's panel (workflow-graph.ts) and the chat view (chat-view.ts); what a status is, is the
// caller's (the DSL's `nodeStatus`). Pure: a tree of plain nodes, which the panels' `Node` takes as it is.
import type { GraphEdge, NodeState, WorkflowGraph } from '../../../packages/dsl/src/graph.ts';
import { under } from './format.ts';

export type GraphTree = string | { tag: string; class?: string; title?: string; path?: string; children?: GraphTree[] };
/** A node's mark: the DSL's `NodeState`, and, once an execution has ended, where it escalated and the nodes it stopped in. */
export type GraphStatus = NodeState | 'escalated' | 'stopped';
export const GRAPH_STATUS_TEXT: Record<GraphStatus, string> = { done: 'done', working: 'working', failed: 'failed', 'not-run': 'not run', escalated: 'escalated', stopped: 'stopped' };

const gdEl = (tag: string, props: { class?: string; title?: string; path?: string }, ...children: GraphTree[]): GraphTree => ({ tag, ...props, children });

/** The nodes of `graph` as nested lists, each node marked with `statuses[path]` (not run when absent). `dim` adds a class to
 *  a node outside a focus. `row`: the tag each node's parts are wrapped in, with the node's path on it, for a page that
 *  acts on a node; without it, the parts sit in the node's item as they are. */
export function graphTree(graph: WorkflowGraph, statuses: Record<string, GraphStatus>, { dim, row }: { dim?: (path: string) => string; row?: string } = {}): GraphTree {
  const byPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const into = new Set(graph.edges.map((edge) => edge.to));
  // A `next` edge to a node under its source enters a chain's first step or a loop's body, drawn inside it; one to a node
  // beside it goes on to the step after. A nested chain or loop has both, so each is kept apart.
  const enters = (edge: GraphEdge) => edge.kind === 'next' && under(edge.to, edge.from);
  const nextOf = new Map(graph.edges.filter((edge) => edge.kind === 'next' && !enters(edge)).map((edge) => [edge.from, edge.to]));
  const inner = (path: string) => graph.edges.filter((edge) => edge.from === path && (edge.kind !== 'next' || enters(edge)));
  const seen = new Set<string>();
  const chain = (start: string): GraphTree[] => {
    const out: GraphTree[] = [];
    for (let at: string | undefined = start; at !== undefined && !seen.has(at); at = nextOf.get(at)) {
      seen.add(at);
      const node = byPath.get(at);
      if (!node) continue;
      const status = statuses[node.path] ?? 'not-run';
      // The parts keep a space between them, so the row reads as words when it is copied or read aloud (the page sets them apart).
      const parts = [gdEl('span', { class: 'wg-kind' }, node.kind), gdEl('span', { class: 'wg-label' }, node.label),
        ...(node.via !== undefined ? [gdEl('span', { class: 'wg-via' }, `via ${node.via}`)] : []), gdEl('span', { class: 'wg-status' }, GRAPH_STATUS_TEXT[status])];
      const spaced = parts.flatMap((part, index) => (index === 0 ? [part] : [' ', part]));
      out.push(gdEl('li', { class: `wg-node ${node.kind} ${status}${dim?.(node.path) ?? ''}`, title: node.path },
        ...(row !== undefined ? [gdEl(row, { class: 'wg-row', path: node.path }, ...spaced)] : spaced),
        ...inner(node.path).map((edge) => gdEl('div', { class: `wg-into ${edge.kind}` }, ...(enters(edge) ? [] : [gdEl('span', { class: 'wg-edge' }, edge.kind)]), gdEl('ol', {}, ...chain(edge.to))))));
    }
    return out;
  };
  const roots = graph.nodes.filter((node) => !into.has(node.path)).map((node) => node.path);
  const drawn = roots.flatMap(chain);
  // A node no edge reaches from a root is still drawn, after the rest, so none is left out.
  const rest = graph.nodes.filter((node) => !seen.has(node.path)).flatMap((node) => chain(node.path));
  return gdEl('ol', { class: 'wg-chain' }, ...drawn, ...rest);
}
