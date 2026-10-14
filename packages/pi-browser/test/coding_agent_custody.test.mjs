import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalCustody } from "../dist/coding-agent.js";
import { FakeBackend, fakeDriver, fixturePage } from "../dist/testing/index.js";
import { startAgent, turn } from "./coding-agent/rig.mjs";

const START = "https://example.test/start";
const POLICY = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0.05, batchTimeoutMs: 60_000 };
const backendWithStart = (options = {}) => new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") }, ...options });
const custodyOn = (backend) => new LocalCustody({
  config: { label: "browser", run: "run-1", policy: POLICY }, provider: async () => backend.provider, driver: fakeDriver(backend),
  keep: () => {}, redact: (text) => text, signal: new AbortController().signal,
});

test("an idle release that fires while a call is already queued keeps the session for that call", async () => {
  const backend = backendWithStart();
  const custody = custodyOn(backend);
  custody.activity(1);
  await custody.session();
  custody.activity(-1);
  backend.delay("status", 200);
  // The status lookup holds custody's queue while the 50 ms idle timer fires behind it.
  const busy = custody.ended();
  await sleep(80);
  custody.activity(1);
  await custody.session();
  custody.activity(-1);
  await busy;
  assert.equal(backend.tally().releases, 0, "the call that started before the idle release ran keeps its session");
  assert.equal(backend.tally().creates, 1);
  await custody.close("close");
});

test("web tools redact every provider key the coding agent reads, Kernel's included", async (t) => {
  const keys = { BROWSERBASE_API_KEY: ["browserbase-key-redact-me-0123456789"].join(""), BB_API_KEY: ["browserbase-alias-redact-me-9876543210"].join(""), KERNEL_API_KEY: ["kernel-key-redact-me-0123456789"].join("") };
  const backend = backendWithStart({ fetches: { "https://example.test/doc": `# Doc\n\nbrowserbase ${keys.BROWSERBASE_API_KEY} alias ${keys.BB_API_KEY} kernel ${keys.KERNEL_API_KEY}` } });
  const agent = await startAgent(t, { extension: { env: keys, provider: () => backend.provider, driver: fakeDriver(backend) } });
  const [fetched] = await agent.run(turn(["web_fetch", { url: "https://example.test/doc" }]));
  assert.equal(fetched.isError, false, fetched.text);
  for (const [name, value] of Object.entries(keys)) assert.equal(fetched.text.includes(value), false, `${name} reached the model`);
});
