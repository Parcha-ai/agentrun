// serve's test hooks (AGENTRUN_SERVE_FAUX and the names after it) are set from startServe's options alone: a name of
// the server's own environment never reaches its capabilities, its runs' processes, or a module they would load.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const MARKER_MODULE = new URL("./fixtures/faux-marker.mjs", import.meta.url).pathname;

/** A Responses endpoint whose first answer waits until `release()`, so the run's process is alive to be read. */
async function heldEndpoint(t) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let asked = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      if (req.method !== "POST") return void res.writeHead(404).end();
      asked += 1;
      await held;
      const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "42", annotations: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "42" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => (release(), new Promise((resolve) => server.close(resolve))));
  return { url: `http://127.0.0.1:${server.address().port}`, release, asked: () => asked };
}

test("a faux name in the server's own environment, with no faux option, enables nothing: capabilities show no faux, no process loads the module, and a run's process carries no such name", async (t) => {
  const dir = await scratch(t);
  const marker = join(dir, "imported");
  const endpoint = await heldEndpoint(t);
  withEnv(t, {
    AGENTRUN_SERVE_FAUX: MARKER_MODULE,
    AGENTRUN_SERVE_FAUX_HARNESS: MARKER_MODULE,
    AGENTRUN_TEST_FAUX_MARKER: marker,
    AGENT_MODEL_BASE_URL: endpoint.url,
    AGENT_MODEL: "gpt-4o",
    AGENT_MODEL_API_KEY: "none",
  }, ["AGENTRUN_SERVE_FAUX", "AGENTRUN_SERVE_FAUX_HARNESS", "AGENTRUN_TEST_FAUX_MARKER", "AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE"]);
  const { api, data } = await serve(t, { faux: undefined });
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.models.source, "gateway", `the server's models are its gateway's, not the faux module's: ${JSON.stringify(caps.models)}`);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const started = await api("POST", "/agents/plain/runs", { input: { content: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  // The run's request reaches the gateway, or the run ends without it (a faux module answered): named either way.
  for (const deadline = Date.now() + 30_000; !endpoint.asked(); await new Promise((resolve) => setTimeout(resolve, 50))) {
    const { status } = (await api("GET", `/runs/${started.body.run_id}`)).body;
    assert.ok(!["completed", "failed"].includes(status), `the run ended ${status} without asking the gateway; the faux module ${existsSync(marker) ? "was" : "was not"} imported`);
    assert.ok(Date.now() < deadline, "the run's request reached the gateway in 30 s");
  }
  // The run's process, alive while its request waits: its environment as the kernel holds it.
  const { holder } = JSON.parse(await readFile(join(data, "runs", started.body.run_id, "run.json"), "utf8"));
  const names = (await readFile(`/proc/${holder.pid}/environ`, "utf8")).split("\0").map((line) => line.slice(0, line.indexOf("=")));
  assert.deepEqual(names.filter((name) => name.startsWith("AGENTRUN_SERVE_FAUX")), [], "the run's process carries no faux name");
  endpoint.release();
  await follow(api, started.body.run_id, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "42"], `the gateway answered, not the faux module: ${JSON.stringify(run)}`);
  assert.equal(endpoint.asked(), 1);
  assert.equal(existsSync(marker), false, "no process imported the faux module");
});
