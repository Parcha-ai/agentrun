// The run's tool gate is the pi chokepoint of the barriers (pi-durable-disk barriers.ts, piToolIntent): a call that is
// not replay-safe goes out only once the run's store synced, after pi-durable committed its intent. On a store at
// NORMAL that is one commit at FULL just before the tool runs; a replay-safe call takes none.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openArchilStore } from "@parcha/pi-durable-disk/lease";
import { RunGate } from "../dist/tool-gate.js";
import { scratch } from "./support.mjs";

/** A NORMAL store whose commits are logged with the level each ran at, beside the gate's tool runs. */
async function normalStore(t, log) {
  const dir = await scratch(t);
  const level = async (on) => Number(Object.values(await on.get("PRAGMA synchronous"))[0]);
  const store = await openArchilStore(join(dir, "store", "run.sqlite"), "exclusive", {
    synchronous: "NORMAL",
    decorate: (inner) => ({
      exec: (sql) => inner.exec(sql),
      run: (sql, ...p) => inner.run(sql, ...p),
      get: (sql, ...p) => inner.get(sql, ...p),
      all: (sql, ...p) => inner.all(sql, ...p),
      async transaction(callback) {
        let at = 0;
        const value = await inner.transaction(async (tx) => {
          const result = await callback(tx);
          at = await level(tx);
          return result;
        });
        log.push(at === 2 ? "commit FULL" : "commit NORMAL");
        return value;
      },
      close: () => inner.close(),
    }),
  });
  t.after(() => store.storage.close(BACKGROUND_CONTEXT).catch(() => undefined));
  return store;
}

async function gated(t, store, tool) {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  const gate = new RunGate({ root, work, data, runId: "r1", harness: "pi" }, { [tool.name]: { permission: "allow" } }, true, true);
  // As the run's beforeResume primes it: the store comes with the prime, before any resumed call can run.
  await gate.prime({ conversation: async () => undefined }, BACKGROUND_CONTEXT, store);
  return gate.extension([tool]).wraps.find((wrap) => wrap.tool === tool.name).wrap(tool);
}

for (const [replay, expected] of [
  [undefined, ["commit FULL", "ran"]],
  ["unsafe", ["commit FULL", "ran"]],
  ["safe", ["ran"]],
]) {
  test(`a pi call ${replay === "safe" ? "that is replay-safe runs with no sync" : `(${replay ?? "no replay set"}) runs only after the store synced`}`, async (t) => {
    const log = [];
    const store = await normalStore(t, log);
    const tool = { name: "write", description: "write", parameters: {}, ...(replay ? { replay } : {}), execute: async () => (log.push("ran"), { content: [{ type: "text", text: "ok" }] }) };
    const wrapped = await gated(t, store, tool);
    const before = log.length;
    const api = { callId: "c1", commit: async () => undefined };
    await wrapped.execute({}, api, {});
    assert.deepEqual(log.slice(before), expected);
  });
}
