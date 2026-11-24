// A capped pi run that answered and was in its end-of-run compile turn (request ids learn-reflect-<run>…) when its
// runner lost the claim: the request out at the loss is booked cut at its hold. The claim that takes the run over must
// not run that open compile turn as the job's turn: told to finish in the cap's words, refused, then parked for a raise
// (input_required) on spend that was only ever learning's. One rule: the run's status comes from how the job's own turn
// ended. Learning spend that leaves the cap no room is the learning's: dropped in the reason the learning code keeps for
// the cap (no_budget), the spend still booked; never a budget pause, a wrap-up note in the compile turn, or a run failed
// over its cap.
// pi through the adapter loop (conformance-pi-adapter.mjs) on the end-of-run step, runners on one store whose clock the
// case moves past each lost claim (adapter-pi-cap-raise-crash.test.mjs's way).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { cap, quiet, rootEntries, SONNET, sleep, STEADY } from "./adapter-pi-cap-support.mjs";

after(closeOpenSessions);

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { createReflectHook } = await import("../dist/runner/reflect-hook.js");
const { seedOf } = await import("../dist/learning.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");

const ANSWER = "The job's answer.";
/** Sonnet's list price, the booking's (the cap prices requests the same: SONNET). */
const listPrice = (_model, usage) => (usage.input * 3 + usage.output * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
/** The text of a Messages request's newest user message. */
const lastUserText = (body) => {
  const content = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
};
/** The compile turn's prompt (learn/compile.ts compilePrompt, a new workflow). */
const isCompile = (body) => /Compile the whole job/.test(lastUserText(body));

/** Run-1 under a cap of `capUsd` (the cap's model and mode `runCap`), its learning step `endOfRun`, on one runner after
 *  another: each request `held` matches while losses are left is never answered there, and that runner's claim is lost
 *  (its journal frozen, the runner killed, the store's clock moved past its claim) once it is out; the next runner takes
 *  the run over. The job's turn answers ANSWER; every later request "No change.". Settles at the run's end or park. */
async function lostRun(t, { capUsd, runCap, held, losses, endOfRun }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-learning-claim-lost-"));
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const stores = [];
  const runners = [];
  /** The requests and commits held on a lost runner, each failed at the end; once it ends, one asked fails at once. */
  const hung = [];
  let ending = false;
  const hold = () => (ending ? Promise.reject(new Error("the test ended")) : new Promise((_, reject) => hung.push(reject)));
  t.after(async () => {
    // What the lost runners hold fails first (their held requests, their frozen commits), so their close ends too, and
    // a commit they try while closing fails at once.
    ending = true;
    for (const fail of hung.splice(0)) fail(new Error("the test ended"));
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: [], learning: true } });
  const seed = await seedOf(dir, server, "agent-1");
  const body = { input: { content: "Follow the script." }, title: "t", place: { mode: "runner" }, learning: { seed: seed.sha, section: "" }, max_cost_usd: capUsd };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body });
  const launch = readLaunchBody(body);
  assert.equal(launch?.maxCostUsd, capUsd, "the launch carries the cap the learning step reads");

  const sent = [];
  let left = losses;
  let out = () => {};
  const origin = async (url, init) => {
    const request = JSON.parse(String(init.body ?? "{}"));
    // The script's step is the request's count of assistant messages (scriptedOrigin): the job's answer, then the
    // learning turn's reply.
    const step = (request.messages ?? []).filter((message) => message.role === "assistant").length;
    return scriptedOrigin([{ say: ANSWER }, ...Array.from({ length: step }, () => ({ say: "No change." }))], sent)(url, init);
  };
  const fetch = async (url, init = {}) => {
    const request = JSON.parse(String(init.body ?? "{}"));
    if (left > 0 && held(request)) {
      sent.push(request);
      left -= 1;
      out();
      return new Promise((_, reject) => {
        hung.push(reject);
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return origin(url, init);
  };
  const spec = piAdapterSpec({ script: [], tools: {}, hooks: quiet, agentId: "agent-1" }, { fetch, price: listPrice });
  // A lost runner's journal, frozen at the loss: every commit from then on never returns, so its loop (still alive in this
  // process: a kill stops nothing) writes nothing more, as a dead process's would.
  const frozen = new Set();
  const freezing = (name, journal) => new Proxy(journal, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "commit") return value.bind(target);
      return (...args) => (frozen.has(name) ? hold() : value.apply(target, args));
    },
  });
  const start = async (name) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner", now });
    stores.push(store);
    const job = createAdapterLoop(async (claim, run) => ({
      ...(await spec(claim, run)),
      cap: { capUsd, park: (refusal) => cap.parkOf(refusal, capUsd), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf },
      runCap: { capUsd: () => capUsd, ...runCap },
    }));
    // Run-1 on the adapter loop; any other run it claims is held, never run here.
    const createLoop = (deps) => {
      const loop = job({ ...deps, endOfRun, journal: (claim) => freezing(name, deps.journal(claim)) });
      let mine = false;
      let release;
      const parked = new Promise((resolve) => (release = resolve));
      return {
        start: (claim) => (claim.runId === "run-1" ? ((mine = true), loop.start(claim)) : parked),
        command: (row) => (mine ? loop.command(row) : Promise.resolve({ refused: "not run here" })),
        stop: async (reason) => (mine ? loop.stop(reason) : release({ state: "interrupted" })),
      };
    };
    const runner = startRunner({ store, createLoop, name, ...STEADY });
    runners.push(runner);
    return runner;
  };

  for (let lost = 0; lost < losses; lost++) {
    const name = `runner-${lost + 1}`;
    const going = new Promise((resolve) => (out = resolve));
    const runner = await start(name);
    let timer;
    const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`the held request never went out on ${name}`)), 30_000)));
    await Promise.race([going, late]).finally(() => clearTimeout(timer));
    // The claim lost mid learning: the runner frozen (nothing stopped, flushed or released), its claim run out.
    frozen.add(name);
    runner.kill();
    clock.skewMs += STEADY.leaseMs * 2;
  }
  await start(`runner-${losses + 1}`);
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (row.runner === null && !["running", "queued"].includes(row.state)) break;
    if (row.state === "parked") break;
    if (Date.now() - from > 60_000) assert.fail(`run-1 did not settle: ${JSON.stringify(row)}`);
    await sleep(25);
  }
  return { server, store: stores.at(-1), row, sent };
}

test("a capped pi run lost mid compile turn: the next claim takes the open compile turn as learning's; the run ends completed with its answer, its learning dropped no_budget, never parked", { timeout: 120_000 }, async (t) => {
  // The compile turn's request is out at the loss, booked cut at its hold (about $0.50, its worst case), which leaves the
  // cap no room for another: the next claim's compile ask is refused by the cap, still learning's request, never a park.
  const COMPILE = { mode: "new", reference: "REF", traces: [], tools: [], judges: false };
  const endOfRun = createReflectHook({
    facts: async () => ({ learns: true, costUsd: 0 }),
    feedback: async () => [],
    correctionRefused: async () => [],
    compileFacts: async () => COMPILE,
    checkDraft: async () => ({ errors: ["no draft is expected under a cap with no room"] }),
    commit: async () => assert.fail("nothing is committed under a cap with no room"),
  });
  const { server, store, row, sent } = await lostRun(t, { capUsd: 0.52, runCap: { modelOf: () => SONNET }, held: isCompile, losses: 1, endOfRun });
  assert.equal(sent.filter(isCompile).length, 1, `the compile turn went out once, at the loss: ${sent.length} requests`);
  const budgets = await rootEntries(store, "agentrun.budget");
  const wrapUps = await rootEntries(store, "agentrun.cap_wrapup");
  assert.deepEqual(budgets, [], `no budget pause for learning spend: ${JSON.stringify(budgets)}`);
  assert.deepEqual(wrapUps, [], `no wrap-up note told to the compile turn: ${JSON.stringify(wrapUps)}`);
  assert.equal(row.state, "ended", `the answered run ends: ${JSON.stringify(row)}`);
  const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  assert.equal(view.status, "completed", `the run reads completed: ${JSON.stringify({ status: view.status, error: view.error })}`);
  const timeline = await runTimeline(server, "run-1", ctx);
  const answers = timeline.filter((one) => one.kind === "final_answer").map((one) => one.text);
  assert.ok(answers.includes(ANSWER), `the job's answer is the run's: ${JSON.stringify(answers)}`);
  const kept = await server.learning.proposal("run-1");
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.reason], ["dropped", "no_budget"], `the learning dropped for the cap's short room: ${JSON.stringify(kept?.proposal)}`);
});
