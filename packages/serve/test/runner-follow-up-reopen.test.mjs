// A person's follow-up to a completed agentic run continues its conversation, as main does: the store reopens it with the
// follow-up's steer (runs.reopen), and the runner, at its claim, opens the run's Harness after the end it sealed and runs
// the message as a new turn. The new turn answers, the run ends again with that answer, the first turn's answer is kept,
// and the timeline shows both turns (the first turn's rows and answer before the new turn's). Its money goes on: after the
// second turn the run's cost is both turns' (its end reads all its spend, never the new turn's alone), and a run that
// reached its cap in its first turn, reopened, parks for a raise instead of running. Its second end is an end of its own:
// a new ended_at, which a webhook's or a notice's run.ended marker is, so it is told again.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
after(closeOpenSessions);

const RUN = "run-1";
/** What each model request costs on the route. */
const PER_REQUEST = 0.1;
/** The model's price table on the route, which the cap judges a request by before it is sent (an unpriced model is never
 *  sent under a cap): no input cost, and $50 per million output tokens up to an 1,000-token ceiling, so each request is
 *  held at $0.05 before it goes and booked at PER_REQUEST once answered. */
const COST = { input: 0, output: 50, cacheRead: 0, cacheWrite: 0 };
const OUTPUT_CEILING = 1_000;
/** A cap the first turn fits under (held $0.05, booked $0.10) and the reopened turn does not ($0.10 spent + $0.05 held). */
const ONE_TURN_CAP = 0.12;

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A pi run through the runner, its model answering "First answer." then "Second answer.", and its launch's cap
 *  `capUsd`; the stores, the runner and what the model was asked. */
async function runner(t, capUsd) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-follow-up-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly." } });
  const launch = { input: { content: "First question." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, max_cost_usd: capUsd };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const requests = [];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `routecredential${"r".repeat(12)}` }, fetch: scriptedOrigin([{ say: "First answer." }, { say: "Second answer." }], requests), price: () => PER_REQUEST, cost: COST, outputCeiling: OUTPUT_CEILING };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7), routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  const running = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => running.close().catch(() => {}));
  return { server, requests };
}

/** The run's row once it has left running with no runner holding it. */
const settled = (server) => until(async () => {
  const row = await server.runs.get(RUN);
  return ["ended", "failed", "stopped", "parked"].includes(row.state) && row.runner === null && row;
}, "the run settles");

test("a follow-up to a completed run runs as a new turn: it answers, the run ends again with that answer, the first answer is kept, the timeline shows both turns, and its cost is both turns'", { timeout: 120_000 }, async (t) => {
  const { server, requests } = await runner(t, 5);
  const first = await settled(server);
  assert.equal(first.state, "ended", JSON.stringify(first));
  assert.equal(requests.length, 1, "the first turn asked the model once");

  await server.runs.reopen(RUN, { kind: "steer", body: { text: "Second question." } });
  const second = await until(async () => {
    const row = await server.runs.get(RUN);
    return row.state === "ended" && row.runner === null && row.endedAt !== null && row;
  }, "the run ends again", 60_000);
  assert.equal(requests.length, 2, `the follow-up was asked of the model as a new turn: ${requests.length} requests`);
  // A new end, its own time: a webhook's and a notice's run.ended marker is the end's ended_at, so the second end is told.
  assert.ok(first.endedAt !== null && second.endedAt !== null && second.endedAt > first.endedAt, `the second end has its own ended_at: ${first.endedAt} then ${second.endedAt}`);
  const asked = JSON.stringify(requests[1].messages);
  assert.ok(asked.includes("First answer.") && asked.includes("Second question."), `the new turn carries the conversation and the follow-up: ${asked.slice(0, 400)}`);
  assert.ok(Math.abs((second.costUsd ?? 0) - 2 * PER_REQUEST) < 1e-9, `the run's cost is both turns': ${second.costUsd}`);
  const commands = await server.commands(RUN, 0);
  assert.ok(commands.every((row) => row.takenAt !== null && row.refused === null), `the follow-up was taken, not refused: ${JSON.stringify(commands)}`);

  const rows = await runTimeline(server, RUN, context, { settled: true });
  const said = rows.map((row) => `${row.kind}:${row.text ?? row.summary ?? ""}`).join("\n");
  for (const text of ["First question.", "First answer.", "Second question.", "Second answer."]) assert.ok(said.includes(text), `the timeline shows "${text}":\n${said}`);
  assert.ok(said.indexOf("First answer.") < said.indexOf("Second question.") && said.indexOf("Second question.") < said.indexOf("Second answer."), `in order:\n${said}`);
});

test("a run that reached its cap in its first turn, reopened, parks for a raise: the cap judges the follow-up on what the run already spent", { timeout: 120_000 }, async (t) => {
  const { server, requests } = await runner(t, ONE_TURN_CAP);
  const first = await settled(server);
  assert.equal(first.state, "ended", JSON.stringify(first));
  await server.runs.reopen(RUN, { kind: "steer", body: { text: "Second question." } });
  const after_ = await until(async () => {
    const row = await server.runs.get(RUN);
    return row.state === "parked" && row.runner === null && row;
  }, "the reopened run parks at its cap", 60_000);
  assert.equal(after_.state, "parked");
  assert.equal(requests.length, 1, "the follow-up was not sent past the cap");
});
