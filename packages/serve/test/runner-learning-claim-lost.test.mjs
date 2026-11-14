// A capped pi run that answered and was looking back (its end-of-run turn, learn-reflect-<run>) when its runner lost the
// claim: the request out at the loss is booked cut at its hold, which leaves the cap no room for another. The claim that
// takes the run over must not run that open learning turn as the job's turn: told to finish in the cap's words, refused,
// then parked for a raise (input_required) on spend that was only ever learning's. An answered run never parks on
// learning spend: the run ends completed with its answer, and its learning is dropped in the reason the learning code
// keeps when the cap is short (no_budget), never a budget pause or a wrap-up note in the learning turn.
// pi through the adapter loop (conformance-pi-adapter.mjs) on the real learning end-of-run step (learning-end.ts), two
// runners on one store whose clock the case moves past the first's claim (adapter-pi-cap-raise-crash.test.mjs's way).
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
const { learningFolderOf, seedOf } = await import("../dist/learning.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");

/** Room for the job's request and then the look-back's (each held at about $0.50 under the strict rule), never for
 *  another once the cut look-back is booked at its hold. */
const CAP = 0.52;
const ANSWER = "The job's answer.";
const NOTE = "---\nname: Retry slowly\ndescription: Back off between retries\ntype: reference\n---\nWait a little longer after each failed call.\n";
const REFLECTED = `\`\`\`note retry-slowly.md\n${NOTE}\`\`\`\n\nReflected.`;
/** Sonnet's list price, the booking's (the cap prices requests the same: SONNET). */
const price = (_model, usage) => (usage.input * 3 + usage.output * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
/** The text of a Messages request's newest user message. */
const lastUserText = (body) => {
  const content = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
};
/** The end-of-run turn's prompt (reflectPrompt names the run's copy of its notes). */
const isLookBack = (body) => /\.learning/.test(lastUserText(body));

test("a capped pi run lost mid look-back: the next claim never runs the learning turn as the job's; the run ends completed with its answer, its learning dropped no_budget, never parked", { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-learning-claim-lost-"));
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const stores = [];
  const runners = [];
  let hold = true;
  let out = () => {};
  const lookBackOut = new Promise((resolve) => (out = resolve));
  /** The look-back requests held on runner-a, each failed at the end. */
  const hung = [];
  t.after(async () => {
    // What runner-a holds fails first (its held requests, its frozen commits), so its close ends too.
    for (const fail of hung) fail(new Error("the test ended"));
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: [], learning: true } });
  const seed = await seedOf(dir, "agent-1");
  const body = { input: { content: "Follow the script." }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: seed.sha, section: "", seedNotes: 0 }, max_cost_usd: CAP };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body });
  const launch = readLaunchBody(body);
  assert.equal(launch?.maxCostUsd, CAP, "the launch carries the cap the learning step reads");

  // The provider: the job answers; on the first runner the look-back's request is held until its claim is gone (never
  // answered there), on the next it answers with a note.
  const sent = [];
  const script = [{ say: ANSWER }, { say: REFLECTED }];
  const origin = scriptedOrigin(script, sent);
  const fetch = async (url, init = {}) => {
    const request = JSON.parse(String(init.body ?? "{}"));
    if (hold && isLookBack(request)) {
      sent.push(request);
      out();
      return new Promise((_, reject) => {
        hung.push(reject);
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return origin(url, init);
  };
  const spec = piAdapterSpec({ script, tools: {}, hooks: quiet, agentId: "agent-1" }, { fetch, price });
  // Runner-a's journal, frozen at the loss: every commit from then on never returns, so its loop (still alive in this
  // process: a kill stops nothing) writes nothing more, as a dead process's would.
  let frozen = false;
  const freezing = (journal) => new Proxy(journal, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "commit") return value.bind(target);
      return (...args) => (frozen ? new Promise((_, reject) => hung.push(reject)) : value.apply(target, args));
    },
  });
  const start = async (name) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner", now });
    stores.push(store);
    const endOfRun = learningEndOfRun(launch, { store, data: dir, env: {}, learningFolder: (agentId) => learningFolderOf(dir, agentId) });
    const job = createAdapterLoop(async (claim, run) => ({
      ...(await spec(claim, run)),
      cap: { capUsd: CAP, park: (refusal) => cap.parkOf(refusal, CAP), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf },
      // Strict: each request held at its output ceiling, so the cut look-back's hold leaves no room for another.
      runCap: { capUsd: () => CAP, modelOf: () => SONNET, mode: "strict" },
    }), { restartLimit: MAX_RESTARTS });
    // Run-1 on the adapter loop; any other run it claims (a learning run a proposal queues) is held, never run here.
    const createLoop = (deps) => {
      const loop = job({ ...deps, endOfRun, ...(name === "runner-a" ? { journal: (claim) => freezing(deps.journal(claim)) } : {}) });
      let mine = false;
      let release;
      const held = new Promise((resolve) => (release = resolve));
      return {
        start: (claim) => (claim.runId === "run-1" ? ((mine = true), loop.start(claim)) : held),
        command: (row) => (mine ? loop.command(row) : Promise.resolve({ refused: "not run here" })),
        stop: async (reason) => (mine ? loop.stop(reason) : release({ state: "interrupted" })),
      };
    };
    const runner = startRunner({ store, createLoop, name, ...STEADY });
    runners.push(runner);
    return runner;
  };

  const a = await start("runner-a");
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the look-back's request never went out on runner-a")), 30_000)));
  await Promise.race([lookBackOut, late]).finally(() => clearTimeout(timer));
  // The claim lost mid look-back: runner-a frozen (nothing stopped, flushed or released), its claim run out.
  frozen = true;
  a.kill();
  clock.skewMs += STEADY.leaseMs * 2;
  hold = false;
  await start("runner-b");
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (row.runner === null && !["running", "queued"].includes(row.state)) break;
    if (row.state === "parked") break;
    if (Date.now() - from > 60_000) assert.fail(`run-1 did not settle: ${JSON.stringify(row)}`);
    await sleep(25);
  }
  const budgets = await rootEntries(stores[1], "agentrun.budget");
  const wrapUps = await rootEntries(stores[1], "agentrun.cap_wrapup");
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
