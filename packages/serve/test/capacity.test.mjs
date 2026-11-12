// What one host can hold, and what it says about itself: a cap on concurrent runs from its memory, a health route that
// reads the store and the free disk, a cancel that settles a run whose carry back cannot be written, and a run whose
// process was killed answered again at once.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { sealKeyOf } from "../dist/tool-keys.js";
import { agent, FAUX, follow, runDir, scratch, serve, storeRun, withEnv } from "./support.mjs";

const MiB = 2 ** 20;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Instructions for the faux model to answer only once `dir`/`name` exists: a run that works until the test lets it go. */
const busy = (dir, name = "never") => `Answer once ${join(dir, name)} exists.`;

/** POST `body` to `path` under Idempotency-Key `key`, and return once the server holds it, still unanswered: a probe under
 *  the same key, with a body the route refuses before it does anything, is idempotency_mismatch only once the server has
 *  the request. `answer` is its answer; `at()` is when it came. */
async function held(api, path, body, key) {
  let at;
  const answer = api("POST", path, body, { "idempotency-key": key }).then((reply) => ((at = Date.now()), reply));
  for (let i = 0; ; i++) {
    const probe = await api("POST", path, {}, { "idempotency-key": key });
    if (probe.body?.error?.code === "idempotency_mismatch") break;
    assert.equal(probe.body?.error?.code, "input_invalid", JSON.stringify(probe.body));
    assert.ok(i < 400 && at === undefined, `the server holds the request: ${JSON.stringify(at && (await answer).body)}`);
    await sleep(25);
  }
  assert.equal(at, undefined, `it waits: ${JSON.stringify(at && (await answer).body)}`);
  return { answer, at: () => at };
}

test("the default cap on how many runs at once is pi's: the host's memory less the server's own, at a pi run's size, never under 1", async () => {
  const { defaultMaxRuns } = await import("../dist/index.js");
  const { builtinHarness } = await import("../dist/harness-table.js");
  const { SERVER_MIB } = await import("../dist/host.js");
  assert.equal(typeof defaultMaxRuns, "function");
  for (const mib of [512, 1024, 8 * 1024]) assert.equal(defaultMaxRuns(mib * MiB), Math.floor((mib - SERVER_MIB) / builtinHarness("pi").runMib), `${mib} MB`);
  assert.equal(defaultMaxRuns(100 * MiB), 1, "never under 1");
});

test("a run that has failed gives its place back once its process exits: a start meanwhile waits for it, never refused for a place the failed run is giving back", { timeout: 90_000 }, async (t) => {
  const gate = join(await scratch(t), "exit");
  withEnv(t, { EXIT_GATE: gate });
  const { api } = await serve(t, { maxRuns: 1, faux: new URL("./fixtures/faux-slow-exit.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("fails"))).status, 201);
  const first = await api("POST", "/agents/fails/runs", { input: { content: "hi" } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  // It reads failed (not yet final: its end waits for its process), and its process, told to stop, cannot exit yet:
  // its place is still held.
  for (let i = 0; (await api("GET", `/runs/${first.body.run_id}`)).body.status !== "failed"; i++) {
    assert.ok(i < 400, "the run reads failed");
    await sleep(50);
  }
  const next = await held(api, "/agents/fails/runs", { input: { content: "hi" } }, "next-start");
  const openedAt = Date.now();
  await writeFile(gate, "");
  const started = await next.answer;
  assert.equal(started.status, 202, `the next start waited for the place the failed run gave back: ${JSON.stringify(started.body)}`);
  assert.ok(next.at() >= openedAt, "admitted only once the failed run's process could exit, never two at once");
  await follow(api, started.body.run_id, ["failed"]);
});

// SKIP (follow-up #2058): a message to a run that completed or was stopped answers 409 not_continuable: the store does not open the run again
test("two follow-ups to a completed run that both wait for a place reach it: one reopens the run, the other waits for that; the reopen gives its place back when it ends again", { timeout: 90_000 }, async (t) => {
  const gate = join(await scratch(t), "gate");
  await writeFile(gate, "");
  withEnv(t, { EXIT_GATE: gate });
  const { api } = await serve(t, { maxRuns: 1, faux: new URL("./fixtures/faux-answer-slow-exit.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const { body: first } = await api("POST", "/agents/calc/runs", { input: { content: "First." } });
  await follow(api, first.run_id, ["completed"]);
  // A second run answers, and its process cannot exit: it holds the one place while the follow-ups wait for it.
  await rm(gate);
  const { body: holder } = await api("POST", "/agents/calc/runs", { input: { content: "Hold." } });
  for (let i = 0; (await api("GET", `/runs/${holder.run_id}`)).body.status !== "completed"; i++) {
    assert.ok(i < 400, "the holding run answers");
    await sleep(50);
  }
  const waiting = [];
  for (const [i, content] of ["And again?", "And once more?"].entries()) waiting.push(await held(api, `/runs/${first.run_id}/messages`, { content }, `follow-up-${i}`));
  assert.ok(waiting.every((one) => one.at() === undefined), "both wait for the place");
  await writeFile(gate, "");
  const statuses = await Promise.all(waiting.map((one) => one.answer));
  assert.deepEqual(statuses.map((a) => a.status), [202, 202], JSON.stringify(statuses.map((a) => a.body)));
  const { rows } = await follow(api, first.run_id, ["completed"]);
  const sent = rows.filter((r) => r.kind === "user_message").map((r) => r.text);
  assert.deepEqual([...sent].sort(), ["And again?", "And once more?", "First."].sort(), "both messages reached the run");
  // Completed again, it opens again for the next follow-up: the reopen the two shared is over.
  const third = await api("POST", `/runs/${first.run_id}/messages`, { content: "And a third time?" });
  assert.equal(third.status, 202, JSON.stringify(third.body));
  const after = await follow(api, first.run_id, ["completed"]);
  assert.ok(after.rows.some((r) => r.kind === "user_message" && r.text === "And a third time?"), "the third message reached the run");
  // Ended again, the reopen gave its one place back: a new start gets it.
  const next = await api("POST", "/agents/calc/runs", { input: { content: "Next." } });
  assert.equal(next.status, 202, `the follow-up kept a place: ${JSON.stringify(next.body)}`);
  await follow(api, next.body.run_id, ["completed"]);
});

test("a run's first message waits for a process slower to come up than a request's deadline: the run starts, never failed", async (t) => {
  const { api } = await serve(t, { faux: new URL("./fixtures/faux-slow-start.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("slow"))).status, 201);
  const run = await api("POST", "/agents/slow/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed"]);
  assert.equal(last.status, "completed", JSON.stringify(last));
});

test("a run a stopped server left queued, its first message never taken: nothing of it is written after the stop, and the next server's runner gives it the message", async (t) => {
  // The first start's runner never claims it: the run is queued, its first message untaken, as the stop finds it.
  const one = await serve(t, { runner: false });
  assert.equal((await one.api("POST", "/agents", agent("slow"))).status, 201);
  const run = await one.api("POST", "/agents/slow/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await one.stop();
  const db = new DatabaseSync(join(one.data, "store.sqlite"), { readOnly: true });
  const left = db.prepare("SELECT state, runner, epoch FROM runs WHERE id = ?").get(run.body.run_id);
  db.close();
  assert.deepEqual({ ...left }, { state: "queued", runner: null, epoch: 0 }, "never claimed");
  // The server runs in this process: what it says about the run after its stop is written here.
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (String(chunk).includes(run.body.run_id) && said.push(String(chunk)), write.call(process.stderr, chunk, ...rest));
  t.after(() => void (process.stderr.write = write));
  await sleep(1_500);
  assert.deepEqual(said, [], "nothing of the run after the server stopped");
  process.stderr.write = write;
  const two = await serve(t, { data: one.data });
  const { last } = await follow(two.api, run.body.run_id, ["completed", "failed"]);
  assert.equal(last.status, "completed", JSON.stringify(last));
});

test("a run working when its server stopped is taken up by the next server and answers: the stop released it, so the next runner claims it at once", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const one = await serve(t);
  assert.equal((await one.api("POST", "/agents", agent("busy"))).status, 201);
  const { body: run } = await one.api("POST", "/agents/busy/runs", { input: { content: busy(dir, "go") } });
  await follow(one.api, run.run_id, ["working"]);
  await one.stop();
  // Stopped mid-turn: released for the next runner, never final.
  const left = storeRun(one.data, run.run_id);
  assert.equal(left.state, "running", JSON.stringify(left));
  await writeFile(join(dir, "go"), "");
  const two = await serve(t, { data: one.data });
  const { last } = await follow(two.api, run.run_id, ["completed", "failed"]);
  assert.equal(last.status, "completed", JSON.stringify(last));
});

test("AGENTRUN_MAX_RUNS and --max-runs set the cap; a value that is not a positive integer is refused", async (t) => {
  const { data } = await serve(t);
  const zero = await startServe({ data: join(data, "..", "other"), port: 0, faux: FAUX, maxRuns: 0 }).then((server) => (t.after(() => server.close()), "started"), (error) => error.message);
  assert.match(zero, /max runs/i, "0 is refused");
  const caps = await (await import("../dist/index.js")).capabilities({ AGENTRUN_MAX_RUNS: "7" });
  assert.equal(caps.limits.max_concurrent_runs, 7);
});

test("GET /v2/health, with no credential: 200 when the store reads and the disk has room, and nothing it should not say", async (t) => {
  const { baseUrl, data } = await serve(t);
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { status: "ok", checks: { store: "ok", disk: "ok" } });
  assert.ok(!JSON.stringify(body).includes(data), "no path");
});

test("health is 503 with the reason when the free disk is under its floor", async (t) => {
  const { baseUrl } = await serve(t, { minFreeBytes: Number.MAX_SAFE_INTEGER });
  const low = await fetch(`${baseUrl}/health`);
  assert.equal(low.status, 503);
  assert.deepEqual(await low.json(), { status: "failing", checks: { store: "ok", disk: "below_floor" } });
});

test("health reads the server's own store: a store whose read fails, or never answers within HEALTH_STORE_MS, is does_not_open; one that answers is ok", async (t) => {
  const { healthOf, HEALTH_STORE_MS } = await import("../dist/host.js");
  const { data } = await serve(t);
  const answers = { agents: { get: async () => undefined } };
  const fails = { agents: { get: async () => { throw new Error("relation \"agents\" does not exist"); } } };
  const silent = { agents: { get: () => new Promise(() => {}) } };
  assert.deepEqual(await healthOf(answers, data, 64 * MiB), { status: "ok", checks: { store: "ok", disk: "ok" } });
  assert.deepEqual(await healthOf(fails, data, 64 * MiB), { status: "failing", checks: { store: "does_not_open", disk: "ok" } });
  const startedAt = Date.now();
  assert.deepEqual(await healthOf(silent, data, 64 * MiB), { status: "failing", checks: { store: "does_not_open", disk: "ok" } });
  assert.ok(Date.now() - startedAt < HEALTH_STORE_MS + 1_000, "bounded by HEALTH_STORE_MS");
});

test("a disk health cannot measure fails its check (503 cannot_check), never reads as room", async (t) => {
  const { healthOf } = await import("../dist/host.js");
  const { data } = await serve(t);
  const answers = { agents: { get: async () => undefined } };
  const failing = async () => { throw Object.assign(new Error("statfs failed"), { code: "EIO" }); };
  assert.deepEqual(await healthOf(answers, data, 64 * MiB, failing), { status: "failing", checks: { store: "ok", disk: "cannot_check" } });
  assert.deepEqual(await healthOf(answers, data, 64 * MiB), { status: "ok", checks: { store: "ok", disk: "ok" } });
});

test("compose and render.yaml check /v2/health", async () => {
  const compose = await readFile(new URL("../../../compose.yaml", import.meta.url), "utf8");
  assert.match(compose, /^ {4}healthcheck:\n {6}test: .*\/v2\/health/m, "the service's healthcheck reads /v2/health");
  const render = await readFile(new URL("../../../render.yaml", import.meta.url), "utf8");
  assert.match(render, /healthCheckPath: \/v2\/health/);
});

test("render.yaml generates the seal key, in a form the server takes: Render's random base64 of 256 bits", async () => {
  const render = await readFile(new URL("../../../render.yaml", import.meta.url), "utf8");
  assert.match(render, /^ {6}- key: AGENTRUN_SEAL_KEY\n {8}generateValue: true$/m, "a new service seals its saved keys, MCP credentials and trigger secrets from its first start");
  // Render's generateValue: "a randomized, base64-encoded, 256-bit value" (render.com/docs/blueprint-spec).
  const generated = randomBytes(32).toString("base64");
  assert.equal(sealKeyOf(generated)?.length, 32);
});

test("a run cancelled as the server stops has its end in the store once the stop is done: no next start opens it again", { timeout: 90_000 }, async (t) => {
  const one = await serve(t);
  const { api } = one;
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const { body: run } = await api("POST", "/agents/busy/runs", { input: { content: busy(await scratch(t)) } });
  await follow(api, run.run_id, ["working"]);
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
  // Stopped at once: the run's turn is still going, and its end is written before the stop is done.
  await one.stop();
  assert.equal(storeRun(one.data, run.run_id).state, "stopped");
  // The next start's runner never takes it up: past three of its polls, it still reads cancelled.
  const two = await serve(t, { data: one.data });
  const seen = two.runnerBeats();
  for (let i = 0; two.runnerBeats() < seen + 3; i++) {
    assert.ok(i < 300, "three runner beats");
    await sleep(100);
  }
  const view = (await two.api("GET", `/runs/${run.run_id}`)).body;
  assert.deepEqual([view.status, storeRun(one.data, run.run_id).state], ["cancelled", "stopped"], JSON.stringify(view));
});
