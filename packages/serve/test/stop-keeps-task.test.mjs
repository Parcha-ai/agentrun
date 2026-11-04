// A codex run the person stops before its first step (Codex's app-server still starting, so the drive has placed no
// prompt yet), then "Go on.": the follow-up's turn must still have the task. The stand-in for Codex's app-server
// (agentrun-harness-codex's fake-app-server) echoes what it is sent and starts slowly (FAKE_CODEX_START_MS), so the stop
// lands before the prompt is placed every time.
import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agent, follow, scratch, serve } from "./support.mjs";

const STAND_IN = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));

test("codex: a run stopped before its first step, then 'Go on.': the follow-up's turn has the task, and the stopped prompt never runs on its own", { timeout: 120_000 }, async (t) => {
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyFile(STAND_IN, standIn);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, {
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_START_MS: "3000" } }),
    AGENT_MODEL_BASE_URL: "http://127.0.0.1:9",
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    AGENT_MODEL_PRICE: "1,2,0.5",
  });
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("coder", { harness: "codex" }))).status, 201);
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Write five files: a.md to e.md." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  // The stop lands while Codex's app-server is still starting: no prompt has been placed.
  assert.equal((await api("POST", `/runs/${run.body.run_id}/stop`)).body.stopped, true);
  await follow(api, run.body.run_id, ["input_required"], { deadlineMs: 60_000 });
  assert.equal((await api("POST", `/runs/${run.body.run_id}/messages`, { content: "Go on." })).status, 202);
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  // The stand-in echoes each message it is sent: its answers are what Codex was given.
  const answers = rows.filter((r) => r.kind === "final_answer" || r.kind === "text_block").map((r) => r.text);
  assert.equal(answers.length, 1, `one answer, the follow-up's: ${JSON.stringify(answers)}`);
  assert.match(answers[0], /Write five files[\s\S]*Go on\./, "the follow-up's turn has the task, before the follow-up");
});
