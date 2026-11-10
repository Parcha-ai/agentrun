// A trigger's Timeline row names the trigger by its name as it is now, read by its id from the store at each read of
// the run's rows (run-timeline-served.ts), never the name the run's launch froze: a rename shows at the next read; a
// trigger gone is named by its id, its row carrying no name; and the name is cut of every value the run's cut holds,
// as the row's own words are. Over a planted journal whose first message is the trigger's (its origin), so the read is
// tested apart from the runner that writes it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { servedTimelineRows } = await import("../dist/run-timeline-served.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const TRIGGER = "trg_0123456789abcdef01234567";

/** A store holding schedule `name` (TRIGGER) and a run whose first message is that schedule's. */
async function triggerRun(t, name) {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.triggers.create({ id: TRIGGER, agentId: "agent-1", name, enabled: false, source: { kind: "schedule", every_s: 3600 }, target: { kind: "start_run", agent_id: "agent-1", input: { content: "Say the time." }, max_cost_usd: 0.5 }, nextAt: null, catchupWindowS: 0 });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const journal = await store.journal(await store.claim("run-1", "runner-a", { leaseMs: 60_000 }));
  const origin = { kind: "trigger", trigger_id: TRIGGER, source: "schedule", owner: true };
  const said = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", data: { origin }, model: [{ role: "user", content: "Say the time." }] };
  const answer = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Noon." }], stopReason: "stop" }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: said }, { type: "entry", value: answer }], context);
  return store;
}
/** The run's trigger row as served, with the server holding `secrets`. */
async function triggerRow(store, secrets = []) {
  const rows = await servedTimelineRows({ serverSecrets: () => secrets, keyEnv: () => ({}) }, store, "run-1", context);
  return rows.find((row) => row.origin === "trigger");
}

test("a trigger's row names it by its name as it is now, read by its id at each read: a rename shows at the next read", async (t) => {
  const store = await triggerRun(t, "utc-check");
  const before = await triggerRow(store);
  assert.equal(before?.summary, "Schedule utc-check: Say the time.");
  assert.deepEqual(before.trigger, { id: TRIGGER, source: "schedule", owner: true, name: "utc-check" }, "the row carries the name it shows");
  await store.triggers.update(TRIGGER, { name: "clock-check" });
  const after = await triggerRow(store);
  assert.equal(after?.summary, "Schedule clock-check: Say the time.", "the new name at the next read");
  assert.equal(after.trigger.name, "clock-check");
});

test("a trigger gone: its row names it by its id and carries no name", async (t) => {
  const store = await triggerRun(t, "utc-check");
  await store.triggers.remove(TRIGGER);
  const row = await triggerRow(store);
  assert.equal(row?.summary, `Schedule ${TRIGGER}: Say the time.`);
  assert.deepEqual(row.trigger, { id: TRIGGER, source: "schedule", owner: true });
});

test("a trigger named with a held value: its row shows the redaction mark in the value's place, in the summary and the name it carries", async (t) => {
  const key = ["not-a-secret", "trigger-name-key", "0f1e2d3c4b5a"].join("-");
  const store = await triggerRun(t, `nightly ${key}`);
  const row = await triggerRow(store, [key]);
  assert.equal(row?.summary, "Schedule nightly [redacted]: Say the time.");
  assert.equal(row.trigger.name, "nightly [redacted]");
  assert.ok(!JSON.stringify(row).includes(key.slice(-12)), JSON.stringify(row));
});
