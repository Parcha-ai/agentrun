// A turn a crash cut off with one tool call in each status, and the system note the shared process layer makes of it
// (`recoverySystemNote`). Other packages' tests import this fixture and compare their own note with `EXPECTED_SYSTEM_NOTE`,
// so every harness says the same thing about the same log.
import { openDrive } from '@parcha/agentrun-adapters/kernel';
import { placeSubmissions, toolBridge } from '@parcha/agentrun-adapters/process';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tool = (name, replay, execute) => ({ name, description: name, inputSchema: { type: 'object' }, replay, execute });
const hang = () => new Promise(() => {});

/** The session state after the crash: completed (c1), failed (c2), interrupted (c3, a `never` tool), retryable (c4, a `safe` tool) and running (c5). */
export async function fiveStatusesState() {
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('five'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'Look things up.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const bridge = toolBridge(first, [tool('read_page', 'safe', async () => 'page text'), tool('fail_page', 'safe', async () => { throw new Error('boom'); }), tool('pay', 'never', hang), tool('look', 'safe', hang)], { live: false, serial: false });
  await bridge.call('read_page', {}, 'c1');
  await bridge.call('fail_page', {}, 'c2');
  void bridge.call('pay', {}, 'c3').catch(() => {});
  await pause(30);
  void bridge.call('look', {}, 'c4').catch(() => {});
  await pause(30);
  const next = await openDrive({ writer: await store.open('five'), signal: new AbortController().signal });
  void toolBridge(next, [tool('index', 'safe', hang)], { live: false }).call('index', {}, 'c5').catch(() => {});
  await pause(30);
  return next.state();
}

export const EXPECTED_SYSTEM_NOTE = `The harness, not the user, adds this about the turn before this one:
[Recovery] Your previous turn was interrupted: the process running it stopped, and this session was resumed from its durable log.

What the log records about the tool calls since that turn began (none was run again):
- read_page, call c1: completed.
- fail_page, call c2: failed.
- pay, call c3: interrupted before it reported a result. It is not safe to repeat, and it may have taken effect.
- look, call c4: interrupted before it reported a result. It is safe to repeat.
- index, call c5: interrupted, and it may still be running. It may have taken effect.

The output of those calls is not shown here. Check the actual state before relying on it.

Check the actual state before repeating anything that may have taken effect, then carry on with the task.`;

/** The note for a turn with no call: a string, not `undefined` (`undefined` is for a session with no open turn). */
export const EXPECTED_NO_CALLS_NOTE = `The harness, not the user, adds this about the turn before this one:
[Recovery] Your previous turn was interrupted: the process running it stopped, and this session was resumed from its durable log.

No tool call had started in that turn.

Check the actual state before repeating anything that may have taken effect, then carry on with the task.`;
