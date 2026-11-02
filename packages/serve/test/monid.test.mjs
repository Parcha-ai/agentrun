// monid's catalog on one key: the client against the tests' fake monid (fixtures/faux-monid.mjs), the three table tools in
// capabilities and at a save, and a pi run whose model calls them by their wire names. No network, no real key.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { wireName } from "../dist/catalog.js";
import { CLIP, monidClient, monidText } from "../dist/monid.js";
import fakeMonid, { calls, KEY } from "./fixtures/faux-monid.mjs";
import { agent, client, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const NAMES = ["monid.discover", "monid.inspect", "monid.run"];
const sleeps = [];
/** The client on the fake, its waits recorded and skipped. */
const monid = (extra = {}) => monidClient({ key: KEY, fetch: fakeMonid, sleep: async (ms) => void sleeps.push(ms), ...extra });
const sent = (from) => calls.slice(from).map((call) => `${call.method} ${call.path}`);

test("discover and inspect pass monid's answer through; one over 60,000 characters is cut, the whole filed under evidence/monid/", async (t) => {
  const work = await scratch(t);
  const found = await monid().discover({ query: "enrich a person", limit: 2 });
  assert.deepEqual([found.count, found.results[0].endpoint, found.results[0].price.amount.value], [2, "/person/enrich", 0.003]);
  const shown = await monid().inspect({ provider: "faux", endpoint: "/person/enrich" });
  assert.deepEqual(shown.input.body.required, ["name"]);
  assert.equal(await monidText(shown, work, "inspect"), JSON.stringify(shown), "a short answer is its JSON, whole");
  const wide = await monid().discover({ query: "everything at once" });
  const text = await monidText(wide, work, "discover");
  const where = /the whole answer is in the run's files at (evidence\/monid\/discover-[^\]\s]+\.json)\]$/.exec(text)?.[1];
  assert.ok(where, text.slice(-200));
  assert.equal(text.indexOf("\n[cut at"), CLIP);
  assert.deepEqual(JSON.parse(await readFile(join(work, where), "utf8")), wide);
});

test("a run: a sync provider's output with its cost in dollars; an async one read until COMPLETED; each sent once", async () => {
  const now = await monid().run({ provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } });
  assert.deepEqual([now.status, now.output, now.cost], ["COMPLETED", { full_name: "Ada" }, { value: 0.003, currency: "USD" }]);
  sleeps.length = 0;
  const from = calls.length;
  const later = await monid({ pollMs: 1500 }).run({ provider: "faux", endpoint: "/tweets" });
  assert.deepEqual([later.status, later.output, later.cost], ["COMPLETED", [{ text: "a tweet" }], { value: 0.012, currency: "USD" }]);
  assert.deepEqual(sent(from), ["POST /v1/run", `GET /v1/runs/${later.runId}`, `GET /v1/runs/${later.runId}`]);
  assert.deepEqual(sleeps, [1500, 1500]);
});

test("a refusal is an error in words: the wallet (402), the workspace's budget (BLOCKED), FAILED, TIMED_OUT, the provider's 404, a wrong key", async () => {
  const run = (endpoint, key = KEY) => monid({ key }).run({ provider: "faux", endpoint });
  const wallet = await run("/wallet");
  assert.deepEqual([wallet.status, /wallet's balance is too low/.test(wallet.error)], [402, true], wallet.error);
  const budget = await run("/budget");
  assert.match(budget.error, /\(BLOCKED\): The workspace's monthly budget is spent\./);
  assert.deepEqual(budget.controls, [{ type: "BUDGET" }]);
  assert.match((await run("/broken")).error, /failed inside monid \(FAILED\)/);
  const late = await run("/late");
  assert.deepEqual([late.status, /TIMED_OUT/.test(late.error)], [408, true]);
  const missing = await run("/missing");
  assert.deepEqual([missing.status, missing.cost], [404, { value: 0, currency: "USD" }]);
  assert.match(missing.error, /No match found for the given query \(monid charges nothing/);
  assert.match((await run("/person/enrich", "not-a-secret")).error, /refused the key \(401\)/);
});

test("a run its caller stops is asked to stop at monid and answers so; one that outlasts the wait is stopped too", async () => {
  const controller = new AbortController();
  const from = calls.length;
  const stopped = await monid({ sleep: async () => controller.abort() }).run({ provider: "faux", endpoint: "/slow" }, controller.signal);
  assert.match(stopped.error, /was stopped by the caller; monid was asked to stop it/);
  assert.deepEqual(sent(from), ["POST /v1/run", `POST /v1/runs/${stopped.runId}/stop`], "never read again, never sent again");
  const outlasted = await monid({ waitMs: 50, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }).run({ provider: "faux", endpoint: "/slow" });
  assert.match(outlasted.error, /did not end in 0\.05 s; monid was asked to stop it/);
  assert.equal(calls.at(-1).path, `/v1/runs/${outlasted.runId}/stop`);
});

test("at the deadline the stop goes at once: after a sleep that spent the whole wait nothing is read, and a slow read is cut at the deadline", async () => {
  const waitMs = 300;
  let from = calls.length;
  let start = Date.now();
  const spent = await monid({ waitMs, sleep: () => new Promise((resolve) => setTimeout(resolve, waitMs + 20)) }).run({ provider: "faux", endpoint: "/slow" });
  assert.match(spent.error, /did not end in 0\.3 s; monid was asked to stop it/);
  assert.deepEqual(sent(from), ["POST /v1/run", `POST /v1/runs/${spent.runId}/stop`], "no read past the deadline");
  assert.ok(Date.now() - start < waitMs + 200, `stopped ${Date.now() - start} ms after the start`);
  // Each read hangs until its limit: the one the deadline leaves, never the 30 s a read gets on its own.
  const reads = [];
  const slowReads = (url, init = {}) => {
    if ((init.method ?? "GET") !== "GET") return fakeMonid(url, init);
    const read = { at: Date.now() };
    reads.push(read);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject((read.cut = Date.now(), init.signal.reason)), { once: true }));
  };
  from = calls.length;
  start = Date.now();
  // A read's limit is an unref'd timer, as a socket would hold the loop: this holds it in the socket's place.
  const held = setInterval(() => {}, 1_000);
  const slow = await monid({ waitMs, fetch: slowReads }).run({ provider: "faux", endpoint: "/slow" }).finally(() => clearInterval(held));
  assert.match(slow.error, /did not end in 0\.3 s; monid was asked to stop it/);
  assert.deepEqual(sent(from), ["POST /v1/run", `POST /v1/runs/${slow.runId}/stop`]);
  assert.ok(reads.length >= 1 && reads.every((read) => read.cut !== undefined && read.cut - start <= waitMs + 150), JSON.stringify(reads.map((read) => [read.at - start, read.cut - start])));
  assert.ok(Date.now() - start < waitMs + 250, `stopped ${Date.now() - start} ms after the start`);
});

test("a cut answer whose whole copy cannot be filed still answers, cut and saying so", async (t) => {
  const work = await scratch(t);
  await mkdir(join(work, "evidence"), { recursive: true });
  await writeFile(join(work, "evidence", "monid"), "a file where the directory would go");
  const huge = await monid().run({ provider: "faux", endpoint: "/huge" });
  const text = await monidText(huge, work, "run");
  assert.equal(text.indexOf("\n[cut at"), CLIP);
  assert.match(text, /the whole answer could not be saved \(E[A-Z]+\)\]$/);
});

test("a run's answer over 60,000 characters is cut, the whole of it filed as evidence/monid/<run id>.json", async (t) => {
  const work = await scratch(t);
  const huge = await monid().run({ provider: "faux", endpoint: "/huge" });
  const text = await monidText(huge, work, "run");
  assert.ok(text.endsWith(`the whole answer is in the run's files at evidence/monid/${huge.runId}.json]`), text.slice(-200));
  assert.equal(text.indexOf("\n[cut at"), CLIP);
  assert.deepEqual(JSON.parse(await readFile(join(work, "evidence", "monid", `${huge.runId}.json`), "utf8")), huge);
});

test("capabilities list the three, on pi only: missing MONID_API_KEY on a keyless server, available with it", async (t) => {
  assert.deepEqual(NAMES.map(wireName), ["monid_discover", "monid_inspect", "monid_run"], "the names pi registers");
  withEnv(t, {}, ["MONID_API_KEY"]);
  const listed = async () => (await client((await serve(t)).baseUrl)("GET", "/capabilities")).body.tools.filter((tool) => NAMES.includes(tool.name));
  assert.deepEqual((await listed()).map((tool) => [tool.name, tool.available, tool.missing, tool.nodes, tool.calls, tool.harnesses]), NAMES.map((name) => [name, false, ["MONID_API_KEY"], false, false, ["pi"]]));
  process.env.MONID_API_KEY = KEY;
  assert.deepEqual((await listed()).map((tool) => [tool.name, tool.available, tool.missing]), NAMES.map((name) => [name, true, undefined]));
});

test("a pi revision naming the three saves with a warning on a keyless server and its run is 409; on claude-agent they run on pi only", async (t) => {
  withEnv(t, {}, ["MONID_API_KEY"]);
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const saved = await api("POST", "/agents", agent("finder", { tools: NAMES }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings.map((w) => [w.field, w.reason]), NAMES.map((_, i) => [`definition.tools[${i}]`, "not_set_up_here"]));
  const run = await api("POST", "/agents/finder/runs", { input: { content: "hi" } });
  assert.deepEqual([run.status, run.body.error.code, run.body.error.details.missing], [409, "agent_not_runnable", Object.fromEntries(NAMES.map((name) => [name, ["MONID_API_KEY"]]))]);
  const claude = await api("POST", "/agents", agent("finder-claude", { harness: "claude-agent", tools: ["read", "monid.run"] }));
  assert.equal(claude.status, 201, JSON.stringify(claude.body));
  assert.match(claude.body.warnings.find((w) => w.field === "definition.tools[1]")?.message ?? "", /^monid\.run runs on pi here; on claude-agent it is not bound yet\.$/);
  const refused = await api("POST", "/agents/finder-claude/runs", { input: { content: "hi" } });
  assert.deepEqual([refused.status, refused.body.error.details.unbound], [409, ["monid.run"]]);
});

test("a pi run's model finds, reads and runs a monid endpoint through monid_discover, monid_inspect and monid_run, on the key from its pipe", { timeout: 90_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api } = await serve(t, { fauxMonid: FAUX_MONID });
  const saved = await api("POST", "/agents", agent("enricher", { tools: NAMES }));
  assert.deepEqual([saved.status, saved.body.warnings], [201, []]);
  const started = await api("POST", "/agents/enricher/runs", { input: { content: "Enrich with monid: Ada at Example." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  assert.match((await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, /^Ran: \{.*"full_name":"Ada".*"cost":\{"value":0\.003,"currency":"USD"\}/);
  const seen = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(seen.map((call) => [call.method, call.path, call.authorized]), [["POST", "/v1/discover", true], ["POST", "/v1/inspect", true], ["POST", "/v1/run", true]]);
  assert.ok(seen.every((call) => call.pid !== process.pid), "each from the run's process");
  // The timeline names each call by the name pi registered, the wire name: mapping it back to the catalog name is later work.
  const rows = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows;
  assert.deepEqual(rows.filter((row) => row.kind === "tool_use").map((row) => row.tool_name), ["monid_discover", "monid_inspect", "monid_run"]);
  assert.deepEqual(rows.filter((row) => row.kind === "tool_result").map((row) => row.tool_status), ["success", "success", "success"]);
});
