// The workflow runs a recording holds, for the chat view: one per task that has an `agentrun.workflow` line, every node
// keyed by (task, path). A run's definition is its line's (`data.input.workflow`), else the job's the manifest names; its
// graph and each node's status are the DSL's (`workflowGraph`, `nodeStatus`, inlined at build time). A line is a task's by
// its own `task`, by being the task's record, or by the run's journal key its document is keyed by (RECORDING.md section
// 5: the driver's and `agentrun.task`'s key, `<journal>\u0000...` for items, states and effects, `<journal>:...` for a
// node attempt). A live node line names no task: it is the latest begun of the runs begun by its time whose graph holds its
// node. Pure.
import { nodeStatus, workflowGraph, type NodeState, type WorkflowGraph } from '../../../packages/dsl/src/graph.ts';
import { under, type Json, type Line } from './format.ts';
import { docOf } from './durable.ts';
import { graphNodeOf } from './graph-draw.ts';
import { runRecordAccepts, runRecordInit, runRecordReduce, statusSource } from './node-status.ts';

/** One workflow run: its task, its title (the workflow's label, else its name), its graph, when its task began, the tool
 *  call that started it (`call`, a chat item's id, when the recording says so), each node's live runs by the node's path,
 *  the driver's record after each of its lines, and the conversations each node held, by the node's path. */
export type ChatWorkflow = {
  id: string; task: string; title: string; graph: WorkflowGraph; t0: number; call?: string;
  spans: { path: string; t0: number; t1?: number }[];
  records: { t: number; source: { pin: Json; items: Json[] } }[];
  conversations: Record<string, string[]>;
};

type CwObj = { [key: string]: Json };
const cwObj = (value: Json | undefined): CwObj | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
const cwId = (value: Json | undefined): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined);
/** An `agentrun.workflow` task line (a task record, not a document). */
const cwTaskLine = (line: Line) => line.channel === 'durable' && line.kind === 'agentrun.workflow' && docOf(line) === undefined && cwObj(line.data) !== undefined;

/** The workflow runs in `lines`, in the order their tasks began, and the task each line is (undefined: none). `job` is
 *  the workflow of the job the manifest names, for a task whose line names none. */
export function chatWorkflowsOf(lines: readonly Line[], job?: Json): { runs: ChatWorkflow[]; taskOf: (line: Line) => string | undefined } {
  const begun = new Map<string, { t0: number; workflow?: Json; journal?: string }>();
  for (const line of lines) {
    if (!cwTaskLine(line)) continue;
    const data = cwObj(line.data)!;
    const task = cwId(data.id) ?? line.task;
    if (task === undefined) continue;
    const input = cwObj(data.input);
    const was = begun.get(task);
    begun.set(task, { t0: Math.min(was?.t0 ?? line.t, line.t), workflow: was?.workflow ?? input?.workflow, journal: was?.journal ?? cwId(input?.key) });
  }
  const journals = new Map<string, string>();
  for (const [task, run] of begun) if (run.journal !== undefined) journals.set(run.journal, task);
  for (const line of lines) {
    const doc = docOf(line);
    const task = doc?.doc === 'agentrun.task' && doc.key !== undefined ? cwId(cwObj(doc.value)?.task) : undefined;
    if (task !== undefined && begun.has(task) && !journals.has(doc!.key!)) journals.set(doc!.key!, task);
  }
  const graphs = new Map<string, WorkflowGraph>();
  for (const [task, run] of begun) {
    const graph = workflowGraph(run.workflow ?? job);
    if (graph.nodes.length > 0) graphs.set(task, graph);
  }
  const byJournal = (key: string): string | undefined => {
    if (journals.has(key)) return journals.get(key);
    const nul = key.indexOf('\u0000');
    if (nul > 0 && journals.has(key.slice(0, nul))) return journals.get(key.slice(0, nul));
    let found: [string, string] | undefined;
    for (const [journal, task] of journals) if (key.startsWith(`${journal}:`) && (!found || journal.length > found[0].length)) found = [journal, task];
    return found?.[1];
  };
  const order = [...begun].filter(([task]) => graphs.has(task)).sort(([, a], [, b]) => a.t0 - b.t0);
  const live = (line: Line) => line.channel === 'live' && (line.kind === 'node.start' || line.kind === 'node.end') && line.path !== undefined;
  const taskOf = (line: Line): string | undefined => {
    if (line.task !== undefined && begun.has(line.task)) return line.task;
    if (cwTaskLine(line)) return cwId(cwObj(line.data)!.id) ?? line.task;
    const key = docOf(line)?.key;
    if (key !== undefined) return byJournal(key);
    if (!live(line)) return undefined;
    const node = graphNodeOf(line.path!);
    return order.filter(([task, run]) => run.t0 <= line.t && graphs.get(task)!.nodes.some((each) => each.path === node)).at(-1)?.[0];
  };

  const runs: ChatWorkflow[] = order.map(([task, run]) => {
    const workflow = cwObj(run.workflow ?? job);
    const label = cwId(workflow?.label) ?? cwId(workflow?.name);
    return { id: `workflow-${task}`, task, title: label ?? 'workflow', graph: graphs.get(task)!, t0: run.t0, spans: [], records: [], conversations: {} };
  });
  const runOf = new Map(runs.map((run) => [run.task, run]));
  const records = new Map(runs.map((run) => [run.task, runRecordInit()]));
  const open = new Map<string, { path: string; t0: number; t1?: number }[]>();
  for (const line of lines) {
    const task = taskOf(line);
    const run = task === undefined ? undefined : runOf.get(task);
    if (!run) continue;
    if (live(line)) {
      const at = `${task}\u0000${line.path}`;
      if (line.kind === 'node.start') {
        const span = { path: graphNodeOf(line.path!), t0: line.t };
        run.spans.push(span);
        open.set(at, [...(open.get(at) ?? []), span]);
      } else {
        const span = open.get(at)?.pop();
        if (span) span.t1 = line.t;
      }
      continue;
    }
    if (runRecordAccepts(line)) {
      const record = runRecordReduce(records.get(run.task)!, line);
      records.set(run.task, record);
      run.records.push({ t: line.t, source: statusSource(record) });
    }
    const doc = docOf(line);
    const conversation = doc?.doc === 'agentrun.nodes' ? cwId(cwObj(doc.value)?.conversation) : undefined;
    if (conversation !== undefined && line.path !== undefined) {
      const node = graphNodeOf(line.path);
      const held = run.conversations[node] ?? [];
      if (!held.includes(conversation)) run.conversations[node] = [...held, conversation];
    }
  }
  return { runs, taskOf };
}

/** What the run had done at each node at time `t`: done or failed as the DSL's `nodeStatus` says of the driver's latest
 *  record at or before `t`; working when a live run of the node had begun by `t` and not ended, or `nodeStatus` says so;
 *  else not run. A node that holds others is working while one of them has begun and it is not done. */
export function chatWorkflowStatusAt(run: ChatWorkflow, t: number): Record<string, NodeState> {
  const record = run.records.filter((each) => each.t <= t).at(-1);
  const said = record ? nodeStatus(run.graph, record.source as Parameters<typeof nodeStatus>[1]) : {};
  const out: Record<string, NodeState> = {};
  for (const node of run.graph.nodes) {
    const state = said[node.path] ?? 'not-run';
    const running = run.spans.some((span) => span.path === node.path && span.t0 <= t && (span.t1 === undefined || span.t1 > t));
    out[node.path] = state === 'done' || state === 'failed' ? state : running ? 'working' : state;
  }
  for (const node of run.graph.nodes) {
    if (out[node.path] === 'not-run' && run.graph.nodes.some((other) => other.path !== node.path && under(other.path, node.path) && out[other.path] !== 'not-run')) out[node.path] = 'working';
  }
  return out;
}
