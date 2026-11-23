// GET /v2/computers/running: every run still going whose agent has a computer, each with the run read's own `computer`
// field. First on a --faux server through the production composition (the route table, the token check, the run read
// and its computer field, the faux desktop made at the claim): a going run with a desktop is listed, one with no
// computer is not, a take-over shows as `taken_over`, and an ended run is gone from the list. Then the list's own rules
// over its ports (computers-running.ts runningComputers), with a store of rows and no server.
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

test("a going run with a desktop is listed with its run read's computer; one with no computer is not; a take-over shows; an ended run is gone", async (t) => {
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

  // No token, no list; with nothing going, an empty one.
  assert.equal((await call(server.port, { method: "GET", path: "/v2/computers/running" })).status, 401);
  assert.deepEqual((await server.api("GET", "/computers/running")).body, { computers: [] });

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
  assert.deepEqual(listed, {
    computers: [{ run_id: desk.body.run_id, agent_id: "desk", title: read.title, status: "working", state: "working", created_at: read.created_at, computer: { kind: "desktop", provider: "faux-desktop", state: "ready" } }],
  }, "the desktop's run alone, with its read's own words");
  assert.deepEqual(listed.computers[0].computer, read.computer, "the same computer field as the run read's");

  // The owner takes the desktop: the list says so, as the run read does.
  assert.equal((await asOwner("POST", `/v2/runs/${desk.body.run_id}/computer/take-over`, {})).status, 200);
  await until(async () => (await server.api("GET", "/computers/running")).body.computers[0]?.computer.state === "taken_over", "the list says the owner has it");
  assert.equal((await asOwner("POST", `/v2/runs/${desk.body.run_id}/computer/hand-back`, {})).status, 200);

  // Both runs end: nothing is up.
  letGo();
  await follow(server.api, desk.body.run_id, ["completed"]);
  await follow(server.api, plain.body.run_id, ["completed", "failed"]);
  assert.deepEqual((await server.api("GET", "/computers/running")).body, { computers: [] });
});

/** A store of run rows by state and revisions by id, counting each revision's reads. */
function storeOf(rows, revisions) {
  const reads = new Map();
  return {
    reads,
    runs: { list: async ({ state }) => rows.filter((row) => row.state === state) },
    agents: { revision: async (id) => { reads.set(id, (reads.get(id) ?? 0) + 1); return revisions[id]; } },
  };
}
const row = (id, state, revisionId, agentId = "a") => ({ id, state, revisionId, agentId });
const viewOf = (views) => async (runId) => views[runId];
const DESKTOP = { body: { computer: { kind: "desktop", provider: "e2b" } } };

test("the list reads a run only when its agent has a computer, each revision once, and is newest first", async () => {
  const store = storeOf(
    [row("r1", "running", "desk"), row("r2", "queued", "desk"), row("r3", "parked", "desk"), row("r4", "running", "none"), row("r5", "running", "plain"), row("r6", "ended", "desk")],
    { desk: DESKTOP, none: { body: { computer: { kind: "none" } } }, plain: { body: {} } },
  );
  const viewed = [];
  const views = {
    r1: { title: "one", status: "working", state: "working", created_at: "2026-11-05T09:00:00.000Z" },
    r2: { title: "two", status: "queued", state: "working", created_at: "2026-11-05T09:02:00.000Z" },
    r3: { title: "three", status: "input_required", state: "waiting", created_at: "2026-11-05T09:01:00.000Z" },
  };
  const { computers } = await runningComputers(store, {
    view: async (runId) => { viewed.push(runId); return views[runId]; },
    computer: async (runId, view) => ({ computer: { kind: "desktop", provider: "e2b", state: view.status === "queued" ? "starting" : "ready" } }),
  });
  assert.deepEqual(computers.map((c) => [c.run_id, c.title, c.status, c.state, c.computer.state]), [
    ["r2", "two", "queued", "working", "starting"],
    ["r3", "three", "input_required", "waiting", "ready"],
    ["r1", "one", "working", "working", "ready"],
  ]);
  assert.deepEqual(viewed.sort(), ["r1", "r2", "r3"], "a run with no computer, and an ended one, is never read");
  assert.equal(store.reads.get("desk"), 1, "three runs of one revision read its setting once");
});

test("a sandbox an agent's place stands for counts as its computer", async () => {
  const store = storeOf([row("r1", "running", "boxed")], { boxed: { body: { place: { mode: "sandbox", box: "docker" } } } });
  const { computers } = await runningComputers(store, {
    view: viewOf({ r1: { title: "boxed", status: "working", state: "working", created_at: "2026-11-05T09:00:00.000Z" } }),
    computer: async () => ({ computer: { kind: "sandbox", provider: "docker", state: "ready" } }),
  });
  assert.deepEqual(computers.map((c) => [c.run_id, c.computer.kind]), [["r1", "sandbox"]]);
});

test("a run gone or ended between the list and its read is left out", async () => {
  const store = storeOf([row("gone", "running", "desk"), row("over", "running", "desk"), row("none", "running", "desk"), row("up", "running", "desk")], { desk: DESKTOP });
  const view = { title: "t", status: "working", state: "working", created_at: "2026-11-05T09:00:00.000Z" };
  const { computers } = await runningComputers(store, {
    view: viewOf({ over: { ...view, status: "completed" }, none: view, up: view }),
    computer: async (runId) => (runId === "over" ? { computer: { kind: "desktop", provider: "e2b", state: "ended" } } : runId === "none" ? {} : { computer: { kind: "desktop", provider: "e2b", state: "ready" } }),
  });
  assert.deepEqual(computers.map((c) => c.run_id), ["up"]);
});

test("a run that moves from queued to running while the states are listed is listed once", async () => {
  // The queued list still has the run; by the running list's turn it is running there too.
  const moved = row("moved", "queued", "desk");
  const viewed = [];
  const store = {
    runs: { list: async ({ state }) => (state === "queued" || state === "running" ? [{ ...moved, state }] : []) },
    agents: { revision: async () => DESKTOP },
  };
  const { computers } = await runningComputers(store, {
    view: async (runId) => { viewed.push(runId); return { title: "t", status: "working", state: "working", created_at: "2026-11-05T09:00:00.000Z" }; },
    computer: async () => ({ computer: { kind: "desktop", provider: "e2b", state: "ready" } }),
  });
  assert.deepEqual(computers.map((c) => c.run_id), ["moved"]);
  assert.deepEqual(viewed, ["moved"], "the run is read once");
});

test("a run that failed for want of its computer between the list and its read is left out", async () => {
  const store = storeOf([row("unavailable", "running", "desk"), row("up", "running", "desk")], { desk: DESKTOP });
  const view = { title: "t", status: "working", state: "working", created_at: "2026-11-05T09:00:00.000Z" };
  const { computers } = await runningComputers(store, {
    view: viewOf({ unavailable: { ...view, status: "failed", state: "ended" }, up: view }),
    // As runComputerField says it: a computer_unavailable failure reads `failed`, not `ended`.
    computer: async (runId) => ({ computer: { kind: "desktop", provider: "e2b", state: runId === "unavailable" ? "failed" : "ready" } }),
  });
  assert.deepEqual(computers.map((c) => c.run_id), ["up"]);
});
