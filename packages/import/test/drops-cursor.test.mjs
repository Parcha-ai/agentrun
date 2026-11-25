// A totals read whose caller drops its cursor (parseHome with no state) makes no copy of its counts for that cursor: the
// copy, trimmed to the requests, is as large as the counts, and on a file of a million requests it was some 70 MB made
// only to be dropped. A read whose cursor is kept (a state) keeps it as before, trimmed, and either cursor reads on alike.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { test } from "node:test";
import { parseHome, READERS } from "../dist/index.js";
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
