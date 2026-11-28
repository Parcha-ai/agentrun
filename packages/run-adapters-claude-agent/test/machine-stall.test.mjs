// The session machine's proxy stops a request its provider sends nothing on, at the bound the host gives the machine
// (`proxy.stallMs`: the adapter gives the CLI's own wait on a local model, streamIdleMs), and the host's turn ends in the
// stall's words (ctx.halt). The CLI is told the same as the stream's last event. No CLI: the test is the CLI's client,
// asking the machine's proxy as the CLI does; the provider is a fetch that answers its first event and goes silent.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { localMachine } from '../dist/host/machine.js';
import { gatewayHandler } from '../dist/host/process.js';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-stall-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
/** The machine's bound in this test (the test's own timeout is far short of the default bound, so a machine that
 *  drops it fails): short, as the request waits on it in real time. */
const STALL_MS = 1_000;
const WORDS = 'the model sent nothing for 1 s, so the request was stopped';

test("the machine's proxy stops a request at the bound the host gives it: the CLI reads the stall's error event, and the host's turn ends in its words", { timeout: 60_000 }, async (t) => {
  const halted = [];
  let forwarded = 0;
  const acquire = localMachine({ dir: mkdtempSync(join(ROOT, 'm-')), proxy: {
    hooks: { beforeRequest: async () => {}, afterRequest: async () => {} },
    tools: [],
    stallMs: STALL_MS,
    // The provider's 200 and first event, then nothing until the proxy stops the request.
    fetch: async (_url, init) => {
      forwarded += 1;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-main', usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`));
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  } });
  const handler = gatewayHandler({ routes: [], models: { model: 'claude-main' }, credential: () => 'provider-secret', target: 'https://provider.invalid' });
  const machine = await acquire({ ctx: { runId: 'r-stall', halt: (error) => halted.push(error.message) }, model: handler });
  t.after(() => machine.close());
  const res = await fetch(`${machine.modelUrl}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.modelKey}` }, body: JSON.stringify({ model: 'claude-main', max_tokens: 64, stream: true, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(res.status, 200);
  const events = (await res.text()).split('\n\n').filter(Boolean).map((event) => ({ name: /^event: (.*)$/m.exec(event)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(event)[1]) }));
  assert.deepEqual(events.map((event) => event.name), ['message_start', 'error'], 'the stream ends in the stall\'s error event');
  assert.deepEqual(events[1].data.error, { type: 'agentrun_proxy', code: 'model_stalled', message: WORDS });
  assert.deepEqual(halted, [WORDS], 'the host ends the turn in the stall\'s words');
  assert.equal(forwarded, 1);
});
