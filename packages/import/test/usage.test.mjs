// One usage shape for every source: `input` is the input neither read from nor written to the cache. Each provider's
// counts below are worked by hand.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { normalizeUsage, otelUsage, priceRequests, readSession } from "../dist/index.js";
import { codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, parseHome, tempHome, writeJsonl } from "./fixtures.mjs";

test("Anthropic: input_tokens already leaves the cache out; the 1h part of the cache write is its own bucket", () => {
  const raw = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 120, ephemeral_5m_input_tokens: 180 } };
  assert.deepEqual(normalizeUsage("anthropic", raw), { input: 100, output: 50, cacheRead: 2000, cacheWrite: 300, cacheWrite1h: 120 });
  // No 1h part named: none.
  assert.deepEqual(normalizeUsage("anthropic", { input_tokens: 7, output_tokens: 3 }), { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
});

test("OpenAI and Codex: cached_input_tokens is a subset of input_tokens, so input is the difference; reasoning is a subset of output", () => {
  // 1500 in, 1200 of them cached: 300 uncached. 400 out, 250 of them reasoning: output stays 400.
  assert.deepEqual(normalizeUsage("openai", openaiUsage(1500, 1200, 400, 250)), { input: 300, output: 400, cacheRead: 1200, cacheWrite: 0, reasoning: 250 });
  // A cache count over the input is no usage at all.
  assert.equal(normalizeUsage("openai", openaiUsage(10, 20, 5)), undefined);
});

test("OpenAI and Codex: cache_write_input_tokens is part of input_tokens too, so it comes out of input as well", () => {
  // OpenAI's Responses usage puts cache_write_tokens in input_tokens_details ("a detailed breakdown of the input
  // tokens"; "the number of input tokens that were written to the cache"), beside cached_tokens; Codex copies both into
  // its TokenUsage unchanged. 1000 in: 600 read from the cache, 300 written to it, 100 neither.
  assert.deepEqual(normalizeUsage("openai", { ...openaiUsage(1000, 600, 50), cache_write_input_tokens: 300 }), { input: 100, output: 50, cacheRead: 600, cacheWrite: 300, reasoning: 0 });
  // A read and a write that add up to more than the input is no usage at all.
  assert.equal(normalizeUsage("openai", { ...openaiUsage(1000, 600, 50), cache_write_input_tokens: 500 }), undefined);
});

test("pi: already split, taken as written", () => {
  assert.deepEqual(normalizeUsage("pi", { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 15 }), { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 15 });
  // A 1h part over the whole write is dropped, never trusted.
  assert.deepEqual(normalizeUsage("pi", { input: 1, output: 2, cacheRead: 0, cacheWrite: 4, cacheWrite1h: 9 }), { input: 1, output: 2, cacheRead: 0, cacheWrite: 4 });
});

test("OpenCode: input leaves the cache out, output leaves the reasoning out (added back); a total says when output held it", () => {
  // 20 out + 5 reasoning: 25, 5 of it reasoning.
  assert.deepEqual(normalizeUsage("opencode", { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 200 } }), { input: 100, output: 25, cacheRead: 0, cacheWrite: 200, reasoning: 5 });
  // An older OpenCode: total 1000 - 100 in - 600 read = 300, the output as written, not 300 + 200.
  assert.deepEqual(normalizeUsage("opencode", { total: 1000, input: 100, output: 300, reasoning: 200, cache: { read: 600, write: 0 } }), { input: 100, output: 300, cacheRead: 600, cacheWrite: 0, reasoning: 200 });
  // A newer one whose total holds the reasoning beside the output: the same 40 + 10.
  assert.deepEqual(normalizeUsage("opencode", { total: 580, input: 30, output: 40, reasoning: 10, cache: { read: 500, write: 0 } }), { input: 30, output: 50, cacheRead: 500, cacheWrite: 0, reasoning: 10 });
  // All nought (a request cut before its usage came), or a count that is no count: no usage.
  assert.equal(normalizeUsage("opencode", { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }), undefined);
  assert.equal(normalizeUsage("opencode", { input: 1, output: -1 }), undefined);
});

test("OpenCode before 1.3.16 wrote output with its reasoning in it: a session's version says so where no total does", () => {
  const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 200 } };
  // 1.3.15 and older (AI SDK 5, and 6 until anomalyco/opencode#21047): output 20 holds the 5.
  for (const version of ["0.15.0", "1.2.27", "1.3.15", "v1.3.3"]) assert.deepEqual(normalizeUsage("opencode", tokens, { version }), { input: 100, output: 20, cacheRead: 0, cacheWrite: 200, reasoning: 5 }, version);
  // 1.3.16 on: output leaves it out, so 20 + 5. No version, or one that is none, reads as today's.
  for (const version of ["1.3.16", "1.4.0", "1.19.5", "2.3.2", "1.10.0", undefined, "dev"]) assert.deepEqual(normalizeUsage("opencode", tokens, { version }), { input: 100, output: 25, cacheRead: 0, cacheWrite: 200, reasoning: 5 }, String(version));
  // A total says it whatever the version: 580 - 30 - 500 = 50.
  const totalled = { total: 580, input: 30, output: 40, reasoning: 10, cache: { read: 500, write: 0 } };
  for (const version of ["1.2.0", "1.19.5"]) assert.equal(normalizeUsage("opencode", totalled, { version }).output, 50, version);
});

test("OpenRouter: prompt_tokens holds its cached and cache-written tokens, so input is the difference; reasoning is a subset of completion_tokens", () => {
  // 2000 in: 1500 read from the cache, 100 written to it, 400 neither. 300 out, 120 of them reasoning: output stays 300.
  const raw = { prompt_tokens: 2000, completion_tokens: 300, total_tokens: 2300, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 120 } };
  assert.deepEqual(normalizeUsage("openrouter", raw), { input: 400, output: 300, cacheRead: 1500, cacheWrite: 100, reasoning: 120 });
  // A request that only wrote the cache, as OpenRouter's usage-accounting page shows one
  // (https://openrouter.ai/docs/use-cases/usage-accounting): cached_tokens 0, cache_write_tokens 100 inside prompt_tokens
  // 194 (total_tokens 196 is prompt_tokens + 2). Its input is the 94 left; and a trace's input is the 194 again.
  const writeOnly = normalizeUsage("openrouter", { prompt_tokens: 194, completion_tokens: 2, total_tokens: 196, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100, audio_tokens: 0 } });
  assert.deepEqual(writeOnly, { input: 94, output: 2, cacheRead: 0, cacheWrite: 100 });
  assert.deepEqual(otelUsage(writeOnly), { input: 194, output: 2, cacheRead: 0, cacheWrite: 100 });
  // No details at all: nothing cached, no reasoning named.
  assert.deepEqual(normalizeUsage("openrouter", { prompt_tokens: 10, completion_tokens: 4 }), { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 });
  // A cache count over the prompt is no usage at all.
  assert.equal(normalizeUsage("openrouter", { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 11 } }), undefined);
  // A reasoning count over the completion is dropped, never trusted.
  assert.deepEqual(normalizeUsage("openrouter", { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 9 } }), { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 });
});

test("otelUsage: a trace's input holds the cache (input + cacheRead + cacheWrite); every other count as it was", () => {
  // Anthropic's 100 uncached + 2000 read + 300 written: 2400 in on the span, the cache counts beside it unchanged.
  const anthropic = normalizeUsage("anthropic", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 });
  assert.deepEqual(otelUsage(anthropic), { input: 2400, output: 50, cacheRead: 2000, cacheWrite: 300 });
  // OpenAI's input_tokens already held its cache: the round trip gives back its own 1500, with the reasoning kept.
  assert.deepEqual(otelUsage(normalizeUsage("openai", openaiUsage(1500, 1200, 400, 250))), { input: 1500, output: 400, cacheRead: 1200, cacheWrite: 0, reasoning: 250 });
  // OpenRouter's prompt_tokens the same: 2000 back.
  assert.deepEqual(otelUsage(normalizeUsage("openrouter", { prompt_tokens: 2000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 100 } })), { input: 2000, output: 300, cacheRead: 1500, cacheWrite: 100 });
  // pi's split figures: summed.
  assert.deepEqual(otelUsage(normalizeUsage("pi", { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })), { input: 80, output: 20, cacheRead: 30, cacheWrite: 40 });
});

test("unknown or broken counts: undefined, never zeros", () => {
  assert.equal(normalizeUsage("anthropic", undefined), undefined);
  assert.equal(normalizeUsage("anthropic", { output_tokens: 3 }), undefined);
  assert.equal(normalizeUsage("pi", { input: -1, output: 2 }), undefined);
  assert.equal(normalizeUsage("openai", { input_tokens: 1.5, output_tokens: 2 }), undefined);
});

test("Codex: a session's usage is the sum of each request's last_token_usage, never total_token_usage, and a repeated total is no new request", async (t) => {
  const home = await tempHome(t);
  const first = openaiUsage(1000, 800, 100, 40); // uncached 200
  const second = openaiUsage(3000, 2900, 250, 0); // uncached 100
  await writeJsonl(codexFile(home), [
    codexMeta("thread-1"),
    codexContext(1),
    codexUser("Fixture question.", 2),
    codexAnswer("Fixture answer.", 3),
    codexTokens(first, openaiUsage(1000, 800, 100, 40), 4),
    // The same total again: Codex repeats a token_count with no new request.
    codexTokens(first, openaiUsage(1000, 800, 100, 40), 5),
    codexAnswer("Second answer.", 6),
    codexTokens(second, openaiUsage(4000, 3700, 350, 40), 7),
  ]);
  const session = await readSession(codexFile(home), "codex");
  const usages = session.turns.filter((turn) => turn.role === "assistant").map((turn) => turn.usage);
  assert.deepEqual(usages, [
    { input: 200, output: 100, cacheRead: 800, cacheWrite: 0, reasoning: 40 },
    { input: 100, output: 250, cacheRead: 2900, cacheWrite: 0, reasoning: 0 },
  ]);
  const [totals] = await parseHome(home, { sources: ["codex"] });
  // 200 + 100 uncached in, 100 + 250 out, 800 + 2900 cached: not the totals' 4000 in.
  assert.deepEqual(totals.tokens, { input: 300, output: 350, cacheRead: 3700, cacheWrite: 0, cacheWrite1h: 0 });
  assert.equal(totals.calls, 2);
});

test("priceRequests prices each request at its own provider's catalog entry, a 1h cache write at twice the input price", async () => {
  const catalog = new Map([["m1", [{ provider: "other", cost: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 } }, { provider: "p", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }]]]);
  // 1000 x 3 + 100 x 15 + 10000 x 0.3 + 1500 x 3.75 + 500 x 6 = 16125 per million.
  const usage = { input: 1000, output: 100, cacheRead: 10000, cacheWrite: 2000, cacheWrite1h: 500 };
  assert.equal(await priceRequests([{ model: "p/m1", usage }], catalog), 0.016125);
  // A model the catalog does not list, or a request with no counts: unknown, never $0.
  assert.equal(await priceRequests([{ model: "p/m2", usage }], catalog), undefined);
  assert.equal(await priceRequests([{ model: "p/m1" }], catalog), undefined);
  // A request of no tokens costs nothing at any price.
  assert.equal(await priceRequests([{ model: "q/unlisted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], catalog), 0);
});

test("a pi-ai that fails to load fails the price with its reason: never a cost of null that says nothing why", () => {
  const index = new URL("../dist/index.js", import.meta.url).href;
  // A loader hook that makes every @earendil-works/pi-ai specifier unresolvable, as a broken install.
  const hooks = `data:text/javascript,${encodeURIComponent('export async function resolve(s, c, next) { if (s.startsWith("@earendil-works/pi-ai")) { const e = new Error("Cannot find package " + s); e.code = "ERR_MODULE_NOT_FOUND"; throw e; } return next(s, c); }')}`;
  const register = `data:text/javascript,${encodeURIComponent(`import { register } from "node:module"; register(${JSON.stringify(hooks)}, ${JSON.stringify(index)});`)}`;
  const script = `
    const { builtinCatalog, priceRequests } = await import(${JSON.stringify(index)});
    const catalog = new Map([["m1", [{ provider: "p", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }]]]);
    for (const call of [() => priceRequests([{ model: "p/m1", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }], catalog), () => builtinCatalog()])
      console.log(await call().then((value) => "resolved " + value, (error) => "rejected " + error.message));
  `;
  const result = spawnSync(process.execPath, ["--import", register, "--input-type=module", "-e", script], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /^rejected Cannot find package @earendil-works\/pi-ai/);
});
