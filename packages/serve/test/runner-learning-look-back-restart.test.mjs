// A CLI run's look-back cut by a lost runner, and asked again on the next claim (the CLI harness's end-of-run turn: no
// submission until its turn ends, so a turn sent and unfinished is asked again). What the earlier attempt spent is kept:
// a request it sent with no answer is booked once at an unknown price, one it answered at its price, and the job's own
// cost and when it answered are what they were when the turn was first asked, never moved into the job by the restart.
// So the run's look-back reads the earlier attempt's spend (unknown when a cut made it unknown), never only the re-ask's.
// The faux CLI harness (fixtures/faux-harness.mjs "Look back, ...") on the runner's dispatch, as runner-cli-booking.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const HARNESS = "codex";
const REFLECT = /Answer with one block per note to keep\./;

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A learning CLI run of the faux harness told `instructions` (its launch with `launch` too), on a store in a fresh
 *  folder: its runners, started by name, and what its session and learning hold once it ended (`read`). */
async function learningRun(t, instructions, launchExtra = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-learning-look-back-restart-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const stores = [];
  const runners = [];
  let reader;
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    await reader?.close(ctx).catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: instructions(dir), harness: HARNESS, tools: ["read"], learning: true } });
  const seed = await landWorkflows(dir, "agent-1", []);
  const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness: HARNESS, model: { provider: "openai", modelId: "gpt-test" }, learning: startAt(seed), ...launchExtra };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: "not-a-secret", AGENT_MODEL_PRICE: "1,2,0.5", AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  const start = async (name) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
    const runner = startRunner({
      store, name, ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
      createLoop: createDispatchLoop({
        launchOf: (runId) => store.runs.launch(runId),
        resolve: (harness, given) => (harness === HARNESS ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
      }),
    });
    runners.push(runner);
    return runner;
  };
  /** The run's end after `since` (its endedAt), with no runner holding it. */
  const ended = (since = 0) => until(async () => {
    const now = await server.runs.get(RUN);
    return (now.endedAt ?? 0) > since && ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  const read = async (row) => {
    reader = await Harness.open(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
    const sessions = journalSessions(reader, ctx, server);
    const all = [];
    for (const key of await sessions.keys()) for (const record of await sessions.read(key)) all.push(record);
    const requests = all.filter((record) => record.kind === "runner.request").map((record) => record.data);
    const turns = all.filter((record) => record.kind === "runner.turn").map((record) => record.data);
    const sent = all.filter((record) => record.kind === "faux.user").map((record) => record.data.text);
    const kept = await server.learning.proposal(RUN);
    const timeline = (await runTimeline(server, RUN, ctx)).map((one) => [one.kind, one.text ?? one.summary ?? one.tool_name]);
    return { requests, turns, sent, kept, timeline };
  };
  return { dir, server, start, ended, read };
}

/** A learning CLI run of the faux harness whose end-of-run turn (`how`: cut, or answered then held) holds on runner-a
 *  until runner-a is closed (the claim lost mid look-back), then runs on runner-b. Its session's booked requests and
 *  turns, the prompts its CLI was sent, its kept learning, and when runner-b started. */
async function restarted(t, how, launchExtra = {}) {
  const { dir, server, start, ended, read } = await learningRun(t, (at) => `Look back, ${how} and held until ${join(at, "go")} (signal ${join(at, "held")}).`, launchExtra);
  const a = await start("runner-a");
  // The end-of-run turn holds on runner-a (its request admitted and unanswered, or answered and the turn held after it).
  await until(() => existsSync(join(dir, "held")), "runner-a's end-of-run turn holds");
  await a.close();
  const lost = await server.runs.get(RUN);
  assert.notEqual(lost.state, "ended", `runner-a wrote no end: ${JSON.stringify(lost)}`);
  writeFileSync(join(dir, "go"), "");
  const restartedAt = Date.now();
  await start("runner-b");
  const row = await ended();
  return { row, ...(await read(row)), restartedAt };
}

/** The paid look-back asks across both claims: the CLI's turns sent the end-of-run prompt, and any request booked at
 *  the faux harness's "asked twice" price ($0.016: a turn after the look-back's own). */
const asks = (sent, turns) => ({ prompts: sent.filter((text) => REFLECT.test(text)).length, twice: turns.filter((turn) => turn.usd === 0.016).length });

test("a CLI look-back whose request a lost runner cut: booked once at an unknown price, asked again once on the next claim, and the job's cost stays the job's", { timeout: 120_000 }, async (t) => {
  const { row, requests, turns, sent, kept } = await restarted(t, "cut");
  assert.equal(row.state, "ended", JSON.stringify(row));
  // The job's two requests, the cut one, and the re-ask's answer and end: each booked once.
  assert.deepEqual(asks(sent, turns), { prompts: 2, twice: 0 }, `sent once on each claim, the open turn never answered as the job's: ${JSON.stringify(turns)}`);
  assert.equal(requests.length, 5, JSON.stringify(requests));
  assert.deepEqual(turns.map((turn) => turn.turn).sort(), requests.map((request) => request.turn).sort(), `each request booked once: ${JSON.stringify(turns)}`);
  assert.equal(turns.filter((turn) => turn.usd === null).length, 1, `the cut request is booked once, at an unknown price: ${JSON.stringify(turns)}`);
  const proposal = kept?.proposal;
  assert.deepEqual([proposal?.state, proposal?.reason], ["dropped", "empty"], `the re-ask's answer is the one read: ${JSON.stringify(proposal)}`);
  assert.equal(proposal.job_cost_usd, 0.002, `the job's own cost, as it stood when the turn was first asked: ${JSON.stringify(proposal)}`);
  assert.equal(proposal.look_back_usd, null, `the look-back spent what no one knows (its cut request): ${JSON.stringify(proposal)}`);
});

test("a CLI look-back answered and then cut by a lost runner: asked again once on the next claim; the look-back reads both attempts' spend, the job only its own", { timeout: 120_000 }, async (t) => {
  const { row, requests, turns, sent, kept, restartedAt } = await restarted(t, "answered");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(asks(sent, turns), { prompts: 2, twice: 0 }, `sent once on each claim, the open turn never answered as the job's: ${JSON.stringify(turns)}`);
  assert.equal(requests.length, 5, JSON.stringify(requests));
  assert.ok(turns.every((turn) => typeof turn.usd === "number"), JSON.stringify(turns));
  const proposal = kept?.proposal;
  assert.deepEqual([proposal?.state, proposal?.reason], ["dropped", "empty"], `the re-ask's answer is the one read: ${JSON.stringify(proposal)}`);
  assert.equal(proposal.job_cost_usd, 0.002, `the job's own cost, never the earlier attempt's look-back: ${JSON.stringify(proposal)}`);
  assert.ok(Date.parse(proposal.answered_at) < restartedAt, `when the job answered is runner-a's, before the restart: ${JSON.stringify(proposal)}`);
  assert.equal(proposal.look_back_usd, 0.013, `both attempts' look-back spend ($0.004, then $0.008 + $0.001): ${JSON.stringify(proposal)}`);
});

test("a CLI look-back a lost runner cut under a cap: the next claim skips it (the run's spend unknown), and still keeps the job's cost and answer time from the first ask, its look-back unknown, never $0", { timeout: 120_000 }, async (t) => {
  const { row, turns, sent, kept, restartedAt } = await restarted(t, "cut", { max_cost_usd: 1 });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(asks(sent, turns), { prompts: 1, twice: 0 }, `sent once, on runner-a; runner-b asks nothing: ${JSON.stringify(turns)}`);
  const proposal = kept?.proposal;
  assert.deepEqual([proposal?.state, proposal?.reason], ["dropped", "unknown_cost"], JSON.stringify(proposal));
  assert.equal(proposal.job_cost_usd, 0.002, `the job's own cost, as it stood when the turn was first asked: ${JSON.stringify(proposal)}`);
  assert.ok(Date.parse(proposal.answered_at) < restartedAt, `when the job answered is runner-a's, before the restart: ${JSON.stringify(proposal)}`);
  assert.equal(proposal.look_back_usd, null, `the look-back spent what no one knows (its cut request), never nothing: ${JSON.stringify(proposal)}`);
});

test("a CLI run stopped while looking back, then followed up and its runner lost in the follow-up's turn: the next claim recovers the follow-up, never settles it as that old look-back", { timeout: 180_000 }, async (t) => {
  const { dir, server, start, ended, read } = await learningRun(t, (at) => `Look back, stopped, then a follow-up held until ${join(at, "go")} (signal ${join(at, "held")}).`);
  const held = join(dir, "held");
  const a = await start("runner-a");
  // Round 1's look-back holds; the person stops the run there: its prompt is on the record, with no submission.
  await until(() => existsSync(held), "runner-a's end-of-run turn holds");
  rmSync(held);
  await server.command(RUN, { kind: "stop" });
  const stopped = await ended();
  assert.equal(stopped.state, "stopped", JSON.stringify(stopped));
  // The follow-up reopens the run; its turn holds; its runner is lost there.
  await server.runs.reopen(RUN, { kind: "steer", body: { text: "And once more?" } });
  await server.flush?.();
  await until(() => existsSync(held), "the follow-up's turn holds on runner-a");
  await a.close();
  writeFileSync(join(dir, "go"), "");
  await start("runner-b");
  const row = await ended(stopped.endedAt ?? 0);
  const { timeline, sent } = await read(row);
  assert.equal(row.state, "ended", `${JSON.stringify(row)} ${JSON.stringify(timeline)}`);
  const answers = timeline.filter(([kind]) => kind === "final_answer").map(([, text]) => text);
  assert.ok(answers.includes("Followed."), `the follow-up's turn was recovered and answered as the job's: ${JSON.stringify(timeline)}`);
  assert.equal(sent.filter((text) => REFLECT.test(text)).length, 2, `round 1's look-back, stopped, and round 2's after the follow-up, each sent once: ${JSON.stringify(sent)}`);
});
