// A pi-native extension's tool (PiAdapterOptions.extensions) is OFFERED to the provider, not only run: its name is in the
// outgoing request's `tools`, so the model may choose to call it. Read from the real request the gateway received (never a
// scripted origin, which names a tool in its answer whatever the request offered), so a tool that pi would run but never
// offers is caught — the trap ask_person fell into.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };

const until = async (done, what, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A native tool that only reports text (no turn end): the model, told "done" by the gateway, never calls it; the one
 *  request's `tools` is what we read. */
const browse = defineTool({ name: "browse", description: "Browses a page.", parameters: { type: "object", additionalProperties: false, properties: {} }, replay: "safe", execute: async () => ({ output: [{ type: "text", text: "ok" }] }) });

/** A pi run through the adapter loop whose root agent carries a native extension (PiAdapterOptions.extensions). The run is
 *  driven by a loopback gateway that just says "done", so it ends in one request; that request's body is returned. */
async function nativeRun(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pi-native-offered-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ text: "done" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "A" }, { id: "rev-1", kind: "agentic", body: { instructions: "Go.", tools: [] } });
  const launch = { input: { content: "Go." }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const provider = { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"x"}` };
  const extension = defineExtension({ name: "native", tools: [browse] });
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop((claim, run) => ({
    adapter: piAdapter({ run, model: "claude-sonnet-4-5", provider, price, fetch: globalThis.fetch, extensions: [extension] }),
    session: { key: `run:${claim.runId}`, label: "root", system: ["Go."], tools: [], context: "fresh" },
    input: "Go.",
    hooks: { beforeIntent: async () => {}, beforeResult: async () => {} },
    gate: () => "allow",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
  })) });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run ended");
  const calls = gw.requests.filter((r) => r.path.endsWith("/messages"));
  return { row, calls };
}

test("a pi-native extension's tool is offered to the provider: its name is in the request's tools", async (t) => {
  const { row, calls } = await nativeRun(t);
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.ok(calls.length >= 1, `the model was asked at least once: ${calls.length}`);
  const names = (calls[0].body?.tools ?? []).map((tool) => tool?.name);
  assert.ok(names.includes("browse"), `the native tool is offered in the request's tools: ${JSON.stringify(names)}`);
  assert.equal(names.filter((name) => name === "browse").length, 1, `offered exactly once, never duplicated: ${JSON.stringify(names)}`);
});
