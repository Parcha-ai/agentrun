// The `browser` tool: pi-browser's durable adapter on Browserbase, here on its fake backend in the run's own process.
// No network and no key: the Browserbase variables are set to fakes where a run needs them.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { evidenceIn } from "../dist/tools.js";
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
  assert.deepEqual(caps.tools.find((tool) => tool.name === "browser"), { name: "browser", summary: caps.tools.find((tool) => tool.name === "browser").summary, nodes: true, calls: false, available: false, missing: ["BROWSERBASE_API_KEY"], harnesses: ["pi"] });
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

test("evidence names never collide: reads filed at once each keep their own file, and a later process's sink never overwrites one", async (t) => {
  const work = await scratch(t);
  const read = (n) => ({ tool: "browser_read", args: {}, status: "ok", facts: { sha256: `sha-${n}` }, body: `page ${n}` });
  const sink = evidenceIn(work);
  const filed = await Promise.all([1, 2, 3].map((n) => sink.file("run", read(n))));
  const later = await evidenceIn(work).file("run", read(4));
  const shot = await evidenceIn(work).file("run", { tool: "screenshot", args: {}, status: "ok", facts: { sha256: "sha-5" }, body: new Uint8Array([5]), ext: "png" });
  const paths = [...filed, later].map((at) => at.path);
  assert.equal(new Set(paths).size, 4, paths.join(", "));
  for (const [i, path] of paths.entries()) assert.match(await readFile(join(work, path), "utf8"), new RegExp(`"sha256":"sha-${i + 1}"[^]*\\n\\npage ${i + 1}$`), path);
  assert.deepEqual([...(await readFile(join(work, shot.bodyPath)))], [5]);
  assert.equal((await readdir(join(work, "evidence"))).length, 6, "four reads, and a capture beside its facts");
});

test("two parallel workflow nodes that browse each keep their evidence file", async (t) => {
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" });
  const { api, data } = await serve(t, { fauxBrowser: FAUX_BROWSER });
  const flow = answerFlow();
  const reader = (label) => ({ ...flow.root.steps[0], label, as: label, tools: ["browser"] });
  flow.root.steps = [{ node: "parallel", label: "both", branches: [reader("left"), reader("right")] }];
  flow.output.path = "left";
  assert.equal((await api("POST", "/agents", { definition: { id: "pair", name: "pair", workflow: flow, tools: ["browser"] } })).status, 201);
  const started = await api("POST", "/agents/pair/runs", { input: { question: "Read the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"]);
  assert.equal(rows.filter((row) => row.kind === "tool_use" && row.tool_name === "browser_read").length, 2);
  const evidence = join(data, "runs", started.body.run_id, "work", "evidence");
  const files = (await readdir(evidence)).filter((name) => name.endsWith(".md"));
  assert.equal(files.length, 2, files.join(", "));
  for (const name of files) assert.match(await readFile(join(evidence, name), "utf8"), /The answer is forty-two\./, name);
});
