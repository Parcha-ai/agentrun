// The coding agent with `--browser-provider kernel`: the real pi agent, the real kernel provider, a fake Kernel API whose
// browsers are a fake backend's sessions and that echoes every secret on failure, and the fake driver. The key the host
// hands in reaches Kernel as the Bearer value and nothing the model is sent; the session is deleted when it is released.
import assert from "node:assert/strict";
import test from "node:test";
import { FakeBackend, fakeDriver, fixturePage, makeSentinels } from "../dist/testing/index.js";
import { startAgent, turn } from "./coding-agent/rig.mjs";
import { fakeKernel } from "./fixtures/fake-kernel.mjs";

const START = "https://example.test/start";

test("kernel is asked for by flag and refused, naming the key, when none is set", { timeout: 60_000 }, async (t) => {
  const agent = await startAgent(t, { extension: { env: { PATH: process.env.PATH ?? "" } }, flags: { "browser-provider": "kernel" } });
  const [snap] = await agent.run(turn(["snapshot"]));
  assert.equal(snap.isError, true);
  const answer = JSON.parse(snap.text);
  assert.equal(answer.code, "auth");
  assert.match(answer.message, /KERNEL_API_KEY/);
});

test("kernel by flag creates at Kernel with the host's key, shows the model no secret, and deletes the session on release", { timeout: 60_000 }, async (t) => {
  const sentinels = makeSentinels();
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const api = await fakeKernel({ key: sentinels.kernelApiKey, backend, sentinels, knobs: { echo: true } });
  t.after(() => api.close());
  const env = { PATH: process.env.PATH ?? "", KERNEL_API_KEY: sentinels.kernelApiKey, KERNEL_BASE_URL: api.url };
  const agent = await startAgent(t, { extension: { env, driver: fakeDriver(backend) }, flags: { "browser-provider": "kernel" } });
  const [snap] = await agent.run(turn(["snapshot"]));
  assert.equal(snap.isError, false, snap.text);
  assert.match(snap.text, /The start page/);
  const [create] = api.only("POST /browsers");
  assert.ok(create, "the create reached Kernel with the host's key");
  assert.equal(create.body.stealth, false);
  assert.equal(create.body.timeout_seconds, 180, "the coding agent's idle release is Kernel's idle timeout");

  // A Kernel failure the model is shown (a refused relaunch create) carries none of Kernel's echo.
  api.knobs.createStatus = 500;
  const [relaunch] = await agent.run(turn(["browser_relaunch"]));
  assert.equal(relaunch.isError, true);
  api.knobs.createStatus = 0;
  const [release] = await agent.run(turn(["browser_release"]));
  assert.equal(release.isError, false, release.text);
  assert.equal(api.alive().length, 0, "every Kernel session this agent opened is deleted");
  assert.equal(backend.tally().liveAtEnd, 0);

  const sent = JSON.stringify({ prompts: agent.prompts, seen: agent.seen, entries: agent.entries() });
  for (const name of ["kernelApiKey", "kernelJwt", "kernelCdpUrl", "kernelLiveViewUrl"]) assert.equal(sent.includes(sentinels[name]), false, `${name} reached the model or the session file`);
});
