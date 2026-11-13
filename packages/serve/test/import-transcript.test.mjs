// transcriptOf turns a parsed session into the pi-durable write batches Store.importRun stores as the run's journal, so an
// imported run's timeline reads back the same turns, with the import's secret cut applied to every string it writes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
import { transcriptOf } from "../dist/import.js";

const { launchBody } = await import("../dist/run-launch.js");
const { runEntries } = await import("../dist/store-reads/journal.js");

const context = BACKGROUND_CONTEXT;

const session = () => ({
  source: "pi",
  id: "s-1",
  model: "acme/model-1",
  state: "completed",
  users: 1,
  activeMs: 0,
  copies: 0,
  turns: [
    { role: "user", text: "do the thing", at: "2026-11-08T05:00:00.000Z" },
    { role: "assistant", text: "done", at: "2026-11-08T05:00:01.000Z", calls: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 },
  ],
});

const launch = () => ({ body: launchBody({ input: { content: "do the thing" }, title: "do the thing", place: { mode: "runner" } }) });

test("transcriptOf builds batches an imported run reads back as its timeline, in order", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  const { batches, entries } = transcriptOf(session(), (v) => v);
  assert.deepEqual(entries.map((e) => e.kind), ["pi.user", "pi.assistant"], "the entries it returns for metrics");
  await store.importRun({ id: "imp-1", agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "pi", session: "s-1" }, launch: launch(), startedAt: T0, endedAt: T0 + 1000, transcript: batches });
  const read = await runEntries(store, "imp-1", context);
  assert.deepEqual(read.map((e) => e.kind), ["pi.user", "pi.assistant"], "the turns read back in order");
  const assistant = read.find((e) => e.kind === "pi.assistant");
  assert.equal(assistant.model[0].content[0].text, "done", "the assistant text survived the round trip");
});

test("transcriptOf applies the import's cut to every string it writes", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  const SECRET = "sk-secret-value-1234567890";
  const s = { ...session(), id: "s-2", turns: [{ role: "user", text: `the key is ${SECRET}`, at: "2026-11-08T05:00:00.000Z" }] };
  const cut = (v) => JSON.parse(JSON.stringify(v).replaceAll(SECRET, "[redacted]"));
  const { batches } = transcriptOf(s, cut);
  await store.importRun({ id: "imp-2", agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "pi", session: "s-2" }, launch: launch(), startedAt: T0, transcript: batches });
  const read = await runEntries(store, "imp-2", context);
  assert.ok(!JSON.stringify(read).includes(SECRET), "the secret is cut from the journal the import wrote");
});
