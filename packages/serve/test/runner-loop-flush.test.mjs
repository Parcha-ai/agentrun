// The kernel's rule on a pi run through the adapter (runner/side-effects.ts, on the host-tool path): a call that is not replay-safe runs only after a flush made its
// intent durable (pi committed it, at synchronous=NORMAL not yet on disk); a replay-safe call runs without one. Read from
// the order the loop's flush and the tool itself happen in, on a real store and runner.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { after } from "node:test";
import { closeOpenSessions, piAdapterSpec, piAdapterSubject, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { STEADY_LEASE } from "./runner-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");

after(closeOpenSessions);
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
// A lease no stall of a loaded machine outlasts: a claim is lost only where a case loses it (its runner killed, the
// stores' clock moved past its claim), never to the box's load. The runs end themselves, so nothing here waits on the lease.
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };

/** The bound on a wait for the run's own event: it caps the wait, it never orders anything. */
const EVENT_WAIT_MS = 30_000;

/** `fetch` (the provider's, behind pi's session proxy) whose first model request never answers: `out` resolves as it
 *  goes, and it fails only when its signal aborts. The runner that sent it is lost there, its request out. */
const lostAtFirst = (fetch, out) => {
  let first = true;
  return (url, init = {}) => {
    if (!first) return fetch(url, init);
    first = false;
    out();
    return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true }));
  };
};

async function order(t, tool, { lost = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-loop-flush-"));
  // The stores' clock, which the test moves past a lost runner's claim: the next runner takes the run with nothing waited out.
  const skew = { ms: 0 };
  const now = () => Date.now() + skew.ms;
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const stores = [await openSqliteStore({ dataDir: dir, role: "runner", now }), await openSqliteStore({ dataDir: dir, role: "runner", now })];
  const runners = [];
  t.after(async () => {
    await Promise.all(runners.map((runner) => runner.close()));
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flush" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const seen = [];
  const run = async () => (seen.push(tool), `${tool} ran`);
  const tools = {
    effect: { name: "effect", replaySafe: false, ask: false, run },
    read: { name: "read", replaySafe: true, ask: false, run },
  };
  const script = [{ call: tool }, { say: "done" }];
  let out = () => {};
  const firstOut = new Promise((resolve) => (out = resolve));
  const inner = lost
    ? createAdapterLoop(piAdapterSpec({ script, tools, hooks: quiet }, { fetch: lostAtFirst(scriptedOrigin(script), () => (seen.push("request lost"), out())) }))
    : piAdapterSubject.createLoop({ script, tools, hooks: quiet });
  const createLoop = (deps) => inner({ ...deps, flush: async () => (seen.push("flush"), deps.flush()) });
  runners.push(startRunner({ store: stores[0], createLoop, name: "runner-a", ...TIMING }));
  if (lost) {
    await bounded(firstOut, "the first runner's first model request goes out");
    runners[0].kill();
    skew.ms = TIMING.leaseMs * 2;
    runners.push(startRunner({ store: stores[1], createLoop, name: "runner-b", ...TIMING }));
  }
  const deadline = Date.now() + EVENT_WAIT_MS;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`not within ${EVENT_WAIT_MS} ms: the run ends (${JSON.stringify(row)})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return seen;
}

/** `event`, or a failure naming `what` once EVENT_WAIT_MS passes without it. */
async function bounded(event, what) {
  let timer;
  try {
    return await Promise.race([event, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`not within ${EVENT_WAIT_MS} ms: ${what}`)), EVENT_WAIT_MS)))]);
  } finally {
    clearTimeout(timer);
  }
}

// Both runs make the same model requests, each after a flush of its own (runner-loop-model-flush), so the call's own
// flush is the difference between them: one more for the effect, right before it; none for the read.
test("a call that is not replay-safe runs after a flush; a replay-safe one runs without", async (t) => {
  const effect = await order(t, "effect");
  const read = await order(t, "read");
  const flushes = (seen) => seen.filter((what) => what === "flush").length;
  assert.equal(effect[effect.indexOf("effect") - 1], "flush", `the effect waited for its intent to be durable: ${JSON.stringify(effect)}`);
  assert.equal(flushes(effect), flushes(read) + 1, `the replay-safe read needed no flush of its own: ${JSON.stringify({ effect, read })}`);
});

// The same rule across a claim lost while the first model request is out (CI's 4-for-3): the runner is lost there, its
// claim run out on the stores' clock, and the next runner takes the run, asks that request again and calls the effect:
// the effect runs once, after a flush of its own.
test("the call's flush rule reads the same when the runner is lost while the effect run's first model request is out, and the next claim goes on", async (t) => {
  const effect = await order(t, "effect", { lost: true });
  assert.ok(effect.indexOf("request lost") >= 0, `the first runner was lost with its request out: ${JSON.stringify(effect)}`);
  assert.equal(effect.filter((what) => what === "effect").length, 1, `the effect ran once: ${JSON.stringify(effect)}`);
  assert.equal(effect[effect.indexOf("effect") - 1], "flush", `the effect waited for its intent to be durable: ${JSON.stringify(effect)}`);
});
