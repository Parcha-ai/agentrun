// A worker of the read pool whose heap runs out (pool.ts: OLD_MB, parseHome's workerOldMb) ends alone: its file goes back
// to parseHome, which reads it on its own thread, and another worker takes its place; past LOSSES_PER_THREAD losses a
// thread, the pool stops and parseHome reads the rest. The totals are those of one thread whatever happens.
//
// The heap is run out for real: a line of empty objects (`[{},{},...]`) parses to some 13 times its size on Node 24's V8,
// so a line under the worker's line limit (an eighth of its heap) still outgrows the heap inside JSON.parse. The first two
// tests lean on that growth; the line-limit test does not (the line is handed back before it is parsed).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { parseHome } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, tempHome, writeJsonl } from "./fixtures.mjs";

// A pool that loses a read waits forever: a test that hangs fails.
const TIMEOUT = 120_000;
const id = (group, k) => `00000000-0000-4000-8000-${group}${String(k).padStart(10, "0")}`;

/** A session whose first line carries `mb` MB of empty objects, then one request of its own. */
async function bomb(home, session, mb, time) {
  const user = JSON.stringify(claudeUser({ uuid: `${session}-u`, text: "Fixture question.", i: 0, session }));
  const pad = `[${"{},".repeat(Math.floor((mb * 2 ** 20) / 3) - 1)}{}]`;
  const answer = JSON.stringify(claudeAnswer({ uuid: `${session}-a`, msg: `${session}-m`, req: `${session}-r`, usage: anthropicUsage(3, 5, 7, 11), i: 1, session }));
  const file = claudeFile(home, session);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${user.slice(0, -1)},"pad":${pad}}\n${answer}\n`);
  await utimes(file, time, time);
}

/** A small session; every other one repeats the first small session's request (a copy, counted once). */
async function small(home, session, k, time) {
  const shared = k % 2 === 1;
  const file = await writeJsonl(claudeFile(home, session), [
    claudeUser({ uuid: `${session}-u`, text: "Small.", i: 0, session }),
    claudeAnswer({ uuid: `${session}-a`, msg: shared ? "msg-shared" : `${session}-m`, req: shared ? "req-shared" : `${session}-r`, usage: anthropicUsage(1, 2), i: 1, session }),
  ]);
  await utimes(file, time, time);
}

/** Workers made, and the reads each sent back (ok or not), while `run` runs. A pool that loses a read hangs here. */
async function watch(run) {
  const workers = [];
  const made = (worker) => {
    const seen = { ok: 0, back: 0 };
    workers.push(seen);
    worker.on("message", (read) => (read.ok ? (seen.ok += 1) : (seen.back += 1)));
  };
  process.on("worker", made);
  try {
    return { result: await run(), workers };
  } finally {
    process.off("worker", made);
  }
}

test("a worker out of memory gives its file back, and the worker that takes its place reads on: the totals of one thread", { timeout: TIMEOUT }, async (t) => {
  const home = await tempHome(t);
  // Two bombs, the largest files: one to each of the two workers first, so both run out; the replacements read the rest.
  for (let k = 0; k < 2; k += 1) await bomb(home, id("b", k), 0.9, 1_000 + k);
  for (let k = 0; k < 12; k += 1) await small(home, id("s", k), k, 2_000 + k);
  const one = await parseHome(home, { catalog: false, threads: 1 });
  const { result, workers } = await watch(() => parseHome(home, { catalog: false, threads: 2, workerOldMb: 8 }));
  assert.deepEqual(result, one);
  assert.equal(workers.length, 4, "two workers lost, two made in their place");
  assert.ok(workers.slice(2).some((w) => w.ok > 0), "a worker made in a lost one's place reads files");
});

test("every worker out of memory: the import settles, the pool stops after its losses, and parseHome reads the rest", { timeout: TIMEOUT }, async (t) => {
  const home = await tempHome(t);
  // Six files that each run out an 8 MB heap. A worker waited on while it runs out must keep the process alive: the
  // import settles (an unref'd one let it exit 13, unsettled).
  for (let k = 0; k < 6; k += 1) await bomb(home, id("b", k), 0.9, 1_000 + k);
  const one = await parseHome(home, { catalog: false, threads: 1 });
  const { result, workers } = await watch(() => parseHome(home, { catalog: false, threads: 2, workerOldMb: 8 }));
  assert.deepEqual(result, one);
  // Two threads, two losses a thread: the fifth loss stops the pool, so threads x 3 workers made.
  assert.equal(workers.length, 2 * 3, "the pool stops at its fifth loss");
});

test("a line of empty objects over the line limit at the default heap is handed back before it is parsed: the totals of one thread", { timeout: TIMEOUT }, async (t) => {
  // OLD_MB 64: the line limit is 8 MB. A 9 MB line of empty objects parses to about 120 MB, past the heap inside one
  // parse, which V8 answers by ending the whole process: it must stop at the limit and go back to parseHome unparsed.
  // In a process of its own, so that such an end fails here in words and spares the rest of this file's tests.
  const home = await tempHome(t);
  await bomb(home, id("b", 0), 9, 1_000);
  for (let k = 0; k < 4; k += 1) await small(home, id("s", k), k, 2_000 + k);
  const child = [
    `import { isDeepStrictEqual } from "node:util";`,
    `import { parseHome } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};`,
    `const home = process.argv[1];`,
    `let made = 0, back = 0;`,
    `process.on("worker", (w) => { made += 1; w.on("message", (r) => { if (!r.ok) back += 1; }); });`,
    `const pooled = await parseHome(home, { catalog: false, threads: 2 });`,
    `const one = await parseHome(home, { catalog: false, threads: 1 });`,
    `process.stdout.write(JSON.stringify({ identical: isDeepStrictEqual(pooled, one), made, back }));`,
  ].join("\n");
  const { code, stdout, stderr } = await new Promise((done) => {
    execFile(process.execPath, ["--input-type=module", "-e", child, home], (error, stdout, stderr) => done({ code: error ? (error.code ?? error.signal) : 0, stdout, stderr }));
  });
  assert.equal(code, 0, `child exit ${code}: a 9 MB line at the default heap must stop at the line limit, not end the process; stderr: ${stderr.slice(-200)}`);
  assert.deepEqual(JSON.parse(stdout), { identical: true, made: 2, back: 1 }, "the line's file handed back once, no worker lost, the totals of one thread");
});
