// A runner's close applies a stop or cancel a person sent before it that no delivery had handed on yet (the command poll's
// tick had not come): that run ends stopped, its row taken, before close resolves, and the next start never resumes it.
// A run with no such row is still stopped for a shutdown and released running, for the next runner. The command poll is
// set far past the case, so only the close can read the rows: ordered by events, never by time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendCommand } from "../dist/runner/commands.js";
import { startRunner } from "../dist/runner/runner.js";
import { commandRow, fauxLoops, queue, stores, until } from "./runner-support.mjs";

const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 600_000 };

for (const kind of ["cancel", "stop"]) {
  test(`a ${kind} sent before a runner's close, never delivered, ends its run at the close: stopped, its row taken; the run beside it with none is released running`, async (t) => {
    const { server, runners: [store] } = await stores({ runners: 1 });
    // Long enough that neither run ends on its own before the close.
    const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
    const runner = startRunner({ store, createLoop: faux.createLoop, name: "runner-a", ...TIMING });
    t.after(() => runner.close());
    await queue(server, "run-1");
    await queue(server, "run-2");
    await until(() => faux.loops.length === 2, "both runs claimed");
    const row = await sendCommand(server, "run-1", { kind });
    await runner.close();
    const ended = await server.runs.get("run-1");
    assert.deepEqual([ended.state, ended.runner], ["stopped", null], `run-1 ended at the close: ${JSON.stringify(ended)}`);
    assert.notEqual((await commandRow(server, "run-1", row.id)).takenAt, null, "its row is taken");
    const loopOf = (runId) => faux.loops.find((loop) => loop.claim.runId === runId);
    assert.deepEqual(loopOf("run-1").stopCalls.map((call) => [call.kind, call.commandId, call.cancel ?? false]), [["command", row.id, kind === "cancel"]], "stopped by its row, never for a shutdown");
    const released = await server.runs.get("run-2");
    assert.deepEqual([released.state, released.runner], ["running", null], `run-2 released for the next runner: ${JSON.stringify(released)}`);
    assert.deepEqual(loopOf("run-2").stopCalls.map((call) => call.kind), ["shutdown"]);
  });
}

test("a close whose read of the stop rows never answers is bounded by the stop margin: the run is stopped for a shutdown and released, its cancel left for the next claim", async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  // The store answers every read but the close's one (the command poll never ticks here): that one never answers.
  const stalled = new Proxy(store, {
    get(target, prop) {
      if (prop === "commandsOf") return () => new Promise(() => {});
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const events = [];
  const runner = startRunner({ store: stalled, createLoop: faux.createLoop, name: "runner-a", ...TIMING, stopMarginMs: 1_000, onEvent: (event) => events.push(event) });
  t.after(() => runner.close());
  await queue(server, "run-1");
  await until(() => faux.loops.length === 1, "the run claimed");
  const row = await sendCommand(server, "run-1", { kind: "cancel" });
  const startedAt = Date.now();
  await runner.close();
  assert.ok(Date.now() - startedAt < 10_000, `the close resolved within its bounds: ${Date.now() - startedAt} ms`);
  const released = await server.runs.get("run-1");
  assert.deepEqual([released.state, released.runner], ["running", null], `released for the next runner: ${JSON.stringify(released)}`);
  assert.equal((await commandRow(server, "run-1", row.id)).takenAt, null, "its cancel is left untaken for the next claim");
  assert.deepEqual(faux.loops[0].stopCalls.map((call) => call.kind), ["shutdown"]);
  assert.ok(events.some((event) => event.type === "error" && event.step === "commands" && /took longer than 1000 ms/.test(event.message)), `the close said why: ${JSON.stringify(events.filter((event) => event.type === "error"))}`);
});
