// A forked Codex rollout's copy of its parent's history (#3588) is skipped the same on every path a totals read takes:
// the scan of each line's fields (scan.ts, the reader's Shape), JSON.parse of the whole line, and the read pool's
// workers. A path that misses the skip counts the parent's history a second time, or takes the parent's id from the
// session_meta a fork copies after its own. Synthetic fixtures only.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseHome, READERS } from "../dist/index.js";
import { codexLines, codexReader } from "../dist/readers/codex.js";
import { at, codexAnswer, codexContext, codexUser, openaiUsage, tempHome, writeJsonl } from "./fixtures.mjs";

// UUIDv7 ids dated 2026-01-01, as Codex names its threads.
const PARENT = "019b76da-a800-7000-8000-0000000000a1";
const FORK = "019b76da-a800-7000-8000-0000000000b1";
const COPIER = "019b76da-a800-7000-8000-0000000000b2";
const CHILD = "019b76da-a800-7000-8000-0000000000c1";
const rollout = (home, id) => join(home, ".codex", "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
const meta = (id, i, extra = {}) => ({ type: "session_meta", timestamp: at(i), payload: { id, cwd: "/work/fixture", model_provider: "openai", ...extra } });
const tokens = (last, total, i) => ({ type: "event_msg", timestamp: at(i), payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } } });
const spawned = (parent) => ({ parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } });
const USES = [openaiUsage(100, 40, 10), openaiUsage(200, 150, 20), openaiUsage(300, 250, 30)];
const TOTALS = [openaiUsage(100, 40, 10), openaiUsage(300, 190, 30), openaiUsage(600, 440, 60)];
const turn = (k, last, total, i) => [codexContext(i), codexUser(`Question ${k}.`, i + 1), codexAnswer(`Answer ${k}.`, i + 2), tokens(last, total, i + 3)];
const parentLines = () => [meta(PARENT, 0), ...USES.flatMap((use, k) => turn(k + 1, use, TOTALS[k], 1 + k * 4))];
/** The parent's history as a fork copies it in, stamped at the fork's time. */
const replayed = (i = 21) => parentLines().slice(1).map((line) => ({ ...line, timestamp: at(i) }));
/** The fork's own turn, `n` uncached input and output. */
const ownTurn = (n, i = 30) => turn(9, openaiUsage(n, 0, n), openaiUsage(600 + n, 440, 60 + n), i);

/** A parent; a user fork (Codex 0.145); a fork that copies its parent's session_meta after its own (Codex 0.154); a
 *  spawned subagent (Codex 0.130). Each fork's copy is the parent's whole history. */
async function forkHome(t) {
  const home = await tempHome(t);
  await writeJsonl(rollout(home, PARENT), parentLines());
  await writeJsonl(rollout(home, FORK), [meta(FORK, 20, { forked_from_id: PARENT }), ...replayed(), ...ownTurn(7)]);
  await writeJsonl(rollout(home, COPIER), [meta(COPIER, 20, { forked_from_id: PARENT }), { ...meta(PARENT, 20) }, ...replayed(), ...ownTurn(5)]);
  await writeJsonl(rollout(home, CHILD), [meta(CHILD, 20, { forked_from_id: PARENT, ...spawned(PARENT) }), ...replayed(), ...ownTurn(3)]);
  return home;
}

/** Codex read with JSON.parse on every line: its reader over the same source with no Shape. */
const parsed = { ...READERS, codex: codexReader({ ...codexLines, fields: undefined }) };

/** `run` with every pool worker watched: the files their reads were of. */
async function onWorkers(run) {
  const files = [];
  const watch = (worker) => worker.on("message", (read) => read.ok && files.push(...read.sessions.map(({ locator }) => locator.file)));
  process.on("worker", watch);
  try {
    return { result: await run(), files };
  } finally {
    process.off("worker", watch);
  }
}

test("a forked Codex session's totals are the same through the scan, JSON.parse and the pool: the parent's history counts once", async (t) => {
  const home = await forkHome(t);
  const options = { sources: ["codex"], catalog: false, env: {} };
  const scanned = await parseHome(home, { ...options, threads: 1 });
  const byId = Object.fromEntries(scanned.map((row) => [row.id, row]));
  // The parent's three requests once, its spawned subagent's own turn with them; each fork its own turn alone.
  assert.deepEqual(Object.keys(byId).sort(), [PARENT, FORK, COPIER].sort());
  assert.deepEqual([byId[PARENT].calls, byId[PARENT].subagents, byId[PARENT].tokens.input, byId[PARENT].tokens.output], [4, 1, 60 + 50 + 50 + 3, 60 + 3]);
  assert.deepEqual([byId[FORK].calls, byId[FORK].tokens.input, byId[FORK].tokens.output], [1, 7, 7]);
  assert.deepEqual([byId[COPIER].calls, byId[COPIER].tokens.input, byId[COPIER].tokens.output], [1, 5, 5]);
  assert.deepEqual(await parseHome(home, { ...options, threads: 1, readers: parsed }), scanned, "JSON.parse gives the scan's totals");
  for (const threads of [2, 4]) {
    const { result, files } = await onWorkers(() => parseHome(home, { ...options, threads }));
    assert.deepEqual(result, scanned, `the pool at ${threads} threads gives one thread's totals`);
    assert.ok(files.some((file) => file === rollout(home, FORK) || file === rollout(home, COPIER) || file === rollout(home, CHILD)), "a fork read on a worker");
  }
});
