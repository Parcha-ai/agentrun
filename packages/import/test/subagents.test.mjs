// A subagent's session is its parent's: the parent's totals hold its requests, and it is no session of its own.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseHome } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, SESSION, subagentFile, tempHome, writeJsonl } from "./fixtures.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

test("Claude Code: <session>/subagents/*.jsonl count under the session beside them, and only there", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home), [
    claudeUser({ uuid: "u1", text: "Fixture question.", i: 0 }),
    claudeAnswer({ uuid: "a1", msg: "msg_parent", req: "req_parent", usage: anthropicUsage(10, 20, 300, 40), i: 1 }),
  ]);
  await writeJsonl(subagentFile(home, SESSION, "agent-a1"), [
    claudeUser({ uuid: "su1", text: "Fixture task.", i: 2, sidechain: true }),
    claudeAnswer({ uuid: "sa1", msg: "msg_sub_1", req: "req_sub_1", usage: anthropicUsage(1, 2, 3, 4), i: 3, sidechain: true }),
    claudeAnswer({ uuid: "sa2", msg: "msg_sub_2", req: "req_sub_2", usage: anthropicUsage(5, 6, 7, 8), i: 4, sidechain: true }),
  ]);
  await writeJsonl(subagentFile(home, SESSION, "agent-a2"), [
    claudeAnswer({ uuid: "sb1", msg: "msg_sub_3", req: "req_sub_3", usage: anthropicUsage(100, 200, 0, 0), i: 5, sidechain: true }),
  ]);
  const sessions = await parseHome(home, { sources: ["claude-code"] });
  assert.equal(sessions.length, 1, "the subagents are no sessions of their own");
  const [parent] = sessions;
  assert.equal(parent.key, sha(`.claude/projects/-work-fixture/${SESSION}.jsonl`));
  assert.deepEqual(parent.tokens, { input: 116, output: 228, cacheRead: 310, cacheWrite: 52, cacheWrite1h: 0 });
  assert.equal(parent.calls, 4);
  assert.equal(parent.subagents, 2);
  // The person's turns are the parent's: a subagent's prompt is its parent agent's, not the person's.
  assert.equal(parent.turns, 1);
});

test("Codex: a thread naming its parent (and its own child naming it) counts under the top thread", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-00-parent.jsonl"), [
    codexMeta("thread-parent"), codexContext(1), codexUser("Fixture question.", 2), codexAnswer("Fixture answer.", 3),
    codexTokens(openaiUsage(100, 40, 10), openaiUsage(100, 40, 10), 4),
  ]);
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-01-child.jsonl"), [
    codexMeta("thread-child", "thread-parent"), codexContext(1), codexUser("Fixture task.", 2), codexAnswer("Child answer.", 3),
    codexTokens(openaiUsage(50, 0, 5), openaiUsage(50, 0, 5), 4),
  ]);
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-02-grandchild.jsonl"), [
    codexMeta("thread-grandchild", "thread-child"), codexContext(1), codexAnswer("Grandchild answer.", 3),
    codexTokens(openaiUsage(7, 2, 1), openaiUsage(7, 2, 1), 4),
  ]);
  const sessions = await parseHome(home, { sources: ["codex"] });
  assert.equal(sessions.length, 1);
  // Uncached in: 60 + 50 + 5. Out: 10 + 5 + 1. Cached: 40 + 0 + 2.
  assert.deepEqual(sessions[0].tokens, { input: 115, output: 16, cacheRead: 42, cacheWrite: 0, cacheWrite1h: 0 });
  assert.equal(sessions[0].calls, 3);
  assert.equal(sessions[0].subagents, 2);
  assert.equal(sessions[0].key, sha(".codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-parent.jsonl"));
});

test("a subagent whose parent is not under the home is counted once, as its own line", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-01-orphan.jsonl"), [
    codexMeta("thread-orphan", "thread-gone"), codexContext(1), codexUser("Its parent agent's prompt.", 2), codexAnswer("Orphan answer.", 3),
    codexTokens(openaiUsage(9, 0, 1), openaiUsage(9, 0, 1), 4),
  ]);
  const sessions = await parseHome(home, { sources: ["codex"] });
  assert.equal(sessions.length, 1);
  assert.deepEqual([sessions[0].tokens.input, sessions[0].calls], [9, 1]);
  assert.equal(sessions[0].turns, 0, "a subagent's prompts are its parent agent's, not the person's");
});

test("a subagent's session that names no parent (Codex's source.subagent alone) is a line of its own, with no turns of the person's", async (t) => {
  const home = await tempHome(t);
  const meta = { type: "session_meta", timestamp: "2026-01-01T00:00:00.000Z", payload: { id: "thread-review", cwd: "/work/fixture", model_provider: "openai", source: { subagent: { review: {} } } } };
  await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-02-review.jsonl"), [
    meta, codexContext(1), codexUser("Its parent agent's prompt.", 2), codexAnswer("Review answer.", 3),
    codexTokens(openaiUsage(9, 0, 1), openaiUsage(9, 0, 1), 4),
  ]);
  const sessions = await parseHome(home, { sources: ["codex"] });
  assert.equal(sessions.length, 1);
  assert.deepEqual([sessions[0].tokens.input, sessions[0].calls, sessions[0].turns], [9, 1, 0]);
});

test("Claude Code: a subagent's file whose session file is gone is a line of its own, with no turns of the person's, sidechain-marked or not", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(subagentFile(home), [claudeUser({ uuid: "s1", text: "Its parent agent's prompt.", i: 0 }), claudeAnswer({ uuid: "s2", msg: "msg_s", req: "req_s", usage: anthropicUsage(4, 2), i: 1 })]);
  const sessions = await parseHome(home, { sources: ["claude-code"], catalog: false });
  assert.equal(sessions.length, 1);
  assert.deepEqual([sessions[0].tokens.input, sessions[0].calls, sessions[0].turns], [4, 1, 0]);
});

test("Claude Code: a resumed session's file that opens with a copy of another session's record is its own session; the copy counts once, in the first", async (t) => {
  const home = await tempHome(t);
  const copied = claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(5, 7), i: 2, session: "s-a" });
  await writeJsonl(claudeFile(home, "s-a", "-work-a"), [claudeUser({ uuid: "u1", text: "Fixture question.", i: 0, session: "s-a" }), claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 20), i: 1, session: "s-a" }), copied]);
  // Claude Code names the file for its session: s-b's file, whose first record is s-a's, copied, then its own request.
  await writeJsonl(claudeFile(home, "s-b", "-work-b"), [copied, claudeAnswer({ uuid: "b1", msg: "msg_3", req: "req_3", usage: anthropicUsage(3, 9), i: 3, session: "s-b" })]);
  // A file holding only copies (nothing of its own) is no session to count: serve's import leaves it out too.
  await writeJsonl(claudeFile(home, "s-c", "-work-c"), [copied]);
  const lines = await parseHome(home, { sources: ["claude-code"], catalog: false });
  const by = Object.fromEntries(lines.map((line) => [line.key, line]));
  assert.equal(lines.length, 2, "s-a and s-b, not the copies-only s-c");
  const a = by[sha(".claude/projects/-work-a/s-a.jsonl")];
  const b = by[sha(".claude/projects/-work-b/s-b.jsonl")];
  assert.ok(b, "s-b has a line of its own");
  assert.deepEqual([a.id, a.tokens.input, a.tokens.output, a.calls], ["s-a", 15, 27, 2]);
  assert.deepEqual([b.id, b.tokens.input, b.tokens.output, b.calls], ["s-b", 3, 9, 1]);
});
