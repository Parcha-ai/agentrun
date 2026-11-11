// A paid step `owed` (money its provider is already owed, incurred outside any call: a browser session's release, its
// top-up, the time a person used): booked and HELD like any paid step and counted in the run's spend; only the rule's
// judge is skipped, so a run past its cap, or of unknown spend, still books it. Every refusable step after it (a model
// request, a paid call) sees it and is refused past the cap as usual.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import * as cap from "../dist/kernel/cap/index.js";

const T0 = Date.parse("2026-11-10T02:00:00Z");
const MODEL_SESSION = "run:run-1";
/** A model at $1 a million input tokens, its output free. */
const MODEL = { id: "m", api: "anthropic", price: { input: 1, output: 0 }, outputCeiling: 100 };
const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);
const capOf = (store, capUsd) => cap.runCap({ sessions: store, capUsd: () => capUsd, mode: "expected", now: () => T0, modelOf: (id) => (id === MODEL.id ? MODEL : undefined) });
/** The run's model spend as its booking keeps it: a model request answered at `usd`. */
async function modelSpent(store, usd) {
  const writer = await store.open(MODEL_SESSION);
  await writer.append([{ kind: RUNNER_RECORDS.request, data: { turn: 1, model: MODEL.id, heldUsd: usd } }, { kind: RUNNER_RECORDS.turn, data: { turn: 1, usd, bookedUsd: usd } }]);
}
const release = { id: "s1@release#1", name: "this browser session's time", holdUsd: 0, basis: "browserbase's session time, billed as it was charged", chargedBy: "browserbase", tool: "browser", tag: "s1" };

test("an owed release past the cap is booked and counted; the next model request is refused at the cap with it counted", async () => {
  const store = memorySessionStore();
  // The run's model spend, $0.61, already past its $0.6005 cap (a model's actual cost above its expected hold).
  await modelSpent(store, 0.61);
  const run = capOf(store, 0.6005);
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  // Refusable, the same step is refused.
  const asked = await tools.admit(release).then(() => undefined, (error) => error);
  assert.ok(asked instanceof cap.CapRefused, `a refusable $0 step past the cap is refused: ${asked ?? "admitted"}`);
  // Owed: booked however the run's spend stands, and settled at its charge.
  await tools.admit({ ...release, id: "s1@release#2", owed: true });
  await tools.settle("s1@release#2", 0.002);
  near(tools.spentUsd(), 0.002, "the release counts in the run's paid spend");
  const records = (await store.read(cap.TOOL_SESSION)).filter((r) => r.kind === RUNNER_RECORDS.request).map((r) => r.data);
  assert.deepEqual(records.map(({ owed, tool, tag }) => ({ owed, tool, tag })), [{ owed: true, tool: "browser", tag: "s1" }], "its record says it was owed, and names its tool and session");
  // The next model request: refused at the cap, its figures the run's spend with the release in it.
  const next = await run.before({ key: MODEL_SESSION, label: MODEL_SESSION, model: MODEL.id, turn: 2, maxTurns: null, spentUsd: 0, inputTokensMax: 100 });
  assert.ok(next && "refuse" in next, `the next model request is refused at the cap: ${JSON.stringify(next)}`);
  near(next.figures?.spentUsd, 0.61 + 0.002, "its figures count the release");
});

test("an owed hold is HELD: a refusable step beside it is refused for the room it takes, and it is booked even when the run's spend is unknown", async () => {
  const store = memorySessionStore();
  const run = capOf(store, 1);
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  const held = await tools.admit({ ...release, id: "s1@reserve#1", name: "this browser session's reserve", holdUsd: 0.9, owed: true });
  near(held.heldUsd, 0.9, "held at its figure");
  near(tools.heldUsd(), 0.9, "the run holds it");
  const call = await tools.admit({ id: "c1#1", name: "this browser call", holdUsd: 0.2, basis: "a stretch", call: "c1" }).then(() => undefined, (error) => error);
  assert.ok(call instanceof cap.CapRefused && call.forGood === false, `a call that does not fit beside it is refused for room: ${call ?? "admitted"}`);
  // A spend no one knows (a model answer of unknown cost): a refusable step is refused for good, an owed one booked.
  const writer = await store.open(MODEL_SESSION);
  await writer.append([{ kind: RUNNER_RECORDS.request, data: { turn: 1, model: MODEL.id } }, { kind: RUNNER_RECORDS.turn, data: { turn: 1, usd: null } }]);
  const unknown = await tools.admit({ ...release, id: "s1@release#3" }).then(() => undefined, (error) => error);
  assert.ok(unknown instanceof cap.CapRefused && unknown.forGood === true, `refusable: refused for good: ${unknown ?? "admitted"}`);
  await tools.admit({ ...release, id: "s1@release#4", owed: true });
  await tools.settle("s1@release#4", 0.001);
  near(tools.spentUsd(), 0.001, "owed: booked");
});

test("an owed step with no figure is no money: refused for good, as any hold that is not a figure", async () => {
  const store = memorySessionStore();
  const tools = await capOf(store, 1).tools(await store.open(cap.TOOL_SESSION));
  const refused = await tools.admit({ ...release, id: "s1@release#5", holdUsd: Number.NaN, owed: true }).then(() => undefined, (error) => error);
  assert.ok(refused instanceof cap.CapRefused && refused.forGood === true, `refused for good: ${refused ?? "admitted"}`);
});

// A hold-only step (`hold`): money reserved, not spent. While its claim holds it, it is held like any step (refusable
// steps beside it see it); a claim lost with it open gives it back on the next claim, never booked as cut. Every other cut
// step keeps today's rule: a model request cut by the same lost claim still books as cut, at its hold.
test("a lost claim's hold-only step is given back by the next claim, while a cut model request of the same run still books as cut", async () => {
  const store = memorySessionStore();
  const run = capOf(store, 1);
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  await tools.admit({ ...release, id: "s1@reserve#1", name: "this browser session's reserve", holdUsd: 0.4, hold: true });
  const beside = await tools.admit({ id: "c1#1", name: "this browser call", holdUsd: 0.7, basis: "a stretch", call: "c1" }).then(() => undefined, (error) => error);
  assert.ok(beside instanceof cap.CapRefused, `held while its claim holds it: a call beside it does not fit: ${beside ?? "admitted"}`);
  // A model request of the same claim, admitted and never answered: the claim is lost with both open.
  const writer = await store.open(MODEL_SESSION);
  await writer.append([{ kind: RUNNER_RECORDS.request, data: { turn: 1, model: MODEL.id, heldUsd: 0.05 } }]);
  // The next claim: the hold is given back, the model request booked cut at its hold.
  const next = capOf(store, 1);
  const tools2 = await next.tools(await store.open(cap.TOOL_SESSION));
  near(tools2.spentUsd(), 0, "the reserve is given back: no spend");
  const turns = (await store.read(cap.TOOL_SESSION)).filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => r.data);
  assert.deepEqual(turns, [{ turn: 1, usd: 0, givenBack: true }], "given back, never booked as cut");
  const model = await next.before({ key: MODEL_SESSION, label: MODEL_SESSION, model: MODEL.id, turn: 2, maxTurns: null, spentUsd: 0, inputTokensMax: 100 });
  assert.ok(model && !("refuse" in model), `the next model request fits: ${JSON.stringify(model)}`);
  const cut = await cap.runCap({ sessions: store, capUsd: () => 0.04, mode: "expected", now: () => T0, modelOf: (id) => (id === MODEL.id ? MODEL : undefined) }).before({ key: MODEL_SESSION, label: MODEL_SESSION, model: MODEL.id, turn: 2, maxTurns: null, spentUsd: 0, inputTokensMax: 100 });
  assert.ok(cut && "refuse" in cut, `the cut model request still counts at its hold: ${JSON.stringify(cut)}`);
  near(cut.figures?.spentUsd, 0.05, "its figures: the cut request at its hold, the reserve none");
});

test("a ref names one booking: a second admit of it, on this claim or a later one, books nothing", async () => {
  const store = memorySessionStore();
  const tools = await capOf(store, 1).tools(await store.open(cap.TOOL_SESSION));
  const owed = { ...release, id: "a#1", owed: true, ref: "browser:s1@2026-11-10T02:00:00.000Z/final" };
  const first = await tools.admit(owed);
  assert.equal(first.booked, undefined, "the first admit books it");
  await tools.settle("a#1", 0.0014);
  const again = await tools.admit({ ...owed, id: "a#2" });
  assert.equal(again.booked, true, "the same claim's second admit books nothing");
  const later = await (await capOf(store, 1).tools(await store.open(cap.TOOL_SESSION))).admit({ ...owed, id: "a#3" });
  assert.equal(later.booked, true, "a later claim's books nothing either");
  near((await capOf(store, 1).tools(await store.open(cap.TOOL_SESSION))).spentUsd(), 0.0014, "booked once");
});
