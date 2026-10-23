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

test("a tool's untyped throw reaches the model as the redacted typed envelope, never as its raw message", { timeout: 60_000 }, async (t) => {
  const { kernelApiKey: key } = makeSentinels();
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "An ordinary page.") } });
  // The workspace read happens before the tool's own failure handling, so its throw is not a typed failure.
  const files = { resolve: async () => { throw new Error(`could not read the file with ${key} in its path`); } };
  const agent = await startAgent(t, { extension: { env: { PATH: process.env.PATH ?? "", KERNEL_API_KEY: key }, provider: backend.provider, driver: fakeDriver(backend), files } });
  const [result] = await agent.run(turn(["browser_upload", { path: "report.pdf", selector: "#file" }]));
  assert.equal(result.isError, true, result.text);
  assert.equal(result.text.includes(key), false, "the key reached the model in the error");
  const envelope = JSON.parse(result.text);
  assert.equal(typeof envelope.code, "string", "the model reads a typed failure code");
  assert.match(envelope.detail ?? "", /could not read the file with \[redacted\] in its path/);
  const kept = JSON.stringify(agent.entries().filter((e) => e.message?.role === "toolResult"));
  assert.equal(kept.includes(key), false, "the key reached the session file through the error");
});

test("a handoff gives the host the browsed page's URL and title scrubbed, as onSession does; the viewer's own URL stays whole", { timeout: 60_000 }, async (t) => {
  const { kernelApiKey: key } = makeSentinels();
  const start = "https://example.test/callback?token=planted-handoff-token&next=1";
  const backend = new FakeBackend({ start, pages: { [start]: fixturePage(start, "Signed in.", `Account ${key}`) } });
  const asks = [];
  const handoff = { request: async (ask) => { asks.push(ask); return { interactionId: "int-1" }; }, outcome: async () => "done" };
  const agent = await startAgent(t, { extension: { env: { PATH: process.env.PATH ?? "", KERNEL_API_KEY: key }, provider: backend.provider, driver: fakeDriver(backend), handoff } });
  const results = await agent.run(turn(["snapshot"]), turn(["browser_request_handoff", { request_id: "3b9e2f1a-7c4d-4e8f-9a21-5d6c0b1e2f3a", instruction: "Solve the captcha.", completion_condition: "the page loads" }]));
  assert.equal(results[1].isError, false, results[1].text);
  assert.equal(asks.length, 1, "the host was asked once");
  const view = asks[0].liveView;
  assert.ok(view, "the host got the live view");
  assert.match(view.fullscreen ?? "", /[?&]token=[0-9a-f]{64}$/, "the viewer URL the person opens is not touched");
  const shown = JSON.stringify(view.pages);
  assert.equal(shown.includes("planted-handoff-token"), false, "a query value of the browsed page reached the host");
  assert.equal(shown.includes(key), false, "a registered key in the page title reached the host");
  assert.equal(view.pages[0].url, "https://example.test/callback?token=[redacted]&next=[redacted]");
});
