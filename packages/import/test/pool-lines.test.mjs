// A worker of the read pool stops at a line longer than its line limit (an eighth of its heap: pool.ts) and hands the
// file back; parseHome reads it on its own thread. A worker that had to hold such a line could end the whole process:
// V8 does not contain a heap limit reached inside one native call (a 90 MB line at a 64 MB heap). Its own file, so that
// a mutant that removes the limit ends this file's process alone.
import assert from "node:assert/strict";
import { utimes } from "node:fs/promises";
import { test } from "node:test";
import { parseHome } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, tempHome, writeJsonl } from "./fixtures.mjs";

// A pool that loses a read waits forever: a test that hangs fails.
const TIMEOUT = 120_000;
const id = (group, k) => `00000000-0000-4000-8000-${group}${String(k).padStart(10, "0")}`;

test("a line over the worker's line limit: the file is handed back and read by parseHome, the totals of one thread", { timeout: TIMEOUT }, async (t) => {
  const home = await tempHome(t);
  // The default 64 MB heap: an 8 MB line limit, so a 24 MB line is three limits. A smaller heap leaves too little room
  // for the worker's ordinary reads on a loaded machine: it ran out of memory and was replaced, a lost worker.
  const long = "x".repeat(24 * 2 ** 20);
  for (let k = 0; k < 2; k += 1) {
    const session = id("l", k);
    const file = await writeJsonl(claudeFile(home, session), [
      claudeUser({ uuid: `${session}-u`, text: long, i: 0, session }),
      claudeAnswer({ uuid: `${session}-a`, msg: `${session}-m`, req: `${session}-r`, usage: anthropicUsage(3, 5, 7, 11), i: 1, session }),
    ]);
    await utimes(file, 1_000 + k, 1_000 + k);
  }
  for (let k = 0; k < 4; k += 1) {
    const session = id("s", k);
    const file = await writeJsonl(claudeFile(home, session), [claudeUser({ uuid: `${session}-u`, text: "Small.", i: 0, session }), claudeAnswer({ uuid: `${session}-a`, msg: "msg-shared", req: "req-shared", usage: anthropicUsage(1, 2), i: 1, session })]);
    await utimes(file, 2_000 + k, 2_000 + k);
  }
  const one = await parseHome(home, { catalog: false, threads: 1 });
  let back = 0;
  let made = 0;
  const watch = (worker) => {
    made += 1;
    worker.on("message", (read) => (back += read.ok ? 0 : 1));
  };
  process.on("worker", watch);
  t.after(() => process.off("worker", watch));
  assert.deepEqual(await parseHome(home, { catalog: false, threads: 2 }), one);
  assert.equal(back, 2, "both long-line files handed back");
  assert.equal(made, 2, "no worker lost");
});
