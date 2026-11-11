// The `browser` tool: pi-browser's durable adapter on Browserbase, here on its fake backend in the run's own process.
// No network and no key: the Browserbase variables are set to fakes where a run needs them.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { evidenceIn } from "../dist/tools.js";
import { journalRecords } from "../dist/runner/journal-reader.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { answerFlow, client, follow, scratch, serve } from "./support.mjs";

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY"];

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
  // Half of Browserbase's keys and none of Kernel's: no vendor runs, and the reason names each one's variables.
  // The plane keeps its own value (a run's meta stores it); only the words a person reads name Settings first.
  const STORED_NO_BROWSER_KEY = "unavailable: no browser key: set or save Browserbase's (BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID) or Kernel's (KERNEL_API_KEY)";
  const reason = "it needs a Browserbase key: save one in Settings → Tool keys (or set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID where the server starts), or a Kernel key: save one in Settings → Tool keys (or set KERNEL_API_KEY where the server starts)";
  const { summary: _, why: __, ...listed } = caps.tools.find((tool) => tool.name === "browser");
  assert.deepEqual(listed, { name: "browser", blurb: "Browse websites in a hosted browser", nodes: false, calls: false, available: false, reason, harnesses: ["pi"], providers: ["auto", "browserbase", "kernel", "chrome"], provider: "auto", default_provider: "auto", permission: "allow", default_permission: "allow", permissions: ["allow", "deny"], resolves: { pi: STORED_NO_BROWSER_KEY, "claude-agent": STORED_NO_BROWSER_KEY, codex: STORED_NO_BROWSER_KEY, opencode: STORED_NO_BROWSER_KEY }, key: "browserbase" });
  // No workflow model node takes the browser (#2098).
  assert.ok(!caps.workflows.node_tools.includes("browser"), JSON.stringify(caps.workflows.node_tools));
  assert.ok(!JSON.stringify(caps).includes("fake-project"), "no value of a variable is shown");
  assert.equal((await api("POST", "/agents", { definition: { id: "browse", name: "browse", instructions: "Browse.", tools: ["browser"] } })).status, 201);
  const refused = await api("POST", "/agents/browse/runs", { input: { content: "Browse the example page." } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "agent_not_runnable"]);
  assert.match(refused.body.error.message, /The\ tool\ browser\ does\ not\ run\ here\ on\ pi:\ it\ needs\ a\ Browserbase\ key:\ save\ one\ in\ Settings\ →\ Tool\ keys\ \(or\ set\ BROWSERBASE_API_KEY\ and\ BROWSERBASE_PROJECT_ID\ where\ the\ server\ starts\),\ or\ a\ Kernel\ key:\ save\ one\ in\ Settings\ →\ Tool\ keys\ \(or\ set\ KERNEL_API_KEY\ where\ the\ server\ starts\)\./);
  assert.deepEqual((await api("GET", "/runs")).body.runs, []);
});

test("an agentic run calls the browser: the provider on its runner is reached and answers, and the session is let go when the run is", async (t) => {
  const log = join(await scratch(t), "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project", FAUX_BROWSER_LOG: log });
  const { api, baseUrl, store } = await serve(t, { fauxBrowser: FAUX_BROWSER });
  assert.equal((await client(baseUrl)("GET", "/capabilities")).body.tools.find((tool) => tool.name === "browser").available, true);
  assert.equal((await api("POST", "/agents", { definition: { id: "browse", name: "browse", instructions: "Browse.", tools: ["browser", "read"] } })).status, 201);
  const started = await api("POST", "/agents/browse/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"]);
  assert.ok(rows.some((row) => row.kind === "tool_use" && row.tool_name === "snapshot"), "the snapshot call is a row");
  assert.match((await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, /The answer is forty-two\./, "the page's text came back through the tool");
  const ops = await ledger(log);
  assert.deepEqual(ops[0], { op: "env", BROWSERBASE_API_KEY: "set", BROWSERBASE_PROJECT_ID: "set" }, "the keys reach the run's browser");
  assert.ok(ops.some((row) => row.op === "create") && ops.some((row) => row.op === "attach"), JSON.stringify(ops.map((row) => row.op)));
  assert.ok(ops.some((row) => row.op === "release"), "the session the run held is released when the run is let go");
  // The session's custody is the run's journal in the one store: its release a task there, done before the run's end.
  const { tasks } = await journalRecords(store.readJournal(started.body.run_id), BACKGROUND_CONTEXT);
  const released = tasks.filter((task) => task.kind === "browser.release");
  assert.ok(released.length >= 1 && released.every((task) => task.state?.status === "terminal" && task.state.outcome?.status === "completed"), `the session's release in the run's journal: ${JSON.stringify(tasks.map((task) => [task.kind, task.state?.status]))}`);
});

test("a workflow whose model node names browser is refused when it is saved, in the words a node tool this server does not give is refused in, never accepted and then failed at its run (#2098)", async (t) => {
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" });
  const { api } = await serve(t, { fauxBrowser: FAUX_BROWSER });
  const nodeTools = (await api("GET", "/capabilities")).body.workflows.node_tools;
  const said = `A workflow's model nodes get the tools ${nodeTools.join(", ")} here; this workflow also names browser.`;
  const flow = answerFlow();
  flow.root.steps[0].tools = ["browser"];
  const saved = await api("POST", "/agents", { definition: { id: "flow", name: "flow", workflow: flow, tools: ["browser"] } });
  assert.equal(saved.status, 422, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.error.fields.map((f) => [f.field, f.reason, f.message]), [["definition.workflow", "not_an_option", said]]);
  assert.equal((await api("GET", "/agents/flow")).status, 404, "nothing saved");
  // Two parallel nodes that would browse: refused the same way, once for the tool.
  const pair = answerFlow();
  const reader = (label) => ({ ...pair.root.steps[0], label, as: label, tools: ["browser"] });
  pair.root.steps = [{ node: "parallel", label: "both", branches: [reader("left"), reader("right")] }];
  pair.output.path = "left";
  const both = await api("POST", "/agents", { definition: { id: "pair", name: "pair", workflow: pair, tools: ["browser"] } });
  assert.equal(both.status, 422, JSON.stringify(both.body));
  assert.deepEqual(both.body.error.fields.map((f) => f.message), [said]);
  assert.deepEqual((await api("GET", "/runs")).body.runs, []);
});

test("evidence names never collide: reads filed at once each keep their own file, and a later process's sink never overwrites one", async (t) => {
  const work = await scratch(t);
  const read = (n) => ({ tool: "browser_read", args: {}, status: "ok", facts: { sha256: `sha-${n}` }, body: `page ${n}` });
  // Filed through the run's Workspace: each sink a fresh one on the same folder, as a later process's is.
  const sink = evidenceIn(localWorkspace(work));
  const filed = await Promise.all([1, 2, 3].map((n) => sink.file("run", read(n))));
  const later = await evidenceIn(localWorkspace(work)).file("run", read(4));
  const shot = await evidenceIn(localWorkspace(work)).file("run", { tool: "screenshot", args: {}, status: "ok", facts: { sha256: "sha-5" }, body: new Uint8Array([5]), ext: "png" });
  const paths = [...filed, later].map((at) => at.path);
  assert.equal(new Set(paths).size, 4, paths.join(", "));
  for (const [i, path] of paths.entries()) assert.match(await readFile(join(work, path), "utf8"), new RegExp(`"sha256":"sha-${i + 1}"[^]*\\n\\npage ${i + 1}$`), path);
  assert.deepEqual([...(await readFile(join(work, shot.bodyPath)))], [5]);
  assert.equal((await readdir(join(work, "evidence"))).length, 6, "four reads, and a capture beside its facts");
});

test("capabilities say the same about the browser in features and in tools: browserbase when the tool is available, none when it is not", async (t) => {
  for (const [values, want] of [[{ BROWSERBASE_PROJECT_ID: "fake-project" }, "none"], [{ BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" }, "browserbase"]]) {
    await t.test(want, async (t) => {
      withEnv(t, values);
      const { baseUrl } = await serve(t);
      const caps = (await client(baseUrl)("GET", "/capabilities")).body;
      const listed = caps.tools.find((tool) => tool.name === "browser");
      assert.equal(caps.features.browser, want, JSON.stringify({ features: caps.features.browser, tool: listed }));
      assert.equal(caps.features.browser !== "none", listed.available);
    });
  }
});
