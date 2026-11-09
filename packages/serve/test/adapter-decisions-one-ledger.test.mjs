// A run on the adapter loop books its decisions on the run's one cap (the kernel's runCap, built by the loop from the run's
// own sessions): the loop hands its tool host the run's decisions and its proxied models at open (AdapterRunSpec.ledger),
// as main's process gives a learned workflow both. A decision is judged with the run's model spend beside its own, and one
// past the cap is refused before it runs, its figures the run's (main's holdPaid).
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
const cap = await import("../../run-adapters/dist/kernel/cap/index.js");
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** A decision model whose hold is its input alone: $1 a million input tokens, its output free. */
const DECIDER = { id: "decider", api: "openrouter", price: { input: 1, output: 0 }, outputCeiling: null };
const decision = (id, usd) => ({ kind: "decision", id, model: DECIDER, inputTokens: Math.round(usd * 1e6), questions: 1 });
/** The run's own model, priced: its requests here are small, and the scripted origin charges nothing. */
const SONNET = { id: MODEL, api: "anthropic-messages", price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000 };
const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

test("a pi run's decisions book on the run's one cap: the second, past the cap, is refused before it runs with the run's model and decision spend together", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-decisions-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Decides" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  // The run's model spend so far, on its journal: one request answered at $0.60.
  const seed = await store.claim("run-1", "seed", { leaseMs: 30_000 });
  const harness = await Harness.open(store.journal(seed), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const earlier = await journalSessions(harness, ctx, store).open("earlier");
  await earlier.append([{ kind: "runner.request", data: { turn: 1, model: MODEL, heldUsd: 0.9 } }, { kind: "runner.turn", data: { turn: 1, usd: 0.6, bookedUsd: 0.6 } }]);
  await harness.close(ctx);
  await store.release(seed);

  /** What the loop hands the spec builder on the run, before it binds its tools (AdapterRun.ledger). */
  let handed;
  const outcomes = [];
  const decide = {
    name: "decide",
    replaySafe: false,
    run: async () => {
      const decisions = handed?.decisions;
      if (!decisions) return (outcomes.push("the loop handed no decisions"), "none");
      await decisions.admit(decision("d1", 0.25));
      await decisions.settle("d1", { end: "charged", usd: 0.25 });
      outcomes.push(await decisions.admit(decision("d2", 0.3)).then(() => "admitted", (error) => error));
      return "decided";
    },
  };
  const spec = piAdapterSpec({ script: [{ call: "decide" }, { say: "done" }], tools: { decide }, hooks: quiet });
  const loop = createAdapterLoop(async (claim, run) => ((handed = run.ledger), { ...(await spec(claim, run)), runCap: { capUsd: () => 1, modelOf: () => SONNET } }), { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state !== "queued" && row.state !== "running" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}; ${JSON.stringify(outcomes)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(typeof handed?.models, "function", "the loop hands the run's proxied models with its decisions");
  const refused = outcomes[0];
  assert.ok(refused instanceof Error && refused.name === "CapRefused", `the second decision is refused for room: ${String(refused)}`);
  near(refused.figures?.spentUsd, 0.85, "spent: the run's $0.60 of model spend and its first decision's $0.25");
  near(refused.figures?.needsUsd, 0.3, "needs: the decision's hold");
  near(refused.figures?.leastCapUsd, cap.raiseFigure(1, 1.15), "the least cap that sends it");
});

test("a paid charge booked outside any tool call (a browser session's release at a relaunch, from the host's beforeResume) lands on the run's one ledger, handed on the run before its tools are bound", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-release-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Releases" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const { paidStep } = await import("../dist/paid-calls.js");
  const said = [];
  const spec = piAdapterSpec({ script: [{ say: "done" }], tools: {}, hooks: quiet });
  const loop = createAdapterLoop(async (claim, run) => {
    // The spec builder binds the browser's money to the run's paid booking it is handed (ToolHost.paid), as browserSpend
    // captures it at its bind: a session's release at a relaunch (the host's beforeResume, its Harness open and nothing
    // resumed yet) comes outside any tool call.
    const paid = run.ledger?.paid;
    const beforeResume = [async () => {
      if (!paid) return void said.push("the run handed no paid booking");
      const stepped = await paidStep(paid, "s1@release", { name: "this browser session's time", holdUsd: 0, basis: "billed as it was charged" }, async () => undefined, () => 0.0014);
      if ("refused" in stepped) said.push(`refused: ${stepped.refused}`);
      said.push(paid.spentUsd());
    }];
    return { ...(await spec(claim, run)), runCap: { capUsd: () => 1, modelOf: () => SONNET }, lifecycle: { onConversation: [], beforeResume, beforeRelease: [] } };
  }, { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state !== "queued" && row.state !== "running" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}; ${JSON.stringify(said)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Its booking is awaited, bounded.
  for (const until = Date.now() + 5_000; said.length === 0 && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(said.length >= 1 ? typeof said.at(-1) : "nothing", "number", `the release's charge was booked on the run's paid ledger: ${JSON.stringify(said)}`);
  near(said.at(-1), 0.0014, `the run's paid calls after the release (${JSON.stringify(said)})`);
});
