// The end-of-run step on a pi run (loop-contract.ts EndOfRunTurn, the learning lane's end-of-run turn moved into the
// runner): asked once after the job's answer and before the end, its turn's writes under work/.learning/ refused, the
// rows it returns landing in the end commit's one transaction, and a lost claim writing no end, the next claim asking
// again. On a real store and runner, with pi-ai's faux model playing the script.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { piSpec } from "./conformance-pi.mjs";

const { createPiLoop } = await import("../dist/runner/loop.js");
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const told = (marker) => ({ table: "channel_told", row: { channel: "learning:test", marker } });

async function setup(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-end-of-run-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const runners = [];
  const stores = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Reflects" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const start = async (createLoop, name) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const runner = startRunner({ store, createLoop, name, ...TIMING });
    runners.push(runner);
    return runner;
  };
  const until = async (test, what) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const row = await server.runs.get("run-1");
      if (test(row)) return row;
      if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(row)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const toldRows = () => {
    const db = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT channel, run_id, marker FROM channel_told ORDER BY marker").all().map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };
  const endEntries = () => {
    const db = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT COUNT(*) AS n FROM pi_entries WHERE run_id = ? AND json_extract(record, '$.kind') = 'agentrun.end'").get("run-1").n;
    } finally {
      db.close();
    }
  };
  return { server, start, until, toldRows, endEntries };
}

/** A pi loop whose spec names its agent, and whose deps carry `endOfRun`. */
const loopWith = (spec, endOfRun) => {
  const inner = createPiLoop(async (claim) => ({ ...(await spec(claim)), agentId: "agent-1" }));
  return (deps) => inner({ ...deps, endOfRun });
};

test("the end-of-run step is asked once, after the job answered and before the end, with the turn's answer", async (t) => {
  const { start, until, endEntries } = await setup(t);
  const calls = [];
  const endOfRun = async (input) => {
    const answer = await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    calls.push({ runId: input.runId, agentId: input.agentId, outcome: input.outcome, epoch: input.claim.epoch, answer });
    return undefined;
  };
  await start(loopWith(piSpec({ script: [{ say: "the job's answer" }, { say: "a note" }], tools: {}, hooks: quiet }), endOfRun), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.equal(calls.length, 1, "asked once");
  assert.deepEqual(calls[0], { runId: "run-1", agentId: "agent-1", outcome: "completed", epoch: calls[0].epoch, answer: { ended: true, answer: "a note" } });
  assert.equal(endEntries(), 1, "one end, written after the step");
});

test("the rows the end-of-run step returns land with the end, in its one commit", async (t) => {
  const { start, until, toldRows } = await setup(t);
  const endOfRun = async (input) => {
    await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    return { also: [told("proposed")] };
  };
  await start(loopWith(piSpec({ script: [{ say: "done" }, { say: "a note" }], tools: {}, hooks: quiet }), endOfRun), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(toldRows(), [{ channel: "learning:test", run_id: "run-1", marker: "proposed" }], "the step's row is stored with the end");
});

test("the learning hook on a pi run: its turn and proposal kept with the end, and one learning run queued", async (t) => {
  const { server, start, until } = await setup(t);
  const { createReflectHook } = await import("../dist/runner/reflect-hook.js");
  const hook = createReflectHook({
    facts: async (runId) => ({ learns: runId === "run-1", costUsd: 0 }),
    promptFacts: async () => ({ active: 0, tools: [] }),
    asked: async () => ({ asked: ["Follow the script."] }),
    check: async ({ turn }) => ({ state: "proposed", notes: 1, skills: 0, workflows: 0, proposal: { seed: "s", notes: [{ file: "n.md", text: turn.answer }], asked: turn.asked } }),
    newRunId: () => "run-1-learning",
  });
  await start(loopWith(piSpec({ script: [{ say: "done" }, { say: "a note" }], tools: {}, hooks: quiet }), hook), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  const kept = await server.learning.proposal("run-1");
  assert.equal(kept?.turn?.answer, "a note", "the turn's answer is kept with the end");
  assert.equal(kept?.proposal?.state, "proposed");
  const learning = await server.runs.get("run-1-learning");
  assert.deepEqual(learning && [learning.agentId, learning.revisionId], ["agent-1", "rev-1"], "one learning run of the run's agent and revision");
});

/** A journal that refuses every commit after the one that wrote the run's end: the fault between two commits. */
function refusingAfterEnd(journal) {
  let ended = false;
  return new Proxy(journal, {
    get(target, key, receiver) {
      if (key === "commit") {
        return async (batches, receive, context) => {
          if (ended) throw new Error("the store refused a commit after the run's end");
          const result = await target.commit(batches, receive, context);
          if (batches.some((batch) => batch.some((write) => write.type === "entry" && write.value.kind === "agentrun.end"))) ended = true;
          return result;
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("the end and the step's rows land together or not at all, even when a commit after the end is refused", async (t) => {
  const { start, until, toldRows, endEntries } = await setup(t);
  const endOfRun = async (input) => {
    await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    return { also: [told("kept")] };
  };
  const inner = createPiLoop(async (claim) => ({ ...(await piSpec({ script: [{ say: "done" }, { say: "a note" }], tools: {}, hooks: quiet })(claim)), agentId: "agent-1" }));
  const createLoop = (deps) => inner({ ...deps, endOfRun, journal: (claim) => refusingAfterEnd(deps.journal(claim)) });
  await start(createLoop, "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.equal(endEntries(), 1, "the end is stored");
  assert.deepEqual(toldRows().map((row) => row.marker), ["kept"], "the step's rows are stored with the end, in its one commit");
});

test("a run whose step returns nothing stores no row beside its end", async (t) => {
  const { start, until, toldRows } = await setup(t);
  await start(loopWith(piSpec({ script: [{ say: "done" }, { say: "" }], tools: {}, hooks: quiet }), async () => undefined), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(toldRows(), [], "no row");
});

test("a lost claim during the end-of-run turn writes no end; the next claim asks again, and the end is written once", async (t) => {
  const { start, until, toldRows, endEntries } = await setup(t);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const seen = [];
  const first = async (input) => {
    seen.push("first");
    await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    await Promise.race([held, new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }))]);
    if (input.signal.aborted) throw new Error("aborted");
    return { also: [told("first")] };
  };
  const runnerA = await start(loopWith(piSpec({ script: [{ say: "done" }, { say: "a note" }], tools: {}, hooks: quiet }), first), "runner-a");
  const deadline = Date.now() + 10_000;
  while (!seen.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, ["first"], "the first claim asked the step");
  await runnerA.close();
  release();
  assert.equal(endEntries(), 0, "no end while the step was cut off");
  assert.deepEqual(toldRows(), [], "nothing of the step was stored");
  const second = async (input) => {
    seen.push("second");
    const answer = await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    assert.deepEqual(answer, { ended: true, answer: "a note" }, "the resumed turn's answer is the one already given");
    return { also: [told("second")] };
  };
  await start(loopWith(piSpec({ script: [{ say: "done" }, { say: "a note" }], tools: {}, hooks: quiet }), second), "runner-b");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end on the next claim");
  assert.deepEqual(seen, ["first", "second"], "asked again on the next claim");
  assert.equal(endEntries(), 1, "one end");
  assert.deepEqual(toldRows().map((row) => row.marker), ["second"], "only the finished step's row");
});

test("the end-of-run turn's write under work/.learning/ is refused; the job's own write there is not", async (t) => {
  const { start, until } = await setup(t);
  const ran = [];
  const write = { name: "write", replaySafe: false, ask: false, run: async (args) => (ran.push(args.path), "written") };
  const script = [{ call: "write", args: { path: ".learning/job.md" } }, { say: "done" }, { call: "write", args: { path: ".learning/note.md" } }, { say: "a note" }];
  let answer;
  const endOfRun = async (input) => {
    answer = await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    return undefined;
  };
  await start(loopWith(piSpec({ script, tools: { write }, hooks: quiet }), endOfRun), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(ran, [".learning/job.md"], "the job wrote; the end-of-run turn's write never ran");
  assert.deepEqual(answer, { ended: true, answer: "a note" });
});

test("an end-of-run turn past its deadline is aborted and answers timedOut; the run still ends", async (t) => {
  const { start, until, endEntries } = await setup(t);
  let answer;
  const slow = { name: "slow", replaySafe: true, ask: false, run: (_args, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve("cut"), { once: true })) };
  const endOfRun = async (input) => {
    answer = await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 300 });
    return undefined;
  };
  await start(loopWith(piSpec({ script: [{ say: "done" }, { call: "slow" }, { say: "late" }], tools: { slow }, hooks: quiet }), endOfRun), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(answer, { timedOut: true });
  assert.equal(endEntries(), 1);
});
