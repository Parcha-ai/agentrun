// Claude Code writes one JSONL line per content block of a response, each repeating the response's usage, and only the
// last one holds the final counts (ccusage#888 is the same bug in another reader). One request, counted once, at its
// last line's usage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHome, readSession } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, tempHome, writeJsonl } from "./fixtures.mjs";

const blocks = [
  { type: "thinking", thinking: "Fixture thought." },
  { type: "tool_use", id: "call-1", name: "read", input: { file: "fixture" } },
  { type: "text", text: "Fixture answer." },
];

/** A session whose one response is written as three lines of message msg_1, request req_1, with these output counts. */
async function threeLines(t, outputs) {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [
    claudeUser({ uuid: "u1", text: "Fixture question.", i: 0 }),
    ...outputs.map((output, k) => claudeAnswer({ uuid: `a${k + 1}`, msg: "msg_1", req: "req_1", usage: anthropicUsage(10, output, 100, 20, 5), i: k + 1, block: blocks[k] })),
  ]);
  return home;
}

test("three lines of one (message.id, requestId) with rising output_tokens: one request at the last line's count", async (t) => {
  const home = await threeLines(t, [5, 12, 30]);
  const session = await readSession(claudeFile(home), "claude-code");
  const answers = session.turns.filter((turn) => turn.role === "assistant");
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].usage, { input: 10, output: 30, cacheRead: 100, cacheWrite: 20, cacheWrite1h: 5 });
  assert.deepEqual(answers[0].calls.map((call) => call.id), ["call-1"]);
  const [totals] = await parseHome(home, { sources: ["claude-code"] });
  assert.deepEqual(totals.tokens, { input: 10, output: 30, cacheRead: 100, cacheWrite: 20, cacheWrite1h: 5 });
  assert.equal(totals.calls, 1);
});

test("the last line wins even when an earlier one counted more: it is the last, not the most", async (t) => {
  const home = await threeLines(t, [5, 40, 30]);
  const [totals] = await parseHome(home, { sources: ["claude-code"] });
  assert.equal(totals.tokens.output, 30);
  assert.equal(totals.calls, 1);
});

test("two requests that share a message id but not a request id are two requests", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [
    claudeUser({ uuid: "u1", text: "Fixture question.", i: 0 }),
    claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 7), i: 1 }),
    claudeAnswer({ uuid: "a2", msg: "msg_1", req: "req_2", usage: anthropicUsage(20, 9), i: 2 }),
  ]);
  const [totals] = await parseHome(home, { sources: ["claude-code"] });
  assert.deepEqual([totals.tokens.input, totals.tokens.output, totals.calls], [30, 16, 2]);
});
