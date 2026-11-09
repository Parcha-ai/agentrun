// The run's one booking on the adapter loop: the host's check before a paid request (the spec's beforeRequest, the spend
// cap's beforeRequestOf) is asked with the run's totals, every session of the run summed (runBooking over the run's
// journal sessions), never its own session's alone. A run whose earlier session spent $0.60 asks its first request of
// a new session with $0.60 spent.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { closeOpenSessions, MODEL, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
// A lease no stall of a loaded machine outlasts: a claim lost mid-request would be retaken and the request asked again,
// which these money checks do not read. The runs end themselves, so nothing here waits on the lease.
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

test("the adapter loop asks the host's check with the run's spend: an earlier session's $0.60 is in the first request's spentUsd", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-run-booking-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Booking" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });

  // An earlier claim's session, on the run's journal: one request answered at $0.60.
  const seed = await store.claim("run-1", "seed", { leaseMs: 30_000 });
  const harness = await Harness.open(store.journal(seed), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const earlier = await journalSessions(harness, ctx, store).open("earlier");
  await earlier.append([{ kind: "runner.request", data: { turn: 1, model: MODEL, heldUsd: 0.9 } }, { kind: "runner.turn", data: { turn: 1, usd: 0.6, bookedUsd: 0.6 } }]);
  await harness.close(ctx);
  await store.release(seed);

  const asked = [];
  const spec = piAdapterSpec({ script: [{ say: "done" }], tools: {}, hooks: quiet });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), beforeRequest: (request) => void asked.push(request.spentUsd) }), { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}; asked ${JSON.stringify(asked)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(asked.length >= 1, "the host was asked");
  assert.ok(Math.abs(asked[0] - 0.6) < 1e-12, `the first request is asked with the run's $0.60: ${JSON.stringify(asked)}`);
});
