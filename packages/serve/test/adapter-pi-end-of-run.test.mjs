// The end-of-run step, the end's patch and harnessReady on pi through the adapter loop (runner/adapter-loop.ts): the
// pi loop's cases (runner-end-of-run on the cutover base) on the one loop. The step (loop-contract.ts EndOfRunTurn) is
// asked once after the job's answer and before the end, its turn's writes under work/.learning/ refused, the rows it
// returns landing in the end commit's one transaction, a lost claim writing no end and the next claim asking again; the
// end's patch (outcome, cost, metrics) rides in the end's commit; a mark committed through harnessReady's commit is
// fenced with the run's. On a real store and runner, the model a scripted origin behind pi's session proxy.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, openSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
/** A short lease: for the one case whose point is the lease (a lost claim during the end-of-run turn). */
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
/** A lease no stall of a loaded machine outlasts: every case whose point is not the lease. On the short lease a stall of
 *  the box longer than it lets the claim lapse unrenewed, the runner takes the run back, and a step or a replay-safe tool
 *  runs again (a mark written twice, a step asked twice). */
const STEADY = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 15_000;
const told = (marker) => ({ table: "channel_told", row: { channel: "learning:test", marker } });
after(closeOpenSessions);

async function setup(t, timing = STEADY) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-end-of-run-"));
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
    const runner = startRunner({ store, createLoop, name, ...timing });
    runners.push(runner);
    return runner;
  };
  const until = async (test, what) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const row = await server.runs.get("run-1");
      if (test(row)) return row;
      if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(row)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const read = (sql, ...args) => {
    const db = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
    try {
      return db.prepare(sql).all(...args).map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };
  const toldRows = () => read("SELECT channel, run_id, marker FROM channel_told ORDER BY marker");
  const entriesOf = (kind) => read("SELECT COUNT(*) AS n FROM pi_entries WHERE run_id = ? AND json_extract(record, '$.kind') = ?", "run-1", kind)[0].n;
  const endEntries = () => entriesOf("agentrun.end");
  /** Each end entry of the run, its data. */
  const endsOf = () => read("SELECT json_extract(record, '$.data') AS data FROM pi_entries WHERE run_id = ? AND json_extract(record, '$.kind') = 'agentrun.end'", "run-1").map((row) => JSON.parse(row.data));
  return { server, start, until, toldRows, endEntries, entriesOf, endsOf };
}

/** The adapter loop on `spec`, its spec naming the run's agent and carrying `extra` (endPatch, harnessReady), its deps
 *  given `more` (endOfRun, a journal). */
const loopWith = (spec, extra = {}, more = {}) => {
  const inner = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1", ...extra }));
  return (deps) => inner({ ...deps, ...(typeof more === "function" ? more(deps) : more) });
};

/** A tool that runs until its call is aborted, telling the test when it started. */
function heldTool() {
  let started;
  const running = new Promise((resolve) => (started = resolve));
  const tool = { name: "slow", replaySafe: true, ask: false, run: (_args, signal) => (started(), new Promise((resolve) => signal.addEventListener("abort", () => resolve("cut"), { once: true }))) };
  return { tool, running };
}

test("pi through the adapter: the end-of-run step is asked once, after the job answered and before the end, with the turn's answer", async (t) => {
  const { start, until, endEntries } = await setup(t);
  const calls = [];
  const endOfRun = async (input) => {
    const answer = await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    calls.push({ runId: input.runId, agentId: input.agentId, outcome: input.outcome, answer });
    return undefined;
  };
  await start(loopWith(piAdapterSpec({ script: [{ say: "the job's answer" }, { say: "a note" }], tools: {}, hooks: quiet }), {}, { endOfRun }), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(calls, [{ runId: "run-1", agentId: "agent-1", outcome: "completed", answer: { ended: true, answer: "a note" } }], "asked once, with the turn's answer");
  assert.equal(endEntries(), 1, "one end, written after the step");
});

test("pi through the adapter: the rows the end-of-run step returns land with the end, in its one commit", async (t) => {
  const { start, until, toldRows } = await setup(t);
  const endOfRun = async (input) => {
    await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    return { also: [told("proposed")] };
  };
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { say: "a note" }], tools: {}, hooks: quiet }), {}, { endOfRun }), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(toldRows(), [{ channel: "learning:test", run_id: "run-1", marker: "proposed" }], "the step's row is stored with the end");
});

test("pi through the adapter: the learning hook keeps its turn and proposal with the end, and queues one learning run", async (t) => {
  const { server, start, until } = await setup(t);
  const { createReflectHook } = await import("../dist/runner/reflect-hook.js");
  const hook = createReflectHook({
    facts: async (runId) => ({ learns: runId === "run-1", costUsd: 0 }),
    promptFacts: async () => ({ active: 0, tools: [] }),
    asked: async () => ({ asked: ["Follow the script."] }),
    check: async ({ turn }) => ({ state: "proposed", notes: 1, skills: 0, workflows: 0, proposal: { seed: "s", notes: [{ file: "n.md", text: turn.answer }], asked: turn.asked } }),
    newRunId: () => "run-1-learning",
  });
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { say: "a note" }], tools: {}, hooks: quiet }), {}, { endOfRun: hook }), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  const kept = await server.learning.proposal("run-1");
  assert.equal(kept?.turn?.answer, "a note", "the turn's answer is kept with the end");
  assert.equal(kept?.proposal?.state, "proposed");
  const learning = await server.runs.get("run-1-learning");
  assert.deepEqual(learning && [learning.agentId, learning.revisionId], ["agent-1", "rev-1"], "one learning run of the run's agent and revision");
});

test("pi through the adapter: the end-of-run step's re-ask (again) is its own request in the same session: the model answers it anew", async (t) => {
  const { start, until } = await setup(t);
  const answers = [];
  const requests = [];
  const endOfRun = async (input) => {
    answers.push(await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 }));
    answers.push(await input.ask("Give the whole answer again in the format.", { origin: "reflect", deadlineMs: 10_000, again: true }));
    return undefined;
  };
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { say: "a note" }, { say: "the note again" }], tools: {}, hooks: quiet }, { requests }), {}, { endOfRun }), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(answers, [{ ended: true, answer: "a note" }, { ended: true, answer: "the note again" }], "the re-ask's answer is the model's second, never the first again");
  assert.equal(requests.length, 3, "three model requests: the job's, the turn's, the re-ask's");
  assert.match(JSON.stringify(requests[2].messages), /a note/, "the re-ask is in the same session: its request carries the first answer");
});

test("pi through the adapter: the learning hook asks again once when the parser refuses the answer, and a skill opened with three backticks, then four, is proposed", async (t) => {
  const { server, start, until } = await setup(t);
  const { createReflectHook } = await import("../dist/runner/reflect-hook.js");
  const { parseReflection } = await import("../dist/learn/index.js");
  const skillAnswer = (fence) => `${fence}skill find-policies\n---\nname: find-policies\ndescription: Find a store's refund policy\n---\n# Find policies\n\nOpen /policies/ first.\n${fence}`;
  const hook = createReflectHook({
    facts: async (runId) => ({ learns: runId === "run-1", costUsd: 0 }),
    promptFacts: async () => ({ active: 0, tools: [] }),
    asked: async () => ({ asked: ["Follow the script."] }),
    check: async ({ turn }) => {
      const parsed = parseReflection(turn.answer);
      if (!parsed.ok) return parsed.reason === "empty" ? { state: "dropped", reason: "empty" } : { state: "dropped", reason: "unparsed", detail: parsed.detail };
      return { state: "proposed", notes: parsed.notes.length, skills: parsed.skills?.length ?? 0, workflows: 0, proposal: { skills: parsed.skills } };
    },
    newRunId: () => "run-1-learning",
  });
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { say: skillAnswer("```") }, { say: skillAnswer("````") }], tools: {}, hooks: quiet }), {}, { endOfRun: hook }), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  const kept = await server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "proposed", JSON.stringify(kept?.proposal));
  assert.equal(kept?.proposal?.skills, 1, "the skill is proposed");
  assert.equal(kept?.turn?.answer, skillAnswer("````"), "the turn kept is the answer read");
  assert.ok(await server.runs.get("run-1-learning"), "one learning run queued");
});

/** A journal that refuses the commit that writes the run's end, and every one after it: an end whose commit is fenced.
 *  `refused` counts the end commits it refused. */
function refusingTheEnd(journal, refused = { ends: 0 }) {
  let refusing = false;
  return new Proxy(journal, {
    get(target, key, receiver) {
      if (key === "commit") {
        return async (batches, receive, context) => {
          const isEnd = batches.some((batch) => batch.some((write) => write.type === "entry" && write.value.kind === "agentrun.end"));
          if (isEnd) refusing = true;
          if (refusing) {
            if (isEnd) refused.ends += 1;
            throw new Error("the store refused the end's commit");
          }
          return target.commit(batches, receive, context);
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("pi through the adapter: the end patch (outcome, cost, metrics) lands on the run in the end's own commit", async (t) => {
  const { start, until } = await setup(t);
  const endPatch = async (end) => ({ outcome: end.state === "ended" ? "escalated" : undefined, costUsd: 1.25, metrics: { requests: 3 } });
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }], tools: {}, hooks: quiet }), { endPatch }), "runner-a");
  const row = await until((r) => r.state === "ended" && r.runner === null, "the run did not end");
  assert.deepEqual([row.outcome, row.costUsd, row.metrics], ["escalated", 1.25, { requests: 3 }]);
});

// The loop's end (ended, with the spec's end patch) is refused, and so is its failed end after it. The runner then ends the
// run itself (runner.ts endRun): failed with why, in an end entry of its own written through the store, never the loop's,
// and with none of the loop's patch. Waited for by the run's final state, never by a state the queued run already has; on
// a lease no stall outlasts, so the claim the loop ends under is the one the runner ends.
test("pi through the adapter: a fenced end writes neither the end nor its patch", async (t) => {
  const { start, until, endsOf } = await setup(t);
  const endPatch = async () => ({ outcome: "escalated", costUsd: 1.25, metrics: { requests: 3 } });
  const refused = { ends: 0 };
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }], tools: {}, hooks: quiet }), { endPatch }, (deps) => ({ journal: (claim) => refusingTheEnd(deps.journal(claim), refused) })), "runner-a");
  const row = await until((r) => r.state === "failed" && r.runner === null, "the runner did not end the run failed");
  assert.ok(refused.ends >= 1, `the loop's end was tried and refused: ${refused.ends}`);
  const ends = endsOf();
  assert.deepEqual(ends.map((end) => end.state), ["failed"], `one end: the runner's failed one, never the loop's ended one: ${JSON.stringify(ends)}`);
  assert.match(ends[0].summary ?? "", /refused the end's commit/, "saying why");
  assert.deepEqual([row.outcome, row.costUsd, row.metrics], [null, null, null], "and none of the loop's patch");
});

test("pi through the adapter: an end patch whose reader stalls cannot hold a person's stop: the run still ends stopped", async (t) => {
  const { server, start, until } = await setup(t);
  const endPatch = () => new Promise(() => {});
  const { tool, running } = heldTool();
  await start(loopWith(piAdapterSpec({ script: [{ call: "slow" }, { say: "done" }], tools: { slow: tool }, hooks: quiet }), { endPatch }), "runner-a");
  await running;
  await server.command("run-1", { kind: "stop" });
  await until((row) => row.state === "stopped" && row.runner === null, "the run did not stop");
});

test("pi through the adapter: a mark committed through harnessReady's commit is in the run's journal, and refused once the run's claim is gone", async (t) => {
  const { start, until, entriesOf } = await setup(t);
  let commit;
  const marked = [];
  const mark = (n) => commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.mark", data: { n } }), BACKGROUND_CONTEXT);
  const slow = {
    name: "slow", replaySafe: true, ask: false,
    run: async () => {
      marked.push(await mark(1).then(() => "ok", (error) => `refused: ${error.message}`));
      return "slow done";
    },
  };
  await start(loopWith(piAdapterSpec({ script: [{ call: "slow" }, { say: "done" }], tools: { slow }, hooks: quiet }), { harnessReady: (c) => (commit = c) }), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(marked, ["ok"], "the mark was committed through the run's own Harness");
  assert.equal(entriesOf("test.mark"), 1, "and it is in the run's journal");
  await assert.rejects(mark(2), undefined, "a commit after the run let its claim go is refused");
  assert.equal(entriesOf("test.mark"), 1, "and wrote nothing");
});

test("pi through the adapter: a run's release is called once, after its session closed, when the run ends; one that throws leaves the end standing", async (t) => {
  const { start, until } = await setup(t);
  // The end's commit is the run's release in the store (its row reads ended, its runner null), and the loop closes the
  // session and calls the release after it, in its pass's finally: the row can read ended before the release is called.
  // So the test waits for the release itself, by its event (its own bound fails one never called), never at the row.
  let releaseCalled = () => {};
  const called = new Promise((resolve) => (releaseCalled = resolve));
  const released = [];
  const release = async () => {
    released.push({ sessionsOpen: openSessions.size });
    releaseCalled();
    throw new Error("the cleanup failed");
  };
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }], tools: {}, hooks: quiet }), { release }), "runner-a");
  const row = await until((r) => r.state === "ended" && r.runner === null, "the run did not end");
  assert.equal(row.state, "ended", "a release that throws leaves the end standing");
  let timer;
  await Promise.race([called, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the run's release was never called")), 10_000)))]);
  clearTimeout(timer);
  assert.deepEqual(released, [{ sessionsOpen: 0 }], "released once, with the session already closed");
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

test("pi through the adapter: the end and the step's rows land together or not at all, even when a commit after the end is refused", async (t) => {
  const { start, until, toldRows, endEntries } = await setup(t);
  const endOfRun = async (input) => {
    await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    return { also: [told("kept")] };
  };
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { say: "a note" }], tools: {}, hooks: quiet }), {}, (deps) => ({ endOfRun, journal: (claim) => refusingAfterEnd(deps.journal(claim)) })), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.equal(endEntries(), 1, "the end is stored");
  assert.deepEqual(toldRows().map((row) => row.marker), ["kept"], "the step's rows are stored with the end, in its one commit");
});

test("pi through the adapter: a run whose step returns nothing stores no row beside its end", async (t) => {
  const { start, until, toldRows } = await setup(t);
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { say: "" }], tools: {}, hooks: quiet }), {}, { endOfRun: async () => undefined }), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(toldRows(), [], "no row");
});

test("pi through the adapter: a lost claim during the end-of-run turn writes no end; the next claim asks again, and the end is written once", async (t) => {
  const { start, until, toldRows, endEntries } = await setup(t, TIMING);
  let asked;
  const firstAsked = new Promise((resolve) => (asked = resolve));
  const seen = [];
  const first = async (input) => {
    seen.push("first");
    await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    asked();
    // Held until the claim's signal aborts (the runner closing): the step never finishes on this claim.
    await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("aborted");
  };
  const runnerA = await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { say: "a note" }], tools: {}, hooks: quiet }), {}, { endOfRun: first }), "runner-a");
  await firstAsked;
  await runnerA.close();
  assert.equal(endEntries(), 0, "no end while the step was cut off");
  assert.deepEqual(toldRows(), [], "nothing of the step was stored");
  const second = async (input) => {
    seen.push("second");
    const answer = await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    assert.deepEqual(answer, { ended: true, answer: "a note" }, "the resumed turn's answer is the one already given");
    return { also: [told("second")] };
  };
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { say: "a note" }], tools: {}, hooks: quiet }), {}, { endOfRun: second }), "runner-b");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end on the next claim");
  assert.deepEqual(seen, ["first", "second"], "asked again on the next claim");
  assert.equal(endEntries(), 1, "one end");
  assert.deepEqual(toldRows().map((row) => row.marker), ["second"], "only the finished step's row");
});

test("pi through the adapter: the end-of-run turn's write under work/.learning/ is refused; the job's own write there is not", async (t) => {
  const { start, until } = await setup(t);
  const ran = [];
  const write = { name: "write", replaySafe: false, ask: false, run: async (args) => (ran.push(args.path), "written") };
  const script = [{ call: "write", args: { path: ".learning/job.md" } }, { say: "done" }, { call: "write", args: { path: ".learning/note.md" } }, { say: "a note" }];
  let answer;
  const endOfRun = async (input) => {
    answer = await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    return undefined;
  };
  await start(loopWith(piAdapterSpec({ script, tools: { write }, hooks: quiet }), {}, { endOfRun }), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(ran, [".learning/job.md"], "the job wrote; the end-of-run turn's write never ran");
  assert.deepEqual(answer, { ended: true, answer: "a note" });
});

test("pi through the adapter: a person's stop during the job: the stopped end carries the step's rows for a cut run, and nothing is asked", async (t) => {
  const { server, start, until, toldRows } = await setup(t);
  const calls = [];
  const endOfRun = async (input) => {
    calls.push(input.cut);
    if (input.cut) return { also: [told(`cut:${input.cut}`)] };
    await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    return { also: [told("asked")] };
  };
  const { tool, running } = heldTool();
  await start(loopWith(piAdapterSpec({ script: [{ call: "slow" }, { say: "done" }], tools: { slow: tool }, hooks: quiet }), {}, { endOfRun }), "runner-a");
  await running;
  await server.command("run-1", { kind: "stop" });
  await until((row) => row.state === "stopped" && row.runner === null, "the run did not stop");
  assert.deepEqual(calls, ["stopped"], "the step asked once, told the run was cut by a stop");
  assert.deepEqual(toldRows(), [{ channel: "learning:test", run_id: "run-1", marker: "cut:stopped" }], "its rows stored with the stopped end");
});

test("pi through the adapter: a person's cancel during the end-of-run turn ends the run cancelled, the cut step's rows with that end", async (t) => {
  const { server, start, until, toldRows } = await setup(t);
  const calls = [];
  const endOfRun = async (input) => {
    calls.push(input.cut ?? "asked");
    if (input.cut) return { also: [told(`cut:${input.cut}`)] };
    await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 30_000 });
    return { also: [told("asked")] };
  };
  // The job answers; the end-of-run turn calls `slow`, which runs until its call is aborted.
  const { tool, running } = heldTool();
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { call: "slow" }, { say: "a note" }], tools: { slow: tool }, hooks: quiet }), {}, { endOfRun }), "runner-a");
  await running;
  await server.command("run-1", { kind: "cancel" });
  const row = await until((r) => r.state === "stopped" && r.runner === null, "the run did not stop");
  assert.equal(row.summary, "cancelled", "a cancel's end says cancelled, never a stop's words");
  assert.deepEqual(calls, ["asked", "stopped-looking"], "asked once, then told the run was cut while it looked back");
  assert.deepEqual(toldRows().map((each) => each.marker), ["cut:stopped-looking"], "the cut step's rows stored with the cancelled end");
});

test("pi through the adapter: a cut step that never answers (its store stalled) cannot hold a person's stop: the run still ends stopped", async (t) => {
  const { server, start, until } = await setup(t);
  const endOfRun = async (input) => (input.cut ? new Promise(() => {}) : undefined);
  const { tool, running } = heldTool();
  await start(loopWith(piAdapterSpec({ script: [{ call: "slow" }, { say: "done" }], tools: { slow: tool }, hooks: quiet }), {}, { endOfRun }), "runner-a");
  await running;
  await server.command("run-1", { kind: "stop" });
  await until((row) => row.state === "stopped" && row.runner === null, "the run did not stop");
});

test("pi through the adapter: a person's steer during the end-of-run turn is not swallowed by it: left for the end's own words, the turn not told", async (t) => {
  const { server, start, until } = await setup(t);
  // The end-of-run turn calls `slow`; the steer is sent once that call runs, and the call returns once the steer is in.
  let started;
  const reflectCallRuns = new Promise((resolve) => (started = resolve));
  let sent;
  const steerIn = new Promise((resolve) => (sent = resolve));
  const slow = { name: "slow", replaySafe: true, ask: false, run: async () => (started(), await steerIn, "slow done") };
  let steerRow;
  const endOfRun = async (input) => {
    if (input.cut) return undefined;
    const steering = (async () => {
      await reflectCallRuns;
      steerRow = await server.command("run-1", { kind: "steer", body: { text: "one more thing" } });
      sent();
    })();
    const answer = await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 10_000 });
    await steering;
    return { also: [told("ended" in answer ? `answered:${answer.answer}` : "timed-out")] };
  };
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { call: "slow" }, { say: "a note" }], tools: { slow }, hooks: quiet }), {}, { endOfRun }), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  const rows = await server.commands("run-1", 0);
  const steer = rows.find((row) => row.id === steerRow.id);
  assert.ok(steer.refused !== null, `the steer is refused at the end in words, not taken by the end-of-run turn: ${JSON.stringify(steer)}`);
});

test("pi through the adapter: an end-of-run turn past its deadline is aborted and answers timedOut; the run still ends", async (t) => {
  const { start, until, endEntries } = await setup(t);
  let answer;
  const { tool } = heldTool();
  const endOfRun = async (input) => {
    answer = await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 300 });
    return undefined;
  };
  await start(loopWith(piAdapterSpec({ script: [{ say: "done" }, { call: "slow" }, { say: "late" }], tools: { slow: tool }, hooks: quiet }), {}, { endOfRun }), "runner-a");
  await until((row) => row.state === "ended" && row.runner === null, "the run did not end");
  assert.deepEqual(answer, { timedOut: true });
  assert.equal(endEntries(), 1);
});
