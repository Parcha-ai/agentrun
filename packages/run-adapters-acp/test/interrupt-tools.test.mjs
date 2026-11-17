// A stop while a tool of ours runs: the agent may answer the prompt `cancelled` and leave its MCP request open. The
// tool's signal is the turn's too, so interrupt() returns only once the tool has stopped, and nothing of it is written
// after the turn let go.
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { fakeRecipe, openSession, scratch, streamRecords, until } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);

for (const http of [true, false]) {
  test(`an interrupt stops a tool whose MCP call the agent left open (MCP over ${http ? 'HTTP' : 'stdio'})`, async (t) => {
    const recipe = fakeRecipe(scratch(), { script: [{ call: 'slow' }, { say: 'never' }], keepMcpOnCancel: true, askMcp: false, http, load: http });
    let started = false;
    let stopped = false;
    let release;
    const slow = {
      name: 'slow',
      description: 'A tool that runs until its signal says stop.',
      inputSchema: { type: 'object', properties: {} },
      replay: 'never',
      call: (_args, context) => {
        started = true;
        return new Promise((resolve) => {
          release = () => resolve({ text: 'finished on its own' });
          context.signal?.addEventListener('abort', () => {
            stopped = true;
            resolve({ text: 'stopped', isError: true });
          }, { once: true });
        });
      },
    };
    t.after(() => release?.());
    const { session, store } = await openSession(t, recipe, { tools: [slow] });
    await session.send('go');
    await until(() => started, 'the tool to start');
    await session.interrupt();
    assert.equal(stopped, true, 'the tool was told to stop before interrupt() returned');
    const end = await session.turnEnd();
    assert.equal(end.status, 'interrupted', end.error);
    const calls = await streamRecords(store, 'acp.call');
    assert.deepEqual(calls.map((r) => r.type), ['seen', 'answered'], 'the call ended in the records before the stop returned');
  });
}
