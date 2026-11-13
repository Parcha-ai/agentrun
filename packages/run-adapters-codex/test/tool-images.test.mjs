// A host tool's image on the Codex adapter, on the pinned binary with a scripted provider behind the session's proxy: it
// reaches the model as an image. Codex 0.164's app-server takes a dynamic tool's output as `contentItems`, each `inputText`
// or `inputImage` with an `imageUrl` (DynamicToolCallResponse, `codex app-server generate-json-schema`); the harness gave it
// the text alone, so a read of a frame in the box's /tmp reached the model as a line naming the file and no picture.
// No network.
//
// Without the binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing one fails (tool-off.test).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as kernel from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const skip = problem && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-images-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const sse = (n, items) => [
  { type: 'response.created', response: { id: `resp_${n}` } },
  ...items.map((item) => ({ type: 'response.output_item.done', item })),
  { type: 'response.completed', response: { id: `resp_${n}`, usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const say = (n) => ({ type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'done' }] });
const submit = { type: 'function_call', name: 'submit', arguments: JSON.stringify({ value: { answer: 'ok' } }), call_id: 'call_submit' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex').toString('base64');

test("on the pinned binary, a host tool's image reaches the model as an image item of the tool's output, after its text", { skip, timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(ROOT, 'run-'));
  const seen = [];
  const answers = [[{ type: 'function_call', name: 'read', arguments: JSON.stringify({ path: '/tmp/view/frame.png' }), call_id: 'call_read' }], [submit]];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const n = seen.length;
    return new Response(sse(n, answers[n - 1] ?? [say(n)]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const codex = codexAdapter({ model: 'gpt-5.4-mini', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), fetch });
  const read = { name: 'read', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, replay: 'safe', call: async () => ({ text: '/tmp/view/frame.png: image/png, 70 bytes', images: [{ mimeType: 'image/png', data: PNG }] }) };
  const runNode = kernel.createHarnessRunner(codex, { store: memorySessionStore(), tools: [read], timeoutMs: 120_000 });
  const output = await runNode({ kind: 'agent', label: 'images', system: ['Answer.'], user: 'Look at the frame, then answer ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['read'] });
  assert.deepEqual(output, { answer: 'ok' });
  const sent = (seen[1]?.input ?? []).find((item) => item.type === 'function_call_output' && item.call_id === 'call_read');
  assert.ok(sent, "read's output went back to the model");
  assert.ok(Array.isArray(sent.output), `the output is items, not a string: ${JSON.stringify(sent.output).slice(0, 200)}`);
  assert.deepEqual(sent.output.map((o) => o.type), ['input_text', 'input_image']);
  assert.equal(sent.output[0].text, '/tmp/view/frame.png: image/png, 70 bytes');
  assert.equal(sent.output[1].image_url, `data:image/png;base64,${PNG}`);
});

test("in code mode, a nested host tool's image is not sent: Codex hands an exec script a tool's image as a data: URL in its text, so the script gets the text and a line that it was not sent, never the base64", { skip, timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(ROOT, 'code-'));
  const seen = [];
  const exec = (callId, js) => ({ type: 'custom_tool_call', name: 'exec', input: js, call_id: callId });
  const answers = [
    [exec('call_look', `const r = await tools.read({ path: '/tmp/view/frame.png' }); text(String(r));`)],
    [exec('call_submit', `text(JSON.stringify(await tools.submit({ value: { answer: 'ok' } })));`)],
  ];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const n = seen.length;
    return new Response(sse(n, answers[n - 1] ?? [say(n)]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const codex = codexAdapter({ model: 'gpt-6-sol', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), fetch });
  const read = { name: 'read', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, replay: 'safe', call: async () => ({ text: '/tmp/view/frame.png: image/png, 70 bytes', images: [{ mimeType: 'image/png', data: PNG }] }) };
  const runNode = kernel.createHarnessRunner(codex, { store: memorySessionStore(), tools: [read], timeoutMs: 120_000 });
  const output = await runNode({ kind: 'agent', label: 'code-images', system: ['Answer.'], user: 'Look at the frame, then answer ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['read'] });
  assert.deepEqual(output, { answer: 'ok' });
  assert.equal(seen.some((body) => JSON.stringify(body).includes(PNG)), false, 'no request to the model carries the image as text');
  const told = seen.flatMap((body) => body.input ?? []).filter((item) => item.call_id === 'call_look' && /_output$/.test(item.type ?? '')).map((item) => JSON.stringify(item.output));
  assert.ok(told.some((t) => t.includes('/tmp/view/frame.png: image/png, 70 bytes')), `the script got the tool's text: ${told.join(' | ').slice(0, 300)}`);
  assert.ok(told.some((t) => /1 image .*not sent/.test(t)), `and a line that its image was not sent: ${told.join(' | ').slice(0, 300)}`);
});
