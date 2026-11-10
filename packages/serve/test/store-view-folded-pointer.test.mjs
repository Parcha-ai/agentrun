// The store-backed run view (store-view.ts viewOverStore, which the run list's row is a subset of) cuts a sign-in pointer
// the run was handed however its answer writes the pointer's hex identifier: uppercased, its dashes dropped, or both
// (learn/secrets.ts folds a hex run of 16 digits or more). The run is served, its answer cut of it in place.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { viewOverStore } = await import("../dist/store-view.js");
const { saveSignIn, signInsOverStore } = await import("../dist/sign-ins-store.js");

const KEY = randomBytes(32);
const ROOT = 1;
/** A test pointer, never a real one: a Browserbase context. */
const UUID = "c2e85e3f-ae11-4df6-aae7-2930a7ba4f19";
const POINTER = `ctx/${UUID}`;
/** The pointer's identifier as the answer writes it, by how. */
const WRITTEN = {
  uppercased: UUID.toUpperCase(),
  "dash-stripped": UUID.replaceAll("-", ""),
  "uppercased and dash-stripped": UUID.replaceAll("-", "").toUpperCase(),
};
/** Whether `text` holds the identifier, however written. */
const holds = (text) => text.toLowerCase().replace(/[-_:.]/g, "").includes(UUID.replaceAll("-", ""));

for (const [how, written] of Object.entries(WRITTEN)) {
  test(`a run handed its sign-in pointer whose answer writes it ${how} is served, its answer cut of it`, async (t) => {
    const { store } = await storeOn(t);
    await store.agents.create({ id: "alpha", name: "alpha" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
    await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: POINTER });
    await store.runs.create({ id: "run-1", agentId: "alpha", revisionId: "rev-1" }, { body: { input: { content: "Which session?" }, title: "t", place: { mode: "runner" }, plane: { browser: "browserbase" } } });
    const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
    const journal = store.journal(claim);
    const user = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Which session?" }] };
    const answer = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `I kept ${written} for later.` }], usage: { cost: { total: 0 } }, timestamp: 0 }] };
    await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: user }, { type: "entry", value: answer }], BACKGROUND_CONTEXT);
    await store.runs.update(claim, { state: "ended", outcome: "completed", summary: `I kept ${written} for later.`, costUsd: 0, endedAt: T0 + 1_000, signInHanded: [createHash("sha256").update(POINTER).digest("hex")] });
    const deps = { origin: "https://run.test", serverSecrets: () => [], signIns: signInsOverStore(store, KEY, { remove: async () => {} }) };
    const served = await viewOverStore(store, "run-1", deps);
    assert.equal(served.result?.final_answer, "I kept [redacted] for later.", "served, the identifier cut in place");
    const view = JSON.stringify(served);
    assert.equal(holds(view), false, `the view holds the pointer: ${view}`);
  });
}
