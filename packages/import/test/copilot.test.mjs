// GitHub Copilot CLI: $COPILOT_HOME (~/.copilot)/session-state/<session id>/events.jsonl, one session event a line. The
// events are made up here in the shape the CLI writes them (github/copilot-sdk nodejs/src/generated/session-events.ts):
// nothing is copied from a real session. Copilot writes no request's tokens to disk; a session.shutdown holds each
// model's tokens since the process started (since the session began, where it says it restored its accounting).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { serialize } from "node:v8";
import { normalizeUsage, parseHome, READERS, readSession, sessionLocators } from "../dist/index.js";
import { at, jsonl, tempHome, writeJsonl } from "./fixtures.mjs";

const SID = "11111111-2222-4333-8444-555555555555";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const copilotFile = (home, id = SID) => join(home, ".copilot", "session-state", id, "events.jsonl");
/** One persisted event: its id is `e<i>` unless `id` says otherwise, its time the i-th second. */
const ev = (i, type, data, extra = {}) => ({ type, data, id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: at(i), ...extra });
const start = (i = 0, id = SID) => ev(i, "session.start", { sessionId: id, version: 1, producer: "copilot-agent", copilotVersion: "1.0.40", startTime: at(i), selectedModel: "claude-sonnet-4.5", reasoningEffort: "high", context: { cwd: "/work/fixture" } });
const user = (i, content, data = {}, extra = {}) => ev(i, "user.message", { content, ...data }, extra);
const answer = (i, messageId, content, data = {}, extra = {}) => ev(i, "assistant.message", { messageId, model: "claude-sonnet-4.5", content, ...data }, extra);
/** A model's shutdown metric, its input holding its cache read and write. */
const metric = (input, output, cacheRead = 0, cacheWrite = 0, reasoning) => ({ requests: { count: 1, cost: 1 }, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}) } });
const shutdown = (i, modelMetrics, data = {}) => ev(i, "session.shutdown", { shutdownType: "routine", totalApiDurationMs: 1000, sessionStartTime: Date.parse(at(0)), codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] }, modelMetrics, ...data });

// One session: a tool call that failed, a response split into two messages, an autopilot continuation and a subagent's
// prompt (neither the person's), a subagent's answer on another model, and a model (a compaction's) with no message.
const FIRST = [
  start(0),
  user(1, "Fixture question."),
  ev(2, "assistant.turn_start", { turnId: "0" }),
  answer(3, "msg-1", "Looking.", { toolRequests: [{ toolCallId: "call-1", name: "bash", arguments: { command: "ls" } }] }),
  ev(4, "tool.execution_start", { toolCallId: "call-1", toolName: "bash", arguments: { command: "ls" } }),
  ev(5, "tool.execution_complete", { toolCallId: "call-1", success: false, error: { message: "exit 1" } }),
  answer(6, "msg-2", "First part.", { chunkIndex: 0, chunkCount: 2 }),
  answer(7, "msg-3", "Second part.", { chunkIndex: 1, chunkCount: 2 }),
  user(8, "Continue.", { isAutopilotContinuation: true }),
  user(9, "Subagent task.", { source: "agent-sub-1" }, { agentId: "sub-1" }),
  answer(10, "msg-4", "Sub answer.", { model: "gpt-5-mini" }, { agentId: "sub-1" }),
  shutdown(11, { "claude-sonnet-4.5": metric(5000, 300, 3000, 500, 100), "gpt-5-mini": metric(800, 50), "claude-haiku-4.5": metric(400, 20) }),
];
// The same session resumed by a CLI that kept no accounting across processes: its shutdown counts this process alone.
const RESUMED = [
  ev(12, "session.resume", { resumeTime: at(12), eventCount: 12, context: { cwd: "/work/fixture" } }),
  user(13, "Next question."),
  answer(14, "msg-5", "Done."),
  shutdown(15, { "claude-sonnet-4.5": metric(1000, 40, 600) }),
];

const usages = (result) => result.sessions[0].requests.map((request) => [request.key ?? null, request.usage ?? null]);

test("Copilot CLI: discovery finds each session's events.jsonl, an older flat <id>.jsonl, under COPILOT_HOME when it is set", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(copilotFile(home), [start()]);
  const flat = await writeJsonl(join(home, ".copilot", "session-state", "22222222-0000-4000-8000-000000000000.jsonl"), [start(0, "22222222-0000-4000-8000-000000000000")]);
  // A session folder with no events yet, and a file that is no session: none.
  await mkdir(join(home, ".copilot", "session-state", "33333333-0000-4000-8000-000000000000"), { recursive: true });
  await writeFile(join(home, ".copilot", "session-state", "notes.txt"), "not a session");
  assert.deepEqual(await sessionLocators(home, "copilot"), [{ file: flat }, { file }].sort((a, b) => (a.file < b.file ? -1 : 1)));
  const elsewhere = join(home, "elsewhere");
  const moved = await writeJsonl(join(elsewhere, "session-state", SID, "events.jsonl"), [start()]);
  assert.deepEqual(await sessionLocators(home, "copilot", { env: { COPILOT_HOME: elsewhere } }), [{ file: moved }]);
  assert.deepEqual(await sessionLocators(join(home, "empty"), "copilot"), []);
});

test("Copilot CLI: a full read: the person's turns, one request per model call, failed tool calls, and the shutdown's tokens", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(copilotFile(home), FIRST);
  const session = await readSession(file, "copilot");
  assert.equal(session.id, SID);
  assert.equal(session.cwd, "/work/fixture");
  assert.equal(session.model, "github-copilot/claude-sonnet-4.5");
  assert.equal(session.effort, "high");
  assert.equal(session.firstPrompt, "Fixture question.");
  assert.equal(session.users, 1, "an autopilot continuation and a subagent's prompt are not the person's");
  assert.equal(session.state, "completed");
  const requests = session.turns.filter((turn) => turn.role === "assistant");
  assert.deepEqual(requests.map((turn) => [turn.key ?? null, turn.text, turn.model]), [
    ["msg-1", "Looking.", "github-copilot/claude-sonnet-4.5"],
    ["msg-2", "First part.\nSecond part.", "github-copilot/claude-sonnet-4.5"],
    ["msg-4", "Sub answer.", "github-copilot/gpt-5-mini"],
    [null, "", "github-copilot/claude-haiku-4.5"],
  ]);
  assert.deepEqual(requests[0].calls, [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }]);
  const result = session.turns.find((turn) => turn.role === "toolResult");
  assert.deepEqual([result.callId, result.name, result.text, result.isError], ["call-1", "bash", "exit 1", true]);
  // Each model's tokens on its last request; input is what neither the cache read nor wrote (5000 - 3000 - 500). A request
  // before it, of the same model and process, is folded into it: zeros, known.
  assert.deepEqual(requests.map((turn) => turn.usage ?? null), [
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: 1500, output: 300, cacheRead: 3000, cacheWrite: 500, reasoning: 100 },
    { input: 800, output: 50, cacheRead: 0, cacheWrite: 0 },
    { input: 400, output: 20, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.deepEqual(requests.map((turn) => turn.folded ?? false), [true, false, false, false]);
  const [totals] = await parseHome(home, { sources: ["copilot"] });
  assert.deepEqual(totals, {
    key: sha(`.copilot/session-state/${SID}/events.jsonl`),
    file: `.copilot/session-state/${SID}/events.jsonl`,
    source: "copilot",
    id: SID,
    tokens: { input: 2700, output: 370, cacheRead: 3000, cacheWrite: 500, cacheWrite1h: 0 },
    reasoning: 100,
    cost: null,
    turns: 1,
    calls: 4,
    subagents: 0,
  });
});

test("Copilot CLI: a session with no shutdown (still running, or killed) has its requests at unknown tokens, cost null", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(copilotFile(home), FIRST.slice(0, -1));
  const requests = (await readSession(file, "copilot")).turns.filter((turn) => turn.role === "assistant");
  assert.deepEqual(requests.map((turn) => [turn.usage ?? null, turn.folded ?? false]), [[null, false], [null, false], [null, false]], "unknown, none folded");
  const [totals] = await parseHome(home, { sources: ["copilot"] });
  assert.deepEqual([totals.tokens.input, totals.tokens.output, totals.cost, totals.calls, totals.turns], [0, 0, null, 3, 1]);
});

test("Copilot CLI: a read resumed from any line's cursor, after the rest is appended, equals a fresh read", async (t) => {
  const home = await tempHome(t);
  const all = [...FIRST, ...RESUMED];
  const file = copilotFile(home);
  for (const keep of [true, false]) {
    await writeJsonl(file, all);
    const fresh = await READERS.copilot.read({ file }, undefined, { turns: keep });
    for (let cut = 1; cut < all.length; cut += 1) {
      await writeJsonl(file, all.slice(0, cut));
      const first = await READERS.copilot.read({ file }, undefined, { turns: keep });
      const more = jsonl(all.slice(cut));
      await appendFile(file, more);
      const resumed = await READERS.copilot.read({ file }, first.cursor, { turns: keep });
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.read, Buffer.byteLength(more), "only the appended bytes are read");
      assert.deepEqual(usages(resumed), usages(fresh), `cut at ${cut}, turns ${keep}`);
      assert.equal(resumed.sessions[0].session.users, fresh.sessions[0].session.users);
      if (keep) assert.deepEqual(resumed.sessions[0].session, fresh.sessions[0].session, `cut at ${cut}`);
    }
  }
  // A process that kept no accounting: its shutdown counts its own requests, added to the first's.
  const fresh = await READERS.copilot.read({ file });
  assert.deepEqual(usages(fresh).slice(-1), [["msg-5", { input: 400, output: 40, cacheRead: 600, cacheWrite: 0 }]]);
  assert.equal(fresh.sessions[0].session.users, 2);
});

test("Copilot CLI: a shutdown that restored its accounting holds the session's whole total: only what it adds counts", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(copilotFile(home), [
    start(0),
    user(1, "Fixture question."),
    answer(2, "msg-1", "One."),
    ev(3, "session.usage_checkpoint", { totalNanoAiu: 10 }),
    shutdown(4, { "claude-sonnet-4.5": metric(1000, 100, 200) }, { usageAccountingWatermarks: { main: 3 } }),
    ev(5, "session.resume", { resumeTime: at(5), eventCount: 5 }),
    user(6, "Next."),
    answer(7, "msg-2", "Two."),
    shutdown(8, { "claude-sonnet-4.5": metric(1500, 160, 300) }, { usageAccountingWatermarks: { main: 6 } }),
  ]);
  const result = await READERS.copilot.read({ file });
  assert.deepEqual(usages(result), [
    ["msg-1", { input: 800, output: 100, cacheRead: 200, cacheWrite: 0 }],
    ["msg-2", { input: 400, output: 60, cacheRead: 100, cacheWrite: 0 }],
  ]);
  const [totals] = await parseHome(home, { sources: ["copilot"] });
  assert.deepEqual(totals.tokens, { input: 1200, output: 160, cacheRead: 300, cacheWrite: 0, cacheWrite1h: 0 }, "the last total, not 2500 in");
});

test("Copilot CLI: a journal's checkpoint records (a rotated head's copy of its archive), a repeated event and a repeated message count once", async (t) => {
  const home = await tempHome(t);
  const copy = { checkpoint: true };
  const file = await writeJsonl(copilotFile(home), [
    ev(0, "session.journal_link", { previousFile: "events.1.jsonl", sessionId: SID, version: 1 }),
    { ...start(1), ...copy },
    { ...user(2, "Archived question."), ...copy },
    { ...answer(3, "msg-0", "Archived answer."), ...copy },
    user(4, "Fixture question."),
    answer(5, "msg-1", "One."),
    // The same event again, and the same message under another event id: neither is a new request.
    answer(5, "msg-1", "One."),
    answer(6, "msg-1", "One."),
    shutdown(7, { "claude-sonnet-4.5": metric(100, 10) }, { usageAccountingWatermarks: { main: 6 } }),
  ]);
  const result = await READERS.copilot.read({ file });
  const { session } = result.sessions[0];
  assert.equal(session.id, SID, "read from the checkpoint's session.start");
  assert.equal(session.cwd, "/work/fixture");
  assert.equal(session.users, 1);
  assert.equal(session.copies, 5);
  assert.deepEqual(usages(result), [["msg-1", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }]]);
  // Two sessions that hold the same events (a fork's copy): each counts in the first file read.
  const fork = "00000000-0000-4000-8000-00000000f0f0";
  await writeJsonl(copilotFile(home, fork), [{ ...start(0, fork), id: "f0" }, user(4, "Fixture question."), answer(5, "msg-1", "One."), user(20, "Forked question.", {}, { id: "f20" })]);
  const lines = await parseHome(home, { sources: ["copilot"], catalog: false });
  // The fork's file sorts first: msg-1 and the first question count there. The original keeps its shutdown's tokens, on a
  // request of their own now that it holds no request of that model.
  assert.deepEqual(lines.map((line) => [line.id, line.turns, line.calls, line.tokens.input]), [[fork, 2, 1, 0], [SID, 0, 1, 100]].sort((a, b) => (sha(`.copilot/session-state/${a[0]}/events.jsonl`) < sha(`.copilot/session-state/${b[0]}/events.jsonl`) ? -1 : 1)));
});

/** Two session ids, in the order parseHome reads their files (by the hash of the path under the home). */
const inReadOrder = (...ids) => ids.sort((a, b) => (sha(`.copilot/session-state/${a}/events.jsonl`) < sha(`.copilot/session-state/${b}/events.jsonl`) ? -1 : 1));

test("Copilot CLI: a copied cumulative shutdown, counted in the file read first, still moves the copy's baseline: the copy's next total adds only its own", async (t) => {
  const home = await tempHome(t);
  const [first, second] = inReadOrder("00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2");
  const head = [user(1, "Fixture question."), answer(2, "msg-1", "One."), ev(3, "session.usage_checkpoint", { totalNanoAiu: 10 }), shutdown(4, { "claude-sonnet-4.5": metric(100, 10) }, { usageAccountingWatermarks: { main: 3 } })];
  await writeJsonl(copilotFile(home, first), [start(0, first), ...head]);
  // The copy: the same events (the same ids), then a process of its own whose shutdown holds the whole total, 150.
  await writeJsonl(copilotFile(home, second), [{ ...start(0, second), id: "c0" }, ...head, ev(5, "session.resume", { resumeTime: at(5), eventCount: 5 }), user(6, "Next."), answer(7, "msg-2", "Two."), shutdown(8, { "claude-sonnet-4.5": metric(150, 15) }, { usageAccountingWatermarks: { main: 7 } })]);
  const lines = await parseHome(home, { sources: ["copilot"], catalog: false });
  assert.deepEqual(lines.map((line) => [line.id, line.tokens.input, line.tokens.output]), [[first, 100, 10], [second, 50, 5]]);
  assert.equal(lines.reduce((n, line) => n + line.tokens.input, 0), 150, "the last total, not 100 + 150");
});

test("Copilot CLI: each chunk's messageId counts once: a chunk repeated under a new event id adds no text or call, and copied files hold no extra request", async (t) => {
  const home = await tempHome(t);
  const chunks = [
    answer(3, "msg-2", "First part.", { apiCallId: "api-1", chunkIndex: 0, chunkCount: 2 }),
    answer(4, "msg-3", "Second part.", { apiCallId: "api-1", chunkIndex: 1, chunkCount: 2, toolRequests: [{ toolCallId: "call-2", name: "view", arguments: { path: "a" } }] }),
  ];
  const file = await writeJsonl(copilotFile(home), [start(0), user(1, "Fixture question."), ...chunks, { ...chunks[1], id: "e5" }, shutdown(6, { "claude-sonnet-4.5": metric(100, 10) })]);
  const { requests } = (await READERS.copilot.read({ file, turns: true })).sessions[0];
  assert.deepEqual(requests.map((r) => [r.key, r.text, r.calls.length]), [["msg-2", "First part.\nSecond part.", 1]]);
  const [one] = await parseHome(home, { sources: ["copilot"], catalog: false });
  // A copy of the session, read after it, whose events carry new ids: its chunks are the same messages, so no request.
  const copy = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"].map((n) => `00000000-0000-4000-8000-0000000000${n}`).find((id) => inReadOrder(SID, id)[1] === id);
  await writeJsonl(copilotFile(home, copy), [{ ...start(0, copy), id: "b0" }, ...chunks.map((c, i) => ({ ...c, id: `b${i + 3}` }))]);
  const both = await parseHome(home, { sources: ["copilot"], catalog: false });
  assert.equal(both.reduce((n, line) => n + line.calls, 0), one.calls, "the copy adds no request");
});

test("Copilot CLI: a session's turns keep the ids it was read by (each event's, a split response's later chunks' messageIds, the shutdown's on the request it fed): a later read handed them as seen counts a copy of the session once, as one import of both does", async (t) => {
  const home = await tempHome(t);
  const chunks = [
    answer(2, "msg-2", "First part.", { apiCallId: "api-1", chunkIndex: 0, chunkCount: 2 }),
    answer(3, "msg-3", "Second part.", { apiCallId: "api-1", chunkIndex: 1, chunkCount: 2 }),
  ];
  const head = [user(1, "Fixture question."), ...chunks, ev(4, "session.usage_checkpoint", { totalNanoAiu: 10 }), shutdown(5, { "claude-sonnet-4.5": metric(100, 10) }, { usageAccountingWatermarks: { main: 4 } })];
  const original = await writeJsonl(copilotFile(home), [start(0), ...head]);
  // The copy: the same events (the same ids), a chunk again under a new event id, then a process of its own whose
  // shutdown holds the whole total, 150.
  const copyId = "00000000-0000-4000-8000-0000000000c1";
  const copy = await writeJsonl(copilotFile(home, copyId), [{ ...start(0, copyId), id: "c0" }, ...head, { ...chunks[1], id: "c3" }, ev(6, "session.resume", { resumeTime: at(6), eventCount: 6 }), user(7, "Next."), answer(8, "msg-9", "Two."), shutdown(9, { "claude-sonnet-4.5": metric(150, 15) }, { usageAccountingWatermarks: { main: 8 } })]);
  const counts = (session) => {
    const requests = session.turns.filter((turn) => turn.role === "assistant");
    return { users: session.users, requests: requests.map((r) => r.key), input: requests.reduce((n, r) => n + (r.usage?.input ?? 0), 0), output: requests.reduce((n, r) => n + (r.usage?.output ?? 0), 0) };
  };
  // One import of both: the copy keeps its own alone.
  const shared = new Set();
  const first = await readSession(original, "copilot", { seen: shared });
  assert.deepEqual(counts(await readSession(copy, "copilot", { seen: shared })), { users: 1, requests: ["msg-9"], input: 50, output: 5 });
  // A later import, handed what a store keeps of the first (each turn's ids, each request's key and later chunks'), counts the copy the same.
  const restored = new Set(first.turns.flatMap((turn) => [...(turn.uuids ?? []).map((id) => `u:${id}`), ...(turn.role === "assistant" ? [turn.key, ...(turn.keys ?? [])].filter(Boolean).map((key) => `m:${key}`) : [])]));
  assert.deepEqual(counts(await readSession(copy, "copilot", { seen: restored })), { users: 1, requests: ["msg-9"], input: 50, output: 5 });
  // What the first read's turns keep: each its events' ids, the request its later chunk's messageId and the shutdown's id.
  assert.deepEqual(first.turns.map((turn) => [turn.role, turn.uuids ?? null, turn.keys ?? null]), [["user", ["e1"], null], ["assistant", ["e2", "e3", "e5"], ["msg-3"]]]);
});

test("Copilot CLI: turns false keeps no answer text, tool output, arguments or later prompt in requests or the cursor", async (t) => {
  const home = await tempHome(t);
  const WORDS = "Fixture answer words, never kept.";
  const file = await writeJsonl(copilotFile(home), [
    start(0),
    user(1, "Fixture prompt."),
    answer(2, "msg-1", WORDS, { toolRequests: [{ toolCallId: "call-1", name: "bash", arguments: { command: WORDS } }] }),
    ev(3, "tool.execution_start", { toolCallId: "call-1", toolName: "bash", arguments: { command: WORDS } }),
    ev(4, "tool.execution_complete", { toolCallId: "call-1", success: true, result: { content: WORDS } }),
    user(5, WORDS),
    shutdown(6, { "claude-sonnet-4.5": metric(10, 2) }),
  ]);
  const result = await READERS.copilot.read({ file }, undefined, { turns: false });
  for (const request of result.sessions[0].requests) assert.equal(request.text, "");
  assert.deepEqual(result.sessions[0].requests[0].calls, [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }]);
  assert.equal(serialize(result.cursor).includes(Buffer.from(WORDS)), false, "the cursor holds no text");
  assert.equal(serialize(result.sessions).includes(Buffer.from(WORDS)), false, "the sessions hold no text");
  for (const text of ["Fixture prompt.", "/work/fixture"]) assert.equal(serialize(result.cursor).includes(Buffer.from(text)), false, `the cursor holds no ${text}`);
  assert.equal(result.sessions[0].session.users, 2, "both prompts still count");
  const state = {};
  await parseHome(home, { sources: ["copilot"], state, catalog: false });
  for (const text of [WORDS, "Fixture prompt.", "/work/fixture"]) assert.equal(serialize(state).includes(Buffer.from(text)), false, `the state holds no ${text}`);
  const kept = await READERS.copilot.read({ file }, undefined, { turns: true });
  assert.equal(kept.sessions[0].requests[0].text, WORDS, "turns true keeps it");
});

test("Copilot CLI: normalizeUsage('copilot') takes the cache read and write out of inputTokens; reasoning is part of output", () => {
  // github/copilot-sdk docs/features/usage-and-billing.md: inputTokens includes cacheReadTokens and cacheWriteTokens.
  const rows = [
    [{ inputTokens: 5000, outputTokens: 300, cacheReadTokens: 3000, cacheWriteTokens: 500, reasoningTokens: 100 }, { input: 1500, output: 300, cacheRead: 3000, cacheWrite: 500, reasoning: 100 }],
    [{ inputTokens: 7, outputTokens: 3 }, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }],
    // Reasoning over the whole output is not trusted.
    [{ inputTokens: 7, outputTokens: 3, reasoningTokens: 9 }, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }],
    // A cache over the input, or a count missing or broken: no usage, never zeros.
    [{ inputTokens: 10, outputTokens: 1, cacheReadTokens: 8, cacheWriteTokens: 5 }, undefined],
    [{ outputTokens: 1 }, undefined],
    [{ inputTokens: -1, outputTokens: 1 }, undefined],
  ];
  for (const [raw, want] of rows) assert.deepEqual(normalizeUsage("copilot", raw), want, JSON.stringify(raw));
});
