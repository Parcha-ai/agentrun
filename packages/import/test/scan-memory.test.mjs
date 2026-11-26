// The scanner's memory (scan.ts) stays inside the import's stated bound: a thread's walker holds the longest line it
// scanned for as long as it lives, beside its own stack and tables, so it scans no line that would take its memory past
// 8 MiB (SCANNER_BYTES). A longer line is parsed whole, as before, and totals the same. Synthetic lines only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldsOf, scan, walkerMemory } from "../dist/scan.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, parseHome, tempHome, writeJsonl } from "./fixtures.mjs";

const MiB = 2 ** 20;

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

test("a 9 MiB line totals the same as a short one, and the walker's memory, its tables with it, stays within 8 MiB", async (t) => {
  const small = await parseHome(await home(t, 10));
  const before = walkerMemory();
  assert.ok(before, "the walker is built by a read on this thread (threads 1)");
  const big = await parseHome(await home(t, 9 * MiB));
  assert.deepEqual(totalsOf(big), totalsOf(small), "the same calls, turns and tokens");
  assert.equal(big[0].calls, 2);
  const after = walkerMemory();
  assert.ok(after.bytes <= 8 * MiB, `the walker's memory ${after.bytes} B (its stack and tables ${after.base} B), over 8 MiB`);
});

test("scan leaves a line that would take its memory past 8 MiB to JSON.parse, and takes one that fits", () => {
  const fields = fieldsOf({ type: true });
  const empty = Buffer.from(JSON.stringify({ type: "user", body: "" }));
  assert.deepEqual(scan(empty, 0, empty.length, fields), { type: "user" }, "the walker built");
  const { base } = walkerMemory();
  // The line of `bytes` bytes in all.
  const line = (bytes) => Buffer.from(JSON.stringify({ type: "user", body: "y".repeat(bytes - empty.length) }));
  const fits = line(8 * MiB - base);
  assert.deepEqual(scan(fits, 0, fits.length, fields), { type: "user" }, "the stack, the tables and the line in 8 MiB: scanned");
  const over = line(8 * MiB - base + 1);
  assert.equal(scan(over, 0, over.length, fields), undefined, "a byte more: left to JSON.parse");
  const past = line(8 * MiB + 1);
  assert.equal(scan(past, 0, past.length, fields), undefined, "over 8 MiB: left to JSON.parse");
  assert.ok(walkerMemory().bytes <= 8 * MiB, `the walker's memory ${walkerMemory().bytes} B`);
});
