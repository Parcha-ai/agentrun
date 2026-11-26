// Requests are priced as they are read once the prices are in hand, and held as one cost each: the totals come out as
// they did when every request was priced at the end, and the prices load only when a session the totals price is read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { builtinCatalog, priceRequests } from "../dist/index.js";
import { priceRequest, roundUsd } from "../dist/price.js";
import { anthropicUsage, at, claudeAnswer, claudeFile, claudeUser, codexContext, codexFile, codexMeta, codexTokens, openaiUsage, parseHome, SESSION, subagentFile, tempHome, writeJsonl } from "./fixtures.mjs";

const INDEX = new URL("../dist/index.js", import.meta.url).href;
const costState = (usd, i) => ({ type: "cost-state", timestamp: at(i), totalCostUSD: usd });
const MODEL = "claude-sonnet-4-5";

/** parseHome(home) in a node of its own, with the pi-ai modules it resolved and the costs it found. */
function run(home) {
  const script = `
import { registerHooks } from "node:module";
const loaded = [];
registerHooks({ resolve(specifier, context, next) { if (specifier.startsWith("@earendil-works/pi-ai")) loaded.push(specifier); return next(specifier, context); } });
const { parseHome } = await import(${JSON.stringify(INDEX)});
const sessions = await parseHome(${JSON.stringify(home)}, { threads: 1 });
process.stdout.write(JSON.stringify({ loaded, costs: sessions.map(({ cost }) => cost).sort() }));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
}

test("priceRequest prices one request as priceRequests does, and roundUsd rounds as it does", async () => {
  const catalog = new Map([["m", [{ provider: "p", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }]]]);
  const calculate = (_model, usage) => ({ total: usage.input * 0.1 + usage.output * 0.7 + (usage.cacheWrite1h ?? 0) });
  const requests = [
    { model: "p/m", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 } },
    { model: "p/m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { model: "p/m", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 4, cacheWrite1h: 4 } },
  ];
  assert.deepEqual(requests.map((r) => priceRequest(r, catalog, calculate)), [3 * 0.1 + 0.7, 0, 0.1 + 1.4 + 4]);
  assert.equal(await priceRequests(requests, catalog, calculate), roundUsd(3 * 0.1 + 0.7 + 0 + (0.1 + 1.4 + 4)));
  assert.equal(priceRequest({ model: "p/other", usage: requests[0].usage }, catalog, calculate), undefined);
  assert.equal(priceRequest({ model: "p/m" }, catalog, calculate), undefined);
});

test("a home whose every session wrote its cost loads no prices: its subagents' files and its files of copies alone neither", async (t) => {
  const home = await tempHome(t);
  const records = [claudeUser({ uuid: "u1", text: "Fixture question.", i: 0 }), claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 20), model: MODEL, i: 1 })];
  await writeJsonl(claudeFile(home), [...records, costState(1.25, 2)]);
  // A subagent writes no cost of its own: its session's is the one written.
  await writeJsonl(subagentFile(home), [claudeAnswer({ uuid: "s1", msg: "msg_s", req: "req_s", usage: anthropicUsage(1, 2), model: MODEL, i: 3, sidechain: true })]);
  // A file of copies alone, no cost written: no session.
  await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-0000000000cc"), records);
  assert.deepEqual(run(home), { loaded: [], costs: [1.25] });
});

test("a session that wrote no cost loads the prices, and is priced as at the end", async (t) => {
  const home = await tempHome(t);
  const usage = anthropicUsage(1000, 2000, 300, 40);
  await writeJsonl(claudeFile(home), [claudeUser({ uuid: "u1", text: "Fixture question.", i: 0 }), claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage, model: MODEL, i: 1 })]);
  const { loaded, costs } = run(home);
  assert.ok(loaded.length > 0);
  const expected = await priceRequests([{ model: `anthropic/${MODEL}`, usage: { input: 1000, output: 2000, cacheRead: 300, cacheWrite: 40 } }], await builtinCatalog());
  assert.equal(typeof expected, "number");
  assert.deepEqual(costs, [expected]);
  const codex = await tempHome(t);
  await writeJsonl(codexFile(codex), [codexMeta("thread-1"), codexContext(1), codexTokens(openaiUsage(100, 0, 10), openaiUsage(100, 0, 10), 2)]);
  assert.ok(run(codex).loaded.length > 0);
});

// Costs that sum to another value in any other order of the three blocks (see compact-parts.test.mjs).
const BIG = 2 ** 56;
const BLOCKS = [[5, 5], [BIG], [3, 9]];
const EXPECTED = roundUsd(BLOCKS.flat().reduce((n, usd) => n + usd, 0));
const calculateCost = (_model, usage) => ({ total: usage.input === 1 ? BIG : usage.input });
const inputOf = (usd) => (usd === BIG ? 1 : usd);

test("prices loaded partway through a source price the parts read before them, in the totals' order", async (t) => {
  const home = await tempHome(t);
  const answers = (usd, n, prefix, sidechain = false) => usd.map((c, i) => claudeAnswer({ uuid: `${prefix}-u${i}`, msg: `msg_${prefix}_${i}`, req: `req_${prefix}_${i}`, usage: anthropicUsage(inputOf(c), 1), model: MODEL, i: n + i, sidechain }));
  // One session in two project folders (moved): the first file wrote a cost, the second none, so the session is priced,
  // and the prices load when the second is read. Its subagent comes after both.
  await writeJsonl(claudeFile(home, SESSION, "-a-first"), [...answers(BLOCKS[0], 0, "first"), costState(0.5, 9)]);
  await writeJsonl(claudeFile(home, SESSION, "-b-second"), answers(BLOCKS[1], 10, "second"));
  await writeJsonl(subagentFile(home, SESSION, "agent-a", "-b-second"), answers(BLOCKS[2], 20, "sub", true));
  // No catalog handed in: pi-ai's, loaded when needed; calculateCost handed in.
  const sessions = await parseHome(home, { sources: ["claude-code"], calculateCost });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].calls, 5);
  assert.equal(sessions[0].cost, EXPECTED);
  // As when the prices are in hand from the start.
  const catalog = await builtinCatalog();
  assert.deepEqual(await parseHome(home, { sources: ["claude-code"], calculateCost, catalog }), sessions);
});

test("tokens that would round summed as read are summed request by request, as before", async (t) => {
  const home = await tempHome(t);
  const files = ["a", "b"].map((name) => join(home, `${name}.jsonl`));
  for (const file of files) await writeFile(file, "");
  const answer = (input) => ({ role: "assistant", text: "", calls: [], at: 0, usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const reader = {
    source: "fixture",
    name: "Fixture",
    harness: "fixture",
    discover: async () => files.map((file) => ({ file })),
    async read(locator) {
      const a = locator.file === files[0];
      // One session in two files: 2^53 - 1, then 1, 1, 1. Added one by one from 2^53 - 1 each 1 is lost at 2^53;
      // the second file's sum (3) added at once is not.
      const requests = a ? [answer(2 ** 53 - 1)] : [answer(1), answer(1), answer(1)];
      return { sessions: [{ locator, session: { source: "fixture", id: "one", file: locator.file, state: "completed", child: false, turns: [], users: 1, activeMs: 0, copies: 0 }, requests }], cursor: undefined, read: 0, resumed: false };
    },
  };
  const [session] = await parseHome(home, { sources: ["fixture"], readers: { fixture: reader }, catalog: false });
  let expected = 0;
  for (const input of [2 ** 53 - 1, 1, 1, 1]) expected += input;
  assert.equal(expected, 2 ** 53);
  assert.equal(session.tokens.input, expected);
  assert.equal(session.calls, 4);
});
