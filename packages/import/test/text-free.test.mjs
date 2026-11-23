// A read with `turns: false` keeps what a listing and a total use: no answer text in its requests (parseHome holds every
// file's requests at once).
import assert from "node:assert/strict";
import { test } from "node:test";
import { serialize } from "node:v8";
import { parseHome, READERS, readSession } from "../dist/index.js";
import { anthropicUsage, at, claudeAnswer, claudeFile, claudeUser, codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, piFile, piMeta, piUser, tempHome, writeJsonl } from "./fixtures.mjs";

const WORDS = "Fixture answer words, never kept.";

const holdsNoText = (result) => {
  assert.ok(result.sessions[0].requests.length > 0);
  for (const request of result.sessions[0].requests) assert.equal(request.text, "");
  assert.equal(serialize(result.sessions).includes(Buffer.from(WORDS)), false, "the sessions hold no answer text");
};

test("Claude Code: turns false keeps no answer text in its requests", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(claudeFile(home), [
    claudeUser({ uuid: "u1", text: "Fixture prompt.", i: 0 }),
    claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 2), i: 1, block: { type: "text", text: WORDS } }),
    claudeAnswer({ uuid: "a2", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 4), i: 2, block: { type: "text", text: WORDS } }),
  ]);
  holdsNoText(await READERS["claude-code"].read({ file }, { turns: false }));
  const kept = await READERS["claude-code"].read({ file }, { turns: true });
  assert.equal(kept.sessions[0].requests[0].text, `${WORDS}\n${WORDS}`, "turns true keeps it");
});

test("pi: turns false keeps no answer text in its requests", async (t) => {
  const home = await tempHome(t);
  const answer = { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", provider: "fixture", model: "fixture-model", content: [{ type: "text", text: WORDS }], stopReason: "stop", usage: { input: 10, output: 2 } } };
  const file = await writeJsonl(piFile(home), [piMeta(), piUser("Fixture prompt."), answer]);
  holdsNoText(await READERS.pi.read({ file }, { turns: false }));
  const kept = await READERS.pi.read({ file }, { turns: true });
  assert.equal(kept.sessions[0].requests[0].text, WORDS, "turns true keeps it");
});

test("Codex: turns false keeps no answer text, tool output or later prompt in its requests", async (t) => {
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
  const result = await READERS.codex.read({ file }, { turns: false });
  holdsNoText(result);
  assert.equal(result.sessions[0].session.users, 2, "both prompts still count");
  assert.equal(result.sessions[0].session.firstPrompt, "Fixture prompt.");
  const kept = await READERS.codex.read({ file }, { turns: true });
  const result1 = kept.sessions[0].session.turns.find((turn) => turn.role === "toolResult");
  assert.equal(result1.isError, true, "the exit code still marks the result failed");
  assert.match(result1.text, /Fixture answer words/);
});

test("parseHome's totals (turns false) hold no prompt, title or working directory, while a listing read still has them", async (t) => {
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
  const sessions = await parseHome(home, { catalog: false });
  assert.equal(sessions.length, 3);
  const bytes = serialize(sessions);
  for (const text of [TITLE, PROMPT, CWD, WORDS]) assert.equal(bytes.includes(Buffer.from(text)), false, `the totals hold no ${text}`);
  const listed = await readSession(claude, "claude-code", { turns: false });
  assert.deepEqual([listed.firstPrompt, listed.sourceTitle, listed.cwd], [PROMPT, TITLE, CWD], "a listing read from the start has them");
});

test("a failed request read with turns false keeps no error text: not in its requests nor a home's totals", async (t) => {
  const home = await tempHome(t);
  // Claude Code's own turn for an API error, and pi's request that stopped on one: each holds the error's words.
  await writeJsonl(claudeFile(home), [
    claudeUser({ uuid: "u1", text: "Fixture prompt.", i: 0 }),
    { ...claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(0, 0), i: 1, model: "<synthetic>", block: { type: "text", text: WORDS } }), isApiErrorMessage: true },
  ]);
  const failed = { type: "message", timestamp: at(2), message: { role: "assistant", provider: "fixture", model: "fixture-model", content: [], stopReason: "error", errorMessage: WORDS, usage: { input: 10, output: 0 } } };
  await writeJsonl(piFile(home), [piMeta(), piUser("Fixture prompt."), failed]);
  for (const [source, file] of [["claude-code", claudeFile(home)], ["pi", piFile(home)]]) {
    const result = await READERS[source].read({ file }, { turns: false });
    assert.equal(result.sessions[0].requests[0].error, "API error", `${source}: the error, without its words`);
    holdsNoText(result);
    const kept = await READERS[source].read({ file }, { turns: true });
    assert.equal(kept.sessions[0].requests[0].error, WORDS, `${source}: turns true keeps it`);
  }
  const totals = await parseHome(home, { sources: ["claude-code", "pi"], catalog: false });
  assert.equal(serialize(totals).includes(Buffer.from(WORDS)), false, "the totals hold no error text");
});
