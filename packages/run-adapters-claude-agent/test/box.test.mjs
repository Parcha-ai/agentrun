// The CLI's own tools and the host's box: they run only in a box the host gave the machine, or where the operator said
// `unsandboxed`; anywhere else the turn fails with a named error, and nothing probes bubblewrap or falls back. In a box,
// Claude Code's own sandbox is off: the box is the boundary.
//
// On the scripted Agent SDK (./testing), with a box for the tests that runs the stand-in CLI as itself. No key, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { BOX_EGRESS_SOCKET, BOX_MODEL_SOCKET, forwardChild, parseForward, startChild } from '@parcha/agentrun-kernel/host';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-box-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
const node = { kind: 'agent', label: 'q', system: ['Be brief.'], user: 'Go.', schema: SCHEMA, tools: [] };

/** A port nothing listens on now. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A box for the tests: it records what it was asked to start, and runs it as a box would, the kernel's forwarder
 *  included, with the paths the box binds the host's sockets at mapped to the host's own (no namespaces here). */
function fakeBox(isolation = { mode: 'bwrap', cgroup: false }) {
  const box = { isolation, started: [] };
  box.start = (spec, child, recorder) => {
    const forwarded = parseForward(child.args.slice(1));
    const host = (path) => (path === BOX_MODEL_SOCKET ? spec.modelSocket : path === BOX_EGRESS_SOCKET ? spec.egressSocket : path);
    const run = forwardChild({ command: forwarded.command, args: forwarded.args }, forwarded.listen.map((l) => ({ port: l.port, socket: host(l.socket) })));
    box.started.push(forwarded.command);
    const record = { id: `box-${box.started.length}`, writer: { pid: process.pid, startTime: '1' } };
    recorder.ahead(record);
    const proc = startChild({ command: run.command, args: run.args, env: spec.env }, {}, spec.workspace);
    return { ...proc, record, ready: recorder.started({ ...record, pid: proc.child.pid }).then(() => record) };
  };
  box.reap = async () => ({ empty: true, left: 0, by: 'pidns' });
  return box;
}
const machineBox = async (box) => ({ box, recorder: { ahead: () => {}, started: async () => {} }, readOnly: [], modelPort: await freePort() });

async function run(t, extra) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const seen = [];
  const logs = [];
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    sessionsDir: join(scratch(), 'sessions'),
    standIn: { command: process.execPath },
    sdk: fakeSdk({ remoteModel: true, mirrorLagMs: 10, script: ['call submit {"value":{"answer":"ok"}}'], onQuery: (options) => seen.push(options) }),
    log: (message) => logs.push(message),
    ...extra,
  });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [] });
  return { result: runNode(node), seen, logs };
}

test("with the CLI's own tools on and no box from the host, the turn fails by name, and the CLI never starts", async (t) => {
  const { result, seen } = await run(t, {});
  await assert.rejects(result, (error) => /the CLI's own tools run only in the host's box, and the host gave this machine no box/.test(String(error?.message ?? error)));
  assert.equal(seen.length, 0, 'no query was made');
});

test('a box the probe found unavailable says why, by its error, and runs nothing', async (t) => {
  const box = fakeBox({ mode: 'unavailable', error: 'bwrap_userns_denied', detail: 'setting up uid map: Permission denied' });
  const { result } = await run(t, { box: await machineBox(box) });
  await assert.rejects(result, (error) => /its box is unavailable \(bwrap_userns_denied: setting up uid map: Permission denied\)/.test(String(error?.message ?? error)));
  assert.deepEqual(box.started, []);
});

test("in the host's box the CLI starts through it, with its own tools and none of the CLI's own sandbox, reaching its model through the box's forwarder", async (t) => {
  const box = fakeBox();
  const { result, seen } = await run(t, { box: await machineBox(box) });
  assert.deepEqual(await result, { answer: 'ok' });
  assert.deepEqual(box.started, [process.execPath], 'the CLI started in the box');
  assert.equal(seen[0].sandbox, undefined, "Claude Code's own sandbox is off: the box is the boundary");
  assert.ok(seen[0].tools.includes('Bash'), "the CLI's own tools are on");
});

test("unsandboxed, the operator's word, runs the CLI's own tools with no box, and says so", async (t) => {
  const { result, logs } = await run(t, { box: 'unsandboxed' });
  assert.deepEqual(await result, { answer: 'ok' });
  assert.ok(logs.some((line) => /unsandboxed: the CLI's own tools run with no box/.test(line)), logs.join('\n'));
});

test('with its own tools off, the CLI runs with no box, as before', async (t) => {
  const { result } = await run(t, { builtins: false });
  assert.deepEqual(await result, { answer: 'ok' });
});
