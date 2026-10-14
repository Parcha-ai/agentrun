// The text the coding agent shows the model passes the redactor, whichever tool made it: a page holding a registered key (the
// host's own API keys are registered) reaches the model through snapshot and run as readily as through browser_read.
import assert from "node:assert/strict";
import test from "node:test";
import { FakeBackend, fakeDriver, fixturePage, makeSentinels } from "../dist/testing/index.js";
import { startAgent, turn } from "./coding-agent/rig.mjs";

const START = "https://example.test/start";

test("a registered key on the page is scrubbed from snapshot, browser_read and run text", { timeout: 60_000 }, async (t) => {
  const { kernelApiKey: key } = makeSentinels();
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, `The page shows the key ${key} in its text.`) } });
  const agent = await startAgent(t, { extension: { env: { PATH: process.env.PATH ?? "", KERNEL_API_KEY: key }, provider: backend.provider, driver: fakeDriver(backend) } });
  const results = await agent.run(turn(["snapshot"]), turn(["browser_read", { what: "text" }]), turn(["run", { code: `return ${JSON.stringify(key)};` }]));
  for (const result of results) {
    assert.equal(result.isError, false, result.text);
    assert.equal(result.text.includes(key), false, `${result.tool} showed the key`);
  }
  assert.match(results[0].text, /The page shows the key \[redacted\] in its text/);
  assert.match(results[2].text, /\[redacted\]/);
  // What the session keeps of the tool results (the model's own call arguments hold the key it was told to run, by construction).
  const kept = JSON.stringify(agent.entries().filter((e) => e.message?.role === "toolResult"));
  assert.ok(kept.length > 100, "the session holds the tool results");
  assert.equal(kept.includes(key), false, "the key reached the session file through a tool result");
});

test("the control: text with no registered value is shown as it is", { timeout: 60_000 }, async (t) => {
  const { kernelApiKey: key } = makeSentinels();
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "An ordinary page.") } });
  const agent = await startAgent(t, { extension: { env: { PATH: process.env.PATH ?? "", KERNEL_API_KEY: key }, provider: backend.provider, driver: fakeDriver(backend) } });
  const [snapshot] = await agent.run(turn(["snapshot"]));
  assert.match(snapshot.text, /An ordinary page\./);
});
