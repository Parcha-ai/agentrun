// The chat view's workflow runs: one per task, every node keyed by (task, path), so two runs whose paths collide keep
// their own spans, conversations and records; what a node had done at a time is the DSL's record at or before it with the
// live runs open then; a recording that ran no workflow has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Json, Line, Recording } from '../src/format.ts';
import { extractChat } from '../src/chat-extract.ts';
import { chatWorkflowsOf, chatWorkflowStatusAt } from '../src/chat-workflow.ts';
import type { ChatItem, ChatModel } from '../src/chat-model.ts';
import { lines, manifest } from './workflow-hand.ts';

const recordingOf = (run: Line[]): Recording => ({ id: 'two-workflows', manifest: manifest as never, lines: run, blobUrl: () => undefined, blobType: () => undefined });
const model = (run: Line[] = lines): Promise<ChatModel> => extractChat(recordingOf(run), async () => undefined);
const tools = (m: ChatModel) => m.threads.flatMap((thread) => thread.items).filter((item): item is Extract<ChatItem, { kind: 'tool' }> => item.kind === 'tool');

test('two workflow runs whose paths collide: each keeps its own graph, node spans, conversations and the call that started it', async () => {
  const m = await model();
  const [a, b] = m.workflows ?? [];
  assert.equal(m.workflows?.length, 2);
  assert.deepEqual([a!.task, a!.title, b!.task, b!.title], ['5', 'gather-and-tally', '9', 'check-and-judge'], 'in the order their tasks began');
  assert.deepEqual(a!.graph.nodes.map((node) => `${node.path} ${node.label}`), ['/root chain', '/root/steps/0 gather', '/root/steps/1 tally']);
  assert.deepEqual(b!.graph.nodes.map((node) => `${node.path} ${node.label}`), ['/root chain', '/root/steps/0 check', '/root/steps/1 verdict']);
  assert.deepEqual(a!.spans, [{ path: '/root/steps/0', t0: 120, t1: 200 }, { path: '/root/steps/1', t0: 210, t1: 220 }]);
  assert.deepEqual(b!.spans, [{ path: '/root/steps/0', t0: 320, t1: 400 }, { path: '/root/steps/1', t0: 410, t1: 420 }]);
  assert.deepEqual([a!.conversations, b!.conversations], [{ '/root/steps/0': ['2'] }, { '/root/steps/0': ['3'] }]);
  const [callA, callB] = tools(m);
  assert.deepEqual([a!.call, b!.call], [callA!.id, callB!.id], 'each run hangs off the call whose span holds its first line');
  assert.deepEqual([callA!.workflow, callB!.workflow], [a!.id, b!.id]);
  assert.deepEqual([callA!.plumbing, callB!.plumbing], [undefined, undefined], 'a call that started a run is no plumbing, though its one argument is a string');

  // The threads and the timeline: the same path names a different node in each run.
  assert.equal(m.threads.find((thread) => thread.id === 'thread-2')?.label, 'gather');
  assert.equal(m.threads.find((thread) => thread.id === 'thread-3')?.label, 'check');
  const nodes = m.spans.filter((span) => span.actor === 'node').map((span) => [span.label, span.t0, span.item ?? null, span.node?.run, span.node?.path]);
  assert.deepEqual(nodes, [
    ['node gather', 120, 'thread-2', a!.id, '/root/steps/0'], ['node tally', 210, null, a!.id, '/root/steps/1'],
    ['node check', 320, 'thread-3', b!.id, '/root/steps/0'], ['node verdict', 410, null, b!.id, '/root/steps/1'],
  ]);
});

test('a node\'s status at a time: not run before it starts, working while its live run is open, then what the record says', async () => {
  const [a, b] = (await model()).workflows!;
  assert.deepEqual(chatWorkflowStatusAt(a!, 100), { '/root': 'not-run', '/root/steps/0': 'not-run', '/root/steps/1': 'not-run' }, 'before the run');
  assert.deepEqual(chatWorkflowStatusAt(a!, 150), { '/root': 'working', '/root/steps/0': 'working', '/root/steps/1': 'not-run' }, 'during gather');
  assert.deepEqual(chatWorkflowStatusAt(a!, 205), { '/root': 'working', '/root/steps/0': 'done', '/root/steps/1': 'not-run' }, 'after gather, before tally');
  assert.deepEqual(chatWorkflowStatusAt(a!, Infinity), { '/root': 'done', '/root/steps/0': 'done', '/root/steps/1': 'done' }, 'at the end');
  assert.deepEqual(chatWorkflowStatusAt(b!, 150), { '/root': 'not-run', '/root/steps/0': 'not-run', '/root/steps/1': 'not-run' }, 'the second run had not begun');
  assert.deepEqual(chatWorkflowStatusAt(b!, 415), { '/root': 'working', '/root/steps/0': 'done', '/root/steps/1': 'working' });
  assert.deepEqual(chatWorkflowStatusAt(b!, Infinity), { '/root': 'failed', '/root/steps/0': 'done', '/root/steps/1': 'failed' });
});

test('a line is its task\'s by its own task, its record, or the journal key its document carries; a live node line by the runs begun', () => {
  const at = (t: number, data: Json, extra: Partial<Line> = {}): Line => ({ channel: 'durable', source: 'workflow', kind: String((data as { doc?: string; kind?: string }).doc ?? (data as { kind: string }).kind), t, commit: t, data, ...extra });
  const workflow = { v: 2, name: 'w', root: { node: 'chain', steps: [{ node: 'agent', label: 'a' }] } };
  const run = [
    at(1, { id: 1, conversationId: 1, kind: 'agentrun.workflow', input: { key: 'lists', workflow } }),
    at(2, { id: 2, conversationId: 1, kind: 'agentrun.workflow', input: { key: 'lists:again', workflow } }),
    at(3, { doc: 'agentrun.nodes', key: 'lists:again:a:step:/root/steps/0:a0', value: { conversation: 7 } }, { path: '/root/steps/0' }),
    at(4, { doc: 'agentrun.nodes', key: 'lists:a:step:/root/steps/0:a0', value: { conversation: 6 } }, { path: '/root/steps/0' }),
    at(5, { doc: 'agentrun.items', key: 'lists\u0000/root/steps/0/items/0', value: {} }),
    at(6, { doc: 'reference.label', value: 'x' }, { task: '2' }),
  ];
  const { runs, taskOf } = chatWorkflowsOf(run);
  assert.deepEqual(run.map(taskOf), ['1', '2', '2', '1', '1', '2'], 'the longest journal a node key starts with is its run\'s');
  assert.deepEqual(runs.map((each) => each.conversations), [{ '/root/steps/0': ['6'] }, { '/root/steps/0': ['7'] }]);
  const start = (t: number): Line => ({ channel: 'live', source: 'workflow', kind: 'node.start', t, path: '/root/steps/0', data: {} });
  assert.deepEqual([taskOf(start(1.5)), taskOf(start(9)), taskOf(start(0))], ['1', '2', undefined], 'the latest begun of the runs begun by its time');
});

test('a recording that ran no workflow has none, and a task whose line names no workflow runs the job\'s', async () => {
  const none = lines.filter((line) => line.kind !== 'agentrun.workflow');
  assert.equal((await model(none)).workflows, undefined);
  const bare = lines.map((line) => (line.kind === 'agentrun.workflow' ? { ...line, data: { ...(line.data as object), input: { key: (line.data as { input: { key: string } }).input.key } } } : line));
  assert.equal((await model(bare)).workflows, undefined, 'no workflow line names one, and no job is named');
  const job = 'a'.repeat(64);
  const withJob = await extractChat({ ...recordingOf(bare), manifest: { ...manifest, job: { blob: job, sha256: job } } as never }, async (sha) => (sha === job ? { workflow: GATHER_JOB } as Json : undefined));
  assert.deepEqual(withJob.workflows?.map((each) => each.title), ['from-the-job', 'from-the-job']);
});

const GATHER_JOB = { v: 2, name: 'from-the-job', root: { node: 'chain', steps: [{ node: 'agent', label: 'gather' }, { node: 'code', label: 'tally' }] } };
