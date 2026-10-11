// Who answers a message: the rules (offline: the tab; online without a trained 1B: the cloud), Jev's choice over two options in a
// shuffled order, the confidence gate (low means cloud), and every failure falling back to the cloud with the reason saying so.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRAIN_CRITERIA, BRAIN_QUESTION, brainEvent, brainRouter, gatedBrain, type JudgeRunner } from "../brain-router.ts";

const ONLINE = { online: true, localModel: { id: "gemma-3-1b-it-tools" } };
type Asked = Parameters<JudgeRunner>[0];
const answering = (choice: string, local: number, cloud: number, asked: Asked[] = []): JudgeRunner => async (params) => {
  asked.push(params);
  return { answers: { who: { type: "choice", choice, probabilities: { local, cloud } } }, model: "jev-latest" };
};
const clock = (step = 30) => { let t = 1_000; return () => (t += step); };

describe("the brain router", () => {
  it("offline: the tab answers, by rule, and Jev is not asked", async () => {
    const asked: Asked[] = [];
    const d = await brainRouter({ runJudge: answering("cloud", 0, 1, asked), now: clock() }).decide("make it obsessed with the Golden Gate", { online: false, localModel: { id: "x" } });
    assert.deepEqual({ ...d, ms: 0 }, { brain: "tab-local", reason: "offline: the model in this tab answers", confidence: null, decidedBy: "rule", ms: 0 });
    assert.equal(asked.length, 0);
  });

  it("online with no trained model in the tab: the cloud answers, by rule, and Jev is not asked", async () => {
    const asked: Asked[] = [];
    const d = await brainRouter({ runJudge: answering("local", 1, 0, asked) }).decide("write hello.py", { online: true, localModel: null });
    assert.equal(d.brain, "cloud");
    assert.equal(d.reason, "no trained model in this tab yet");
    assert.equal(d.decidedBy, "rule");
    assert.equal(asked.length, 0);
  });

  it("online with the 1B: one choice question over the two options, the message as its state; Jev picks the tab", async () => {
    const asked: Asked[] = [];
    const d = await brainRouter({ runJudge: answering("local", 0.92, 0.08, asked), now: clock(), random: () => 0.1 }).decide("write hello.py that prints hi", ONLINE);
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.questions.who!.instructions, BRAIN_QUESTION);
    assert.deepEqual(asked[0]!.questions.who!.criteria, BRAIN_CRITERIA);
    assert.deepEqual(asked[0]!.state, { message: "write hello.py that prints hi" });
    assert.deepEqual(d, { brain: "tab-local", reason: "a simple task the model in this tab handles", confidence: 0.92, decidedBy: "jev", ms: 30, probabilities: { local: 0.92, cloud: 0.08 }, choice: "local", judge: "jev-latest" });
  });

  it("Jev picks the cloud: the cloud answers because it needs it, with Jev's probability", async () => {
    const d = await brainRouter({ runJudge: answering("cloud", 0.03, 0.97) }).decide("train yourself a small model", ONLINE);
    assert.equal(d.brain, "cloud");
    assert.equal(d.reason, "this needs the cloud");
    assert.equal(d.confidence, 0.97);
    assert.equal(d.decidedBy, "jev");
  });

  it("low confidence means cloud: Jev leans to the tab under the gate, so the cloud answers and the reason says by how much", async () => {
    const d = await brainRouter({ runJudge: answering("local", 0.62, 0.38) }).decide("refactor the parser", ONLINE);
    assert.equal(d.brain, "cloud");
    assert.equal(d.reason, "Jev leaned to this tab at 62%, under the 70% it takes, so the cloud answers");
    assert.equal(d.confidence, 0.62);
    const gated = await brainRouter({ runJudge: answering("local", 0.62, 0.38), minLocalConfidence: 0.6 }).decide("refactor the parser", ONLINE);
    assert.equal(gated.brain, "tab-local", "the gate is the router's option");
  });

  it("the option order is shuffled per call, and the answer is read by id whatever the order", async () => {
    const asked: Asked[] = [];
    const draws = [0.1, 0.9, 0.49, 0.5];
    const router = brainRouter({ runJudge: answering("local", 0.9, 0.1, asked), random: () => draws.shift()! });
    for (let i = 0; i < 4; i++) assert.equal((await router.decide("write a.txt", ONLINE)).brain, "tab-local");
    assert.deepEqual(asked.map((a) => Object.keys(a.questions.who!.criteria)), [["local", "cloud"], ["cloud", "local"], ["local", "cloud"], ["cloud", "local"]]);
  });

  it("no answer within the timeout: the cloud answers, the reason says so, and the call is aborted", async () => {
    let seen: AbortSignal | undefined;
    const slow: JudgeRunner = (params) => { seen = params.signal; return new Promise(() => {}); };
    const started = Date.now();
    const d = await brainRouter({ runJudge: slow, timeoutMs: 20 }).decide("write a.txt", ONLINE);
    assert.ok(Date.now() - started < 1_000, "it did not wait for the runner");
    assert.deepEqual([d.brain, d.decidedBy, d.confidence], ["cloud", "rule", null]);
    assert.equal(d.reason, "Jev did not answer within 20 ms, so the cloud answers");
    assert.equal(seen?.aborted, true, "the runner's signal is aborted, so its request is cancelled");
  });

  it("a Jev error or an answer it cannot read: the cloud answers and the reason says so", async () => {
    const failing: JudgeRunner = async () => { throw new Error("HTTP 503"); };
    const e = await brainRouter({ runJudge: failing }).decide("write a.txt", ONLINE);
    assert.deepEqual([e.brain, e.decidedBy, e.reason], ["cloud", "rule", "Jev failed (HTTP 503), so the cloud answers"]);
    for (const bad of [{ type: "choice", choice: "gpu", probabilities: { local: 0.5, cloud: 0.5 } }, { type: "choice", choice: "local" }, { type: "choice", choice: "local", probabilities: { local: 1.4, cloud: 0 } }, undefined]) {
      const d = await brainRouter({ runJudge: async () => ({ answers: { who: bad as never } }) }).decide("write a.txt", ONLINE);
      assert.deepEqual([d.brain, d.decidedBy, d.reason], ["cloud", "rule", "Jev's answer was not a choice with probabilities, so the cloud answers"], JSON.stringify(bad));
    }
  });

  it("a caller that cancels gets no decision", async () => {
    const stop = new AbortController();
    const pending = brainRouter({ runJudge: () => new Promise(() => {}), timeoutMs: 5_000 }).decide("write a.txt", ONLINE, stop.signal);
    stop.abort();
    await assert.rejects(pending, /cancelled/);
  });

  it("a caller that cancelled before asking gets no decision, by rule or by Jev, even if the runner never answers", async () => {
    const stop = new AbortController();
    stop.abort();
    let called = 0;
    const router = brainRouter({ runJudge: () => { called++; return new Promise(() => {}); }, timeoutMs: 20 });
    for (const state of [{ online: false, localModel: null }, { online: true, localModel: null }, ONLINE]) {
      await assert.rejects(router.decide("write a.txt", state, stop.signal), /cancelled/, JSON.stringify(state));
    }
    assert.equal(called, 0, "Jev is not asked");
  });

  it("a runner that rejects with something other than an Error still falls back to the cloud", async () => {
    for (const [thrown, why] of [["boom", "boom"], [undefined, "unknown error"], [{ code: 7 }, "unknown error"]] as const) {
      const d = await brainRouter({ runJudge: () => Promise.reject(thrown) }).decide("write a.txt", ONLINE);
      assert.deepEqual([d.brain, d.decidedBy, d.reason], ["cloud", "rule", `Jev failed (${why}), so the cloud answers`], String(thrown));
    }
  });

  it("the gate is one rule: Jev's choice first, then the probability; a cloud choice stays the cloud whatever the numbers", async () => {
    assert.equal(gatedBrain("local", 0.7, 0.7), "tab-local");
    assert.equal(gatedBrain("local", 0.69, 0.7), "cloud");
    assert.equal(gatedBrain("cloud", 0.8, 0.7), "cloud", "Jev chose the cloud; a higher local probability does not override it");
    const d = await brainRouter({ runJudge: answering("cloud", 0.8, 0.2) }).decide("write a.txt", ONLINE);
    assert.deepEqual([d.brain, d.choice], ["cloud", "cloud"]);
  });

  it("each decision is one stage event: who answers, why, how sure, who decided", async () => {
    const labels = { local: "Gemma 3 1B, in this tab", cloud: "gpt-6-luna" };
    const offline = await brainRouter({ runJudge: answering("cloud", 0, 1) }).decide("hi", { online: false, localModel: null });
    assert.deepEqual({ ...brainEvent(offline, labels), ms: 0 }, { event: "brain.decision", brain: "tab-local", answering: "Gemma 3 1B, in this tab", reason: "offline: the model in this tab answers", confidence: null, decidedBy: "rule", ms: 0 });
    const cloud = await brainRouter({ runJudge: answering("cloud", 0.04, 0.96) }).decide("make it obsessed with the Golden Gate Bridge", ONLINE);
    assert.deepEqual({ ...brainEvent(cloud, labels), ms: 0 }, { event: "brain.decision", brain: "cloud", answering: "gpt-6-luna", reason: "this needs the cloud", confidence: 0.96, decidedBy: "jev", ms: 0, probabilities: { local: 0.04, cloud: 0.96 } });
  });

  it("refuses a gate outside (0, 1] and a timeout that is not a positive whole number", () => {
    for (const minLocalConfidence of [0, 1.2, Number.NaN]) assert.throws(() => brainRouter({ runJudge: answering("local", 1, 0), minLocalConfidence }), /minLocalConfidence/);
    for (const timeoutMs of [0, -5, 1.5]) assert.throws(() => brainRouter({ runJudge: answering("local", 1, 0), timeoutMs }), /timeoutMs/);
  });
});
