// A workflow run cut by a crash before a call node's paid request: the next process resumes the workflow when its harness
// resumes, before the app's open hook (onOpen) runs, so the node's request may be sent first. It must be booked under its
// call, as on a first run (paid-calls.ts), and sent once: never refused as a request with no call to book it under. This
// drives the real launch: the server, the run's process, its death and its relaunch. The run is paused between its two
// call nodes, so it is killed with the first ended and the second never started; a preload makes the relaunched process's
// onOpen wait for the second (open-after-effect.mjs), the race's worst case every time.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { PARALLEL_SEARCH_USD } from "../dist/paid-calls.js";
import { readNodeLog, RUN_PAUSED } from "../dist/pause.js";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { follow, runDir, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const OPEN_AFTER = fixture("open-after-effect.mjs");
const HELD = "http://public.example/?hold";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, ms = 55_000) {
  for (const end = Date.now() + ms; !(await check()); await sleep(20)) assert.ok(Date.now() < end, what);
}

/** The run's paid records (agentrun.tool_*), in order. */
function paidRecords(data, runId) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind.startsWith("agentrun.tool_")).map((entry) => ({ kind: entry.kind, ...entry.data }));
  } finally {
    db.close();
  }
}

test("a workflow cut by a crash before its call node's paid request, resumed: the request is sent before the app's onOpen, booked under its call and sent once, never refused as having no call to book it under", { timeout: 150_000 }, async (t) => {
  const scratchDir = await scratch(t);
  const [hold, parallelLog, opened] = [join(scratchDir, "hold"), join(scratchDir, "parallel.jsonl"), join(scratchDir, "opened")];
  withEnv(t, { PARALLEL_API_KEY: CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: parallelLog, FAUX_WEB_HOLD: hold }, ["PARALLEL_API_KEY", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS", "FAUX_WEB_HOLD"]);
  const server = await serve(t, { fauxParallel: fixture("faux-parallel.mjs"), fauxWeb: fixture("faux-gate-web.mjs") });
  const Page = { type: "object" };
  const Search = { type: "object", required: ["query", "results"], properties: { query: { type: "string" }, results: { type: "array" } } };
  const flow = { v: 2, name: "resumed-paid", schemas: { In: { type: "object", required: ["q"], properties: { q: { type: "string" } } }, Page, Search }, input: { schemaId: "In" }, output: { schemaId: "Search", path: "found" }, root: { node: "chain", steps: [
    { node: "call", label: "Read", via: "tool", tool: "web_fetch", args: { url: HELD }, out: "Page", as: "page", deadline_s: 60 },
    { node: "call", label: "Search", via: "tool", tool: "web_search", args: { query: "{q}", n: 2 }, out: "Search", as: "found", deadline_s: 60 },
  ] } };
  const created = await server.api("POST", "/agents", { definition: { id: "resumed-paid", name: "resumed-paid", workflow: flow, tools: ["web_fetch", "web_search"], tool_settings: { web_search: { provider: "parallel" } } } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const started = await server.api("POST", "/agents/resumed-paid/runs", { input: { q: "acme registry" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const root = runDir(server.data, runId);
  // The first call node is on the wire: pause the run, then let the call answer. It ends, and the second waits at the
  // pause, never admitted.
  await until(() => existsSync(`${hold}.waiting`), "the first call node reached the network");
  await writeFile(join(root, RUN_PAUSED), "");
  await writeFile(hold, "");
  await until(async () => (await readNodeLog(root)).some((line) => line.t === "effect.end" && line.label === "Read" && line.status === "done"), "the first call node ended");
  // Its outcome committed: the driver's write after the effect, on a FULL store, well within this.
  await sleep(2_000);
  assert.ok(!(await readNodeLog(root)).some((line) => line.t === "effect.start" && line.label === "Search"), "the second call node never started");
  assert.equal(existsSync(parallelLog), false, "nothing reached Parallel before the crash");
  // The relaunched process's onOpen waits for the second call node's end.
  withEnv(t, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${OPEN_AFTER}`.trim(), AGENTRUN_TEST_OPEN_AFTER_EFFECT: "Search", AGENTRUN_TEST_OPEN_AFTER_SIGNAL: opened });
  const { pid } = runRecordOf(server.data, runId).holder;
  process.kill(pid, "SIGKILL");
  await until(() => !processAlive(pid), "the run's process died");
  await rm(join(root, RUN_PAUSED));
  const { last, rows } = await follow(server.api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  const view = (await server.api("GET", `/runs/${runId}`)).body;
  const nodes = await readNodeLog(root);
  // The cause first: the resumed node's request is never refused as having no call to book it under, wherever the run
  // says so (its error, its rows, its node log). What it says is shown when it does.
  const said = JSON.stringify({ error: view.error ?? null, rows, nodes });
  const at = said.indexOf("no call to book it under");
  assert.equal(at === -1 ? null : said.slice(Math.max(0, at - 300), at + 100), null, "the resumed node's request is never refused as having no call to book it under");
  assert.equal(await readFile(opened, "utf8").catch(() => "never"), "ended", "the relaunched process's onOpen ran after the resumed node's request");
  const search = nodes.filter((line) => line.t === "effect.end" && line.label === "Search");
  assert.deepEqual(search.map((line) => [line.status, line.error ?? null]), [["done", null]], "the resumed node's request was booked and sent");
  const sent = (await readFile(parallelLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((call) => [call.path, call.authorized]), [["/v1/search", true]], "sent once");
  const paid = paidRecords(server.data, runId);
  assert.deepEqual(paid.map((entry) => [entry.kind, entry.tool, entry.charged_by, entry.heldUsd ?? entry.usd]), [
    ["agentrun.tool_started", "web_search", "parallel", PARALLEL_SEARCH_USD],
    ["agentrun.tool_cost", "web_search", "parallel", PARALLEL_SEARCH_USD],
  ]);
  assert.ok(paid[0].call && paid[0].call === paid[1].call, `booked under its call: ${paid.map((entry) => entry.call)}`);
  assert.equal(last.final, true);
  assert.equal(view.status, "completed", JSON.stringify(view.error ?? null));
});
