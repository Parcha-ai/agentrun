// The `browser` tool: pi-browser's durable adapter on Browserbase, here on its fake backend in the run's own process.
// No network and no key: the Browserbase variables are set to fakes where a run needs them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { answerFlow, client, follow, scratch, serve } from "./support.mjs";

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"];

/** Sets `values` in this process's environment for test `t`, which a server and its runs' processes inherit. */
function withEnv(t, values) {
  const saved = Object.fromEntries([...KEYS, "FAUX_BROWSER_LOG", ...Object.keys(values)].map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  for (const name of KEYS) delete process.env[name];
  Object.assign(process.env, values);
}

const ledger = async (file) => (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

test("capabilities list browser with the variables it is missing (names only), and a run of a revision naming it then is 409", async (t) => {
  withEnv(t, { BROWSERBASE_PROJECT_ID: "fake-project" });
  const { api, baseUrl } = await serve(t);
  const caps = (await client(baseUrl)("GET", "/capabilities")).body;
  assert.deepEqual(caps.tools.find((tool) => tool.name === "browser"), { name: "browser", summary: caps.tools.find((tool) => tool.name === "browser").summary, nodes: true, available: false, missing: ["BROWSERBASE_API_KEY"] });
  assert.ok(caps.workflows.node_tools.includes("browser"));
  assert.ok(!JSON.stringify(caps).includes("fake-project"), "no value of a variable is shown");
  assert.equal((await api("POST", "/agents", { definition: { id: "browse", name: "browse", instructions: "Browse.", tools: ["browser"] } })).status, 201);
  const refused = await api("POST", "/agents/browse/runs", { input: { content: "Browse the example page." } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "agent_not_runnable"]);
  assert.deepEqual(refused.body.error.details.missing, { browser: ["BROWSERBASE_API_KEY"] });
  assert.match(refused.body.error.message, /the tool browser needs BROWSERBASE_API_KEY/);
  const flow = answerFlow();
  flow.root.steps[0].tools = ["browser"];
  assert.equal((await api("POST", "/agents", { definition: { id: "flow", name: "flow", workflow: flow, tools: ["browser"] } })).status, 201);
  const node = await api("POST", "/agents/flow/runs", { input: { question: "x" } });
  assert.deepEqual([node.status, node.body.error.details.missing], [409, { browser: ["BROWSERBASE_API_KEY"] }], "a workflow's node naming it too");
  assert.deepEqual((await api("GET", "/runs")).body.runs, []);
});

test("an agentic run calls the browser: the provider in its own process is reached and answers, and the session is let go when the run is", async (t) => {
  const log = join(await scratch(t), "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project", FAUX_BROWSER_LOG: log });
  const { api, baseUrl, data } = await serve(t, { fauxBrowser: FAUX_BROWSER });
  assert.equal((await client(baseUrl)("GET", "/capabilities")).body.tools.find((tool) => tool.name === "browser").available, true);
  assert.equal((await api("POST", "/agents", { definition: { id: "browse", name: "browse", instructions: "Browse.", tools: ["browser", "read"] } })).status, 201);
  const started = await api("POST", "/agents/browse/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"]);
  assert.ok(rows.some((row) => row.kind === "tool_use" && row.tool_name === "snapshot"), "the snapshot call is a row");
  assert.match((await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, /The answer is forty-two\./, "the page's text came back through the tool");
  const ops = await ledger(log);
  assert.deepEqual(ops[0], { op: "env", BROWSERBASE_API_KEY: "set", BROWSERBASE_PROJECT_ID: "set" }, "the keys reach the run's process");
  assert.ok(ops.some((row) => row.op === "create") && ops.some((row) => row.op === "attach"), JSON.stringify(ops.map((row) => row.op)));
  assert.ok(ops.some((row) => row.op === "release"), "the session the run held is released when the run is let go");
  const custody = await readFile(join(data, "runs", started.body.run_id, "store", "run.sqlite"));
  assert.ok(custody.includes("browser.sessions"), "the session's custody is in the run's own store");
});

test("a workflow's model node names browser: it browses, delivers its record, and its session is released when the workflow ends", async (t) => {
  const log = join(await scratch(t), "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project", FAUX_BROWSER_LOG: log });
  const { api } = await serve(t, { fauxBrowser: FAUX_BROWSER });
  const flow = answerFlow();
  flow.root.steps[0].tools = ["browser"];
  assert.equal((await api("POST", "/agents", { definition: { id: "flow", name: "flow", workflow: flow, tools: ["browser"] } })).status, 201);
  const started = await api("POST", "/agents/flow/runs", { input: { question: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"]);
  assert.ok(rows.some((row) => row.kind === "tool_use" && row.tool_name === "snapshot"));
  assert.deepEqual((await api("GET", `/runs/${started.body.run_id}`)).body.result.output, { answer: 42 });
  const ops = (await ledger(log)).map((row) => row.op);
  assert.ok(ops.includes("create") && ops.includes("release"), JSON.stringify(ops));
});
