// ask_person on the runner's pi line. On main ask_person is pi's own native tool (tools.ts installTool -> defineExtension):
// calling it returns control.terminate, so pi ends the turn and the run parks on the person's question (input_required).
// The runner carries it the same way, as a pi-native extension on the root agent (adapter-run-spec.ts, through the pi
// adapter's PiAdapterOptions.extensions, which both offers and runs it), so pi keeps its terminate; the loop reads that
// turn end (endedOnTurnEndingTool) and commits the run parked on a KINDS.personAsked entry, never ending it. A person's
// message resumes it as the next user turn. pi only: CLI harnesses refuse ask_person (runnable.ts, not in REPLAY).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { blockersOf } = await import("../dist/runnable.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const QUESTION = "Which region should I pick?";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const VIEW_DEPS = { origin: "https://run.test", serverSecrets: () => [] };

const until = async (done, what, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const modelCalls = (gw) => gw.requests.filter((r) => r.path.endsWith("/messages"));

/** The gateway's answer: on a request offering ask_person with no tool result yet (the first turn), the model calls it;
 *  once its result is in (the resume turn, pi replays the prior turn), the model has nothing to ask and says "done". */
const driveAsk = ({ body }) => {
  const toolNames = (body?.tools ?? []).map((tool) => tool?.name);
  const hasResult = (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
  if (toolNames.includes("ask_person") && !hasResult) return { name: "ask_person", input: { question: QUESTION } };
  return undefined;
};

/** A pi run granted `tools`, through the runner's adapter loop; its model calls ask_person once. Settles to its park (or,
 *  with `settled`, to what that reads). `personWait`: a tool host's hold the spec's lifecycle carries (HostLifecycle
 *  .personWait), as the browser's is. The runner stays up so a test may resume it; its store, server and gateway are
 *  returned. */
async function askRun(t, { tools, personWait, settled }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-ask-person-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: driveAsk, text: "done" });
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
  const specOf = async (claim, run) => {
    const spec = await adapterRunSpecFromLaunch(launch, run, deps, claim);
    return personWait ? { ...spec, lifecycle: { ...spec.lifecycle, personWait: [personWait] } } : spec;
  };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const row = await until(settled ? () => settled(server) : async () => {
    const now = await server.runs.get(RUN);
    return ["parked", "ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's park or end");
  return { row, server, store, gw };
}

test("park: a pi run that calls ask_person parks on its question, input_required with the question pending, claim released, one request and no re-run", async (t) => {
  const { row, server, gw } = await askRun(t, { tools: ["ask_person"] });
  assert.equal(row.state, "parked", `the run parks on ask_person, never completes with no question: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.equal(row.runner, null, "the claim is released");
  // One model request: the turn ended on the ask, and the parked run is not claimed again with nothing to answer (the
  // re-claim-stays-parked case — before the state was committed the run looped, re-running the turn every poll).
  assert.equal(modelCalls(gw).length, 1, `one request, the run parked and was never re-run: ${modelCalls(gw).length}`);
  const view = await viewOverStore(server, RUN, VIEW_DEPS);
  assert.equal(view.status, "input_required", `the view reads input_required: ${JSON.stringify(view.status)}`);
  assert.equal(view.state, "waiting", `waiting on the person: ${JSON.stringify(view.state)}`);
  assert.equal(view.pending?.kind, "question", `a question is pending: ${JSON.stringify(view.pending)}`);
  assert.equal(view.pending?.question, QUESTION, `the question is the model's, read through the cut: ${JSON.stringify(view.pending)}`);
  assert.ok(!(row.summary ?? "").includes(QUESTION), `the run row never copies the question text: ${JSON.stringify(row.summary)}`);
});

test("resume: the person's message resumes the parked run as its next user turn, and nothing is re-asked", async (t) => {
  const { row, server, gw } = await askRun(t, { tools: ["ask_person"] });
  assert.equal(row.state, "parked");
  const before = modelCalls(gw).length;
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  const ended = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the person's message resumes and ends the run");
  assert.equal(ended.state, "ended", `the reply resumed the run to its end: ${JSON.stringify(ended)}`);
  const after = modelCalls(gw);
  assert.ok(after.length > before, `the resume ran a new turn: ${before} -> ${after.length}`);
  const last = after[after.length - 1].body;
  assert.ok((last.messages ?? []).some((message) => JSON.stringify(message.content ?? message).includes("us-west-2")), "the person's message is the resume's user turn");
  // ask_person was asked exactly once across the whole run: the resume did not re-ask, so the question is not billed twice.
  const asks = after.flatMap((call) => (call.body?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block?.type === "tool_use" && block?.name === "ask_person"));
  assert.equal(asks.length, 1, `ask_person was asked once, never re-asked on the resume: ${asks.length}`);
});

test("CLI refused: a CLI-harness run that names ask_person is refused in main's words, never bound", async () => {
  const blockers = await blockersOf({}, { kind: "agentic", instructions: "Ask the person.", tools: ["ask_person"], harness: "codex", model: "gpt-5" });
  const ask = blockers.find((blocker) => blocker.tool === "ask_person");
  assert.ok(ask, `ask_person is refused on a CLI harness: ${JSON.stringify(blockers)}`);
  assert.match(ask.message, /runs on pi here/, `refused in main's words: ${JSON.stringify(ask)}`);
});

/** A tool host's hold for the wait in the claim (HostLifecycle.personWait), as the browser's is: what it was asked, how
 *  often it was dropped, and its lapse, for the test to fire. `holds: false` holds nothing (undefined), as with no browser. */
function fakeWait({ holds = true } = {}) {
  const seen = { asked: [], dropped: 0 };
  let lapse = () => {};
  const lapsed = new Promise((resolve) => (lapse = resolve));
  const personWait = async (_harness, callId) => {
    seen.asked.push(callId);
    return holds ? { lapsed, drop: () => void (seen.dropped += 1) } : undefined;
  };
  return { seen, personWait, lapse: (words) => lapse(words) };
}
/** The run waits in its claim: running, a runner holding it, and the host asked for its hold. */
const waitingInClaim = (seen) => async (server) => {
  const now = await server.runs.get(RUN);
  return now.state === "running" && now.runner !== null && seen.asked.length > 0 && now;
};

test("wait in the claim: a tool host that holds for the wait keeps the run claimed and input_required on its question; the person's message is its next turn in the same claim, the hold dropped as it is placed", async (t) => {
  const wait = fakeWait();
  const { row, server, gw } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen) });
  assert.equal(row.state, "running", "never parked");
  assert.equal(wait.seen.asked.length, 1, "the host was asked once, for the ask_person call");
  const view = await viewOverStore(server, RUN, VIEW_DEPS);
  assert.equal(view.status, "input_required", `the view reads input_required while the run waits in its claim: ${JSON.stringify(view.status)}`);
  assert.equal(view.state, "waiting");
  assert.equal(view.pending?.question, QUESTION, JSON.stringify(view.pending));
  assert.equal(wait.seen.dropped, 0, "held while it waits");
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  const ended = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the answer's turn ends the run");
  // The claim's release moves the epoch once: a park and a new claim would have moved it more.
  assert.equal(ended.epoch, row.epoch + 1, "the answer ran in the same claim, never a park and a new claim");
  const { entries } = await journalRecords(server.readJournal(RUN), BACKGROUND_CONTEXT);
  assert.equal(entries.filter((entry) => entry.kind === "agentrun.person.asked").length, 0, "no park entry was written");
  assert.ok(wait.seen.dropped >= 1, "the hold was dropped");
  const last = modelCalls(gw).at(-1).body;
  assert.ok((last.messages ?? []).some((message) => JSON.stringify(message.content ?? message).includes("us-west-2")), "the person's message is the next user turn");
  const asks = modelCalls(gw).flatMap((call) => (call.body?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block?.type === "tool_use" && block?.name === "ask_person"));
  assert.equal(asks.length, 1, `ask_person was asked once: ${asks.length}`);
});

test("wait in the claim: a hold that lapses before the answer (the cap refused more of the person's time, or the browser went) parks the run on its question, and the answer resumes it from the park", async (t) => {
  const wait = fakeWait();
  const { server } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen) });
  wait.lapse("spend_cap_reached: no room for more of your time");
  const parked = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "parked" && now.runner === null && now;
  }, "the lapsed wait parks the run");
  assert.equal(parked.state, "parked");
  assert.ok(wait.seen.dropped >= 1, "the hold was dropped");
  const view = await viewOverStore(server, RUN, VIEW_DEPS);
  assert.equal(view.status, "input_required");
  assert.equal(view.pending?.question, QUESTION, JSON.stringify(view.pending));
  await sendCommand(server, RUN, { kind: "steer", body: { text: "us-west-2" } });
  await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "ended" && now.runner === null && now;
  }, "the answer resumes it from the park");
});

test("wait in the claim: a stop while the run waits ends it stopped, and the hold is dropped", async (t) => {
  const wait = fakeWait();
  const { server } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait, settled: waitingInClaim(wait.seen) });
  await sendCommand(server, RUN, { kind: "stop", body: {} });
  const stopped = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "stopped" && now.runner === null && now;
  }, "the stop ends the waiting run");
  assert.equal(stopped.state, "stopped");
  assert.ok(wait.seen.dropped >= 1, "the hold was dropped");
});

test("wait in the claim: a host that holds nothing (no browser session open) leaves the park as it was", async (t) => {
  const wait = fakeWait({ holds: false });
  const { row } = await askRun(t, { tools: ["ask_person"], personWait: wait.personWait });
  assert.equal(row.state, "parked", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.equal(wait.seen.asked.length, 1, "the host was asked");
});
