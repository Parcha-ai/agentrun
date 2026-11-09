// pi's tools as the kernel registry's executors (serve/src/workspace/executors.ts): a failure is the answer's `error`,
// its output kept apart in `text`, never thrown; streamed output goes to the call's output as it comes; an abort throws;
// and the call's model reaches the tool. That an executor's answer, rendered (answerText), is a host tool's text for the
// same call on the same files is held where a run's tools are bound (workspace-bind-tools.test.mjs).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { localWorkspace, shellEnv } from "../dist/workspace/index.js";
import { piExecutor } from "../dist/workspace/executors.js";
import { bashTool, piEnv } from "../dist/workspace/pi-env.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-executors-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  return root;
}

test("an executor keeps a failure's output and says its words apart; streamed output goes to the call's output as it comes; an abort throws", async () => {
  const root = scratch();
  const env = piEnv(localWorkspace(root), { cwd: "/workspace", env: shellEnv(), defaultTimeoutS: 120 });
  const bash = piExecutor(bashTool(), env, ctx);
  const timed = await bash({ command: "echo before; sleep 300", timeout: 0.2 }, {});
  assert.deepEqual([timed.text, timed.error, timed.isError], ["before\n", "Command timed out after 0.2 seconds", true]);
  const streamed = [];
  await bash({ command: "echo first; echo second" }, { output: (chunk) => streamed.push(chunk) });
  assert.deepEqual(streamed.join(""), "first\nsecond\n");
  // Aborted when the command says it started, not after a clock.
  const controller = new AbortController();
  await assert.rejects(bash({ command: "echo started; sleep 300", timeout: 600 }, { signal: controller.signal, output: () => controller.abort() }));
});

test("an executor gives pi's tool the call's model (the registry's ToolCall.model), whose image limits read uses; none, pi's defaults", async () => {
  const root = scratch();
  const env = piEnv(localWorkspace(root), { cwd: "/workspace", env: shellEnv(), defaultTimeoutS: 120 });
  // A stand-in tool that says the model pi's api hands it, as read asks for it.
  const probe = { name: "probe", description: "", parameters: { type: "object" }, async execute(_args, api) { return { output: [{ type: "text", text: JSON.stringify((await api.agent()).model ?? null) }] }; } };
  const run = piExecutor(probe, env, ctx);
  assert.equal((await run({}, { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } })).text, '{"provider":"anthropic","modelId":"claude-sonnet-5-5"}');
  assert.equal((await run({}, {})).text, "null");
  assert.equal((await run({}, { model: "not a model" })).text, "null", "anything else is no model");
});
