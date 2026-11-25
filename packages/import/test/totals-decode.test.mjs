// A totals read takes of each line only the fields its reader names (LineSource.fields): a tool result's text, a call's
// arguments, a command's output are checked as JSON where they lie and never decoded into strings or parsed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { READERS } from "../dist/index.js";
import { anthropicUsage, at, claudeAnswer, claudeFile, claudeUser, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, tempHome, writeJsonl } from "./fixtures.mjs";

const BIG = 1 << 20;
const BODY = "fixture output line\n".repeat(BIG / 20);

/** The longest string decoded from a Buffer, or handed to JSON.parse, while `run` runs. */
async function longestDecoded(run) {
  const proto = Buffer.prototype;
  const names = ["toString", "utf8Slice", "latin1Slice", "asciiSlice", "ucs2Slice"].filter((name) => typeof proto[name] === "function");
  const saved = Object.fromEntries(names.map((name) => [name, proto[name]]));
  const parse = JSON.parse;
  let longest = 0;
  const seen = (value) => {
    if (typeof value === "string" && value.length > longest) longest = value.length;
    return value;
  };
  for (const name of names)
    proto[name] = function (...args) {
      return seen(saved[name].apply(this, args));
    };
  JSON.parse = (text, reviver) => {
    seen(text);
    return parse(text, reviver);
  };
  try {
    const result = await run();
    return { longest, result };
  } finally {
    for (const name of names) proto[name] = saved[name];
    JSON.parse = parse;
  }
}

test("a totals read decodes none of a tool result's text", async (t) => {
  const home = await tempHome(t);
  const cc = await writeJsonl(claudeFile(home), [
    claudeUser({ uuid: "u1", text: "Fixture prompt.", i: 0 }),
    claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 2), i: 1, block: { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: BODY } } }),
    { ...claudeUser({ uuid: "u2", i: 2, text: [{ type: "tool_result", tool_use_id: "toolu_1", content: BODY }] }), toolUseResult: { stdout: BODY } },
    claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(20, 3), i: 3 }),
  ]);
  const codex = await writeJsonl(codexFile(home), [
    codexMeta("thread-1"),
    codexContext(1),
    codexUser("Fixture prompt.", 2),
    { type: "response_item", timestamp: at(3), payload: { type: "function_call", call_id: "call_1", name: "shell", arguments: JSON.stringify({ command: BODY }) } },
    { type: "response_item", timestamp: at(4), payload: { type: "function_call_output", call_id: "call_1", output: BODY } },
    codexTokens(openaiUsage(100, 60, 7, 3), openaiUsage(100, 60, 7, 3), 5),
  ]);
  for (const [source, file, requests] of [["claude-code", cc, 2], ["codex", codex, 1]]) {
    const { longest, result } = await longestDecoded(() => READERS[source].read({ file }, undefined, { turns: false, totals: true }));
    assert.equal(result.sessions[0].counts.n, requests, `${source}: every request counted`);
    assert.ok(longest < BIG / 16, `${source}: the longest string decoded is ${longest} characters, none of the tool output's ${BODY.length}`);
  }
});
