// The tools a definition may name come from the harness: its vocabulary on the host the server's environment gives, and
// serve's own ask_person. A run's command acts in the run's work directory and sees none of the server's keys.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { agentApp, agentTools, hostFromEnv, placeAt } from "@parcha/agentrun-harness";
import { agent, client, follow, scratch, serve, startRun } from "./support.mjs";

const BROWSER_ENV = ["CHROME_PATH", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BB_API_KEY"];
const NO_BROWSER = "set CHROME_PATH (this host takes a local Chrome only)";

/** Sets `vars` in this process's environment, which the server and its runs inherit, until test `t` ends. The browser's
 *  variables are cleared first, so a test sees only the browser it sets. */
function withEnv(t, vars) {
  const saved = Object.fromEntries([...BROWSER_ENV, ...Object.keys(vars)].map((name) => [name, process.env[name]]));
  for (const name of BROWSER_ENV) delete process.env[name];
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
}

/** The harness's host on this process's environment, as a run's app builds it. */
async function harnessHost(t) {
  const place = await placeAt(join(await scratch(t), "run"), "probe");
  return { place, host: await hostFromEnv(place, { models: createModels(), lead: { provider: "none", modelId: "none" }, env: process.env, browserbase: false }) };
}

test("an agent with bash: the command runs in the run's work directory with none of the server's keys, and the run completes", async (t) => {
  const canary = `canary-${randomUUID()}`;
  withEnv(t, { AGENT_MODEL_API_KEY: canary, TYPESAFE_API_KEY: canary, AGENTRUN_SERVE_TEST_SECRET: canary });
  const { api, data } = await serve(t);
  const { run_id } = await startRun(api, "shell", "Run in the shell: echo hello > hi.txt && printenv > env.txt", { tools: ["bash"] });
  const { rows } = await follow(api, run_id, ["completed"]);
  const call = rows.find((row) => row.kind === "tool_use");
  assert.deepEqual([call?.tool_name, rows.find((row) => row.kind === "tool_result")?.tool_status], ["bash", "success"]);
  const run = (await api("GET", `/runs/${run_id}`)).body;
  assert.deepEqual([run.status, run.result.final_answer], ["completed", "Ran it."]);
  const work = join(data, "shell", "runs", run_id, "work");
  assert.equal(await readFile(join(work, "hi.txt"), "utf8"), "hello\n");
  assert.equal((await api("GET", `/runs/${run_id}/files/hi.txt`)).body, "hello\n");
  const env = await readFile(join(work, "env.txt"), "utf8");
  assert.ok(!env.includes(canary), "no key of the server reaches the command");
  const names = new Set(env.split("\n").map((line) => line.split("=")[0]).filter(Boolean));
  for (const name of ["AGENT_MODEL_API_KEY", "TYPESAFE_API_KEY", "AGENTRUN_SERVE_TEST_SECRET", "AGENTRUN_SERVE_FAUX"]) assert.ok(!names.has(name), `${name} is not in the command's environment`);
  for (const name of ["PATH", "HOME"]) assert.ok(names.has(name), `${name} is in the command's environment`);
});

test("a definition may name a tool this server does not bind: the agent is created, and its run start is refused with the harness's message and what is bound", async (t) => {
  withEnv(t, {});
  const { api } = await serve(t);
  const created = await api("POST", "/agents", agent("teleporter", { tools: ["read", "teleport", "ask_person"] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const refused = await api("POST", "/agents/teleporter/runs", { input: { content: "x" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "agent_not_runnable");
  const { place, host } = await harnessHost(t);
  const harness = await agentApp(place, host, { instructions: "", tools: ["read", "teleport"] }).then(() => "accepted", (error) => error.message);
  assert.match(harness, /^the definition names the tool teleport, which this host does not offer \(it offers /);
  assert.equal(refused.body.error.message, harness, "the harness's message, word for word");
  assert.deepEqual(refused.body.error.details, { bound: ["read", "ask_person"], unbound: ["teleport"] });

  assert.equal((await api("POST", "/agents", agent("browsing", { tools: ["browser_read"] }))).status, 201);
  const browsing = await api("POST", "/agents/browsing/runs", { input: { content: "x" } });
  assert.deepEqual([browsing.status, browsing.body.error.code], [409, "agent_not_runnable"]);
  assert.equal(browsing.body.error.message, `the definition names the tool browser_read, and this host has no browser: ${NO_BROWSER}`);
  assert.deepEqual(browsing.body.error.details, { bound: [], unbound: ["browser_read"] });
  for (const id of ["teleporter", "browsing"]) assert.deepEqual((await api("GET", `/agents/${id}/runs`)).body.runs, [], "nothing started");
});

test("features.browser is the browser the host offers, as the harness's vocabulary says: a local Chrome or none, never a billed Browserbase session", async (t) => {
  const cases = [
    ["none", {}],
    ["chrome", { CHROME_PATH: "/nonexistent/chrome" }],
    ["none", { BROWSERBASE_API_KEY: "bb-key", BROWSERBASE_PROJECT_ID: "bb-project" }],
    ["chrome", { CHROME_PATH: "/nonexistent/chrome", BROWSERBASE_API_KEY: "bb-key", BROWSERBASE_PROJECT_ID: "bb-project" }],
    ["none", { BROWSERBASE_API_KEY: "bb-key" }],
  ];
  for (const [expected, vars] of cases) {
    await t.test(`${JSON.stringify(vars)}: ${expected}`, async (t) => {
      withEnv(t, vars);
      const { baseUrl } = await serve(t);
      const caps = (await client(baseUrl)("GET", "/capabilities")).body;
      assert.equal(caps.features.browser, expected);
      const { place, host } = await harnessHost(t);
      const browserTools = (await agentTools(place, host)).filter((tool) => tool.plane === "browser");
      assert.ok(browserTools.length > 0);
      assert.equal(browserTools.every((tool) => tool.unmet === undefined), expected !== "none", "offered exactly when capabilities name a browser");
      assert.equal(browserTools.every((tool) => tool.unmet === `this host has no browser: ${NO_BROWSER}`), expected === "none");
    });
  }
});
