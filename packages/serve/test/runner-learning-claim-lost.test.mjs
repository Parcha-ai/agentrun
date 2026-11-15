// A capped pi run that answered and was in its end-of-run learning (its look-back or its compile turn, request ids
// learn-reflect-<run>…) when its runner lost the claim: the request out at the loss is booked cut at its hold. The claim
// that takes the run over must not run that open learning turn as the job's turn: told to finish in the cap's words,
// refused, then parked for a raise (input_required) on spend that was only ever learning's. One rule: the run's status
// comes from how the job's own turn ended. Learning spend that leaves the cap no room, or that takes the total past it,
// is the learning's: dropped in the reason the learning code keeps for the cap (no_budget), the spend still booked;
// never a budget pause, a wrap-up note in the learning turn, or a run failed over its cap.
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
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { createReflectHook } = await import("../dist/runner/reflect-hook.js");
const { learningFolderOf, seedOf } = await import("../dist/learning.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");

const ANSWER = "The job's answer.";
const NOTE = "---\nname: Retry slowly\ndescription: Back off between retries\ntype: reference\n---\nWait a little longer after each failed call.\n";
const REFLECTED = `\`\`\`note retry-slowly.md\n${NOTE}\`\`\`\n\nReflected.`;
/** Sonnet's list price, the booking's (the cap prices requests the same: SONNET). */
const listPrice = (_model, usage) => (usage.input * 3 + usage.output * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
/** The text of a Messages request's newest user message. */
const lastUserText = (body) => {
  const content = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
};
/** The end-of-run turn's prompt (reflectPrompt names the run's copy of its notes). */
const isLookBack = (body) => /\.learning/.test(lastUserText(body));
/** The compile turn's prompt (learn/compile.ts compilePrompt, a new workflow). */
const isCompile = (body) => /Compile the whole job/.test(lastUserText(body));

/** Run-1 under a cap of `capUsd` (the cap's model and mode `runCap`), its learning step `endOfRunOf(store, launch)`, on
 *  one runner after another: each request `held` matches while losses are left is never answered there, and that
 *  runner's claim is lost (its journal frozen, the runner killed, the store's clock moved past its claim) once it is out;
 *  the next runner takes the run over. `priceOf(body)`: what a request the provider answered is booked at (each answer's
 *  booking reads the figure of the request it answers, in order). Settles at the run's end or park. */
async function lostRun(t, { capUsd, runCap, held, losses, priceOf, endOfRunOf }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-learning-claim-lost-"));
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const stores = [];
  const runners = [];
  /** The requests held on a lost runner, each failed at the end. */
  const hung = [];
  t.after(async () => {
    // What the lost runners hold fails first (their held requests, their frozen commits), so their close ends too.
    for (const fail of hung) fail(new Error("the test ended"));
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: [], learning: true } });
  const seed = await seedOf(dir, "agent-1");
  const body = { input: { content: "Follow the script." }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: seed.sha, section: "", seedNotes: 0 }, max_cost_usd: capUsd };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body });
  const launch = readLaunchBody(body);
  assert.equal(launch?.maxCostUsd, capUsd, "the launch carries the cap the learning step reads");

  const sent = [];
  /** The figures of the answers the provider gave, in order, each read once by its booking. */
  const prices = [];
  let left = losses;
  let out = () => {};
  const origin = async (url, init) => {
    const request = JSON.parse(String(init.body ?? "{}"));
    // The script's step is the request's count of assistant messages (scriptedOrigin): the job's answer, then the
    // learning turn's reply.
    const step = (request.messages ?? []).filter((message) => message.role === "assistant").length;
    const script = [{ say: ANSWER }, ...Array.from({ length: step }, () => ({ say: isCompile(request) ? "No change." : REFLECTED }))];
    prices.push(priceOf(request));
    return scriptedOrigin(script, sent)(url, init);
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
  // A figure the case gives, else Sonnet's list price of the answer's usage.
  const price = (model, usage) => {
    const figure = prices.shift();
    return typeof figure === "number" ? figure : listPrice(model, usage);
  };
  const spec = piAdapterSpec({ script: [], tools: {}, hooks: quiet, agentId: "agent-1" }, { fetch, price });
  // A lost runner's journal, frozen at the loss: every commit from then on never returns, so its loop (still alive in this
  // process: a kill stops nothing) writes nothing more, as a dead process's would.
  const frozen = new Set();
  const freezing = (name, journal) => new Proxy(journal, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "commit") return value.bind(target);
      return (...args) => (frozen.has(name) ? new Promise((_, reject) => hung.push(reject)) : value.apply(target, args));
    },
  });
  const start = async (name) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner", now });
    stores.push(store);
    const endOfRun = endOfRunOf(store, launch, dir);
    const job = createAdapterLoop(async (claim, run) => ({
      ...(await spec(claim, run)),
      cap: { capUsd, park: (refusal) => cap.parkOf(refusal, capUsd), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf },
      runCap: { capUsd: () => capUsd, ...runCap },
    }), { restartLimit: MAX_RESTARTS });
    // Run-1 on the adapter loop; any other run it claims (a learning run a proposal queues) is held, never run here.
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

/** The run's learning step as the server builds it (learning-end.ts), over the runner's store. */
const realLearning = (store, launch, dir) => learningEndOfRun(launch, { store, data: dir, env: {}, learningFolder: (agentId) => learningFolderOf(dir, agentId) });

test("a capped pi run lost mid look-back: the next claim never runs the learning turn as the job's; the run ends completed with its answer, its learning dropped no_budget, never parked", { timeout: 120_000 }, async (t) => {
  // Room for the job's request and then the look-back's (each held at about $0.50 under the strict rule), never for
  // another once the cut look-back is booked at its hold.
  const { server, store, row, sent } = await lostRun(t, { capUsd: 0.52, runCap: { modelOf: () => SONNET, mode: "strict" }, held: isLookBack, losses: 1, priceOf: () => undefined, endOfRunOf: realLearning });
  const budgets = await rootEntries(store, "agentrun.budget");
  const wrapUps = await rootEntries(store, "agentrun.cap_wrapup");
  assert.deepEqual(budgets, [], `no budget pause for learning spend: ${JSON.stringify(budgets)}`);
  assert.equal(row.state, "ended", `the answered run ends, never parked for a raise: ${JSON.stringify(row)}`);
  assert.deepEqual(wrapUps, [], `no wrap-up note told to the learning turn: ${JSON.stringify(wrapUps)}`);
  const timeline = await runTimeline(server, "run-1", ctx);
  const answers = timeline.filter((one) => one.kind === "final_answer").map((one) => one.text);
  assert.ok(answers.includes(ANSWER), `the job's answer is the run's: ${JSON.stringify(answers)}`);
  const kept = await server.learning.proposal("run-1");
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.reason], ["dropped", "no_budget"], `the learning dropped as the cap's short room drops it: ${JSON.stringify(kept?.proposal)}`);
  assert.equal(sent.filter(isLookBack).length, 1, `the look-back was sent once, never again under a cap with no room: ${sent.length} requests`);
});

test("the walk's shape: a job answered at $1, its look-back cut twice and booked at its worst case, then answered past the $5 cap: the run ends completed with its answer, its learning dropped no_budget, the spend booked and shown", { timeout: 180_000 }, async (t) => {
  // A model whose request (32k output tokens asked) holds about $1.61 (strict: the hold is the worst case, no cache read).
  // The job's request answers for $1.00; each look-back request out at a loss is booked cut at its hold
  // ($1 + 2 × $1.61 = $4.22); the third claim's look-back is admitted at what the cap leaves (about $0.78) and answers
  // for $1.16 (its provider's count above the measured bound): about $5.38 booked against the $5 cap.
  const PRICEY = Object.freeze({ ...SONNET, price: { ...SONNET.price, output: 50 } });
  const CAP = 5;
  const { server, store, row, sent } = await lostRun(t, {
    capUsd: CAP,
    runCap: { modelOf: () => PRICEY, mode: "strict" },
    held: isLookBack,
    losses: 2,
    priceOf: (body) => (isLookBack(body) ? 1.16 : 1),
    endOfRunOf: realLearning,
  });
  assert.equal(sent.filter(isLookBack).length, 3, `the look-back went out on each of the three claims: ${sent.length} requests`);
  const budgets = await rootEntries(store, "agentrun.budget");
  assert.deepEqual(budgets, [], `no budget pause for learning spend: ${JSON.stringify(budgets)}`);
  assert.equal(row.state, "ended", `the run's status is its job's turn's: completed, never failed over its cap for learning spend: ${JSON.stringify(row)}`);
  const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  assert.deepEqual([view.status, view.error ?? null], ["completed", null], `the run reads completed: ${JSON.stringify({ status: view.status, error: view.error })}`);
  const timeline = await runTimeline(server, "run-1", ctx);
  const answers = timeline.filter((one) => one.kind === "final_answer").map((one) => one.text);
  assert.ok(answers.includes(ANSWER), `the job's answer is the run's: ${JSON.stringify(answers)}`);
  const kept = await server.learning.proposal("run-1");
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.reason], ["dropped", "no_budget"], `the learning dropped for the cap, never the run: ${JSON.stringify(kept?.proposal)}`);
  // The spend stays booked: the job's $1, each cut look-back at its hold, the last look-back's $1.16, past the cap. The
  // run's cost shows what is known ($2.16) and the two cut requests as not priced, never $0 or a total under the cap.
  const entries = (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx)).entries;
  const held = new Map(entries.filter((one) => one.kind === "runner.request").map((one) => [one.data.turn, one.data.heldUsd]));
  const booked = entries.filter((one) => one.kind === "runner.turn").map((one) => (one.data.cut ? held.get(one.data.turn) : one.data.bookedUsd));
  assert.deepEqual(entries.filter((one) => one.kind === "runner.turn").map((one) => one.data.cut === true), [false, true, true, false], "booked: the job's answer, two cuts, the look-back's answer");
  const total = booked.reduce((sum, usd) => sum + usd, 0);
  assert.ok(total > CAP + 0.3 && total < CAP + 0.5, `about $5.38 booked against the $5 cap: ${total}`);
  assert.deepEqual([view.cost.usd, view.cost.cap_usd, view.cost.so_far_usd, view.cost.unpriced], [null, CAP, 2.16, 2], `the run's cost: $2.16 known, the two cut requests not priced: ${JSON.stringify(view.cost)}`);
});

test("a capped pi run lost mid compile turn: the next claim takes the open compile turn as learning's; the run ends completed with its answer, its learning dropped no_budget, never parked", { timeout: 120_000 }, async (t) => {
  // The look-back answers on the first claim; the compile turn's request is out at the loss, booked cut at its hold
  // (about $0.50, strict), which leaves the cap no room for another.
  const COMPILE = { mode: "new", reference: "REF", notes: [{ file: "retry-slowly.md", text: NOTE }], traces: [], tools: [], judges: false };
  const proposed = { state: "proposed", notes: 1, skills: 0, workflows: 0, proposal: { seed: "abc", notes: [{ file: "retry-slowly.md", text: NOTE }], asked: ["Follow the script."] } };
  const hook = () => createReflectHook({
    facts: async () => ({ learns: true, costUsd: 0 }),
    promptFacts: async () => ({ active: 0 }),
    asked: async () => ({ asked: ["Follow the script."] }),
    check: async () => proposed,
    compileFacts: async () => COMPILE,
    newRunId: () => "run-1-learning",
  });
  const { server, store, row, sent } = await lostRun(t, { capUsd: 0.52, runCap: { modelOf: () => SONNET, mode: "strict" }, held: isCompile, losses: 1, priceOf: () => undefined, endOfRunOf: hook });
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
