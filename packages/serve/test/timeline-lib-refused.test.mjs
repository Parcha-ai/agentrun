// A request a host's spend cap refused was never sent: it is no model request in the run's usage, and costs nothing.
// Its marks are its own start mark (capRefused) and pi's error entry for it, which the timeline shows as the refusal, in
// the cap's own words after the error's code ("Not sent: ..."). A run whose only request was refused says it sent none:
// "no model request sent", never "Cost so far: $0 over 1 model request".
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_STARTED, timelineOf } from "../dist/timeline/index.js";
import { assistant, custom, user } from "./timeline-lib-support.mjs";

const rowsOf = (entries) => timelineOf(entries, { settled: true });
const usageOf = (entries) => rowsOf(entries).find((row) => row.kind === "usage");
const SAID = "Not sent: the next step needs at least $0.11, and this run's cap is $0.05. Raise the cap to at least $0.11 to continue.";
const refusal = () => [
  custom(REQUEST_STARTED, { capRefused: true }),
  assistant([], 0, { stopReason: "error", errorMessage: `spend_cap_reached (out of budget): ${SAID}`, usage: { input: 0, output: 0, cost: { total: 0 } } }),
];
const started = () => custom(REQUEST_STARTED, { heldUsd: 0.2 });
const priced = (text, usd = 0.01) => assistant([{ type: "text", text }], 0, { usage: { input: 10, output: 5, cost: { total: usd } } });

test("a run whose first request the cap refused has made no model request: its usage line says it sent none", () => {
  const row = usageOf([user("go"), ...refusal()]);
  assert.deepEqual([row?.summary, row?.usage], ["no model request sent", { usd: 0, requests: 0 }], JSON.stringify(row));
  for (const r of rowsOf([user("go"), ...refusal()])) assert.doesNotMatch(String(r.summary ?? ""), /over 1 model request/, JSON.stringify(r));
});

test("the refusal itself shows in the cap's own words: its row says why nothing was sent, its text keeps the error's code", () => {
  const rows = rowsOf([user("go"), ...refusal()]);
  const shown = rows.filter((row) => row.kind === "error");
  assert.deepEqual(shown.map((row) => [row.summary, row.text]), [[SAID, `spend_cap_reached (out of budget): ${SAID}`]], JSON.stringify(rows.map((row) => [row.kind, row.summary])));
});

test("a refusal after requests that were sent adds no request and no cost", () => {
  assert.deepEqual(usageOf([user("go"), started(), priced("one"), ...refusal()])?.usage, usageOf([user("go"), started(), priced("one")])?.usage);
  assert.equal(usageOf([user("go"), started(), priced("one"), ...refusal()])?.usage.requests, 1);
});

// The model proxy's own refusal of a request for the run's spend cap (run-adapters host/proxy.ts refuse): pi-ai writes its
// 400 as `400 <the proxy's JSON body>`. Read by the body's fields, it is no model failure: no row (the run's park at its cap
// says what happened), no request, no cost. A provider's own 400, or a proxy refusal of another kind, keeps its row.
const proxyRefused = (error) => assistant([], 0, { stopReason: "error", errorMessage: `400 ${JSON.stringify({ error })}`, usage: { input: 0, output: 0, cost: { total: 0 } } });
const CAP_BODY = { message: "refused before it was sent: Not sent: the next step needs at least $0.11, and this run's cap is $0.05.", type: "agentrun_proxy", code: "spend_cap_reached" };
const failedRows = (rows) => rows.filter((row) => row.kind === "error" && String(row.summary).startsWith("Model request failed"));

test("the model proxy's refusal of a request for the run's cap shows no Model request failed row, and adds no request or cost", () => {
  const rows = rowsOf([user("go"), started(), priced("one"), proxyRefused(CAP_BODY)]);
  assert.deepEqual(failedRows(rows).map((row) => row.summary), [], JSON.stringify(rows.map((row) => [row.kind, row.summary])));
  assert.deepEqual(usageOf([user("go"), started(), priced("one"), proxyRefused(CAP_BODY)])?.usage, usageOf([user("go"), started(), priced("one")])?.usage, "the refused request is no request and no cost");
});

test("a provider's own 400, and a proxy refusal with no cap code, keep their Model request failed row", () => {
  const provider = rowsOf([user("go"), started(), proxyRefused({ type: "invalid_request_error", message: "messages: roles must alternate" })]);
  assert.equal(failedRows(provider).length, 1, JSON.stringify(provider.map((row) => [row.kind, row.summary])));
  // The proxy's other refusals carry no code: the same words without the cap's code still show.
  const other = rowsOf([user("go"), started(), proxyRefused({ message: CAP_BODY.message, type: "agentrun_proxy" })]);
  assert.equal(failedRows(other).length, 1, "matched by the body's fields, never its words");
});
