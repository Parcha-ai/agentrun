// A run's MCP tool on Codex is a host tool like any other (a dynamic tool through the session's bridge and the host's
// gate), on the stand-in app-server (fake-app-server.mjs), which refuses a dynamic tool named `mcp__…` at the thread's
// start as Codex 0.164 does (#1586). Codex is given it as `mcp_<server>__<tool>`; the host's gate and the session's events
// name the call by the host's own name. No key, no network, no Codex.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-mcp-host-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

const schema = { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } };
const adapterIn = (dir, script) => {
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify(script));
  return codexAdapter({
    model: 'luna-test',
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    price: () => 0,
    sessionsDir: join(dir, 'sessions'),
    standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_SCRIPT: file } },
  });
};

test("an MCP tool named mcp__<server>__<tool> runs on Codex as mcp_<server>__<tool>, gated and reported by the host's name", async (t) => {
  const adapter = adapterIn(scratch(), ['call mcp_fake__add {"a":2,"b":3}']);
  const ran = [];
  const add = { name: 'mcp__fake__add', description: 'Adds two numbers.', inputSchema: schema, replay: 'never', call: async (args) => { ran.push(args); return { text: String(args.a + args.b) }; } };
  const store = memorySessionStore();
  const events = [];
  const asked = [];
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: (event) => events.push(event), gate: async (call) => { asked.push(call); return 'allow'; } };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [add], context: 'fresh' }, io);
  t.after(() => session.close());
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'completed', JSON.stringify(end));
  assert.deepEqual(ran, [{ a: 2, b: 3 }], 'the host tool ran once');
  assert.deepEqual(asked.map((call) => [call.tool, call.args]), [['mcp__fake__add', { a: 2, b: 3 }]], "the gate was asked by the host's name");
  assert.deepEqual(events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end').map((e) => [e.type, e.name]), [['tool_start', 'mcp__fake__add'], ['tool_end', 'mcp__fake__add']], "the events name the host's tool");
  assert.match(JSON.stringify(await store.read('s1')), /mcp_fake__add returned: 5/, 'Codex read the answer');
});

test('two tools that would reach Codex by one name are refused when the session is checked', () => {
  const adapter = adapterIn(scratch(), []);
  const tool = (name) => ({ name, description: 'A tool.', inputSchema: schema, replay: 'safe', call: async () => ({ text: '' }) });
  const problems = adapter.check({ key: 's', label: 'root', system: [], tools: [tool('mcp__fake__add'), tool('mcp_fake__add')], context: 'fresh' });
  assert.deepEqual(problems, ['the tools mcp__fake__add and mcp_fake__add both reach Codex as mcp_fake__add']);
});
