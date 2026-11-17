// The run's release sweeps the run's scratch (.agentrun/tmp, .agentrun/output) through its own Workspace only after the
// computer is let go: on Archil that Workspace is the disk's file API, and a computer's mount of the folder holds
// Archil's write delegation until its release (final sync, then checkin), refusing every delete under the folder until
// then. A park that keeps the computer sweeps nothing (its processes and their outputs live on), and a failed step is
// logged and the next still taken. Each part is a seam the test controls.
import assert from "node:assert/strict";
import test from "node:test";
import { SpecHolds } from "../dist/runner/spec-holds.js";

/** Every part a spec holds, each recording its step in `order` (`fails`: the steps that throw). */
function parts(order, { fails = [], keeps = false } = {}) {
  const step = (name) => async () => {
    order.push(name);
    if (fails.includes(name)) throw new Error(`${name} failed`);
  };
  return {
    tools: { end: step("tools.end"), sweep: step("tools.sweep") },
    checkout: { end: step("checkout.end") },
    computer: { release: step("computer.release"), ...(keeps ? { keeps: "sandbox", park: async () => (order.push("computer.park"), !fails.includes("computer.park")) } : {}) },
    archil: { revoke: step("archil.revoke") },
    ws: { end: step("ws.end") },
  };
}

test("the release sweeps the run's scratch after the computer is let go, and before the mount credential's revoke and the Workspace's end", async () => {
  const order = [];
  const holds = new SpecHolds();
  holds.hold(parts(order));
  await holds.release();
  assert.deepEqual(order, ["tools.end", "checkout.end", "computer.release", "tools.sweep", "archil.revoke", "ws.end"]);
  await holds.release();
  assert.equal(order.filter((name) => name === "tools.sweep").length, 1, "a second release sweeps nothing more");
});

test("the run's end (endCheckout, before its commit) stops the tools' processes but sweeps nothing: the sweep waits for the release", async () => {
  const order = [];
  const holds = new SpecHolds();
  holds.hold(parts(order));
  await holds.endCheckout();
  assert.deepEqual(order, ["tools.end", "checkout.end"]);
  await holds.release();
  assert.deepEqual(order, ["tools.end", "checkout.end", "computer.release", "tools.sweep", "archil.revoke", "ws.end"]);
});

test("a park that keeps the computer sweeps nothing; one whose keep fails lets the computer go, then sweeps", async () => {
  const kept = [];
  const keeping = new SpecHolds();
  keeping.hold(parts(kept, { keeps: true }));
  await keeping.release({ parked: "answer" });
  assert.ok(!kept.includes("tools.sweep"), `a kept computer's scratch stays: ${kept.join(", ")}`);
  assert.ok(!kept.includes("tools.end"), "and its processes run on");

  const failed = [];
  const letGo = new SpecHolds();
  letGo.logTo(() => {});
  letGo.hold(parts(failed, { keeps: true, fails: ["computer.park"] }));
  await letGo.release({ parked: "answer" });
  assert.deepEqual(failed, ["computer.park", "tools.end", "checkout.end", "computer.release", "tools.sweep", "archil.revoke", "ws.end"]);
});

test("a computer that could not be let go is logged and the sweep still runs; a sweep that fails is logged and the release goes on", async () => {
  const order = [];
  const logged = [];
  const holds = new SpecHolds();
  holds.logTo((line) => logged.push(line));
  holds.hold(parts(order, { fails: ["computer.release", "tools.sweep"] }));
  await holds.release();
  assert.deepEqual(order, ["tools.end", "checkout.end", "computer.release", "tools.sweep", "archil.revoke", "ws.end"]);
  assert.ok(logged.some((line) => /computer could not be let go: computer\.release failed/.test(line)), logged.join("\n"));
  assert.ok(logged.some((line) => /scratch could not be swept: tools\.sweep failed/.test(line)), logged.join("\n"));
});
