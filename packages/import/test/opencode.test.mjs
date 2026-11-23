// The OpenCode reader: one locator per session ({ file: <db>, id } for a database's, the session's JSON file for the
// storage OpenCode kept before SQLite), each read into the one Session shape. A locator with no id reads every session
// of its database.
import assert from "node:assert/strict";
import { readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { locatorSize, READERS, readSession } from "../dist/index.js";
import { openCodeFiles } from "../dist/readers/opencode.js";
import { tempHome } from "./fixtures.mjs";
import { buildLegacy, buildV1, buildV2, T0, V2_MESSAGES, V2_PARTS } from "./fixtures/opencode/fixture.mjs";

const reader = READERS.opencode;
const read = async (locator, options) => (await reader.read(locator, undefined, options)).sessions.map(({ session }) => session);
const at = (ms) => new Date(T0 + ms).toISOString();
const byId = (sessions) => Object.fromEntries(sessions.map((session) => [session.id, session]));
/** The sum of a session's requests' tokens. */
const total = ({ turns }) =>
  turns.reduce(
    (sum, turn) => {
      if (turn.role !== "assistant" || !turn.usage) return sum;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) sum[key] += turn.usage[key];
      return sum;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
const said = ({ turns }) => turns.map((turn) => [turn.role, turn.role === "toolResult" ? `${turn.callId}:${turn.text}:${turn.isError}` : turn.text]);

test("the reader is registered as opencode, run by serve's opencode harness", () => {
  assert.deepEqual([reader.source, reader.name, reader.harness], ["opencode", "OpenCode", "opencode"]);
});

// ses_A and ses_B as the 1.x database and the JSON storage both hold them: one reading, wherever it was kept.
function assertV1(sessions, fileOf) {
  const { ses_A: a, ses_B: b, ...rest } = byId(sessions);
  assert.deepEqual(Object.keys(rest), []);
  assert.deepEqual(
    { ...a, turns: undefined },
    {
      source: "opencode", id: "ses_A", file: fileOf("ses_A"), cwd: "/fixture/project", model: "openai/gpt-5",
      startedAt: at(1000), endedAt: at(30_000), state: "completed", costUsd: 0.875,
      firstPrompt: "Fix the parser please.", titleText: "Fix the parser please.", sourceTitle: "Fix the parser",
      child: false, turns: undefined, users: 2, activeMs: 29_000, copies: 0, effort: "high",
    },
  );
  assert.deepEqual(said(a), [
    ["user", "Fix the parser please."],
    ["assistant", "Reading the file."],
    ["toolResult", "call_1:export const a = 1;:false"],
    ["assistant", "Fixed."],
    ["toolResult", "call_2:exit 1:true"],
    ["user", "Now add a test."],
    ["assistant", "Added."],
  ]);
  const [, first, , second, , , third] = a.turns;
  assert.deepEqual(first.calls, [{ type: "toolCall", id: "call_1", name: "read", arguments: { filePath: "/fixture/project/a.ts" } }]);
  assert.deepEqual([first.model, first.effort, first.costUsd, first.at], ["anthropic/claude-sonnet-4-5", "high", 0.25, T0 + 2000]);
  // Each step its own usage: the message's tokens are only its last step's. Output holds the reasoning, kept beside it.
  assert.deepEqual(first.usage, { input: 100, output: 25, cacheRead: 0, cacheWrite: 200, reasoning: 5 });
  assert.deepEqual(second.usage, { input: 30, output: 50, cacheRead: 500, cacheWrite: 0, reasoning: 10 });
  assert.equal(second.calls[0].name, "bash");
  // An older message whose output holds its reasoning, as its total says.
  assert.deepEqual([third.model, third.effort, third.usage], ["openai/gpt-5", undefined, { input: 100, output: 300, cacheRead: 600, cacheWrite: 0, reasoning: 200 }]);
  assert.deepEqual(total(a), { input: 230, output: 375, cacheRead: 1100, cacheWrite: 200 });
  assert.equal(a.turns[2].name, "read");

  assert.deepEqual([b.child, b.parent, b.sourceTitle, b.costUsd, b.firstPrompt, b.model], [true, "ses_A", undefined, 0.0625, "Find the tests.", "anthropic/claude-haiku-4-5"]);
  assert.deepEqual(total(b), { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
}

test("a 1.x opencode.db: each step a request with its own usage, a subagent's session under its parent, malformed rows passed over", async (t) => {
  const db = join(await tempHome(t), "opencode.db");
  await buildV1(db);
  assertV1(await read({ file: db }), () => db);
  // One session by its id, as the import reads it.
  const [one] = (await reader.read({ file: db, id: "ses_B" })).sessions;
  assert.deepEqual([one.locator, one.session.id, one.requests.length], [{ file: db, id: "ses_B" }, "ses_B", 1]);
});

test("the JSON storage OpenCode kept before SQLite reads as its database does, a session's file its locator", async (t) => {
  const storage = join(await tempHome(t), "storage");
  await buildLegacy(storage);
  const fileOf = (id) => join(storage, "session", "prj_fixture", `${id}.json`);
  const sessions = [];
  for (const id of ["ses_A", "ses_B"]) {
    const [one] = (await reader.read({ file: fileOf(id) })).sessions;
    assert.deepEqual(one.locator, { file: fileOf(id) });
    sessions.push(one.session);
  }
  assertV1(sessions, fileOf);
});

test("a 2.x opencode.db: its own tables first, 1.x history not yet moved, a fork's copied rows counted once", async (t) => {
  const db = join(await tempHome(t), "opencode.db");
  await buildV2(db);
  const { ses_C: c, ses_D: d, ses_F: f, ses_K: _k, ...rest } = byId(await read({ file: db }));
  assert.deepEqual(Object.keys(rest), []);
  assert.deepEqual(
    { ...c, turns: undefined },
    {
      source: "opencode", id: "ses_C", file: db, cwd: "/fixture/v2", model: "anthropic/claude-opus-4-5",
      startedAt: at(100_500), endedAt: at(111_000), state: "stopped", costUsd: 0.875,
      firstPrompt: "Port the reader to v2.", titleText: "Port the reader to v2.", sourceTitle: "Port the reader",
      child: false, turns: undefined, users: 2, activeMs: 10_500, copies: 0, effort: "max",
    },
  );
  assert.deepEqual(said(c), [
    ["user", "Port the reader to v2."],
    ["assistant", "Looking."],
    ["toolResult", "call_v2a:const x = 1;:false"],
    ["assistant", "Done porting."],
    ["toolResult", "call_v2b:exit 1:true"],
    ["assistant", "Ported the reader."],
    ["user", "Stop."],
  ]);
  assert.deepEqual(c.turns[1].calls, [{ type: "toolCall", id: "call_v2a", name: "read", arguments: { filePath: "x.ts" } }]);
  assert.deepEqual(c.turns.filter((turn) => turn.role === "assistant").map((turn) => [turn.usage, turn.costUsd]), [
    [{ input: 50, output: 14, cacheRead: 1000, cacheWrite: 20, reasoning: 4 }, 0.5],
    [{ input: 5, output: 30, cacheRead: 1070, cacheWrite: 0, reasoning: 0 }, 0.25],
    [{ input: 200, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, 0.125],
  ]);
  assert.deepEqual(total(c), { input: 255, output: 144, cacheRead: 2070, cacheWrite: 20 });
  // Read by its id, ses_C is the 2.x session, never the 1.x copy the migration left (999 999 tokens).
  assert.deepEqual(total(await readSession({ file: db, id: "ses_C" }, "opencode")), total(c));

  assert.deepEqual([d.model, d.cwd, d.costUsd, total(d)], ["openai/gpt-5", "/fixture/old", 0, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }]);
  assert.deepEqual([f.copies, f.users, f.costUsd, said(f), total(f)], [3, 0, 0.03125, [["assistant", "Forked."]], { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }]);
});

test("a claude-agent request names the Claude Code session that also holds it; the session, each one it names", async (t) => {
  const db = join(await tempHome(t), "opencode.db");
  await buildV2(db);
  const one = { source: "claude-code", sessionId: "claude-session-1" };
  const two = { source: "claude-code", sessionId: "claude-session-2" };
  const k = await readSession({ file: db, id: "ses_K" }, "opencode");
  assert.deepEqual(k.turns.map((turn) => [turn.role, turn.text, turn.mirrors]), [
    ["user", "Use Claude here.", undefined],
    ["assistant", "On it.", one],
    ["assistant", "Still on it.", one],
    ["assistant", "Forked over.", two],
    ["assistant", "Back on Opus.", undefined],
  ]);
  assert.deepEqual(k.mirrors, [one, two]);
  // A listing names them too, and its requests carry their mirrors, for a total to set the copies aside.
  const [listed] = (await reader.read({ file: db, id: "ses_K" }, undefined, { turns: false })).sessions;
  assert.deepEqual(listed.session.mirrors, [one, two]);
  assert.deepEqual(listed.requests.map((request) => request.mirrors), [one, one, two, undefined]);
  assert.equal((await readSession({ file: db, id: "ses_C" }, "opencode")).mirrors, undefined);
});

test("a listing reads the same sessions without their turns, and its requests are every request", async (t) => {
  const db = join(await tempHome(t), "opencode.db");
  await buildV2(db);
  const full = await read({ file: db });
  // The effort most requests ran at is read from the turns: none in a listing, as with the other sources.
  assert.deepEqual(await read({ file: db }, { turns: false }), full.map(({ effort: _effort, ...session }) => ({ ...session, turns: [] })));
  const listed = (await reader.read({ file: db }, undefined, { turns: false })).sessions;
  assert.deepEqual(
    listed.map(({ session, requests }) => [session.id, requests.length]),
    full.map((session) => [session.id, session.turns.filter((turn) => turn.role === "assistant").length]),
  );
});

test("OpenCode's files under a home: its databases and its JSON storage, never a link nor a database's WAL", async (t) => {
  const home = await tempHome(t);
  const data = join(home, ".local", "share", "opencode");
  await buildV1(join(data, "opencode.db"));
  await buildLegacy(join(data, "storage"));
  await writeFile(join(data, "opencode-beta.db"), "");
  await writeFile(join(data, "opencode.db-wal"), "");
  await symlink(join(data, "opencode.db"), join(data, "opencode-linked.db"));
  assert.deepEqual(await openCodeFiles(home, {}), { dbs: [join(data, "opencode-beta.db"), join(data, "opencode.db")], storage: join(data, "storage") });
  // No env is no env: the home's own folder.
  assert.deepEqual(await openCodeFiles(home), await openCodeFiles(home, {}));
  // $XDG_DATA_HOME/opencode is OpenCode's data folder when it is set.
  const xdg = join(home, "xdg");
  await buildV1(join(xdg, "opencode", "opencode.db"));
  assert.deepEqual(await openCodeFiles(home, { XDG_DATA_HOME: xdg }), { dbs: [join(xdg, "opencode", "opencode.db")] });
  assert.deepEqual(await openCodeFiles(join(home, "nobody"), {}), { dbs: [] });
  // OPENCODE_DB names the database OpenCode opens: a path as given, a relative one under the data folder. The databases
  // it wrote before it was set are still the person's.
  const own = join(home, "work", "mine.sqlite");
  await buildV1(own);
  assert.deepEqual((await openCodeFiles(home, { OPENCODE_DB: own })).dbs, [own, join(data, "opencode-beta.db"), join(data, "opencode.db")]);
  await buildV1(join(data, "nested", "named.db"));
  assert.deepEqual((await openCodeFiles(home, { OPENCODE_DB: "nested/named.db" })).dbs, [join(data, "nested", "named.db"), join(data, "opencode-beta.db"), join(data, "opencode.db")]);
  // Named twice (the default's own name), :memory:, a missing file or a link: nothing more.
  for (const name of ["opencode.db", ":memory:", "", join(home, "missing.db"), join(data, "opencode-linked.db")])
    assert.deepEqual((await openCodeFiles(home, { OPENCODE_DB: name })).dbs, [join(data, "opencode-beta.db"), join(data, "opencode.db")], name);

  // One locator per session. A session both in the database and in the storage it was moved from is the database's,
  // once; an empty database has none; a session two databases hold is the first's (OPENCODE_DB's).
  const db = join(data, "opencode.db");
  assert.deepEqual(await reader.discover(home, {}), [{ file: db, id: "ses_A" }, { file: db, id: "ses_B" }]);
  assert.deepEqual(await reader.discover(home, { OPENCODE_DB: own }), [{ file: own, id: "ses_A" }, { file: own, id: "ses_B" }]);
});

test("discover: the storage's sessions no database holds are their own files'; a database that cannot be read is passed over", async (t) => {
  const home = await tempHome(t);
  const data = join(home, ".local", "share", "opencode");
  await buildLegacy(join(data, "storage"));
  await writeFile(join(data, "opencode.db"), "not a database, not even close to one");
  const fileOf = (id) => join(data, "storage", "session", "prj_fixture", `${id}.json`);
  assert.deepEqual(await reader.discover(home, {}), [{ file: fileOf("ses_A") }, { file: fileOf("ses_B") }]);
});

test("a database session's size and last write are its own rows', not its database's; a storage session's, its files' together", async (t) => {
  const dir = await tempHome(t);
  const db = join(dir, "opencode.db");
  await buildV2(db);
  // ses_C's 2.x rows: each message's and part's data as written, and its session row updated last, at C + 11 s.
  const data = [...V2_MESSAGES.map(([, , d]) => (typeof d === "string" ? d : JSON.stringify(d))), ...V2_PARTS.map(([, , , , d]) => JSON.stringify(d))];
  const c = await locatorSize({ file: db, id: "ses_C" }, "opencode");
  assert.deepEqual(c, { bytes: data.reduce((n, d) => n + Buffer.byteLength(d), 0), mtimeMs: T0 + 111_000 }, "its 2.x rows, never its 1.x copy");
  // ses_D, 1.x history not yet moved: its 1.x rows, its session row updated last.
  const d = await locatorSize({ file: db, id: "ses_D" }, "opencode");
  assert.equal(d.mtimeMs, T0 + 52_000);
  assert.ok(d.bytes > 0 && c.bytes + d.bytes < (await stat(db)).size, "each less than the database");
  assert.equal(await locatorSize({ file: db, id: "ses_none" }, "opencode"), null, "a session not there");
  assert.deepEqual(await locatorSize({ file: db }, "opencode"), { bytes: (await stat(db)).size, mtimeMs: (await stat(db)).mtimeMs }, "a database without an id: its file's");
  const storage = join(dir, "storage");
  await buildLegacy(storage);
  const files = [join(storage, "session", "prj_fixture", "ses_A.json")];
  for (const message of await readdir(join(storage, "message", "ses_A"))) {
    files.push(join(storage, "message", "ses_A", message));
    for (const part of await readdir(join(storage, "part", message.replace(/\.json$/, ""))).catch(() => [])) files.push(join(storage, "part", message.replace(/\.json$/, ""), part));
  }
  const stats = await Promise.all(files.map((file) => stat(file)));
  assert.deepEqual(await locatorSize({ file: files[0] }, "opencode"), { bytes: stats.reduce((n, s) => n + s.size, 0), mtimeMs: Math.max(...stats.map((s) => s.mtimeMs)) });
});
