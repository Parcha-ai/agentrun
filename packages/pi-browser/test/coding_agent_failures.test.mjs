// What the coding agent's toolset answers when a browser call fails. A typed failure (BrowserFailureError) comes back as the same envelope the durable adapter gives, a
// JSON failure result flagged isError, so the model reads the code and `retryable` and decides: never as an exception pi turns into a plain error string.
//   - The driving guard refuses a release or a relaunch while a person drives the live view BEFORE the tool's own error handling runs (it must take the gate first),
//     so that refusal is the one typed failure that reaches the adapter as a throw.
//   - Every one of the 14 failure codes comes back as its typed envelope when the provider throws it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";
import { BrowserFailureError, browserFailure, FAILURE_CODES } from "../dist/index.js";
import { createDrivingGates } from "../dist/core/driving.js";
import { startAgent, turn } from "./coding-agent/rig.mjs";

const START = "https://example.test/start";
const ARTICLE = { url: START, title: "Filing", text: "Acme Corp file number 7741234", html: "<html><body><h1>Acme Corp</h1><p>File number 7741234</p></body></html>" };
const fake = () => new FakeBackend({ start: START, pages: { [START]: ARTICLE } });
const failureOf = (text) => { try { return JSON.parse(text); } catch { return null; } };

test("a browser_release or browser_relaunch refused for a driving person comes back as the typed, retryable person_driving result, as the durable adapter gives it", async (t) => {
  const backend = fake();
  const idle = createDrivingGates()("lead");
  // The person's turn lapses after a few seconds of real time, which a slow worker could pass before the refusal checks: the gate's own timers are inert here, so the person
  // keeps driving until the test ends.
  const person = createDrivingGates({ timers: { set: () => null, clear: () => undefined } })("lead");
  person.input(); // a person is driving
  let active = idle;
  const agent = await startAgent(t, { extension: { provider: () => backend.provider, driver: fakeDriver(backend), gates: () => active } });
  await agent.run(turn(["snapshot"]));
  assert.equal(backend.tally().creates, 1, "a session is open");
  active = person;
  for (const tool of ["browser_release", "browser_relaunch"]) {
    const [result] = await agent.run(turn([tool]));
    const failure = failureOf(result.text);
    assert.ok(failure, `${tool}: the answer is the typed JSON envelope, not a plain error string: ${JSON.stringify(result.text).slice(0, 120)}`);
    assert.equal(result.isError, true, `${tool}: flagged as an error`);
    assert.deepEqual([failure.code, failure.retryable, failure.effect, failure.message.startsWith("person_driving: ")], ["refused", true, "none", true], `${tool}: refused, retryable, nothing done`);
  }
  assert.equal(backend.tally().releases, 0, "nothing was released while the person drove");
});

for (const code of FAILURE_CODES) {
  test(`a provider that throws the typed failure "${code}" comes back to the model as that failure's envelope`, async (t) => {
    const backend = fake();
    const thrown = browserFailure(code, `table row for ${code}`);
    const provider = { ...backend.provider, create: async () => { throw new BrowserFailureError(thrown); } };
    const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
    const [result] = await agent.run(turn(["snapshot"]));
    const failure = failureOf(result.text);
    assert.ok(failure, `the answer is the typed JSON envelope: ${JSON.stringify(result.text).slice(0, 120)}`);
    assert.equal(result.isError, true);
    assert.equal(failure.code, thrown.code, "the failure's own code");
    assert.deepEqual([failure.retryable, failure.effect], [thrown.retryable, thrown.effect]);
  });
}
