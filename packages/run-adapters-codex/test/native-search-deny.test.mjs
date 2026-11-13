// A deny set while a run is live reaches Codex's own live web search. The run's process is built with web search live
// (the plane resolved web_search to native at launch); later the operator denies web_search. The adapter's one channel
// that hears a permission change mid-run is the host's gate (SessionIO.gate: the runner's RunGate reads the tool
// settings at each call), so the test's gate starts allowing everything and denies everything once the deny is set.
// Codex's search is run by the provider inside a model request (a `web_search_call`), so no call reaches a hook before it
// runs: after the deny, no request the session sends may offer the provider its web_search tool. The pinned Codex binary
// and the adapter's real proxy run against a scripted fetch answering in the Responses API's format. No network.
//
// Without the binary the case skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing or different binary fails.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const skip = problem && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-search-deny-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const DENIED = 'Permission denied: web_search is set to deny.';
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 };
const sse = (n, items, searches) => [
  { type: 'response.created', response: { id: `resp_${n}`, object: 'response', status: 'in_progress' } },
  ...items.flatMap((item, i) => [{ type: 'response.output_item.added', output_index: i, item: { ...item, status: 'in_progress' } }, { type: 'response.output_item.done', output_index: i, item }]),
  { type: 'response.completed', response: { id: `resp_${n}`, object: 'response', status: 'completed', output: items, usage, tool_usage: { web_search: { num_requests: searches } } } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const search = (n) => ({ type: 'web_search_call', id: `ws_${n}`, status: 'completed', action: { type: 'search', query: `agentrun ${n}` } });
const say = (n) => ({ type: 'message', role: 'assistant', id: `msg_${n}`, status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] });
/** Whether a request body offers the provider its web search tool. */
const offersSearch = (body) => (body.tools ?? []).some((tool) => tool.type === 'web_search' || tool.type === 'web_search_preview');

test("a deny set mid-run reaches Codex's live web search: no request after it offers the provider web_search", { skip, timeout: 120_000 }, async (t) => {
  const seen = [];
  // Each request the provider gets it answers with a search it ran, then a message: the "model" searches every turn.
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    return new Response(sse(seen.length, offersSearch(body) ? [search(seen.length), say(seen.length)] : [say(seen.length)], offersSearch(body) ? 1 : 0), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const codex = codexAdapter({ model: 'gpt-5.4-mini', webSearch: 'live', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(mkdtempSync(join(ROOT, 's-')), 'sessions'), fetch, price: () => 0 });
  let denied = false;
  const asked = [];
  const gate = async (call) => {
    asked.push({ tool: call.tool, denied });
    return denied ? { deny: DENIED } : 'allow';
  };
  const store = memorySessionStore();
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: () => {}, gate };
  const session = await codex.open({ key: 's1', label: 'root', system: [], tools: [], context: 'fresh' }, io);
  t.after(() => session.close());

  // Turn 1, web_search allowed: Codex offers the provider its live search, and the provider searches.
  await session.send('search');
  assert.equal((await session.turnEnd()).status, 'completed');
  assert.ok(seen.length >= 1 && seen.every(offersSearch), `turn 1 offered web search: ${JSON.stringify(seen.map((b) => (b.tools ?? []).map((tool) => tool.type)))}`);

  // The operator denies web_search while the run is live: from now on the run's gate refuses it.
  denied = true;
  const before = seen.length;
  await session.send('search again');
  await session.turnEnd();
  const after = seen.slice(before);
  assert.deepEqual(
    after.filter(offersSearch).map((b) => b.tools.map((tool) => tool.type)),
    [],
    `after the deny, ${after.filter(offersSearch).length} of ${after.length} requests still offered the provider web_search; the gate was asked about ${JSON.stringify(asked.filter((a) => a.denied).map((a) => a.tool))}`,
  );
});
