// claude-agent on the tool plane: a tool a revision names is served to a claude-agent run through the harness's own MCP
// server, and the call is journaled in the run's OWN records (its run.sqlite entries) under the wire name the catalog
// gives it, the way the fetch-page tests read a non-pi run. The journal is the harness-app projection: a tool_start
// becomes an assistant toolCall { id, name }, and the result a toolResult { toolCallId, toolName }. The replay class a
// crash honours lives in host-tools.ts REPLAY (read and fetch_page safe, write and edit never), and is checked by name.
//
// Gate (3), the socket (the box's only sockets are the model front and the egress proxy, and the plane socket is never
// among them), is a SEPARATE PR stacked on the box-network change; it is PENDING and this PR adds and binds no socket.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-adapters/host";
import { wireName } from "../dist/catalog.js";
import { follow, scratch, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kill a non-pi run's own process the way a crash does. */
async function killRun(data, runId) {
  const { holder } = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
  process.kill(holder.pid, "SIGKILL");
  for (let i = 0; processAlive(holder.pid); i++) {
    assert.ok(i < 200, "the run's process dies on SIGKILL");
    await sleep(50);
  }
}

/** The run's own records: every message in its run.sqlite, in order, read read-only. */
function messagesOf(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all().flatMap((row) => JSON.parse(row.record).model ?? []);
  } finally {
    db.close();
  }
}
const callsIn = (messages) => messages.filter((m) => m.role === "assistant").flatMap((m) => (m.content ?? []).filter((c) => c.type === "toolCall"));
const resultsIn = (messages) => messages.filter((m) => m.role === "toolResult");

/** A claude-agent agent that fetches `url` and says its title (the faux harness scripts one fetch_page call then an answer). */
async function fetchingClaude(t, url) {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, fauxWeb: FAUX_WEB });
  assert.equal((await api("POST", "/agents", { definition: { id: "c", name: "c", harness: "claude-agent", instructions: `Fetch ${url} and say its title.`, tools: ["fetch_page"] } })).status, 201);
  const started = await api("POST", "/agents/c/runs", { input: { content: "go" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 120_000 });
  return { data, runId: started.body.run_id };
}

test("a claude-agent run's tool call is journaled in its OWN records under the wire name", { timeout: 120_000 }, async (t) => {
  const { data, runId } = await fetchingClaude(t, "http://public.example/");
  const messages = messagesOf(data, runId);
  const calls = callsIn(messages);
  const results = resultsIn(messages);
  const wire = wireName("fetch_page");

  // (1) The call is journaled in the run's own records: exactly one toolCall and its one toolResult, the result paired
  // with the call by its id, so a duplicate or a result linked to another call fails.
  const fetchCalls = calls.filter((c) => c.name === wire);
  assert.equal(fetchCalls.length, 1, `one fetch_page call under the wire name: ${calls.map((c) => c.name).join(", ")}`);
  const fetchResults = results.filter((r) => r.toolName === wire);
  assert.equal(fetchResults.length, 1, "one fetch_page result under the wire name");
  // The callId is a nonempty string before the pairing is compared, so a record that dropped both ids does not pass by
  // undefined === undefined.
  assert.equal(typeof fetchCalls[0].id, "string", "the callId is a string");
  assert.notEqual(fetchCalls[0].id, "", "the call has a callId");
  assert.equal(fetchResults[0].toolCallId, fetchCalls[0].id, "the result answers the journaled call by id");

  // (4) The journaled name is the wire name the catalog gives, computed, never a literal; the tool actually ran under it
  // (the result is the page the fetch answered, not a "no such tool" error a call gets when the name it ran under is not
  // the one the model called), so a registration under a different name is red here, not only a drift in the TOOLS key.
  assert.equal(fetchCalls[0].name, wire, "the toolCall is journaled under the wire name");
  const text = (fetchResults[0].content ?? []).map((c) => c.text ?? "").join("") || JSON.stringify(fetchResults[0].output ?? "");
  const page = JSON.parse(text);
  assert.equal(page.ok, true, `the fetch succeeded, not refused or errored: ${text.slice(0, 200)}`);
  assert.equal(page.status, 200, "the page answered 200");
  assert.equal(page.title, "Public page", "the tool returned the fixture page it fetched");
});


// Gate (2b): the binding. A served claude-agent run's host tools reach the adapter as HostTools whose replay class is
// the catalog's REPLAY[name] — read and fetch_page safe, write and edit never — asserted by name on the SERVED path (the
// faux harness reports the class each tool reached it with), not on the REPLAY table alone. A serve that handed the
// adapter a class-less tool, or the wrong class, is red here.
test("a served claude-agent run's host tools carry their catalog replay class to the adapter, by name", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  assert.equal((await api("POST", "/agents", { definition: { id: "b", name: "b", harness: "claude-agent", instructions: "Say each tool's replay class.", tools: ["read", "write", "edit", "fetch_page"] } })).status, 201);
  const started = await api("POST", "/agents/b/runs", { input: { content: "go" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
  // The agent's answer is the [name, replay] pairs the harness saw; read it from the run's record.
  const answer = (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";
  const classes = Object.fromEntries(JSON.parse(answer));
  assert.deepEqual(classes, { read: "safe", write: "never", edit: "never", fetch_page: "safe" }, `each host tool reached the adapter with its catalog class: ${answer}`);
});
