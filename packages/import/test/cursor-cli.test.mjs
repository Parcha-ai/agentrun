// Cursor's CLI (cursor-agent) as a source: each chat a store.db of its own (blobs and meta), read once, whole. Cursor
// keeps no tokens, cost or readable model for a request on this machine (its usage is on Cursor's server): each answer
// is a request of unknown tokens on an unknown model. Every chat here is synthetic (fixtures/cursor/fixture.mjs).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { open, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { serialize } from "node:v8";
import { cursorSessionId, HARNESS_OF, locatorParent, locatorSize, parseHome, READERS, readSession, SOURCE_NAMES } from "../dist/index.js";
import { AGENT, buildChat, MESSAGES, T0, WORKSPACE } from "./fixtures/cursor/fixture.mjs";
import { tempHome } from "./fixtures.mjs";

const cursor = READERS.cursor;
const iso = (ms) => new Date(ms).toISOString();

test("Cursor is a source: its name, and serve's cursor harness", () => {
  assert.equal(cursor.source, "cursor");
  assert.equal(SOURCE_NAMES.cursor, "Cursor");
  assert.equal(HARNESS_OF.cursor, "cursor");
});

test("a chat is found under ~/.cursor/chats and ~/.cursor/acp-sessions, else where CURSOR_CONFIG_DIR or XDG_CONFIG_HOME name", async (t) => {
  const home = await tempHome(t);
  const chat = await buildChat(join(home, ".cursor"));
  const acp = await buildChat(join(home, ".cursor"), { agent: "00000000-0000-4000-8000-00000000c002", layout: "acp" });
  // Not a chat: a file beside the store, and a folder with no store.
  await writeFile(join(dirname(chat), "notes.db"), "");
  assert.deepEqual((await cursor.discover(home, {})).map(({ file }) => file).sort(), [chat, acp].sort());
  assert.deepEqual(await cursor.discover(home, {}), (await cursor.discover(home, {})).map(({ file }) => ({ file })), "one chat a file: no id");
  const named = await buildChat(join(home, "elsewhere"), { agent: "00000000-0000-4000-8000-00000000c003" });
  assert.deepEqual(await cursor.discover(home, { CURSOR_CONFIG_DIR: join(home, "elsewhere") }), [{ file: named }]);
  const xdg = await buildChat(join(home, "xdg", "cursor"), { agent: "00000000-0000-4000-8000-00000000c004" });
  assert.deepEqual(await cursor.discover(home, { XDG_CONFIG_HOME: join(home, "xdg") }), [{ file: xdg }]);
  assert.deepEqual(await cursor.discover(join(home, "nobody"), {}), []);
});

test("a chat reads into one session: its prompts, its answers (each a request of unknown tokens and model), its tools' results", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"), { lastUsedModel: "fixture-model", name: "Fixture chat" });
  const result = await cursor.read({ file });
  assert.equal(result.resumed, false);
  assert.ok(result.read > 0, "the bytes of the blobs it read");
  assert.equal(result.sessions.length, 1);
  const [{ locator, session, requests }] = result.sessions;
  assert.deepEqual(locator, { file });
  assert.equal(session.source, "cursor");
  assert.equal(session.id, AGENT);
  assert.equal(session.id, cursorSessionId(file), "the id is the exported function's");
  assert.equal(session.file, file);
  assert.equal(session.cwd, WORKSPACE);
  assert.equal(session.model, undefined, "the model Cursor names last is no request's: each turn's is encrypted, never read");
  assert.equal(session.sourceTitle, "Fixture chat");
  assert.equal(session.firstPrompt, "Tidy the fixture notes.");
  assert.equal(session.users, 2);
  assert.equal(session.child, false);
  assert.equal(session.state, "completed");
  assert.equal(session.costUsd, undefined);
  assert.equal(session.startedAt, iso(T0));
  assert.equal(session.endedAt, iso(T0 + 5 * 60_000));
  assert.equal(session.activeMs, 5 * 60_000);
  assert.deepEqual(
    session.turns.map((turn) => [turn.role, turn.role === "assistant" ? turn.text : turn.role === "toolResult" ? `${turn.name}:${turn.isError}:${turn.text}` : turn.text]),
    [
      ["user", "Tidy the fixture notes."],
      ["assistant", "Reading the notes."],
      ["toolResult", "read_file:false:Three fixture lines."],
      ["assistant", "Tidied."],
      ["user", "Now delete the scratch file."],
      ["assistant", ""],
      ["toolResult", "delete_file:true:No such fixture file."],
    ],
  );
  assert.deepEqual(session.turns[1].calls, [{ type: "toolCall", id: "call_fixture_1", name: "read_file", arguments: { path: "/fixture/notes/todo.md" } }]);
  assert.equal(session.turns[2].callId, "call_fixture_1");
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((request) => request.key),
    ["req_fixture_1", "msg_fixture_2", "msg_fixture_3"],
  );
  for (const request of requests) {
    assert.equal(request.usage, undefined, "Cursor keeps no tokens here");
    assert.equal(request.costUsd, undefined);
    assert.equal(request.model, undefined);
    assert.equal(request.error, undefined, "Cursor stores no request's error");
  }
});

test("a chat's messages are read in its root's order, not the order its blobs were written in", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"), { stored: [7, 6, 5, 4, 3, 2, 1, 0] });
  const session = await readSession(file, "cursor");
  assert.deepEqual(
    session.turns.map((turn) => turn.role),
    ["user", "assistant", "toolResult", "assistant", "user", "assistant", "toolResult"],
  );
  assert.equal(session.firstPrompt, "Tidy the fixture notes.");
});

test("a message its root names but the store has not (written later, or lost) is passed over", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"), { stored: [0, 1, 2, 3, 4, 5] });
  const session = await readSession(file, "cursor");
  assert.deepEqual(
    session.turns.map((turn) => turn.role),
    ["user", "assistant", "toolResult", "assistant", "user"],
  );
});

test("an untitled chat has no source title", async (t) => {
  const home = await tempHome(t);
  const session = await readSession(await buildChat(join(home, ".cursor")), "cursor");
  assert.equal(session.sourceTitle, undefined, "Cursor's default name, New Agent, is no title");
  assert.equal(session.titleText, "Tidy the fixture notes.");
});

test("a subagent's chat is its parent's child", async (t) => {
  const home = await tempHome(t);
  const parent = "00000000-0000-4000-8000-00000000c00a";
  const file = await buildChat(join(home, ".cursor"), { subagentInfo: { parentAgentId: parent, rootParentAgentId: parent, toolCallId: "call_fixture_9", typeName: "fixture" } });
  const session = await readSession(file, "cursor");
  assert.equal(session.child, true);
  assert.equal(session.parent, parent);
});

test("the start is the agent's createdAt; a chat with no updatedAtMs ends where it started", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"), { created: T0 + 1000 });
  const meta = join(dirname(file), "meta.json");
  const { updatedAtMs: _gone, ...rest } = JSON.parse(await readFile(meta, "utf8"));
  await writeFile(meta, JSON.stringify(rest));
  const session = await readSession(file, "cursor");
  assert.equal(session.startedAt, iso(T0 + 1000));
  assert.equal(session.endedAt, iso(T0 + 1000));
  assert.equal(session.activeMs, 0);
});

test("a chat left open past the gap counts no time at work", async (t) => {
  const home = await tempHome(t);
  const session = await readSession(await buildChat(join(home, ".cursor"), { updated: T0 + 60 * 60_000 }), "cursor");
  assert.equal(session.endedAt, iso(T0 + 60 * 60_000));
  assert.equal(session.activeMs, 0);
});

test("turns false keeps no text: no prompt, answer, tool output or argument, in the session, its requests or the cursor", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"), { name: "Fixture chat" });
  const result = await cursor.read({ file }, undefined, { turns: false });
  const [{ session, requests }] = result.sessions;
  assert.deepEqual(session.turns, []);
  assert.equal(session.cwd, WORKSPACE, "the workspace still names its project, as a listing needs");
  assert.equal(requests.length, 3, "every request still counts");
  for (const request of requests) {
    assert.equal(request.text, "");
    for (const call of request.calls) assert.deepEqual(call.arguments, {});
  }
  assert.equal(session.users, 2, "both prompts still count");
  const bytes = serialize({ requests, cursor: result.cursor, calls: requests.flatMap((r) => r.calls) });
  for (const text of ["Reading the notes.", "Tidied.", "Three fixture lines.", "No such fixture file.", "/fixture/notes/todo.md", "/fixture/notes/scratch.md"]) assert.equal(bytes.includes(Buffer.from(text)), false, text);
  assert.equal(serialize(result.cursor).includes(Buffer.from("Tidy the fixture notes.")), false);
});

test("a later message of a request read already (Cursor's requestId) is more of that request: one request, its calls all kept", async (t) => {
  const home = await tempHome(t);
  const more = { role: "assistant", id: "msg_fixture_1b", content: [{ type: "text", text: "And the index." }, { type: "tool-call", toolCallId: "call_fixture_1b", toolName: "read_file", args: { path: "/fixture/notes/index.md" } }], providerOptions: { cursor: { requestId: "req_fixture_1" } } };
  const file = await buildChat(join(home, ".cursor"), { messages: [...MESSAGES.slice(0, 4), more, ...MESSAGES.slice(4)] });
  const { sessions } = await cursor.read({ file });
  const [{ session, requests }] = sessions;
  assert.deepEqual(
    requests.map((request) => [request.key, request.calls.map((call) => call.id)]),
    [
      ["req_fixture_1", ["call_fixture_1", "call_fixture_1b"]],
      ["msg_fixture_2", []],
      ["msg_fixture_3", ["call_fixture_2"]],
    ],
  );
  assert.equal(session.turns[1].text, "Reading the notes.\nAnd the index.");
  assert.equal(session.turns.filter((turn) => turn.role === "assistant").length, 3);
});

test("a read is one pass: no cursor to go on from, and a second read reads it all again", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"));
  const first = await cursor.read({ file });
  assert.equal(first.cursor, null);
  const again = await cursor.read({ file }, first.cursor);
  assert.equal(again.resumed, false);
  assert.equal(again.read, first.read);
  assert.equal(again.sessions[0].requests.length, 3);
});

test("a read changes nothing in the store", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"));
  const before = createHash("sha256").update(await readFile(file)).digest("hex");
  const { mtimeMs } = await stat(file);
  await readSession(file, "cursor");
  assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), before);
  assert.equal((await stat(file)).mtimeMs, mtimeMs);
});

/** A chat folder's files, each with its size. */
const listing = async (dir) => Promise.all((await readdir(dir)).sort().map(async (name) => [name, (await stat(join(dir, name))).size]));

test("a chat Cursor has closed is found, stated and read with nothing written beside its store: its folder holds the same files at the same sizes (a read-only open of a WAL store makes its -wal and -shm, and leaves them)", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"));
  const before = await listing(dirname(file));
  assert.deepEqual(before.map(([name]) => name), ["meta.json", "store.db"]);
  assert.deepEqual((await cursor.discover(home)).map(({ file }) => file), [file]);
  await stat(file);
  await readSession(file, "cursor");
  await cursor.read({ file }, undefined, { turns: false });
  assert.deepEqual(await listing(dirname(file)), before);
});

test("a chat Cursor has open (its -wal beside the store) is read with what its log holds", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"));
  // cursor-agent's connection, open: it renames the chat, and the rename is in the log alone.
  const { DatabaseSync } = await import("node:sqlite");
  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  const agent = JSON.parse(Buffer.from(writer.prepare("SELECT value FROM meta WHERE key = '0'").get().value, "hex").toString("utf8"));
  writer.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(Buffer.from(JSON.stringify({ ...agent, name: "Renamed" })).toString("hex"));
  assert.ok((await listing(dirname(file))).some(([name, size]) => name === "store.db-wal" && size > 0));
  assert.equal((await readSession(file, "cursor")).sourceTitle, "Renamed");
});

test("a chat Cursor opens while it is read (its -wal made mid-read) fails that read, never a clean one", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"));
  // meta.json as a pipe: the read opens the store, then waits on meta.json until the test has made the -wal.
  const meta = join(dirname(file), "meta.json");
  const text = await readFile(meta, "utf8");
  await unlink(meta);
  execFileSync("mkfifo", [meta]);
  const reading = readSession(file, "cursor");
  const pipe = await open(meta, "w");
  await writeFile(`${file}-wal`, "");
  await pipe.write(text);
  await pipe.close();
  await assert.rejects(reading, /Cursor wrote the chat while it was read/);
});

test("a file that is no Cursor store fails its read alone", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"));
  const other = join(dirname(dirname(file)), "00000000-0000-4000-8000-00000000c0ff", "store.db");
  await buildChat(join(home, ".cursor"), { agent: "00000000-0000-4000-8000-00000000c0ff" });
  await writeFile(other, "not a database");
  const failures = [];
  const totals = await parseHome(home, { sources: ["cursor"], env: {}, catalog: false, failures });
  assert.deepEqual(
    totals.map(({ id, calls, turns, cost }) => [id, calls, turns, cost]),
    [[AGENT, 3, 2, null]],
  );
  assert.deepEqual(
    failures.map(({ file }) => file),
    [other],
  );
});

test("a chat's size and last write take its write-ahead log and meta.json: an open chat writes store.db-wal, store.db's mtime unchanged", async (t) => {
  const home = await tempHome(t);
  const chat = await buildChat(join(home, ".cursor"));
  const meta = join(dirname(chat), "meta.json");
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  await utimes(chat, hourAgo, hourAgo);
  await utimes(meta, hourAgo, hourAgo);
  const db = await stat(chat);
  assert.deepEqual(await locatorSize({ file: chat }, "cursor"), { bytes: db.size, mtimeMs: db.mtimeMs }, "no log: the store's own");
  // A log the open chat has written since (its bytes are not read here): the chat was last written then, and holds both.
  await writeFile(`${chat}-wal`, Buffer.alloc(4096));
  const wal = await stat(`${chat}-wal`);
  assert.deepEqual(await locatorSize({ file: chat }, "cursor"), { bytes: db.size + 4096, mtimeMs: wal.mtimeMs });
  // meta.json written later still (its updatedAtMs moved): that is the last write.
  const later = new Date(Math.ceil(wal.mtimeMs) + 60_000);
  await utimes(meta, later, later);
  assert.equal((await locatorSize({ file: chat }, "cursor")).mtimeMs, later.getTime());
  assert.equal(await locatorSize({ file: join(home, ".cursor", "chats", "gone", "gone", "store.db") }, "cursor"), null, "a store gone: no chat");
});

test("a subagent's chat names the agent it ran under from its store's metadata alone, never its messages: what ties one over a caller's cap to its run", async (t) => {
  const home = await tempHome(t);
  const parent = "00000000-0000-4000-8000-00000000c0aa";
  const top = await buildChat(join(home, ".cursor"));
  const sub = await buildChat(join(home, ".cursor"), { agent: "00000000-0000-4000-8000-00000000c0bb", subagentInfo: { parentAgentId: parent, rootParentAgentId: parent, toolCallId: "call_fixture_9", typeName: "fixture" } });
  assert.equal(await locatorParent({ file: sub }, "cursor"), parent);
  assert.equal(await locatorParent({ file: top }, "cursor"), undefined, "a top chat names none");
  // A store whose messages are gone still names its parent: the lookup reads the metadata, not the blobs.
  const db = new (await import("node:sqlite")).DatabaseSync(sub);
  db.exec("DELETE FROM blobs");
  db.close();
  assert.equal(await locatorParent({ file: sub }, "cursor"), parent);
  const junk = join(home, "junk.db");
  await writeFile(junk, "not a store");
  assert.equal(await locatorParent({ file: junk }, "cursor"), undefined, "no store: no parent, and no throw");
});

test("the session id is the chat's folder, as Cursor names its agent", () => {
  assert.equal(cursorSessionId("/x/.cursor/chats/abc/00000000-0000-4000-8000-00000000c001/store.db"), "00000000-0000-4000-8000-00000000c001");
  assert.equal(cursorSessionId("/x/.cursor/acp-sessions/sess-1/store.db"), "sess-1");
});
