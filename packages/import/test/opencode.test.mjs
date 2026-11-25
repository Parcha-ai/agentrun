// The OpenCode reader: one locator per session ({ file: <db>, id } for a database's, the session's JSON file for the
// storage OpenCode kept before SQLite), each read into the one Session shape. A locator with no id reads every session
// of its database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdir, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { locatorSize, READERS, readSession } from "../dist/index.js";
import { openCodeFiles, withDb } from "../dist/readers/opencode.js";
import { tempHome } from "./fixtures.mjs";
import { buildLegacy, buildV1, buildV2, T0, V2_MESSAGES, V2_PARTS, v1Fork } from "./fixtures/opencode/fixture.mjs";

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

// ses_A and ses_B as the 1.x database and the JSON storage both hold them: one reading, wherever it was kept, but for
// prt_A2d's output, which records no total: the storage's OpenCode (0.15.0, `old`) wrote it with its reasoning in it.
function assertV1(sessions, fileOf, { old = false } = {}) {
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
  assert.deepEqual(first.usage, { input: 100, output: old ? 20 : 25, cacheRead: 0, cacheWrite: 200, reasoning: 5 });
  assert.deepEqual(second.usage, { input: 30, output: 50, cacheRead: 500, cacheWrite: 0, reasoning: 10 });
  assert.equal(second.calls[0].name, "bash");
  // An older message whose output holds its reasoning, as its total says.
  assert.deepEqual([third.model, third.effort, third.usage], ["openai/gpt-5", undefined, { input: 100, output: 300, cacheRead: 600, cacheWrite: 0, reasoning: 200 }]);
  assert.deepEqual(total(a), { input: 230, output: old ? 370 : 375, cacheRead: 1100, cacheWrite: 200 });
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
  assertV1(sessions, fileOf, { old: true });
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

test("a 1.x fork's copies (new ids, the same times, model, tokens and cost) count once, in the session read first; its own prompt and requests count", async (t) => {
  const db = join(await tempHome(t), "opencode.db");
  await buildV1(db, v1Fork());
  const { ses_S: source, ses_F: fork } = byId(await read({ file: db }));
  assert.deepEqual([source.turns.filter((turn) => turn.role === "assistant").length, total(source), source.costUsd, source.copies], [40, { input: 820, output: 40, cacheRead: 0, cacheWrite: 0 }, 2.5, 0]);
  // The copied prompt and 15 messages (30 requests) are copies: the fork's own prompt and 2 requests are all it holds.
  assert.deepEqual([fork.copies, fork.users, fork.costUsd, total(fork)], [16, 1, 0.5, { input: 300, output: 4, cacheRead: 0, cacheWrite: 0 }]);
  assert.deepEqual(said(fork), [["user", "Now the tests."], ["assistant", "Step msg_F91."], ["assistant", ""]]);
  assert.deepEqual([fork.firstPrompt, fork.startedAt], ["Now the tests.", at(231_000)]);
  // Each request is keyed by its fingerprint, the same in both sessions' reads: never an id the fork made anew.
  const keys = (session) => session.turns.filter((turn) => turn.role === "assistant").map((turn) => turn.key);
  assert.ok([...keys(source), ...keys(fork)].every((key) => /^o:[0-9a-f]{32}$/.test(key)));
  assert.equal(new Set([...keys(source), ...keys(fork)]).size, 42);
  // Read alone, with no other session read before it, the fork is all its own.
  const alone = await readSession({ file: db, id: "ses_F" }, "opencode");
  assert.deepEqual([alone.copies, alone.turns.filter((turn) => turn.role === "assistant").length], [0, 32]);
  // The import's `seen` carries the source's keys to a later read of the fork.
  const seen = new Set();
  await reader.read({ file: db, id: "ses_S" }, undefined, { seen });
  const [later] = (await reader.read({ file: db, id: "ses_F" }, undefined, { seen, turns: false })).sessions;
  assert.deepEqual([later.session.copies, later.requests.length], [16, 2]);
});

test("a 2.x fork that names no source (a 1.x one moved to 2.x): its copied rows count once too", async (t) => {
  const db = join(await tempHome(t), "opencode.db");
  const sqlite = new DatabaseSync(db);
  sqlite.exec(await readFile(new URL("./fixtures/opencode/schema.sql", import.meta.url), "utf8"));
  sqlite.prepare("INSERT INTO project VALUES ('prj_fixture', '/fixture/v2', ?, ?, '[]')").run(T0, T0);
  const MODEL = { id: "claude-opus-4-5", providerID: "anthropic" };
  const row = (n, input) => ({ agent: "build", model: MODEL, cost: 0.125, tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: T0 + n * 1000 }, content: [{ type: "text", text: `Answer ${n}.` }] });
  const session = sqlite.prepare("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'prj_fixture', 'fixture', '/fixture/v2', ?, '1.14.0', ?, ?)");
  const message = sqlite.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
  session.run("ses_S2", "Moved", T0, T0 + 5000);
  const rows = [["user", { text: "Go.", time: { created: T0 } }], ["assistant", row(1, 10)], ["assistant", row(2, 20)], ["assistant", row(3, 30)]];
  rows.forEach(([type, data], seq) => message.run(`msg_S2_${seq}`, "ses_S2", type, seq, T0, T0, JSON.stringify(data)));
  // The fork: the first three rows under new ids, then one of its own; no fork_session_id, no fork_boundary.
  session.run("ses_F2", "Moved (fork #1)", T0 + 10_000, T0 + 12_000);
  rows.slice(0, 3).forEach(([type, data], seq) => message.run(`msg_F2_${seq}`, "ses_F2", type, seq, T0 + 10_000, T0 + 10_000, JSON.stringify(data)));
  message.run("msg_F2_9", "ses_F2", "assistant", 3, T0 + 11_000, T0 + 11_000, JSON.stringify(row(11, 99)));
  sqlite.close();
  const { ses_S2: source, ses_F2: fork } = byId(await read({ file: db }));
  assert.deepEqual([total(source).input, source.copies], [60, 0]);
  assert.deepEqual([fork.copies, fork.users, total(fork).input, fork.costUsd], [3, 0, 99, 0.125]);
  // A prompt is keyed by its fingerprint, which serve keeps as the turn's record id, so a fork read later is told too.
  assert.match(source.turns.find((turn) => turn.role === "user")?.uuids?.[0] ?? "", /^o:[0-9a-f]{32}$/);
});

test("a session's OpenCode version says how its output reads where no total does: before 1.3.16 it holds the reasoning", async (t) => {
  const db = join(await tempHome(t), "opencode.db");
  const tokens = { input: 10, output: 20, reasoning: 5, cache: { read: 0, write: 0 } };
  const session = (id, version, at) => ({
    session: { id, directory: "/fixture/v", title: id, version, time: { created: at, updated: at + 2000 } },
    messages: [{ info: { id: `${id}_m`, role: "assistant", providerID: "openai", modelID: "gpt-5", path: { cwd: "/fixture/v", root: "/fixture/v" }, time: { created: at + 1000 }, cost: 0.5, tokens }, parts: [] }],
  });
  await buildV1(db, [session("ses_old", "1.3.15", T0), session("ses_new", "1.3.16", T0 + 10_000)]);
  const { ses_old: old, ses_new: now } = byId(await read({ file: db }));
  assert.deepEqual(old.turns[0].usage, { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5 });
  assert.deepEqual(now.turns[0].usage, { input: 10, output: 25, cacheRead: 0, cacheWrite: 0, reasoning: 5 });
});

test("no time past now: a row written by a clock set ahead reads as its database's last write, the same at each look, so it ages out; one past what a Date holds too", async (t) => {
  const db = join(await tempHome(t), "opencode.db");
  const ahead = Date.now() + 365 * 24 * 60 * 60_000;
  const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
  const session = (id, at) => ({
    session: { id, directory: "/fixture/t", title: id, time: { created: at, updated: at } },
    messages: [
      { info: { id: `${id}_u`, role: "user", time: { created: at } }, parts: [{ id: `${id}_p`, type: "text", text: "Go." }] },
      { info: { id: `${id}_m`, role: "assistant", providerID: "openai", modelID: "gpt-5", path: { cwd: "/fixture/t", root: "/fixture/t" }, time: { created: at, completed: at }, cost: 0, tokens }, parts: [] },
    ],
  });
  await buildV1(db, [session("ses_ahead", ahead), session("ses_far", 9e15), session("ses_past", T0)]);
  // The database untouched for 20 minutes, twice the 10 a caller's "still being written" check allows.
  const written = new Date(Math.floor((Date.now() - 20 * 60_000) / 1000) * 1000);
  await utimes(db, written, written);
  for (const look of [1, 2]) {
    const size = await locatorSize({ file: db, id: "ses_ahead" }, "opencode");
    assert.equal(size.mtimeMs, written.getTime(), `look ${look}: its last write is the database's, not now`);
  }
  assert.equal((await locatorSize({ file: db, id: "ses_past" }, "opencode")).mtimeMs, T0, "a time before now is as written");
  const { ses_ahead: a, ses_far: far } = byId(await read({ file: db }));
  for (const s of [a, far]) assert.equal(Date.parse(s.endedAt), written.getTime(), s.id);
  assert.ok(far.turns.every((turn) => turn.at === written.getTime()));
});

test("a session two databases hold (a channel's stale copy beside opencode.db's): the one written last is listed", async (t) => {
  const home = await tempHome(t);
  const data = join(home, ".local", "share", "opencode");
  const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
  const session = (updated, messages) => ({
    session: { id: "ses_X", directory: "/fixture/x", title: "Both", time: { created: T0, updated: T0 + 1000 } },
    messages: Array.from({ length: messages }, (_, i) => ({ info: { id: `msg_X${i}`, role: "assistant", providerID: "openai", modelID: "gpt-5", path: { cwd: "/fixture/x", root: "/fixture/x" }, time: { created: T0 + 1000 + i, completed: updated }, cost: 0, tokens }, parts: [] })),
  });
  // opencode-beta.db sorts before opencode.db, and holds the copy from before the session went on.
  await buildV1(join(data, "opencode-beta.db"), [session(T0 + 2000, 1)]);
  await buildV1(join(data, "opencode.db"), [session(T0 + 9000, 3)]);
  const latest = (rows) => {
    const db = new DatabaseSync(rows.file);
    db.prepare("UPDATE message SET time_updated = ?").run(rows.at);
    db.close();
  };
  latest({ file: join(data, "opencode-beta.db"), at: T0 + 2000 });
  latest({ file: join(data, "opencode.db"), at: T0 + 9000 });
  assert.deepEqual(await reader.discover(home, {}), [{ file: join(data, "opencode.db"), id: "ses_X" }]);
  // Written later in the channel's: that one.
  latest({ file: join(data, "opencode-beta.db"), at: T0 + 20_000 });
  assert.deepEqual(await reader.discover(home, {}), [{ file: join(data, "opencode-beta.db"), id: "ses_X" }]);
  // On a tie, the first: OPENCODE_DB's comes first.
  const named = join(home, "elsewhere.db");
  await buildV1(named, [session(T0 + 20_000, 1)]);
  latest({ file: named, at: T0 + 20_000 });
  assert.deepEqual(await reader.discover(home, { OPENCODE_DB: named }), [{ file: named, id: "ses_X" }]);
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

test("discover: the storage's sessions no database holds are their own files'; a database that cannot be listed is its own locator, whose read fails", async (t) => {
  const home = await tempHome(t);
  const data = join(home, ".local", "share", "opencode");
  await buildLegacy(join(data, "storage"));
  await writeFile(join(data, "opencode.db"), "not a database, not even close to one");
  const fileOf = (id) => join(data, "storage", "session", "prj_fixture", `${id}.json`);
  assert.deepEqual(await reader.discover(home, {}), [{ file: join(data, "opencode.db") }, { file: fileOf("ses_A") }, { file: fileOf("ses_B") }]);
  await assert.rejects(reader.read({ file: join(data, "opencode.db") }), "never read as an empty database, nor as storage");
});

test("a database session's size and last write are its own rows', not its database's; a storage session's, its files' together", async (t) => {
  const dir = await tempHome(t);
  const db = join(dir, "opencode.db");
  await buildV2(db);
  // ses_C's 2.x rows: each message's and part's data as written, and its session row updated last, at C + 11 s.
  const data = [...V2_MESSAGES.map(([, , d]) => (typeof d === "string" ? d : JSON.stringify(d))), ...V2_PARTS.map(([, , , , d]) => JSON.stringify(d))];
  const c = await locatorSize({ file: db, id: "ses_C" }, "opencode");
  // When it began, its row's: the import reads OpenCode's sessions oldest first.
  assert.deepEqual(c, { bytes: data.reduce((n, d) => n + Buffer.byteLength(d), 0), mtimeMs: T0 + 111_000, created: T0 + 100_000 }, "its 2.x rows, never its 1.x copy");
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
  // A subagent's names the session it ran under, its database's row's or its session file's.
  assert.equal((await locatorSize({ file: join(storage, "session", "prj_fixture", "ses_B.json") }, "opencode")).parent, "ses_A");
  const v1 = join(dir, "v1.db");
  await buildV1(v1);
  assert.deepEqual([(await locatorSize({ file: v1, id: "ses_B" }, "opencode")).parent, (await locatorSize({ file: v1, id: "ses_A" }, "opencode")).parent], ["ses_A", undefined]);
  assert.deepEqual(await locatorSize({ file: files[0] }, "opencode"), { bytes: stats.reduce((n, s) => n + s.size, 0), mtimeMs: Math.max(...stats.map((s) => s.mtimeMs)), created: T0 });
});

/** A folder's entries, each with its size and a hash of what it holds: what a read must leave as it was. */
const listing = async (dir) => Promise.all((await readdir(dir)).sort().map(async (name) => [name, (await stat(join(dir, name))).size, createHash("sha256").update(await readFile(join(dir, name)).catch(() => "")).digest("hex")]));

test("discover, stat and read leave OpenCode's folder as it was: a WAL database OpenCode has closed (no -wal, no -shm) gets none from a read", async (t) => {
  const home = await tempHome(t);
  const data = join(home, ".local", "share", "opencode");
  const db = join(data, "opencode.db");
  await buildV2(db);
  const own = new DatabaseSync(db);
  own.exec("PRAGMA journal_mode = WAL");
  own.close();
  const before = await listing(data);
  assert.deepEqual(before.map(([name]) => name), ["opencode.db"], "OpenCode closed: no -wal, no -shm");
  const locators = await reader.discover(home, {});
  assert.ok(locators.length > 0);
  for (const locator of locators) {
    assert.ok(await locatorSize(locator, "opencode"));
    assert.ok((await reader.read(locator)).sessions.length > 0);
    await readSession(locator, "opencode", { turns: false });
  }
  assert.deepEqual(await listing(data), before, "no -wal or -shm made, the database as it was");
});

test("a WAL database OpenCode has open (its -wal there) is read as it is now: a row in the -wal not yet checkpointed is read", async (t) => {
  const home = await tempHome(t);
  const data = join(home, ".local", "share", "opencode");
  const db = join(data, "opencode.db");
  await buildV1(db);
  const open = new DatabaseSync(db);
  t.after(() => open.close());
  open.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  open.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_W', 'prj_fixture', NULL, 'fixture', '/fixture/w', 'In the WAL', '1.19.5', ?, ?)").run(T0 + 90_000, T0 + 90_000);
  assert.ok((await readdir(data)).includes("opencode.db-wal"));
  assert.deepEqual((await reader.discover(home, {})).map(({ id }) => id), ["ses_A", "ses_B", "ses_W"]);
  assert.equal((await readSession({ file: db, id: "ses_W" }, "opencode")).sourceTitle, "In the WAL");
});

test("the JSON storage is read by its own files' names, never through a link: a session whose id names another folder is passed over, a linked message folder not followed", async (t) => {
  const home = await tempHome(t);
  const storage = join(home, "storage");
  await buildLegacy(storage);
  // An id that climbs out of storage/: its messages would be read from home/outside.
  const climbing = join(storage, "session", "prj_fixture", "ses_Z.json");
  await writeFile(climbing, JSON.stringify({ id: "../../outside", directory: "/fixture/project", title: "Climb", version: "0.15.0", time: { created: T0, updated: T0 } }));
  await mkdir(join(home, "outside"), { recursive: true });
  await writeFile(join(home, "outside", "msg_Z1.json"), JSON.stringify({ id: "msg_Z1", role: "user", time: { created: T0 } }));
  await mkdir(join(storage, "part", "msg_Z1"), { recursive: true });
  await writeFile(join(storage, "part", "msg_Z1", "prt_Z1.json"), JSON.stringify({ id: "prt_Z1", type: "text", text: "Words from outside." }));
  assert.deepEqual((await reader.read({ file: climbing })).sessions, [], "an id that is no OpenCode id is passed over");
  const data = join(home, ".local", "share", "opencode");
  await mkdir(data, { recursive: true });
  await rename(storage, join(data, "storage"));
  const moved = join(data, "storage");
  assert.ok(!(await reader.discover(home, {})).some(({ file }) => file.endsWith("ses_Z.json")), "nor listed");
  // ses_B's message folder moved out and linked back: not followed, by its read, its size or its stamp.
  await rename(join(moved, "message", "ses_B"), join(home, "elsewhere"));
  await symlink(join(home, "elsewhere"), join(moved, "message", "ses_B"));
  const b = join(moved, "session", "prj_fixture", "ses_B.json");
  const [one] = (await reader.read({ file: b })).sessions;
  assert.deepEqual(said(one.session), [], "no message through the link");
  assert.equal((await locatorSize({ file: b }, "opencode")).bytes, (await stat(b)).size, "its size, its own file's alone");
});

test("a session OpenCode is still running is live whatever its rows' times: a 1.x message not completed or a tool part running, a 2.x session busy, a storage message not completed", async (t) => {
  const dir = await tempHome(t);
  const recent = Date.now() - 60_000;
  const live = (size, what) => assert.ok(size.mtimeMs >= recent, `${what}: live`);
  const v1 = join(dir, "v1.db");
  const parked = (id, info, parts, ended = {}) => ({
    session: { id, directory: "/fixture/p", title: id, time: { created: T0, updated: T0 } },
    messages: [
      { info: { id: `${id}_u`, role: "user", time: { created: T0 } }, parts: [{ id: `${id}_t`, type: "text", text: "Go." }] },
      { info: { id: `${id}_m`, role: "assistant", providerID: "openai", modelID: "gpt-5", path: { cwd: "/fixture/p", root: "/fixture/p" }, time: { created: T0 + 1000, ...info }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, ...ended }, parts },
    ],
  });
  const tool = (status) => ({ id: `prt_${status}`, type: "tool", callID: "call_p", tool: "bash", state: { status, input: { command: "ls" }, time: { start: T0 + 1000 } } });
  // A request that failed or was aborted before it completed (text-free's ses_E1 shape: no time.completed, an error)
  // has ended, as its read says (failed, stopped): never running.
  const failed = { error: { name: "APIError", data: { message: "overloaded" } } };
  const aborted = { error: { name: "MessageAbortedError", data: { message: "aborted" } } };
  await buildV1(v1, [
    parked("ses_open", {}, []),
    parked("ses_ask", { completed: T0 + 2000 }, [tool("pending")]),
    parked("ses_run", { completed: T0 + 2000 }, [tool("running")]),
    parked("ses_done", { completed: T0 + 2000 }, [tool("completed")]),
    parked("ses_failed", {}, [], failed),
    parked("ses_aborted", {}, [{ ...tool("running"), id: "prt_aborted" }], aborted),
  ]);
  for (const id of ["ses_open", "ses_ask", "ses_run"]) live(await locatorSize({ file: v1, id }, "opencode"), id);
  for (const id of ["ses_done", "ses_failed", "ses_aborted"]) assert.equal((await locatorSize({ file: v1, id }, "opencode")).mtimeMs, T0 + 1000, `${id}: ended, its rows' last write`);
  // Each read alone: the parked sessions' requests share a fingerprint, so one read of all would take them for copies.
  assert.deepEqual([(await readSession({ file: v1, id: "ses_failed" }, "opencode")).state, (await readSession({ file: v1, id: "ses_aborted" }, "opencode")).state], ["failed", "stopped"], "as its read ends them");
  // 2.x: time_busy (set as a run starts, never cleared) after time_idle (set as it ends): running.
  const v2 = join(dir, "v2.db");
  await buildV2(v2);
  const db = new DatabaseSync(v2);
  db.exec("ALTER TABLE session_v2 ADD time_busy integer; ALTER TABLE session_v2 ADD time_idle integer");
  db.prepare("UPDATE session_v2 SET time_busy = ?, time_idle = ? WHERE id = 'ses_C'").run(T0 + 112_000, T0 + 111_500);
  db.prepare("UPDATE session_v2 SET time_busy = ?, time_idle = ? WHERE id = 'ses_K'").run(T0 + 131_000, T0 + 139_500);
  db.close();
  live(await locatorSize({ file: v2, id: "ses_C" }, "opencode"), "2.x busy");
  assert.equal((await locatorSize({ file: v2, id: "ses_K" }, "opencode")).mtimeMs, T0 + 139_000, "2.x idle since: its rows' last write");
  // The JSON storage: its last message not completed; one that failed has ended.
  const storage = join(dir, "storage");
  await buildLegacy(storage);
  const last = join(storage, "message", "ses_B", "msg_B2.json");
  const info = JSON.parse(await readFile(last, "utf8"));
  delete info.time.completed;
  await writeFile(last, JSON.stringify(info));
  // Every file of it written long ago.
  for (const entry of await readdir(storage, { recursive: true, withFileTypes: true })) if (entry.isFile()) await utimes(join(entry.parentPath, entry.name), new Date(T0), new Date(T0));
  live(await locatorSize({ file: join(storage, "session", "prj_fixture", "ses_B.json") }, "opencode"), "storage");
  await writeFile(last, JSON.stringify({ ...info, error: failed.error }));
  await utimes(last, new Date(T0), new Date(T0));
  assert.equal((await locatorSize({ file: join(storage, "session", "prj_fixture", "ses_B.json") }, "opencode")).mtimeMs, T0, "storage, failed: its files' last write");
  assert.equal((await locatorSize({ file: join(storage, "session", "prj_fixture", "ses_A.json") }, "opencode")).mtimeMs, T0, "storage, completed: its files' last write");
});

test("a closed database OpenCode opens or writes while it is read (its -wal made, or its time moved, before the read's look after) fails that read, never a clean one: discover lists it as its own locator, its stat and read fail", async (t) => {
  const home = await tempHome(t);
  const data = join(home, ".local", "share", "opencode");
  const db = join(data, "opencode.db");
  await buildV2(db);
  const own = new DatabaseSync(db);
  own.exec("PRAGMA journal_mode = WAL");
  own.close();
  // The read looks at the database and its -wal as it opens it, and again after it closes it (the database's stat, then
  // its -wal): OpenCode starts between the two. Its -wal made just before the look after; its time moved just after the
  // first look took the database's stat.
  const lstat = fs.lstat;
  let looks = 0;
  let change;
  const mocked = t.mock.method(fs, "lstat", async (path, ...args) => {
    if (path === `${db}-wal` && ++looks === change.at) await change.made();
    return lstat(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const changes = {
    "its -wal made": { at: 2, made: () => writeFile(`${db}-wal`, "") },
    "its time moved": { at: 1, made: () => utimes(db, new Date(), new Date(Date.now() + 60_000)) },
  };
  for (const [how, made] of Object.entries(changes)) {
    for (const [what, run] of [
      ["read", () => reader.read({ file: db, id: "ses_C" })],
      ["stat", () => locatorSize({ file: db, id: "ses_C" }, "opencode")],
      ["discover", async () => assert.deepEqual(await reader.discover(home, {}), [{ file: db }], `${how}: discover lists the database as its own locator`)],
    ]) {
      looks = 0;
      change = made;
      await rm(`${db}-wal`, { force: true });
      if (what === "discover") await run();
      else await assert.rejects(run(), /changed while it was read/, `${how}: ${what}`);
      assert.equal(looks >= 2, true, `${how}: ${what} looked after`);
    }
  }
  // Nothing changed: a clean read.
  looks = 0;
  change = { at: 0, made: async () => {} };
  await rm(`${db}-wal`, { force: true });
  assert.equal((await reader.read({ file: db, id: "ses_C" })).sessions.length, 1);
});

test("a read that fails partway adds nothing to the import's `seen`: the session read again (or a fork after it) keeps every request of its own", async (t) => {
  const home = await tempHome(t);
  const db = join(home, ".local", "share", "opencode", "opencode.db");
  await buildV2(db);
  const own = new DatabaseSync(db);
  own.exec("PRAGMA journal_mode = WAL");
  own.close();
  const whole = (await reader.read({ file: db, id: "ses_C" })).sessions[0].requests.length;
  assert.ok(whole > 0);
  // OpenCode opens the database while ses_C is read: its -wal there at the read's look after (the second -wal look).
  const lstat = fs.lstat;
  let looks = 0;
  const mocked = t.mock.method(fs, "lstat", async (path, ...args) => {
    if (path === `${db}-wal` && ++looks === 2) await writeFile(`${db}-wal`, "");
    return lstat(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const seen = new Set();
  await assert.rejects(reader.read({ file: db, id: "ses_C" }, undefined, { seen }), /changed while it was read/);
  assert.deepEqual([...seen], [], "nothing of the failed read");
  mocked.mock.restore();
  syncBuiltinESMExports();
  await rm(`${db}-wal`, { force: true });
  const again = (await reader.read({ file: db, id: "ses_C" }, undefined, { seen })).sessions[0];
  assert.equal(again.requests.length, whole, "no request of its own taken for a copy");
  assert.ok(seen.size > 0, "a read that ends clean adds its own");
});

test("every query of one read sees the database as its first did: a row OpenCode writes between two of them is in neither", async (t) => {
  const home = await tempHome(t);
  const file = join(home, "opencode.db");
  // OpenCode's own connection, open in WAL mode throughout (its -wal and -shm there), writing as the read goes on.
  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE message (id TEXT); INSERT INTO message VALUES ('m1');");
  const counts = await withDb(file, (db) => {
    const first = db.all("SELECT count(*) AS n FROM message")[0].n;
    writer.exec("INSERT INTO message VALUES ('m2')");
    return [first, db.all("SELECT count(*) AS n FROM message")[0].n];
  });
  assert.deepEqual(counts, [1, 1]);
  // The next read sees it.
  assert.equal(await withDb(file, (db) => db.all("SELECT count(*) AS n FROM message")[0].n), 2);
});
