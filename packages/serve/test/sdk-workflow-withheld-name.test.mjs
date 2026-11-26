// An SDK run's learned_workflow start whose arguments hold a held value is stored withheld ("[redacted]"), so its
// arguments name no workflow. The run's record still names the one it ran (metrics.workflow) when that is a workflow the
// run was given, the name the server kept for it (SdkInbox.workflow_calls); never one the run was not given, and never a
// part of the held value.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { heldRedactor } from "../dist/runner/redact.js";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { SdkRuns, sdkInbox } from "../dist/sdk/runs.js";
import { runEntries } from "../dist/store-reads/journal.js";
import { landWorkflows, promoteChecked } from "./learned-workflow-seed-support.mjs";
import { serve } from "./support.mjs";

// A held value of 32 characters in no secret's shape, made at runtime, split across two of the start's arguments.
const [HEAD, REST] = [["Zq8V", "bN3x", "LmT6", "pR2w"].join(""), ["Yk9H", "sD4f", "Gj7A", "c5Ue"].join("")];
const SECRETS = [`${HEAD}${REST}`];
const STATUS = "mcp:backend/status";
const workflow = { v: 2, name: "release", schemas: { In: { type: "object" }, Out: { type: "object" } }, input: { schemaId: "In" }, output: { schemaId: "Out", path: "answer" }, root: { node: "call", label: "status", via: "tool", tool: STATUS, args: {}, out: "Out", as: "answer", deadline_s: 5 } };
const tool = (id, name, status, extra = {}) => ({ type: "tool", id, name, status, ...extra });
const start = (name) => tool("workflow", "learned_workflow", "started", { input: { name, input: { note: `see ${HEAD}`, more: `${REST} next` } } });

/** An SDK run given the learned workflow "release", that reports `events` and ends, its end settled by the SDK loop. */
async function endedRunOf(t, events) {
  const server = await serve(t, { runner: false });
  assert.equal((await server.api("POST", "/agents", { definition: { id: "sdk-held", name: "SDK held", instructions: "Read release status.", sdk: { runtime: "claude-agent-sdk" }, learning: true, tools: [] } })).status, 201);
  await landWorkflows(server.data, "sdk-held", [{ name: "release", description: "Read release status.", workflow }]);
  await promoteChecked(server.store.settings, "sdk-held", [{ name: "release", workflow }]);
  const started = await server.api("POST", "/agents/sdk-held/sdk-runs", { runtime: "claude-agent-sdk", input: "Read release status.", instructions: "Read release status.", workflow_tools: [{ name: STATUS, description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 }] }, { "Idempotency-Key": "held" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = started.body.run_id;
  const sdk = new SdkRuns(server.store, server.data, "fake-test-key", () => [...SECRETS]);
  assert.deepEqual(await sdk.events(id, { sequence: 1, events }), { accepted: true });
  assert.equal((await sdkInbox(server.store, id)).batches[0].events[0].input, "[redacted]");
  assert.deepEqual(await sdk.complete(id, { status: "completed", answer: "Ready.", usage: { cost_usd: 0.25, input_tokens: 20, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 } }), { accepted: true });
  const claim = await server.store.claim(id, "sdk-held-proof", { leaseMs: 60_000 });
  const launch = (await server.store.runs.launch(id)).body;
  // No paid request: the reflection route is scripted unavailable.
  const loop = createSdkLoop(launch, { store: server.store, data: server.data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => { throw new Error("the test reflection route is unavailable"); })({ redact: heldRedactor((text) => text), journal: () => server.store.journal(claim), flush: () => server.store.flush(), signal: new AbortController().signal });
  assert.equal((await loop.start(claim)).state, "ended");
  const journal = JSON.stringify(await runEntries(server.store, id, BACKGROUND_CONTEXT));
  assert.equal(journal.includes(HEAD) || journal.includes(REST.slice(0, 8)), false, "the journal holds no part of the held value");
  return (await server.store.runs.get(id)).metrics;
}

test("an SDK run's learned_workflow start stored withheld still names the workflow it ran in the run's record, a workflow the run was given", async (t) => {
  const metrics = await endedRunOf(t, [start("release"), tool("callback", STATUS, "started", { parent_tool_use_id: "workflow" }), tool("callback", STATUS, "completed", { parent_tool_use_id: "workflow" }), tool("workflow", "learned_workflow", "completed")]);
  assert.deepEqual([metrics.path, metrics.workflow], ["workflow", "release"]);
});

test("an SDK run's learned_workflow start stored withheld that names a workflow the run was not given names none in the run's record (control)", async (t) => {
  const metrics = await endedRunOf(t, [start("invented"), tool("workflow", "learned_workflow", "completed")]);
  assert.equal(metrics.workflow, undefined, "the record names no workflow");
});
