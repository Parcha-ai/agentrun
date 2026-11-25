// A read with `turns: false` keeps what a listing and a total use: no answer text in its requests, nor in the cursor a
// later read goes on from (parseHome holds every file's requests and cursors at once).
import assert from "node:assert/strict";
import { test } from "node:test";
import { serialize } from "node:v8";
import { parseHome, READERS, readSession } from "../dist/index.js";
import { FAILED } from "../dist/readers/opencode.js";
import { anthropicUsage, at, claudeAnswer, claudeFile, claudeUser, codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, piFile, piMeta, piUser, tempHome, writeJsonl } from "./fixtures.mjs";

const WORDS = "Fixture answer words, never kept.";

const holdsNoText = (result) => {
  assert.ok(result.sessions[0].requests.length > 0);
  for (const request of result.sessions[0].requests) assert.equal(request.text, "");
  assert.equal(serialize(result.cursor).includes(Buffer.from(WORDS)), false, "the cursor holds no answer text");
  assert.equal(serialize(result.sessions).includes(Buffer.from(WORDS)), false, "the sessions hold no answer text");
};

test("Claude Code: turns false keeps no answer text in requests or the cursor", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(claudeFile(home), [
    claudeUser({ uuid: "u1", text: "Fixture prompt.", i: 0 }),
    claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 2), i: 1, block: { type: "text", text: WORDS } }),
    claudeAnswer({ uuid: "a2", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 4), i: 2, block: { type: "text", text: WORDS } }),
  ]);
  holdsNoText(await READERS["claude-code"].read({ file }, undefined, { turns: false }));
  const kept = await READERS["claude-code"].read({ file }, undefined, { turns: true });
  assert.equal(kept.sessions[0].requests[0].text, `${WORDS}\n${WORDS}`, "turns true keeps it");
});

test("pi: turns false keeps no answer text in requests or the cursor", async (t) => {
  const home = await tempHome(t);
  const answer = { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", provider: "fixture", model: "fixture-model", content: [{ type: "text", text: WORDS }], stopReason: "stop", usage: { input: 10, output: 2 } } };
  const file = await writeJsonl(piFile(home), [piMeta(), piUser("Fixture prompt."), answer]);
  holdsNoText(await READERS.pi.read({ file }, undefined, { turns: false }));
  const kept = await READERS.pi.read({ file }, undefined, { turns: true });
  assert.equal(kept.sessions[0].requests[0].text, WORDS, "turns true keeps it");
});

test("OpenCode: turns false keeps no answer text, tool output or later prompt in requests or the cursor, a database's and the JSON storage's", async (t) => {
  const { join } = await import("node:path");
  const { buildLegacy, buildV2 } = await import("./fixtures/opencode/fixture.mjs");
  const dir = await tempHome(t);
  const db = join(dir, "opencode.db");
  await buildV2(db);
  const storage = join(dir, "storage");
  await buildLegacy(storage);
  // Answer text the fixtures write (2.x content and parts, a compaction's summary, 1.x text parts), tool output
  // (2.x content, 1.x output) and a prompt after the first.
  const said = ["Looking.", "Done porting.", "Ported the reader.", "Reading the file.", "Fixed.", "const x = 1;", "export const a = 1;", "Stop.", "Now add a test."];
  for (const [locator, kept] of [[{ file: db, id: "ses_C" }, "Done porting."], [{ file: join(storage, "session", "prj_fixture", "ses_A.json") }, "Fixed."]]) {
    const result = await READERS.opencode.read(locator, undefined, { turns: false });
    assert.ok(result.sessions[0].requests.length > 0);
    for (const request of result.sessions[0].requests) assert.equal(request.text, "");
    for (const words of said) {
      assert.equal(serialize(result.cursor).includes(Buffer.from(words)), false, `the cursor holds no "${words}"`);
      assert.equal(serialize(result.sessions).includes(Buffer.from(words)), false, `the sessions hold no "${words}"`);
    }
    const full = await READERS.opencode.read(locator, undefined, { turns: true });
    assert.ok(full.sessions[0].requests.some((request) => request.text.includes(kept)), "turns true keeps it");
  }
});

test("OpenCode: turns false keeps no request's error message (a path, a provider's words) in requests or the cursor: a fixed mark that it failed", async (t) => {
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { buildV1, buildV2, T0 } = await import("./fixtures/opencode/fixture.mjs");
  const dir = await tempHome(t);
  const message = "rate limited at /fixture/private/notes.md by the provider";
  const v1 = join(dir, "v1.db");
  await buildV1(v1, [
    {
      session: { id: "ses_E", directory: "/fixture/e", title: "Errs", time: { created: T0, updated: T0 + 2000 } },
      messages: [{ info: { id: "msg_E1", role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-5", path: { cwd: "/fixture/e", root: "/fixture/e" }, time: { created: T0 + 1000 }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, error: { name: "APIError", data: { message } } }, parts: [] }],
    },
  ]);
  const v2 = join(dir, "v2.db");
  await buildV2(v2);
  const db = new DatabaseSync(v2);
  db.prepare("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_E2', 'prj_fixture', 'fixture', '/fixture/e', 'Errs', '2.3.2', ?, ?)").run(T0, T0 + 2000);
  db.prepare("INSERT INTO session_message VALUES ('msg_E2', 'ses_E2', 'assistant', 0, ?, ?, ?)").run(T0, T0, JSON.stringify({ model: { id: "m", providerID: "p" }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: T0 + 1000 }, content: [], error: { type: "provider", message } }));
  db.close();
  for (const locator of [{ file: v1, id: "ses_E" }, { file: v2, id: "ses_E2" }]) {
    const result = await READERS.opencode.read(locator, undefined, { turns: false });
    assert.deepEqual(result.sessions[0].requests.map((request) => request.error), [FAILED]);
    assert.equal(result.sessions[0].session.state, "failed");
    for (const words of [message, "/fixture/private"]) {
      assert.equal(serialize(result.cursor).includes(Buffer.from(words)), false, `the cursor holds no "${words}"`);
      assert.equal(serialize(result.sessions).includes(Buffer.from(words)), false, `the sessions hold no "${words}"`);
    }
    const full = await READERS.opencode.read(locator, undefined, { turns: true });
    assert.deepEqual(full.sessions[0].requests.map((request) => request.error), [message], "turns true keeps it");
  }
});

test("Codex: turns false keeps no answer text, tool output or later prompt in requests or the cursor", async (t) => {
  const home = await tempHome(t);
  const call = { type: "response_item", timestamp: at(4), payload: { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" } };
  const output = { type: "response_item", timestamp: at(5), payload: { type: "function_call_output", call_id: "call_1", output: `Exit code: 1\nOutput:\n${WORDS}` } };
  const file = await writeJsonl(codexFile(home), [
    codexMeta("thread-1"),
    codexContext(1),
    codexUser("Fixture prompt.", 2),
    codexAnswer(WORDS, 3),
    call,
    output,
    codexTokens(openaiUsage(100, 60, 7, 3), openaiUsage(100, 60, 7, 3), 6),
    codexUser(WORDS, 7),
  ]);
  const result = await READERS.codex.read({ file }, undefined, { turns: false });
  holdsNoText(result);
  assert.equal(result.sessions[0].session.users, 2, "both prompts still count");
  assert.equal(result.sessions[0].session.firstPrompt, "Fixture prompt.");
  const kept = await READERS.codex.read({ file }, undefined, { turns: true });
  const result1 = kept.sessions[0].session.turns.find((turn) => turn.role === "toolResult");
  assert.equal(result1.isError, true, "the exit code still marks the result failed");
  assert.match(result1.text, /Fixture answer words/);
});

test("parseHome's state (turns false) holds no prompt, title or working directory, while a read from the start still lists them", async (t) => {
  const home = await tempHome(t);
  const TITLE = "Fixture title, never kept.";
  const PROMPT = "Fixture prompt, never kept.";
  const CWD = "/fixture/cwd/never/kept";
  const claude = await writeJsonl(claudeFile(home), [
    { ...claudeUser({ uuid: "u1", text: PROMPT, i: 0 }), cwd: CWD },
    { ...claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 2), i: 1 }), cwd: CWD },
    { type: "custom-title", customTitle: TITLE, sessionId: "00000000-0000-4000-8000-000000000001" },
    { type: "summary", summary: TITLE, leafUuid: "a1" },
  ]);
  await writeJsonl(codexFile(home), [
    { ...codexMeta("thread-1"), payload: { ...codexMeta("thread-1").payload, cwd: CWD } },
    codexContext(1),
    codexUser(PROMPT, 2),
    codexAnswer(WORDS, 3),
    codexTokens(openaiUsage(100, 60, 7, 3), openaiUsage(100, 60, 7, 3), 4),
  ]);
  await writeJsonl(piFile(home), [{ ...piMeta(), cwd: CWD }, piUser(PROMPT), { type: "message", timestamp: at(2), message: { role: "assistant", provider: "fixture", model: "fixture-model", content: [{ type: "text", text: WORDS }], stopReason: "stop", usage: { input: 10, output: 2 } } }]);
  const state = {};
  const sessions = await parseHome(home, { state, catalog: false });
  assert.equal(sessions.length, 3);
  const bytes = serialize(state);
  for (const text of [TITLE, PROMPT, CWD, WORDS]) assert.equal(bytes.includes(Buffer.from(text)), false, `the state holds no ${text}`);
  const listed = await readSession(claude, "claude-code", { turns: false });
  assert.deepEqual([listed.firstPrompt, listed.sourceTitle, listed.cwd], [PROMPT, TITLE, CWD], "a listing read from the start has them");
});

test("OpenCode: parseHome's state (turns false) holds no prompt, title or working directory, a database's or the JSON storage's, while a read from the start still lists them", async (t) => {
  const { join } = await import("node:path");
  const { buildLegacy, buildV2 } = await import("./fixtures/opencode/fixture.mjs");
  const home = await tempHome(t);
  const data = join(home, ".local", "share", "opencode");
  await buildV2(join(data, "opencode.db"));
  await buildLegacy(join(data, "storage"));
  const state = {};
  const sessions = await parseHome(home, { sources: ["opencode"], state, catalog: false });
  assert.ok(sessions.length > 0);
  // Its titles, first prompts and folders, a database's (2.x and 1.x) and the storage's.
  const text = ["Port the reader", "Older work", "Fix the parser", "Port the reader to v2.", "Rename it.", "Fix the parser please.", "/fixture/v2", "/fixture/old", "/fixture/project"];
  const bytes = serialize(state);
  for (const words of text) assert.equal(bytes.includes(Buffer.from(words)), false, `the state holds no ${words}`);
  const again = await parseHome(home, { sources: ["opencode"], state, catalog: false });
  assert.deepEqual(again, sessions, "a pass resumed from the state totals the same");
  const listed = await readSession({ file: join(data, "opencode.db"), id: "ses_C" }, "opencode", { turns: false });
  assert.deepEqual([listed.firstPrompt, listed.sourceTitle, listed.cwd], ["Port the reader to v2.", "Port the reader", "/fixture/v2"], "a listing read from the start has them");
});

test("a failed request read with turns false keeps no error text, only that it failed: not in its requests nor a home's totals", async (t) => {
  const home = await tempHome(t);
  // Claude Code's own turn for an API error, and pi's request that stopped on one: each holds the error's words.
  await writeJsonl(claudeFile(home), [
    claudeUser({ uuid: "u1", text: "Fixture prompt.", i: 0 }),
    { ...claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(0, 0), i: 1, model: "<synthetic>", block: { type: "text", text: WORDS } }), isApiErrorMessage: true },
  ]);
  const failed = { type: "message", timestamp: at(2), message: { role: "assistant", provider: "fixture", model: "fixture-model", content: [], stopReason: "error", errorMessage: WORDS, usage: { input: 10, output: 0 } } };
  await writeJsonl(piFile(home), [piMeta(), piUser("Fixture prompt."), failed]);
  for (const [source, file] of [["claude-code", claudeFile(home)], ["pi", piFile(home)]]) {
    const result = await READERS[source].read({ file }, undefined, { turns: false });
    // The same mark as OpenCode's: one word for "it failed" whatever the source.
    assert.equal(result.sessions[0].requests[0].error, FAILED, `${source}: the error, without its words`);
    holdsNoText(result);
    const kept = await READERS[source].read({ file }, undefined, { turns: true });
    assert.equal(kept.sessions[0].requests[0].error, WORDS, `${source}: turns true keeps it`);
  }
  const totals = await parseHome(home, { sources: ["claude-code", "pi"], catalog: false });
  assert.equal(serialize(totals).includes(Buffer.from(WORDS)), false, "the totals hold no error text");
});
