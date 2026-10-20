// A run built by hand (synthetic), in the shape of a recording exported from a store: no times (every line's `t` is 0)
// and no live lines. One agent starts two workflows with its `agentrun` tool, one after the other. Both are chains whose
// steps sit at the same paths (/root/steps/0 and /root/steps/1): the first gathers, then tallies; the second checks, then a
// judge fails it. Each execution's documents join on its run key (the task's `data.input.key`): the driver's checkpoints,
// `agentrun.task`, and the node runner's index (`agentrun.nodes`), whose attempt holds a conversation of its own. Each
// task's record is one line at the end, as an export writes it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Line } from '../src/format.ts';

const chain = (name: string, steps: { node: string; label: string }[]) => ({ v: 2, name, root: { node: 'chain', steps } });
export const GATHER = chain('gather-and-tally', [{ node: 'agent', label: 'gather' }, { node: 'code', label: 'tally' }]);
export const CHECK = chain('check-and-judge', [{ node: 'agent', label: 'check' }, { node: 'judge', label: 'verdict' }]);
export const KEY_A = `agentrun:1:${'a'.repeat(64)}:${'b'.repeat(64)}`;
export const KEY_B = `agentrun:1:${'c'.repeat(64)}:${'d'.repeat(64)}`;

let commit = 0;
let entryId = 0;
const durable = (kind: string, data: unknown, extra: Partial<Line> = {}): Line => ({ channel: 'durable', source: kind.startsWith('pi.') ? 'pi' : 'workflow', kind, gen: 1, t: 0, commit: (commit += 1), order: 0, data: data as never, ...extra });
const entry = (kind: string, conv: number, message: unknown, path?: string) => durable(kind, { kind, id: (entryId += 1), conversationId: conv, model: [message] }, { conv, ...(path ? { path } : {}) });
const said = (text: string) => ({ role: 'assistant', model: 'faux/faux-1', content: [{ type: 'text', text }] });
const call = (id: string, name: string) => entry('pi.assistant', 1, { role: 'assistant', model: 'faux/faux-1', content: [{ type: 'toolCall', id, name: 'agentrun', arguments: { action: 'run', name } }] });
const result = (id: string, text: string) => entry('pi.tool-result', 1, { role: 'toolResult', toolCallId: id, toolName: 'agentrun', content: [{ type: 'text', text }], isError: false });
const task = (key: string, id: number) => durable('agentrun.task', { doc: 'agentrun.task', key, value: { task: id, stop: null }, version: 1 });
const driver = (key: string, pin: { done: string[]; steps?: Record<string, unknown>; inputs?: Record<string, unknown> }) =>
  durable('agentrun.driver', { doc: 'agentrun.driver', key, value: { generation: 1, state: { schema: 'agentrun.frozen_run.v3', pin: { steps: {}, inputs: {}, ...pin } } }, version: 1 });
const nodes = (key: string, name: string, path: string, conversation: number) =>
  durable('agentrun.nodes', { doc: 'agentrun.nodes', key: `${key}:${name}:step:${path}:a0`, value: { conversation, closed: false }, version: 1 }, { path });
const workflow = (id: number, key: string, definition: unknown, outcome: unknown) =>
  durable('agentrun.workflow', { id, conversationId: 1, kind: 'agentrun.workflow', version: 1, input: { key, workflow: definition, input: {} }, state: { status: 'terminal', outcome } }, { conv: 1 });

export const lines: Line[] = [
  entry('pi.user', 1, { role: 'user', content: 'Gather the names, then check them.' }),
  call('call-a', 'gather-and-tally'),
  task(KEY_A, 5),
  driver(KEY_A, { done: [] }),
  driver(KEY_A, { done: [], steps: { '/root/steps/0': {} }, inputs: { '/root/steps/0': {} } }),
  nodes(KEY_A, 'gather-and-tally', '/root/steps/0', 2),
  entry('pi.user', 2, { role: 'user', content: 'The runner\'s prompt for gather.' }, '/root/steps/0'),
  entry('pi.assistant', 2, said('Gathered three names.'), '/root/steps/0'),
  driver(KEY_A, { done: ['/root/steps/0'], steps: { '/root/steps/1': {} }, inputs: { '/root/steps/1': {} } }),
  driver(KEY_A, { done: ['/root/steps/0', '/root/steps/1'] }),
  result('call-a', 'Tallied three names.'),
  call('call-b', 'check-and-judge'),
  task(KEY_B, 9),
  driver(KEY_B, { done: [], steps: { '/root/steps/0': {} }, inputs: { '/root/steps/0': {} } }),
  nodes(KEY_B, 'check-and-judge', '/root/steps/0', 3),
  entry('pi.user', 3, { role: 'user', content: 'The runner\'s prompt for check.' }, '/root/steps/0'),
  entry('pi.assistant', 3, said('Checked: one name is misspelt.'), '/root/steps/0'),
  driver(KEY_B, { done: ['/root/steps/0'], steps: { '/root/steps/1': {} }, inputs: { '/root/steps/1': {} } }),
  driver(KEY_B, { done: ['/root/steps/0'], steps: { '/root/steps/1': { status: 'failed' } } }),
  result('call-b', 'The verdict failed.'),
  entry('pi.assistant', 1, said('Both workflows ran; the check failed its verdict.')),
  workflow(5, KEY_A, GATHER, { status: 'completed', result: { status: 'complete', output: { names: 3 } } }),
  workflow(9, KEY_B, CHECK, { status: 'failed' }),
];

/** A line's place on the chat view's axis, which in a recording with no times is its position in the file, from 1. */
export const placeOf = (line: Line) => lines.indexOf(line) + 1;

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
