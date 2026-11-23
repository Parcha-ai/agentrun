// A read with `turns: false` keeps what a listing and a total use: no answer text in its requests, nor in the cursor a
// later read goes on from (parseHome holds every file's requests and cursors at once).
import assert from "node:assert/strict";
import { test } from "node:test";
import { serialize } from "node:v8";
import { READERS } from "../dist/index.js";
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
