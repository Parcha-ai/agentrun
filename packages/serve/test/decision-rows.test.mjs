// A workflow run's decisions as timeline rows (decision-rows.ts): what a row says, the sources it cites, and the cost it
// adds to the run's usage row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionRows, withDecisions } from "../dist/decision-rows.js";

const receipt = (over = {}) => ({
  id: "d1", at: "2026-10-29T23:00:00.000Z", node: "document_checks", kind: "judge", request: { index: 0, count: 1 }, status: "answered",
  answers: { is_coi: { type: "noul", noul: 0.97 }, internally_consistent: { type: "noul", noul: 0.09 } }, cost_usd: 0.004, ...over,
});
const usageRow = (usd, requests) => ({ id: "1:usage", timestamp: "2026-10-29T23:00:05.000Z", created_at: "2026-10-29T23:00:05.000Z", kind: "usage", summary: "Cost so far", agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: null, usage: { usd, requests } });

test("a judge row names its node and provider, then each answer with the probability of what it said", () => {
  const [row] = decisionRows([receipt({ provider: "parallel" })]);
  assert.equal(row.kind, "decision");
  assert.equal(row.summary, "document_checks (parallel): is_coi yes 0.97 · internally_consistent no 0.91");
  assert.deepEqual(row.usage, { usd: 0.004, requests: 1 });
});

test("a choice and a score say their option and level with its probability, and a refusal says refused", () => {
  const [row] = decisionRows([receipt({ answers: {
    kind: { type: "choice", choice: "llc", confidence: 0.5, probabilities: { llc: 0.7, corp: 0.3 } },
    risk: { type: "score", score: 2, legend: { 0: "low", 1: "medium", 2: "high" }, confidence: 0.6 },
    age: { type: "refusal" },
  }, refused: ["age"] })]);
  assert.equal(row.summary, "document_checks: kind llc 0.70 · risk high 0.60 · age refused", "a row whose receipt names no provider names none");
  assert.equal(row.text, "refused: age");
});

test("the sources a provider grounded its answers in are the row's text, title then url", () => {
  const [row] = decisionRows([receipt({ provider: "parallel", evidence: [
    { url: "https://icis.corp.delaware.gov/entity/123", title: "Delaware entity search", excerpts: ["Example Widgets, Inc."], scope: "call" },
    { url: "https://example.org/filing", title: null, excerpts: [], scope: "is_coi" },
  ] })]);
  assert.equal(row.text, "Delaware entity search https://icis.corp.delaware.gov/entity/123\nhttps://example.org/filing");
});

test("a route row names the branch it took, and unsure or refused when it took that branch", () => {
  const route = (action, over = {}) => decisionRows([receipt({ kind: "route", node: "triage", answers: { branch: { type: "choice", choice: "accept", confidence: 0.6 } }, action, ...over })])[0].summary;
  assert.equal(route({ branch: "accept", taken: "accept", unsure: false }), "route: accept");
  assert.equal(route({ branch: "accept", taken: "review", unsure: true }), "route: review (unsure)");
  assert.equal(route({ branch: null, taken: "review", unsure: true, refused: true }, { refused: ["branch"] }), "route: review (unsure, refused)");
});

test("a decision's cost joins the run's usage row; one unknown makes the total unknown, never $0 or a lower figure", () => {
  const known = withDecisions([usageRow(0.01, 1)], [receipt(), receipt({ id: "d2", cost_usd: 0.002 })]);
  assert.deepEqual(known.at(-1).usage, { usd: 0.016, requests: 3 });
  assert.deepEqual(known.map((row) => row.kind), ["decision", "decision", "usage"]);
  const unknown = withDecisions([usageRow(0.01, 1)], [receipt(), receipt({ id: "d2", cost_usd: null })]);
  assert.deepEqual(unknown.at(-1).usage, { usd: null, requests: 3 });
  assert.equal(decisionRows([receipt({ cost_usd: null })])[0].usage.usd, null, "a decision whose cost is unknown says so on its row");
  assert.deepEqual(withDecisions([usageRow(0.01, 1)], []), [usageRow(0.01, 1)], "no decisions: the rows as they were");
});

test("decision rows sit among the run's rows by time, the usage row last", () => {
  const at = (id, timestamp) => ({ ...usageRow(0, 0), id, kind: "text_block", timestamp, usage: undefined });
  const rows = withDecisions([at("a", "2026-10-29T22:59:00.000Z"), at("b", "2026-10-29T23:01:00.000Z"), usageRow(0.01, 1)], [receipt()]);
  assert.deepEqual(rows.map((row) => row.id), ["a", "decision:d1:0", "b", "1:usage"]);
});
