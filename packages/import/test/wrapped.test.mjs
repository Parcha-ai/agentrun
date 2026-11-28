// wrappedHome: a year of work under a home, bucketed by each request's time in the local zone.
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { catalogOf } from "../dist/index.js";
import { anthropicUsage, at, claudeAnswer, claudeFile, claudeUser, piFile, piMeta, piUser, tempHome, wrappedHome, writeJsonl } from "./fixtures.mjs";
import { buildChat } from "./fixtures/cursor/fixture.mjs";

const WORDS = "Fixture prompt, never reported.";
const answer = (n, i, usage = anthropicUsage(100, 10, 50, 5), model = "claude-fixture-1") => claudeAnswer({ uuid: `a${n}`, msg: `m${n}`, req: `r${n}`, usage, i, model });
const piAnswer = (i, model = "fx-model") => ({ type: "message", timestamp: at(i), message: { role: "assistant", provider: "fx", model, content: [{ type: "text", text: "w" }], stopReason: "stop", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0 } } } });
const nothing = { catalog: false };

test("a session across New Year splits by request: tokens, requests and days to each year, the session to the year it began in", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: WORDS, i: -300 }), answer(1, -120), answer(2, 60), answer(3, 120)]);
  const was = await wrappedHome(home, 2025, nothing);
  const now = await wrappedHome(home, 2026, nothing);
  assert.deepEqual([was.sessions, was.requests, was.tokens.input, was.days.map((d) => d.day)], [1, 1, 100, ["2025-12-31"]]);
  assert.deepEqual([now.sessions, now.requests, now.tokens.input, now.tokens.cacheRead, now.days.map((d) => [d.day, d.requests, d.tokens])], [0, 2, 200, 100, [["2026-01-01", 2, 330]]]);
  assert.equal(now.turns, 0, "the session's prompts count with the session, in 2025");
  assert.equal(was.turns, 1);
  assert.equal((await wrappedHome(home, 2024, nothing)).requests, 0);
});

test("hours and weekdays follow the machine's local zone", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: WORDS, i: 0 }), answer(1, 5 * 3600), answer(2, 5 * 3600 + 30)]);
  const utc = await wrappedHome(home, 2026, nothing);
  assert.deepEqual([utc.hours[5], utc.weekdays[4]], [2, 2], "05:00 UTC, Thursday 2026-01-01");
  process.env.TZ = "America/Los_Angeles";
  try {
    const la = await wrappedHome(home, 2026, nothing);
    assert.equal(la.requests, 0, "21:00 on Dec 31 there: 2025");
    const was = await wrappedHome(home, 2025, nothing);
    assert.deepEqual([was.requests, was.hours[21], was.weekdays[3], was.days[0].day], [2, 2, 2, "2025-12-31"]);
  } finally {
    process.env.TZ = "UTC";
  }
});

test("time at work counts the gaps under the idle limit and none past it", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: WORDS, i: 0 }), answer(1, 10), answer(2, 70), answer(3, 70 + 20 * 60), answer(4, 70 + 20 * 60 + 30)]);
  assert.equal((await wrappedHome(home, 2026, nothing)).activeMs, 60_000 + 30_000);
});

test("models, harnesses and sources: tokens by the request's model, sessions by the reader's harness", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: WORDS, i: 0 }), answer(1, 10), answer(2, 20, anthropicUsage(1, 1), "claude-other")]);
  await writeJsonl(piFile(home), [piMeta(), piUser(WORDS, 1), piAnswer(30)]);
  const wrapped = await wrappedHome(home, 2026, nothing);
  assert.deepEqual(wrapped.models.map((m) => [m.model, m.requests]), [["anthropic/claude-fixture-1", 1], ["fx/fx-model", 1], ["anthropic/claude-other", 1]]);
  assert.deepEqual(wrapped.sources.map((s) => [s.source, s.sessions, s.requests]).sort(), [["claude-code", 1, 2], ["pi", 1, 1]]);
  assert.equal(wrapped.sessions, 2);
  assert.equal(wrapped.harnesses.reduce((n, h) => n + h.sessions, 0), 2);
  assert.equal(wrapped.harnesses.reduce((n, h) => n + h.tokens, 0), 165 + 2 + 10);
});

test("cost is the list price of the requests it can price; the rest are counted, not dropped", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: WORDS, i: 0 }), answer(1, 10), answer(2, 20, anthropicUsage(1, 1), "claude-unlisted")]);
  const price = (model, usage) => (model === "anthropic/claude-fixture-1" ? usage.input / 100 : undefined);
  const wrapped = await wrappedHome(home, 2026, { catalog: false, price });
  assert.equal(wrapped.cost, 1);
  assert.equal(wrapped.unpricedRequests, 1);
  assert.deepEqual(wrapped.models.map((m) => [m.model, m.cost, m.unpricedRequests]), [["anthropic/claude-fixture-1", 1, 0], ["anthropic/claude-unlisted", 0, 1]], "each model says its own unpriced requests");
  const unpriced = await wrappedHome(home, 2026, nothing);
  assert.equal(unpriced.unpricedRequests, 2);
  assert.deepEqual(unpriced.models.map((m) => m.unpricedRequests), [1, 1]);
});

test("a price that rejects rejects wrappedHome, and the process lives on", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: WORDS, i: 0 }), answer(1, 10), answer(2, 20)]);
  const lost = [];
  const watch = (reason) => lost.push(reason);
  process.on("unhandledRejection", watch);
  t.after(() => process.off("unhandledRejection", watch));
  await assert.rejects(wrappedHome(home, 2026, { catalog: false, price: async () => { throw new Error("no price today"); } }), /no price today/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(lost, [], "no rejection left without a handler");
});

test("many requests of a fraction of a millionth each still add up: one rounding per model, not one per request", async (t) => {
  const home = await tempHome(t);
  const tiny = anthropicUsage(10, 0, 0, 0);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: WORDS, i: 0 }), ...Array.from({ length: 20 }, (_, n) => answer(n + 1, 10 + n, tiny))]);
  // $0.01 per million input tokens: 1e-7 a request, 2e-6 for the twenty.
  const catalog = catalogOf([{ id: "claude-fixture-1", provider: "anthropic", cost: { input: 0.01 } }]);
  const wrapped = await wrappedHome(home, 2026, { catalog });
  assert.equal(wrapped.unpricedRequests, 0);
  assert.equal(wrapped.cost, 0.000002);
  assert.equal(wrapped.models[0].cost, 0.000002);
});

test("a request with no usage (pi leaves it off an aborted one) is unpriced, and one of known zero usage is free", async (t) => {
  const home = await tempHome(t);
  const aborted = { type: "message", timestamp: at(40), message: { role: "assistant", provider: "fx", model: "fx-model", content: [], stopReason: "aborted", timestamp: Date.parse(at(40)) } };
  const free = piAnswer(50);
  free.message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  await writeJsonl(piFile(home), [piMeta(), piUser(WORDS, 1), piAnswer(30), aborted, free]);
  const catalog = catalogOf([{ id: "fx-model", provider: "fx", cost: { input: 1, output: 1 } }]);
  const wrapped = await wrappedHome(home, 2026, { catalog });
  assert.equal(wrapped.requests, 3);
  assert.equal(wrapped.unpricedRequests, 1, "the aborted one: its cost is unknown, the total says so");
  assert.equal(wrapped.models[0].unpricedRequests, 1, "and its model's row says so too");
  assert.ok(wrapped.cost > 0);
});

test("a request whose session records no tokens (Cursor keeps none) is counted as tokens unknown, by harness and model too, never as zero tokens known", async (t) => {
  const tz = process.env.TZ;
  process.env.TZ = "UTC";
  t.after(() => (tz === undefined ? delete process.env.TZ : (process.env.TZ = tz)));
  const home = await tempHome(t);
  await buildChat(join(home, ".cursor"));
  const cursorOnly = await wrappedHome(home, 2026, { catalog: false });
  assert.ok(cursorOnly.requests > 0, "the chat's answers are requests");
  assert.equal(cursorOnly.tokensUnknownRequests, cursorOnly.requests, "a Cursor-only year: every request's tokens are unknown");
  assert.deepEqual(cursorOnly.harnesses.map((h) => [h.harness, h.requests, h.tokensUnknownRequests]), [["cursor", cursorOnly.requests, cursorOnly.requests]]);
  assert.deepEqual(cursorOnly.models.map((m) => [m.requests, m.tokensUnknownRequests]), [[cursorOnly.requests, cursorOnly.requests]]);
  // A pi session beside it: its requests carry usage, so they are not counted; an aborted one with none is.
  const aborted = { type: "message", timestamp: at(40), message: { role: "assistant", provider: "fx", model: "fx-model", content: [], stopReason: "aborted", timestamp: Date.parse(at(40)) } };
  await writeJsonl(piFile(home), [piMeta(), piUser(WORDS, 1), piAnswer(30), aborted]);
  const both = await wrappedHome(home, 2026, { catalog: false });
  assert.equal(both.tokensUnknownRequests, cursorOnly.requests + 1);
  assert.deepEqual(both.harnesses.find((h) => h.harness === "pi")?.tokensUnknownRequests, 1);
  assert.deepEqual(both.models.find((m) => m.model === "fx/fx-model")?.tokensUnknownRequests, 1);
});

test("a model the catalog does not list leaves its requests with tokens unpriced, and its zero-token requests are not counted as unpriced", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: WORDS, i: 0 }), answer(1, 10, anthropicUsage(0, 0, 0, 0), "claude-unlisted"), answer(2, 20, anthropicUsage(5, 5, 0, 0), "claude-unlisted")]);
  const catalog = catalogOf([{ id: "something-else", provider: "anthropic", cost: { input: 1 } }]);
  const wrapped = await wrappedHome(home, 2026, { catalog });
  assert.equal(wrapped.requests, 2);
  assert.equal(wrapped.unpricedRequests, 1);
});

test("harnesses are the ones of the readers it is given, not only the built-in ones", async (t) => {
  const home = await tempHome(t);
  await mkdir(join(home, ".own"), { recursive: true });
  const store = join(home, ".own", "store.json");
  await writeFile(store, "[]");
  const own = {
    source: "own",
    name: "Own",
    harness: "own-harness",
    discover: async () => [{ file: store }],
    read: async (locator) => ({
      sessions: [{ locator, session: { source: "own", id: "s1", file: store, state: "completed", child: false, turns: [], users: 1, activeMs: 0, copies: 0 }, requests: [{ role: "assistant", text: "", calls: [], at: Date.parse(at(10)), usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }] }],
      cursor: 0,
      read: 0,
      resumed: false,
    }),
  };
  const wrapped = await wrappedHome(home, 2026, { sources: ["own"], readers: { own }, catalog: false });
  assert.deepEqual(wrapped.harnesses, [{ harness: "own-harness", sessions: 1, requests: 1, tokens: 10, tokensUnknownRequests: 0 }]);
});

test("the report holds no prompt, path or project, only numbers and names", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: WORDS, i: 0 }), answer(1, 10)]);
  const text = JSON.stringify(await wrappedHome(home, 2026, nothing));
  for (const leak of [WORDS, "/work/fixture", "-work-fixture", home, "00000000-0000-4000"]) assert.equal(text.includes(leak), false, leak);
});
