// The workflow graph: the job's workflow drawn as its nodes and edges, each node marked by what the run did there at the
// stop: done, working, failed or not run. Both are the DSL's own (packages/dsl/src/graph.ts, read from its source at build
// time): `workflowGraph` of the workflow in the job blob the manifest names, and `nodeStatus` of the driver's record at the
// stop (./node-status.ts keeps it), so this panel draws what the DSL says and decides no status itself. A panel
// (PANELS.md): `accepts`, `reduce` and `view` are pure, so a scrub is a replay. A recording whose manifest names no job is
// not drawn.
import { graphNodeOf, nodeStatus, workflowGraph } from '../../../packages/dsl/src/graph.ts';
import { under, type Json, type Manifest } from './format.ts';
import { docOf } from './durable.ts';
import { runRecordAccepts, runRecordInit, runRecordReduce, statusSource, type RunRecord } from './node-status.ts';
import { graphTree } from './graph-draw.ts';
import { h, register, type Panel } from './panels.ts';

const wgIsObj = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

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
    // A focused execution path as the node it ran, by the DSL's walk of the graph.
    const focused = focus === undefined ? undefined : graphNodeOf(graph, focus)?.path ?? focus;
    const dim = (path: string) => (focused !== undefined && !under(focused, path) && !under(path, focused) ? ' dim' : '');
    return h('div', { class: 'workflow-graph' }, graphTree(graph, statuses, { dim }));
  },
};

register(workflowGraphPanel);
