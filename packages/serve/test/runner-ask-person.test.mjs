// ask_person on the runner's pi line. On main ask_person is pi's own native tool (tools.ts installTool -> defineExtension):
// calling it returns control.terminate, so pi ends the turn and the run parks on the person's question (input_required).
// The runner builds the session's tools itself (adapter-run-spec.ts), so it must bind ask_person too AND keep its terminate
// native, so the turn ends and the loop parks the run instead of it completing with no question. pi only: CLI harnesses
// refuse ask_person (runnable.ts, not in REPLAY).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { specFor, toolNames } from "./runner-spec-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The gateway's answer: when the request offers ask_person and carries no tool result yet, the model calls it. If the run
 *  parks on the call (the turn ends), the model is never asked again; if it does not park, the model gets the call's result
 *  and is asked once more, where it says nothing and the run ends — so a completed run means the park was dropped. */
const driveAsk = ({ body }) => {
  const toolNames = (body?.tools ?? []).map((tool) => tool?.name);
  const hasResult = (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
  if (toolNames.includes("ask_person") && !hasResult) return { name: "ask_person", input: { question: "Which region should I pick?" } };
  return undefined;
};

/** A pi run granted `tools`, through the runner's adapter loop; its model calls ask_person once. Settles to its park or end. */
async function askRun(t, { tools }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-ask-person-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: driveAsk });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Asks" }, { id: "rev-1", kind: "agentic", body: { instructions: "Ask the person.", tools } });
  const launch = { input: { content: "Pick a region." }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: "claude-sonnet-4-5", provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["parked", "ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's park or end", 12_000);
  return { row, server, store, dir, gw };
}

test("a pi run granted ask_person binds it on the runner's session", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["ask_person"] } });
  assert.ok(toolNames(spec).includes("ask_person"), `ask_person is bound on the runner's session tools: ${JSON.stringify(toolNames(spec))}`);
});

test("a pi run that calls ask_person parks on the person's question (the claim released), never completes", async (t) => {
  const { row } = await askRun(t, { tools: ["ask_person"] });
  assert.equal(row.state, "parked", `the run parks on ask_person, never completes with no question: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
});
