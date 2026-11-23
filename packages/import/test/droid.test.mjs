// Factory's Droid CLI: ~/.factory/sessions/<cwd slug>/<session id>.jsonl, with the session's running token total in the
// <session id>.settings.json beside it. Droid writes no request's tokens: the session's total goes on its last request.
// Every record below is made up in the shape Droid 1.17.2 writes (see src/readers/droid.ts): no id, prompt or count is
// copied from a real session.
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { serialize } from "node:v8";
import { normalizeUsage, parseHome, READERS, readSession } from "../dist/index.js";
import { at, jsonl, tempHome, writeJsonl } from "./fixtures.mjs";

const PARENT = "00000000-0000-4000-8000-0000000000d1";
const WORKER = "00000000-0000-4000-8000-0000000000d2";
const FORK = "00000000-0000-4000-8000-0000000000d3";

const droidFile = (home, id = PARENT, project = "-work-fixture") => join(home, ".factory", "sessions", project, `${id}.jsonl`);
const settingsOf = (file) => file.replace(/\.jsonl$/, ".settings.json");
const start = (id, extra = {}) => ({ type: "session_start", id, title: "Fixture title.", owner: "fixture", version: 2, cwd: "/work/fixture", ...extra });
const user = (id, text, i) => ({ type: "message", id, timestamp: at(i), message: { role: "user", content: [{ type: "text", text }] } });
const toolResult = (id, callId, text, i) => ({ type: "message", id, timestamp: at(i), message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: text }] } });
const answer = (id, i, { text = "Done.", call, modelId } = {}) => ({
  type: "message",
  id,
  timestamp: at(i),
  message: { role: "assistant", ...(modelId ? { modelId } : {}), content: [{ type: "text", text }, ...(call ? [{ type: "tool_use", id: call, name: "Read", input: { file_path: "/work/fixture/a.txt" } }] : [])] },
});
const tokens = (input, output, cacheCreation = 0, cacheRead = 0, thinking = 0) => ({ inputTokens: input, outputTokens: output, cacheCreationTokens: cacheCreation, cacheReadTokens: cacheRead, thinkingTokens: thinking });
async function writeSettings(file, tokenUsage, extra = {}) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(settingsOf(file), JSON.stringify({ model: "claude-fixture-1", providerLock: "anthropic", ...(tokenUsage ? { tokenUsage } : {}), ...extra }));
}

const opening = [start(PARENT), user("m1", "Fixture question.", 1), answer("m2", 2, { call: "toolu_1" }), toolResult("m3", "toolu_1", "Fixture file text.", 3), answer("m4", 4)];

test("discovery: every session file under ~/.factory/sessions, a folder deep or flat, and FACTORY_HOME_OVERRIDE moves the home", async (t) => {
  const home = await tempHome(t);
  const nested = await writeJsonl(droidFile(home), opening);
  await writeSettings(nested, tokens(1, 1));
  const flat = await writeJsonl(join(home, ".factory", "sessions", `${FORK}.jsonl`), [start(FORK)]);
  assert.deepEqual((await READERS.droid.discover(home)).map(({ file }) => file).sort(), [flat, nested].sort(), "the settings files are no sessions");
  const other = await tempHome(t);
  const moved = await writeJsonl(droidFile(other), opening);
  assert.deepEqual(await READERS.droid.discover(home, { FACTORY_HOME_OVERRIDE: other }), [{ file: moved }]);
  assert.equal(READERS.droid.name, "Droid");
});

test("a full read: the session's id, model and title, one call per assistant message, and the settings' total once", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(droidFile(home), opening);
  await writeSettings(file, tokens(300, 40, 12, 5000, 25), { inclusiveTokenUsage: tokens(9000, 900, 90, 90000, 0) });
  const session = await readSession(file, "droid");
  assert.equal(session.id, PARENT);
  assert.equal(session.model, "anthropic/claude-fixture-1");
  assert.equal(session.cwd, "/work/fixture");
  assert.equal(session.sourceTitle, "Fixture title.");
  assert.equal(session.users, 1, "a tool result is no prompt of the person's");
  const answers = session.turns.filter((turn) => turn.role === "assistant");
  assert.deepEqual(answers.map((turn) => turn.usage), [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: 300, output: 40, cacheRead: 5000, cacheWrite: 12, reasoning: 25 }]);
  assert.equal(answers[0].calls[0].name, "Read");
  const [line] = await parseHome(home, { sources: ["droid"], catalog: false });
  // tokenUsage alone: inclusiveTokenUsage (its Workers' with it) would count them twice.
  assert.deepEqual(line.tokens, { input: 300, output: 40, cacheRead: 5000, cacheWrite: 12, cacheWrite1h: 0 });
  assert.equal(line.reasoning, 25);
  assert.deepEqual([line.turns, line.calls, line.subagents, line.cost], [1, 2, 0, null]);
});

test("no settings file: the calls still count, tokens 0 and cost null (nothing to price)", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(droidFile(home), opening);
  const [line] = await parseHome(home, { sources: ["droid"], catalog: new Map() });
  assert.deepEqual(line.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  assert.deepEqual([line.calls, line.cost], [2, null]);
});

test("a total with no assistant message read is still counted, on one request of its own", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(droidFile(home), [start(PARENT), user("m1", "Fixture question.", 1)]);
  await writeSettings(file, tokens(7, 3));
  const [line] = await parseHome(home, { sources: ["droid"], catalog: false });
  assert.deepEqual([line.tokens.input, line.tokens.output, line.calls], [7, 3, 1]);
});

test("a resumed read after an append, and a rewritten settings file, equals a fresh read; nothing new reads nothing", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(droidFile(home), opening);
  await writeSettings(file, tokens(100, 10, 0, 1000));
  const first = await READERS.droid.read({ file });
  const idle = await READERS.droid.read({ file }, first.cursor);
  assert.deepEqual([idle.resumed, idle.read], [true, 0], "an unchanged transcript and settings file read nothing");
  const more = [user("m5", "Second question.", 5), answer("m6", 6), answer("m6", 6)];
  await appendFile(file, jsonl(more));
  await writeSettings(file, tokens(250, 30, 4, 3000));
  const resumed = await READERS.droid.read({ file }, first.cursor);
  assert.equal(resumed.resumed, true);
  assert.ok(resumed.read >= Buffer.byteLength(jsonl(more)));
  const fresh = await READERS.droid.read({ file });
  assert.deepEqual(resumed.sessions[0].requests, fresh.sessions[0].requests);
  assert.equal(resumed.sessions[0].requests.length, 3, "m6 written twice is one request");
  assert.deepEqual(resumed.sessions[0].requests.at(-1).usage, { input: 250, output: 30, cacheRead: 3000, cacheWrite: 4, reasoning: 0 });
  assert.deepEqual(resumed.sessions[0].session.users, fresh.sessions[0].session.users);
  // The first read's result is its own: resuming never changes it.
  assert.deepEqual(first.sessions[0].requests.at(-1).usage, { input: 100, output: 10, cacheRead: 1000, cacheWrite: 0, reasoning: 0 });
  // parseHome from its state agrees with a fresh pass.
  const state = {};
  await writeJsonl(droidFile(home, FORK), [start(FORK), user("f1", "Other question.", 1), answer("f2", 2)]);
  await parseHome(home, { sources: ["droid"], catalog: false, state });
  await appendFile(file, jsonl([answer("m7", 7)]));
  await writeSettings(file, tokens(260, 33, 4, 3500));
  assert.deepEqual(await parseHome(home, { sources: ["droid"], catalog: false, state }), await parseHome(home, { sources: ["droid"], catalog: false }));
});

test("turns false: no prompt, title, working directory, answer or tool output in the requests or the cursor", async (t) => {
  const home = await tempHome(t);
  const WORDS = ["Fixture prompt, never kept.", "Fixture answer, never kept.", "Fixture tool output, never kept.", "Fixture title, never kept.", "/fixture/cwd/never/kept"];
  const file = await writeJsonl(droidFile(home), [start(PARENT, { title: WORDS[3], sessionTitle: WORDS[3], cwd: WORDS[4] }), user("m1", WORDS[0], 1), answer("m2", 2, { text: WORDS[1], call: "toolu_1" }), toolResult("m3", "toolu_1", WORDS[2], 3)]);
  await writeSettings(file, tokens(10, 2));
  const result = await READERS.droid.read({ file }, undefined, { turns: false });
  for (const request of result.sessions[0].requests) assert.equal(request.text, "");
  const cursor = serialize(result.cursor);
  const requests = serialize(result.sessions[0].requests);
  for (const text of WORDS) {
    assert.equal(cursor.includes(Buffer.from(text)), false, `the cursor holds no ${text}`);
    assert.equal(requests.includes(Buffer.from(text)), false, `the requests hold no ${text}`);
  }
  const state = {};
  await parseHome(home, { sources: ["droid"], catalog: false, state });
  for (const text of WORDS) assert.equal(serialize(state).includes(Buffer.from(text)), false, `parseHome's state holds no ${text}`);
});

test("normalizeUsage('droid'): inputTokens already leaves the cache out; thinkingTokens is part of outputTokens", () => {
  assert.deepEqual(normalizeUsage("droid", tokens(300, 40, 12, 5000, 25)), { input: 300, output: 40, cacheRead: 5000, cacheWrite: 12, reasoning: 25 });
  // No thinking named: none. A thinking count over the whole output is dropped, never added.
  assert.deepEqual(normalizeUsage("droid", { inputTokens: 7, outputTokens: 3 }), { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(normalizeUsage("droid", tokens(1, 2, 0, 0, 9)), { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(normalizeUsage("droid", { outputTokens: 3 }), undefined);
  assert.equal(normalizeUsage("droid", tokens(-1, 2)), undefined);
});

test("a Worker (session_start names its calling session) counts under its parent, each at its own tokenUsage", async (t) => {
  const home = await tempHome(t);
  const parent = await writeJsonl(droidFile(home), opening);
  await writeSettings(parent, tokens(300, 40, 12, 5000), { inclusiveTokenUsage: tokens(350, 45, 12, 5100) });
  const worker = await writeJsonl(droidFile(home, WORKER), [start(WORKER, { title: "worker: Fixture task.", callingSessionId: PARENT, callingToolUseId: "toolu_1" }), user("w1", "Fixture task prompt.", 2), answer("w2", 3)]);
  await writeSettings(worker, tokens(50, 5, 0, 100));
  const sessions = await parseHome(home, { sources: ["droid"], catalog: false });
  assert.equal(sessions.length, 1, "the Worker is no session of its own");
  assert.deepEqual(sessions[0].tokens, { input: 350, output: 45, cacheRead: 5100, cacheWrite: 12, cacheWrite1h: 0 });
  assert.deepEqual([sessions[0].turns, sessions[0].calls, sessions[0].subagents], [1, 3, 1], "the Worker's prompt is its parent agent's");
  assert.equal((await readSession(worker, "droid")).parent, PARENT);
});

test("a fork's copied messages count once, in the first file; its own total starts at zero and adds", async (t) => {
  const home = await tempHome(t);
  const parent = await writeJsonl(droidFile(home), opening);
  await writeSettings(parent, tokens(300, 40));
  const fork = await writeJsonl(droidFile(home, FORK), [start(FORK, { parent: PARENT }), ...opening.slice(1), answer("f1", 9)]);
  await writeSettings(fork, tokens(20, 2));
  const sessions = await parseHome(home, { sources: ["droid"], catalog: false });
  const calls = sessions.reduce((n, line) => n + line.calls, 0);
  const output = sessions.reduce((n, line) => n + line.tokens.output, 0);
  assert.deepEqual([sessions.length, calls, output], [2, 3, 42]);
});
