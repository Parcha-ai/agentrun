// A code-mode script's JSON read too large for a 16k model's window share: Codex hands a script a failed call's text as
// its value (it never throws), so the script parses what it is handed. Handed half the document, the parse fails on a
// character in the middle and the model reads nothing of the cut; handed the cut's note, the parse fails naming it, and
// the model, reading the exec's error, knows to ask for less. The pinned binary, through the adapter, with a scripted
// Responses provider behind the session's proxy. No network.
//
// Without the binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing or different binary fails.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const required = env.AGENTRUN_CODEX_REQUIRE_BINARY === '1';
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-cut-read-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const MODEL = 'gpt-6-sol';
const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const sse = (n, items) => [
  { type: 'response.created', response: { id: `resp_${n}` } },
  ...items.map((item) => ({ type: 'response.output_item.done', item })),
  { type: 'response.completed', response: { id: `resp_${n}`, usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const exec = (callId, js) => ({ type: 'custom_tool_call', name: 'exec', input: js, call_id: callId });
const say = (n) => ({ type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'done' }] });
/** A provider that answers request n with `script[n - 1]` (or a plain reply past its end), keeping what it was sent. */
function provider(script) {
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const n = seen.length;
    return new Response(sse(n, script[n - 1] ?? [say(n)]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { seen, fetch };
}
/** What the model was told about `callId`'s outcome, from the requests it was sent. */
const toldAbout = (seen, callId) => seen.flatMap((body) => body.input ?? []).filter((item) => item.call_id === callId && /_output$/.test(item.type ?? '')).map((item) => (Array.isArray(item.output) ? item.output.map((o) => o.text ?? '').join('\n') : String(item.output)));

test("code mode, a 16k model: a script that parses a JSON read too large for its window share fails naming the cut", { skip, timeout: 120_000 }, async () => {
  // MUTATION: a script's read cut like the model's hands the script half the document: its parse fails mid-string
  // ("Bad control character ..."), and the model reads nothing that says the read was cut.
  const rows = JSON.stringify({ rows: Array.from({ length: 2_000 }, (_, i) => ({ id: i, name: `row ${i}` })) });
  const read = { name: 'read', description: 'Reads the rows.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: rows }) };
  const { seen, fetch } = provider([
    [exec('call_read', `const data = JSON.parse(await tools.read({}));\ntext('rows: ' + data.rows.length);`)],
    [exec('call_submit', `text(JSON.stringify(await tools.submit({ value: { answer: 'ok' } })));`)],
  ]);
  const adapter = codexAdapter({ model: MODEL, contextWindow: 16_384, provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: mkdtempSync(join(ROOT, 'box-')), fetch });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [read], timeoutMs: 90_000 });
  const output = await runNode({ kind: 'agent', label: 'rows', system: ['Count.'], user: 'Count the rows.', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, tools: ['read'] });
  assert.deepEqual(output, { answer: 'ok' });
  const told = toldAbout(seen, 'call_read').join('\n');
  assert.doesNotMatch(told, /rows: 2000/, 'the whole document never reached the script');
  assert.match(told, /\[read cut:/, `the model reads that the read was cut: ${told.slice(0, 600)}`);
});
