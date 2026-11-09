// The run-building test helpers refuse an option they do not read, in words, before they build anything: a stale caller
// (capRun's old `beforeRequest`, which once left three cap tests running on no cap) fails loudly instead of testing nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capRun } from "./adapter-pi-cap-support.mjs";
import { claudeAgentSpec } from "./conformance-claude-agent.mjs";
import { piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { specFor } from "./runner-spec-support.mjs";

test("capRun refuses an option it does not read (the old beforeRequest) in words, and builds nothing", async (t) => {
  await assert.rejects(capRun(t, { script: [{ say: "done" }], beforeRequest: () => undefined, runCap: { capUsd: () => 1, modelOf: () => undefined } }), /capRun: it does not read `beforeRequest`/);
});

test("specFor refuses an option it does not read in words", async (t) => {
  await assert.rejects(specFor(t, { lanuch: { maxCostUsd: 1 } }), /specFor: it does not read `lanuch`/);});

test("claudeAgentSpec refuses a setup key it does not read in words", () => {
  assert.throws(() => claudeAgentSpec({ script: [], tools: {}, hooks: {}, beforeRequest: () => undefined }), /claudeAgentSpec's setup: it does not read `beforeRequest`/);
});

test("piAdapterSpec refuses a setup or an option it does not read in words", () => {
  assert.throws(() => piAdapterSpec({ script: [], tools: {}, hooks: {}, beforeRequest: () => undefined }), /piAdapterSpec's setup: it does not read `beforeRequest`/);
  assert.throws(() => piAdapterSpec({ script: [], tools: {}, hooks: {} }, { cap: 1 }), /piAdapterSpec: it does not read `cap`/);
});
