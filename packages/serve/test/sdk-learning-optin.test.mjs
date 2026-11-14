import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve, client } from "./support.mjs";
import { getAgent } from "../dist/agents-store.js";
import { SdkRuns } from "../dist/sdk/runs.js";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { runEntries } from "../dist/store-reads/journal.js";

const disabled = { enabled: false, revision: null, context: "", skills: [] };
const input = { input: "Report release status.", instructions: "Keep the backend policy and tools." };

for (const runtime of ["claude-agent-sdk", "codex-sdk"]) {
  test(`${runtime} omitted and false learning stay Off through completion without a grader`, async (t) => {
    const server = await serve(t, { runner: false });
    const { api, store, data } = server;
    for (const learning of [undefined, false]) for (const bridge of [false]) await t.test(`${learning === undefined ? "omitted" : "false"}, bridge ${bridge}`, async () => {
      const id = `off-${learning === undefined ? "omitted" : "false"}-${bridge}`;
      // Do not use the SDK test helper's default learning=false: absence is a separate contract.
      const definition = { id, name: id, instructions: input.instructions, sdk: { runtime }, tools: [], ...(learning === undefined ? {} : { learning }) };
      assert.equal((await api("POST", "/agents", { definition })).status, 201);
      const entry = await getAgent(store, id);
      const before = structuredClone(entry.revision.body);
      assert.equal(Object.hasOwn(before, "learning"), learning !== undefined);
      const sdkRuns = new SdkRuns(store, data, server.token);
      const receipt = await sdkRuns.start(entry, { ...input, runtime }, {
        pinnedOf: async () => ({ revision: entry.revision, version: entry.version }),
        learning: "on",
        // There is deliberately no gradeModel. Off must not even read a learning seed.
        seedFor: async () => assert.fail("Off must not read learned context"),
      }, undefined, async () => assert.fail("Off must not require a grading model"), server.baseUrl);
      assert.deepEqual(receipt.learning, disabled);
      const launch = (await store.runs.launch(receipt.run_id)).body;
      assert.equal(launch.learning, undefined);
      const sdk = client(server.baseUrl, receipt.token);
      assert.equal((await sdk("POST", `/sdk-runs/${receipt.run_id}/complete`, { status: "completed", answer: "Ready.", evidence_complete: true })).status, 200);
      const claim = await store.claim(receipt.run_id, "off-proof", { leaseMs: 60_000 });
      assert.ok(claim);
      const journal = store.journal(claim);
      let modelCalls = 0;
      const loop = createSdkLoop(launch, { store, data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => {
        modelCalls++;
        assert.fail("Off must not reflect or grade completed SDK work");
      })({ journal: () => journal, flush: () => store.flush(), signal: new AbortController().signal });
      assert.deepEqual(await loop.start(claim), { state: "ended" });
      assert.equal(modelCalls, 0);
      const read = (await api("GET", `/runs/${receipt.run_id}`)).body;
      assert.equal(read.status, "completed");
      assert.equal(read.result.final_answer, "Ready.");
      assert.equal(read.learning, null);
      assert.equal(await store.runs.get(`${receipt.run_id}-learning`), undefined);
      const entries = await runEntries(store, receipt.run_id, BACKGROUND_CONTEXT);
      assert.ok(!entries.some(({ kind }) => kind === "agentrun.sdk.reflecting" || kind === "agentrun.end-of-run.turn"));
      assert.deepEqual((await getAgent(store, id)).revision.body, before, "starting and completing a run must not alter the saved learning mode");
    });
  });

  test(`${runtime} only enabled workflow learning falls back to notes without a bridge`, async (t) => {
    const { api, store } = await serve(t, { runner: false });
    for (const learning of [true, "notes"]) for (const bridge of [false]) await t.test(`${learning}, bridge ${bridge}`, async () => {
      const id = `enabled-${learning}-${bridge}`;
      assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: input.instructions, sdk: { runtime }, tools: [], learning } })).status, 201);
      const before = (await getAgent(store, id)).revision.body;
      const started = await api("POST", `/agents/${id}/sdk-runs`, { ...input, runtime }, { "Idempotency-Key": id });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      assert.equal(started.body.learning.enabled, true);
      const launch = (await store.runs.launch(started.body.run_id)).body;
      assert.equal(launch.learning.notesOnly, learning === "notes" || !bridge ? true : undefined);
      assert.deepEqual((await getAgent(store, id)).revision.body, before, "fallback affects this run, not the saved definition");
    });
  });
}
