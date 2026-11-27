// A code-mode script's calls on Codex are outside the model's turn. The model's answer makes one call, `exec`; the
// script then calls host tools under Codex's own ids (`exec-<uuid>`), and their results go to the script, not to the
// model, which sees only what the script prints. So the turn budget (what the window has left, split over the answer's
// calls) is not charged with them: each is held to the per-result bound alone, and a script that reads four pages is
// never refused the later ones. The stand-in app-server (fake-app-server.mjs) with its model the provider's, behind the
// real model proxy, which opens the turn from each answer: no binary, no key, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-script-turn-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const WINDOW = 16_384;
const SIZE = 10_000;
/** A Responses stream of `events`, as data alone. */
const stream = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

test("a 16k window, 4,000 tokens held: a code-mode script's four 10k reads are each held to the per-result bound alone, none refused, the turn's split never charged with them", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(ROOT, 'n-'));
  const script = JSON.stringify([0, 1, 2, 3].map((n) => ({ tool: 'read_page', args: { n } })));
  let asked = 0;
  const bodies = [];
  const fetch = async (input, init) => {
    asked += 1;
    bodies.push(JSON.parse(String(input instanceof Request ? await input.text() : init?.body ?? 'null')));
    const exec = { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_1', input: script };
    const events = asked === 1
      ? [
          { type: 'response.output_item.added', output_index: 0, item: { ...exec, input: '' } },
          { type: 'response.output_item.done', output_index: 0, item: exec },
          { type: 'response.completed', response: { usage: { input_tokens: 4_000, output_tokens: 100 } } },
        ]
      : [
          { type: 'response.output_text.delta', item_id: 'm_0', output_index: 0, content_index: 0, delta: 'Read them.' },
          { type: 'response.completed', response: { usage: { input_tokens: 5_000, output_tokens: 10 } } },
        ];
    return new Response(stream(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const tool = { name: 'read_page', description: `Answers ${SIZE} characters.`, inputSchema: { type: 'object', properties: { n: { type: 'number' } } }, replay: 'safe', call: async (args) => ({ text: `START-${args?.n ?? 0} `.padEnd(SIZE, 'r') }) };
  const adapter = codexAdapter({ model: 'luna-test', provider: { origin: 'https://provider.invalid', credential: () => 'k' }, price: () => 0.001, sessionsDir: join(dir, 'sessions'), standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_MODEL: 'responses' } }, fetch, contextWindow: WINDOW });
  const store = memorySessionStore();
  const events = [];
  const models = { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [tool], context: 'fresh' }, { writer: await store.open('s1'), models, signal: new AbortController().signal, onEvent: (event) => events.push(event) });
  t.after(() => session.close());
  await session.send('Read four pages.');
  assert.deepEqual(await session.turnEnd(), { status: 'completed' });
  const ended = events.filter((e) => e.type === 'tool_end' && e.name === 'read_page');
  assert.equal(ended.length, 4, 'the script made its four calls');
  // What the script got back from each call, as Codex's exec output tells the model on its next request.
  const output = bodies[1]?.input?.find((item) => item.type === 'custom_tool_call_output' && item.call_id === 'call_exec_1')?.output;
  assert.ok(typeof output === 'string', `the next request carries the exec's output: ${JSON.stringify(bodies[1]?.input?.map((item) => item.type))}`);
  const got = JSON.parse(output);
  assert.equal(got.length, 4);
  const told = got.map((call) => `${call.text.length}:${call.text.startsWith('START-') ? 'kept' : 'refused'}`);
  assert.deepEqual(told, Array(4).fill(`${SIZE}:kept`), `each read whole, none refused: ${told.join(', ')}`);
  for (const [i, call] of got.entries()) {
    assert.ok(call.text.startsWith(`START-${i} `), `call ${i} not refused: ${JSON.stringify(call.text.slice(0, 200))}`);
    // Within the per-result bound of a 16k window (12,288 characters), a 10k result goes to the script whole.
    assert.equal(call.text.length, SIZE, `call ${i} whole, as the per-result bound allows: ${call.text.length} characters, ${JSON.stringify(call.text.slice(-120))}`);
  }
  assert.ok(ended.every((e) => !e.truncated), 'none flagged cut');
});
