// One usage shape for every source: `input` is the input neither read from nor written to the cache. Each provider's
// counts below are worked by hand.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { normalizeUsage, parseHome, priceRequests, readSession } from "../dist/index.js";
import { codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, tempHome, writeJsonl } from "./fixtures.mjs";

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
