// parseHome's totals are the same whatever number of threads read the files ahead (pool.ts): a read made on a worker is
// kept only when no record it asked about and did not hold is one an earlier file holds; any other is made again in
// order, so a copy counts once, in the file the import's order first read it.
import assert from "node:assert/strict";
import { appendFile, utimes } from "node:fs/promises";
import { test } from "node:test";
import { parseHome } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, subagentFile, tempHome, writeJsonl } from "./fixtures.mjs";

const THREADS = [2, 3, 4];
// Read-ahead budgets: none (every read in the import's order but the one waited for), one small read, the default.
const AHEAD = [0, 1 << 10, undefined];
const each = (threads) => AHEAD.map((readAhead) => ({ threads, ...(readAhead === undefined ? {} : { readAhead }) }));
const OLD = "00000000-0000-4000-8000-0000000000a1";
const NEW = "00000000-0000-4000-8000-0000000000a2";

async function copiedHome(t) {
  const home = await tempHome(t);
  const question = claudeUser({ uuid: "u1", text: "Fixture question.", i: 0, session: OLD });
  const answer = claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 20, 30, 40), i: 1, session: OLD });
  const old = await writeJsonl(claudeFile(home, OLD), [question, answer]);
  // The resumed session's file opens with the old one's records, then goes on.
  const resumed = await writeJsonl(claudeFile(home, NEW), [question, answer, claudeUser({ uuid: "u2", text: "Again.", i: 5, session: NEW }), claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(1, 2, 3, 4), i: 6, session: NEW })]);
  // A request copied under another uuid is still the same request (its m: key).
  await writeJsonl(subagentFile(home, NEW, "agent-a1"), [claudeAnswer({ uuid: "a1-again", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 20, 30, 40), i: 7, session: NEW, sidechain: true }), claudeAnswer({ uuid: "s1", msg: "msg_s", req: "req_s", usage: anthropicUsage(100, 200, 0, 0), i: 8, session: NEW, sidechain: true })]);
  await utimes(old, 1_000, 1_000);
  await utimes(resumed, 2_000, 2_000);
  await writeJsonl(codexFile(home), [codexMeta("thread-1"), codexContext(1), codexUser("Fixture question.", 2), codexAnswer("Fixture answer.", 3), codexTokens(openaiUsage(100, 60, 7, 3), openaiUsage(100, 60, 7, 3), 4)]);
  return home;
}

test("a copy read on a worker counts once, where the import's order first read it: threads or none, the same totals", async (t) => {
  const home = await copiedHome(t);
  const one = await parseHome(home, { catalog: false, threads: 1 });
  const byId = Object.fromEntries(one.map((row) => [row.id, row]));
  assert.deepEqual([byId[OLD].calls, byId[OLD].tokens.output], [1, 20], "the old file holds msg_1");
  assert.deepEqual([byId[NEW].calls, byId[NEW].tokens.output, byId[NEW].subagents], [3 - 1, 2 + 200, 1], "the resumed file and its subagent count msg_1 no second time");
  for (const opts of THREADS.flatMap(each)) assert.deepEqual(await parseHome(home, { catalog: false, ...opts }), one, JSON.stringify(opts));
});

test("a state kept across passes comes out the same with threads as without", async (t) => {
  const home = await copiedHome(t);
  const plain = {};
  const threaded = {};
  assert.deepEqual(await parseHome(home, { catalog: false, threads: 2, state: threaded }), await parseHome(home, { catalog: false, threads: 1, state: plain }));
  assert.equal(threaded.read, plain.read);
  assert.deepEqual(await parseHome(home, { catalog: false, threads: 2, state: threaded }), await parseHome(home, { catalog: false, threads: 1, state: plain }));
  assert.equal(threaded.read, 0);
});

// The records a read asks about but never adds count too: a copy in a file's last line, still being written (asked
// about, added only once a later read takes it whole), and a request's bare message id ("l:", which no reader adds).
const FIRST = "00000000-0000-4000-8000-0000000000c1";
const OPEN = "00000000-0000-4000-8000-0000000000c2";
const BARE = "00000000-0000-4000-8000-0000000000c3";
const AFTER = "00000000-0000-4000-8000-0000000000c4";

test("a record a worker asked about but never added: a copy when an earlier file read it, and no one's when none did", async (t) => {
  const home = await tempHome(t);
  const answer = claudeAnswer({ uuid: "c1-a", msg: "msg_c1", req: "req_c1", usage: anthropicUsage(1, 2, 3, 4), i: 1, session: FIRST });
  const first = await writeJsonl(claudeFile(home, FIRST), [claudeUser({ uuid: "c1-u", text: "First.", i: 0, session: FIRST }), answer]);
  // Its last line, with no newline yet, a copy of the first file's request: the first file's, not this one's.
  const open = claudeFile(home, OPEN);
  await writeJsonl(open, [claudeUser({ uuid: "c2-u", text: "Open.", i: 0, session: OPEN })]);
  await appendFile(open, JSON.stringify(answer));
  // A request, then another file's request with the same message id under another request id: the bare id is asked
  // about by both and added by neither, so the second is no copy.
  const bare = await writeJsonl(claudeFile(home, BARE), [claudeUser({ uuid: "c3-u", text: "Bare.", i: 0, session: BARE }), claudeAnswer({ uuid: "c3-a", msg: "msg_c3", req: "req_c3", usage: anthropicUsage(10, 20), i: 1, session: BARE })]);
  const after = await writeJsonl(claudeFile(home, AFTER), [claudeUser({ uuid: "c4-u", text: "After.", i: 0, session: AFTER }), claudeAnswer({ uuid: "c4-a", msg: "msg_c3", req: "req_c4", usage: anthropicUsage(7, 8), i: 1, session: AFTER })]);
  for (const [file, time] of [[first, 1_000], [open, 2_000], [bare, 3_000], [after, 4_000]]) await utimes(file, time, time);
  const one = await parseHome(home, { catalog: false, threads: 1 });
  const byId = Object.fromEntries(one.map((row) => [row.id, row]));
  assert.deepEqual([FIRST, OPEN, BARE, AFTER].map((id) => byId[id].calls), [1, 0, 1, 1]);
  for (const opts of THREADS.flatMap(each)) assert.deepEqual(await parseHome(home, { catalog: false, ...opts }), one, JSON.stringify(opts));
});
