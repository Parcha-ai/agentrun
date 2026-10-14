// A tool's result reaches the model with its text, on every pi version the peers accept. pi-durable 1.2 reads a result's
// `output` and silently sends the model an empty result for one that still says `content` (1.0.4 and 1.1 read
// `content`); nothing throws, and a suite that only counts calls stays green. The lifecycle app's tools are what the
// run, park and fork suites run on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { lifecycleApp, type Counters } from "./_lifecycle.ts";

test("a lifecycle tool's result reaches the model with its text, not empty", { timeout: 30_000 }, async () => {
  const counters: Counters = { flaky: 0, safe: 0, unsafe: 0, requests: 0, gate: 0 };
  const toolResults: string[] = [];
  const app = lifecycleApp(counters, { gate: Promise.resolve(), jobs: false, toolResults });
  const harness = await Harness.open(new MemoryStorage(), { models: app.models, registry: app.registry, settings: app.settings }, ctx);
  try {
    const root = await harness.root(ctx, { agent: app.agent });
    const done = await (await root.submit({ type: "input", content: "gate" }, ctx)).wait(ctx);
    assert.equal(done.status, "done");
    assert.equal(counters.gate, 1);
    assert.deepEqual(toolResults, ["gate open"]);
  } finally {
    await harness.close(ctx);
  }
});
