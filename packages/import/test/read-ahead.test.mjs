// A read on parseHome's own thread reads a file's next chunk while this one's lines are read: a spare core makes the
// read. A pool worker's read does not (NO_READ_AHEAD, the package's own read option): the pool's threads take every
// core it was given, so a read made ahead waits for one, and its chunk is read on another core than the one that reads
// its lines. Each read is watched through the FileHandle's read: a line handled while a read is in flight is a read
// made ahead.
import assert from "node:assert/strict";
import { appendFile, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import * as pkg from "../dist/index.js";
// The package's own option (internal.ts), which no caller of the package can name.
import * as internal from "../dist/internal.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, tempHome, writeJsonl } from "./fixtures.mjs";

// The bytes a read takes at once (lines.ts): a file of three and a half of them is read in four reads and an empty one.
const CHUNK = 2 ** 20;

/** The FileHandle reads in flight, counted while `body` runs. */
async function watchReads(file, body) {
  const handle = await open(file, "r");
  const proto = Object.getPrototypeOf(handle);
  await handle.close();
  const real = proto.read;
  const reads = { inFlight: 0, made: 0 };
  proto.read = function (...args) {
    reads.inFlight += 1;
    reads.made += 1;
    return real.apply(this, args).finally(() => (reads.inFlight -= 1));
  };
  try {
    return await body(reads);
  } finally {
    proto.read = real;
  }
}

/** A source of lines `{"n":k}`, each counted as it is read, and how many were read while a read was in flight. */
function counting(dir, reads) {
  const seen = { lines: 0, ahead: 0 };
  const reader = pkg.lineReader({
    source: "lines",
    name: "Lines",
    harness: "fixture",
    files: async () => [join(dir, "lines.jsonl")],
    start: () => ({}),
    record() {
      seen.lines += 1;
      if (reads.inFlight > 0) seen.ahead += 1;
    },
    idOf: () => "lines-1",
  });
  return { reader, seen };
}

async function linesFile(dir) {
  const line = `${JSON.stringify({ n: 0, pad: "x".repeat(1000) })}\n`;
  const count = Math.ceil((3.5 * CHUNK) / line.length);
  const file = join(dir, "lines.jsonl");
  await writeFile(file, line.repeat(count));
  return { file, count, bytes: count * line.length };
}

test("a read on parseHome's own thread reads a file's next chunk while this one's lines are read", async (t) => {
  const dir = await tempHome(t);
  const { file, count } = await linesFile(dir);
  await watchReads(file, async (reads) => {
    const { reader, seen } = counting(dir, reads);
    await reader.read({ file }, undefined, { turns: false, totals: true });
    assert.equal(seen.lines, count);
    assert.ok(seen.ahead > 0, "lines read while the next chunk is read");
  });
});

test("a read with NO_READ_AHEAD reads a file's next chunk only after this one's lines are read", async (t) => {
  const dir = await tempHome(t);
  const { file, count, bytes } = await linesFile(dir);
  await watchReads(file, async (reads) => {
    const { reader, seen } = counting(dir, reads);
    const result = await reader.read({ file }, undefined, { turns: false, totals: true, [internal.NO_READ_AHEAD]: true });
    assert.equal(seen.lines, count);
    assert.equal(seen.ahead, 0, "no line read while a read is in flight");
    assert.equal(result.read, bytes);
    // Four chunks, the read that finds the end, and the mark's read of the bytes before the cursor.
    assert.equal(reads.made, 6);
  });
});

test("a read with NO_READ_AHEAD gives what the default read gives, a line across chunks and a last line with no newline", async (t) => {
  const dir = await tempHome(t);
  const session = "00000000-0000-4000-8000-0000000000aa";
  const records = [];
  for (let i = 0; i < 600; i += 1) {
    records.push(claudeUser({ uuid: `${session}-u${i}`, text: `p${i} ${"y".repeat(5000 + (i % 7) * 311)}`, i: 2 * i, session }));
    records.push(claudeAnswer({ uuid: `${session}-a${i}`, msg: `m${i}`, req: `r${i}`, usage: anthropicUsage(i + 1, 2 * i + 1), i: 2 * i + 1, session }));
  }
  const file = await writeJsonl(claudeFile(dir, session), records);
  await appendFile(file, JSON.stringify(claudeAnswer({ uuid: `${session}-last`, msg: "m-last", req: "r-last", usage: anthropicUsage(7, 9), i: 1300, session })));
  const { READERS } = pkg;
  for (const options of [{ turns: false, totals: true }, { turns: true }]) {
    const ahead = await READERS["claude-code"].read({ file }, undefined, options);
    const serial = await READERS["claude-code"].read({ file }, undefined, { ...options, [internal.NO_READ_AHEAD]: true });
    assert.deepEqual(serial, ahead, JSON.stringify(options));
  }
});

// The worker is the pool's own (pool-worker.js), its reads watched from inside it (read-ahead-watch.mjs, loaded first):
// every line it parses while a read of its file is in flight is counted, and the count rides on its reply.
test("a pool worker's read makes no read-ahead of the next chunk", async (t) => {
  const home = await tempHome(t);
  const session = "00000000-0000-4000-8000-0000000000bb";
  const records = [];
  for (let i = 0; i < 400; i += 1) {
    records.push(claudeUser({ uuid: `${session}-u${i}`, text: `p${i} ${"z".repeat(10_000)}`, i: 2 * i, session }));
    records.push(claudeAnswer({ uuid: `${session}-a${i}`, msg: `m${i}`, req: `r${i}`, usage: anthropicUsage(3, 5), i: 2 * i + 1, session }));
  }
  const file = await writeJsonl(claudeFile(home, session), records);
  const worker = new Worker(new URL("../dist/pool-worker.js", import.meta.url), {
    execArgv: ["--import", new URL("./read-ahead-watch.mjs", import.meta.url).href],
    workerData: { maxLine: 8 * CHUNK },
  });
  t.after(() => worker.terminate());
  const reply = await new Promise((done, fail) => {
    worker.once("message", done);
    worker.once("error", fail);
    worker.postMessage({ id: 0, source: "claude-code", locator: { file } });
  });
  assert.equal(reply.ok, true);
  assert.ok(reply.watched.reads >= 4, `the file read in chunks (${reply.watched.reads} reads)`);
  assert.ok(reply.watched.parsed >= 800, "its lines parsed in the worker");
  assert.equal(reply.watched.ahead, 0, "no line parsed while a read is in flight");
});

test("the switch is the package's own: index.js exports no NO_READ_AHEAD", () => {
  assert.equal(typeof internal.NO_READ_AHEAD, "symbol");
  assert.ok(!Object.values(pkg).includes(internal.NO_READ_AHEAD));
  assert.ok(!Object.keys(pkg).some((name) => /ahead/i.test(name)));
});
