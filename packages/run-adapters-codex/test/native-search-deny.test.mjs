// A deny set while a run is live reaches Codex's own live web search. The run's process is built with web search live
// (the plane resolved web_search to native at launch); later the operator denies web_search, or sets it to ask. Codex's
// search is run by the provider inside a model request (a `web_search_call`), so no call reaches a hook or the per-call
// gate before it runs: the host's current setting for the tool (SessionIO.permission: the runner's RunGate reads the
// tool settings at each read) is what the adapter's proxy reads before each request. The per-call gate is not the
// channel here: asking it once per request would record a refused call, or park the run on the person, for every
// request. After a deny, or an ask nobody has answered, no request the session sends may offer the provider its
// web_search tool. The pinned Codex binary and the adapter's real proxy run against a scripted fetch answering in the
// Responses API's format. No network.
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

/** A live-search session on the pinned binary whose host setting for web_search is `setting()` at each read. */
async function searching(t, setting) {
  const seen = [];
  // Each request the provider gets it answers with a search it ran, then a message: the "model" searches every turn.
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    return new Response(sse(seen.length, offersSearch(body) ? [search(seen.length), say(seen.length)] : [say(seen.length)], offersSearch(body) ? 1 : 0), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const codex = codexAdapter({ model: 'gpt-6.1-terra', webSearch: 'live', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(mkdtempSync(join(ROOT, 's-')), 'sessions'), fetch, price: () => 0 });
  const asked = [];
  const read = [];
  // The per-call gate refuses whatever the setting does not allow; the test records whether anything asked it.
  const gate = async (call) => {
    asked.push(call.tool);
    return setting() === 'allow' ? 'allow' : { deny: DENIED };
  };
  const permission = async (tool) => {
    read.push(tool);
    const now = setting();
    if (now instanceof Error) throw now;
    return now;
  };
  const store = memorySessionStore();
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: () => {}, gate, permission };
  const session = await codex.open({ key: 's1', label: 'root', system: [], tools: [], context: 'fresh' }, io);
  t.after(() => session.close());

  // Turn 1, web_search allowed: Codex offers the provider its live search, and the provider searches.
  await session.send('search');
  assert.equal((await session.turnEnd()).status, 'completed');
  assert.ok(seen.length >= 1 && seen.every(offersSearch), `turn 1 offered web search: ${JSON.stringify(seen.map((b) => (b.tools ?? []).map((tool) => tool.type)))}`);
  /** The requests of one more turn. */
  const turn = async (text) => {
    const before = seen.length;
    await session.send(text);
    const end = await session.turnEnd();
    return { end, after: seen.slice(before) };
  };
  return { turn, asked, read };
}

const offered = (requests) => requests.filter(offersSearch).map((b) => b.tools.map((tool) => tool.type));

test("a deny set mid-run reaches Codex's live web search: no request after it offers the provider web_search", { skip, timeout: 120_000 }, async (t) => {
  let now = 'allow';
  const { turn, asked } = await searching(t, () => now);
  // The operator denies web_search while the run is live.
  now = 'deny';
  const { after } = await turn('search again');
  assert.ok(after.length >= 1, 'the turn reached the provider');
  assert.deepEqual(offered(after), [], `after the deny, ${offered(after).length} of ${after.length} requests still offered the provider web_search; the gate was asked about ${JSON.stringify(asked)}`);
});

test("ask set mid-run on Codex's live web search: no search until the person answers, and an allow brings it back", { skip, timeout: 120_000 }, async (t) => {
  let now = 'allow';
  const { turn, read } = await searching(t, () => now);
  // The operator sets web_search to ask: nobody has answered, so nothing may search.
  now = 'ask';
  const asking = await turn('search again');
  assert.equal(asking.end.status, 'completed', 'the turn goes on without search');
  assert.ok(asking.after.length >= 1, 'the turn reached the provider');
  assert.deepEqual(offered(asking.after), [], `under ask, ${offered(asking.after).length} of ${asking.after.length} requests offered web_search`);
  assert.ok(read.includes('web_search'), 'the setting was read for the request');
  // The setting goes back to allow: the next request offers search again, with no new session.
  now = 'allow';
  const allowed = await turn('and again');
  assert.ok(allowed.after.length >= 1 && allowed.after.every(offersSearch), `after the allow, search is offered again: ${JSON.stringify(allowed.after.map((b) => (b.tools ?? []).map((tool) => tool.type)))}`);
});

test("a failed read of web_search's setting on Codex offers no search: it fails closed", { skip, timeout: 120_000 }, async (t) => {
  let now = 'allow';
  const { turn } = await searching(t, () => now);
  now = new Error('store unreachable');
  const { after } = await turn('search again');
  assert.ok(after.length >= 1, 'the turn reached the provider');
  assert.deepEqual(offered(after), [], 'a failed read is not an allow');
});
