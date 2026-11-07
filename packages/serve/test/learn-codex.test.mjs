// An agent with learning on, on codex's real adapter (agentrun-harness-codex) against its stand-in for Codex's
// app-server (no Codex binary, no network): a read of a note the run started from is a dynamic tool's call, and its
// learning block names the note it used, as pi's and claude-agent's do. The stand-in acts on the turn's own text: `call
// read {...}` calls the host's read tool, and any other text is said; what it says is a model request to serve's gateway
// (a loopback server here), which answers each one the same, so the end-of-run turn adds nothing.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, learner, made, settled, started } from "./learn-support.mjs";
import { scratch, serve, withEnv } from "./support.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";

const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");

test("on codex's real adapter, a run whose job reads a note through the host's read tool used it: its rows name the tool `read` with the path as given, and its learning block, in its view and its list, names the note", { timeout: 120_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyStandIn(standIn);
  // serve's gateway: each Responses request streamed back as one short answer with its usage.
  const gateway = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    for await (const _ of req);
    const events = [{ type: "response.output_text.delta", delta: "Codex answered." }, { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 100 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  withEnv(t, {
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: `http://127.0.0.1:${gateway.address().port}`,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    AGENT_MODEL_PRICE: "1,2,0.5",
  }, []);
  const { api } = await serve(t, { learning: "on", faux: undefined });
  const id = "codex-reader";
  await made(api, learner(id, { harness: "codex", tools: ["write", "read"] }));
  assert.equal((await api("PUT", `/agents/${id}/learning/files/check-units.md`, { text: UNITS }, { "if-none-match": "*" })).status, 201);

  const runId = await started(api, id, `call read ${JSON.stringify({ path: ".learning/check-units.md" })}`);
  const { view, rows } = await ended(api, runId, ["completed"]);
  assert.equal(view.result.final_answer, "Codex answered.");
  const reads = rows.filter((row) => row.tool_name === "read").map((row) => [row.kind, row.tool_input_preview, row.tool_status]);
  assert.deepEqual(reads, [["tool_use", ".learning/check-units.md", null], ["tool_result", null, "success"]], JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.summary])));
  settled(view, rows, "dropped", "empty");
  assert.deepEqual(view.learning.read, [{ file: "check-units.md", name: "Check units" }]);
  assert.deepEqual((await api("GET", "/runs")).body.runs.find((run) => run.run_id === runId).learning.read, view.learning.read);
});
