import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve, client } from "./support.mjs";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { runEntries } from "../dist/store-reads/journal.js";
const { heldRedactor } = await import("../dist/runner/redact.js");

for (const runtime of ["claude-agent-sdk", "codex-sdk"]) {
  for (const mode of ["expired", "read-error", "command", "expired-off"]) {
    test(`${runtime} SDK ${mode} settles terminal learning without dispatching a model`, async t => {
      const server = await serve(t, { runner: false });
      const { api, store } = server, learning = mode !== "expired-off", id = "sdk-terminal";
      const created = await api("POST", "/agents", { definition: { id, name: id, instructions: "Keep application execution in its backend.", sdk: { runtime }, learning, tools: [] } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const started = await api("POST", `/agents/${id}/sdk-runs`, { runtime, input: "An application task whose outcome has not been reported.", instructions: "Keep the original application policy." }, { "Idempotency-Key": "terminal" });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const runId = started.body.run_id, key = `sdk-run:${runId}`, launch = (await store.runs.launch(runId)).body;
      const originalInbox = await store.settings.get(key);
      assert.equal(originalInbox.completion, undefined, "no application result is fabricated");
      if (mode.startsWith("expired")) await store.settings.put(key, { ...originalInbox, expires_at: Date.now() - 1 });
      const claim = await store.claim(runId, "terminal-proof", { leaseMs: 60_000 });
      assert.ok(claim);
      let inboxReads = 0, exercised = false, stopping, command, routes = 0, loop;
      const settings = new Proxy(store.settings, {
        get(target, name) {
          if (name === "get") return async wanted => {
            const value = await target.get(wanted);
            if (wanted === key && ++inboxReads === 2) {
              // The first inbox read pins supplied context; this is the real loop's next read after its start commit.
              if (mode === "read-error") { exercised = true; throw new Error("Synthetic SDK inbox read failed."); }
              if (mode === "command") {
                command = await store.command(runId, { kind: "stop" });
                exercised = true;
                stopping = loop.stop({ kind: "command", commandId: command.id });
              }
            }
            return value;
          };
          const value = Reflect.get(target, name, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const observedStore = new Proxy(store, {
        get(target, name) {
          if (name === "settings") return settings;
          const value = Reflect.get(target, name, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      loop = createSdkLoop(launch, { store: observedStore, data: server.data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => {
        routes++;
        assert.fail("An unreported SDK task cannot dispatch reflection or grading");
      })({ redact: heldRedactor((text) => text), journal: () => store.journal(claim), flush: () => store.flush(), signal: new AbortController().signal });
      const outcome = await loop.start(claim);
      await stopping;
      assert.equal(outcome.state, mode === "command" ? "stopped" : "failed", JSON.stringify(outcome));
      if (mode === "read-error" || mode === "command") assert.equal(exercised, true, "the intended loop seam was reached");
      assert.equal(routes, 0);
      const row = await store.runs.get(runId);
      assert.equal(row.costUsd, null, "an unreported application task has unknown spend");
      assert.equal(row.metrics, null, "no usage is invented for an unreported task");
      const entries = await runEntries(store, runId, BACKGROUND_CONTEXT);
      assert.equal(entries.filter(entry => entry.kind === "agentrun.end").length, 1);
      assert.ok(!entries.some(entry => entry.kind === "agentrun.sdk.completion" || entry.kind === "agentrun.sdk.reflecting" || entry.kind === "agentrun.end-of-run.turn" || entry.kind === "runner.request"));
      assert.equal(await store.runs.get(`${runId}-learning`), undefined, "no grader job is queued");
      const proposal = await store.learning.proposal(runId), read = (await api("GET", `/runs/${runId}`)).body;
      const receipt = (await client(server.baseUrl, started.body.token)("GET", `/sdk-runs/${runId}`)).body;
      assert.equal(receipt.state, mode === "command" ? "cancelled" : "failed");
      if (learning) {
        assert.ok(proposal, "terminal SDK failure must settle learning rather than leave it seeded");
        assert.equal(proposal.turn, null, "the terminal learning drop was not asked of a model");
        assert.equal(proposal.proposal.state, "dropped");
        assert.equal(proposal.proposal.reason, mode === "command" ? "cancelled" : "crashed");
        assert.equal(read.learning.state, "dropped");
        assert.equal(receipt.learning.state, "dropped");
      } else {
        assert.equal(proposal, undefined);
        assert.equal(read.learning, null);
        assert.equal(receipt.learning, null);
      }
      if (command) {
        const saved = (await store.commands(runId, 0)).find(row => row.id === command.id);
        assert.notEqual(saved.takenAt, null, "the stop command is taken with the terminal end");
      }
    });
  }
}
