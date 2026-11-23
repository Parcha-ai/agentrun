// GET /v2/computers/running: every run still going whose agent has a computer, each as GET /v2/runs/{run_id} answers
// it. First on a --faux server through the production composition (the route table, the token check, the run read, the
// faux desktop made at the claim): a going run with a desktop is listed as its run read, one with no computer is not, a
// take-over shows as `taken_over`, and an ended run is gone from the list. Then the list's own rules over a store of rows
// and a stand-in read, with no server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runningComputers } from "../dist/computers-running.js";
import { agent, call, clientOwnerSession, follow, serve } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-desktop-held.mjs", import.meta.url).pathname;
const FIRST = Symbol.for("agentrun.test.first");
const HELD = Symbol.for("agentrun.test.held");

/** Until `check()` holds, bounded; each try after the next turn of the timers. */
async function until(check, what, ms = 30_000) {
  for (const deadline = Date.now() + ms; !(await check());) {
    assert.ok(Date.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a going run with a desktop is listed as its run read; one with no computer is not; a take-over shows; an ended run is gone", async (t) => {
  let letGo;
  globalThis[HELD] = new Promise((resolve) => (letGo = resolve));
  // Each run's first look tells the test: the desktop's, then the plain run's (whose look is a tool it does not have).
  let looks = 0;
  globalThis[FIRST] = () => { looks += 1; };
  t.after(() => {
    letGo();
    delete globalThis[FIRST];
    delete globalThis[HELD];
  });
  const server = await serve(t, { accounts: true, openSetup: true, faux: FAUX });
  const owner = await clientOwnerSession(server);
  const asOwner = (method, path, body) => call(server.port, { method, path, headers: { cookie: owner.cookie, origin: owner.origin, ...(body ? { "content-type": "application/json" } : {}) }, body });

  assert.equal((await call(server.port, { method: "GET", path: "/v2/computers/running" })).status, 401);
  assert.deepEqual((await server.api("GET", "/computers/running")).body, { runs: [] });

  assert.equal((await server.api("POST", "/agents", agent("desk", { computer: { kind: "desktop", provider: "faux-desktop" } }))).status, 201);
  assert.equal((await server.api("POST", "/agents", agent("plain"))).status, 201);
  const desk = await server.api("POST", "/agents/desk/runs", { input: { content: "Look at the desktop." } });
  assert.equal(desk.status, 202, JSON.stringify(desk.body));
  const plain = await server.api("POST", "/agents/plain/runs", { input: { content: "Answer." } });
  assert.equal(plain.status, 202, JSON.stringify(plain.body));
  // Both runs are going, each held at the faux model's wait after its first look.
  await until(() => looks >= 2, "both runs took their first turn");
  await until(async () => (await server.api("GET", `/runs/${desk.body.run_id}`)).body.computer?.state === "ready", "the desktop is up");
  assert.equal((await server.api("GET", `/runs/${plain.body.run_id}`)).body.status, "working", "the run with no computer is going too");

  const listed = (await server.api("GET", "/computers/running")).body;
  const read = (await server.api("GET", `/runs/${desk.body.run_id}`)).body;
  assert.deepEqual(listed.runs.map((run) => run.run_id), [desk.body.run_id], "the desktop's run alone");
  const [run] = listed.runs;
  assert.deepEqual(Object.keys(run).sort(), Object.keys(read).sort(), "every field of the run read");
  assert.deepEqual([run.agent_id, run.title, run.status, run.kind, run.created_at], [read.agent_id, read.title, read.status, read.kind, read.created_at]);
  assert.deepEqual(run.computer, { kind: "desktop", provider: "faux-desktop", state: "ready" });

  // The owner takes the desktop: the list says so, as the run read does.
  assert.equal((await asOwner("POST", `/v2/runs/${desk.body.run_id}/computer/take-over`, {})).status, 200);
  await until(async () => (await server.api("GET", "/computers/running")).body.runs[0]?.computer.state === "taken_over", "the list says the owner has it");
  assert.equal((await asOwner("POST", `/v2/runs/${desk.body.run_id}/computer/hand-back`, {})).status, 200);

  letGo();
  await follow(server.api, desk.body.run_id, ["completed"]);
  await follow(server.api, plain.body.run_id, ["completed", "failed"]);
  assert.deepEqual((await server.api("GET", "/computers/running")).body, { runs: [] });
});

/** A store of run rows by state and revisions by id. */
const storeOf = (rows, revisions) => ({
  runs: { list: async ({ state }) => rows.filter((row) => row.state === state) },
  agents: { revision: async (id) => revisions[id] },
});
const row = (id, state, revisionId) => ({ id, state, revisionId, agentId: "a" });
const DESKTOP = { body: { computer: { kind: "desktop", provider: "e2b" } } };
const going = (created_at, state = "ready") => ({ status: "working", created_at, computer: { kind: "desktop", provider: "e2b", state } });

test("only going runs whose agent has a computer are read, and the list is newest first", async () => {
  const store = storeOf(
    [row("r1", "running", "desk"), row("r2", "queued", "desk"), row("r3", "parked", "desk"), row("r4", "running", "none"), row("r5", "running", "plain"), row("r6", "ended", "desk")],
    { desk: DESKTOP, none: { body: { computer: { kind: "none" } } }, plain: { body: {} } },
  );
  const reads = { r1: going("2026-11-05T09:00:00.000Z"), r2: going("2026-11-05T09:02:00.000Z", "starting"), r3: going("2026-11-05T09:01:00.000Z") };
  const asked = [];
  const { runs } = await runningComputers(store, async (runId) => { asked.push(runId); return reads[runId]; });
  assert.deepEqual(runs, [reads.r2, reads.r3, reads.r1]);
  assert.deepEqual(asked.sort(), ["r1", "r2", "r3"], "a run with no computer, and an ended one, is never read");
});

test("a sandbox an agent's place stands for counts as its computer", async () => {
  const sandbox = { status: "working", created_at: "2026-11-05T09:00:00.000Z", computer: { kind: "sandbox", provider: "docker", state: "ready" } };
  const { runs } = await runningComputers(storeOf([row("r1", "running", "boxed")], { boxed: { body: { place: { mode: "sandbox", box: "docker" } } } }), async () => sandbox);
  assert.deepEqual(runs, [sandbox]);
});

test("a run gone, or ended, between its row and its read is left out", async () => {
  const reads = { over: going("2026-11-05T09:00:00.000Z", "ended"), up: going("2026-11-05T09:00:00.000Z") };
  const { runs } = await runningComputers(storeOf([row("gone", "running", "desk"), row("over", "running", "desk"), row("up", "running", "desk")], { desk: DESKTOP }), async (runId) => reads[runId]);
  assert.deepEqual(runs, [reads.up]);
});

test("a run whose row moves from one state to the next while the rows are listed is listed once", async () => {
  // The queued rows are listed, then the run is claimed: it is among the running rows too.
  const rows = [row("r1", "queued", "desk"), row("r1", "running", "desk")];
  const { runs } = await runningComputers(storeOf(rows, { desk: DESKTOP }), async () => going("2026-11-05T09:00:00.000Z"));
  assert.equal(runs.length, 1);
});

