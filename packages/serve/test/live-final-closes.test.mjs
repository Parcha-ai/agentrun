// A run that goes final (the lead's read of #1969, P2-13) closes its live stream, whatever ends it: a person's stop while a
// tool runs, a resume's stop that the runner ends itself, and a loop that fails before its journal opens, whose end the
// runner writes. A stream left open on a final run would keep its reader waiting for good.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendCommand } from "../dist/runner/commands.js";
import { collect, liveWorld, RUN } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");

/** `journal` with every read refused, as a store that cannot be read: pi's Harness cannot open on it. */
const unreadable = (journal) =>
  new Proxy(journal, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return key === "stage" ? value.bind(target) : () => Promise.reject(new Error("the run's harness could not open"));
    },
  });

/** The stream's end, or a refusal naming what it saw when it does not close within `ms`. */
const closedWithin = (stream, got, ms) =>
  Promise.race([
    stream.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`the stream did not close within ${ms} ms; it saw ${JSON.stringify(got.types())}`)), ms)),
  ]);

test("a run a person stops while a tool runs closes its live stream", async (t) => {
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run([{ call: "slow" }, { say: "done" }]);
  await w.tools.slowStarted;
  await sendCommand(w.server, RUN, { kind: "stop", body: {} });
  await w.ended("stopped");
  assert.deepEqual(await closedWithin(stream, got, 5_000), { reason: "ended" });
});

test("a run whose loop fails before its journal opens closes its live stream", async (t) => {
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run([{ say: "done" }], { journal: unreadable });
  const row = await w.ended("failed");
  assert.match(row.summary ?? "", /could not open/);
  assert.deepEqual(await closedWithin(stream, got, 5_000), { reason: "ended" });
});

test("a run stopped while its loop fails closes its live stream", async (t) => {
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await sendCommand(w.server, RUN, { kind: "stop", body: {} });
  await w.run([{ say: "done" }], { journal: unreadable });
  await w.ended("stopped");
  assert.deepEqual(await closedWithin(stream, got, 5_000), { reason: "ended" });
});
