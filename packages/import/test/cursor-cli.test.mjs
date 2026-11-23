// Cursor's CLI (cursor-agent) as a source: each chat a store.db of its own (blobs and meta), read once, whole. Cursor
// keeps no tokens or cost for a request on this machine (its usage is on Cursor's server): each answer is a request of
// unknown tokens. Every chat here is synthetic (fixtures/cursor/fixture.mjs).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { serialize } from "node:v8";
import { cursorSessionId, HARNESS_OF, parseHome, READERS, readSession, SOURCE_NAMES } from "../dist/index.js";
import { AGENT, buildChat, T0, WORKSPACE } from "./fixtures/cursor/fixture.mjs";
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

test("a chat reads into one session: its prompts, its answers (each a request of unknown tokens), its tools' results", async (t) => {
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
  assert.equal(session.model, "cursor/fixture-model");
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
    ["msg_fixture_1", "msg_fixture_2", "msg_fixture_3"],
  );
  for (const request of requests) {
    assert.equal(request.usage, undefined, "Cursor keeps no tokens here");
    assert.equal(request.costUsd, undefined);
    assert.equal(request.model, "cursor/fixture-model");
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

test("an untitled chat has no source title, and one with no model named has none", async (t) => {
  const home = await tempHome(t);
  const session = await readSession(await buildChat(join(home, ".cursor")), "cursor");
  assert.equal(session.sourceTitle, undefined, "Cursor's default name, New Agent, is no title");
  assert.equal(session.model, undefined);
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

test("the start is the root's, else the agent's createdAt; a chat with no updatedAtMs ends where it started", async (t) => {
  const home = await tempHome(t);
  const file = await buildChat(join(home, ".cursor"), { started: null, created: T0 + 1000 });
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

test("the session id is the chat's folder, as Cursor names its agent", () => {
  assert.equal(cursorSessionId("/x/.cursor/chats/abc/00000000-0000-4000-8000-00000000c001/store.db"), "00000000-0000-4000-8000-00000000c001");
  assert.equal(cursorSessionId("/x/.cursor/acp-sessions/sess-1/store.db"), "sess-1");
});
