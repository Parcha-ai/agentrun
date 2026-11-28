// A model on the host's own machine (an Ollama model the route translates) can send nothing for minutes while it loads
// or reads a long prompt; on a slow machine that passes Codex's five-minute stream idle limit, and Codex ends the turn
// ("stream disconnected before completion: idle timeout waiting for SSE"). The host says so (`streamIdleMs`,
// LOCAL_STREAM_IDLE_MS, as claude-agent's) and Codex's provider waits that long (`stream_idle_timeout_ms`). Any other
// route keeps Codex's own limit, so a hung stream holds the run's slot and cap no longer than that.
//
// The config is checked always; the run on the pinned binary skips without it (AGENTRUN_CODEX_REQUIRE_BINARY=1 fails).
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as kernel from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter, LOCAL_STREAM_IDLE_MS } from '@parcha/agentrun-harness-codex';
import { codexConfig, toToml } from '../dist/config.js';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const skip = problem && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-idle-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const base = { model: 'm', baseUrl: 'http://127.0.0.1:1/v1', envKey: 'KEY', contextWindow: 1000 };
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const submit = { type: 'function_call', name: 'submit', arguments: JSON.stringify({ value: { answer: 'ok' } }), call_id: 'call_submit' };
const sse = [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_item.done', item: submit },
  { type: 'response.completed', response: { id: 'resp_1', usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

test("a local model's provider waits LOCAL_STREAM_IDLE_MS (30 minutes) on a silent stream; any other keeps Codex's own limit", () => {
  assert.equal(LOCAL_STREAM_IDLE_MS, 30 * 60_000);
  assert.equal(codexConfig(base).model_providers.gateway.stream_idle_timeout_ms, undefined, "Codex's own limit");
  const local = codexConfig({ ...base, streamIdleMs: LOCAL_STREAM_IDLE_MS });
  assert.equal(local.model_providers.gateway.stream_idle_timeout_ms, 1_800_000);
  assert.match(toToml(local), /\[model_providers\.gateway\][^[]*\nstream_idle_timeout_ms = 1800000\n/);
});

test("on the pinned binary, the adapter's streamIdleMs is the session's config, and Codex runs on it", { skip, timeout: 180_000 }, async () => {
  const configOf = async (extra) => {
    const sessionsDir = join(mkdtempSync(join(ROOT, 'run-')), 'sessions');
    const fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const codex = codexAdapter({ model: 'gpt-6-luna', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir, fetch, ...extra });
    const runNode = kernel.createHarnessRunner(codex, { store: memorySessionStore(), tools: [], timeoutMs: 120_000 });
    assert.deepEqual(await runNode({ kind: 'agent', label: 'idle', system: ['Answer.'], user: 'Answer ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] }), { answer: 'ok' });
    return readFileSync(files(sessionsDir).find((f) => f.endsWith(join('codex-home', 'config.toml'))), 'utf8');
  };
  assert.match(await configOf({ streamIdleMs: LOCAL_STREAM_IDLE_MS }), /^stream_idle_timeout_ms = 1800000$/m, 'a local model: 30 minutes');
  assert.doesNotMatch(await configOf({}), /stream_idle_timeout_ms/, "any other: Codex's own");
});
