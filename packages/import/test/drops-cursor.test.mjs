// A totals read whose caller drops its cursor (parseHome with no state) makes no copy of its counts for that cursor: the
// copy, trimmed to the requests, is as large as the counts, and on a file of a million requests it was some 70 MB made
// only to be dropped. A read whose cursor is kept (a state) keeps it as before, trimmed, and either cursor reads on alike.
// Nor does it copy its whole state for that cursor when the file's last line has no newline yet: that copy (the state as
// it was before the line, the file's own request index and counts with it) was held beside the live state, the largest
// file's peak, for a cursor parseHome then dropped. The line still counts as it did, so the totals are a kept pass's.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { test } from "node:test";
import { parseHome, READERS, readSession } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, jsonl, tempHome, writeJsonl } from "./fixtures.mjs";

const claude = READERS["claude-code"];
const STRIDE = 7;
// The option is the package's own (src/internal.ts), keyed by a symbol no caller's ReadOptions can name. Loaded so, a
// build from before it still runs the tests below (the first one then fails, as it should).
const DROPS_CURSOR = await import("../dist/internal.js").then(({ DROPS_CURSOR }) => DROPS_CURSOR, () => undefined);
const dropping = DROPS_CURSOR === undefined ? {} : { [DROPS_CURSOR]: true };

/** One session file of `n` requests, each a user line and its answer. */
const records = (n, from = 0) =>
  Array.from({ length: n }, (_, k) => {
    const i = from + k;
    return [
      claudeUser({ uuid: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`, text: "Go.", i: 2 * i }),
      claudeAnswer({ uuid: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`, msg: `msg_${i}`, req: `req_${i}`, usage: anthropicUsage(10 + i, 5), i: 2 * i + 1 }),
    ];
  }).flat();

/** Claude Code's reader, each read's options and result noted. */
function spying() {
  const reads = [];
  const reader = {
    ...claude,
    read: async (locator, cursor, options) => {
      const result = await claude.read(locator, cursor, options);
      reads.push({ options, result });
      return result;
    },
  };
  return { reads, readers: { ...READERS, "claude-code": reader } };
}

test("parseHome with no state makes no copy of a read's counts for the cursor it drops", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), records(100));
  const { reads, readers } = spying();
  const [session] = await parseHome(home, { sources: ["claude-code"], readers, catalog: false });
  assert.equal(session.calls, 100);
  assert.equal(reads.length, 1);
  const [{ result }] = reads;
  const counts = result.sessions[0].counts;
  assert.equal(counts.n, 100);
  assert.ok(counts.model.length > counts.n, "the read's counts have room to grow (a trimmed copy would have none)");
  assert.equal(result.cursor.state.counts, counts, "the dropped cursor holds the read's own counts, no copy of them");
});

test("parseHome with a state keeps each cursor as before: its counts a copy trimmed to the requests", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(claudeFile(home), records(100));
  const { reads, readers } = spying();
  const state = {};
  await parseHome(home, { sources: ["claude-code"], readers, catalog: false, state });
  const [{ result }] = reads;
  const kept = state.sources["claude-code"].cursors.get(file);
  assert.equal(kept, result.cursor);
  const { counts } = kept.state;
  assert.notEqual(counts, result.sessions[0].counts);
  assert.deepEqual([counts.n, counts.model.length, counts.values.length, counts.has.length], [100, 100, 100 * STRIDE, 100]);
  // The same cursor a read with the reader's defaults gives, as before this change.
  const plain = await claude.read({ file }, undefined, { turns: false, totals: true, seen: new Set() });
  assert.deepEqual(kept, plain.cursor);
});

test("a dropped cursor and a kept one read on from the same place to the same result", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(claudeFile(home), records(40));
  const options = { turns: false, totals: true };
  const dropped = await claude.read({ file }, undefined, { ...options, ...dropping });
  const kept = await claude.read({ file }, undefined, options);
  if (DROPS_CURSOR !== undefined) assert.equal(dropped.cursor.state.counts, dropped.sessions[0].counts, "the dropped cursor is the untrimmed one");
  assert.equal(dropped.cursor.offset, kept.cursor.offset);
  assert.equal(dropped.cursor.mark, kept.cursor.mark);
  await appendFile(file, jsonl(records(25, 40)));
  const fromDropped = await claude.read({ file }, dropped.cursor, options);
  const fromKept = await claude.read({ file }, kept.cursor, options);
  assert.ok(fromDropped.resumed && fromKept.resumed);
  assert.equal(fromKept.read, fromDropped.read);
  const totals = ({ sessions: [{ session, counts }] }) => ({ session, n: counts.n, values: [...counts.values.subarray(0, counts.n * STRIDE)], model: [...counts.model.subarray(0, counts.n)], has: [...counts.has.subarray(0, counts.n)] });
  assert.deepEqual(totals(fromDropped), totals(fromKept));
  assert.equal(fromKept.sessions[0].counts.n, 65);
});

test("the option is no caller's: the package exports it nowhere, and a ReadOptions naming it keeps the trimmed copy", async (t) => {
  const exported = await import("../dist/index.js");
  assert.ok(!Object.keys(exported).some((name) => /drops|internal/i.test(name)));
  await assert.rejects(import("@parcha/agentrun-import/dist/internal.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  const file = await writeJsonl(claudeFile(await tempHome(t)), records(10));
  const result = await claude.read({ file }, undefined, { turns: false, totals: true, dropsCursor: true });
  assert.notEqual(result.cursor.state.counts, result.sessions[0].counts);
  assert.equal(result.cursor.state.counts.model.length, 10);
});

const SESSION = "00000000-0000-4000-8000-0000000000c1";
const COPY = "00000000-0000-4000-8000-0000000000c2";
const opening = [
  claudeUser({ uuid: "u1", text: "Fixture question.", i: 0, session: SESSION }),
  claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 5), i: 1, session: SESSION }),
];
// The last line: whole JSON, no newline after it yet.
const last = claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(4, 7), i: 2, session: SESSION });

/** A home of one session whose file's last line has no newline, and a second file that copies that line's record. */
async function unfinished(t) {
  const dir = await tempHome(t);
  const file = await writeJsonl(claudeFile(dir, SESSION), opening);
  await appendFile(file, JSON.stringify(last));
  await writeJsonl(claudeFile(dir, COPY), [{ ...last, sessionId: COPY }, claudeUser({ uuid: "u3", text: "Another.", i: 3, session: COPY })]);
  return { dir, file };
}

/** `run` with every structuredClone of a read's state counted. */
async function clonesIn(run) {
  const real = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = (value, options) => {
    if (value && typeof value === "object" && "session" in value && "own" in value) clones += 1;
    return real(value, options);
  };
  try {
    return { result: await run(), clones };
  } finally {
    globalThis.structuredClone = real;
  }
}

test("parseHome without a state copies no read's state for the cursor it drops, and totals as a pass with a state", async (t) => {
  const { dir } = await unfinished(t);
  const { result: fresh, clones } = await clonesIn(() => parseHome(dir, { sources: ["claude-code"], catalog: false, threads: 1 }));
  assert.equal(clones, 0, "no copy of a read's state");
  const { result: kept, clones: keptClones } = await clonesIn(() => parseHome(dir, { sources: ["claude-code"], catalog: false, threads: 1, state: {} }));
  assert.equal(keptClones, 1, "a pass with a state keeps the cursor before the last line: one copy");
  assert.deepEqual(fresh, kept);
  assert.equal(fresh.find(({ id }) => id === SESSION).tokens.output, 5 + 7, "the last line is read");
});

test("a read with dropsCursor: the same sessions, no copy of its state", async (t) => {
  const { file } = await unfinished(t);
  const options = { turns: false, totals: true };
  const { result: dropped, clones } = await clonesIn(() => claude.read({ file }, undefined, { ...options, ...dropping }));
  assert.equal(clones, 0);
  const { result: whole } = await clonesIn(() => claude.read({ file }, undefined, options));
  assert.deepEqual(dropped.sessions, whole.sessions);
  assert.equal(dropped.read, whole.read);
  assert.equal(whole.cursor.offset, dropped.cursor.offset, "the cursor's offset is before the last line either way");
  // readSession drops its cursor too.
  const { result: session, clones: sessionClones } = await clonesIn(() => readSession(file, "claude-code"));
  assert.equal(sessionClones, 0, "readSession copies no read's state");
  assert.deepEqual(session.turns.at(-1).usage, { input: 4, output: 7, cacheRead: 0, cacheWrite: 0 }, "the last line is read");
});
