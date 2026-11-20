// A run's look-back never undoes its end. A run that learns looks back once its job has ended: its end-of-run step, after
// the job's own turn (a fresh run's), or a grade's feedback round, which opens a completed run again on the grade's words
// (feedback-round.ts). While it looks back the run is its job's end, as every reader serves it:
//   - GET /runs/{id}, the list and the timeline read the end the job kept (completed, its answer, its end time), with its
//     learning reflecting, and nothing final until the look-back ends (poll_after_ms 1000, the timeline's `final` false);
//   - a person's stop and cancel are refused there, as for any ended run;
//   - a stop or cancel the runner takes anyway (a row that raced the view, or one landing as the end commits) cuts the
//     look-back alone: the run ends on the job's end, never stopped or cancelled;
//   - a message there does what a message to a completed run does: it runs as a follow-up turn once the end is in;
//   - the end keeps its time, so the run is told ended once (one run.ended webhook, whose marker is that time).
// Over a real server (its routes, its notices) on the data of a runner of the test's own, whose end-of-run step it holds
// open, so "while it looks back" is a moment the test chooses.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";
import { client, FAUX, startServe } from "./support.mjs";
import { PRIVATE_OK, receiver } from "./webhook-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { keepGrade } = await import("../dist/runner/feedback-round.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const AGENT_SAYS = "The agent's own answer: 42.";
const FOLLOW_UP = "And twice that?";
const FOLLOWED = "Twice that is 84.";
const LABEL = "Review: the reference answer is 42, said as a number.";
const FLOWS = [{ name: "answer", description: "Answers a question as a number", workflow: {
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer", tier: "fast" }] },
} }];
const lastText = (body) => {
  const last = (body?.messages ?? []).at(-1);
  return typeof last?.content === "string" ? last.content : (last?.content ?? []).map((block) => block?.text ?? "").join("");
};

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A server with its webhook set, and beside it on the same data a runner of the test's own whose end-of-run step waits,
 *  once armed (`hold()`), until the test lets it go or the run's stop cuts it; `beforeEnd(fn)` runs `fn` once as the
 *  run's end is written (its patch's read, right before the end commits). Agent `agent-1` learns. */
async function world(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "look-back-keeps-end-"));
  const served = await startServe({ data: dir, port: 0, faux: FAUX, drainTimeout: "5s", learning: "on", ...PRIVATE_OK });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ text: ({ body }) => (lastText(body).includes(FOLLOW_UP) ? FOLLOWED : AGENT_SAYS) });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await served.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = client(served.baseUrl, served.token);
  const hook = await receiver(t);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const seed = await landWorkflows(dir, "agent-1", FLOWS);
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: () => {} };
  let held;
  let ending;
  const specOf = async (claim, run) => {
    const spec = await adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
    const step = spec.endOfRun;
    assert.ok(step, "a run that learns has an end-of-run step");
    const before = async () => {
      const fn = ending;
      ending = undefined;
      await fn?.();
    };
    return {
      ...spec,
      endOfRun: async (asked) => {
        const mine = asked.cut ? undefined : held;
        if (mine) {
          held = undefined;
          mine.enter();
          await new Promise((resolve, reject) => {
            void mine.released.then(resolve);
            if (asked.signal.aborted) reject(asked.signal.reason ?? new Error("cut"));
            asked.signal.addEventListener("abort", () => reject(asked.signal.reason ?? new Error("cut")), { once: true });
          });
        }
        return step(asked);
      },
      ...(spec.endPatch ? { endPatch: async (data) => (await before(), spec.endPatch(data)) } : {}),
      ...(spec.endCost && !spec.endPatch ? { endCost: async () => (await before(), spec.endCost()) } : {}),
    };
  };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  /** The runner lost (closed for a shutdown: its claims given back, nothing ended) and another started on the same data,
   *  which claims what it held. */
  const restart = async () => {
    await runner.close();
    runner = startRunner({ store, name: "runner-b", ...TIMING, createLoop: createAdapterLoop(specOf) });
  };
  /** Arms the hold: the next end-of-run step waits. `entered` once it does; `release()` lets it go. */
  const hold = () => {
    const mine = {};
    mine.entered = new Promise((resolve) => (mine.enter = resolve));
    mine.released = new Promise((resolve) => (mine.release = resolve));
    held = mine;
    return mine;
  };
  const beforeEnd = (fn) => void (ending = fn);
  /** The run, once final with no runner, its claim past epoch `above`. */
  const endedPast = (id, above = 0) => until(async () => {
    const row = await store.runs.get(id);
    return ["ended", "failed", "stopped"].includes(row?.state) && row.runner === null && row.epoch > above && row;
  }, `run ${id} ended past epoch ${above}`);
  const start = async (id) => {
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "What is six times seven?" }, title: id, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, learning: startAt(seed), workflow_first: false } });
  };
  /** The grade route's work (keepGrade): a wrong grade with words on a run the agent finished opens its feedback round. */
  const grade = async (id) => {
    const row = await store.runs.get(id);
    const kept = await keepGrade(store, "agent-1", { run: id, correct: false, expected: { answer: 42 }, source: "eval", at: new Date().toISOString(), path: row.metrics?.path ?? "agent" }, LABEL);
    assert.equal(kept.feedback, "correction", `the grade opened a correction round: ${JSON.stringify(kept)}`);
    return kept;
  };
  const get = async (id) => {
    const read = await api("GET", `/runs/${id}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    return read.body;
  };
  const listed = async (id) => (await api("GET", "/runs")).body.runs.find((one) => one.run_id === id);
  const timeline = async (id) => (await api("GET", `/runs/${id}/timeline`)).body;
  /** The run.ended notices the receiver holds for run `id`. */
  const endsTold = (id) => hook.got.map((one) => JSON.parse(one.body)).filter((one) => one.type === "run.ended" && one.data?.run_id === id);
  /** Every run.ended told up to now: a run started after this point is told ended after them (the server tells ends in
   *  the order the store's change feed has them), so its notice is a fence for every end before it. */
  let fences = 0;
  const toldUpToNow = async () => {
    const id = `fence-${++fences}`;
    await start(id);
    await endedPast(id);
    await hook.when((got) => got.some((one) => JSON.parse(one.body).type === "run.ended" && JSON.parse(one.body).data?.run_id === id), `${id}'s run.ended`);
  };
  return { api, store, hook, hold, beforeEnd, restart, endedPast, start, grade, get, listed, timeline, endsTold, toldUpToNow };
}

/** The two look-backs: a graded run's feedback round, and a fresh run's own end-of-run step. `open(w, id)` brings run `id`
 *  to its look-back, held, and answers what its job's end was (`ended_at`, `result`: the job's, null for a fresh run, whose
 *  end is first read mid-look-back), the epoch its look-back's claim is past, and the hold. */
const LOOK_BACKS = {
  "a graded run's feedback round": async (w, id) => {
    await w.start(id);
    const first = await w.endedPast(id);
    const job = await w.get(id);
    assert.equal(job.status, "completed", JSON.stringify(job));
    // The job's own end is told once before the grade.
    await w.toldUpToNow();
    const held = w.hold();
    await w.grade(id);
    await held.entered;
    return { job: { ended_at: job.ended_at, result: job.result }, above: first.epoch, held };
  },
  "a fresh run's own look-back": async (w, id) => {
    const held = w.hold();
    await w.start(id);
    await held.entered;
    return { job: null, above: 0, held };
  },
};

for (const [name, open] of Object.entries(LOOK_BACKS)) {
  test(`${name}: GET, the list and the timeline read the job's end while it looks back, completed with its answer and end time; nothing is final until the look-back ends`, { timeout: 120_000 }, async (t) => {
    const w = await world(t);
    const { job, above, held } = await open(w, "run-read");
    const mid = await w.get("run-read");
    assert.deepEqual([mid.status, mid.state], ["completed", "idle"], `read completed while it looks back: ${JSON.stringify({ status: mid.status, state: mid.state, ended_at: mid.ended_at })}`);
    assert.ok(mid.ended_at, "with its end time");
    assert.equal(mid.result?.final_answer, AGENT_SAYS, `with its answer: ${JSON.stringify(mid.result)}`);
    if (job) assert.deepEqual([mid.ended_at, mid.result], [job.ended_at, job.result], "the job's end, as it read before the grade");
    assert.equal(mid.learning?.state, "reflecting", `its learning reads reflecting: ${JSON.stringify(mid.learning)}`);
    assert.equal(mid.poll_after_ms, 1000, "not settled: a poll or a stream stays open for the look-back's rows");
    const item = await w.listed("run-read");
    assert.deepEqual([item?.status, item?.ended_at], ["completed", mid.ended_at], `the list reads it so: ${JSON.stringify(item)}`);
    const page = await w.timeline("run-read");
    assert.deepEqual([page.status, page.final], ["completed", false], "the timeline reads it so, still open");

    held.release();
    await w.endedPast("run-read", above);
    const after = await w.get("run-read");
    assert.deepEqual([after.status, after.ended_at, after.result], ["completed", mid.ended_at, mid.result], "its end stands as it was read while it looked back");
    assert.equal(after.poll_after_ms, 0);
    assert.equal((await w.timeline("run-read")).final, true);
  });

  test(`${name}: a person's stop and cancel are refused while it looks back, as for any ended run; its end stands`, { timeout: 120_000 }, async (t) => {
    const w = await world(t);
    const { above, held } = await open(w, "run-stop");
    const mid = await w.get("run-stop");
    const stopped = await w.api("POST", "/runs/run-stop/stop");
    assert.deepEqual([stopped.status, stopped.body.stopped, stopped.body.status], [200, false, "completed"], `the stop is refused: ${JSON.stringify(stopped.body)}`);
    const cancelled = await w.api("POST", "/runs/run-stop/cancel");
    assert.deepEqual([cancelled.status, cancelled.body.cancel_requested, cancelled.body.already_terminal, cancelled.body.status], [202, false, true, "completed"], `the cancel is refused: ${JSON.stringify(cancelled.body)}`);
    assert.deepEqual((await w.store.commands("run-stop", 0)).filter((one) => one.kind === "stop" || one.kind === "cancel"), [], "neither wrote a row");

    held.release();
    const row = await w.endedPast("run-stop", above);
    assert.deepEqual([row.state, row.outcome], ["ended", null], "the run ended on its job's end");
    const after = await w.get("run-stop");
    assert.deepEqual([after.status, after.ended_at, after.result], ["completed", mid.ended_at, mid.result]);
  });

  test(`${name}: a cancel the runner takes while it looks back cuts the look-back alone: the run ends on its job's end, never cancelled`, { timeout: 120_000 }, async (t) => {
    const w = await world(t);
    const { above } = await open(w, "run-cut");
    const mid = await w.get("run-cut");
    // A row that raced the read which would have refused it: the runner takes it, and its stop cuts the held step.
    const cancel = await w.store.command("run-cut", { kind: "cancel" });
    const row = await w.endedPast("run-cut", above);
    assert.deepEqual([row.state, row.outcome], ["ended", null], `the run ended on its job's end, not cancelled: ${JSON.stringify({ state: row.state, outcome: row.outcome, summary: row.summary })}`);
    assert.equal(row.endedAt, Date.parse(mid.ended_at), "at its end's own time");
    const after = await w.get("run-cut");
    assert.deepEqual([after.status, after.ended_at, after.result], ["completed", mid.ended_at, mid.result]);
    const taken = (await w.store.commands("run-cut", 0)).find((one) => one.id === cancel.id);
    assert.ok(taken?.takenAt, `the cancel's row is answered: ${JSON.stringify(taken)}`);
  });

  test(`${name}: a cancel landing as the end commits leaves the job's end standing`, { timeout: 120_000 }, async (t) => {
    const w = await world(t);
    const { above, held } = await open(w, "run-race");
    const mid = await w.get("run-race");
    let cancel;
    // As the end is written: the row lands, and the runner's command poll hands it on before the commit.
    w.beforeEnd(async () => {
      cancel = await w.store.command("run-race", { kind: "cancel" });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    held.release();
    const row = await w.endedPast("run-race", above);
    assert.ok(cancel, "the cancel landed as the end was written");
    assert.deepEqual([row.state, row.outcome], ["ended", null], `the run ended on its job's end, not cancelled: ${JSON.stringify({ state: row.state, outcome: row.outcome, summary: row.summary })}`);
    assert.equal(row.endedAt, Date.parse(mid.ended_at));
    const after = await w.get("run-race");
    assert.deepEqual([after.status, after.ended_at, after.result], ["completed", mid.ended_at, mid.result]);
    assert.ok((await w.store.commands("run-race", 0)).find((one) => one.id === cancel.id)?.takenAt, "the cancel's row is answered");
  });

  test(`${name}: a message while it looks back does what a message to a completed run does: a follow-up turn once the end is in`, { timeout: 120_000 }, async (t) => {
    const w = await world(t);
    const { above, held } = await open(w, "run-message");
    const sent = await w.api("POST", "/runs/run-message/messages", { content: FOLLOW_UP });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    assert.equal(sent.body.mode, "follow_up", `a follow-up, as to a completed run: ${JSON.stringify(sent.body)}`);
    assert.notEqual(sent.body.status, "completed", "a run with a message waiting reads as going on, as a completed run a message opened again does");
    held.release();
    const followed = await until(async () => {
      const read = await w.get("run-message");
      return read.status === "completed" && read.result?.final_answer === FOLLOWED && read;
    }, "the follow-up answered");
    const rows = (await w.timeline("run-message")).rows ?? [];
    assert.deepEqual(rows.filter((one) => one.kind === "user_message" && one.text === FOLLOW_UP).length, 1, "the message is on its record once, as the person's");
    assert.ok(followed.ended_at, "the follow-up's end");
    assert.ok((await w.store.runs.get("run-message")).epoch > above + 1, "a claim of its own ran the follow-up");
  });

  test(`${name}: the run is told ended once, at the end time read while it looked back`, { timeout: 120_000 }, async (t) => {
    const w = await world(t);
    const { above, held } = await open(w, "run-told");
    const mid = await w.get("run-told");
    held.release();
    await w.endedPast("run-told", above);
    await w.toldUpToNow();
    const told = w.endsTold("run-told");
    assert.deepEqual(told.map((one) => [one.data.status, one.timestamp !== undefined]), [["completed", true]], `one run.ended: ${JSON.stringify(told)}`);
    const row = await w.store.runs.get("run-told");
    assert.equal(new Date(row.endedAt).toISOString(), mid.ended_at, "its marker, the end time, is the one read while it looked back");
  });

  test(`${name}: a grade while it looks back is 409 run_learning, nothing kept; the same grade is taken once the look-back ends`, { timeout: 120_000 }, async (t) => {
    const w = await world(t);
    const { above, held } = await open(w, "run-grade");
    const graded = async () => (await w.api("GET", "/runs/run-grade/learning")).body.graded ?? null;
    const before = await graded();
    const refused = await w.api("PUT", "/runs/run-grade/grade", { correct: true });
    assert.deepEqual([refused.status, refused.body.error?.code], [409, "run_learning"], `the grade waits for the look-back's end: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body.error.message, /still learning from its answer: grade it once that ends/);
    assert.deepEqual(await graded(), before, "nothing kept");
    held.release();
    await w.endedPast("run-grade", above);
    const taken = await w.api("PUT", "/runs/run-grade/grade", { correct: true });
    assert.equal(taken.status, 200, `taken once it ended: ${JSON.stringify(taken.body)}`);
    assert.equal((await graded())?.correct, true);
  });

  test(`${name}: a runner lost before the look-back's first ask leaves the next claim the job's end at its time, never a later one`, { timeout: 120_000 }, async (t) => {
    const w = await world(t);
    await open(w, "run-lost");
    // Held before its first ask: the job's end is kept, no request of the look-back's is written yet.
    const mid = await w.get("run-lost");
    const lost = (await w.store.runs.get("run-lost")).epoch;
    // Past the kept end's millisecond, so an end written again now reads later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await w.restart();
    const row = await w.endedPast("run-lost", lost);
    assert.deepEqual([row.state, row.outcome], ["ended", null], `the run ended on its job's end: ${JSON.stringify({ state: row.state, outcome: row.outcome, summary: row.summary })}`);
    assert.equal(new Date(row.endedAt).toISOString(), mid.ended_at, "at the end time read while it looked back");
    const after = await w.get("run-lost");
    assert.deepEqual([after.status, after.ended_at, after.result], ["completed", mid.ended_at, mid.result]);
  });
}

// The end-commit race in the store (run-patch.ts refuseLeftovers): an end that keeps the job's end (`keepsEnd`) is the
// job's, so a cancel waiting at its commit is refused, never the end's; a message waiting there still opens the run again
// as its next turn, and a cancel waiting beside such a message is the message's run's, which it ends cancelled.
test("an end that keeps the job's end refuses a cancel waiting at its commit; a message waiting there still opens it again", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "look-back-commit-"));
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "a1", name: "Agent one" }, { id: "r1", kind: "agentic", body: { instructions: "Answer.", tools: [] } });
  const kept = Date.now() - 60_000;
  const ending = async (id, rows) => {
    await store.runs.create({ id, agentId: "a1", revisionId: "r1" });
    const claim = await store.claim(id, "runner-a", { leaseMs: 30_000 });
    for (const row of rows) await store.command(id, row);
    await store.runs.update(claim, { state: "ended", summary: null, endedAt: kept, keepsEnd: true });
    return { row: await store.runs.get(id), commands: await store.commands(id, 0) };
  };
  const cancelled = await ending("run-cancel", [{ kind: "cancel" }]);
  assert.deepEqual([cancelled.row.state, cancelled.row.outcome, cancelled.row.endedAt], ["ended", null, kept], `the job's end stands: ${JSON.stringify(cancelled.row)}`);
  assert.ok(cancelled.commands.every((one) => one.refused !== null), `the cancel is refused: ${JSON.stringify(cancelled.commands)}`);
  const messaged = await ending("run-message", [{ kind: "steer", body: { text: "And twice that?" } }]);
  assert.deepEqual([messaged.row.state, messaged.row.endedAt], ["running", null], "a message waiting opens it again, as for any completed run");
  assert.deepEqual(messaged.commands.map((one) => [one.kind, one.takenAt]), [["steer", null]], "its message waits for the next claim");
  const both = await ending("run-both", [{ kind: "steer", body: { text: "And twice that?" } }, { kind: "cancel" }]);
  assert.deepEqual([both.row.state, both.row.outcome], ["stopped", "cancelled"], "a cancel beside a waiting message is that message's run's: it ends cancelled");
});
