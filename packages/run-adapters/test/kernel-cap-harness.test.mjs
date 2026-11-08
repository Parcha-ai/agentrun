// The kernel cap is the same for every harness: pi's requests go through createCap, the CLI harnesses' (claude-agent,
// codex, opencode) through the runner's booking with beforeRequestOf, and both decide by the one rule, capRule.judge,
// exactly once per decision. The same request figures get the same admission, the same refusal in the same words, and
// the same wrap-up note in the same words, whichever harness sends them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPortFor } from "@parcha/agentrun-kernel";
import { fauxAdapter, memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { beforeRequestOf, capRule, CapRefused, createCap, noteFor } from "../dist/kernel/cap/index.js";
import { SONNET, T0 } from "./kernel-cap-support.mjs";

const models = { [SONNET.id]: SONNET };
/** The CLI harnesses' request shapes: what each asks for and needs at least, as its model proxy's policy reads them. */
const SHAPES = {
  "claude-agent": { outputTokensAsked: 32_000, outputTokensLeast: 1_024 },
  codex: { outputTokensAsked: 16_384, outputTokensLeast: 1_024 },
  opencode: { outputTokensAsked: 8_192, outputTokensLeast: 1_024 },
};

/** A CLI session of `shape` under `capUsd`: the runner's booking with beforeRequestOf, and the faux harness sending `script`. */
async function cliSession(capUsd, script, { spentUsd } = {}) {
  const store = memorySessionStore();
  const spec = { key: "step:cap", label: "cap", system: ["Answer."], tools: [], context: "fresh" };
  const writer = await store.open(spec.key);
  const tickets = [];
  // The faux harness names its own session model: priced here as Sonnet, as pi's requests are.
  const before = beforeRequestOf({ capUsd: () => capUsd, modelOf: () => SONNET, now: () => T0 });
  const booking = await modelPortFor(writer, { key: spec.key, beforeRequest: async (r) => {
    const answer = await before({ ...r, spentUsd: spentUsd ?? r.spentUsd });
    tickets.push(answer);
    return answer;
  } });
  const adapter = fauxAdapter({ script: () => script });
  const session = await adapter.open(spec, { store, writer, models: booking.models, signal: new AbortController().signal, onEvent: () => {} });
  await session.send("go");
  const end = await session.turnEnd();
  await session.close();
  return { end, tickets, adapter };
}

test("every decision passes through capRule.judge exactly once, on createCap.admit and on beforeRequestOf", async (t) => {
  const original = capRule.judge;
  let calls = 0;
  capRule.judge = (...args) => (calls++, original(...args));
  t.after(() => (capRule.judge = original));
  const cap = createCap({ capUsd: () => 1, now: () => T0 });
  await cap.admit({ kind: "model", id: "r1", model: SONNET, inputTokens: 1_000, outputAsked: 1_000 });
  assert.equal(calls, 1, "createCap.admit");
  await assert.rejects(cap.admit({ kind: "model", id: "r2", model: SONNET, inputTokens: 1_000_000, outputAsked: 1_000 }), CapRefused);
  assert.equal(calls, 2, "a refusal is a decision too");
  const before = beforeRequestOf({ capUsd: () => 1, modelOf: (id) => models[id], now: () => T0 });
  await before({ model: SONNET.id, spentUsd: 0, inFlight: [], inputTokensMax: 1_000, outputTokensAsked: 1_000, turn: 1, maxTurns: null, key: "k", label: "k" });
  assert.equal(calls, 3, "beforeRequestOf");
});

for (const [harness, shape] of Object.entries(SHAPES)) {
  test(`${harness}: the same request figures get the same admission as pi's, its output clamped to what is left`, async () => {
    const capUsd = 0.1;
    const pi = await createCap({ capUsd: () => capUsd, now: () => T0 }).admit({ kind: "model", id: "pi-1", model: SONNET, inputTokens: 10_000, outputAsked: shape.outputTokensAsked, outputTokensLeast: shape.outputTokensLeast });
    const { tickets } = await cliSession(capUsd, [{ say: "done", usd: 0.01, inputTokensMax: 10_000, ...shape }, { end: true }]);
    assert.equal(tickets[0].outputTokensMax, pi.outputTokensMax);
    assert.ok(Math.abs(tickets[0].holdUsd - pi.heldUsd) < 1e-12);
  });

  test(`${harness}: a refusal for room says the same words as pi's at the same figures, and is final: one request, no second attempt`, async () => {
    const capUsd = 0.05;
    const pi = await createCap({ capUsd: () => capUsd, now: () => T0 }).admit({ kind: "model", id: "pi-1", model: SONNET, inputTokens: 10_000, outputAsked: shape.outputTokensAsked, outputTokensLeast: shape.outputTokensLeast }).catch((error) => error);
    assert.ok(pi instanceof CapRefused);
    const { end, tickets, adapter } = await cliSession(capUsd, [{ say: "never sent", usd: 0.01, inputTokensMax: 10_000, ...shape }, { end: true }]);
    assert.equal(tickets[0].refuse, pi.message);
    assert.equal(end.status, "failed");
    assert.equal(adapter.requests, 0, "the refused request was never sent, nor tried again");
  });
}

for (const [harness, shape] of Object.entries(SHAPES)) {
  test(`${harness}: with a priced tool in play, a request sees the tool's hold and then its charge, as pi's does: the same refusal, then the same admission`, async () => {
    const capUsd = 0.1;
    const ask = { kind: "model", model: SONNET, inputTokens: 10_000, outputAsked: shape.outputTokensAsked, outputTokensLeast: shape.outputTokensLeast };
    // pi: the tool and the request on createCap's one ledger.
    const pi = createCap({ capUsd: () => capUsd, now: () => T0 });
    await pi.admit({ kind: "tool", id: "tool-1", name: "monid_run", holdUsd: 0.06, basis: "its quote" });
    const piRefused = await pi.admit({ ...ask, id: "pi-1" }).catch((error) => error);
    await pi.settle("tool-1", { end: "charged", usd: 0.01 });
    const piAdmitted = await pi.admit({ ...ask, id: "pi-2" });
    // The CLI harness: the runner's model spend, and the host's tool charges and holds passed in.
    const tools = { spent: 0, held: 0.06 };
    const before = beforeRequestOf({ capUsd: () => capUsd, modelOf: () => SONNET, now: () => T0, spentUsd: () => tools.spent, heldUsd: () => tools.held });
    const request = { key: "k", label: "k", model: SONNET.id, turn: 1, maxTurns: null, spentUsd: 0, inFlight: [], inputTokensMax: 10_000, ...shape };
    const refused = await before(request);
    assert.equal(refused.refuse, piRefused.message, "the same refusal while the tool holds");
    Object.assign(tools, { spent: 0.01, held: 0 });
    const admitted = await before(request);
    assert.equal(admitted.outputTokensMax, piAdmitted.outputTokensMax, "the same admission once it is charged");
    assert.ok(Math.abs(admitted.holdUsd - piAdmitted.heldUsd) < 1e-12);
  });
}

test("a CLI request when the host's tool charges are unknown (null) is refused for good as an unknown spend, never judged on the runner's spend alone", async () => {
  const before = beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, now: () => T0, spentUsd: () => null });
  const answer = await before({ key: "k", label: "k", model: SONNET.id, turn: 1, maxTurns: null, spentUsd: 0, inFlight: [], inputTokensMax: 1_000, outputTokensAsked: 1_024 });
  assert.equal(answer.refuse, "spend_cap_reached: Not sent: what the run has spent is unknown, so its cap of $1 cannot be kept: the run is out of budget.");
});

const ASK = { key: "k", label: "k", model: SONNET.id, turn: 1, maxTurns: null, spentUsd: 0, inFlight: [], inputTokensMax: 1_000, outputTokensAsked: 1_024 };
const UNKNOWN_SPEND = "spend_cap_reached: Not sent: what the run has spent is unknown, so its cap of $1 cannot be kept: the run is out of budget.";
const UNKNOWN_HELD = "spend_cap_reached: Not sent: what the run's steps still running hold is unknown, so its cap of $1 cannot be kept: the run is out of budget.";
const UNMEASURED = "spend_cap_reached: Not sent: the size of the next model request's input is unknown, so the run's cap of $1 cannot be kept: the run is out of budget.";

test("a CLI request when the host's tool holds are unknown (the held hook says null, or nothing) is refused for good as an unknown hold, never judged as $0 held", async () => {
  for (const held of [null, undefined]) {
    const before = beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, now: () => T0, spentUsd: () => 0, heldUsd: () => held });
    assert.equal((await before(ASK)).refuse, UNKNOWN_HELD, `held ${held}`);
  }
});

test("a spent hook's figure that is not a finite figure of 0 or more frees no room: a negative, NaN or Infinity spend is refused as an unknown spend", async () => {
  for (const figure of [-100, Number.NaN, Number.POSITIVE_INFINITY]) {
    const before = beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, now: () => T0, spentUsd: () => figure });
    assert.equal((await before(ASK)).refuse, UNKNOWN_SPEND, `spent ${figure}`);
  }
});

test("a held hook's figure that is not a finite figure of 0 or more frees no room: a negative, NaN or Infinity hold is refused as an unknown hold", async () => {
  for (const figure of [-100, Number.NaN, Number.POSITIVE_INFINITY]) {
    const before = beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, now: () => T0, spentUsd: () => 0, heldUsd: () => figure });
    assert.equal((await before(ASK)).refuse, UNKNOWN_HELD, `held ${figure}`);
  }
});

test("the runner's own spend as NaN, Infinity or below 0 is refused as an unknown spend, in words with no NaN", async () => {
  const before = beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, now: () => T0 });
  for (const spentUsd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const answer = await before({ ...ASK, spentUsd });
    assert.equal(answer.refuse, UNKNOWN_SPEND, `runner spent ${spentUsd}`);
  }
});

test("a request in flight whose hold is below 0 frees no room: it counts at its worst case, and with no measure it is refused as unmeasured", async () => {
  const before = beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, now: () => T0 });
  const answer = await before({ ...ASK, turn: 2, spentUsd: 0.99, inFlight: [{ turn: 1, model: SONNET.id, holdUsd: -100 }] });
  assert.equal(answer.refuse, UNMEASURED);
});

test("a request in flight with no hold, no output limit and a model with priced output but no ceiling cannot be counted: refused, never priced at 0 output", async () => {
  const open = { ...SONNET, id: "open-ended", outputCeiling: null };
  const before = beforeRequestOf({ capUsd: () => 1, modelOf: (id) => (id === open.id ? open : SONNET), now: () => T0 });
  const answer = await before({ ...ASK, turn: 2, spentUsd: 0.9, inFlight: [{ turn: 1, model: open.id, inputTokensMax: 1_000 }] });
  assert.equal(answer.refuse, UNMEASURED);
});

test("a CLI request beside one in flight with no hold and no measured input is refused for good as unmeasured, never held at Infinity", async () => {
  const before = beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, now: () => T0 });
  const answer = await before({ key: "k", label: "k", model: SONNET.id, turn: 2, maxTurns: null, spentUsd: 0, inFlight: [{ turn: 1, model: SONNET.id }], inputTokensMax: 10, outputTokensAsked: 1_024 });
  assert.equal(answer.refuse, "spend_cap_reached: Not sent: the size of the next model request's input is unknown, so the run's cap of $1 cannot be kept: the run is out of budget.");
  assert.doesNotMatch(answer.refuse, /Infinity/);
});

test("pi and every CLI harness under the same $0.10, the first request due at step 0: the same note, in the same words, in request 1", () => {
  const ask = (shape) => ({ kind: "model", id: "r", model: SONNET, inputTokens: 10_000, outputAsked: shape.outputTokensAsked, outputTokensLeast: shape.outputTokensLeast });
  const pi = createCap({ capUsd: () => 0.1, now: () => T0 }).note(ask(SHAPES["claude-agent"]));
  assert.ok(pi);
  for (const [harness, shape] of Object.entries(SHAPES)) {
    const cli = noteFor(ask(shape), { capUsd: 0.1, spentUsd: 0, heldUsd: 0, costs: [], told: false, mode: "expected", now: T0 });
    assert.equal(cli?.words, pi.words, harness);
  }
});

test("a CLI harness: priced output with no ceiling refused, free output passes, with no cap no refusal", async () => {
  const unbounded = { ...SONNET, id: "unbounded", outputCeiling: null };
  const free = { ...SONNET, id: "free-out", price: { input: 3, output: 0 }, outputCeiling: null };
  const before = (capUsd) => beforeRequestOf({ capUsd: () => capUsd, modelOf: (id) => ({ unbounded, "free-out": free })[id], now: () => T0 });
  const asked = (model) => ({ model, spentUsd: 0, inFlight: [], inputTokensMax: 1_000, turn: 1, maxTurns: null, key: "k", label: "k" });
  assert.match((await before(10)(asked("unbounded"))).refuse, /no output ceiling/);
  assert.equal((await before(10)(asked("free-out"))).refuse, undefined);
  assert.equal(await before(undefined)(asked("unbounded")), undefined);
});

test("a CLI request in flight is held at the limit it was admitted with: a second one beside it sees that hold", async () => {
  const before = beforeRequestOf({ capUsd: () => 0.1, modelOf: (id) => models[id], now: () => T0, mode: "strict" });
  const first = await before({ model: SONNET.id, spentUsd: 0, inFlight: [], inputTokensMax: 10_000, outputTokensAsked: 2_000, turn: 1, maxTurns: null, key: "k", label: "k" });
  const second = await before({ model: SONNET.id, spentUsd: 0, inFlight: [{ turn: 1, model: SONNET.id, inputTokensMax: 10_000, outputTokensMax: first.outputTokensMax, holdUsd: first.holdUsd }], inputTokensMax: 10_000, outputTokensAsked: 2_000, turn: 2, maxTurns: null, key: "k", label: "k" });
  assert.match(second.refuse ?? "", /holds \$0\.07 for steps still running/);
});
