// The workflow executions a recording holds, for the chat view: one per run key, every node keyed by (run key, execution
// path). An execution is an `agentrun.workflow` task (its latest line per task id); its run key is the task's
// `data.input.key`, and its graph is the DSL's `workflowGraph` of the task's `data.input.workflow`. Each document of the
// execution joins on the run key (RECORDING.md section 5): the driver's and `agentrun.task`'s key is it, items, states and
// effects are keyed `<run key>\u0000...`, a node attempt `<run key>:<name>:step:<path>:a<n>`. A live node line names no
// run: it is an execution's only when that execution is the one open at its place (begun, not ended) whose graph holds
// its node; else no execution takes it. An execution path is mapped to its graph node by the DSL's walk (`graphNodeOf`),
// never by its text. Status is the DSL's `nodeStatus`. Pure.
import { graphNodeOf, nodeStatus, workflowGraph, type NodeState, type WorkflowGraph } from '../../../packages/dsl/src/graph.ts';
import { under, type Json, type Line } from './format.ts';
import { docOf } from './durable.ts';
import type { GraphStatus } from './graph-draw.ts';
import { runRecordAccepts, runRecordInit, runRecordReduce, statusSource } from './node-status.ts';

/** How an execution ended, from its task's terminal state (`state.outcome`): completed with a complete result, completed
 *  with an escalated one (where it stopped: the escalation's execution path, label and summary), failed or aborted. */
export type ChatOutcome = { status: 'complete' | 'failed' | 'aborted' } | { status: 'escalated'; path?: string; label?: string; summary?: string };

/** One execution: its run key, its title (the workflow's label, else its name), its graph, the place of its first line,
 *  the conversation that started it, the tool call that did (`call`, a chat item's id, when the recording says so), how it
 *  ended and the place of its first terminal line, each node's live runs by the node's graph path, the driver's record
 *  after each of its lines, and the conversations each node held, by the node's graph path. */
export type ChatWorkflow = {
  id: string; key: string; title: string; graph: WorkflowGraph; t0: number; conversation?: string; call?: string;
  outcome?: ChatOutcome & { t: number };
  spans: { path: string; t0: number; t1?: number }[];
  records: { t: number; source: { pin: Json; items: Json[] } }[];
  conversations: Record<string, string[]>;
};

type CwObj = { [key: string]: Json };
const cwObj = (value: Json | undefined): CwObj | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
const cwId = (value: Json | undefined): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined);
/** An `agentrun.workflow` task line (a task record, not a document). */
const cwTaskLine = (line: Line) => line.channel === 'durable' && line.kind === 'agentrun.workflow' && cwObj(line.data) !== undefined && cwObj(line.data)!.doc === undefined;

/** A task's terminal outcome (VIZ-DATA-CONTRACT section 1, "The answer"), undefined while it has none. */
function cwOutcomeOf(state: CwObj | undefined): ChatOutcome | undefined {
  const outcome = state?.status === 'terminal' ? cwObj(state.outcome) : undefined;
  if (outcome?.status === 'failed' || outcome?.status === 'aborted') return { status: outcome.status };
  if (outcome?.status !== 'completed') return undefined;
  const result = cwObj(outcome.result);
  const escalation = result?.status === 'escalated' ? cwObj(result.escalation) : undefined;
  if (result?.status !== 'escalated') return { status: 'complete' };
  const [path, label, summary] = [cwId(escalation?.executionPath), cwId(escalation?.label), cwId(escalation?.summary)];
  return { status: 'escalated', ...(path !== undefined ? { path } : {}), ...(label !== undefined ? { label } : {}), ...(summary !== undefined ? { summary } : {}) };
}

/** The graph node an execution path ran at: the one mapping, the DSL's walk of the graph. */
export const chatNodeOf = (graph: WorkflowGraph, path: string): string | undefined => graphNodeOf(graph, path)?.path;

/** The executions in `lines`, in the order their first lines come, and the run key each line is (undefined: none). */
export function chatWorkflowsOf(lines: readonly Line[]): { runs: ChatWorkflow[]; runOf: (line: Line) => string | undefined } {
  // The latest line of each task names its run key and its workflow; its first terminal line is where it ended.
  const tasks = new Map<string, CwObj>();
  const endedAt = new Map<string, number>();
  for (const line of lines) {
    const data = cwTaskLine(line) ? cwObj(line.data)! : undefined;
    const id = data ? cwId(data.id) : undefined;
    if (id === undefined) continue;
    tasks.set(id, data!);
    if (!endedAt.has(id) && cwOutcomeOf(cwObj(data!.state))) endedAt.set(id, line.t);
  }
  const keyOfTask = new Map<string, string>();
  const begun = new Map<string, { workflow: Json | undefined; conversation?: string }>();
  const ended = new Map<string, number>();
  for (const [id, data] of tasks) {
    const input = cwObj(data.input);
    const key = cwId(input?.key);
    if (key === undefined) continue;
    keyOfTask.set(id, key);
    if (endedAt.has(id)) ended.set(key, Math.min(endedAt.get(id)!, ended.get(key) ?? Infinity));
    const conversation = cwId(data.conversationId);
    if (!begun.has(key)) begun.set(key, { workflow: input?.workflow, ...(conversation !== undefined ? { conversation } : {}) });
  }
  const graphs = new Map<string, WorkflowGraph>();
  for (const [key, run] of begun) {
    const graph = workflowGraph(run.workflow);
    if (graph.nodes.length > 0) graphs.set(key, graph);
  }
  const byKey = (key: string): string | undefined => {
    if (graphs.has(key)) return key;
    const nul = key.indexOf('\u0000');
    if (nul > 0 && graphs.has(key.slice(0, nul))) return key.slice(0, nul);
    let found: string | undefined;
    for (const run of graphs.keys()) if (key.startsWith(`${run}:`) && (found === undefined || run.length > found.length)) found = run;
    return found;
  };
  const live = (line: Line) => line.channel === 'live' && (line.kind === 'node.start' || line.kind === 'node.end') && line.path !== undefined;
  const durableRunOf = (line: Line): string | undefined => {
    if (cwTaskLine(line)) { const key = keyOfTask.get(cwId(cwObj(line.data)!.id) ?? ''); return key !== undefined && graphs.has(key) ? key : undefined; }
    const key = docOf(line)?.key;
    return key === undefined ? undefined : byKey(key);
  };
  const first = new Map<string, number>();
  for (const line of lines) {
    const key = durableRunOf(line);
    if (key !== undefined && !first.has(key)) first.set(key, line.t);
  }
  const order = [...graphs.keys()].filter((key) => first.has(key)).sort((a, b) => first.get(a)! - first.get(b)!);
  const runOf = (line: Line): string | undefined => {
    if (!live(line)) return durableRunOf(line);
    const open = order.filter((key) => first.get(key)! <= line.t && (ended.get(key) ?? Infinity) > line.t && chatNodeOf(graphs.get(key)!, line.path!) !== undefined);
    return open.length === 1 ? open[0] : undefined;
  };

  const runs: ChatWorkflow[] = order.map((key, index) => {
    const workflow = cwObj(begun.get(key)!.workflow);
    const conversation = begun.get(key)!.conversation;
    return { id: `workflow-${index + 1}`, key, title: cwId(workflow?.label) ?? cwId(workflow?.name) ?? 'workflow', graph: graphs.get(key)!, t0: first.get(key)!,
      ...(conversation !== undefined ? { conversation } : {}), spans: [], records: [], conversations: {} };
  });
  const byRun = new Map(runs.map((run) => [run.key, run]));
  const records = new Map(runs.map((run) => [run.key, runRecordInit()]));
  const open = new Map<string, { path: string; t0: number; t1?: number }[]>();
  for (const line of lines) {
    const key = runOf(line);
    const run = key === undefined ? undefined : byRun.get(key);
    if (!run) continue;
    if (live(line)) {
      const node = chatNodeOf(run.graph, line.path!);
      if (node === undefined) continue;
      const at = `${run.key}\u0000${line.path}`;
      if (line.kind === 'node.start') {
        const span = { path: node, t0: line.t };
        run.spans.push(span);
        open.set(at, [...(open.get(at) ?? []), span]);
      } else {
        const span = open.get(at)?.pop();
        if (span) span.t1 = line.t;
      }
      continue;
    }
    const ended = !run.outcome && cwTaskLine(line) ? cwOutcomeOf(cwObj(cwObj(line.data)!.state)) : undefined;
    if (ended) run.outcome = { ...ended, t: line.t };
    if (runRecordAccepts(line)) {
      const record = runRecordReduce(records.get(run.key)!, line);
      records.set(run.key, record);
      run.records.push({ t: line.t, source: statusSource(record) });
    }
    const doc = docOf(line);
    const conversation = doc?.doc === 'agentrun.nodes' ? cwId(cwObj(doc.value)?.conversation) : undefined;
    const node = conversation !== undefined && line.path !== undefined ? chatNodeOf(run.graph, line.path) : undefined;
    if (conversation !== undefined && node !== undefined) {
      const held = run.conversations[node] ?? [];
      if (!held.includes(conversation)) run.conversations[node] = [...held, conversation];
    }
  }
  return { runs, runOf };
}

/** What the execution had done at each node at place `t`: done or failed as the DSL's `nodeStatus` says of the driver's
 *  latest record at or before `t`; working when a live run of the node had begun by `t` and not ended, or `nodeStatus`
 *  says so; else not run. A node that holds others is working while one of them has begun and it is not done. From its
 *  terminal line on, an execution has nothing working: an escalation marks the node it names escalated and the nodes
 *  holding it stopped; a complete run's working nodes are done; a failed or aborted run's are stopped. */
export function chatWorkflowStatusAt(run: ChatWorkflow, t: number): Record<string, GraphStatus> {
  const out: Record<string, GraphStatus> = cwRunningAt(run, t);
  const ended = run.outcome && run.outcome.t <= t ? run.outcome : undefined;
  if (!ended) return out;
  const at = ended.status === 'escalated' && ended.path !== undefined ? chatNodeOf(run.graph, ended.path) : undefined;
  for (const node of run.graph.nodes) {
    if (node.path === at) out[node.path] = 'escalated';
    else if (at !== undefined && under(at, node.path) && out[node.path] !== 'failed') out[node.path] = 'stopped';
    else if (out[node.path] === 'working') out[node.path] = ended.status === 'complete' ? 'done' : 'stopped';
  }
  return out;
}

/** The statuses at `t` from the driver's record and the live runs alone. */
function cwRunningAt(run: ChatWorkflow, t: number): Record<string, NodeState> {
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
