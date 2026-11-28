// A requests sink (wrappedHome's) takes each request with its time, so with one parseHome keeps every request to the
// totals and prices it there; without one, each request is priced as its file is read and a part keeps one cost a
// request. Either way the totals are the same. Imports parseHome alone, so it runs against a build without read pricing.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { anthropicUsage, at, claudeAnswer, claudeFile, claudeUser, codexContext, codexFile, codexMeta, codexTokens, openaiUsage, parseHome, subagentFile, tempHome, writeJsonl } from "./fixtures.mjs";

const costState = (usd, i) => ({ type: "cost-state", timestamp: at(i), totalCostUSD: usd });
const MODEL = "claude-sonnet-4-5";

/** A reader of two files, one session each, that notes each read in `events`. */
function noting(home, events, files) {
  const request = (at, input) => ({ role: "assistant", text: "", calls: [], at, model: "p/m", usage: { input, output: 2, cacheRead: 0, cacheWrite: 0 } });
  return {
    source: "fixture",
    name: "Fixture",
    harness: "fixture",
    discover: async () => files.map((file) => ({ file })),
    async read(locator) {
      const a = locator.file === files[0];
      events.push(`read ${a ? "a" : "b"}`);
      const requests = a ? [request(1000, 1), request(3000, 3)] : [request(2000, 5)];
      return { sessions: [{ locator, session: { source: "fixture", id: a ? "a" : "b", file: locator.file, state: "completed", child: false, turns: [], users: 1, activeMs: 0, copies: 0 }, requests }], cursor: undefined, read: 0, resumed: false };
    },
  };
}

test("without a requests sink each request is priced as its file is read; with one, every request is kept to the totals and priced there", async (t) => {
  const home = await tempHome(t);
  const files = ["a", "b"].map((name) => join(home, `${name}.jsonl`));
  for (const file of files) await writeFile(file, "");
  const catalog = new Map([["m", [{ provider: "p", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }]]]);
  const pass = async (sink) => {
    const events = [];
    const calculateCost = (_model, usage) => (events.push(`price ${usage.input}`), { total: usage.input });
    const sessions = await parseHome(home, { sources: ["fixture"], readers: { fixture: noting(home, events, files) }, catalog, calculateCost, ...(sink ? { requests: sink } : {}) });
    return { events, sessions };
  };
  const bare = await pass();
  assert.deepEqual(bare.events, ["read a", "price 1", "price 3", "read b", "price 5"], "without a sink each request is priced as its file is read (a part keeps one cost a request), not at the totals");
  const got = [];
  const sunk = await pass((totals, requests, started) => got.push({ id: totals.id, requests, started }));
  assert.deepEqual(sunk.events, ["read a", "read b", "price 1", "price 3", "price 5"], "with a sink every request is kept to the totals and priced there");
  assert.deepEqual(sunk.sessions, bare.sessions, "the totals are the same with a sink and without");
  assert.deepEqual(bare.sessions.map(({ id, cost, calls }) => ({ id, cost, calls })).sort((x, y) => (x.id < y.id ? -1 : 1)), [{ id: "a", cost: 4, calls: 2 }, { id: "b", cost: 5, calls: 1 }]);
  const usage = (input) => ({ input, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(got.sort((x, y) => (x.id < y.id ? -1 : 1)), [
    { id: "a", requests: [{ at: 1000, model: "p/m", usage: usage(1) }, { at: 3000, model: "p/m", usage: usage(3) }], started: 1000 },
    { id: "b", requests: [{ at: 2000, model: "p/m", usage: usage(5) }], started: 2000 },
  ], "the sink takes each request whole, with its time and model");
});

test("a home's totals are the same with a requests sink and without, on the pool and on one thread", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: "Fixture question.", i: 0 }), claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(1000, 2000, 300, 40), model: MODEL, i: 1 })]);
  await writeJsonl(subagentFile(home), [claudeAnswer({ uuid: "s1", msg: "msg_s", req: "req_s", usage: anthropicUsage(7, 9), model: MODEL, i: 3, sidechain: true })]);
  await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-0000000000dd"), [claudeUser({ uuid: "u2", text: "Fixture question.", i: 4 }), claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(5, 6), model: MODEL, i: 5 }), costState(0.75, 6)]);
  await writeJsonl(codexFile(home), [codexMeta("thread-1"), codexContext(1), codexTokens(openaiUsage(100, 0, 10), openaiUsage(100, 0, 10), 2)]);
  for (const threads of [1, 4]) {
    const bare = await parseHome(home, { threads });
    let sunk = 0;
    const withSink = await parseHome(home, { threads, requests: () => (sunk += 1) });
    assert.equal(sunk, bare.length, `threads ${threads}: the sink takes every session`);
    assert.deepEqual(withSink, bare, `threads ${threads}: the totals are the same with a sink and without`);
    assert.ok(bare.some(({ cost }) => typeof cost === "number" && cost !== 0.75), `threads ${threads}: a session priced from its requests`);
  }
});
