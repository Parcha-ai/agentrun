// A learned workflow served first (runner/workflow-first.ts) whose call node names an MCP tool of the run: the step runs
// the run's own learned_workflow tool as the loop wrapped it (adapter-loop.ts serveFirst, through `hosted`), so the MCP
// node reaches the run's MCP (host-calls.ts withHostCalls) exactly as the agent's own call of the tool would: it runs
// once, its price is booked on the run, and the workflow answers alone with no agent turn. pi, on the faux model.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, retried, serve as serveOf, withEnv } from "./support.mjs";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { git, resnap } from "./learn-support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"learned-first-mcp-0123"}`;
const serve = (t) => (withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }), serveOf(t, { faux: FAUX_MCP, accounts: true, openSetup: true }));

/** One call node on the fake server's `add`, its sum the output: fits an input with numbers `a` and `b`. */
const ADD_FLOW = {
  v: 2, name: "add-two",
  schemas: { In: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, Out: { type: "number" } },
  input: { schemaId: "In" }, output: { schemaId: "Out", path: "result" },
  root: { node: "call", label: "mcp", via: "tool", tool: "mcp:fake/add", args: { a: "{a}", b: "{b}" }, out: "Out", as: "result", deadline_s: 60 },
};

test("served first, a learned workflow's MCP node runs once through the run's MCP: the workflow answers alone, its price on the run", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const { api, data } = server;
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN }, prices: { add: 0.05 } })).status, 200);
  assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" } })).status, 200);
  assert.equal((await retried(api)("POST", "/agents", agent("adder", { learning: true, tools: ["mcp:fake/add"] }))).status, 201);
  await seedOf(data, "adder");
  const repo = join(agentFolderOf(data, "adder"), "learning");
  const files = { "workflows/add-two/workflow.json": JSON.stringify(ADD_FLOW), "workflows/add-two/README.md": "---\nname: add-two\ndescription: Adds two numbers\n---\n" };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, "adder");
  const started = await retried(api)("POST", "/agents/adder/runs", { input: { content: "Add two and three", a: 2, b: 3 }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.status, "completed", JSON.stringify(view));
  assert.equal(String(view.result?.final_answer).trim(), "5", `the workflow answered alone: ${JSON.stringify(rows.map(({ kind, text, tool_name }) => [kind, tool_name, text?.slice(0, 160)]))}`);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length, 1, "the MCP tool ran once");
  assert.equal(view.cost?.usd, 0.05, "the faux model is free: the run's cost is the MCP node's");
  assert.equal(rows.some((row) => /handed it back/.test(row.text ?? "")), false, "never handed back");
});
