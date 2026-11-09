// A run's update can take command rows in the same fenced transaction (runs.update(claim, patch, { take })): a stop the
// runner applies itself ends the run and marks the stop row taken together, or neither. A command already taken refuses the
// whole update (CommandTaken): the run's row is as it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";

const { CommandTaken, Fenced } = await import("../dist/store/index.js");

const commandRow = async (store, id) => (await store.commands("run-1", id - 1)).find((row) => row.id === id);

test("a stopped patch and its stop row's take land in one transaction", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const stop = await store.command("run-1", { kind: "stop" });
  const row = await store.runs.update(claim, { state: "stopped", summary: "stopped by a person" }, { take: [stop.id] });
  assert.equal(row.state, "stopped");
  assert.ok((await commandRow(store, stop.id)).takenAt !== null, "the stop taken with it");
});

test("a take of a command already taken refuses the whole update: the run is not stopped", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const stop = await store.command("run-1", { kind: "stop" });
  await store.take(claim, stop.id, "taken");
  await assert.rejects(store.runs.update(claim, { state: "stopped" }, { take: [stop.id] }), CommandTaken);
  assert.equal((await store.runs.get("run-1")).state, "running", "nothing written");
});

test("an array third argument is refused (TypeError), never read as `also`: the rows come as { also }", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const told = { table: "channel_told", row: { channel: "slack:C1", marker: "ended" } };
  await assert.rejects(store.runs.update(claim, { state: "ended" }, [told]), TypeError);
  assert.equal((await store.runs.get("run-1")).state, "running", "nothing written");
});

test("the update's `also` rows still come as before, beside a take, and a stale claim writes neither", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const stale = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  clock.now += 2_000;
  const claim = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  const stop = await store.command("run-1", { kind: "stop" });
  await assert.rejects(store.runs.update(stale, { state: "stopped" }, { take: [stop.id] }), Fenced);
  assert.equal((await commandRow(store, stop.id)).takenAt, null, "the stale claim took nothing");
  const told = { table: "channel_told", row: { channel: "slack:C1", marker: "stopped" } };
  await store.runs.update(claim, { state: "stopped" }, { also: [told], take: [stop.id] });
  assert.ok((await commandRow(store, stop.id)).takenAt !== null);
});
