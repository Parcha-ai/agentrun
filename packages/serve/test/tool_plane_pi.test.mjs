// pi on the tool plane: a tool a revision names is served to pi through its registry, and a call is journaled as an
// effect in the calling run's OWN records (its run.sqlite), under the wire name the catalog gives it, nowhere else. pi
// runs in the run process with no box, so there is no plane socket to gate here (that gate arrives when pi's runner
// moves into a box). The records are read back the way the fetch-page tests read them: the run's own sqlite, entries in
// order, the assistant's toolCall and the toolResult.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-adapters/host";
import { startServe } from "../dist/index.js";
import { FAUX, client, follow, scratch, serve } from "./support.mjs";
import { wireName } from "../dist/catalog.js";

const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;
const FAUX_WEB_HOLD = new URL("./fixtures/faux-web-hold.mjs", import.meta.url).pathname;
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = processAlive;

/** The run's own records: every message in its run.sqlite, in order, read read-only the way a reader must. */
function entriesOf(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all().flatMap((row) => JSON.parse(row.record).model ?? []);
  } finally {
    db.close();
  }
}

/** Each tool call in the records: the assistant's `toolCall` content, `{ id, name }`. */
const callsIn = (messages) => messages.filter((m) => m.role === "assistant").flatMap((m) => (m.content ?? []).filter((c) => c.type === "toolCall"));
/** Each tool result in the records, by the tool it answered. */
const resultsIn = (messages) => messages.filter((m) => m.role === "toolResult");

/** Every file under `dir`, relative, sorted: for the before/after listing that proves nothing is written outside the run. */
async function tree(dir) {
  const out = [];
  const walk = async (rel) => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(at);
      else out.push(at);
    }
  };
  await walk("");
  return out.sort();
}

test("a pi run's tool call is journaled in its OWN records under the wire name, and nowhere else", async (t) => {
  const { api, data } = await serve(t, { fauxWeb: FAUX_WEB });
  assert.equal((await api("POST", "/agents", { definition: { id: "reader", name: "reader", instructions: "Read.", tools: ["fetch_page"] } })).status, 201);
  // Everything the data root holds once the agent is saved and before the run starts: every path the run then adds must
  // be under its own runs/<runId>/ directory. A path that existed here is allowed to change (the store index gets the
  // run's row); a NEW path anywhere but runs/<runId>/ is a plane-side store and fails.
  const before = await tree(data);
  const started = await api("POST", "/agents/reader/runs", { input: { content: `Fetch these pages: ${JSON.stringify(["http://public.example/"])}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed"]);

  const messages = entriesOf(data, runId);
  const calls = callsIn(messages);
  const results = resultsIn(messages);

  // (1) The call is journaled in the run's own records: a toolCall and its toolResult are both there.
  assert.equal(calls.length, 1, "one tool call in the run's own records");
  const result = results.find((r) => r.toolName === calls[0].name);
  assert.ok(result, "the call's result is journaled too");

  // (4) The journaled name is the wire name the catalog gives, computed, never a literal; the callId is the call's id.
  const wire = wireName("fetch_page");
  assert.equal(calls[0].name, wire, "the assistant's toolCall is journaled under the wire name");
  assert.ok(results.some((r) => r.toolName === wire), "the toolResult carries the wire name");
  assert.equal(typeof calls[0].id, "string");
  assert.notEqual(calls[0].id, "", "the call has a callId");
  // The tool was registered under that wire name and actually ran: its result is the page it fetched, not the
  // "no such tool" error a call gets when the name it was registered under is not the name the model called. This is
  // what makes a registration under a different name (a prefix) red here, not only a drift in the TOOLS key.
  const text = (result.content ?? []).map((c) => c.text ?? "").join("") || JSON.stringify(result.output ?? "");
  assert.doesNotMatch(text, /no (such )?tool|not a tool|unknown tool|is not bound/i, `the tool did not run under the wire name: ${text.slice(0, 200)}`);
  assert.equal(result.isError ?? false, false, `the tool's result is an error: ${text.slice(0, 200)}`);
  assert.match(text, /public\.example|"ok"|"status"|"title"/, `the tool ran and answered the page: ${text.slice(0, 200)}`);

  // (1, asserted not just mutated) No plane-side store: every path the run ADDED is under its own runs/<runId>/.
  // A path that existed before the run may change (the store index takes the run's row); any NEW path elsewhere — a
  // record or store the plane wrote outside the run — fails. The rule is "new => under runs/<runId>/", with no
  // per-directory exception; if serve ever writes a new per-run path outside runs/, name it here with its reason.
  const after = await tree(data);
  const added = after.filter((p) => !before.includes(p));
  const outside = added.filter((p) => !p.startsWith(`runs/${runId}/`));
  assert.deepEqual(outside, [], `the run added a path outside its own directory: ${outside.join(", ")}`);
});

// Gate (2): recovery honours a tool's replay class, which lives on the catalog entry the plane serves, not in the test.
// A call is held in-flight by a hold file, the server and the run's own process are killed, and the next server resumes
// the run: fetch_page (replay safe) runs again; faux_never (replay unsafe) is answered interrupted and never runs again.
// The faux_never entry is in the catalog only under AGENTRUN_SERVE_FAUX_NEVER, read when the catalog is built.
const FAUX_NEVER_ENV = "AGENTRUN_SERVE_FAUX_NEVER";
const FAUX_WEB_ENV = "AGENTRUN_SERVE_FAUX_WEB";

/** Set `vars` in this process's environment for the test (the spawned server and the in-process restart both read it),
 *  the rest unset; restored after. */
function env(t, vars) {
  const names = [FAUX_NEVER_ENV, FAUX_WEB_ENV, "FAUX_WEB_HOLD", "FAUX_WEB_LOG"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  for (const name of names) delete process.env[name];
  Object.assign(process.env, vars);
}

/** A server in a process of its own, so the test can kill it the way a crash does; it inherits this process's env. */
async function serverProcess(data) {
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  for (let i = 0; !/AGENTRUN_API_KEY=/.test(out); i++) {
    assert.ok(i < 200, `the server did not start: ${out}`);
    await sleep(50);
  }
  const base = /AGENTRUN_BASE_URL=(\S+)/.exec(out)[1];
  return { child, api: client(base, (await readFile(join(data, ".token"), "utf8")).trim()) };
}

/** Wait until the run's tool call is in-flight: its `tool_use` row is on the timeline with no `tool_result` yet. The
 *  call's execute is then blocked on the hold file, so the call outlives the crash with no result journaled. */
async function callInFlight(api, runId, toolName) {
  for (let i = 0; ; i++) {
    const { rows = [] } = (await api("GET", `/runs/${runId}/timeline`)).body;
    const started = rows.some((r) => r.kind === "tool_use" && r.tool_name === toolName);
    const ended = rows.some((r) => r.kind === "tool_result" && r.tool_name === toolName);
    if (started && !ended) return;
    // A generous setup wait: on a loaded machine the run's process is slow to reach the call; this only gates the crash.
    assert.ok(i < 2_000, `the ${toolName} call went in-flight`);
    await sleep(25);
  }
}

/** Run `agent` with `content` in a server process, wait until its tool call is in-flight (blocked on the hold file),
 *  kill the server and the run's own process the way a crash does, and return the data root and run id. */
async function crashInToolCall(t, { tools, content }) {
  const data = join(await scratch(t), "agents");
  const first = await serverProcess(data);
  t.after(() => first.child.kill("SIGKILL"));
  assert.equal((await first.api("POST", "/agents", { definition: { id: "a", name: "a", instructions: "Do.", tools } })).status, 201);
  const { body: run } = await first.api("POST", "/agents/a/runs", { input: { content } });
  const runId = run.run_id;
  await callInFlight(first.api, runId, tools[0]);
  const record = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  assert.ok(alive(record.holder.pid), "the run's process outlived its server");
  process.kill(record.holder.pid, "SIGKILL");
  for (let i = 0; alive(record.holder.pid); i++) {
    assert.ok(i < 200, "the run's process dies on SIGKILL");
    await sleep(50);
  }
  t.after(() => alive(record.holder.pid) && process.kill(record.holder.pid, "SIGKILL"));
  return { data, runId };
}

/** faux_never's result as the run's own records journal it, by its wire name (identity: it is already a wire name). */
function fauxNeverResult(data, runId) {
  const messages = entriesOf(data, runId);
  const wire = wireName("faux_never");
  const call = callsIn(messages).find((c) => c.name === wire);
  const result = resultsIn(messages).find((r) => r.toolName === wire);
  return { call, result, text: result ? (result.content ?? []).map((c) => c.text ?? "").join("") || JSON.stringify(result.output ?? "") : "" };
}

test("faux_never is in the catalog only when its env is set: unset, it is in no capability, registry or openapi document", async (t) => {
  env(t, {}); // FAUX_NEVER unset
  const { api } = await serve(t, {});
  // Capabilities' tool list and the registry (what a revision may name) do not hold it.
  const caps = (await api("GET", "/capabilities")).body;
  const names = (caps.tools ?? []).map((tool) => tool.name);
  assert.ok(!names.includes("faux_never"), `capabilities name faux_never: ${names.join(", ")}`);
  assert.equal((await api("POST", "/agents", { definition: { id: "n", name: "n", instructions: "Do.", tools: ["faux_never"] } })).status, 422, "a revision that names faux_never is refused");
  // The openapi document's tool list does not hold it either.
  const openapi = (await api("GET", "/openapi.json")).body;
  assert.doesNotMatch(JSON.stringify(openapi), /faux_never/, "the openapi document names faux_never");
});

test("an unsafe tool's call that a crash cut off is answered interrupted on resume and never runs again", { timeout: 120_000 }, async (t) => {
  // faux_never, replay unsafe: the next server answers the interrupted call; it never runs again. The hold file stays,
  // so if it wrongly re-ran it would block, not complete.
  const dir = await scratch(t);
  const hold = join(dir, "never.hold");
  await writeFile(hold, "");
  env(t, { [FAUX_NEVER_ENV]: hold });
  const unsafe = await crashInToolCall(t, { tools: ["faux_never"], content: "Call faux_never." });
  const next = await startServe({ data: unsafe.data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const { last } = await follow(api, unsafe.runId, ["completed", "failed"]);
  assert.equal(last.final, true);
  const never = fauxNeverResult(unsafe.data, unsafe.runId);
  assert.ok(never.call, "the interrupted call is journaled under the wire name");
  assert.match(never.text, /interrupted and may have partially run/i, `the unsafe call is answered interrupted, not re-run: ${never.text.slice(0, 200)}`);
  assert.doesNotMatch(never.text, /faux_never: done/, "the unsafe call's execute never ran to completion");
});

test("a safe tool's call that a crash cut off runs again on resume and the run completes", { timeout: 120_000 }, async (t) => {
  // fetch_page, replay safe: the next server re-runs the call; the test removes the hold file so the re-run lands.
  const dir = await scratch(t);
  const hold = join(dir, "web.hold");
  const log = join(dir, "dials.log");
  await writeFile(hold, "");
  env(t, { [FAUX_WEB_ENV]: FAUX_WEB_HOLD, FAUX_WEB_HOLD: hold, FAUX_WEB_LOG: log });
  const safe = await crashInToolCall(t, { tools: ["fetch_page"], content: `Fetch these pages: ${JSON.stringify(["http://public.example/"])}` });
  const next = await startServe({ data: safe.data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  // Let the re-run through: the re-run's dial polls the hold file, which is now gone.
  await rm(hold, { force: true });
  const { last } = await follow(api, safe.runId, ["completed"]);
  assert.equal(last.final, true, "the safe call re-ran and the run completed");
  // The call was cut off before it dialled (it blocked first); the dial is the re-run's, so the log proves the re-run
  // ran, and completion proves the safe call was re-run, not answered interrupted.
  const dials = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  assert.deepEqual(dials, ["http://public.example/"], `the re-run dialled the page: ${dials.join(", ")}`);
  const pages = entriesOf(safe.data, safe.runId).filter((m) => m.role === "toolResult" && m.toolName === wireName("fetch_page"));
  assert.equal(pages.length, 1, "one fetch_page result in the records");
  const text = (pages[0].content ?? []).map((c) => c.text ?? "").join("") || JSON.stringify(pages[0].output ?? "");
  assert.doesNotMatch(text, /interrupted and may have partially run/i, "the safe call was re-run, not answered interrupted");
  assert.match(text, /public\.example|"ok"|"status"|"title"/, `the re-run answered the page: ${text.slice(0, 200)}`);
});
