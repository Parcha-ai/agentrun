// A tool key the server is started with (its launcher's, or its environment) is checked once, as it starts, with the
// same call that costs nothing a saved key gets (key-check.ts), never holding up the start. A key its provider refuses
// shows as refused on GET /v2/settings/tool-keys, and the tools it unlocks read unavailable in capabilities, saying who
// refused which key and what to do; one it accepts shows accepted, and its tools stay available. On fakes: no network,
// no real key.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { calls as bbCalls, KEY as BB_KEY, release as releaseBrowserbase } from "./fixtures/faux-browserbase-check.mjs";
import { calls as monidCheckCalls } from "./fixtures/faux-monid-check.mjs";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { startServe } from "../dist/index.js";
import { client, FAUX, scratch, serve, withEnv } from "./support.mjs";

const FAUX_BROWSERBASE = new URL("./fixtures/faux-browserbase-check.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const FAUX_MONID_CHECK = new URL("./fixtures/faux-monid-check.mjs", import.meta.url).pathname;
const KEYS = ["PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "TYPESAFE_API_KEY", "AGENTRUN_SEAL_KEY", "AGENTRUN_TEST_FAUX_BROWSERBASE_STALL", "AGENTRUN_TEST_FAUX_MONID_STALL", "AGENTRUN_TEST_FAUX_MONID_CALLS"];
/** The calls the runs' monid fake filed (faux-monid.mjs, AGENTRUN_TEST_FAUX_MONID_CALLS). */
const filed = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
/** A throwaway wrong key: built here, never a real one. */
const wrong = () => ["bb", "wrong", randomBytes(8).toString("hex")].join("_");
const rowOf = (view, id) => view.keys.find((key) => key.id === id);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const REFUSED = "Browserbase refused BROWSERBASE_API_KEY (401: Unauthorized) when this server started: set the right one where AgentRun starts, then restart it";

/** The row's check once the start's check has answered (at most `ms`). */
async function checked(api, id, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    const row = rowOf((await api("GET", "/settings/tool-keys")).body, id);
    if (row.check !== null || Date.now() > until) return row;
    await new Promise((go) => setTimeout(go, 50));
  }
}

test("a Browserbase key the server starts with and Browserbase refuses: refused on its key row, and the browser unavailable in capabilities, saying who refused which key and what to do", async (t) => {
  const key = wrong();
  withEnv(t, { BROWSERBASE_API_KEY: key, BROWSERBASE_PROJECT_ID: "proj-1" }, KEYS);
  const { api, baseUrl } = await serve(t, { fauxBrowserbase: FAUX_BROWSERBASE });
  const row = await checked(api, "browserbase");
  assert.deepEqual([row.fields[0].source, row.check?.state, row.check?.reason], ["server", "refused", REFUSED], JSON.stringify(row));
  assert.match(row.check.at, ISO);
  const browser = (await client(baseUrl)("GET", "/capabilities")).body.tools.find((tool) => tool.name === "browser");
  assert.deepEqual([browser.available, browser.reason], [false, REFUSED], JSON.stringify(browser));
  const doc = (await api("GET", "/openapi.json")).body;
  const view = (await api("GET", "/settings/tool-keys")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths["/settings/tool-keys"].get.responses["200"].content["application/json"].schema, view), [], JSON.stringify(view));
  for (const text of [JSON.stringify(view), JSON.stringify(browser)]) assert.ok(!text.includes(key) && !text.includes(key.slice(-12)), "no part of the key is shown");
  assert.deepEqual(bbCalls.filter((call) => !call.authorized).map((call) => [call.method, call.path]).slice(-1), [["GET", "/v1/projects"]], "one free call: the list of projects");
});

test("a Browserbase key the server starts with and Browserbase accepts: accepted on its key row, and the browser available", async (t) => {
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1" }, KEYS);
  const { api, baseUrl } = await serve(t, { fauxBrowserbase: FAUX_BROWSERBASE });
  const row = await checked(api, "browserbase");
  assert.equal(row.check?.state, "accepted", JSON.stringify(row));
  assert.equal((await client(baseUrl)("GET", "/capabilities")).body.tools.find((tool) => tool.name === "browser").available, true);
});

test("a monid key the server starts with is checked against monid's check fake: one monid refuses leaves its three tools unavailable, saying why; one it accepts leaves them available; the runs' fake sees neither check", async (t) => {
  for (const [key, available] of [[["monid", "wrong", randomBytes(6).toString("hex")].join("_"), false], [MONID_KEY, true]]) {
    await t.test(String(available), async (t) => {
      const log = join(await scratch(t), "monid-calls.jsonl");
      withEnv(t, { MONID_API_KEY: key, AGENTRUN_TEST_FAUX_MONID_CALLS: log }, KEYS);
      const before = monidCheckCalls.length;
      const { api, baseUrl } = await serve(t, { fauxMonid: FAUX_MONID, fauxMonidCheck: FAUX_MONID_CHECK });
      const row = await checked(api, "monid");
      assert.equal(row.check?.state, available ? "accepted" : "refused", JSON.stringify(row));
      const tools = (await client(baseUrl)("GET", "/capabilities")).body.tools.filter((tool) => tool.name.startsWith("monid."));
      assert.equal(tools.length, 3, JSON.stringify(tools));
      assert.deepEqual(tools.map((tool) => tool.available), [available, available, available], JSON.stringify(tools));
      if (!available) {
        for (const tool of tools) assert.match(tool.reason, /^Monid refused MONID_API_KEY \(401: Missing or invalid API key\) when this server started/, tool.name);
        assert.equal(row.check.reason, tools[0].reason);
        assert.ok(!JSON.stringify(row).includes(key), "no part of the key is shown");
      }
      assert.deepEqual(monidCheckCalls.slice(before).map((call) => [call.method, call.path, call.authorized]), [["POST", "/v1/discover", available]], "one discover, through the check's fake");
      assert.deepEqual(filed(log), [], "the runs' fake saw no call");
    });
  }
});

test("under faux, a key with no check fake of its own is not checked at the start: the fakes the runs use see the runs' calls alone", async (t) => {
  withEnv(t, { MONID_API_KEY: ["monid", "wrong", randomBytes(6).toString("hex")].join("_") }, KEYS);
  const { api, baseUrl } = await serve(t, { fauxMonid: FAUX_MONID });
  await new Promise((go) => setTimeout(go, 300));
  assert.equal(rowOf((await api("GET", "/settings/tool-keys")).body, "monid").check, null);
  assert.ok((await client(baseUrl)("GET", "/capabilities")).body.tools.filter((tool) => tool.name.startsWith("monid.")).every((tool) => tool.available));
});

test("the start's check never holds up the start: with Browserbase not answering, the server answers, the row reads not yet checked (null) and the browser available until it answers", async (t) => {
  withEnv(t, { BROWSERBASE_API_KEY: wrong(), BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_TEST_FAUX_BROWSERBASE_STALL: "1" }, KEYS);
  t.after(releaseBrowserbase);
  const started = performance.now();
  const { api, baseUrl } = await serve(t, { fauxBrowserbase: FAUX_BROWSERBASE });
  assert.ok(performance.now() - started < 4_000, "the start did not wait on the check");
  assert.equal(rowOf((await api("GET", "/settings/tool-keys")).body, "browserbase").check, null);
  assert.equal((await client(baseUrl)("GET", "/capabilities")).body.tools.find((tool) => tool.name === "browser").available, true);
  releaseBrowserbase();
  const row = await checked(api, "browserbase");
  assert.equal(row.check?.state, "refused", JSON.stringify(row));
  assert.equal((await client(baseUrl)("GET", "/capabilities")).body.tools.find((tool) => tool.name === "browser").available, false);
});

test("a check fake that does not load leaves the server up: the key's row says its check could not start, and no rejection goes unhandled", async (t) => {
  withEnv(t, { BROWSERBASE_API_KEY: wrong(), BROWSERBASE_PROJECT_ID: "proj-1" }, KEYS);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const missing = join(await scratch(t), "no-such-check-fake.mjs");
  const { api, baseUrl } = await serve(t, { fauxBrowserbase: missing });
  const row = await checked(api, "browserbase");
  assert.equal(row.check?.state, "not_checked", JSON.stringify(row));
  assert.match(row.check.reason, /^Browserbase's key could not be checked: its check did not start \(/, row.check.reason);
  await new Promise((go) => setTimeout(go, 200));
  assert.equal((await client(baseUrl)("GET", "/capabilities")).status, 200, "the server is still up");
  assert.deepEqual(unhandled, [], "no rejection went unhandled");
});

test("a start that fails to listen sends no key check: the check starts only once the server listens", async (t) => {
  withEnv(t, { BROWSERBASE_API_KEY: wrong(), BROWSERBASE_PROJECT_ID: "proj-1" }, KEYS);
  const { createServer } = await import("node:net");
  const taken = createServer();
  await new Promise((go) => taken.listen(0, "127.0.0.1", go));
  t.after(() => new Promise((go) => taken.close(go)));
  const before = bbCalls.length;
  const data = join(await scratch(t), "agents");
  await assert.rejects(startServe({ data, port: taken.address().port, faux: FAUX, fauxBrowserbase: FAUX_BROWSERBASE, drainTimeout: "5s" }), (error) => error.code === "EADDRINUSE");
  await new Promise((go) => setTimeout(go, 300));
  assert.deepEqual(bbCalls.slice(before), [], "no request reached the provider's check");
});
