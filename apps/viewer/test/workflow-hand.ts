// A run built by hand (synthetic) in which one agent starts two workflows with its `agentrun` tool, one after the other.
// Both are chains whose steps sit at the same paths (/root/steps/0 and /root/steps/1): the first gathers, then tallies;
// the second checks, then a judge fails it. Each agent node holds a conversation of its own. The lines are the recorder's
// shapes (RECORDING.md): a task record per workflow, the driver's checkpoints keyed by the run's journal, the node
// runner's index (`agentrun.nodes`), live node and tool lines.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Line } from '../src/format.ts';

const chain = (name: string, steps: { node: string; label: string }[]) => ({ v: 2, name, root: { node: 'chain', steps } });
export const GATHER = chain('gather-and-tally', [{ node: 'agent', label: 'gather' }, { node: 'code', label: 'tally' }]);
export const CHECK = chain('check-and-judge', [{ node: 'agent', label: 'check' }, { node: 'judge', label: 'verdict' }]);

let commit = 0;
let seq = 0;
const durable = (kind: string, t: number, data: unknown, extra: Partial<Line> = {}): Line => ({ channel: 'durable', source: kind.startsWith('pi.') ? 'pi' : 'workflow', kind, gen: 1, t, commit: (commit += 1), order: 0, data: data as never, ...extra });
const live = (kind: string, t: number, data: unknown, extra: Partial<Line> = {}): Line => ({ channel: 'live', source: kind.startsWith('node.') ? 'workflow' : 'pi', kind, gen: 1, t, seq: (seq += 1), data: data as never, ...extra });
const entry = (kind: string, t: number, conv: number, id: number, message: unknown) => durable(kind, t, { kind, id, conversationId: conv, model: [message] }, { conv });
const task = (t: number, id: number, journal: string, workflow: unknown) => durable('agentrun.workflow', t, { id, conversationId: 1, kind: 'agentrun.workflow', version: 1, input: { key: journal, workflow, input: {} } }, { conv: 1 });
const driver = (t: number, journal: string, pin: unknown) => durable('agentrun.driver', t, { doc: 'agentrun.driver', key: journal, value: { generation: 1, state: { pin } }, version: 1 });
const nodes = (t: number, journal: string, label: string, path: string, conversation: number) =>
  durable('agentrun.nodes', t, { doc: 'agentrun.nodes', key: `${journal}:${label}:step:${path}:a0`, value: { conversation, closed: false }, version: 1 }, { path });
const node = (kind: 'node.start' | 'node.end', t: number, path: string, label: string) => live(kind, t, { type: kind, label, executionPath: path }, { path });
const call = (t0: number, t1: number, id: string) => [live('tool_execution_start', t0, { type: 'tool_execution_start', toolCallId: id, toolName: 'agentrun', args: { action: 'run' } }, { conv: 1 }),
  live('tool_execution_end', t1, { type: 'tool_execution_end', toolCallId: id, toolName: 'agentrun' }, { conv: 1 })];
const said = (text: string) => ({ role: 'assistant', model: 'faux/faux-1', content: [{ type: 'text', text }] });

const [startA, endA] = call(100, 240, 'call-a');
const [startB, endB] = call(300, 440, 'call-b');
export const lines: Line[] = [
  entry('pi.user', 10, 1, 1, { role: 'user', content: 'Gather the names, then check them.' }),
  entry('pi.assistant', 90, 1, 2, { role: 'assistant', model: 'faux/faux-1', content: [{ type: 'text', text: 'I will gather the names first.' }, { type: 'toolCall', id: 'call-a', name: 'agentrun', arguments: { action: 'run' } }] }),
  startA!,
  task(110, 5, 'run-a', GATHER),
  node('node.start', 120, '/root/steps/0', 'gather'),
  nodes(125, 'run-a', 'gather', '/root/steps/0', 2),
  entry('pi.user', 126, 2, 3, { role: 'user', content: 'The runner\'s prompt for gather.' }),
  entry('pi.assistant', 150, 2, 4, said('Gathered three names.')),
  node('node.end', 200, '/root/steps/0', 'gather'),
  driver(201, 'run-a', { done: ['/root/steps/0'], steps: {}, inputs: {} }),
  node('node.start', 210, '/root/steps/1', 'tally'),
  node('node.end', 220, '/root/steps/1', 'tally'),
  driver(221, 'run-a', { done: ['/root/steps/0', '/root/steps/1'], steps: {}, inputs: {} }),
  endA!,
  entry('pi.tool-result', 241, 1, 5, { role: 'toolResult', toolCallId: 'call-a', toolName: 'agentrun', content: [{ type: 'text', text: 'Tallied three names.' }], isError: false }),
  entry('pi.assistant', 290, 1, 6, { role: 'assistant', model: 'faux/faux-1', content: [{ type: 'toolCall', id: 'call-b', name: 'agentrun', arguments: { action: 'run' } }] }),
  startB!,
  task(310, 9, 'run-b', CHECK),
  node('node.start', 320, '/root/steps/0', 'check'),
  nodes(325, 'run-b', 'check', '/root/steps/0', 3),
  entry('pi.user', 326, 3, 7, { role: 'user', content: 'The runner\'s prompt for check.' }),
  entry('pi.assistant', 350, 3, 8, said('Checked: one name is misspelt.')),
  node('node.end', 400, '/root/steps/0', 'check'),
  driver(401, 'run-b', { done: ['/root/steps/0'], steps: {}, inputs: {} }),
  node('node.start', 410, '/root/steps/1', 'verdict'),
  node('node.end', 420, '/root/steps/1', 'verdict'),
  driver(421, 'run-b', { done: ['/root/steps/0'], steps: { '/root/steps/1': { status: 'failed' } }, inputs: {} }),
  endB!,
  entry('pi.tool-result', 441, 1, 9, { role: 'toolResult', toolCallId: 'call-b', toolName: 'agentrun', content: [{ type: 'text', text: 'The verdict failed.' }], isError: false }),
  entry('pi.assistant', 500, 1, 10, said('Both workflows ran; the check failed its verdict.')),
];

export const manifest = {
  format: 'agentrun.recording/1', title: 'Two workflows, built by hand (synthetic)', task: 'two-workflows', recorded: { started: '2026-10-20T00:00:00Z', ended: '2026-10-20T00:00:01Z' },
  code: { repo: 'https://github.com/Parcha-ai/agentrun', commit: '0'.repeat(40), packages: {} }, model: 'faux/faux-1', generations: 1, kills: 0, providers: 'scripted' as const,
  cost: { usd: 0, parts: {} }, source: { run: 'hand', store_sha256: '0'.repeat(64) },
};

/** The recording as a directory: manifest.json, events.jsonl and an empty blobs/. */
export function writeRecording(dir: string, run: Line[] = lines): void {
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'events.jsonl'), `${run.map((line) => JSON.stringify(line)).join('\n')}\n`);
}
