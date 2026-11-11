// A reply a spend cap cut short says so. A host's cap that clamped a request's output to what was left of it writes the
// clamp on the request's start mark (`clamp`: the tokens, what was left, the cap); an answer that then stopped at its
// output limit (stopReason "length") gets a row in plain words with those numbers. A reply that stopped on its own, or
// at the model's own limit with no clamp, gets none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_STARTED, timelineOf } from "../dist/timeline/index.js";
import { assistant, custom, user } from "./timeline-lib-support.mjs";

const rowsOf = (entries) => timelineOf(entries, { settled: true });
const clamped = custom(REQUEST_STARTED, { heldUsd: 0.15, clamp: { tokens: 1_500, leftUsd: 0.15, capUsd: 0.5 } });
const unclamped = custom(REQUEST_STARTED, { heldUsd: 1.6384 });
const answer = (stopReason) => assistant([{ type: "text", text: "The first half of the answer" }], 0, { stopReason, usage: { input: 10, output: 1_500, cost: { total: 0.15 } } });
const SAID = "The reply stopped at 1,500 tokens: all that the $0.15 left of the run's $0.50 cap could buy.";
const saying = (rows) => rows.filter((row) => `${row.summary ?? ""} ${row.text ?? ""}`.includes(SAID));

test("a reply the cap's clamp cut short says so, with the tokens, what was left and the cap", () => {
  const rows = rowsOf([user("go"), clamped, answer("length")]);
  assert.equal(saying(rows).length, 1, JSON.stringify(rows.map((row) => [row.kind, row.summary])));
});

test("a clamped reply that stopped on its own, or a reply cut at the model's own limit with no clamp, says nothing of the cap", () => {
  assert.equal(saying(rowsOf([user("go"), clamped, answer("stop")])).length, 0);
  assert.equal(saying(rowsOf([user("go"), unclamped, answer("length")])).length, 0);
  for (const row of rowsOf([user("go"), unclamped, answer("length")])) assert.doesNotMatch(`${row.summary ?? ""} ${row.text ?? ""}`, /cap could buy/);
});
