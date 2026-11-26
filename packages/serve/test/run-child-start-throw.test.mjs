// A run's start in a process of its own can throw before that process is up: a store read, the server's settings or its
// keys (run-child-host.ts). A stop or a command handed over then must not wait on a process that never comes: each
// finds no channel and says so, as for a start that was handed back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { childLoops } = await import("../dist/runner/run-child-host.js");
const { launchBody } = await import("../dist/run-launch.js");
const { heldRedactor } = await import("../dist/runner/redact.js");

/** `promise`, or "waited" if it is still pending after `ms`. */
const within = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve("waited"), ms)))]).finally(() => clearTimeout(timer));
};

test("a start that throws before its process is up: a stop and a command handed over after it end at once, never waiting on a process that never comes", { timeout: 30_000 }, async (t) => {
  const { store, dir: data } = await storeOn(t);
  await store.agents.create({ id: "agent", name: "Thrown" }, { id: "rev", kind: "agentic", body: { instructions: "Work." } });
  await store.runs.create({ id: "run", agentId: "agent", revisionId: "rev" }, { body: launchBody({ input: { content: "Work." }, title: "Work", place: { mode: "runner" }, harness: "pi" }) });
  const claim = await store.claim("run", "fixture", { leaseMs: 60_000 });
  // The run's row read fails as the start begins, the first of its reads before a process or a slot.
  const runs = new Proxy(store.runs, { get: (target, key) => (key === "get" ? async () => { throw new Error("the store is gone"); } : Reflect.get(target, key, target)) });
  const failing = new Proxy(store, { get: (target, key) => (key === "runs" ? runs : Reflect.get(target, key, target)) });
  const deps = { store: failing, data, sealKey: Buffer.alloc(32, 7), env: {}, computerForClaim: async () => { throw new Error("no computer here"); } };
  const loop = childLoops({ deps, isolation: { kind: "process", why: "a test's runner" }, log: () => {}, argv: [process.execPath, "-e", "process.exit(0)"] })({
    signal: new AbortController().signal, journal: (c) => store.journal(c), flush: async () => {}, delivered: Promise.resolve(), redact: heldRedactor((text) => text),
  });
  await assert.rejects(loop.start(claim), /the store is gone/);
  assert.equal(await within(loop.stop({ kind: "command", commandId: 1 }), 5_000), undefined, "the stop ends at once");
  assert.deepEqual(await within(loop.command({ kind: "approve" }), 5_000), { later: "the run's process is not running" }, "the command finds no process");
});
