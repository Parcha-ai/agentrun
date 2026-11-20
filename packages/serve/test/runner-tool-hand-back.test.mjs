// A tool call in flight when its runner lets the run go is never run again (GRE-4452 saw a bash command replayed after a
// sandbox was made anew). Two runners on one store (Postgres with AGENTRUN_TEST_PG_URL, else SQLite), the real loop
// (startRunner over createDispatchLoop and the adapter spec pi really uses), the model a script, and each claim's computer
// a sandbox of its own over the run's folder whose processes run for real on this machine (fixtures/streaming-sandbox.mjs):
// the second claim gets a new sandbox, as a hand-back on grep gets a new Daytona sandbox.
//   - hand-back: runner-a closes (what SIGTERM does, past its drain) while bash runs; runner-b claims the run at once;
//   - crash: runner-a dies where it stands (runner.ts kill); runner-b claims the run once its lease lapses.
// Either way the bash command ran once (its own count in the run's folder), its call ends "interrupted" in the run's
// journal, the model's next request is told so, and the run ends on runner-b with one answer.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { release, stores, until } from "./runner-support.mjs";
import { follow, scratch, serve, startInProcessRunner } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { callsOf, journalRecords } = await import("../dist/runner/journal-reader.js");
const { runFolder } = await import("../dist/workspace/paths.js");
const { streamingSandbox } = await import("./fixtures/streaming-sandbox.mjs");
after(closeOpenSessions);
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

const RUN = "run-1";
// A hand-back is the close's release, never a lapse: a lease no stall of a loaded machine outlasts.
const STEADY = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 };
// A crash's run is claimed again once its lease lapses: a short one, so the case takes seconds.
const SHORT = { leaseMs: 2_000, renewEveryMs: 300, stopMarginMs: 500, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 };
const FINAL = ["ended", "failed", "stopped"];

/** The bash command: counts its own start in the run's folder, says it started, then holds until `release` exists. */
const COMMAND = "echo ran >> count.txt; touch started; while [ ! -e release ]; do sleep 0.05; done; echo finished";

/** run-1 on the stores' agent, granted bash, the script's model; two runners' worth of loops over `stores`, each claim's
 *  computer a new sandbox over the run's folder. `start(name, store, timing)` starts a runner. */
async function setup(t) {
  const { server, runners: [storeA, storeB] } = await stores({ runners: 2 });
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-tool-hand-back-"));
  const started = [];
  t.after(async () => {
    for (const runner of started) await runner.close().catch(() => {});
    await release({ server });
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-bash", name: "Bash" }, { id: "rev-bash", kind: "agentic", body: { instructions: "Run it, then say done.", tools: ["bash"] } });
  await server.runs.create({ id: RUN, agentId: "agent-bash", revisionId: "rev-bash" }, { body: { input: { content: "Go." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } } });
  const folder = runFolder(dir, "agent-bash", RUN);
  mkdirSync(folder, { recursive: true });
  const requests = [];
  const route = {
    model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"m"}` },
    fetch: scriptedOrigin([{ call: "bash", args: { command: COMMAND } }, { say: "done" }], requests), price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 1_000,
  };
  const sandboxes = [];
  const start = (name, store, timing) => {
    const deps = {
      env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 3), routeOf: async () => route,
      computerForClaim: async () => {
        const sandbox = streamingSandbox(folder);
        sandboxes.push(name);
        return sandbox;
      },
    };
    const runner = startRunner({ store, name, ...timing, live: false, createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (_name, given) => createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) }) });
    started.push(runner);
    return runner;
  };
  return { server, storeA, storeB, folder, requests, sandboxes, start };
}

/** What the run's journal says of its tool calls: [tool, status] each. */
async function callsIn(server) {
  const row = await server.runs.get(RUN);
  const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  return callsOf(records).map((call) => [call.tool, call.status]);
}

/** The tool results the model was sent in `request`, as text. */
const toolResultsOf = (request) => (request?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result")
  .map((block) => (Array.isArray(block.content) ? block.content.map((part) => part.text ?? "").join("\n") : String(block.content ?? "")));

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

for (const [how, timing] of [["hands the run back (its close: what SIGTERM does past the drain)", STEADY], ["dies (a crash: SIGKILL, its lease left to lapse)", SHORT]]) {
  test(`a bash call in flight when its runner ${how} is never run again: it ends interrupted, the next claim's new sandbox does not run it, and the run ends there with one answer`, { timeout: 120_000 }, async (t) => {
    const { server, storeA, storeB, folder, requests, sandboxes, start } = await setup(t);
    const a = start("runner-a", storeA, timing);
    await until(() => existsSync(join(folder, "started")), "bash started on runner-a's sandbox", 30_000);
    assert.equal((await server.runs.get(RUN)).runner, "runner-a");
    if (timing === STEADY) await a.close();
    else a.kill();
    const b = start("runner-b", storeB, timing);
    const row = await until(async () => {
      const current = await server.runs.get(RUN);
      return FINAL.includes(current.state) && current.runner === null && current;
    }, "the run ended and was released", 60_000);
    // The command's process outlives a crash on its sandbox, as a box's does: let it finish now, so a second run of it
    // (the bug) would have counted by the time the run ended.
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(folder, "release"), ""));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
    assert.deepEqual(lines(join(folder, "count.txt")), ["ran"], "the bash command ran once: the next claim never ran it again");
    assert.deepEqual(sandboxes, ["runner-a", "runner-b"], "runner-b's claim had a sandbox of its own");
    assert.deepEqual(await callsIn(server), [["bash", "interrupted"]], "the call ends interrupted in the run's journal");
    assert.equal(requests.length, 2, `two model requests: the call, then the answer after the hand-back: ${requests.length}`);
    const told = toolResultsOf(requests[1]);
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.match(told[0], /interrupt/i, `the model is told the call was interrupted: ${told[0]}`);
    assert.doesNotMatch(told[0], /finished/, "never the output of a second run");
    await b.close();
  });
}

// The same on claude-agent's path: a process harness (run-adapters' faux harness in claude-agent's place, as serve's harness
// tests run it: fixtures/faux-table.mjs), whose bash is the host's tool bridged into the CLI's session and run in the
// claim's sandbox, and whose resume is the CLI's own session read back (resumeUnstartedCalls: a call with no intent in the
// records runs, one with an intent is left interrupted). An API server and two in-process runners on one data directory.
for (const [how, timing] of [["hands the run back (its close)", STEADY], ["dies (a crash, its lease left to lapse)", SHORT]]) {
  test(`claude-agent: a bash call in flight when its runner ${how} is never run again on the next claim's new sandbox, and the run ends there`, { timeout: 120_000 }, async (t) => {
    const marks = await scratch(t);
    const command = `echo ran >> ${marks}/count.txt; touch ${marks}/started; while [ ! -e ${marks}/release ]; do sleep 0.05; done; echo finished`;
    const harnessTable = fauxTable(FAUX_HARNESS);
    const { api, data, store } = await serve(t, { runner: false, harnessTable });
    const sandboxes = [];
    const runnerOf = (name) => startInProcessRunner(data, {
      harnessTable,
      runnerTiming: { ...timing, name },
      computerForClaim: async (launch) => {
        const folder = runFolder(data, "bash-cli", launch.runId);
        mkdirSync(folder, { recursive: true });
        sandboxes.push(name);
        return streamingSandbox(folder);
      },
    });
    // Saved in the store as the API saves an agent and a run, with bash granted on the runner's place: the API refuses that
    // grant (bash runs only in a box), and the claim's computer here is the test's sandbox, as a box's would be.
    await store.agents.create({ id: "bash-cli", name: "bash-cli" }, { id: "rev-cli", kind: "agentic", body: { instructions: `Box calls: ${JSON.stringify([{ call: "bash", args: { command } }])}`, tools: ["bash"], harness: "claude-agent" } });
    const runId = "run-cli";
    await store.runs.create({ id: runId, agentId: "bash-cli", revisionId: "rev-cli" }, { body: { input: { content: "Go." }, title: "Go.", place: { mode: "runner" }, harness: "claude-agent", model: { provider: "faux", modelId: "faux-1" } } });
    const run = { body: { run_id: runId } };
    const a = await runnerOf("runner-a");
    let b;
    t.after(async () => {
      await writeMark(marks, "release");
      await b?.().catch(() => {});
      await a().catch(() => {});
    });
    await until(() => existsSync(join(marks, "started")), "bash started on runner-a's sandbox", 60_000);
    if (timing === STEADY) await a();
    else a.kill();
    b = await runnerOf("runner-b");
    const { last, rows } = await follow(api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
    await writeMark(marks, "release");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const shown = JSON.stringify(rows.map((r) => [r.kind, r.summary, r.tool_status, r.tool_result_preview]));
    assert.deepEqual(lines(join(marks, "count.txt")), ["ran"], `the bash command ran once: the next claim never ran it again: ${shown}`);
    assert.deepEqual(sandboxes, ["runner-a", "runner-b"], "runner-b's claim had a sandbox of its own");
    assert.equal(last.status, "completed", shown);
    const results = rows.filter((r) => r.kind === "tool_result");
    assert.deepEqual(results.map((r) => [r.tool_status, /^interrupted: /.test(r.tool_result_preview ?? "")]), [["failed", true]], `the call's one result: interrupted, never a second run's output: ${shown}`);
  });
}

async function writeMark(dir, name) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, name), "").catch(() => {});
}

// A claude-agent turn cut mid-request (no tool in flight) by its runner's hand-back goes on on the next runner: the request
// is asked again there, once, and the run ends with its one answer. harness-run.test.mjs's skipped case (#2089) is the
// same cut by a whole server's stop and restart; this is the runner split's hand-back between two runners.
test("claude-agent: a turn its runner hands back mid-request goes on on the next runner and ends with one answer, each request counted once", { timeout: 120_000 }, async (t) => {
  const harnessTable = fauxTable(FAUX_HARNESS);
  const { api, data } = await serve(t, { runner: false, harnessTable });
  const runnerOf = (name) => startInProcessRunner(data, { harnessTable, runnerTiming: { ...STEADY, name } });
  const go = join(await scratch(t), "go");
  assert.equal((await api("POST", "/agents", { definition: { id: "waits", version: 1, name: "waits", instructions: `Wait for ${go} before the answer.`, skills: [], tools: ["read"], harness: "claude-agent" } })).status, 201);
  const made = await api("POST", "/agents/waits/runs", { input: { content: "hi" } });
  assert.equal(made.status, 202, JSON.stringify(made.body));
  const runId = made.body.run_id;
  const a = await runnerOf("runner-a");
  let b;
  t.after(async () => {
    await b?.().catch(() => {});
    await a().catch(() => {});
  });
  // The first request is paid and its tool has ended: its row is in, then the turn holds on its second request.
  await until(async () => (await api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "tool_result"), "the first request's tool row", 60_000);
  await a();
  b = await runnerOf("runner-b");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(go, ""));
  const { last, rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
  const shown = JSON.stringify(rows.map((r) => [r.kind, r.summary]));
  assert.equal(last.status, "completed", shown);
  assert.deepEqual(rows.filter((r) => r.kind === "final_answer").map((r) => r.summary), ["Done after the wait."], `one answer: ${shown}`);
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  assert.equal(usage?.requests, 2, `the request before the hand-back and the one after it, once each: ${JSON.stringify(usage)}`);
});
