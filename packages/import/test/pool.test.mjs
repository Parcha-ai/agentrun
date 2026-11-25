// parseHome's totals are the same whatever number of threads read the files ahead (pool.ts): a read made on a worker is
// kept only when no record it asked about and did not hold is one an earlier file holds; any other is made again in
// order, so a copy counts once, in the file the import's order first read it.
import assert from "node:assert/strict";
import { appendFile, utimes } from "node:fs/promises";
import { test } from "node:test";
import { availableParallelism, freemem } from "node:os";
import { relative } from "node:path";
import { parseHome, READERS } from "../dist/index.js";
import * as poolModule from "../dist/pool.js";

const { memoryLimit, ReadPool, readAheadBytes, stringBytes } = poolModule;
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

/** The workers made while `run` goes (process "worker" events). */
async function workersOf(run) {
  const made = [];
  const on = (worker) => made.push(worker);
  process.on("worker", on);
  try {
    return { result: await run(), workers: made.length };
  } finally {
    process.off("worker", on);
  }
}

test("a call with a state reads on its own thread, threads or none: no worker is made, and the state comes out the same", async (t) => {
  const home = await copiedHome(t);
  assert.equal((await workersOf(() => parseHome(home, { catalog: false, threads: 2 }))).workers, 2, "without a state, two threads make two workers");
  const plain = {};
  const threaded = {};
  for (let pass = 0; pass < 2; pass += 1) {
    const { result, workers } = await workersOf(() => parseHome(home, { catalog: false, threads: 2, state: threaded }));
    assert.equal(workers, 0, `pass ${pass}: no worker with a state`);
    assert.deepEqual(result, await parseHome(home, { catalog: false, threads: 1, state: plain }));
    assert.equal(threaded.read, plain.read);
  }
  assert.equal(threaded.read, 0);
});

/** The files read on this thread while `run` goes, relative to `home`. The pool's workers load the readers as modules of
 *  their own, so a read counted here is one parseHome made itself, not one it took from the pool. */
async function readsHere(home, run) {
  const files = [];
  const own = Object.fromEntries(Object.entries(READERS).map(([source, reader]) => [source, reader.read]));
  for (const [source, reader] of Object.entries(READERS)) {
    reader.read = function (locator, ...rest) {
      files.push(relative(home, locator.file));
      return own[source].call(this, locator, ...rest);
    };
  }
  try {
    return { result: await run(), files: files.sort() };
  } finally {
    for (const [source, reader] of Object.entries(READERS)) reader.read = own[source];
  }
}

/** Sessions with no record in common: no read of one is changed by another. */
async function plainHome(t) {
  const home = await tempHome(t);
  for (let k = 0; k < 6; k += 1) {
    const session = `00000000-0000-4000-8000-0000000000b${k}`;
    await utimes(await writeJsonl(claudeFile(home, session), [claudeUser({ uuid: `b${k}-u`, text: "Plain question.", i: 0, session }), claudeAnswer({ uuid: `b${k}-a`, msg: `msg_b${k}`, req: `req_b${k}`, usage: anthropicUsage(k + 1, 2), i: 1, session })]), 1_000 + k, 1_000 + k);
    if (k < 2) await writeJsonl(subagentFile(home, session, `agent-b${k}`), [claudeAnswer({ uuid: `b${k}-s`, msg: `msg_b${k}s`, req: `req_b${k}s`, usage: anthropicUsage(5, 6), i: 2, session, sidechain: true })]);
  }
  await writeJsonl(codexFile(home), [codexMeta("thread-b"), codexContext(1), codexUser("Plain question.", 2), codexAnswer("Plain answer.", 3), codexTokens(openaiUsage(100, 60, 7, 3), openaiUsage(100, 60, 7, 3), 4)]);
  return home;
}

test("with no copies, every read is the pool's: parseHome makes none again on its own thread", async (t) => {
  const home = await plainHome(t);
  const one = await readsHere(home, () => parseHome(home, { catalog: false, threads: 1 }));
  assert.equal(one.files.length, 6 + 2 + 1, "threads: 1 reads every file on this thread");
  for (const opts of THREADS.flatMap(each)) {
    const pooled = await readsHere(home, () => parseHome(home, { catalog: false, ...opts }));
    assert.deepEqual(pooled.result, one.result, JSON.stringify(opts));
    assert.deepEqual(pooled.files, [], `${JSON.stringify(opts)}: each read taken from the pool, none made again`);
  }
});

test("with copies, only the files that hold a copy are read again on parseHome's own thread", async (t) => {
  const home = await copiedHome(t);
  // The resumed file opens with the old one's records; its subagent repeats the old file's request.
  const again = [claudeFile(home, NEW), subagentFile(home, NEW, "agent-a1")].map((file) => relative(home, file)).sort();
  for (const opts of THREADS.flatMap(each)) assert.deepEqual((await readsHere(home, () => parseHome(home, { catalog: false, ...opts }))).files, again, JSON.stringify(opts));
});

test("a source read again whole (tokens past a safe sum) gives up its reads in the pool: the totals of one thread", async (t) => {
  const home = await tempHome(t);
  for (let k = 0; k < 4; k += 1) {
    const session = `00000000-0000-4000-8000-0000000000d${k}`;
    await utimes(await writeJsonl(claudeFile(home, session), [claudeUser({ uuid: `d${k}-u`, text: "Big.", i: 0, session }), claudeAnswer({ uuid: `d${k}-a`, msg: `msg_d${k}`, req: `req_d${k}`, usage: anthropicUsage(2 ** 52, 1), i: 1, session })]), 1_000 + k, 1_000 + k);
  }
  const one = await parseHome(home, { catalog: false, threads: 1 });
  for (const opts of THREADS.flatMap(each)) assert.deepEqual(await parseHome(home, { catalog: false, ...opts }), one, JSON.stringify(opts));
});

test("threads, readAhead and workerOldMb out of range are refused", async (t) => {
  const home = await plainHome(t);
  for (const opts of [{ threads: 0 }, { threads: 2.5 }, { threads: Number.NaN }, { readAhead: -1 }, { readAhead: Number.NaN }, { workerOldMb: 0 }, { workerOldMb: 1.5 }]) {
    await assert.rejects(parseHome(home, { catalog: false, ...opts }), RangeError, JSON.stringify(opts));
  }
});

test("workerOldMb under 8 is refused before any worker starts, naming the floor; 8 reads every file on the workers", async (t) => {
  const home = await copiedHome(t);
  const one = await parseHome(home, { catalog: false, threads: 1 });
  // 7 first: on a build without the floor it starts workers that lose their reads, where 1 or 2 would end this process.
  for (const workerOldMb of [7, 3, 2, 1]) {
    const { result, workers } = await workersOf(() => parseHome(home, { catalog: false, threads: 2, workerOldMb }).then(() => "read", (e) => e));
    assert.ok(result instanceof RangeError, `workerOldMb ${workerOldMb}: ${result}`);
    assert.match(result.message, /^workerOldMb: a whole number of MB, at least 8, not \d+$/);
    assert.equal(workers, 0, `workerOldMb ${workerOldMb}: no worker started`);
  }
  // Refused on the calling thread too: the option is the same whatever the threads.
  await assert.rejects(parseHome(home, { catalog: false, threads: 1, workerOldMb: 7 }), RangeError);
  let made = 0;
  let ok = 0;
  let back = 0;
  const watch = (worker) => {
    made += 1;
    worker.on("message", (read) => (read.ok ? (ok += 1) : (back += 1)));
  };
  process.on("worker", watch);
  t.after(() => process.off("worker", watch));
  assert.deepEqual(await parseHome(home, { catalog: false, threads: 2, workerOldMb: 8 }), one, "at the floor, the totals of one thread");
  assert.deepEqual({ made, back }, { made: 2, back: 0 }, "no worker lost, no file handed back");
  assert.ok(ok > 0, "the workers read files");
});

test("threads over 64 are refused before any worker starts", async (t) => {
  const home = await plainHome(t);
  for (const threads of [65, 100_000]) {
    const { result, workers } = await workersOf(() => parseHome(home, { catalog: false, threads }).then(() => "read", (e) => e));
    assert.ok(result instanceof RangeError, `threads ${threads}: ${result}`);
    assert.equal(workers, 0, `threads ${threads}: no worker started`);
  }
});

test("a container's memory limit below the machine's sets the default read-ahead", () => {
  assert.equal(memoryLimit(512 * 2 ** 30, 2 * 2 ** 30), 2 * 2 ** 30, "a 2 GiB container on a 512 GiB host");
  assert.equal(readAheadBytes(memoryLimit(512 * 2 ** 30, 2 * 2 ** 30)), 128 * 2 ** 20);
  assert.equal(memoryLimit(8 * 2 ** 30, 0), 8 * 2 ** 30, "no limit");
  assert.equal(memoryLimit(8 * 2 ** 30, 2 ** 62), 8 * 2 ** 30, "a limit above the machine's");
});

test("a read's strings are charged as V8 holds them: one byte a character up to U+00FF, two past it", () => {
  assert.equal(stringBytes({ firstPrompt: "a".repeat(1000) }), 1000, "ASCII");
  assert.equal(stringBytes({ firstPrompt: "é".repeat(1000) }), 1000, "Latin-1 is still one byte a character");
  assert.equal(stringBytes({ firstPrompt: "日本".repeat(500) }), 2000, "CJK takes two bytes a character");
  assert.equal(stringBytes({ firstPrompt: "a".repeat(999) + "日" }), 2000, "one character past U+00FF makes the whole string two bytes");
  assert.equal(stringBytes({ firstPrompt: "日", titleText: "ab", turns: 3 }), 4, "each string on its own; numbers count nothing");
});

test("a read's strings in its objects and arrays are charged too: each object once, at any depth", () => {
  // A session's turns (types.ts: Turn[], each with its text, its calls' ids, names and arguments) and a read's requests.
  const turns = [
    { role: "user", text: "日本", at: 1 },
    { role: "assistant", text: "", calls: [{ type: "toolCall", id: "c1", name: "ls", arguments: { path: "a".repeat(100) } }], at: 2 },
  ];
  assert.equal(stringBytes({ session: { id: "s", turns }, requests: [] }), 1 + 4 + 4 + 9 + 8 + 2 + 2 + 100, "nested in objects and arrays");
  const shared = { text: "a".repeat(10) };
  assert.equal(stringBytes({ a: shared, b: [shared, shared] }), 10, "an object held twice is charged once");
  const cycle = { text: "ab" };
  cycle.self = cycle;
  assert.equal(stringBytes(cycle), 2, "a cycle ends");
  assert.equal(stringBytes({ counts: { models: ["m"], values: new Float64Array(1 << 10) } }), 1, "typed arrays hold no strings (their bytes count apart)");
  let deep = ["z"];
  for (let i = 0; i < 100_000; i += 1) deep = [deep];
  assert.equal(stringBytes(deep), 1, "no depth runs the call stack out");
});

test("the default read-ahead is 1 GiB, or a sixteenth of the machine's memory when that is less", () => {
  assert.equal(readAheadBytes(8 * 2 ** 30), 512 * 2 ** 20);
  assert.equal(readAheadBytes(16 * 2 ** 30), 2 ** 30);
  assert.equal(readAheadBytes(512 * 2 ** 30), 2 ** 30);
});

const GiB = 2 ** 30;
const MiB = 2 ** 20;

test("the default threads are the cores less one, at most 16, and no more workers than the memory free holds", () => {
  const { defaultThreads } = poolModule;
  assert.equal(typeof defaultThreads, "function", "pool.js exports defaultThreads");
  // A worker's heap: its 16 MB young generation and its old one (OLD_MB, 64), 80 MiB.
  assert.equal(poolModule.workerBytes(), 80 * MiB);
  assert.equal(poolModule.workerBytes(32), 48 * MiB);
  assert.equal(defaultThreads(48, 503 * GiB, GiB), 16, "48 cores, 503 GB: the ceiling");
  assert.equal(defaultThreads(10, 16 * GiB, GiB), 9, "a 10-core laptop, 16 GB free");
  assert.equal(defaultThreads(10, 2 * GiB, GiB), 9, "the same with 2 GB free: 1 GiB past the read-ahead holds 12 workers");
  assert.equal(defaultThreads(10, 1.5 * GiB, GiB), 6, "1.5 GB free: 512 MiB past the read-ahead holds 6");
  assert.equal(defaultThreads(4, 8 * GiB, 512 * MiB), 3, "4 cores, 8 GB");
  assert.equal(defaultThreads(2, 8 * GiB, 512 * MiB), 2, "two cores keep two threads");
  assert.equal(defaultThreads(1, 8 * GiB, 512 * MiB), 1, "one core: the calling thread alone");
  assert.equal(defaultThreads(48, GiB + 3 * 80 * MiB, GiB), 3, "three heaps past the read-ahead: three");
  assert.equal(defaultThreads(48, GiB + 3 * 80 * MiB - 1, GiB), 2, "a byte short of three: two");
  assert.equal(defaultThreads(48, 512 * MiB, GiB), 1, "less free than the read-ahead: the calling thread alone");
  assert.equal(defaultThreads(48, GiB + 3 * 48 * MiB, GiB, 32), 3, "a smaller old generation fits more");
  assert.equal(defaultThreads(48, GiB + 3 * 48 * MiB, GiB), 1, "at the default's 80 MiB, the same memory holds one");
  assert.equal(poolModule.freeMemory(8 * GiB, 2 * GiB), 2 * GiB, "a 2 GiB container: its limit");
  assert.equal(poolModule.freeMemory(GiB, 512 * GiB), GiB, "1 GiB free on the machine: 1 GiB");
});

test("without threads, parseHome starts the default's workers: the cores less one, none when the heaps or the read-ahead fill the memory free", async (t) => {
  const home = await copiedHome(t);
  const one = await parseHome(home, { catalog: false, threads: 1 });
  const cores = availableParallelism();
  const byCores = Math.min(cores <= 2 ? cores : cores - 1, 16);
  // One thread is the calling thread alone: no worker.
  const workersAt = (threads) => (threads > 1 ? threads : 0);
  const free = Math.min(freemem(), memoryLimit());
  // 80 MiB heaps, nothing set aside: the cores set the count while the memory free holds 16 of them (1.25 GiB; under
  // twice that, the test is skipped).
  if (free < 2 * 16 * 80 * MiB) return t.skip(`${Math.round(free / MiB)} MiB free`);
  const small = await workersOf(() => parseHome(home, { catalog: false, readAhead: 0 }));
  assert.equal(small.workers, workersAt(byCores), `${cores} cores`);
  assert.deepEqual(small.result, one);
  // An old generation four times the memory free: not one heap fits, so every file is read on the calling thread.
  const huge = Math.ceil((4 * free) / MiB);
  const big = await workersOf(() => parseHome(home, { catalog: false, readAhead: 0, workerOldMb: huge }));
  assert.equal(big.workers, 0, "heaps past the memory free");
  assert.deepEqual(big.result, one);
  // A read-ahead four times the memory free leaves none for a worker.
  const ahead = await workersOf(() => parseHome(home, { catalog: false, readAhead: 4 * free }));
  assert.equal(ahead.workers, 0, "a read-ahead past the memory free");
  assert.deepEqual(ahead.result, one);
  // A caller's threads are taken as given, though the default here would read on the calling thread.
  assert.equal((await workersOf(() => parseHome(home, { catalog: false, threads: 3, readAhead: 4 * free }))).workers, 3, "a caller's threads");
});

// The pool on its own: N files of the same shape, so each read waiting holds the same bytes, and nothing taken.
const SAME = 12;

async function sameShape(t) {
  const home = await tempHome(t);
  const items = [];
  for (let k = 0; k < SAME; k += 1) {
    const session = `00000000-0000-4000-8000-0000000000e${k.toString(16)}`;
    const file = await writeJsonl(claudeFile(home, session), [claudeUser({ uuid: `e${k.toString(16)}-u`, text: "Same question.", i: 0, session }), claudeAnswer({ uuid: `e${k.toString(16)}-a`, msg: `msg_e${k.toString(16)}`, req: `req_e${k.toString(16)}`, usage: anthropicUsage(1, 2), i: 1, session })]);
    items.push({ source: "claude-code", locator: { file }, size: 1_000 });
  }
  return items;
}

/** Waits until no worker reads: no read is in flight, and none is sent until one is taken or dropped. */
async function settled(pool) {
  for (let i = 0; i < 2_000 && pool.reading; i += 1) await new Promise((done) => setTimeout(done, 5));
  assert.equal(pool.reading, 0, "the pool settles");
}

/** A pool of `threads` and read-ahead `ahead` over `items`, nothing taken, once it settles: the reads its workers sent
 *  back (each one waiting, as none is taken), and the bytes they hold. */
async function aheadOf(items, threads, ahead) {
  let reads = 0;
  const counted = (worker) => worker.on("message", () => (reads += 1));
  process.on("worker", counted);
  const pool = new ReadPool(threads, ahead);
  try {
    pool.readAll(items);
    await settled(pool);
    return { peak: pool.peakWaiting, held: pool.held, waiting: reads };
  } finally {
    process.off("worker", counted);
    pool.close();
  }
}

test("the read-ahead caps the reads waiting: none at 0, else at most the reads in flight when it was reached", async (t) => {
  const items = await sameShape(t);
  const all = await aheadOf(items, 2, Number.POSITIVE_INFINITY);
  assert.equal(all.waiting, SAME, "no cap: every file read ahead");
  const one = all.held / SAME;
  assert.ok(one > 0 && Number.isInteger(one), `each read waiting holds the same bytes (${all.held} / ${SAME})`);
  assert.equal(all.peak, all.held);
  assert.deepEqual(await aheadOf(items, 2, 0), { peak: 0, held: 0, waiting: 0 }, "readAhead 0: nothing read ahead");
  // One thread: reads are sent at 0, 1 and 2 reads waiting (under 2.5), none at 3.
  assert.deepEqual(await aheadOf(items, 1, 2.5 * one), { peak: 3 * one, held: 3 * one, waiting: 3 });
  // More threads: past the read-ahead by at most the reads in flight when it was reached.
  for (const [threads, ahead] of [[2, 1], [3, 2.5 * one], [4, 4 * one]]) {
    const { peak, held, waiting } = await aheadOf(items, threads, ahead);
    assert.equal(held, waiting * one, `threads ${threads}, read-ahead ${ahead}: each read back is waiting`);
    assert.ok(peak >= Math.min(ahead, SAME * one) && peak <= ahead + threads * one, `threads ${threads}, read-ahead ${ahead}: peak ${peak}`);
    assert.ok(waiting < SAME, `threads ${threads}, read-ahead ${ahead}: ${waiting} of ${SAME} read ahead`);
  }
});

test("reads dropped let the read-ahead go: the pool reads on past them, and a dropped read is not taken", async (t) => {
  const items = await sameShape(t);
  const one = (await aheadOf(items, 1, Number.POSITIVE_INFINITY)).held / SAME;
  assert.ok(one > 0, "with no cap, the pool reads ahead");
  // One thread, nothing taken: reads go in the import's order, three of them under 2.5 reads of read-ahead.
  const pool = new ReadPool(1, 2.5 * one);
  try {
    pool.readAll(items);
    await settled(pool);
    assert.equal(pool.held, 3 * one, "three read ahead");
    pool.drop([0, 1, 2]);
    assert.equal(pool.held, 0, "the reads dropped are the three waiting");
    await settled(pool);
    assert.equal(pool.held, 3 * one, "three more read ahead");
    // Each of the next three is waiting: taking it lets go of its bytes (one not read yet would be read, and hold none).
    for (const id of [3, 4, 5]) {
      const held = pool.held;
      assert.equal((await pool.take(id)).ok, true);
      assert.equal(pool.held, held - one, `file ${id} was read ahead`);
    }
    assert.deepEqual(await pool.take(0), { ok: false }, "a dropped read is not taken");
  } finally {
    pool.close();
  }
});

test("a source read again whole lets go of its reads in the pool: once the pool settles, none waits", async (t) => {
  const home = await tempHome(t);
  // The second file's tokens take the sums past 2^53 - 1: the source is read again whole, and the last two files' reads,
  // made ahead (the read-ahead is the default), are never taken.
  for (let k = 0; k < 4; k += 1) {
    const session = `00000000-0000-4000-8000-0000000000f${k}`;
    await utimes(await writeJsonl(claudeFile(home, session), [claudeUser({ uuid: `f${k}-u`, text: "Big.", i: 0, session }), claudeAnswer({ uuid: `f${k}-a`, msg: `msg_f${k}`, req: `req_f${k}`, usage: anthropicUsage(2 ** 52, 1), i: 1, session })]), 1_000 + k, 1_000 + k);
  }
  // The pool parseHome made, kept open past its close until it settles.
  const pools = [];
  const close = ReadPool.prototype.close;
  ReadPool.prototype.close = function () {
    pools.push(this);
  };
  try {
    assert.deepEqual(await parseHome(home, { sources: ["claude-code"], catalog: false, threads: 2 }), await parseHome(home, { sources: ["claude-code"], catalog: false, threads: 1 }));
  } finally {
    ReadPool.prototype.close = close;
  }
  assert.equal(pools.length, 1, "one pool");
  try {
    await settled(pools[0]);
    assert.equal(pools[0].held, 0, "no read of the source read again waits in the pool");
  } finally {
    pools[0].close();
  }
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
