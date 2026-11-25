// A worker of the read pool whose heap runs out (pool.ts: OLD_MB, parseHome's workerOldMb) ends alone: its file goes back
// to parseHome, which reads it on its own thread, and another worker takes its place; past LOSSES_PER_THREAD losses a
// thread, the pool stops and parseHome reads the rest. The totals are those of one thread whatever happens.
//
// The heap is run out for real: a line of empty objects (`[{},{},...]`) parses to some 13 times its size, so a line
// under the worker's line limit (an eighth of its heap) still outgrows the heap as it is read. The objects are the user
// message's content, which a totals read builds block by block (a field it does not read it never builds: scan.ts).
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

/** A session whose first line's user message is `mb` MB of empty objects, then one request of its own. */
async function bomb(home, session, mb, time) {
  const user = JSON.stringify(claudeUser({ uuid: `${session}-u`, text: "\0", i: 0, session }));
  const pad = `[${"{},".repeat(Math.floor((mb * 2 ** 20) / 3) - 1)}{}]`;
  const answer = JSON.stringify(claudeAnswer({ uuid: `${session}-a`, msg: `${session}-m`, req: `${session}-r`, usage: anthropicUsage(3, 5, 7, 11), i: 1, session }));
  const file = claudeFile(home, session);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${user.replace('"content":"\\u0000"', `"content":${pad}`)}\n${answer}\n`);
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

/** The bound on one pooled import here (each settles in about a second). A pool that hangs fails on this bound, in words
 * that name what it was doing, not on the runner's timeout. */
const DEADLINE = 20_000;

/** The failure for a pool that did not settle within DEADLINE: the workers made after the first `threads` replace lost
 * ones; a replacement that never sent a read and never ended was never given a file. */
function stuck(workers, threads) {
  const made = workers.slice(threads);
  const bound = `a pool that lost workers settles within ${DEADLINE / 1000} s; this one did not (workers made ${workers.length})`;
  if (made.length > 0 && made.every((w) => w.ok + w.back === 0 && !w.ended)) return `${bound}: pending files never dispatched to a replacement`;
  return `${bound}: a lost worker's file never handed back to parseHome`;
}

/** Workers made, and the reads each sent back (ok or not), while `run` runs; `run` must settle within DEADLINE. */
async function watch(run, threads) {
  const workers = [];
  const made = (worker) => {
    const seen = { ok: 0, back: 0, ended: false };
    workers.push(seen);
    worker.on("message", (read) => (read.ok ? (seen.ok += 1) : (seen.back += 1)));
    worker.on("exit", () => (seen.ended = true));
  };
  process.on("worker", made);
  let timer;
  const late = new Promise((_, fail) => (timer = setTimeout(() => fail(new assert.AssertionError({ message: stuck(workers, threads) })), DEADLINE)));
  try {
    return { result: await Promise.race([run(), late]), workers };
  } finally {
    clearTimeout(timer);
    process.off("worker", made);
  }
}

test("a worker out of memory gives its file back, and the worker that takes its place reads on: the totals of one thread", { timeout: TIMEOUT }, async (t) => {
  const home = await tempHome(t);
  // Two bombs, the largest files: one to each of the two workers first, so both run out; the replacements read the rest.
  for (let k = 0; k < 2; k += 1) await bomb(home, id("b", k), 0.9, 1_000 + k);
  for (let k = 0; k < 12; k += 1) await small(home, id("s", k), k, 2_000 + k);
  const one = await parseHome(home, { catalog: false, threads: 1 });
  const { result, workers } = await watch(() => parseHome(home, { catalog: false, threads: 2, workerOldMb: 8 }), 2);
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
  const { result, workers } = await watch(() => parseHome(home, { catalog: false, threads: 2, workerOldMb: 8 }), 2);
  assert.deepEqual(result, one);
  // Two threads, two losses a thread: the fifth loss stops the pool, so threads x 3 workers made.
  assert.equal(workers.length, 2 * 3, "the pool stops at its fifth loss");
});

test("workers out of memory, in a process with nothing else to wait on: the import settles (an unref'd worker let it exit 13)", { timeout: TIMEOUT }, async (t) => {
  // Under node --test the runner keeps the event loop alive, so a pool that waits on unref'd workers still settles here.
  // A process of its own whose only work is the import shows it: Node exits 13 on a top-level await that never settles.
  // Whether it does depends on timing (the main thread must run out of its own work while a worker still reads), so three
  // shapes, each in its own process:
  // - 6 files of 1.5 MB at an 8 MB heap: over the line limit (an eighth of the heap, 1 MB), so the main thread reads
  //   them while the workers stop at the limit.
  // - 6 files of 1.8 MB at a 16 MB heap: under the line limit (2 MB), so each runs a worker out, and longer than 0.9 MB.
  // - 6 files of 0.9 MB at an 8 MB heap: the shape of the test above.
  const cases = [
    ["6 files of 1.5 MB at an 8 MB heap", 1.5, 8],
    ["6 files of 1.8 MB at a 16 MB heap", 1.8, 16],
    ["6 files of 0.9 MB at an 8 MB heap", 0.9, 8],
  ];
  // Each child's own bound, so that a hang fails here in words and not on the runner's timeout.
  const LIMIT = 20_000;
  const runs = await Promise.all(
    cases.map(async ([label, mb, heap]) => {
      const home = await tempHome(t);
      for (let k = 0; k < 6; k += 1) await bomb(home, id("b", k), mb, 1_000 + k);
      const child = [
        `import { isDeepStrictEqual } from "node:util";`,
        `import { parseHome } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};`,
        `const home = process.argv[1];`,
        `const pooled = await parseHome(home, { catalog: false, threads: 2, workerOldMb: ${heap} });`,
        `const one = await parseHome(home, { catalog: false, threads: 1 });`,
        `process.stdout.write(isDeepStrictEqual(pooled, one) ? "identical" : "different");`,
      ].join("\n");
      return new Promise((done) => {
        execFile(process.execPath, ["--input-type=module", "-e", child, home], { timeout: LIMIT }, (error, stdout, stderr) =>
          done({ label, code: !error ? 0 : error.killed ? "killed" : (error.code ?? error.signal), stdout, stderr }),
        );
      });
    }),
  );
  // Every case's exit code first, so a red run shows all three.
  for (const { label, code, stderr } of runs) {
    t.diagnostic(`case ${label}: child exit ${code}`);
    if (stderr) t.diagnostic(`case ${label}: child stderr (last 200): ${stderr.slice(-200).replace(/\s+/g, " ")}`);
  }
  for (const { label, code, stdout } of runs) {
    assert.notEqual(code, "killed", `the import in a process of its own settles within ${LIMIT / 1000} s; this one did not (${label})`);
    assert.equal(code, 0, `child exit ${code}: the import must settle in a process of its own (13 is a top-level await left unsettled); ${label}`);
    assert.equal(stdout, "identical", `the totals of one thread (${label})`);
  }
});

test("an empty-object line at the default heap, just under the line limit and just over, each in a process of its own: the totals of one thread", { timeout: TIMEOUT }, async (t) => {
  // OLD_MB 64: the line limit is 8 MB. 7.9 MB of empty objects parses to about 100 MB: the worker may read it or run out
  // (either hands nothing wrong to parseHome). 9 MB stops at the limit. At a quarter of the heap (16 MB) it would go to a
  // worker, whose heap a line this size can run out inside one parse; V8 then ends the whole process. Each case runs in a process of its own, so that such an end fails here in words, and spares the rest of
  // this file's tests.
  const cases = [
    [7.9, ["worker", "out of memory"]],
    [9, ["line limit"]],
  ];
  const LIMIT = 60_000;
  const runs = await Promise.all(
    cases.map(async ([mb, want]) => {
      const home = await tempHome(t);
      await bomb(home, id("b", 0), mb, 1_000);
      for (let k = 0; k < 4; k += 1) await small(home, id("s", k), k, 2_000 + k);
      // The path the long line's file took: handed back at the line limit, a worker out of memory (its file handed
      // back, another worker made), or read on a worker.
      const child = [
        `import { isDeepStrictEqual } from "node:util";`,
        `import { parseHome } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};`,
        `const home = process.argv[1];`,
        `let made = 0, back = 0;`,
        `process.on("worker", (w) => { made += 1; w.on("message", (r) => { if (!r.ok) back += 1; }); });`,
        `const pooled = await parseHome(home, { catalog: false, threads: 2 });`,
        `const path = made > 2 ? "out of memory" : back ? "line limit" : "worker";`,
        `const one = await parseHome(home, { catalog: false, threads: 1 });`,
        `process.stdout.write(JSON.stringify({ identical: isDeepStrictEqual(pooled, one), path, made }));`,
      ].join("\n");
      return new Promise((done) => {
        execFile(process.execPath, ["--input-type=module", "-e", child, home], { timeout: LIMIT }, (error, stdout, stderr) =>
          done({ mb, want, code: !error ? 0 : error.killed ? "killed" : (error.code ?? error.signal), stdout, stderr }),
        );
      });
    }),
  );
  // Every case's exit code and path first, so a red run shows both sides of the limit.
  for (const { mb, code, stdout, stderr } of runs) {
    t.diagnostic(`case ${mb} MB empty-object line at the default heap: child exit ${code}${code === 0 ? `, ${stdout}` : ""}`);
    if (stderr) t.diagnostic(`case ${mb} MB: child stderr (last 200): ${stderr.slice(-200).replace(/\s+/g, " ")}`);
  }
  for (const { mb, want, code, stdout } of runs) {
    assert.notEqual(code, "killed", `a ${mb} MB empty-object line at the default heap settles within ${LIMIT / 1000} s; this one did not`);
    assert.equal(code, 0, `child exit ${code}: a ${mb} MB empty-object line at the default heap must not end the process (${mb > 8 ? "it must stop at the 8 MB line limit, not run a worker out inside one parse" : "a worker that runs out of heap must end alone"})`);
    const { identical, path, made } = JSON.parse(stdout);
    assert.ok(identical, `${mb} MB: the totals of one thread`);
    assert.ok(want.includes(path), `${mb} MB: ${path} (workers made ${made}), not ${want.join(" or ")}`);
  }
});
