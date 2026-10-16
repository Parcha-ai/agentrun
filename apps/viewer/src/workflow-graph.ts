// The workflow graph: the job's workflow drawn as its nodes and edges, each node marked by what the run did there at the
// stop: done, working, failed or not run. Both are the DSL's own (packages/dsl/src/graph.ts, read from its source at build
// time): `workflowGraph` of the workflow in the job blob the manifest names, and `nodeStatus` of the driver's record at the
// stop (./node-status.ts keeps it), so this panel draws what the DSL says and decides no status itself. A panel
// (PANELS.md): `accepts`, `reduce` and `view` are pure, so a scrub is a replay. A recording whose manifest names no job is
// not drawn.
import { nodeStatus, workflowGraph, type NodeState } from '../../../packages/dsl/src/graph.ts';
import { under, type Json, type Manifest } from './format.ts';
import { docOf } from './durable.ts';
import { runRecordAccepts, runRecordInit, runRecordReduce, statusSource, type RunRecord } from './node-status.ts';
import { h, register, type Node, type Panel } from './panels.ts';

const wgIsObj = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
const WG_TEXT: Record<NodeState, string> = { done: 'done', working: 'working', failed: 'failed', 'not-run': 'not run' };
/** A focused execution path as the node it ran (each map item's and loop iteration's index taken out), for dimming. */
const wgNodeOf = (path: string) => path.replace(/\/items\/\d+\/body/g, '/body').replace(/\/iterations\/\d+(?=\/|$)/g, '');

export const workflowGraphPanel: Panel<RunRecord> = {
  id: 'workflow-graph',
  title: 'The workflow',
  init: runRecordInit,
  accepts: runRecordAccepts,
  showsFor: (manifest: Manifest) => typeof manifest.job?.blob === 'string',
  shows: (line) => { const doc = docOf(line); return doc !== undefined && doc.doc === 'agentrun.driver'; },
  reduce: runRecordReduce,
  view(state, { json, job, focus }) {
    const read = job !== undefined ? json?.(job) : undefined;
    if (read === undefined) return h('div', { class: 'workflow-graph' }, h('p', { class: 'empty' }, 'The job that ran is not read yet.'));
    const graph = wgIsObj(read) && read.workflow !== undefined ? workflowGraph(read.workflow) : undefined;
    if (!graph || graph.nodes.length === 0) return h('div', { class: 'workflow-graph' }, h('p', { class: 'empty' }, 'The job holds no workflow this viewer can draw.'));
    const statuses = nodeStatus(graph, statusSource(state) as Parameters<typeof nodeStatus>[1]);
    const byPath = new Map(graph.nodes.map((node) => [node.path, node]));
    const into = new Set(graph.edges.map((edge) => edge.to));
    const nextOf = new Map(graph.edges.filter((edge) => edge.kind === 'next').map((edge) => [edge.from, edge.to]));
    const inner = (path: string) => graph.edges.filter((edge) => edge.from === path && edge.kind !== 'next');
    const seen = new Set<string>();
    const dim = (path: string) => (focus !== undefined && !under(wgNodeOf(focus), path) && !under(path, wgNodeOf(focus)) ? ' dim' : '');
    // A chain of nodes from `start` along its `next` edges, each with what it opens into (a branch, a route, an item, a child).
    const chain = (start: string): Node[] => {
      const out: Node[] = [];
      for (let at: string | undefined = start; at !== undefined && !seen.has(at); at = nextOf.get(at)) {
        seen.add(at);
        const node = byPath.get(at);
        if (!node) continue;
        const status = statuses[node.path] ?? 'not-run';
        // The parts keep a space between them, so the row reads as words when it is copied or read aloud (the page sets them apart).
        const parts = [h('span', { class: 'wg-kind' }, node.kind), h('span', { class: 'wg-label' }, node.label),
          ...(node.via !== undefined ? [h('span', { class: 'wg-via' }, `via ${node.via}`)] : []), h('span', { class: 'wg-status' }, WG_TEXT[status])];
        out.push(h('li', { class: `wg-node ${node.kind} ${status}${dim(node.path)}`, title: node.path },
          ...parts.flatMap((part, index) => (index === 0 ? [part] : [' ', part])),
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

register(workflowGraphPanel);
