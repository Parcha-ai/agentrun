// OpenCode in a home's totals: each database session keyed by `relpath#id`, a subagent's session (and its cost) under
// its parent, a cursor that skips an unchanged session, and a claude-agent request counted once when the Claude Code
// session it mirrors is in the same import.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseHome, READERS } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, tempHome, writeJsonl } from "./fixtures.mjs";
import { buildLegacy, buildV1, buildV2, T0, v1Fork } from "./fixtures/opencode/fixture.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const DATA = ".local/share/opencode";
const tokens = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, cacheWrite1h: 0 });
const byId = (lines) => Object.fromEntries(lines.map((line) => [line.id, line]));

/** A home with a 2.x database and, beside it, the JSON storage of the sessions it never moved (ses_A, ses_B). */
async function openCodeHome(t) {
  const home = await tempHome(t);
  await buildV2(join(home, DATA, "opencode.db"));
  await buildLegacy(join(home, DATA, "storage"));
  return home;
}

test("a home's OpenCode sessions: a db session keyed by relpath#id, a storage one by its file, a subagent's usage and cost its parent's", async (t) => {
  const home = await openCodeHome(t);
  const lines = await parseHome(home, { sources: ["opencode"], catalog: false, env: {} });
  const by = byId(lines);
  assert.deepEqual(Object.keys(by).sort(), ["ses_A", "ses_C", "ses_D", "ses_F", "ses_K"]);
  assert.equal(by.ses_C.key, sha(`${DATA}/opencode.db#ses_C`));
  assert.equal(by.ses_C.file, `${DATA}/opencode.db`);
  assert.equal(by.ses_A.key, sha(`${DATA}/storage/session/prj_fixture/ses_A.json`));
  // ses_C: three requests (the compaction's one of them); its 1.x copy counts nothing.
  assert.deepEqual([by.ses_C.tokens, by.ses_C.reasoning, by.ses_C.cost, by.ses_C.turns, by.ses_C.calls], [tokens(255, 144, 2070, 20), 4, 0.875, 2, 3]);
  assert.deepEqual([by.ses_D.tokens, by.ses_D.cost, by.ses_D.turns, by.ses_D.calls], [tokens(7, 3), 0, 1, 1]);
  // The fork's three copied rows count nothing: its own request alone.
  assert.deepEqual([by.ses_F.tokens, by.ses_F.cost, by.ses_F.turns, by.ses_F.calls], [tokens(1, 1), 0.03125, 0, 1]);
  // No Claude Code session in the import: every claude-agent request counts.
  assert.deepEqual([by.ses_K.tokens, by.ses_K.cost, by.ses_K.turns, by.ses_K.calls], [tokens(18, 5), 0.9375, 1, 4]);
  // ses_A 230/370/1100/200 at 0.875 (reasoning 5 + 10 + 200; the storage's OpenCode, 0.15.0, wrote prt_A2d's output
  // with its reasoning in it), its subagent ses_B 10/5 at 0.0625: one line, both costs.
  assert.equal(by.ses_A.reasoning, 215);
  assert.deepEqual([by.ses_A.tokens, by.ses_A.cost, by.ses_A.turns, by.ses_A.calls, by.ses_A.subagents], [tokens(240, 375, 1100, 200), 0.9375, 2, 4, 1]);
  assert.deepEqual(lines.map((line) => line.key), lines.map((line) => line.key).sort());
});

/** Claude Code's own transcript of claude-session-1, which OpenCode's ses_K ran two requests in. */
async function claudeSession(home) {
  const session = "claude-session-1";
  await writeJsonl(claudeFile(home, session), [
    claudeUser({ uuid: "u1", text: "Fixture prompt.", i: 0, session }),
    claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(3, 2), i: 1, session }),
    claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(4, 1), i: 2, session }),
  ]);
}

test("a claude-agent request whose Claude Code session the same import reads is counted there, once, request by request", async (t) => {
  const home = await openCodeHome(t);
  await claudeSession(home);
  const by = byId(await parseHome(home, { sources: ["claude-code", "opencode"], catalog: false, env: {} }));
  assert.deepEqual([by["claude-session-1"].tokens, by["claude-session-1"].calls], [tokens(7, 3), 2]);
  // K2 and K3 ran in claude-session-1: Claude Code's. K4 names claude-session-2, which no file holds, and K5 ran on
  // another provider: OpenCode's. 5 + 6 in, 1 + 1 out, 0.125 + 0.0625.
  assert.deepEqual([by.ses_K.tokens, by.ses_K.cost, by.ses_K.turns, by.ses_K.calls], [tokens(11, 2), 0.1875, 1, 2]);
  // Every other OpenCode session is as it was.
  assert.deepEqual([by.ses_C.tokens, by.ses_C.cost], [tokens(255, 144, 2070, 20), 0.875]);
  // With Claude Code not read, the request is OpenCode's alone, and counts there.
  const alone = byId(await parseHome(home, { sources: ["opencode"], catalog: false, env: {} }));
  assert.deepEqual([alone.ses_K.tokens, alone.ses_K.cost, alone.ses_K.calls], [tokens(18, 5), 0.9375, 4]);
});

test("the mirrored request counts once whatever the sources' order, and a requests sink takes OpenCode's own requests alone", async (t) => {
  const home = await openCodeHome(t);
  await claudeSession(home);
  const first = await parseHome(home, { sources: ["claude-code", "opencode"], catalog: false, env: {} });
  // OpenCode read before Claude Code: its totals wait for every source, so K2 and K3 are still Claude Code's.
  assert.deepEqual(await parseHome(home, { sources: ["opencode", "claude-code"], catalog: false, env: {} }), first);
  // With a sink every part keeps its requests to the totals (Unpriced): the same totals, and ses_K's own two, K4 and K5.
  const sunk = new Map();
  const lines = await parseHome(home, { sources: ["opencode", "claude-code"], catalog: false, env: {}, requests: (totals, requests) => sunk.set(totals.id, requests) });
  assert.deepEqual(lines, first);
  assert.deepEqual(sunk.get("ses_K").map(({ usage }) => [usage.input, usage.output]), [[5, 1], [6, 1]]);
  assert.equal(sunk.get("claude-session-1").length, 2);
});

test("a cursor: an unchanged session is not read again, a changed one is, and a replaced database is read from its start", async (t) => {
  const home = await openCodeHome(t);
  const db = join(home, DATA, "opencode.db");
  const reader = READERS.opencode;
  const locator = { file: db, id: "ses_C" };
  const first = await reader.read(locator, undefined, { turns: false });
  assert.equal(first.resumed, false);
  assert.ok(first.read > 0);
  const again = await reader.read(locator, first.cursor, { turns: false });
  assert.deepEqual([again.resumed, again.read], [true, 0]);
  // Resumed from a turns: false cursor: the same counts and ids, no prompt, title or working directory (the cursor keeps
  // none).
  const { firstPrompt: _p, titleText: _t, sourceTitle: _s, cwd: _c, ...rest } = first.sessions[0].session;
  assert.deepEqual(again.sessions, [{ ...first.sessions[0], session: rest }]);
  // A cursor of a read that kept turns is no place for one that keeps none to go on from.
  const kept = await reader.read(locator, (await reader.read(locator)).cursor, { turns: false });
  assert.equal(kept.resumed, false);

  const d = await reader.read({ file: db, id: "ses_D" }, undefined, { turns: false });
  // OpenCode writes a new request into ses_C: read again, the new request with the rest.
  const write = new DatabaseSync(db);
  const C = T0 + 100_000;
  write
    .prepare("INSERT INTO session_message VALUES ('msg_C8', 'ses_C', 'assistant', 8, ?, ?, ?)")
    .run(C + 12_000, C + 12_000, JSON.stringify({ model: { id: "claude-opus-4-5", providerID: "anthropic" }, cost: 0.0625, tokens: { input: 9, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: C + 12_000 }, content: [] }));
  write.prepare("UPDATE session_v2 SET time_updated = ? WHERE id = 'ses_C'").run(C + 12_000);
  write.close();
  const changed = await reader.read(locator, again.cursor, { turns: false });
  assert.equal(changed.resumed, true);
  assert.ok(changed.read > 0);
  assert.deepEqual([changed.sessions[0].requests.length, changed.sessions[0].session.costUsd], [4, 0.9375]);
  // Another session of the database, read before the write, is as it was: not read again.
  assert.deepEqual((await reader.read({ file: db, id: "ses_D" }, d.cursor, { turns: false })).read, 0);

  // A database replaced (a new file under the name): read from its start.
  await buildV2(join(home, "fresh.db"));
  await rename(join(home, "fresh.db"), db);
  const replaced = await reader.read(locator, changed.cursor, { turns: false });
  assert.deepEqual([replaced.resumed, replaced.sessions[0].requests.length], [false, 3]);
});

test("parseHome's state: a second pass over an unchanged OpenCode home reads nothing, and totals the same", async (t) => {
  const home = await openCodeHome(t);
  const state = {};
  const first = await parseHome(home, { sources: ["opencode"], catalog: false, env: {}, state });
  assert.ok(state.read > 0);
  const second = await parseHome(home, { sources: ["opencode"], catalog: false, env: {}, state });
  assert.equal(state.read, 0);
  assert.deepEqual(second, first);
});

test("a 1.x fork in a home's totals: its 30 copied requests count in its source alone, 40 there and its own 2 here; a pass over the fork changed since totals as a fresh one", async (t) => {
  const home = await tempHome(t);
  const file = join(home, DATA, "opencode.db");
  await buildV1(file, v1Fork());
  const state = {};
  const by = byId(await parseHome(home, { sources: ["opencode"], catalog: false, env: {}, state }));
  assert.deepEqual([by.ses_S.tokens, by.ses_S.calls, by.ses_S.cost, by.ses_S.turns], [tokens(820, 40), 40, 2.5, 1]);
  assert.deepEqual([by.ses_F.tokens, by.ses_F.calls, by.ses_F.cost, by.ses_F.turns], [tokens(300, 4), 2, 0.5, 1]);
  // The fork goes on: one more request of its own (input 400, output 1 + 1 reasoning, 0.125).
  const db = new DatabaseSync(file);
  const created = T0 + 240_000;
  const info = { role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-5", path: { cwd: "/fixture/fork", root: "/fixture/fork" }, time: { created }, cost: 0.125, tokens: { input: 400, output: 1, reasoning: 1, cache: { read: 0, write: 0 } } };
  db.prepare("INSERT INTO message VALUES ('msg_F92', 'ses_F', ?, ?, ?)").run(created, created, JSON.stringify(info));
  db.prepare("UPDATE session SET time_updated = ? WHERE id = 'ses_F'").run(created);
  db.close();
  // Read again whole from its cursor, its own requests are its own, not copies of what its last read added.
  const again = await parseHome(home, { sources: ["opencode"], catalog: false, env: {}, state });
  assert.deepEqual(again, await parseHome(home, { sources: ["opencode"], catalog: false, env: {} }));
  assert.deepEqual([byId(again).ses_F.tokens, byId(again).ses_F.calls, byId(again).ses_F.cost], [tokens(700, 6), 3, 0.625]);
});
