// Gemini CLI as a source: ~/.gemini/tmp/<project>/chats/session-*.jsonl (append-only records: a message written again
// replaces the one with its id, $patch and $rewindTo edit it) and the legacy whole-file session-*.json. Cached tokens
// are a subset of the input; thoughts are billed as output.
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { serialize } from "node:v8";
import { HARNESS_OF, normalizeUsage, parseHome, READERS, readSession, SOURCES } from "../dist/index.js";
import { sessionIdOf } from "../dist/readers/gemini.js";
import { jsonl, tempHome } from "./fixtures.mjs";
import { chatsDir, GEMINI_SESSION, geminiAnswer, geminiFile, geminiMeta, geminiSubagentFile, geminiTokens, geminiUser, writeGemini, writeLegacy } from "./gemini-fixtures.mjs";

const WORDS = "Fixture answer words, never kept.";
const totals = async (home, options = {}) => parseHome(home, { sources: ["gemini"], catalog: false, ...options });

test("gemini is a registered source, run by pi (serve has no Gemini harness)", () => {
  assert.ok(SOURCES.includes("gemini"));
  assert.equal(READERS.gemini.source, "gemini");
  assert.equal(READERS.gemini.name, "Gemini CLI");
  assert.equal(HARNESS_OF.gemini, "pi");
});

test("usage: prompt tokens hold the cached ones; thoughts are output; tool-use prompt tokens are input", () => {
  // 1500 prompt, 1200 of them cached: 300 uncached; 30 tool-use prompt tokens more input: 330. 400 candidates + 250
  // thoughts: 650 output, 250 of them reasoning.
  assert.deepEqual(normalizeUsage("gemini", geminiTokens(1500, 400, 1200, 250, 30)), { input: 330, output: 650, cacheRead: 1200, cacheWrite: 0, reasoning: 250 });
  // No thoughts, tool or cached count named: none of them.
  assert.deepEqual(normalizeUsage("gemini", { input: 7, output: 3, total: 10 }), { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
  // A cache count over the prompt, or no counts, is no usage at all.
  assert.equal(normalizeUsage("gemini", geminiTokens(10, 5, 20)), undefined);
  assert.equal(normalizeUsage("gemini", { output: 3 }), undefined);
  assert.equal(normalizeUsage("gemini", null), undefined);
});

test("discover: the session files of every project, never logs.json, a subagent's file or a file of another name; GEMINI_CLI_HOME names the home", async (t) => {
  const home = await tempHome(t);
  const a = await writeGemini(geminiFile(home), [geminiMeta()]);
  const legacy = await writeLegacy(geminiFile(home, "99999999-0000-4000-8000-000000000000", { ext: "json" }), { id: "99999999-0000-4000-8000-000000000000", messages: [] });
  const other = await writeGemini(geminiFile(home, "aaaaaaaa-0000-4000-8000-000000000000", { project: "second" }), [geminiMeta({ id: "aaaaaaaa-0000-4000-8000-000000000000" })]);
  await writeGemini(geminiSubagentFile(home), [geminiMeta({ id: "sub-agent-1", kind: "subagent" })]);
  await writeFile(join(chatsDir(home), "notes.txt"), "not a session\n");
  await writeFile(join(home, ".gemini", "tmp", "fixture-project", "logs.json"), "[]");
  const found = (await READERS.gemini.discover(home)).map(({ file }) => file).sort();
  assert.deepEqual(found, [a, legacy, other].sort());
  const moved = await tempHome(t);
  assert.deepEqual(await READERS.gemini.discover(join(moved, "nowhere")), []);
  assert.deepEqual((await READERS.gemini.discover(moved, { GEMINI_CLI_HOME: home })).map(({ file }) => file).sort(), found);
});

test("a read counts each message once, as the file ends: a message written again replaces the first, $patch and $rewindTo edit", async (t) => {
  const home = await tempHome(t);
  const file = await writeGemini(geminiFile(home), [
    geminiMeta(),
    geminiUser("u1", "Fixture question."),
    // The CLI writes a message again when its tool calls or tokens arrive: the id is the request.
    geminiAnswer("a1", "", null, 2, { toolCalls: [{ id: "c1", name: "read_file", args: { path: "x" }, status: "success", timestamp: "2026-01-01T00:00:02.000Z" }] }),
    geminiAnswer("a1", "", geminiTokens(100, 20, 60, 5), 2, { toolCalls: [{ id: "c1", name: "read_file", args: { path: "x" }, status: "success", timestamp: "2026-01-01T00:00:02.000Z" }] }),
    { $patch: { id: "a1", content: WORDS } },
    geminiUser("u2", "Second question.", 3),
    geminiAnswer("a2", "Done.", geminiTokens(200, 10, 0), 4),
    geminiUser("u3", "Rewound away.", 5),
    geminiAnswer("a3", "Gone.", geminiTokens(9000, 9000), 6),
    { $rewindTo: "u3" },
  ]);
  const session = await readSession(file, "gemini");
  assert.equal(session.id, GEMINI_SESSION);
  assert.equal(session.users, 2);
  assert.equal(session.model, "google/gemini-fixture-pro");
  const requests = (await READERS.gemini.read({ file })).sessions[0].requests;
  assert.deepEqual(requests.map((r) => [r.key, r.usage]), [
    ["a1", { input: 40, output: 25, cacheRead: 60, cacheWrite: 0, reasoning: 5 }],
    ["a2", { input: 200, output: 10, cacheRead: 0, cacheWrite: 0 }],
  ]);
  assert.equal(requests[0].text, WORDS);
  assert.deepEqual(requests[0].calls.map((c) => [c.id, c.name, c.arguments]), [["c1", "read_file", { path: "x" }]]);
  const [line, ...rest] = await totals(home);
  assert.equal(rest.length, 0);
  assert.deepEqual([line.tokens.input, line.tokens.output, line.tokens.cacheRead, line.calls, line.turns, line.reasoning], [240, 35, 60, 2, 2, 5]);
});

test("a legacy session-*.json is read as the whole record it is, and the same session in a .jsonl beside it counts once", async (t) => {
  const home = await tempHome(t);
  const messages = [geminiUser("u1", "Fixture question."), geminiAnswer("a1", "Done.", geminiTokens(100, 20, 60), 2)];
  await writeLegacy(geminiFile(home, GEMINI_SESSION, { ext: "json" }), { messages });
  const [alone] = await totals(home);
  assert.deepEqual([alone.tokens.input, alone.tokens.output, alone.tokens.cacheRead, alone.calls, alone.turns], [40, 20, 60, 1, 1]);
  // The CLI migrates a legacy file on resume: the same messages in a new .jsonl, and more.
  await writeGemini(geminiFile(home), [geminiMeta(), ...messages, geminiAnswer("a2", "More.", geminiTokens(10, 1), 3)]);
  const both = await totals(home);
  assert.equal(both.length, 1, "one session");
  assert.deepEqual([both[0].tokens.input, both[0].tokens.output, both[0].calls, both[0].turns], [50, 21, 2, 1]);
});

test("a cursor: an unchanged file reads nothing; an appended record is counted once on the next pass, never twice", async (t) => {
  const home = await tempHome(t);
  const file = await writeGemini(geminiFile(home), [geminiMeta(), geminiUser("u1", "Fixture question."), geminiAnswer("a1", "Done.", geminiTokens(100, 20), 2)]);
  const first = await READERS.gemini.read({ file });
  const same = await READERS.gemini.read({ file }, first.cursor);
  assert.equal(same.resumed, true);
  assert.equal(same.read, 0);
  assert.equal(same.sessions[0].requests.length, 1);
  const state = {};
  const [one] = await totals(home, { state });
  assert.equal(one.calls, 1);
  await appendFile(file, jsonl([geminiAnswer("a1", "Done.", geminiTokens(100, 25), 2), geminiAnswer("a2", "More.", geminiTokens(7, 3), 3)]));
  const [two] = await totals(home, { state });
  assert.deepEqual([two.calls, two.tokens.input, two.tokens.output], [2, 107, 28], "a1 at its last counts, a2 once");
  assert.ok(state.read > 0);
  const [fresh] = await totals(home);
  assert.deepEqual(two, fresh, "a second pass is what a fresh one is");
  const resumed = await READERS.gemini.read({ file }, structuredClone(first.cursor));
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.sessions[0].requests.length, 2);
});

test("a subagent's file under its parent's id joins the parent's totals; one with no parent under the home has a line of its own", async (t) => {
  const home = await tempHome(t);
  await writeGemini(geminiFile(home), [geminiMeta(), geminiUser("u1", "Fixture question."), geminiAnswer("a1", "Done.", geminiTokens(100, 20), 2)]);
  await writeGemini(geminiSubagentFile(home), [geminiMeta({ id: "sub-agent-1", kind: "subagent" }), geminiUser("su1", "Subtask."), geminiAnswer("sa1", "Sub done.", geminiTokens(1000, 200), 3)]);
  await writeGemini(geminiSubagentFile(home, "ffffffff-0000-4000-8000-000000000000", "orphan"), [geminiMeta({ id: "orphan", kind: "subagent" }), geminiAnswer("oa1", "Orphan.", geminiTokens(5, 5), 3)]);
  const lines = await totals(home);
  const parent = lines.find((line) => line.id === GEMINI_SESSION);
  assert.deepEqual([parent.tokens.input, parent.tokens.output, parent.calls, parent.turns, parent.subagents], [1100, 220, 2, 1, 1]);
  const orphan = lines.find((line) => line.id === "orphan");
  assert.deepEqual([orphan.tokens.input, orphan.turns, orphan.calls], [5, 0, 1]);
  assert.equal(lines.length, 2);
});

test("turns false keeps no answer text in the requests, the sessions or the cursor", async (t) => {
  const home = await tempHome(t);
  const file = await writeGemini(geminiFile(home), [geminiMeta({ summary: "A title in words." }), geminiUser("u1", "Fixture prompt."), geminiAnswer("a1", WORDS, geminiTokens(10, 2), 2, { thoughts: [{ subject: "S", description: "Thought words.", timestamp: "2026-01-01T00:00:02.000Z" }] })]);
  const result = await READERS.gemini.read({ file }, undefined, { turns: false });
  assert.equal(result.sessions[0].requests[0].text, "");
  for (const word of [WORDS, "Fixture prompt.", "A title in words.", "Thought words."]) {
    assert.equal(serialize(result.cursor).includes(Buffer.from(word)), false, `the cursor holds ${word}`);
    assert.equal(serialize(result.sessions).includes(Buffer.from(word)), false, `the sessions hold ${word}`);
  }
  const kept = await READERS.gemini.read({ file }, undefined, { turns: true });
  assert.equal(kept.sessions[0].requests[0].text, WORDS);
});

test("a broken line, and a last line still being written, are passed over", async (t) => {
  const home = await tempHome(t);
  const file = geminiFile(home);
  await mkdir(chatsDir(home), { recursive: true });
  await writeFile(file, `${JSON.stringify(geminiMeta())}\nnot json\n${JSON.stringify(geminiAnswer("a1", "Done.", geminiTokens(1, 1)))}\n{"id":"a2","type":"gemini","tokens":{"input":5`);
  const [line] = await totals(home);
  assert.equal(line.calls, 1, "the half-written last line is not a request yet");
});

test("cwd: the project's path from the CLI's projects.json (or the .project_root marker), else none; a listing's cursor holds none", async (t) => {
  const home = await tempHome(t);
  const messages = [geminiMeta(), geminiUser("u1", "Fixture question."), geminiAnswer("a1", "Done.", geminiTokens(1, 1))];
  const file = await writeGemini(geminiFile(home), messages);
  const second = await writeGemini(geminiFile(home, "22222222-2222-4222-8222-222222222222", { project: "marked" }), [geminiMeta({ id: "22222222-2222-4222-8222-222222222222" })]);
  const third = await writeGemini(geminiFile(home, "33333333-3333-4333-8333-333333333333", { project: "unlisted" }), [geminiMeta({ id: "33333333-3333-4333-8333-333333333333" })]);
  const sub = await writeGemini(geminiSubagentFile(home), [geminiMeta({ id: "sub-agent-1", kind: "subagent" })]);
  // The registry maps a project's path to its id; the marker in the project's directory names the path itself.
  await writeFile(join(home, ".gemini", "projects.json"), JSON.stringify({ projects: { "/work/fixture": "fixture-project", "/work/other": "marked" } }));
  await writeFile(join(home, ".gemini", "tmp", "marked", ".project_root"), "/work/marked\n");
  const cwd = async (path, options) => (await readSession(path, "gemini", options)).cwd;
  assert.equal(await cwd(file), "/work/fixture");
  assert.equal(await cwd(sub), "/work/fixture", "a subagent's is its project's");
  assert.equal(await cwd(second), "/work/marked", "the marker names the path itself");
  assert.equal(await cwd(third), undefined, "a project in neither: none, never the id");
  assert.equal(await cwd(file, { turns: false }), "/work/fixture", "a listing has it, as the other sources' do: an import needs the project");
  assert.equal(serialize((await READERS.gemini.read({ file }, undefined, { turns: false })).cursor).includes(Buffer.from("/work/fixture")), false);
});

test("a session's id is the one its record names, else its file's name without the extension: one rule, exported", async (t) => {
  assert.equal(sessionIdOf("/x/chats/session-2026-01-01T00-00-abcd1234.jsonl", "recorded-id"), "recorded-id");
  assert.equal(sessionIdOf("/x/chats/session-2026-01-01T00-00-abcd1234.jsonl"), "session-2026-01-01T00-00-abcd1234");
  assert.equal(sessionIdOf("/x/chats/session-old.json"), "session-old");
  // The reader uses it: a file with no session record is named for its file.
  const home = await tempHome(t);
  const file = await writeGemini(geminiFile(home), [geminiUser("u1", "Fixture question.")]);
  assert.equal((await readSession(file, "gemini")).id, sessionIdOf(file));
});
