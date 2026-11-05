// A codex run the person stops before its first step (Codex's app-server still starting, so the drive has placed no
// prompt yet), then "Go on.": the follow-up's turn must still have the task. The stand-in for Codex's app-server
// (agentrun-harness-codex's fake-app-server) echoes what it is sent and starts slowly (FAKE_CODEX_START_MS), so the stop
// lands before the prompt is placed every time.
import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agent, follow, scratch, serve } from "./support.mjs";

const STAND_IN = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));

/** serve's gateway, on loopback: each Responses request answered at once, with its usage. */
async function gateway(t) {
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    for await (const _ of req);
    const events = [{ type: "response.output_text.delta", delta: "Working on it." }, { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 100 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

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

test("codex: a run stopped right after a tool result, then 'Go on.': the follow-up shows as the person's next message, not a steer", { timeout: 120_000 }, async (t) => {
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyFile(STAND_IN, standIn);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  // The stand-in runs the message as its script: a model request (priced, through the gateway) that asks for a write, the
  // write, then 30 s before its next model request. The request's answer is written at the write's end, before its
  // result, as with Codex itself; the stop lands after the result, with no request out, before the turn's end.
  Object.assign(process.env, {
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote", FAKE_CODEX_THINK_MS: "30000" } }),
    AGENT_MODEL_BASE_URL: await gateway(t),
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    AGENT_MODEL_PRICE: "1,2,0.5",
  });
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("writer", { harness: "codex", tools: ["write"] }))).status, 201);
  const run = await api("POST", "/agents/writer/runs", { input: { content: 'call write {"path":"a.md","content":"x"}' } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const rowsOf = async () => (await api("GET", `/runs/${run.body.run_id}/timeline`)).body.rows ?? [];
  for (let i = 0; !(await rowsOf()).some((r) => r.kind === "tool_result"); i++) {
    assert.ok(i < 300, "the write's result is in the timeline");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await api("POST", `/runs/${run.body.run_id}/stop`)).body.stopped, true);
  await follow(api, run.body.run_id, ["input_required"], { deadlineMs: 60_000 });
  assert.equal((await api("POST", `/runs/${run.body.run_id}/messages`, { content: "Go on." })).status, 202);
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 90_000 });
  const said = rows.filter((r) => r.kind === "user_message").map((r) => r.summary);
  assert.equal(said.at(-1), "You: Go on.", `the follow-up is the person's next message: ${JSON.stringify(said)}`);
});
