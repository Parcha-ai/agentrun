// A person takes over a runner run's desktop and hands it back, over the one store (computer-view.ts), as the browser's
// hand-over is (browser-commands.ts): the take-over and the hand-back are command rows the runner applies to the run's
// hold (workspace/computer-hold.ts), and the hold's states are journal entries the server reads. Nothing is in the
// server's memory, so a take-over outlives the server that took it.
//
// The run is pi through the adapter loop on a runner, its spec carrying a desktop (`computer: { kind, hold }`) whose
// screen is the test's own: the agent's first look waits inside the shot until the test lets it go, so the person's take
// meets a call in flight. The routes are called as serve's dispatch calls them (computerRoute, with the store and the
// run's journal), on the server's store; "a restart" closes that store and opens another on the same file.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { computerRoute } = await import("../dist/computer-view.js");
const { computerHold, heldHands } = await import("../dist/workspace/computer-hold.js");
const { runEntries, runTimeline } = await import("../dist/store-reads/journal.js");
const { ApiError } = await import("../dist/errors.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 15_000;
const OWNER = { ownerSession: true, token: false, accounts: true };
after(closeOpenSessions);

async function setup(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-computer-takeover-"));
  let server = await openSqliteStore({ dataDir: dir, role: "server" });
  const runners = [];
  const stores = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { computer: { kind: "desktop", provider: "e2b" } } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const until = async (check, what) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const found = await check();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`not within ${WAIT_MS} ms: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** One of the run's computer routes, as serve's dispatch calls it on the server's store (the one open now). */
  const route = (name, body) => computerRoute(name, "run-1", { ...OWNER, ...(body !== undefined ? { body } : {}) }, {
    store: server,
    entries: () => runEntries(server, "run-1", ctx),
    kind: "desktop",
  });
  /** The route's answer, or its refusal as { status, code, message }. */
  const answer = (name, body) => route(name, body).then((view) => ({ view }), (error) => {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, code: error.code, message: error.message };
  });
  /** The server goes away and comes back: its store is closed, and another opened on the same file. */
  const restart = async () => {
    await server.close();
    server = await openSqliteStore({ dataDir: dir, role: "server" });
  };
  /** The run's phase rows, as its Timeline shows them. */
  const rows = async () => (await runTimeline(server, "run-1", ctx)).map((row) => row.summary);
  /** The run on a runner: its first look at the screen waits inside the shot until `letGo`. */
  const start = async () => {
    const hold = computerHold();
    let shotStarted;
    const inShot = new Promise((resolve) => (shotStarted = resolve));
    let letGo;
    const released = new Promise((resolve) => (letGo = resolve));
    const held = heldHands({ screen: { shot: async () => { shotStarted(); await released; return { png: "AA==" }; } } }, hold);
    const look = { name: "look", replaySafe: true, run: async () => JSON.stringify(await held.screen.shot()) };
    // Two looks: the second is the agent's next call, parked while the person holds the desktop, so the run does not
    // end (and let its desktop go) under the person's hand.
    const spec = piAdapterSpec({ script: [{ call: "look" }, { call: "look" }, { say: "done" }], tools: { look }, hooks: quiet });
    const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1", computer: { kind: "desktop", hold } }));
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    runners.push(startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING }));
    await inShot;
    return { hold, letGo };
  };
  const ended = () => until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "ended" && row.runner === null && row;
  }, "the run ended");
  return { route, answer, restart, rows, start, until, ended };
}

test("a person takes over a runner run's desktop and hands it back: the take waits out the agent's call in flight, and the Timeline says both at their own times", async (t) => {
  const world = await setup(t);
  const run = await world.start();
  // Up, and the agent drives: read from the run's journal.
  const up = await world.until(async () => {
    const { view } = await world.answer("getRunComputer");
    return view?.state === "live" && view;
  }, "the desktop is live in the server's read");
  assert.equal(up.kind, "desktop");
  assert.equal(up.hold, "agent");
  assert.equal(up.taken_over, false);

  // The take: written, and pending while the agent's look is still in the shot.
  const taking = await world.route("takeOverRunComputer", {});
  assert.equal(taking.hold, "pending", "the person's take waits for the agent's call in flight");
  await world.until(async () => (await world.route("getRunComputer")).hold === "pending" && run.hold.state() === "pending", "the runner applied the take: pending");
  run.letGo();
  const taken = await world.until(async () => {
    const view = await world.route("getRunComputer");
    return view.hold === "person" && view;
  }, "the person holds the desktop once the call ended");
  assert.equal(taken.taken_over, true);

  // The hand-back: written, applied, and the agent drives again.
  const back = await world.route("handBackRunComputer", {});
  assert.ok(back.hold === "person" || back.hold === "agent", `the answer is the view: ${JSON.stringify(back)}`);
  await world.until(async () => (await world.route("getRunComputer")).hold === "agent" && run.hold.state() === "agent", "the desktop is the agent's again");
  await world.ended();
  const said = await world.rows();
  const took = said.indexOf("You took over the desktop");
  const gave = said.indexOf("You handed the desktop back");
  assert.ok(took >= 0 && gave > took, `the Timeline says the take, then the hand-back:\n${said.join("\n")}`);
});

test("two hand-backs of one take-over: the first wins, the second is a 409 in words, and only one hand-back is written to the Timeline", async (t) => {
  const world = await setup(t);
  const run = await world.start();
  await world.until(async () => (await world.answer("getRunComputer")).view?.state === "live", "the desktop is live");
  await world.route("takeOverRunComputer", {});
  run.letGo();
  await world.until(async () => (await world.route("getRunComputer")).hold === "person", "the person holds the desktop");

  const [first, second] = await Promise.all([world.answer("handBackRunComputer", {}), world.answer("handBackRunComputer", {})]);
  const won = [first, second].filter((answer) => answer.view);
  const lost = [first, second].filter((answer) => !answer.view);
  assert.equal(won.length, 1, `one hand-back wins: ${JSON.stringify([first, second])}`);
  assert.equal(lost.length, 1);
  assert.deepEqual({ status: lost[0].status, code: lost[0].code }, { status: 409, code: "handoff_answered" });
  assert.equal(lost[0].message, "The desktop was already handed back to the agent.");
  // A third, once the runner applied the first: the take is over, in the same words.
  await world.until(async () => (await world.route("getRunComputer")).hold === "agent", "the desktop is the agent's again");
  const late = await world.answer("handBackRunComputer", {});
  assert.deepEqual(late, { status: 409, code: "handoff_answered", message: "The desktop was already handed back to the agent." });
  await world.ended();
  assert.equal((await world.rows()).filter((row) => row === "You handed the desktop back").length, 1, "one hand-back on the Timeline");
});

test("a take-over survives a server restart: it is read from the store, never from the server's memory, and the new server hands it back", async (t) => {
  const world = await setup(t);
  const run = await world.start();
  await world.until(async () => (await world.answer("getRunComputer")).view?.state === "live", "the desktop is live");
  await world.route("takeOverRunComputer", {});
  run.letGo();
  await world.until(async () => (await world.route("getRunComputer")).hold === "person", "the person holds the desktop");

  await world.restart();
  const after = await world.route("getRunComputer");
  assert.deepEqual({ state: after.state, hold: after.hold, taken_over: after.taken_over }, { state: "live", hold: "person", taken_over: true }, "the new server reads the take-over");
  // Taking it again is the same answer: one take is in force, and nothing new is written.
  assert.equal((await world.route("takeOverRunComputer", {})).hold, "person");
  await world.route("handBackRunComputer", {});
  await world.until(async () => (await world.route("getRunComputer")).hold === "agent" && run.hold.state() === "agent", "the new server's hand-back reached the runner");
  await world.ended();
  const said = await world.rows();
  assert.equal(said.filter((row) => row === "You took over the desktop").length, 1, `one take on the Timeline:\n${said.join("\n")}`);
});
