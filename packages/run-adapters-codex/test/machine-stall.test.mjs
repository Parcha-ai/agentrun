// The session machine's proxy stops a request its provider sends nothing on, at the bound the host gives the machine
// (`proxy.stallMs`: the adapter gives Codex's own wait on a local model, streamIdleMs), and the host's turn ends in the
// stall's words (ctx.halt). Codex is told the same as the stream's last event. No Codex binary: the test is Codex's
// client, asking the machine's proxy as Codex does; the provider is a fetch that answers its first event and goes silent.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CODEX_ROUTES, gatewayHandler } from '../dist/host/process.js';
import { localMachine } from '../dist/host/machine.js';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-stall-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const route = { routes: CODEX_ROUTES, models: { model: 'luna-test' }, credential: () => 'provider-secret', target: 'https://provider.invalid' };
const RECORDED_REQUEST = JSON.parse(readFileSync(new URL('./fixtures/responses-request-recorded.json', import.meta.url), 'utf8'));
/** The machine's bound in this test (the test's own timeout is far short of the default bound, so a machine that
 *  drops it fails): short, as the run waits on it in real time. */
const STALL_MS = 1_000;
const WORDS = 'the model sent nothing for 1 s, so the request was stopped';

test("the machine's proxy stops a request at the bound the host gives it: Codex reads the stall's error event, and the host's turn ends in its words", { timeout: 60_000 }, async (t) => {
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
          controller.enqueue(new TextEncoder().encode(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } })}\n\n`));
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  } });
  const machine = await acquire({ ctx: { runId: 'r-stall', halt: (error) => halted.push(error.message) }, model: gatewayHandler(route) });
  t.after(() => machine.close());
  const res = await fetch(`${machine.modelUrl}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.modelKey}`, accept: 'text/event-stream' }, body: JSON.stringify(RECORDED_REQUEST) });
  assert.equal(res.status, 200);
  const events = (await res.text()).split('\n\n').filter(Boolean).map((event) => JSON.parse(/^data: (.*)$/m.exec(event)[1]));
  assert.deepEqual(events.map((event) => event.type), ['response.created', 'error'], 'the stream ends in the stall\'s error event');
  assert.equal(events[1].code, 'model_stalled');
  assert.equal(events[1].message, WORDS);
  assert.deepEqual(halted, [WORDS], 'the host ends the turn in the stall\'s words');
  assert.equal(forwarded, 1);
});
