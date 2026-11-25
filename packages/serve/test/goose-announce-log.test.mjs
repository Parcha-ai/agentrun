// serve's one debug switch on the built-in Goose: AGENTRUN_LOG=debug reaches the adapter Goose's entry builds
// (harness-table.ts gooseLaunch) as it reaches every other ACP agent's, so a run on the real Goose writes the adapter's
// "acp: the agent announced a call" line for its call of ours, by the toolCallId the run's tool row carries. Goose's
// entry builds its adapter apart from acpEntryOf, so the plan entry's test (acp-announce-log.test.mjs) does not reach
// it; acp-debug-entries.test.mjs walks every entry's.
// It needs the real Goose 1.59.2 binary, which AGENTRUN_TEST_GOOSE names (its digest is checked against the pin, so no
// stand-in can be), and skips without it, saying why. Its model is the scripted origin (fake-anthropic.mjs): no spend.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { installGoose, needsGoose } from "./fixtures/goose-installed.mjs";
import { agent, follow, scratch, serve, serverLog, withEnv } from "./support.mjs";

const LINE = "acp: the agent announced a call";
const MODEL = "claude-sonnet-5-5";

/** The model's script: a call of the offered tool whose name ends in "write", its required strings filled in, then, once
 *  its result is back, a plain answer. */
function writeOnce(body) {
  const last = body.messages?.at(-1);
  if (Array.isArray(last?.content) && last.content.some((block) => block.type === "tool_result")) return { text: "DONE" };
  const tool = (body.tools ?? []).find((offered) => /write$/.test(offered.name));
  if (!tool) return { text: `NO_WRITE_TOOL among [${(body.tools ?? []).map((offered) => offered.name).join(",")}]` };
  const required = tool.input_schema?.required ?? [];
  return { tool: tool.name, input: Object.fromEntries(required.map((name) => [name, /path|file/i.test(name) ? "proof.txt" : "ready"])) };
}

test("AGENTRUN_LOG=debug writes the ACP adapter's announce line on a run of the built-in Goose: its call of ours, by the toolCallId the run's tool row carries", { skip: needsGoose || (!existsSync("/usr/bin/setpriv") && "no setpriv here"), timeout: 180_000 }, async (t) => {
  const { fakeAnthropic } = await import(new URL("../../run-adapters-acp/test/fake-anthropic.mjs", import.meta.url).href);
  const fake = await fakeAnthropic({ step: writeOnce });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}`, AGENTRUN_LOG: "debug" }, ["AGENT_MODEL_BASE_URL"]);
  const data = installGoose(join(await scratch(t), "agents"));
  const log = serverLog(t);
  const { api } = await serve(t, { data, faux: undefined });
  assert.equal((await api("POST", "/agents", agent("gosling", { harness: "goose", model: `anthropic/${MODEL}`, tools: ["write"] }))).status, 201);
  const run = await api("POST", "/agents/gosling/runs", { input: { content: "Write ready into proof.txt." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 150_000 });
  const written = rows.find((row) => row.tool_name === "write" && row.tool_use_id);
  assert.ok(written, `the run's write row: ${JSON.stringify(rows).slice(0, 4000)}`);
  const lines = log.text().split("\n").filter((text) => text.includes(LINE)).map((text) => JSON.parse(text.slice(text.indexOf("{"))));
  const line = lines.find((one) => one.toolCallId === written.tool_use_id);
  assert.ok(line, `an announce line for the write row's ${written.tool_use_id}: ${JSON.stringify(lines)} in ${log.text().slice(-4000)}`);
  assert.deepEqual([line.harness, line.ours], ["goose", "write"]);
  assert.match(line.field, /write$/, "the tool name Goose's field holds");
  assert.doesNotMatch(line.toolCallId, /^acp-/, "Goose's own toolCallId");
});
