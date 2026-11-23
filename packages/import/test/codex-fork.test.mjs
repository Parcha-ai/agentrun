// A forked Codex rollout: the parent's history it copies in is the parent's, counted once, where the parent's file is
// read; the fork keeps its own id whatever session_meta it copies after its own.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { appendFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { parseHome, READERS, readSession } from "../dist/index.js";
import { at, codexAnswer, codexContext, codexUser, jsonl, openaiUsage, tempHome, writeJsonl } from "./fixtures.mjs";

// UUIDv7 ids dated 2026-01-01, as Codex names its threads.
const PARENT = "019b76da-a800-7000-8000-00000000000a";
const FORK = "019b76da-a800-7000-8000-00000000000b";
const CHILD = "019b76da-a800-7000-8000-00000000000c";
const rollout = (home, id) => join(home, ".codex", "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
const meta = (id, i, extra = {}) => ({ type: "session_meta", timestamp: at(i), payload: { id, cwd: "/work/fixture", model_provider: "openai", ...extra } });
const tokens = (last, total, i) => ({ type: "event_msg", timestamp: at(i), payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } } });
const spawned = (parent) => ({ parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } });

// The parent's three requests, each a turn of its own: [last, total] as its token_counts write them.
const USES = [openaiUsage(100, 40, 10), openaiUsage(200, 150, 20), openaiUsage(300, 250, 30)];
const running = (uses) => uses.reduce((totals, use) => [...totals, totals.length ? openaiUsage(totals.at(-1).input_tokens + use.input_tokens, totals.at(-1).cached_input_tokens + use.cached_input_tokens, totals.at(-1).output_tokens + use.output_tokens) : use], []);
const TOTALS = running(USES);
/** Turn k of a history (1-based), from second `i`: its context, prompt, answer and token_count. */
const turn = (k, last, total, i) => [codexContext(i), codexUser(`Question ${k}.`, i + 1), codexAnswer(`Answer ${k}.`, i + 2), tokens(last, total, i + 3)];
const parentLines = () => [meta(PARENT, 0), ...USES.flatMap((use, k) => turn(k + 1, use, TOTALS[k], 1 + k * 4))];
/** The parent's history as a fork copies it in: every line after its session_meta, stamped at the fork's time. */
const replayed = (from = 0, i = 21) => parentLines().slice(1 + from * 4).map((line) => ({ ...line, timestamp: at(i) }));
/** The fork's own turn: totals go on from the copied history's. */
const OWN = openaiUsage(7, 0, 3);
const ownTurn = (i = 30) => turn(9, OWN, openaiUsage(TOTALS.at(-1).input_tokens + 7, TOTALS.at(-1).cached_input_tokens, TOTALS.at(-1).output_tokens + 3), i);
// Uncached input, as normalizeUsage counts it: input less cached.
const PARENT_TOKENS = { input: 60 + 50 + 50, output: 60, cacheRead: 440, cacheWrite: 0, cacheWrite1h: 0 };

test("a user fork (Codex 0.145) copies the parent's token_counts: they count once, in the parent", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(rollout(home, PARENT), parentLines());
  await writeJsonl(rollout(home, FORK), [meta(FORK, 20, { forked_from_id: PARENT }), ...replayed(), ...ownTurn()]);
  const sessions = await parseHome(home, { sources: ["codex"] });
  const byId = new Map(sessions.map((line) => [line.id, line]));
  assert.deepEqual([...byId.keys()].sort(), [PARENT, FORK]);
  assert.deepEqual(byId.get(PARENT).tokens, PARENT_TOKENS);
  assert.equal(byId.get(PARENT).calls, 3);
  assert.deepEqual(byId.get(FORK).tokens, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  assert.equal(byId.get(FORK).calls, 1);
  // The fork's transcript is its own: the copied turns are copies, and its first prompt is the one asked in it.
  const fork = await readSession(rollout(home, FORK), "codex");
  assert.equal(fork.firstPrompt, "Question 9.");
  assert.deepEqual(fork.turns.filter((t) => t.role === "user").map((t) => t.text), ["Question 9."]);
  assert.equal(fork.startedAt, at(20), "its own session_meta, not a copied line");
});

test("a spawned subagent (Codex 0.130) copies the parent's token_counts: its parent's session counts them once", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(rollout(home, PARENT), parentLines());
  await writeJsonl(rollout(home, CHILD), [meta(CHILD, 20, { forked_from_id: PARENT, ...spawned(PARENT) }), ...replayed(), ...ownTurn()]);
  const sessions = await parseHome(home, { sources: ["codex"] });
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].tokens, { ...PARENT_TOKENS, input: PARENT_TOKENS.input + 7, output: PARENT_TOKENS.output + 3 });
  assert.equal(sessions[0].calls, 4);
  assert.equal(sessions[0].subagents, 1);
});

test("a spawned subagent (Codex 0.145) whose copy opens with a token_count of a total alone: the copy still counts once", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(rollout(home, PARENT), parentLines());
  // The copy opens on the parent's compacted history: a token_count whose last usage is only a total_tokens, no request.
  const opening = tokens({ ...openaiUsage(0, 0, 0), total_tokens: 999 }, openaiUsage(1, 0, 0), 21);
  await writeJsonl(rollout(home, CHILD), [meta(CHILD, 20, { forked_from_id: PARENT, ...spawned(PARENT) }), { type: "compacted", timestamp: at(21), payload: { message: "" } }, opening, ...replayed(), ...ownTurn()]);
  const sessions = await parseHome(home, { sources: ["codex"] });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].calls, 4);
  assert.deepEqual(sessions[0].tokens, { ...PARENT_TOKENS, input: PARENT_TOKENS.input + 7, output: PARENT_TOKENS.output + 3 });
});

test("a fork of a parent that compacted copies only the history kept: that suffix counts once", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(rollout(home, PARENT), parentLines());
  await writeJsonl(rollout(home, FORK), [meta(FORK, 20, { forked_from_id: PARENT }), ...replayed(1), ...ownTurn()]);
  const fork = (await parseHome(home, { sources: ["codex"] })).find((line) => line.id === FORK);
  assert.deepEqual(fork.tokens, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  assert.equal(fork.calls, 1);
});

test("only the parent's history from before the fork is matched; usage that is no copy of it is the fork's own", async (t) => {
  const home = await tempHome(t);
  // The parent went on after the fork: its third request is after the fork's time, so no copy of it.
  await writeJsonl(rollout(home, PARENT), [meta(PARENT, 0), ...USES.flatMap((use, k) => turn(k + 1, use, TOTALS[k], k === 2 ? 40 : 1 + k * 4))]);
  await writeJsonl(rollout(home, FORK), [meta(FORK, 20, { forked_from_id: PARENT }), ...replayed().slice(0, 8), ...turn(3, USES[2], TOTALS[2], 30)]);
  const fork = (await parseHome(home, { sources: ["codex"] })).find((line) => line.id === FORK);
  assert.equal(fork.calls, 1, "the third request's usage is the fork's own: the parent wrote its own later");
  assert.deepEqual(fork.tokens, { input: 50, output: 30, cacheRead: 250, cacheWrite: 0, cacheWrite1h: 0 });
});

test("a fork whose parent's rollout is not under the home counts its usage, as there is nothing to match it against", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(rollout(home, FORK), [meta(FORK, 20, { forked_from_id: PARENT }), ...replayed(), ...ownTurn()]);
  const [fork] = await parseHome(home, { sources: ["codex"] });
  assert.equal(fork.calls, 4);
});

test("a fork that copies its parent's session_meta after its own keeps its own id (Codex 0.154)", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(rollout(home, PARENT), parentLines());
  await writeJsonl(rollout(home, CHILD), [meta(CHILD, 20, { forked_from_id: PARENT, ...spawned(PARENT) }), meta(PARENT, 20), ...ownTurn()]);
  await writeJsonl(rollout(home, FORK), [meta(FORK, 21, { forked_from_id: PARENT }), meta(PARENT, 21, { cwd: "/work/elsewhere" }), ...ownTurn(31)]);
  const child = await readSession(rollout(home, CHILD), "codex");
  assert.deepEqual([child.id, child.child, child.parent], [CHILD, true, PARENT]);
  const fork = await readSession(rollout(home, FORK), "codex");
  assert.deepEqual([fork.id, fork.child, fork.cwd], [FORK, false, "/work/fixture"]);
  // So a user fork is a session of its own, not a part of its parent's.
  const ids = (await parseHome(home, { sources: ["codex"] })).map((line) => line.id).sort();
  assert.deepEqual(ids, [PARENT, FORK]);
});

test("a fork whose parent is in archived_sessions counts its usage: the import reads no rollout there, so nothing else counts it", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(join(home, ".codex", "archived_sessions", `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`), parentLines());
  await writeJsonl(rollout(home, FORK), [meta(FORK, 20, { forked_from_id: PARENT }), ...replayed(), ...ownTurn()]);
  const [fork] = await parseHome(home, { sources: ["codex"] });
  assert.equal(fork.id, FORK);
  assert.equal(fork.calls, 4);
});

test("a fork read while its copy is still being written: the next read finds the whole copy, as a read of the whole file does", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(rollout(home, PARENT), parentLines());
  const lines = [meta(FORK, 20, { forked_from_id: PARENT }), ...replayed(), ...ownTurn()];
  const file = await writeJsonl(rollout(home, FORK), lines.slice(0, 5));
  const first = await READERS.codex.read({ file });
  await appendFile(file, jsonl(lines.slice(5)));
  const next = await READERS.codex.read({ file }, first.cursor);
  const whole = await READERS.codex.read({ file });
  assert.equal(whole.sessions[0].requests.length, 1, "the fork's own request alone");
  assert.equal(next.sessions[0].requests.length, whole.sessions[0].requests.length);
  assert.deepEqual(next.sessions[0].session.tokens ?? null, whole.sessions[0].session.tokens ?? null);
});

test("forks whose parent is in no sessions directory walk the sessions tree once per import, not once each", async (t) => {
  const home = await tempHome(t);
  const sessions = join(home, ".codex", "sessions");
  // A parent that is not UUIDv7 has no day to look in first: its forks go straight to the walk, which finds nothing.
  const gone = "4b1d0c2e-1f3a-4c5d-8e6f-00000000000d";
  const fork = (id) => [meta(id, 20, { forked_from_id: gone }), ...replayed(), ...ownTurn()];
  const fs = createRequire(import.meta.url)("node:fs/promises");
  const walks = async (forks) => {
    await writeJsonl(rollout(home, FORK), fork(FORK));
    if (forks === 2) await writeJsonl(rollout(home, CHILD.replace(/c$/, "e")), fork(CHILD.replace(/c$/, "e")));
    const readdir = t.mock.method(fs, "readdir");
    syncBuiltinESMExports();
    try {
      const lines = await parseHome(home, { sources: ["codex"] });
      assert.deepEqual(lines.map((line) => line.calls), Array(forks).fill(4), "nothing to match: each fork counts its usage");
      return readdir.mock.calls.filter((call) => call.arguments[0] === sessions).length;
    } finally {
      readdir.mock.restore();
      syncBuiltinESMExports();
    }
  };
  const one = await walks(1);
  assert.equal(await walks(2), one, "a second fork of the same missing parent lists the sessions directory no more");
});
