// Factory's Droid CLI: ~/.factory/sessions/<cwd slug>/<session id>.jsonl, with the session's running token total in the
// <session id>.settings.json beside it. Droid writes no request's tokens: the session's total goes on its last request.
// Every record below is made up in the shape Droid 1.17.2 writes (see src/readers/droid.ts): no id, prompt or count is
// copied from a real session.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { serialize } from "node:v8";
import { droidSessionId, normalizeUsage, parseHome, READERS, readSession } from "../dist/index.js";
import { at, tempHome, writeJsonl } from "./fixtures.mjs";

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
const outcome = (turnId, reason) => ({ type: "agent_turn_outcome", turnId, reason });
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
  assert.deepEqual(answers.map((turn) => turn.folded), [true, undefined], "the first request's zeros are counted in the last's total");
  const [line] = await parseHome(home, { sources: ["droid"], catalog: false });
  // tokenUsage alone: inclusiveTokenUsage (its Workers' with it) would count them twice.
  assert.deepEqual(line.tokens, { input: 300, output: 40, cacheRead: 5000, cacheWrite: 12, cacheWrite1h: 0 });
  assert.equal(line.reasoning, 25);
  assert.deepEqual([line.turns, line.calls, line.subagents, line.cost], [1, 2, 0, null]);
  // The working directory is the session's whatever turns is (serve's plan reads without turns); totals hold none.
  assert.equal((await READERS.droid.read({ file }, undefined, { turns: false })).sessions[0].session.cwd, "/work/fixture");
  assert.equal(JSON.stringify(line).includes("/work/fixture"), false, "the totals hold no working directory");
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

test("turns false: no prompt, title, working directory, answer or tool output in the requests or the cursor; a failed request's error is a fixed \"API error\"", async (t) => {
  const home = await tempHome(t);
  const WORDS = ["Fixture prompt, never kept.", "Fixture answer, never kept.", "Fixture tool output, never kept.", "Fixture title, never kept.", "/fixture/cwd/never/kept"];
  const file = await writeJsonl(droidFile(home), [start(PARENT, { title: WORDS[3], sessionTitle: WORDS[3], cwd: WORDS[4] }), user("m1", WORDS[0], 1), answer("m2", 2, { text: WORDS[1], call: "toolu_1" }), toolResult("m3", "toolu_1", WORDS[2], 3), outcome("t1", "model_rate_limited")]);
  await writeSettings(file, tokens(10, 2));
  const result = await READERS.droid.read({ file }, undefined, { turns: false });
  for (const request of result.sessions[0].requests) assert.equal(request.text, "");
  assert.deepEqual(result.sessions[0].requests.map((request) => request.error), [undefined, "API error"]);
  const cursor = serialize(result.cursor);
  const requests = serialize(result.sessions[0].requests);
  for (const text of WORDS) {
    assert.equal(cursor.includes(Buffer.from(text)), false, `the cursor holds no ${text}`);
    assert.equal(requests.includes(Buffer.from(text)), false, `the requests hold no ${text}`);
  }
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

test("droidSessionId: session_start's id, else the file's name; the reader and serve read it alike", async (t) => {
  assert.equal(droidSessionId(`/x/${FORK}.jsonl`, start(PARENT)), PARENT);
  assert.equal(droidSessionId(`/x/${FORK}.jsonl`), FORK);
  assert.equal(droidSessionId(`/x/${FORK}.jsonl`, { type: "message", id: PARENT }), FORK, "only a session_start names the session");
  assert.equal(droidSessionId(`/x/${FORK}.jsonl`, start("")), FORK);
  const home = await tempHome(t);
  const bare = await writeJsonl(droidFile(home, FORK), [user("m1", "Fixture question.", 1)]);
  assert.equal((await readSession(bare, "droid")).id, FORK);
  const named = await writeJsonl(droidFile(home, WORKER), [start(PARENT), user("m2", "Fixture question.", 1)]);
  assert.equal((await readSession(named, "droid")).id, PARENT);
});

test("a turn's outcome: a refused or unanswered request is one more request, failed, its reason the error with turns", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(droidFile(home), [...opening, outcome("t1", "completed"), user("m5", "Second question.", 5), outcome("t2", "model_provider_unreachable")]);
  await writeSettings(file, tokens(100, 10));
  const session = await readSession(file, "droid");
  assert.equal(session.state, "failed");
  const answers = session.turns.filter((turn) => turn.role === "assistant");
  assert.deepEqual(answers.map((turn) => turn.error), [undefined, undefined, "model_provider_unreachable"]);
  assert.deepEqual(answers.at(-1).usage, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, "the total sits on the last request");
  const [line] = await parseHome(home, { sources: ["droid"], catalog: false });
  assert.deepEqual([line.calls, line.tokens.input], [3, 100]);
  // Droid's own failure is the session's, no request; the person's cancel stops it; a later turn's end is what holds.
  const own = await writeJsonl(droidFile(home, WORKER), [start(WORKER), user("w1", "Fixture question.", 1), answer("w2", 2), outcome("t3", "host_resources_exhausted")]);
  const failed = await readSession(own, "droid");
  assert.deepEqual([failed.state, failed.turns.filter((turn) => turn.role === "assistant").length], ["failed", 1]);
  await writeJsonl(own, [start(WORKER), user("w1", "Fixture question.", 1), answer("w2", 2), outcome("t3", "cancelled")]);
  assert.equal((await readSession(own, "droid")).state, "stopped");
  await writeJsonl(own, [start(WORKER), outcome("t3", "model_rate_limited"), user("w1", "Fixture question.", 1), answer("w2", 2), outcome("t4", "completed")]);
  assert.equal((await readSession(own, "droid")).state, "completed");
});

test("a fork's copy of its source's failed turn is no second failed request", async (t) => {
  const home = await tempHome(t);
  const failing = [...opening, outcome("t1", "model_rate_limited")];
  await writeJsonl(droidFile(home), failing);
  await writeJsonl(droidFile(home, FORK), [start(FORK, { parent: PARENT }), ...failing.slice(1), user("f1", "Fork question.", 9), answer("f2", 10)]);
  const sessions = await parseHome(home, { sources: ["droid"], catalog: false });
  assert.deepEqual(sessions.map((line) => line.calls).sort(), [1, 3]);
});

test("cost: the total at the price of the model settings.json names, else the last request's; with neither, or no tokenUsage, null", async (t) => {
  const catalog = new Map([
    ["claude-fixture-1", [{ provider: "anthropic", cost: { input: 1, output: 10, cacheRead: 0.5, cacheWrite: 2 } }]],
    ["gpt-fixture-2", [{ provider: "openai", cost: { input: 3, output: 30, cacheRead: 1, cacheWrite: 0 } }]],
  ]);
  // Per million tokens, as pi-ai's calculateCost.
  const calculateCost = ({ cost }, usage) => ({ total: (usage.input * cost.input + usage.output * cost.output + usage.cacheRead * cost.cacheRead + usage.cacheWrite * cost.cacheWrite) / 1e6 });
  const costOf = async (settings, messages = opening) => {
    const home = await tempHome(t);
    const file = await writeJsonl(droidFile(home), messages);
    await mkdir(join(file, ".."), { recursive: true });
    if (settings) await writeFile(settingsOf(file), JSON.stringify(settings));
    const [line] = await parseHome(home, { sources: ["droid"], catalog, calculateCost });
    return line.cost;
  };
  const usage = tokens(1_000_000, 100_000, 0, 2_000_000);
  // 1M input at $1, 100k output at $10, 2M cache reads at $0.50: $3.
  assert.equal(await costOf({ model: "claude-fixture-1", tokenUsage: usage }), 3);
  // No model named: the last request's own (gpt-fixture-2 at openai's price: $3 + $3 + $2).
  assert.equal(await costOf({ tokenUsage: usage }, [...opening.slice(0, -1), answer("m4", 4, { modelId: "gpt-fixture-2" })]), 8);
  // Both named: settings.json's, the session's latest, wins over the request's own.
  assert.equal(await costOf({ model: "claude-fixture-1", tokenUsage: usage }, [...opening.slice(0, -1), answer("m4", 4, { modelId: "gpt-fixture-2" })]), 3);
  assert.equal(await costOf({ tokenUsage: usage }), null, "no model anywhere");
  assert.equal(await costOf({ model: "claude-fixture-1" }), null, "no tokenUsage: unmetered");
  assert.equal(await costOf(undefined), null, "no settings.json: unmetered");
  assert.equal(await costOf({ model: "claude-unlisted-9", tokenUsage: usage }), null, "a model the catalog does not list");
});
