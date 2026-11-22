import assert from 'node:assert/strict';
import { test } from 'node:test';
const module = await import('../dist/runner/project-host.js').catch(() => ({}));
const { ProjectDrain } = await import('../dist/runner/project-drain.js');

test('child checkpoint cancellation still waits for an already dispatched write', async () => {
  const drain = new ProjectDrain(), entered = Promise.withResolvers(), finish = Promise.withResolvers(), stop = new AbortController();
  const writing = drain.run(async () => { entered.resolve(); await finish.promise; }); await entered.promise;
  let ended = false; const closing = drain.close(stop.signal).finally(() => { ended = true; }); closing.catch(() => {});
  try {
    stop.abort(new Error('fixture cancelled'));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
  } finally { finish.resolve(); await writing; await closing.catch(() => {}); }
  await assert.rejects(closing, /fixture cancelled/);
});

test('retained nested project capabilities drain actual calls and refuse all later dispatch', async () => {
  assert.equal(typeof module.ProjectHostGate, 'function');
  const gate = new module.ProjectHostGate(), entered = Promise.withResolvers(), finish = Promise.withResolvers(); let writes = 0;
  const workspace = gate.capability({
    attach: async () => ({ write: async () => { writes++; entered.resolve(); await finish.promise; } }),
    process: { start: async () => { writes++; } },
    pieces: { write: async () => { writes++; } },
    client: { call: async () => { writes++; } },
  });
  const attached = await workspace.attach(), writing = attached.write(); await entered.promise;
  gate.close(); let drained = false; const drain = gate.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  for (const call of [() => attached.write(), () => workspace.process.start(), () => workspace.pieces.write(), () => workspace.client.call('exec.run')])
    await assert.rejects(call, /dispatch.*closed/);
  assert.equal(writes, 1); finish.resolve(); await writing; await drain; assert.equal(drained, true);
});

test('project capability data retains ordinary array semantics and only dispatched write failures are uncertain', async () => {
  assert.equal(typeof module.ProjectHostGate, 'function');
  const gate = new module.ProjectHostGate();
  const workspace = gate.capability({ list: async () => [{ name: 'kept', bytes: new Uint8Array([0, 128, 255]) }],
    read: async () => { throw new Error('fixture missing file'); }, write: async () => { throw new Error('fixture unknown write'); } });
  const files = await workspace.list(); assert.deepEqual(files.map(entry => entry.name), ['kept']);
  assert.deepEqual([...files[0].bytes], [0, 128, 255]);
  await assert.rejects(workspace.read()); assert.equal(gate.uncertain, false);
  await assert.rejects(workspace.write()); assert.equal(gate.uncertain, true);
});
