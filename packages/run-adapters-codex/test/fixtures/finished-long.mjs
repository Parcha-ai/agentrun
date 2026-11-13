// A turn whose two host tool calls finished in the log, one with a 1 MiB result and one failed with 300,000 characters of
// error, as the next drive reads it: what a crash after the outcomes, before Codex wrote their outputs, leaves dangling in
// the rollout. Through the kernel's tool bridge and drive, which keep each outcome whole in the record.
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { placeSubmissions, toolBridge } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const tool = (name, execute) => ({ name, description: name, inputSchema: { type: 'object' }, replay: 'safe', execute });

/** `{ state, whole, failure }`: the next drive's state, c1's (read_skill_file) result and c2's (delegate) error. */
export async function finishedLong() {
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('long'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'Read it all.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const whole = 'x'.repeat(1_048_514);
  const failure = 'e'.repeat(300_000);
  const bridge = toolBridge(first, [tool('read_skill_file', async () => whole), tool('delegate', async () => { throw new Error(failure); })], { live: false });
  await bridge.call('read_skill_file', {}, 'c1');
  await bridge.call('delegate', {}, 'c2');
  const next = await openDrive({ writer: await store.open('long'), signal: new AbortController().signal });
  return { state: next.state(), whole, failure };
}
