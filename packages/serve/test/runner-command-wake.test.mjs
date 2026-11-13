// A command written for a held run reaches its loop at once, not at the runner's next command poll: with commandPollMs at
// ten seconds, the row is in the loop's command() well inside 100 ms, and a row written while a delivery is in flight is
// handed on by the one more delivery that follows it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxLoops, queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 10_000 };

test("a row written for a held run reaches its loop's command() in under 100 ms with the command poll at ten seconds", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const runner = startRunner({ store: opened.runners[0], createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(() => faux.loops[0]?.claim !== null && faux.loops[0] !== undefined, "the run is held and its loop started");
  const loop = faux.loops[0];
  const wrote = Date.now();
  const row = await opened.server.command("run-1", { kind: "steer", body: { content: "now" } });
  await until(() => loop.received.some((one) => one.id === row.id), "the row reaches the loop", 2_000);
  const ms = loop.received.find((one) => one.id === row.id).at - wrote;
  console.log(`runner wake: a row written for a held run reached its loop's command() in ${ms} ms (commandPollMs 10000)`);
  assert.ok(ms < 100, `${ms} ms`);
});

test("rows written one after another while deliveries are in flight all reach the loop before the next poll", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const runner = startRunner({ store: opened.runners[0], createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(() => faux.loops[0]?.claim !== null && faux.loops[0] !== undefined, "the run is held and its loop started");
  const loop = faux.loops[0];
  const rows = await Promise.all([1, 2, 3, 4, 5].map((n) => opened.server.command("run-1", { kind: "steer", body: { content: `m${n}` } })));
  await until(() => rows.every((row) => loop.received.some((one) => one.id === row.id)), "every row reaches the loop", 2_000);
  assert.deepEqual(loop.received.map((one) => one.id), [...loop.received.map((one) => one.id)].sort((a, b) => a - b), "in id order, each once");
  assert.equal(new Set(loop.received.map((one) => one.id)).size, loop.received.length);
});
