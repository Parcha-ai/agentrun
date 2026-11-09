// A run that asked its person a question (ask_person) shows the question in the Timeline GET /runs/{id}/timeline serves
// (run-timeline-served.ts): a waiting row after the call's answer, "Waiting for you: <question>", as main's served rows
// carried it (runs.ts withAsks), through the run's one cut like every other row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { servedTimelineRows } = await import("../dist/run-timeline-served.js");

/** A held value the run's cut takes out: built at run time, never a literal. */
const HELD = ["held", "value", "q".repeat(24)].join("-");
const deps = { serverSecrets: () => [HELD], keyEnv: () => ({}) };

/** A run parked on its question: its journal holds the model's ask_person call and the call's answer. */
async function askedRun(t, question) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "A" }, { id: "rev-1", kind: "agentic", body: { instructions: "Ask." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Plan the trip." } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const j = store.journal(claim);
  const writes = [{ type: "conversation", value: { id: 1 } }];
  const add = async (entry) => writes.push({ type: "entry", value: { id: await j.mintId(), conversationId: 1, ...entry } });
  await add({ kind: "pi.user", model: [{ role: "user", content: "Plan the trip.", timestamp: T0 }] });
  await add({ kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "ask-1", name: "ask_person", arguments: { question } }], timestamp: T0 + 100 }] });
  await add({ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "ask-1", toolName: "ask_person", content: [{ type: "text", text: "Asked." }], isError: false, timestamp: T0 + 200 }] });
  await commitWrites(j, writes, context);
  await store.runs.update(claim, { state: "parked" });
  return store;
}

test("a run that asked its person serves a waiting row with the question, cut like every row", async (t) => {
  const store = await askedRun(t, `Which region? Use ${HELD} for the login.`);
  const rows = await servedTimelineRows(deps, store, "run-1", context);
  const waiting = rows.filter((row) => row.kind === "waiting");
  assert.equal(waiting.length, 1, JSON.stringify(rows.map((row) => [row.kind, row.summary])));
  assert.match(waiting[0].summary, /^Waiting for you: Which region\? Use .+ for the login\.$/);
  assert.equal(JSON.stringify(rows).includes(HELD), false, "the held value is cut from every row, the waiting row's too");
  // Right after the call's answer, as main's withAsks placed it.
  const result = rows.findIndex((row) => row.kind === "tool_result" && row.tool_use_id === "ask-1");
  assert.equal(rows[result + 1]?.kind, "waiting");
});
