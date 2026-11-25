// A source's sessions are held, until their totals are taken, as only what the totals need: a request read is not kept
// as the reader's object once its locator is read. The totals come out as before, to the last bit of a float cost.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { parseHome } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, codexContext, codexFile, codexMeta, codexTokens, openaiUsage, SESSION, subagentFile, tempHome, writeJsonl } from "./fixtures.mjs";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

/** A reader of `files` (one session each, one request each), noting on each read after the first whether the first
 *  read's request and session are still alive. */
function trackingReader(files) {
  const alive = [];
  let first;
  return {
    alive,
    reader: {
      source: "fixture",
      name: "Fixture",
      harness: "fixture",
      discover: async () => files.map((file) => ({ file })),
      async read(locator) {
        if (first) {
          // Another macrotask, so no WeakRef is kept for the job, then a full collection.
          await new Promise((resolve) => setImmediate(resolve));
          gc();
          alive.push({ request: first.request.deref() !== undefined, session: first.session.deref() !== undefined });
        }
        const request = { role: "assistant", text: "", calls: [{ type: "toolCall", id: "call-1", name: "Bash", arguments: {} }], at: 0, key: `key-${locator.file}`, uuids: ["u-1"], usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
        const session = { source: "fixture", id: locator.file, file: locator.file, state: "completed", child: false, turns: [], users: 1, activeMs: 0, copies: 0, model: "fixture/model", firstPrompt: "x".repeat(1 << 16) };
        first ??= { request: new WeakRef(request), session: new WeakRef(session) };
        return { sessions: [{ locator, session, requests: [request] }], cursor: undefined, read: 0, resumed: false };
      },
    },
  };
}

test("a locator's requests and session are not held as read once later locators are read", async (t) => {
  const home = await tempHome(t);
  const files = ["a", "b", "c", "d"].map((name) => join(home, `${name}.jsonl`));
  for (const file of files) await writeFile(file, "");
  const { alive, reader } = trackingReader(files);
  const sessions = await parseHome(home, { sources: ["fixture"], readers: { fixture: reader }, catalog: false });
  assert.equal(sessions.length, 4);
  assert.deepEqual(sessions.map(({ tokens, calls }) => [tokens.input, calls]), [[1, 1], [1, 1], [1, 1], [1, 1]]);
  // While the next locator is read, the last one's read may still be on the stack; two locators on, it is gone.
  assert.deepEqual(alive.slice(1), [{ request: false, session: false }, { request: false, session: false }]);
});

// Per-request costs whose sum, rounded as priceRequests rounds it, is one value in the order [parts..., subagents...]
// and another in every other order of those three blocks: at 2^56 a float's step is 16, so small costs added one by one
// to it are lost or rounded up by turns.
const BIG = 2 ** 56;
const round = (usd) => Math.round(usd * 1e6) / 1e6;
const sum = (costs) => costs.reduce((n, usd) => n + usd, 0);
const BLOCKS = [[5, 5], [BIG], [3, 9]];
const EXPECTED = round(sum(BLOCKS.flat()));
/** input 1 costs BIG, any other input its own count in USD. */
const calculateCost = (_model, usage) => ({ total: usage.input === 1 ? BIG : usage.input });
const inputOf = (usd) => (usd === BIG ? 1 : usd);
const catalog = new Map([
  ["gpt-fixture", [{ provider: "openai", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }]],
  ["claude-fixture-1", [{ provider: "anthropic", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }]],
]);

test("Codex: a thread's cost sums its files' requests in order, then its named child thread's", async (t) => {
  const home = await tempHome(t);
  const tokens = (usd, i) => codexTokens(openaiUsage(inputOf(usd), 0, 1), openaiUsage(i * 1000, 0, i), i);
  // The parent thread in two files (resumed), then a thread naming it.
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-00-a.jsonl"), [codexMeta("thread-parent"), codexContext(1), ...BLOCKS[0].map((usd, i) => tokens(usd, 2 + i))]);
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-01-b.jsonl"), [codexMeta("thread-parent"), codexContext(1), ...BLOCKS[1].map((usd, i) => tokens(usd, 10 + i))]);
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-02-c.jsonl"), [codexMeta("thread-child", "thread-parent"), codexContext(1), ...BLOCKS[2].map((usd, i) => tokens(usd, 20 + i))]);
  const sessions = await parseHome(home, { sources: ["codex"], catalog, calculateCost });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].calls, 5);
  assert.equal(sessions[0].subagents, 1);
  assert.equal(sessions[0].cost, EXPECTED);
});

test("Claude Code: a session's cost sums its own requests, then its subagents' in their files' order", async (t) => {
  const home = await tempHome(t);
  const answers = (usd, n, prefix, sidechain) => usd.map((c, i) => claudeAnswer({ uuid: `${prefix}-u${i}`, msg: `msg_${prefix}_${i}`, req: `req_${prefix}_${i}`, usage: anthropicUsage(inputOf(c), 1), i: n + i, sidechain }));
  await writeJsonl(claudeFile(home), answers(BLOCKS[0], 0, "top", false));
  await writeJsonl(subagentFile(home, SESSION, "agent-a"), answers(BLOCKS[1], 10, "a", true));
  await writeJsonl(subagentFile(home, SESSION, "agent-b"), answers(BLOCKS[2], 20, "b", true));
  const sessions = await parseHome(home, { sources: ["claude-code"], catalog, calculateCost });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].calls, 5);
  assert.equal(sessions[0].subagents, 2);
  assert.equal(sessions[0].cost, EXPECTED);
});

test("each request is priced as read: its own model or else the session's, its 1h cache write only where it has one, none without usage; reasoning counted in the totals", async (t) => {
  const home = await tempHome(t);
  const files = ["a.jsonl", "b.jsonl"].map((name) => join(home, name));
  for (const file of files) await writeFile(file, "");
  const asked = [];
  const reader = {
    source: "fixture",
    name: "Fixture",
    harness: "fixture",
    discover: async () => files.map((file) => ({ file })),
    async read(locator) {
      const a = locator.file === files[0];
      const requests = a
        ? [
            { role: "assistant", text: "", calls: [], at: 0, model: "p/own", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 4 } },
            { role: "assistant", text: "", calls: [], at: 0, usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 6 } },
            { role: "assistant", text: "", calls: [], at: 0, usage: { input: 0.5, output: -0, cacheRead: 0, cacheWrite: 0 } },
          ]
        : [{ role: "assistant", text: "", calls: [], at: 0, model: "p/own", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }, { role: "assistant", text: "", calls: [], at: 0 }];
      const session = { source: "fixture", id: a ? "a" : "b", file: locator.file, state: "completed", child: false, turns: [], users: 1, activeMs: 0, copies: 0, ...(a ? { model: "p/session" } : {}) };
      return { sessions: [{ locator, session, requests }], cursor: undefined, read: 0, resumed: false };
    },
  };
  const listed = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
  const prices = new Map([
    ["own", [{ provider: "p", cost: { ...listed, input: 10 } }]],
    ["session", [{ provider: "p", cost: { ...listed, input: 20 } }]],
  ]);
  const cost = ({ cost }, usage) => {
    asked.push({ price: cost.input, keys: Object.keys(usage).filter((k) => k === "cacheWrite1h"), input: usage.input, output: usage.output });
    return { total: cost.input * usage.input + 0.1 };
  };
  const [a, b] = await parseHome(home, { sources: ["fixture"], readers: { fixture: reader }, catalog: prices, calculateCost: cost }).then((out) => out.sort((x, y) => (x.file < y.file ? -1 : 1)));
  // Each request priced at its own price, with what it has (a request may be priced more than once: when it is read,
  // and again at the totals when its source is read again).
  const distinct = [...new Map(asked.map((call) => [JSON.stringify(call, (_k, v) => (Object.is(v, -0) ? "-0" : v)), call])).values()];
  assert.deepEqual(distinct, [
    { price: 10, keys: ["cacheWrite1h"], input: 1, output: 2 },
    { price: 20, keys: [], input: 5, output: 6 },
    { price: 20, keys: [], input: 0.5, output: -0 },
    { price: 10, keys: [], input: 1, output: 1 },
  ]);
  assert.equal(a.cost, round(10 * 1 + 0.1 + (20 * 5 + 0.1) + (20 * 0.5 + 0.1)));
  assert.deepEqual(a.tokens, { input: 6.5, output: 8, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 4 });
  assert.equal(a.reasoning, 6);
  assert.equal(a.calls, 3);
  assert.equal(b.cost, null, "a request of unknown tokens leaves the cost unknown");
  assert.equal(b.calls, 2);
});
