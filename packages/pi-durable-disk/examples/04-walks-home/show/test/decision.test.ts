import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDecision, percent } from "../decision.ts";

const good = { id: "d1", phase: "start", question: "Where should this run?", options: [{ id: "tab", label: "Browser", probability: 0.02 }, { id: "modal-vm", label: "Modal VM", probability: 0.04 }, { id: "modal-gpu", label: "H100 GPU", probability: 0.94 }], choice: "modal-gpu", latency_ms: 37, model: "jev" };

test("a decision entry is read as the pipe wrote it", () => {
  assert.deepEqual(parseDecision(good), { id: "d1", phase: "start", question: "Where should this run?", options: good.options, choice: "modal-gpu", latencyMs: 37, model: "jev" });
  assert.equal(parseDecision({ ...good, phase: "done", question: "The task is done; where should the agent run now?", model: "scripted" })?.phase, "done");
});

test("anything the card could not show truthfully is refused, not repaired", () => {
  const bad = (over: Record<string, unknown>) => parseDecision({ ...good, ...over });
  assert.equal(bad({ choice: "mars" }), undefined, "the choice is not among the options");
  assert.equal(bad({ latency_ms: Number.NaN }), undefined);
  assert.equal(bad({ latency_ms: -1 }), undefined);
  assert.equal(bad({ latency_ms: "37" }), undefined);
  assert.equal(bad({ options: [good.options[0]] }), undefined, "a decision needs a choice between at least two");
  assert.equal(bad({ options: [...good.options, { id: "tab", label: "Again", probability: 0 }] }), undefined, "an option listed twice");
  assert.equal(bad({ options: [{ ...good.options[0], probability: 1.2 }, good.options[1]!, good.options[2]!] }), undefined, "a probability above 1");
  assert.equal(bad({ options: [{ ...good.options[0], probability: "0.02" }, good.options[1]!, good.options[2]!] }), undefined, "a probability that is a string");
  assert.equal(bad({ id: "" }), undefined);
  assert.equal(bad({ model: "gpt" }), undefined, "only the typed model or an honest stand-in");
  assert.equal(bad({ model: undefined }), undefined, "no model named: not shown as measured by default");
  assert.equal(bad({ phase: "middle" }), undefined);
  assert.equal(parseDecision(null), undefined);
  assert.equal(parseDecision("decision"), undefined);
});

test("a probability is shown as a whole percent, and a tiny one is not shown as zero", () => {
  assert.equal(percent(0.94), "94%");
  assert.equal(percent(0.02), "2%");
  assert.equal(percent(0.004), "<1%");
  assert.equal(percent(0), "0%");
  assert.equal(percent(1), "100%");
});
