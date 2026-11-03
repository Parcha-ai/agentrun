// A monid call's one row in the person's words: what the catalog search found, what an endpoint costs a call, and what
// a run of one did and was charged, the charge on the run's own row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timelineOf, timelineReducer, TOOL_COST } from "@parcha/pi-durable-agent/timeline";
import "../dist/monid.js";

const at = (s) => ({ timestamp: Date.UTC(2026, 10, 3, 18, 0, s) });
let next = 1;
const user = (text) => ({ kind: "pi.user", id: next++, conversationId: 1, model: [{ role: "user", content: text, ...at(0) }] });
const asks = (id, name, args) => ({ kind: "pi.assistant", id: next++, conversationId: 1, model: [{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", usage: { cost: { total: 0.001 } }, ...at(1) }] });
const answers = (id, name, value, extra = {}) => ({ kind: "pi.tool-result", id: next++, conversationId: 1, model: [{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: JSON.stringify(value) }], isError: false, ...at(2), ...extra }] });
const rowOf = (id, name, args, value, extra) => timelineOf([user("Find Ada."), asks(id, name, args), answers(id, name, value, extra)], { settled: true }).find((row) => row.kind === "tool_use");
const PRICE = { type: "PER_CALL", amount: { value: 0.003, currency: "USD" } };

test("a catalog search says how many endpoints it found, and while it runs that it is searching", () => {
  const results = [0, 1, 2].map((i) => ({ provider: "faux", endpoint: `/e/${i}`, description: "Enrich a person.", score: 0.9, price: PRICE }));
  const row = rowOf("d1", "monid_discover", { query: "enrich a person" }, { results, query: "enrich a person", count: 3 });
  assert.deepEqual([row.summary, row.tool_status], ['Found 3 monid endpoints for "enrich a person"', "success"]);
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([{ type: "message_end", entry: asks("d2", "monid_discover", { query: "q" }) }]);
  assert.equal(reducer.rows().find((r) => r.kind === "tool_use").summary, `Searching monid's catalog for "q"`);
});

test("an endpoint looked up says what a call of it costs", () => {
  const row = rowOf("i1", "monid_inspect", { provider: "faux", endpoint: "/person/enrich" }, { id: "insp-1", provider: "faux", endpoint: "/person/enrich", description: "Enrich a person.", price: PRICE });
  assert.equal(row.summary, "Checked faux /person/enrich: $0.0030 a call");
});

test("a run of an endpoint carries its charge, as booked, on its own row", () => {
  const record = { runId: "r1", provider: "faux", endpoint: "/person/enrich", status: "COMPLETED", output: { full_name: "Ada" }, price: PRICE, cost: { value: 0.0049, currency: "USD" } };
  const args = { provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } };
  const booked = { kind: TOOL_COST, id: next++, conversationId: 1, data: { tool: "monid.run", charged_by: "monid", usd: 0.0049, call: "u1" } };
  const rows = timelineOf([user("Find Ada."), asks("u1", "monid_run", args), answers("u1", "monid_run", record, { details: { cost: record.cost } }), booked], { settled: true });
  assert.deepEqual(rows.filter((row) => row.kind === "tool_use" || row.kind === "phase").map((row) => [row.summary, row.tool_status]), [["Ran faux /person/enrich: ok · charged $0.0049", "success"]]);
  // A run that failed and was charged anyway says both: its failure, and the charge as booked.
  const failedRun = { error: "the run went past monid's time budget (TIMED_OUT)", status: 408, runId: "r2", cost: { value: 0.0049, currency: "USD" } };
  const charged = { kind: "agentrun.tool_cost", id: next++, conversationId: 1, data: { tool: "monid.run", charged_by: "monid", usd: 0.0049, call: "u3" } };
  const timedOut = timelineOf([user("Find Ada."), asks("u3", "monid_run", args), answers("u3", "monid_run", failedRun, { isError: true, details: { cost: failedRun.cost } }), charged], { settled: true }).find((row) => row.tool_use_id === "u3");
  assert.deepEqual([timedOut.tool_status, timedOut.summary], ["failed", "Ran faux /person/enrich failed: the run went past monid's time budget (TIMED_OUT) · charged $0.0049"]);
  const free = rowOf("u2", "monid_run", { provider: "faux", endpoint: "/person/enrich", input: {} }, { ...record, cost: undefined });
  assert.equal(free.summary, "Ran faux /person/enrich: ok", "no charge said when none was booked");
});
