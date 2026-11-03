// A host tool's long result on the Codex adapter, on the pinned binary with a scripted provider behind the session's
// proxy: it reaches the model whole. Codex keeps a tool's output in the model's history within its truncation policy,
// 10,000 tokens (at four bytes a token) for every model its catalog holds, and cuts the middle of a longer one
// ("…N tokens truncated…"); `tool_output_token_limit` in its config sets the policy, and the adapter sets it from the
// host's result bound (HOST_RESULT_MAX_CHARS) as Codex counts it: four bytes of UTF-8 a token, so a result in a script
// of three bytes a character (CJK) takes three quarters of a token a character. No network.
//
// Without the binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing one fails (tool-off.test).
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as kernel from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { CODEX_TOOL_OUTPUT_TOKENS, codexAdapter } from '@parcha/agentrun-harness-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const skip = problem && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-size-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const sse = (n, items) => [
  { type: 'response.created', response: { id: `resp_${n}` } },
  ...items.map((item) => ({ type: 'response.output_item.done', item })),
  { type: 'response.completed', response: { id: `resp_${n}`, usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const say = (n) => ({ type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'done' }] });
const submit = { type: 'function_call', name: 'submit', arguments: JSON.stringify({ value: { answer: 'ok' } }), call_id: 'call_submit' };
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

/** `size` characters of numbered lines, so a cut in their middle shows. */
const pageOf = (size) => {
  let text = '';
  for (let n = 1; text.length < size; n++) text += `line ${String(n).padStart(6, '0')}: the "answer" is forty-two.\n`;
  return text.slice(0, size);
};

test("on the pinned binary, a host tool's result past Codex's default truncation reaches the model whole: its tool output limit is the host's bound", { skip, timeout: 180_000 }, async () => {
  const size = 90_000;
  const text = pageOf(size);
  // Just under the bound, three bytes of UTF-8 a character: a quarter of a token a character would cut it.
  const wide = '世界'.repeat((kernel.HOST_RESULT_MAX_CHARS - 1_000) / 2);
  const dir = mkdtempSync(join(ROOT, 'run-'));
  const seen = [];
  const answers = [[{ type: 'function_call', name: 'page', arguments: '{}', call_id: 'call_page' }, { type: 'function_call', name: 'wide', arguments: '{}', call_id: 'call_wide' }], [submit]];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const n = seen.length;
    return new Response(sse(n, answers[n - 1] ?? [say(n)]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const sessionsDir = join(dir, 'sessions');
  const codex = codexAdapter({ model: 'gpt-5.4-mini', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir, fetch });
  const page = { name: 'page', description: 'A long page.', inputSchema: { type: 'object', properties: {} }, replay: 'safe', call: async () => ({ text }) };
  const widePage = { name: 'wide', description: 'A long page in CJK.', inputSchema: { type: 'object', properties: {} }, replay: 'safe', call: async () => ({ text: wide }) };
  const runNode = kernel.createHarnessRunner(codex, { store: memorySessionStore(), tools: [page, widePage], timeoutMs: 120_000 });
  const output = await runNode({ kind: 'agent', label: 'size', system: ['Answer.'], user: 'Read the pages, then answer ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['page', 'wide'] });
  assert.deepEqual(output, { answer: 'ok' });
  for (const [callId, whole] of [['call_page', text], ['call_wide', wide]]) {
    const sent = (seen[1]?.input ?? []).find((item) => item.type === 'function_call_output' && item.call_id === callId);
    assert.ok(sent, `${callId}'s output went back to the model`);
    const got = Array.isArray(sent.output) ? sent.output.map((o) => o.text ?? '').join('') : String(sent.output);
    assert.ok(!/tokens truncated|chars truncated/.test(got), `${callId} not cut: ${got.length} characters`);
    assert.equal(got, whole, `${callId}: every character`);
  }
  assert.equal(CODEX_TOOL_OUTPUT_TOKENS, Math.ceil((kernel.HOST_RESULT_MAX_CHARS * 3) / 4));
  const config = readFileSync(files(sessionsDir).find((f) => f.endsWith(join('codex-home', 'config.toml'))), 'utf8');
  assert.match(config, new RegExp(`^tool_output_token_limit = ${CODEX_TOOL_OUTPUT_TOKENS}$`, 'm'), "the session's config sets the limit from the host's bound");
});
