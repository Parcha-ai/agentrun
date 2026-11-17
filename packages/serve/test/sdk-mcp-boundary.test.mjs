// SDK callbacks belong to their backend, even when a saved tool name also names a managed MCP server.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { serve, client, follow } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

for (const runtime of ["claude-agent-sdk", "codex-sdk"]) {
  for (const registry of ["available", "unavailable", "missing"]) {
    test(`${runtime} keeps SDK execution outside ${registry} managed MCP pinning`, { timeout: 60_000 }, async (t) => {
      const server = await serve(t), { api, store } = server;
      const fake = await startFakeMcp();
      t.after(() => fake.close());
      assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
      // What reached the unavailable endpoint, as the fake logs it: the HTTP method, the path and the JSON-RPC method.
      const unavailableLog = [];
      if (registry === "missing") {
        assert.equal((await api("DELETE", "/settings/mcp-servers/fake")).status, 204);
      } else if (registry === "unavailable") {
        // Retain the registered URL and listing, but make its actual loopback endpoint unavailable.
        await fake.close();
        const unavailable = createServer((req, res) => {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            let method;
            try { method = JSON.parse(body)?.method; } catch {}
            unavailableLog.push({ http: req.method, path: req.url, method, at: Date.now() });
            res.writeHead(503).end("Fixture MCP server is unavailable.");
          });
        });
        await new Promise((resolve) => unavailable.listen(Number(new URL(fake.url).port), "127.0.0.1", resolve));
        t.after(() => new Promise((resolve) => { unavailable.close(resolve); unavailable.closeAllConnections(); }));
      }
      const requests = () => fake.log.length + unavailableLog.length;
      const seen = () => JSON.stringify({ fake: fake.log, unavailable: unavailableLog });
      const baseline = requests(), id = `sdk-${runtime}-${registry}`;
      const created = await api("POST", "/agents", {
        definition: { id, name: id, instructions: "Keep backend callback ownership.", sdk: { runtime }, learning: false, tools: ["mcp:fake/add"] },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.mcp_pin, null);
      const edited = await api("PUT", `/agents/${id}/definition`, { definition: { instructions: "Edited backend policy.", tools: ["mcp:fake/add"] } });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.deepEqual(edited.body.definition.sdk, { runtime });
      assert.deepEqual(edited.body.definition.tools, ["mcp:fake/add"], "editing preserves the backend's declared tools");
      assert.equal(edited.body.mcp_pin, null);
      assert.equal(requests(), baseline, `SDK save and edit never list managed tools: ${seen()}`);

      const ordinary = await api("POST", `/agents/${id}/runs`, { input: { content: "Do not launch a managed harness." } });
      assert.equal(ordinary.status, 409, JSON.stringify(ordinary.body));
      assert.match(ordinary.body.error.message, /backend SDK/);
      assert.equal(requests(), baseline, `a refused ordinary launch must not list managed MCP first: ${seen()}`);
      assert.equal((await store.agents.revision(edited.body.revision)).mcpPin, null, "no managed MCP pin was written");
      assert.deepEqual((await api("GET", `/agents/${id}/runs`)).body.runs, [], "refusal creates no managed run");

      // Inline starts share prepareLaunch but do not pass through startRun's current-agent SDK guard.
      const inline = await api("POST", "/runs", {
        external: { source: "fixture", kind: "sdk", id, version: "1" },
        definition: { name: id, instructions: "Keep backend ownership for inline metadata too.", sdk: { runtime }, learning: false, tools: ["mcp:fake/add"] },
        input: { content: "Do not launch an inline SDK definition on a managed harness." },
      });
      assert.equal(inline.status, 409, JSON.stringify(inline.body));
      assert.match(inline.body.error.message, /backend SDK/);
      assert.equal(requests(), baseline, `a refused inline SDK start must not list managed MCP before checking its mode: ${seen()}`);
      assert.equal((await api("GET", "/agents")).body.agents.length, 1, "refusal creates no inline agent");

      const started = await api("POST", `/agents/${id}/sdk-runs`, {
        runtime, input: "Add two and three in the application.", instructions: "Use the application's own add callback.", model: "backend-fixture",
      }, { "Idempotency-Key": `backend-${registry}` });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const receipt = started.body, sdk = client(server.baseUrl, receipt.token), path = `/sdk-runs/${receipt.run_id}`;
      let callbacks = 0;
      const add = (a, b) => { callbacks++; return a + b; };
      const answer = add(2, 3);
      assert.equal((await sdk("POST", `${path}/events`, { sequence: 1, events: [
        { type: "tool", id: "backend-add", name: "mcp:fake/add", status: "started", input: { a: 2, b: 3 } },
        { type: "tool", id: "backend-add", name: "mcp:fake/add", status: "completed", output: { answer } },
      ] })).status, 200);
      assert.equal((await sdk("POST", `${path}/complete`, { status: "completed", answer: String(answer) })).status, 200);
      await follow(api, receipt.run_id, ["completed"]);
      const run = (await api("GET", `/runs/${receipt.run_id}`)).body;
      assert.equal(callbacks, 1);
      assert.equal(run.result.final_answer, "5");
      assert.equal(run.sdk.runtime, runtime);
      assert.equal((await store.runs.launch(receipt.run_id)).body.harness, "sdk");
      assert.equal(requests(), baseline, `recording the real backend callback must not invoke or pin managed MCP: ${seen()}`);
      assert.equal((await store.agents.revision(edited.body.revision)).mcpPin, null);
    });
  }
}
