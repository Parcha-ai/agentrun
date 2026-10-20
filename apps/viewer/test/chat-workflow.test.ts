// The chat view's workflow executions: one per run key, every node keyed by (run key, execution path), so two executions
// whose paths collide keep their own spans, conversations and records; what a node had done at a place is the DSL's
// record at or before it with the live runs open then; a recording that ran no workflow has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLines, type Json, type Line, type Recording } from '../src/format.ts';
import { extractChat } from '../src/chat-extract.ts';
import { chatWorkflowsOf, chatWorkflowStatusAt } from '../src/chat-workflow.ts';
import type { ChatItem, ChatModel } from '../src/chat-model.ts';
import { KEY_A, KEY_B, lines, manifest, placeOf, SUMMARY } from './workflow-hand.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const recordingOf = (run: Line[]): Recording => ({ id: 'two-workflows', manifest: manifest as never, lines: run, blobUrl: () => undefined, blobType: () => undefined });
const model = (run: Line[] = lines): Promise<ChatModel> => extractChat(recordingOf(run), async () => undefined);
const tools = (m: ChatModel) => m.threads.flatMap((thread) => thread.items).filter((item): item is Extract<ChatItem, { kind: 'tool' }> => item.kind === 'tool');
/** The place of the first line of `kind` with this run key, as the chat view counts places in a file with no times. */
const placeWhere = (kind: string, key: string, nth = 0) => placeOf(lines.filter((line) => line.kind === kind && (line.data as { key?: string }).key === key)[nth]!);

test('two executions whose paths collide: each keeps its own graph, node spans, conversations and the call that started it', async () => {
  const m = await model();
  const [a, b] = m.workflows ?? [];
  assert.equal(m.inOrder, true, 'a recording with no times');
  assert.equal(m.workflows?.length, 2);
  assert.deepEqual([a!.key, a!.title, b!.key, b!.title], [KEY_A, 'gather-and-tally', KEY_B, 'check-and-judge'], 'in the order their first lines come');
  assert.deepEqual(a!.graph.nodes.map((node) => `${node.path} ${node.label}`), ['/root chain', '/root/steps/0 gather', '/root/steps/1 tally'], 'drawn from the task\'s own workflow');
  assert.deepEqual(b!.graph.nodes.map((node) => `${node.path} ${node.label}`), ['/root chain', '/root/steps/0 check', '/root/steps/1 misspelt', '/root/steps/2 verdict']);
  const ends = lines.filter((line) => line.kind === 'agentrun.workflow').map(placeOf);
  assert.deepEqual([a!.outcome, b!.outcome], [{ status: 'complete', t: ends[0] }, { status: 'escalated', path: '/root/steps/1', label: 'misspelt', summary: SUMMARY, t: ends[1] }], 'each ends at its terminal line');
  assert.deepEqual([a!.t0, b!.t0], [placeWhere('agentrun.task', KEY_A), placeWhere('agentrun.task', KEY_B)], 'an execution begins at its first line, not its task record at the end');
  assert.deepEqual([a!.conversations, b!.conversations], [{ '/root/steps/0': ['2'] }, { '/root/steps/0': ['3'] }]);
  const [callA, callB] = tools(m);
  assert.deepEqual([a!.call, b!.call], [callA!.id, callB!.id], 'each hangs off the call of its conversation made before its first line and answered after it');
  assert.deepEqual([callA!.workflow, callB!.workflow], [a!.id, b!.id]);

  // The threads and the timeline: the same path names a different node in each execution.
  assert.equal(m.threads.find((thread) => thread.id === 'thread-2')?.label, 'gather');
  assert.equal(m.threads.find((thread) => thread.id === 'thread-3')?.label, 'check');
  const nodes = m.spans.filter((span) => span.actor === 'node').map((span) => [span.label, span.item, span.node?.run, span.node?.path]);
  assert.deepEqual(nodes, [['node gather', 'thread-2', a!.id, '/root/steps/0'], ['node check', 'thread-3', b!.id, '/root/steps/0']], 'with no live line, a node attempt spans its conversation');
  const calls = m.spans.filter((span) => span.actor === 'tool').map((span) => [span.label, span.item]);
  assert.deepEqual(calls, [[callA!.title, callA!.id], [callB!.title, callB!.id]], 'with no live line, a call spans its entry to its result');
});

test('a node\'s status at a place: what the driver\'s latest record at or before it says, as the DSL reads it', async () => {
  const [a, b] = (await model()).workflows!;
  const [, , aWorking, aSecond] = lines.filter((line) => line.kind === 'agentrun.driver' && (line.data as { key: string }).key === KEY_A).map(placeOf);
  assert.deepEqual(chatWorkflowStatusAt(a!, a!.t0 - 1), { '/root': 'not-run', '/root/steps/0': 'not-run', '/root/steps/1': 'not-run' }, 'before the execution');
  assert.deepEqual(chatWorkflowStatusAt(a!, placeWhere('agentrun.driver', KEY_A, 1)), { '/root': 'working', '/root/steps/0': 'working', '/root/steps/1': 'not-run' }, 'during gather');
  assert.deepEqual(chatWorkflowStatusAt(a!, aWorking!), { '/root': 'working', '/root/steps/0': 'done', '/root/steps/1': 'working' }, 'gather done, tally under way');
  assert.deepEqual(chatWorkflowStatusAt(a!, aSecond!), { '/root': 'done', '/root/steps/0': 'done', '/root/steps/1': 'done' });
  assert.deepEqual(chatWorkflowStatusAt(b!, aSecond!), { '/root': 'not-run', '/root/steps/0': 'not-run', '/root/steps/1': 'not-run', '/root/steps/2': 'not-run' }, 'the second had not begun');
});

test('from its terminal line on, an execution has nothing working: where it escalated is marked, the nodes holding it stopped', async () => {
  const [a, b] = (await model()).workflows!;
  const before = b!.outcome!.t - 1;
  assert.deepEqual(chatWorkflowStatusAt(b!, before), { '/root': 'working', '/root/steps/0': 'done', '/root/steps/1': 'working', '/root/steps/2': 'not-run' }, 'before it, unchanged');
  assert.deepEqual(chatWorkflowStatusAt(b!, b!.outcome!.t), { '/root': 'stopped', '/root/steps/0': 'done', '/root/steps/1': 'escalated', '/root/steps/2': 'not-run' });
  assert.deepEqual(chatWorkflowStatusAt(b!, Infinity), chatWorkflowStatusAt(b!, b!.outcome!.t));
  assert.deepEqual(chatWorkflowStatusAt(a!, Infinity), { '/root': 'done', '/root/steps/0': 'done', '/root/steps/1': 'done' }, 'complete: all done');
  // A complete run whose record still shows a node working (the record lags the outcome) has none working.
  const route = { ...a!, outcome: { status: 'complete' as const, t: 1 }, records: [{ t: 0, source: { pin: { done: ['/root/steps/0'], steps: { '/root/steps/1': {} } }, items: [] } }] };
  assert.deepEqual(Object.values(chatWorkflowStatusAt(route, 1)), ['done', 'done', 'done']);
  for (const status of ['failed', 'aborted'] as const) {
    const ended = { ...route, outcome: { status, t: 1 }, records: [{ t: 0, source: { pin: { done: ['/root/steps/0'], steps: { '/root/steps/1': { status: 'failed' } } }, items: [] } }] };
    assert.deepEqual(chatWorkflowStatusAt(ended, 1), { '/root': 'failed', '/root/steps/0': 'done', '/root/steps/1': 'failed' }, `${status}: failed per the record`);
    const cut = { ...route, outcome: { status, t: 1 } };
    assert.deepEqual(chatWorkflowStatusAt(cut, 1), { '/root': 'stopped', '/root/steps/0': 'done', '/root/steps/1': 'stopped' }, `${status}: nothing working`);
  }
});

test('with live node lines (a recording with times), a node is working while its live run is open', async () => {
  const dir = join(here, 'fixtures', 'reference-job');
  const recording: Recording = { id: 'reference-job', manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), lines: parseLines(readFileSync(join(dir, 'events.jsonl'), 'utf8')), blobUrl: () => undefined, blobType: () => undefined };
  const [run] = (await extractChat(recording, async () => undefined)).workflows!;
  const start = (label: string) => recording.lines.find((line) => line.kind === 'node.start' && (line.data as { label: string }).label === label)!.t;
  assert.deepEqual(run!.spans.map((span) => span.path), ['/root/steps/0', '/root/steps/1', '/root/steps/2', '/root/steps/3']);
  assert.equal(chatWorkflowStatusAt(run!, start('search'))['/root/steps/0'], 'working', 'its node.start, before any checkpoint names it');
  assert.equal(chatWorkflowStatusAt(run!, start('investigate'))['/root/steps/1'], 'working');
  assert.deepEqual(Object.values(chatWorkflowStatusAt(run!, Infinity)), ['done', 'done', 'done', 'done', 'done']);
});

test('a live node line is taken only when one execution open at its place holds its node; else the record alone decides', async () => {
  const workflow = { v: 2, name: 'w', root: { node: 'chain', steps: [{ node: 'agent', label: 'a' }] } };
  const doc = (t: number, kind: string, key: string, value: Json): Line => ({ channel: 'durable', source: 'workflow', kind, t, commit: t, data: { doc: kind, key, value } });
  const task = (t: number, id: number, key: string, state?: Json): Line => ({ channel: 'durable', source: 'workflow', kind: 'agentrun.workflow', t, commit: t, data: { id, conversationId: 1, kind: 'agentrun.workflow', input: { key, workflow }, ...(state ? { state } : {}) } });
  const node = (t: number, kind: 'node.start' | 'node.end'): Line => ({ channel: 'live', source: 'workflow', kind, t, path: '/root/steps/0', data: { type: kind, label: 'a' } });
  const pin = (done: string[]) => ({ state: { pin: { done, steps: {}, inputs: {} } } });
  // A begins at 10, B at 20; the node.start at 30 is A's, but nothing on it says so.
  const both = [doc(10, 'agentrun.task', 'A', { task: 1 }), doc(20, 'agentrun.task', 'B', { task: 2 }), node(30, 'node.start'), node(40, 'node.end'),
    doc(50, 'agentrun.driver', 'A', pin(['/root/steps/0'])), task(60, 1, 'A', { status: 'terminal', outcome: { status: 'completed', result: { status: 'complete' } } }), task(61, 2, 'B'),
    node(70, 'node.start'), node(80, 'node.end')];
  const { runs, runOf } = chatWorkflowsOf(both);
  const [a, b] = runs;
  assert.deepEqual([runOf(both[2]!), runOf(both[3]!)], [undefined, undefined], 'two executions open hold the node: no execution takes the line');
  assert.deepEqual([a!.spans, b!.spans.filter((span) => span.t0 < 60)], [[], []], 'no live span on either');
  assert.equal(chatWorkflowStatusAt(a!, 35)['/root/steps/0'], 'not-run', 'A is not working from the line');
  assert.equal(chatWorkflowStatusAt(b!, 35)['/root/steps/0'], 'not-run', 'nor is B');
  assert.equal(chatWorkflowStatusAt(a!, 55)['/root/steps/0'], 'done', 'the driver\'s record still decides');
  // A has ended at 60: B is the one execution open, and takes the line at 70.
  assert.deepEqual([runOf(both[7]!), b!.spans], ['B', [{ path: '/root/steps/0', t0: 70, t1: 80 }]]);
  assert.equal(chatWorkflowStatusAt(b!, 75)['/root/steps/0'], 'working');
  const timeline = (await model(both)).spans.filter((span) => span.actor === 'node').map((span) => [span.t0, span.node?.run]);
  assert.deepEqual(timeline, [[70, b!.id]], 'the timeline draws no span for the line no execution takes');
});

test('a line is its execution\'s by the run key its document carries, the longest that a node attempt\'s key starts with', () => {
  let place = 0;
  const at = (data: Json, extra: Partial<Line> = {}): Line => ({ channel: 'durable', source: 'workflow', kind: String((data as { doc?: string; kind?: string }).doc ?? (data as { kind: string }).kind), t: (place += 1), data, ...extra });
  const workflow = { v: 2, name: 'w', root: { node: 'map', body: { node: 'agent', label: 'each' } } };
  const key = 'agentrun:1:abc:def';
  const run = [
    at({ doc: 'agentrun.nodes', key: `${key}:1:w:step:/root/items/0/body:a0`, value: { conversation: 7 } }, { path: '/root/items/0/body' }),
    at({ doc: 'agentrun.nodes', key: `${key}:w:step:/root/items/1/body:a0`, value: { conversation: 6 } }, { path: '/root/items/1/body' }),
    at({ doc: 'agentrun.items', key: `${key}\u0000/root/items/1`, value: {} }),
    at({ doc: 'agentrun.driver', key: `${key}:1`, value: {} }),
    at({ doc: 'reference.label', value: 'x' }),
    at({ id: 1, conversationId: 1, kind: 'agentrun.workflow', input: { key, workflow } }),
    at({ id: 2, conversationId: 1, kind: 'agentrun.workflow', input: { key: `${key}:1`, workflow } }),
  ];
  const { runs, runOf } = chatWorkflowsOf(run);
  assert.deepEqual(run.map(runOf), [`${key}:1`, key, key, `${key}:1`, undefined, key, `${key}:1`]);
  assert.deepEqual(runs.map((each) => [each.key, each.conversations]), [[`${key}:1`, { '/root/body': ['7'] }], [key, { '/root/body': ['6'] }]], 'a map item\'s node is the map\'s body, by the DSL\'s walk');
});

test('a recording that ran no workflow has none; nor does a task that names no workflow, whatever the manifest\'s job', async () => {
  assert.equal((await model(lines.filter((line) => line.kind !== 'agentrun.workflow'))).workflows, undefined);
  const bare = lines.map((line) => (line.kind === 'agentrun.workflow' ? { ...line, data: { ...(line.data as object), input: { key: (line.data as { input: { key: string } }).input.key } } } : line));
  const job = 'a'.repeat(64);
  const withJob = await extractChat({ ...recordingOf(bare), manifest: { ...manifest, job: { blob: job, sha256: job } } as never }, async () => ({ workflow: { v: 2, name: 'job', root: { node: 'agent', label: 'x' } } }) as Json);
  assert.equal(withJob.workflows, undefined);
});
