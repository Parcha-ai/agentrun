// The agent's hand-over of a desktop or a phone to the person (computer_request_handoff): one tool in each kind, under
// that kind's settings key. It asks the run's hold (the hands' handoff port) with what the person should do, how both will
// know it is done, and when the ask expires; it answers once the ask is answered: done, cancelled, or expired, each in
// words. A malformed ask reaches no person.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityToolDefs, createRegistry } from "@parcha/agentrun-kernel/kernel";
import { fakeHandoff, fakeInput, fakePhone, fakeScreen } from "./registry-ports.mjs";
import { localHands } from "./registry-support.mjs";

const TOOL = "computer_request_handoff";
const answer = (text) => async () => ({ text });
const injected = { read: answer("read"), write: answer("write"), edit: answer("edit"), bash: answer("bash") };
const ASK = { instruction: "Sign in to the bank with your own password.", completion_condition: "The account summary page is showing." };
const handsWith = (ports) => ({ ...localHands().hands, ...ports });

test("each of the desktop and the phone has the hand-over, under its own settings key, never replayed; a run with both lists it once", () => {
  for (const kind of ["desktop", "phone"]) {
    const def = capabilityToolDefs(kind).find((one) => one.name === TOOL);
    assert.ok(def, `${kind} has ${TOOL}`);
    assert.deepEqual([def.gateName, def.settingsKey, def.replaySafe], [`host:${kind}/${TOOL}`, kind, false]);
    assert.deepEqual(def.parameters.required, ["instruction", "completion_condition"]);
    assert.deepEqual(Object.keys(def.parameters.properties).sort(), ["completion_condition", "expires_in_s", "instruction"]);
  }
  const both = createRegistry({ maxExecS: 600, shell: "none", kinds: ["desktop", "phone"], executors: injected });
  assert.equal(both.list().filter((def) => def.name === TOOL).length, 1);
});

test("the hand-over asks the hold with the person's instruction, the completion condition and when it expires, and says done in words", async () => {
  const handoff = fakeHandoff({ outcome: "done" });
  const registry = createRegistry({ maxExecS: 600, shell: "none", kinds: ["desktop"], executors: injected });
  const before = Date.now();
  const said = await registry.invoke(TOOL, { ...ASK, expires_in_s: 120 }, { hands: handsWith({ screen: fakeScreen(), input: fakeInput(), handoff }) });
  const after = Date.now();
  assert.equal(said.error, undefined);
  assert.equal(said.text, "The person says the hand-over is done: The account summary page is showing. Look at the screen before you go on: it may have changed.");
  assert.equal(handoff.calls.length, 1);
  const [, request] = handoff.calls[0];
  assert.deepEqual([request.instruction, request.completion_condition], [ASK.instruction, ASK.completion_condition]);
  const at = Date.parse(request.expires_at);
  assert.ok(at >= before + 120_000 && at <= after + 120_000, `expires_at is 120 s after the ask: ${request.expires_at}`);
});

test("cancelled and expired are each said in words; with no expiry given, the ask lasts 600 s", async () => {
  const registry = createRegistry({ maxExecS: 600, shell: "none", kinds: ["phone"], executors: injected });
  const cancelled = await registry.invoke(TOOL, ASK, { hands: handsWith({ phone: fakePhone(), handoff: fakeHandoff({ outcome: "cancelled" }) }) });
  assert.equal(cancelled.text, "The person cancelled the hand-over. Go on without it, or say why you can't.");
  const expiring = fakeHandoff({ outcome: "expired" });
  const before = Date.now();
  const expired = await registry.invoke(TOOL, ASK, { hands: handsWith({ phone: fakePhone(), handoff: expiring }) });
  assert.equal(expired.text, "The agent's hand-over expired: the person did not answer within 600 s. Go on without it, or ask again.");
  assert.ok(Date.parse(expiring.calls[0][1].expires_at) >= before + 600_000, "600 s when none is given");
});

test("a malformed ask reaches no person, and a run whose computer has no hand-over is refused in words naming the setting", async () => {
  const handoff = fakeHandoff();
  const registry = createRegistry({ maxExecS: 600, shell: "none", kinds: ["desktop"], executors: injected });
  const hands = handsWith({ screen: fakeScreen(), input: fakeInput(), handoff });
  assert.equal((await registry.invoke(TOOL, { instruction: "", completion_condition: "x" }, { hands })).error, "instruction is what the person should do, in words");
  assert.equal((await registry.invoke(TOOL, { instruction: "x" }, { hands })).error, "completion_condition is how you and the person will know the step is done, in words");
  assert.equal((await registry.invoke(TOOL, { ...ASK, expires_in_s: 5 }, { hands })).error, "expires_in_s is a whole number of seconds from 30 to 3600");
  assert.equal(handoff.calls.length, 0, "no malformed ask reached the person");
  const none = await registry.invoke(TOOL, ASK, { hands: handsWith({ screen: fakeScreen(), input: fakeInput() }) });
  assert.equal(none.error, `${TOOL} needs a desktop computer: set this agent's computer to desktop (Settings → Computers).`);
});

test("a stop while the person has the computer ends the wait: the call rejects as aborted", async () => {
  const handoff = fakeHandoff({ now: false });
  const registry = createRegistry({ maxExecS: 600, shell: "none", kinds: ["desktop"], executors: injected });
  const stop = new AbortController();
  const waiting = registry.invoke(TOOL, ASK, { hands: handsWith({ screen: fakeScreen(), input: fakeInput(), handoff }), signal: stop.signal });
  await new Promise((resolve) => setImmediate(resolve));
  stop.abort(Object.assign(new Error("stopped"), { name: "AbortError" }));
  await assert.rejects(waiting, (error) => error.name === "AbortError");
});
