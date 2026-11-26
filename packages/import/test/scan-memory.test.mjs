// The scanner's memory (scan.ts) stays inside the import's stated bound: a thread's walker holds the longest line it
// scanned for as long as it lives, so it scans none past 8 MiB (LONGEST). A longer line is parsed whole, as before, and
// totals the same. Synthetic lines only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldsOf, scan, walkerMemory } from "../dist/scan.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, parseHome, tempHome, writeJsonl } from "./fixtures.mjs";

const MiB = 2 ** 20;
const PAGE = 65536;

test("scan.js exports walkerMemory", () => {
  assert.equal(typeof walkerMemory, "function");
});

/** A Claude Code tool result of `bytes` characters: a line no total reads past its type. */
const toolResult = (uuid, bytes, i) => ({ ...claudeUser({ uuid, text: "", i }), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(bytes) }] } });

/** A session with one tool result line of `bytes` characters between two paid requests. */
async function home(t, bytes) {
  const dir = await tempHome(t);
  await writeJsonl(claudeFile(dir), [
    claudeUser({ uuid: "u1", text: "Read the file.", i: 0 }),
    claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(100, 20, 5, 7), i: 1 }),
    toolResult("u2", bytes, 2),
    claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(300, 40, 9, 11), i: 3 }),
  ]);
  return dir;
}

const totalsOf = (sessions) => sessions.map(({ calls, turns, tokens }) => ({ calls, turns, tokens }));

test("a 9 MiB line totals the same as a short one, and the walker's memory stays within 8 MiB of its tables", async (t) => {
  const small = await parseHome(await home(t, 10));
  const before = walkerMemory();
  assert.ok(before, "the walker is built by a read on this thread (threads 1)");
  const big = await parseHome(await home(t, 9 * MiB));
  assert.deepEqual(totalsOf(big), totalsOf(small), "the same calls, turns and tokens");
  assert.equal(big[0].calls, 2);
  const after = walkerMemory();
  assert.ok(after.bytes - after.base <= 8 * MiB + PAGE, `the walker's line room ${after.bytes - after.base} B, over 8 MiB`);
});

test("scan leaves a line over 8 MiB to JSON.parse, and takes one under it", () => {
  const fields = fieldsOf({ type: true });
  const line = (bytes) => Buffer.from(JSON.stringify({ type: "user", body: "y".repeat(bytes) }));
  const under = line(8 * MiB - 64);
  assert.deepEqual(scan(under, 0, under.length, fields), { type: "user" }, "under 8 MiB: scanned");
  const over = line(8 * MiB + 1);
  assert.equal(scan(over, 0, over.length, fields), undefined, "over 8 MiB: left to JSON.parse");
  const { bytes, base } = walkerMemory();
  assert.ok(bytes - base <= 8 * MiB + PAGE, `line room ${bytes - base} B`);
});
