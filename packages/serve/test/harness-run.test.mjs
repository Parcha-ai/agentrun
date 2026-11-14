// A run on a harness other than pi, on the faux harness: it starts, answers, takes a follow-up after its end and while
// it works, and completes; each paid request is counted once, also when the run's runner dies mid-turn (support.mjs
// crashRunner) and the next runner takes the run up and resumes the session.
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, client, FAUX, follow, journalOf, runDir, scratch, serve, startInProcessRunner, withEnv, startServe } from "./support.mjs";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";
import { CANARY as PARALLEL_CANARY } from "./fixtures/faux-parallel.mjs";
import { LONG_ANSWER } from "./fixtures/faux-harness.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";


const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const usageOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage;
const answer = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer;
/** The timeline's rows that say the run's process opened again after the last one ended unfinished. */
const resumedRows = (rows) => rows.filter((r) => r.kind === "phase" && r.summary.startsWith("Resumed")).map((r) => r.summary);

async function started(api, id, instructions, harness = "claude-agent", tools = []) {
  assert.equal((await api("POST", "/agents", agent(id, { harness, instructions, tools }))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

test("with a faux harness every harness runs; a claude-agent run answers, takes follow-ups after its end and completes again, each request counted once", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.map((h) => [h.id, h.available]), [["pi", true], ["claude-agent", true], ["codex", true], ["opencode", true]]);
  const runId = await started(api, "chat", "Answer the question.");
  const first = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await answer(api, runId), "Answer 1.");
  assert.deepEqual(usageOf(first.rows), { usd: 0.002, requests: 2 });
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and then?" })).status, 202);
  const second = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await answer(api, runId), "Answer 2.");
  assert.deepEqual(usageOf(second.rows), { usd: 0.004, requests: 4 });
  assert.deepEqual(second.rows.filter((r) => r.kind === "user_message").map((r) => r.text), ["hi", "and then?"]);
});

test("one turn of three paid requests costs their sum, once: never twice", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "three", "Make three requests.", "codex");
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.deepEqual(usageOf(rows), { usd: 0.007, requests: 3 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, 0.007);
});

// A runner's crash is its process's (support.mjs crashRunner: runner.ts kill, nothing released, no write of its loops
// lands), and a lease short enough that the next runner takes the run up within the case.
const CRASHABLE = { leaseMs: 1_500, renewEveryMs: 300, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };

test("a run whose runner dies mid-turn after a paid request resumes on the next runner and finishes; each paid request counted once; its timeline says it was taken over", { timeout: 90_000 }, async (t) => {
  const lines = [];
  const { api, crashRunner } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), runnerTiming: CRASHABLE, log: (line) => lines.push(line) });
  const go = join(await scratch(t), "go");
  // Granted read, the faux harness's first call: on the runner a call the session has no tool for has no row of its own.
  const runId = await started(api, "resume",`Wait for ${go} before the answer.`, "claude-agent", ["read"]);
  // The first request is paid and its tool has ended: its row is in, then the turn hangs.
  for (let i = 0; !(await api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "tool_result"); i++) {
    assert.ok(i < 300, "the first request's tool row");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await crashRunner();
  await writeFile(go, "");
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await answer(api, runId), "Done after the wait.");
  assert.deepEqual(usageOf(rows), { usd: 0.006, requests: 2 }, "the request before the crash and the one after it, once each");
  assert.equal(resumedRows(rows).length, 1, `one stored row: ${JSON.stringify(resumedRows(rows))}`);
  assert.match(resumedRows(rows)[0], /^Resumed after its runner \(.+\) was lost$/, "the next runner took the run over once the dead one's lease ran out");
  // The reclaim is no second start: one run_started (the first runner's claim) and one run_ended.
  for (let i = 0; !lines.some((line) => line.includes(" event=run_ended ")); i++) {
    assert.ok(i < 100, lines.join("\n"));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(["run_started", "run_ended"].map((event) => lines.filter((line) => line.includes(` event=${event} `) && line.includes(`run=${runId} `)).length), [1, 1]);
});

// SKIP (follow-up #2089): a turn the server's stop lets go mid-way is claimed by the next start's runner and never goes
// on (it reads working/idle, as turn-record.test.mjs's drain case, skipped for #2089, does). Rewritten onto the runner.
test.skip("a run that the server stopped mid-turn goes on at the next start", { timeout: 90_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await serve(t, { data, harnessTable: fauxTable(FAUX_HARNESS) });
  const go = join(await scratch(t), "go");
  const runId = await started(first.api, "drained", `Wait for ${go} before the answer.`, "claude-agent", ["read"]);
  for (let i = 0; !(await first.api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "tool_result"); i++) {
    assert.ok(i < 300, "the first request's tool row");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The whole start stopped, as the CLI's stop stops it: the runner drains, then lets the run go where the next runner
  // takes it up (released, never ended), then the server.
  await first.stop();
  const next = await serve(t, { data, harnessTable: fauxTable(FAUX_HARNESS) });
  await writeFile(go, "");
  const { rows } = await follow(next.api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await answer(next.api, runId), "Done after the wait.");
  assert.deepEqual(usageOf(rows), { usd: 0.006, requests: 2 }, "the request before the stop and the one after it, once each");
});

test("a chat sent while a turn works, then the run's runner dies: the next runner finishes the turn and answers the chat before it completes, never dropping it", { timeout: 120_000 }, async (t) => {
  const { api, crashRunner } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), runnerTiming: CRASHABLE });
  const go = join(await scratch(t), "go");
  const runId = await started(api, "chat-resume", `Wait for ${go}, then answer the chat.`, "claude-agent", ["read"]);
  for (let i = 0; !(await api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "tool_result"); i++) {
    assert.ok(i < 300, "the first request's tool row");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Accepted while the turn works: it waits for the turn's end.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and the chat?" })).status, 202);
  await crashRunner();
  await writeFile(go, "");
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.text), ["hi", "and the chat?"]);
  const last = rows.filter((r) => r.kind === "user_message" || r.kind === "final_answer").at(-1);
  assert.equal(last?.kind, "final_answer", "nothing the person sent is left unanswered");
  assert.equal(await answer(api, runId), "Answered the chat.", "the run's last answer is the chat's");
});

/** Every journal entry of run `runId` in the server's one store (`<data>/store.sqlite`, the runs' journals in pi_entries,
 *  each keyed by its run), in the order they were written. */
function runEntries(data, runId) {
  // The runner writes the store meanwhile: a read that finds it locked tries again.
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM pi_entries WHERE run_id = ? ORDER BY id").all(runId).map((row) => JSON.parse(String(row.record)));
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
}
/** The run's store entries of `kind` (a session's record, or the root's request marker). */
const storeRecords = (data, runId, kind) => runEntries(data, runId).filter((record) => record.kind === kind);

test("a request whose price is unknown makes the run's cost unknown, never 0", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "unpriced", "Price unknown.");
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.deepEqual(usageOf(rows), { usd: null, requests: 1, so_far_usd: 0, unpriced: 1 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, null);
});

test("a run whose booked spend passes its cap shows by how much on its timeline, once, and ends spend_cap_reached saying so", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  assert.equal((await api("POST", "/agents", agent("over", { harness: "codex", instructions: "Overspend." }))).status, 201);
  // A cap that is no whole number of cents: its words say it in cents, never as a float's tail.
  const run = await api("POST", "/agents/over/runs", { input: { content: "hi" }, max_cost_usd: 0.3002094 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["failed"], { deadlineMs: 55_000 });
  const over = rows.filter((row) => row.id.endsWith(":over_cap"));
  assert.deepEqual(over.map((row) => [row.kind, row.summary]), [["phase", "Spent $0.50, $0.20 over the run's cap of $0.30"]]);
  assert.equal(usageOf(rows).usd, 0.5, "the usage row it reads: the refused request cost nothing");
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.deepEqual([view.error.code, view.error.message], ["spend_cap_reached", "The run cost $0.50, $0.20 over its cap of $0.30."]);
});

test("a request admitted and cut by a crash is booked once, unknown: on resume the cost is unknown and every admitted request counts once", { timeout: 90_000 }, async (t) => {
  const { api, data, crashRunner } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), runnerTiming: CRASHABLE });
  const go = join(await scratch(t), "go");
  const runId = await started(api, "cut", `Cut until ${go}.`, "claude-agent", ["read"]);
  // The first request is answered at its tool's end; the second is then admitted and held, never answered.
  for (let i = 0; usageOf((await api("GET", `/runs/${runId}/timeline`)).body.rows)?.requests !== 2; i++) {
    assert.ok(i < 300, "the second request is admitted and marked");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await crashRunner();
  await writeFile(go, "");
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await answer(api, runId), "After the cut.");
  assert.deepEqual(usageOf(rows), { usd: null, requests: 3, so_far_usd: 0.006, unpriced: 1 }, "the first, the cut one (unknown), and the one after: once each");
  // On the run's one ledger (its journal in the store): three model requests held, the cut one booked as cut, unknown.
  const entries = journalOf(data, runId);
  const requests = entries.filter((entry) => entry.kind === "runner.request" && !String(entry.data?.model ?? "").startsWith("paid:"));
  const turns = entries.filter((entry) => entry.kind === "runner.turn" && requests.some((request) => request.conversationId === entry.conversationId && request.data.turn === entry.data.turn));
  assert.equal(requests.length, 3, `three requests admitted, each once: ${JSON.stringify(requests.map((entry) => entry.data))}`);
  assert.deepEqual(turns.map((entry) => [entry.data.cut === true, entry.data.usd ?? null]), [[false, 0.002], [true, null], [false, 0.004]], `each booked once, the cut one unknown: ${JSON.stringify(turns.map((entry) => entry.data))}`);
});

test("a run cancelled while its harness's request is out, and never opened again, carries back a cost that is not a plain number", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const go = join(await scratch(t), "go");
  // The agent has `read`: its first request's call is a host tool's, recorded as it runs (a tool it lacks never runs).
  const runId = await started(api, "cut-cancel", `Cut until ${go}.`, "codex", ["read"]);
  // The first request is answered at its tool's end; the second is then admitted and cut, and the cancel lands.
  for (let i = 0; !(await api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "tool_result"); i++) {
    assert.ok(i < 300, "the first request's row");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The second request's mark is on the root once it is admitted: the live usage counts it, in flight, as a second.
  for (let i = 0; usageOf((await api("GET", `/runs/${runId}/timeline`)).body.rows)?.requests !== 2; i++) {
    assert.ok(i < 300, "the second request is admitted and marked");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  const { rows } = await follow(api, runId, ["cancelled"], { deadlineMs: 55_000 });
  assert.deepEqual(usageOf(rows), { usd: null, requests: 2, so_far_usd: 0.002, unpriced: 1 }, "the first at its cost, and the cut one, its cost unknown");
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, null, "the carried-back cost is unknown, never the first request's alone");
});

test("a run opened again whose new opening has a request of unknown price reads cost unknown, never the earlier opening's figure", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "later", "Second turn unpriced.");
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, 0.002);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and then?" })).status, 202);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.deepEqual(usageOf(rows), { usd: null, requests: 4, so_far_usd: 0.003, unpriced: 1 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, null, "unknown, not the first opening's 0.002");
});

/** A run's paid tool calls as its one ledger booked them, from the server's store: each paid request of the run's
 *  paid-tools session (its `paid:<what was paid for>` name), with the figure its turn was booked at (null while none is). A
 *  request and its booking share a turn of their own session, so they are paired within it. */
function paidOf(data, runId) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    const entries = db.prepare("SELECT conversation_id, record FROM pi_entries WHERE run_id = ? ORDER BY id").all(runId).map((row) => ({ conversation: row.conversation_id, ...JSON.parse(String(row.record)) }));
    const booked = (request) => entries.find((entry) => entry.kind === "runner.turn" && entry.conversation === request.conversation && entry.data?.turn === request.data.turn)?.data?.usd ?? null;
    return entries.filter((entry) => entry.kind === "runner.request" && String(entry.data?.model ?? "").startsWith("paid:")).map((request) => [request.data.model, booked(request)]);
  } finally {
    db.close();
  }
}
const toolResults = (rows) => rows.filter((r) => r.kind === "tool_result").map((r) => [`${r.summary ?? ""} ${r.tool_result_preview ?? ""}`, r.tool_status]);

test("a run on another harness gets pi's own file tools: a write then a read of the run's workspace", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "files", "Write then read.", "codex", ["read", "write"]);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await readFile(join(runDir(data, runId), "work", "note.txt"), "utf8"), "hello from the tool");
  const results = toolResults(rows);
  assert.equal(results.length, 2, JSON.stringify(results));
  assert.match(results[1][0], /hello from the tool/, "the read returned what the write wrote");
});

for (const harness of ["claude-agent", "codex"]) {
  test(`web_fetch runs on ${harness} as a host tool: the definition saves with no warning, its run is not refused, and it reads the page through the guarded fetch`, { timeout: 60_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxWeb: FAUX_WEB });
    const saved = await api("POST", "/agents", agent(`web-${harness}`, { harness, instructions: "Fetch http://public.example/ and say its title.", tools: ["web_fetch"] }));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.doesNotMatch(JSON.stringify(saved.body), /not bound yet/, "no warning that the tool is pi's only");
    const run = await api("POST", `/agents/web-${harness}/runs`, { input: { content: "hi" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
    const results = toolResults(rows);
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.match(results[0][0], /"title":"Public page".*"via":"direct"/s, "web_fetch's Page, read through the guarded fetch");
  });

  test(`web_fetch runs on ${harness} as a host tool: with Parallel picked the run is handed Parallel's key and reads the page through Parallel`, { timeout: 60_000 }, async (t) => {
    const calls = join(await scratch(t), "parallel.jsonl");
    withEnv(t, { PARALLEL_API_KEY: PARALLEL_CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: calls }, ["AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT"]);
    const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxWeb: FAUX_WEB, fauxParallel: FAUX_PARALLEL });
    const saved = await api("POST", "/agents", agent(`web-${harness}`, { harness, instructions: "Fetch http://public.example/ and say its title with web_fetch.", tools: ["web_fetch"], tool_settings: { web_fetch: { provider: "parallel" } } }));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.doesNotMatch(JSON.stringify(saved.body), /not bound yet/, "no warning that the tool is pi's only");
    const run = await api("POST", `/agents/web-${harness}/runs`, { input: { content: "hi" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
    const results = toolResults(rows);
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.match(results[0][0], /"title":"Read by Parallel".*"via":"parallel"/s, "read through Parallel's extract");
    const sent = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(sent.map((call) => [call.path, call.authorized, call.urls]), [["/v1/extract", true, ["http://public.example/"]]], "on the key the server handed the run");
    assert.deepEqual(paidOf(data, run.body.run_id), [["paid:Parallel's extract", 0.001]], "the extract's fee, booked once on the run's one ledger, as on pi");
    assert.deepEqual(rows.filter((row) => row.kind === "phase" && row.tool_name === "web_fetch").map((row) => row.summary), ["Tool cost: parallel charged $0.0010 for web_fetch"]);
  });

  test(`web_search runs on ${harness} as a host tool where Parallel is picked: the run is handed Parallel's key and searches through Parallel`, { timeout: 60_000 }, async (t) => {
    const calls = join(await scratch(t), "parallel.jsonl");
    withEnv(t, { PARALLEL_API_KEY: PARALLEL_CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: calls }, ["AGENTRUN_TEST_FAUX_PARALLEL_SEARCH"]);
    const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxParallel: FAUX_PARALLEL });
    const saved = await api("POST", "/agents", agent(`search-${harness}`, { harness, instructions: "Search the web for widgets delaware and say what you found.", tools: ["web_search"], tool_settings: { web_search: { provider: "parallel" } } }));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.doesNotMatch(JSON.stringify(saved.body), /not bound yet/, "no warning that the tool is pi's only");
    const run = await api("POST", `/agents/search-${harness}/runs`, { input: { content: "hi" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
    const results = toolResults(rows);
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.match(results[0][0], /\{"provider":"parallel","query":"widgets delaware","results":\[\{"url":"https:\/\/registry\.example\/widgets"/, "Parallel's results");
    const sent = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(sent.map((call) => [call.path, call.authorized, call.queries]), [["/v1/search", true, ["widgets delaware"]]], "on the key the server handed the run");
    assert.deepEqual(paidOf(data, run.body.run_id), [["paid:Parallel's search", 0.001]], "the search's fee, booked once on the run's one ledger, as on pi");
    assert.deepEqual(rows.filter((row) => row.kind === "phase" && row.tool_name === "web_search").map((row) => row.summary), ["Tool cost: parallel charged $0.0010 for web_search"]);
  });
}

for (const harness of ["claude-agent", "codex"]) {
  test(`monid.run runs on ${harness} as monid_run: it saves with no warning, reaches monid on the run's key, and is journaled and shown under its wire name`, { timeout: 60_000 }, async (t) => {
    const log = join(await scratch(t), "monid-calls.jsonl");
    withEnv(t, { MONID_API_KEY: MONID_KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
    const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxMonid: FAUX_MONID });
    const saved = await api("POST", "/agents", agent(`monid-${harness}`, { harness, instructions: "Run monid's /person/enrich on Ada.", tools: ["monid.discover", "monid.inspect", "monid.run"], tool_settings: { "monid.discover": { permission: "allow" }, "monid.inspect": { permission: "allow" }, "monid.run": { permission: "allow" } } }));
    assert.deepEqual([saved.status, saved.body.warnings], [201, []], JSON.stringify(saved.body));
    const run = await api("POST", `/agents/monid-${harness}/runs`, { input: { content: "hi" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
    const seen = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((call) => [call.method, call.path, call.authorized]), [["POST", "/v1/run", true]], "sent once, on the key");
    assert.deepEqual(storeRecords(data, run.body.run_id, "faux.call").map((record) => record.data?.name), ["monid_run"], "the harness's journal names the wire name");
    assert.deepEqual(rows.filter((r) => r.kind === "tool_use").map((r) => r.tool_name), ["monid_run"]);
    const results = toolResults(rows);
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.match(results[0][0], /"full_name":"Ada"/, "the run's output reaches the timeline");
    assert.equal(results[0][1], "success");
  });
}

test("capabilities say which harnesses run each tool: the file tools, bash and the background tools (in a box), ask_person, the web tools and monid's three on every harness, the rest on pi", async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const tools = Object.fromEntries((await api("GET", "/capabilities")).body.tools.map((tool) => [tool.name, tool.harnesses]));
  const every = ["pi", "claude-agent", "codex", "opencode"];
  const hosted = ["read", "write", "edit", "bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list", "ask_person", "web_fetch", "web_search", "monid.discover", "monid.inspect", "monid.run"];
  for (const name of hosted) assert.deepEqual(tools[name], every, name);
  for (const [name, harnesses] of Object.entries(tools)) if (!hosted.includes(name)) assert.deepEqual(harnesses, ["pi"], name);
});

test("a turn that says something, then calls a tool, then answers: what it said first is a text_block, the run does not end on it, and its answer is the last one", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "comment", "Comment, then write.", "codex", ["write"]);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  // decide() ends a run on its newest answer row once its turn is over: the row said first, an answer until the turn
  // went on, never ended it (the write ran after it), and the real answer did.
  assert.equal(await readFile(join(runDir(data, runId), "work", "note.md"), "utf8"), "noted", "the write after the first row ran");
  assert.deepEqual(rows.filter((r) => ["text_block", "final_answer", "tool_use"].includes(r.kind)).map((r) => [r.kind, r.summary]), [["text_block", "I'll write note.md."], ["tool_use", "Wrote note.md"], ["final_answer", "Wrote note.md."]]);
  assert.equal(await answer(api, runId), "Wrote note.md.");
});

test("a turn whose first answer is empty and that then calls a tool and answers: the empty answer is an empty text_block, the real answer is the only final_answer, and the timeline is final", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "empty-first", "Say nothing, then write.", "codex", ["write"]);
  const { rows, last } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const shown = JSON.stringify(rows.map((r) => [r.kind, r.summary, r.text]));
  assert.equal(await readFile(join(runDir(data, runId), "work", "note.md"), "utf8"), "noted", "the write after the empty answer ran");
  // An empty answer is an answer (it ended a request on purpose) until the same turn goes on: then it was only the turn's
  // first word, an empty one, and the answer that ends the turn is the run's one final_answer.
  assert.deepEqual(rows.filter((r) => ["text_block", "final_answer", "tool_use"].includes(r.kind)).map((r) => [r.kind, r.summary]), [["text_block", ""], ["tool_use", "Wrote note.md"], ["final_answer", "Wrote note.md."]], shown);
  assert.equal(rows.filter((r) => r.kind === "final_answer").length, 1, shown);
  assert.deepEqual([last.status, last.final], ["completed", true], shown);
  assert.equal(await answer(api, runId), "Wrote note.md.");
});

test("a turn that comments, then answers with nothing, then calls a tool and answers: the commentary is a text_block, the real answer the only final_answer", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "comment-empty", "Comment, say nothing, then write.", "codex", ["write"]);
  const { rows, last } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const shown = JSON.stringify(rows.map((r) => [r.kind, r.summary, r.text]));
  assert.equal(await readFile(join(runDir(data, runId), "work", "note.md"), "utf8"), "noted", "the write after the empty answer ran");
  // The empty answer held the turn's place as its answer for a moment; the commentary before it never stays one either.
  // A CLI's record keeps the turn's text up to its call as one message, so the empty one joins the commentary's row.
  assert.deepEqual(rows.filter((r) => ["text_block", "final_answer", "tool_use"].includes(r.kind)).map((r) => [r.kind, r.summary]), [["text_block", "I'll check first."], ["tool_use", "Wrote note.md"], ["final_answer", "Wrote note.md."]], shown);
  assert.equal(rows.filter((r) => r.kind === "final_answer").length, 1, shown);
  assert.deepEqual([last.status, last.final], ["completed", true], shown);
  assert.equal(await answer(api, runId), "Wrote note.md.");
});

test("another harness's file tools name the workspace's paths relative to it: a path out of it, a missing file and a write, with no result naming the server's data directory", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "edges", "Touch the edges.", "claude-agent", ["read", "write"]);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const results = rows.filter((r) => r.kind === "tool_result").map((r) => [r.tool_name, r.tool_status, r.tool_result_preview ?? ""]);
  assert.deepEqual(results.map(([name, status]) => [name, status]), [["write", "failed"], ["read", "failed"], ["write", "success"]], JSON.stringify(results));
  assert.match(results[0][2], /^\.\.\/escape\.md: outside the workspace(?: \(it resolves to \.\.\/escape\.md\))?$/, "the refusal names the path beside the workspace, not where it is");
  assert.match(results[1][2], /^ENOENT: no such file or directory, \w+ 'missing\.md'$/);
  assert.equal(results[2][2], "Successfully wrote to sub/ok.md");
  assert.equal(await readFile(join(runDir(data, runId), "work", "sub", "ok.md"), "utf8"), "in");
  for (const root of new Set([data, realpathSync(data)])) assert.deepEqual(results.filter(([, , text]) => text.includes(root)), [], `no result names ${root}`);
});

// SKIP (follow-up #2058): the reopened run completes, but its answer reads the earlier turn's ("Answer 1.") where its own
// turn showed none: the store's answer is the run's last model text, not the last turn's.
test.skip("a follow-up whose turn ends showing nothing (the Claude CLI's /compact) ends the run completed, its answer that turn's own (none), without waiting for another message", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "answerless", "The second turn answers nothing.");
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await answer(api, runId), "Answer 1.");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "/compact" })).status, 202);
  // Well inside the 60 s a message-less run sat working/idle before (key-custody probe, run3/run4).
  const { rows, last } = await follow(api, runId, ["completed"], { deadlineMs: 20_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.map((r) => [r.kind, r.summary])));
  assert.equal(await answer(api, runId), "", "the turn's own answer: it showed no text, and the earlier turn's is not its");
  assert.deepEqual(usageOf(rows), { usd: 0.003, requests: 3 }, "the follow-up's request counts");
});

const FAUX_WEB_HOLD = new URL("./fixtures/faux-web-hold.mjs", import.meta.url).pathname;

/** Follows a run to completed, then checks it never read completed before `answer` was on its timeline: the rows of every
 *  page up to the first completed one. */
async function completesOnlyAfter(api, runId, answer) {
  const { pages } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const seen = new Map();
  for (const page of pages) {
    if (page.reset) seen.clear();
    for (const id of page.drop) seen.delete(id);
    for (const row of page.rows) seen.set(row.id, row);
    if (page.status === "completed") {
      const rows = [...seen.values()];
      assert.ok(rows.some((r) => (r.kind === "final_answer" || r.kind === "text_block") && r.summary === answer), `completed before the follow-up's answer: ${JSON.stringify(rows.map((r) => [r.kind, r.summary]))}`);
      return rows;
    }
  }
  assert.fail("never completed");
}

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a follow-up sent while a turn works waits its turn; the run does not end when the first turn does, only once the follow-up is answered`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxWeb: FAUX_WEB_HOLD });
    const go = join(await scratch(t), "go");
    const runId = await started(api, `held-${harness}`, `Hold the answer until ${go}.`, harness, ["web_fetch"]);
    // The turn runs, held on its fetch until the file exists: its call shows only once it ends (the bridge writes a call
    // with its result), so the turn is read from the run, working with the person's message in.
    await follow(api, runId, ["working"], { deadlineMs: 30_000 });
    const sent = await api("POST", `/runs/${runId}/messages`, { content: "and then?" });
    // claude-agent steers mid-turn (its facts), so the API answers steer; this faux session takes no steer, so the runner
    // still sends it as the next turn. codex takes no message mid-turn: follow_up.
    assert.deepEqual([sent.status, sent.body.mode], [202, harness === "claude-agent" ? "steer" : "follow_up"], JSON.stringify(sent.body));
    await writeFile(go, "");
    const rows = await completesOnlyAfter(api, runId, "Answer 2.");
    assert.deepEqual(rows.filter((r) => ["user_message", "final_answer", "text_block"].includes(r.kind)).map((r) => r.summary), ["You: hi", "Answer 1.", "You: and then?", "Answer 2."]);
    assert.equal(await answer(api, runId), "Answer 2.");
  });
}

test("pi: a message sent while the turn a steered message started works reaches that turn too; the run does not end until both are answered", { timeout: 90_000 }, async (t) => {
  // The first turn holds; a message steered into it is answered in a turn of its own after it (steeredIn), which holds
  // too; a second message sent while that turn works is placed in it, never left for the run's end and a reopen.
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const [go, goToo] = [join(await scratch(t), "go"), join(await scratch(t), "go-too")];
  assert.equal((await api("POST", "/agents", agent("held-twice", { tools: [] }))).status, 201);
  const run = await api("POST", "/agents/held-twice/runs", { input: { content: `Hold twice, until ${go} and then ${goToo}.` } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await follow(api, runId, ["working"], { deadlineMs: 30_000 });
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and then?" })).status, 202);
  await writeFile(go, "");
  // The steered message's turn holds on the second file: the second message lands while it works.
  for (let i = 0; !(await api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => (r.kind === "final_answer" || r.kind === "text_block") && r.summary === "Answer 1."); i++) {
    assert.ok(i < 300, "the first turn's answer");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and also?" })).status, 202);
  await writeFile(goToo, "");
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  // Settled: no reopen is still to come.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const said = (await api("GET", `/runs/${runId}/timeline`)).body.rows.filter((r) => r.kind === "final_answer" || r.kind === "text_block").map((r) => r.summary);
  assert.equal(said.length, 3, `an answer for the input and for each message: ${JSON.stringify(said)}`);
  // One end: the second message was answered in the claim, never left for the run's end to open it again.
  const ends = storeEntries(data, runId).filter((entry) => entry.kind === "agentrun.end");
  assert.equal(ends.length, 1, `the run ended once, after both messages were answered: ${ends.length} ends`);
});

test("pi: a message sent while a turn works is placed at that turn's end and answered in the next run; the run does not end between them", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const go = join(await scratch(t), "go");
  assert.equal((await api("POST", "/agents", agent("held-pi", { tools: [] }))).status, 201);
  const run = await api("POST", "/agents/held-pi/runs", { input: { content: `Hold the answer until ${go}.` } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await follow(api, runId, ["working"], { deadlineMs: 30_000 });
  const sent = await api("POST", `/runs/${runId}/messages`, { content: "and then?" });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await writeFile(go, "");
  const rows = await completesOnlyAfter(api, runId, "Answer 2.");
  assert.deepEqual(rows.filter((r) => ["final_answer", "text_block"].includes(r.kind)).map((r) => r.summary), ["Answer 1.", "Answer 2."]);
  assert.equal(await answer(api, runId), "Answer 2.");
});

// A follow-up to the completed run, answered with nothing, is #2058's (a message to a finished run): "a follow-up whose
// turn ends showing nothing" above.
test("a run's answer is whole, past the 2,000 characters its summary keeps, on this server and the next", { timeout: 90_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const table = fauxTable(FAUX_HARNESS);
  // The first server and the runner beside it (the CLI start's pair), closed together before the next server opens.
  const one = await startServe({ data, port: 0, faux: FAUX, harnessTable: table, drainTimeout: "5s" });
  const runner = await startInProcessRunner(data, { faux: FAUX, harnessTable: table });
  let closed = false;
  t.after(async () => {
    if (closed) return;
    await runner();
    await one.close();
  });
  const api = client(one.baseUrl, one.token);
  const runId = await started(api, "long", "The second turn answers nothing, after a long answer.");
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(LONG_ANSWER.length > 2_000, true);
  assert.equal(await answer(api, runId), LONG_ANSWER, "the first turn's answer, whole");
  closed = true;
  await runner();
  await one.close();
  const two = await serve(t, { data, harnessTable: table });
  assert.equal(await answer(two.api, runId), LONG_ANSWER, "and on the next server, read from the run's store: never the summary the store keeps");
});

/** The run's journal entries, in order, as the server's one store keeps them (pi_entries): read-only, beside the server
 *  that writes it. */
function storeEntries(data, runId) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    return db.prepare("SELECT record FROM pi_entries WHERE run_id = ? ORDER BY id").all(runId).map((row) => JSON.parse(String(row.record)));
  } finally {
    db.close();
  }
}
/** Until the faux harness has admitted its request: it writes `signal` the moment it does (cutSignalled). Nothing the API
 *  shows says a request is in flight (one alone makes no row), and the run's store is its process's alone while it lives. */
const admitted = async (signal) => {
  for (const end = Date.now() + 60_000; !existsSync(signal); await new Promise((resolve) => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < end, `the faux harness never admitted the turn's first request (no ${signal} in 60 s)`);
  }
};

test("a cancel of a turn that has shown nothing reads working, then cancelled: never completed on the way", { timeout: 90_000 }, async (t) => {
  // Review F2, not reproduced (an interrupted request that showed nothing and was never paid writes no entry): a guard
  // that the cancel decides the run's end, whatever the turn it cut writes.
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const signal = join(await scratch(t), "admitted");
  const runId = await started(api, "cancel-empty", `Hold a request unanswered (signal ${signal}).`);
  await admitted(signal);
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  const { pages } = await follow(api, runId, ["cancelled"], { deadlineMs: 55_000 });
  assert.deepEqual(pages.filter((page) => page.status === "completed").map((page) => page.status), [], `statuses: ${pages.map((page) => page.status).join(", ")}`);
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "cancelled");
  const entries = storeEntries(data, runId);
  // The person's message on the CLI's record, then the runner's request record (on the run's model session) as the cap
  // admits a request.
  const user = entries.findLastIndex((e) => e.kind === "agentrun.message" && e.data?.role === "person");
  assert.ok(user >= 0 && entries.slice(user + 1).some((e) => e.kind === "runner.request"), "the case: the request was admitted after the person's message (its record is in the store)");
});

// SKIP (follow-up #2058): a message to a run that completed or was stopped answers 409 not_continuable: the store does not open the run again (the case also needs a runner beside each server, startInProcessRunner)
test.skip("pi: after a stopped turn's commentary and a follow-up answered with nothing, the run's answer is that follow-up's own (empty), never the commentary or the earlier answer, on this server and the next", { timeout: 120_000 }, async (t) => {
  // Review F3: commentary that came with a call is no answer, though it is the run's newest text.
  const data = join(await scratch(t), "agents");
  const one = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let closed = false;
  t.after(() => (closed ? undefined : one.close()));
  const api = client(one.baseUrl, one.token);
  assert.equal((await api("POST", "/agents", agent("reread", { tools: ["read"] }))).status, 201);
  const run = await api("POST", "/agents/reread/runs", { input: { content: "Answer, reread, then compact." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await answer(api, runId), "Report written.");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Reread it." })).status, 202);
  for (let i = 0; !(await api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "text_block" && /reread the report/.test(r.summary ?? "")); i++) {
    assert.ok(i < 300, "the commentary and its call");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"], { deadlineMs: 30_000 });
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "/compact" })).status, 202);
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await answer(api, runId), "", "the follow-up's own answer, empty: not the stopped turn's commentary, and not the earlier answer");
  await one.close();
  closed = true;
  const two = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => two.close());
  assert.equal(await answer(client(two.baseUrl, two.token), runId), "", "and on the next server, read from the run's store");
});

test("a write that names its file by an absolute path in the workspace reads by its name there (hello.md) in the tool rows and the Saved row; a path outside the run's directory stays as given; the call's arguments are kept", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "absolute", "Write by the absolute path.", "claude-agent", ["write"]);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(await readFile(join(runDir(data, runId), "work", "hello.md"), "utf8"), "hello");
  const shown = rows.filter((r) => ["tool_use", "tool_result", "phase"].includes(r.kind) && !/^Released|session/.test(r.summary ?? "")).map((r) => [r.kind, r.summary]);
  assert.deepEqual(shown.slice(0, 4), [["tool_use", "Wrote hello.md"], ["tool_result", "Wrote hello.md: ok"], ["phase", "Saved hello.md"], ["tool_use", "Wrote /elsewhere/away.md"]], JSON.stringify(shown));
  assert.match(shown[4]?.[1] ?? "", /^Wrote \/elsewhere\/away\.md failed: /, "a path outside the run's directory stays as given");
  assert.equal(shown.length, 5, JSON.stringify(shown));
  assert.equal(rows.find((r) => r.kind === "phase" && /^Saved/.test(r.summary))?.path, "hello.md", "the Saved row's file, by its name in the workspace");
  // Display only: the call's own arguments, as the harness sent them (the absolute path under its working directory), are
  // the input preview.
  assert.match(rows.find((r) => r.kind === "tool_use")?.tool_input_preview ?? "", /^\/\S*\/hello\.md$/);
});

test("a codex or pi run whose write names a relative path reads the same as before: Wrote <name>, Saved <name>", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const runId = await started(api, "relative-codex", "Write then read.", "codex", ["write", "read"]);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.deepEqual(rows.filter((r) => r.tool_name === "write" || /^Saved/.test(r.summary ?? "")).map((r) => r.summary), ["Wrote note.txt", "Wrote note.txt: ok", "Saved note.txt"]);
  // pi, on the faux model: its write names report.md.
  assert.equal((await api("POST", "/agents", agent("relative-pi", { tools: ["write"] }))).status, 201);
  const pi = await api("POST", "/agents/relative-pi/runs", { input: { content: "Write the report." } });
  assert.equal(pi.status, 202, JSON.stringify(pi.body));
  const piRows = (await follow(api, pi.body.run_id, ["completed"], { deadlineMs: 55_000 })).rows;
  assert.deepEqual(piRows.filter((r) => r.tool_name === "write" || /^Saved/.test(r.summary ?? "")).map((r) => r.summary), ["Wrote report.md", "Wrote report.md: ok", "Saved report.md"]);
});

test("a capped run with a request cut by a crash goes on: the cut request counts at the worst case its cap held, $0 on a model listed at $0", { timeout: 90_000 }, async (t) => {
  const { api, data, crashRunner } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), runnerTiming: CRASHABLE });
  const go = join(await scratch(t), "go");
  assert.equal((await api("POST", "/agents", agent("capped-cut", { harness: "claude-agent", instructions: `Cut until ${go}.`, tools: ["read"] }))).status, 201);
  const run = await api("POST", "/agents/capped-cut/runs", { input: { content: "hi" }, max_cost_usd: 1 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  // The first request answered, the second admitted and held: the crash cuts it.
  for (let i = 0; usageOf((await api("GET", `/runs/${runId}/timeline`)).body.rows)?.requests !== 2; i++) {
    assert.ok(i < 300, "the second request is admitted and marked");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await crashRunner();
  await writeFile(go, "");
  // Priced cases, and a cut request that leaves no room, are harness-cap.test.mjs's.
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 55_000 });
  const ended = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([ended.status, ended.result?.final_answer], ["completed", "After the cut."], JSON.stringify(ended.error));
  assert.equal(ended.cost.usd, null, "the cut request's own price never came in: the shown cost is unknown");
  // What the cap held for each request, on the run's one ledger (its journal in the store): the model's $0 worst case,
  // so the cut one counts at $0, and it is booked as cut.
  const entries = journalOf(data, runId);
  const requests = entries.filter((entry) => entry.kind === "runner.request" && !String(entry.data?.model ?? "").startsWith("paid:"));
  assert.deepEqual(requests.map((entry) => entry.data.heldUsd), [0, 0, 0], "the first, the cut one, and the one after it, each held at $0");
  const turns = entries.filter((entry) => entry.kind === "runner.turn" && requests.some((request) => request.conversationId === entry.conversationId && request.data.turn === entry.data.turn));
  assert.deepEqual(turns.map((entry) => entry.data.cut === true), [false, true, false], `the cut one booked as cut, once: ${JSON.stringify(turns.map((entry) => entry.data))}`);
});

// Three runs in turn, each followed for up to 55 s.
test("the run's thinking level reaches the harness's session: the revision's, and Codex's highest where serve's is max", { timeout: 180_000 }, async (t) => {
  const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  for (const [harness, thinking, said] of [["claude-agent", "high", "Thinking high."], ["claude-agent", "max", "Thinking max."], ["codex", "max", "Thinking xhigh."]]) {
    const id = `think-${harness}-${thinking}`;
    assert.equal((await api("POST", "/agents", agent(id, { harness, instructions: "Say your thinking.", thinking }))).status, 201);
    const run = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
    assert.equal(await answer(api, run.body.run_id), said);
  }
});

/**
 * A refused call's row names the path the call gave, as given, and no other: neither a directory of `roots` (the server's
 * data directory, where a link points), as named or as resolved, nor any other absolute path on the host.
 */
function namesOnlyGiven(row, given, roots, who, words = "outside the workspace") {
  const said = `${row.summary ?? ""}\n${row.tool_result_preview ?? ""}`;
  assert.equal(row.tool_status, "failed", `${who}: ${said}`);
  assert.ok((row.tool_result_preview ?? "").includes(`${given}: ${words}`), `${who}: the refusal names ${given} as given: ${said}`);
  for (const root of new Set(roots.flatMap((root) => [root, realpathSync(root)]))) assert.ok(!said.includes(root), `${who}: the refusal of ${given} names ${root}: ${said}`);
  // An absolute path starts at a "/" no name, dot or "<" comes before: pi's "</harness>", closing its error block, is none.
  assert.doesNotMatch(said.split(given).join(""), /(?<![\w.~<-])\/[\w.-]/, `${who}: the refusal of ${given} names an absolute host path: ${said}`);
  assert.doesNotMatch(said, /resolves to/, `${who}: the refusal of ${given} names where it resolves to: ${said}`);
}

test("a read refused outside the run names the path it was given, as given, on pi, claude-agent and codex: up out of the run, absolute, and a link out of the workspace, never the data directory or a host path", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const reads = (rows) => rows.filter((r) => r.kind === "tool_result" && r.tool_name === "read");
  for (const harness of ["claude-agent", "codex"]) {
    const runId = await started(api, `outside-${harness}`, "Read outside the run.", harness, ["read"]);
    const refused = reads((await follow(api, runId, ["completed"], { deadlineMs: 55_000 })).rows);
    assert.equal(refused.length, 2, `${harness}: ${JSON.stringify(refused)}`);
    refused.forEach((row, i) => namesOnlyGiven(row, ["../../.token", "/etc/hostname"][i], [data], harness));
  }
  // On pi, the reads wait for a link the test plants in the run's workspace, to a file outside it.
  const dir = await scratch(t);
  const go = join(dir, "go");
  await writeFile(join(dir, "secret.txt"), "not for the agent");
  const given = ["../../.token", "/etc/hostname", "out.txt"];
  assert.equal((await api("POST", "/agents", agent("outside-pi", { tools: ["read"] }))).status, 201);
  const pi = await api("POST", "/agents/outside-pi/runs", { input: { content: `Read these paths once ${go} exists: ${JSON.stringify(given)}` } });
  assert.equal(pi.status, 202, JSON.stringify(pi.body));
  const work = join(runDir(data, pi.body.run_id), "work");
  for (let i = 0; !existsSync(work); i++) {
    assert.ok(i < 300, "the run's workspace");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await symlink(join(dir, "secret.txt"), join(work, "out.txt"));
  await writeFile(go, "");
  const refused = reads((await follow(api, pi.body.run_id, ["completed"], { deadlineMs: 55_000 })).rows);
  assert.equal(refused.length, 3, `pi: ${JSON.stringify(refused)}`);
  // The link is refused in the workspace's own words for a link (its file tools follow none), the path as given.
  refused.forEach((row, i) => namesOnlyGiven(row, given[i], [data, dir], "pi", i === 2 ? "refused: a link is on the way to it" : undefined));
  assert.ok(refused.every((row) => !JSON.stringify(row).includes("not for the agent")));
});

for (const harness of ["claude-agent", "codex"]) {
  test(`a ${harness} run cancelled while its host web_search through Parallel is under way still settles the call: its charge is booked, so the run's cost stays known`, { timeout: 90_000 }, async (t) => {
    const calls = join(await scratch(t), "parallel.jsonl");
    // The faux Parallel answers the search after 2 s, so the cancel lands while the host tool's call is under way.
    withEnv(t, { PARALLEL_API_KEY: PARALLEL_CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: calls, AGENTRUN_TEST_FAUX_PARALLEL_SEARCH: "slow:2000" });
    const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxParallel: FAUX_PARALLEL });
    assert.equal((await api("POST", "/agents", agent(`stopped-${harness}`, { harness, instructions: "Search the web for widgets delaware and say what you found.", tools: ["web_search"], tool_settings: { web_search: { provider: "parallel" } } }))).status, 201);
    const run = await api("POST", `/agents/stopped-${harness}/runs`, { input: { content: "hi" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    for (const end = Date.now() + 30_000; !(await readFile(calls, "utf8").catch(() => "")).includes('"path":"/v1/search"'); ) {
      assert.ok(Date.now() < end, "the search reached Parallel");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await api("POST", `/runs/${run.body.run_id}/cancel`)).status, 202);
    await follow(api, run.body.run_id, ["cancelled", "failed", "completed"], { deadlineMs: 60_000 });
    let paid = [];
    for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) {
      paid = paidOf(data, run.body.run_id);
      if (paid.some(([, usd]) => usd !== null)) break;
    }
    assert.deepEqual(paid, [["paid:Parallel's search", 0.001]], "held, and booked at its fee though its turn was stopped");
    // A cancel reads cancelled from its 202 on, so the poll above can return before the run's end lands with its cost.
    let usd = null;
    for (const end = Date.now() + 15_000; Date.now() < end && usd === null; await new Promise((resolve) => setTimeout(resolve, 200))) usd = (await api("GET", `/runs/${run.body.run_id}`)).body.cost.usd;
    assert.notEqual(usd, null, "the run's cost is known");
  });
}
