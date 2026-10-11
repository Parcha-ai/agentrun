// The placement question: one typed choice over the environments the server offers, one criterion line each, the latency
// measured around the call, the probabilities as the answer gave them. An answer that cannot be shown on a decision card (a
// choice nobody offered, no probabilities) is an error, never a guess.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgePlacer, PLACEMENT_QUESTIONS, type JudgeRunner } from "../placement.ts";

const criteria = { tab: "the tab", "modal-gpu": "an H100", "modal-vm": "a VM" };
const labels = { tab: "Browser", "modal-gpu": "H100 GPU", "modal-vm": "Modal VM" };

describe("the placer over a judge runner", () => {
  it("asks one choice question per phase, only about the offered environments, and times the call", async () => {
    const asked: Parameters<JudgeRunner>[0][] = [];
    let t = 1_000;
    const placer = judgePlacer({
      criteria,
      labels,
      model: "jev",
      now: () => (t += 120),
      runJudge: async (params) => {
        asked.push(params);
        return { answers: { where: { type: "choice", choice: "modal-gpu", probabilities: { tab: 0.02, "modal-gpu": 0.94 } } }, model: "jev-latest" };
      },
    });
    const d = await placer.decide({ phase: "start", message: "teach it to walk", current: "tab", environments: ["tab", "modal-gpu"] });
    assert.equal(asked.length, 1);
    assert.deepEqual(Object.keys(asked[0]!.questions.where!.criteria), ["tab", "modal-gpu"], "the VM is not offered, so not asked about");
    assert.equal(asked[0]!.questions.where!.instructions, PLACEMENT_QUESTIONS.start);
    assert.deepEqual(asked[0]!.state, { task: "teach it to walk", running_now_in: "tab" });
    assert.equal(d.choice, "modal-gpu");
    assert.equal(d.latency_ms, 120);
    assert.equal(d.model, "jev");
    assert.deepEqual(d.options.map((o) => [o.id, o.label, o.probability]), [["tab", "Browser", 0.02], ["modal-gpu", "H100 GPU", 0.94]]);
    assert.equal(placer.describe("modal-gpu"), "an H100");

    await placer.decide({ phase: "done", message: "teach it to walk", current: "modal-gpu", environments: ["tab", "modal-gpu"] });
    assert.equal(asked[1]!.questions.where!.instructions, PLACEMENT_QUESTIONS.done);
    assert.match(JSON.stringify(asked[1]!.state), /the agent finished the task/);
  });

  it("refuses an answer it cannot show: a choice nobody offered, no probabilities, one outside 0 to 1", async () => {
    const answering = (answer: unknown): ReturnType<typeof judgePlacer> =>
      judgePlacer({ criteria, labels, model: "jev", runJudge: async () => ({ answers: { where: answer as never } }) });
    const query = { phase: "start" as const, message: "x", current: "tab", environments: ["tab", "modal-gpu"] };
    await assert.rejects(answering({ type: "choice", choice: "modal-vm", probabilities: { tab: 0.5, "modal-gpu": 0.5 } }).decide(query), /not one of tab, modal-gpu/);
    await assert.rejects(answering({ type: "choice", choice: "tab" }).decide(query), /not a choice with probabilities/);
    await assert.rejects(answering({ type: "choice", choice: "tab", probabilities: { tab: 1.5, "modal-gpu": 0 } }).decide(query), /within 0 to 1/);
    await assert.rejects(answering(undefined).decide(query), /not a choice/);
  });

  it("passes the judge's failure on, so the server leaves the run where it is", async () => {
    const placer = judgePlacer({ criteria, labels, model: "jev", runJudge: async () => Promise.reject(new Error("timeout")) });
    await assert.rejects(placer.decide({ phase: "start", message: "x", current: "tab", environments: ["tab"] }), /timeout/);
  });
});
