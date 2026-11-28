// The /v2 document's note on a timeline row's `usage` quotes the cost lines a run's rows carry: a paid tool's charge row
// ("Tool cost: ...") and a free model's usage row ("Cost: $0 · free model over ..."). A host reads those quotes as the
// install's own words (hosted Grep strips the dollar part of each by their shape), so each is the renderer's output for
// the same charge, never a hand copy: the charge row through timelineOf, the usage row through runTimeline over a run
// written to a real store as its runner writes it. The live row's "Cost so far" reads as the quoted "Cost" once the run
// ends (endedUsage), the one rewrite a host that kept the live row makes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { openapiDocument } = await import("../dist/openapi.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { costLabel, endedUsage, REQUEST_STARTED, timelineOf, TOOL_COST } = await import("../dist/timeline/index.js");

const ROOT = 1;
/** The charge and the run the note's quotes describe: monid's $0.026 for one endpoint, three requests on a free model. */
const CHARGE = { tool: "monid:apollo/people/match", charged_by: "monid", usd: 0.026 };
const FREE_REQUESTS = 3;

/** The note's quoted lines, in the order it quotes them. */
function quotedLines() {
  const note = openapiDocument(() => undefined).components.schemas.TimelineRow.properties.usage["x-agentrun-serve-note"];
  return [...note.matchAll(/"([^"]+)"/g)].map(([, line]) => line);
}

/** The charge row timelineOf renders for CHARGE, booked under a call as serve books a paid tool's settle. */
function chargeRow() {
  let id = 1;
  const call = { type: "toolCall", id: "c1", name: "monid__apollo__people_match", arguments: {} };
  const rows = timelineOf(
    [
      { kind: "pi.assistant", id: id++, conversationId: ROOT, model: [{ role: "assistant", content: [call], stopReason: "toolUse", usage: { input: 10, output: 5, cost: { total: 0.01 } }, timestamp: T0 }] },
      { kind: TOOL_COST, id: id++, conversationId: ROOT, data: { ...CHARGE, call: "c1" } },
      { kind: "pi.tool-result", id: id++, conversationId: ROOT, model: [{ role: "toolResult", toolCallId: "c1", toolName: call.name, content: [{ type: "text", text: "{}" }], isError: false, timestamp: T0 }] },
    ],
    { settled: true },
  );
  return rows.find((row) => row.kind === "phase" && row.tool_name === CHARGE.tool);
}

/** The usage row runTimeline reads for a pi run whose FREE_REQUESTS requests were each answered on a free model and
 *  booked a known $0 (the booking's runner.turn `free`), its journal written as its runner writes it. */
async function freeUsageRow(t, ended) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Hi" }, title: "t", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const HARNESS = await journal.mintId();
  const writes = [{ type: "conversation", value: { id: ROOT } }, { type: "conversation", value: { id: HARNESS } }];
  const entry = async (conversationId, kind, data, model) => writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId, kind, ...(data === undefined ? {} : { data }), ...(model === undefined ? {} : { model }) } });
  await entry(ROOT, "agentrun.session.key", { key: "harness", conversation: HARNESS });
  await entry(ROOT, "pi.user", undefined, [{ role: "user", content: "Hi" }]);
  for (let turn = 1; turn <= FREE_REQUESTS; turn += 1) {
    await entry(ROOT, REQUEST_STARTED, {});
    await entry(ROOT, "pi.assistant", undefined, [{ role: "assistant", provider: "openrouter", model: "m:free", stopReason: "stop", content: [{ type: "text", text: `answer ${turn}` }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }]);
    await entry(HARNESS, "runner.request", { turn, model: "m:free", heldUsd: 0 });
    await entry(HARNESS, "runner.turn", { turn, usd: 0, bookedUsd: 0, rule: "answered", free: true });
  }
  await commitWrites(journal, writes, ctx);
  const rows = await runTimeline(store, "run-1", ctx, { settled: true, ended });
  return rows.findLast((row) => row.kind === "usage");
}

test("the note quotes a paid tool's charge row exactly as the renderer writes it", () => {
  const row = chargeRow();
  assert.ok(row, "the charge renders a row of its own");
  assert.ok(quotedLines().includes(row.summary), `the note quotes ${JSON.stringify(row.summary)}: ${JSON.stringify(quotedLines())}`);
});

test("the note quotes a free model's usage row exactly as an ended run's timeline reads it, and the live row's Cost so far reads as it once the run ends", async (t) => {
  const ended = await freeUsageRow(t, true);
  assert.equal(ended?.usage?.free, true, `a free run's usage row: ${JSON.stringify(ended)}`);
  assert.ok(quotedLines().includes(ended.summary), `the note quotes ${JSON.stringify(ended.summary)}: ${JSON.stringify(quotedLines())}`);
  const live = await freeUsageRow(t, false);
  assert.ok(live.summary.startsWith(`${costLabel(false)}: `), `a live run's usage row: ${JSON.stringify(live.summary)}`);
  assert.equal(endedUsage(live).summary, ended.summary);
});
