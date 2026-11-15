// Two runs that met a cap in the field, on codex through the faux harness at GPT-6.1 Sol's prices (faux-sonnet55.mjs has
// the same: $2 in, $10 out, $0.10 a cache read, $2.50 a cache write, a million tokens; 128,000 output tokens):
//   - a lead list under a $0.50 cap (faux-field-harness.mjs leadListStep): two $0.026 searches, reads, and a people search
//     Codex makes while its request still streams, at $0.17 of the cap. The field run had that search refused with
//     "Budget nearly spent" and answered without it. Now the search is never refused for the reserve: with the provider's
//     own count of the input (a route straight to OpenAI) the run goes on and runs it, each request's output clamped to
//     what its worst case leaves; with only the body's bytes to bound the input (a route with no count), the request
//     that would make the search has a worst case ($0.35 at its least output: 128,400 bytes uncached) past what is left
//     ($0.33), so it is not sent and the run parks with the plain message naming the cap that sends it.
//   - a kyb step under a $1.50 cap whose whole ask holds $1.62 (kybStep): a cap that fits the step's input uncached and
//     its 1,024-token least goes on with its output clamped; a cap that does not parks with the plain message.
// In each, no request is held past what the cap leaves.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { journalRecords } from "../dist/runner/journal-reader.js";
import { KEY } from "./fixtures/faux-monid.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FIELD = new URL("./fixtures/faux-field-harness.mjs", import.meta.url).pathname;
const SONNET = new URL("./fixtures/faux-sonnet55.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const PEOPLE_TOOL = "monid:apollo/people/match";
const journalOf = async (store, runId) => (await journalRecords(store.readJournal(runId), BACKGROUND_CONTEXT)).entries;

/** One run of a codex agent told `instructions` with `tools` (monid's allowed), under `capUsd`, followed to its end:
 *  the run as served, and its journal. */
async function runOf(t, id, instructions, capUsd, tools) {
  withEnv(t, { MONID_API_KEY: KEY });
  const { api, store } = await serve(t, { harnessTable: fauxTable(FIELD), faux: SONNET, fauxMonid: FAUX_MONID });
  const settings = Object.fromEntries(tools.filter((tool) => tool.startsWith("monid:")).map((tool) => [tool, { permission: "allow" }]));
  assert.equal((await api("POST", "/agents", agent(id, { harness: "codex", instructions, tools, tool_settings: settings }))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "go" }, max_cost_usd: capUsd });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 100_000 });
  return { run: (await api("GET", `/runs/${started.body.run_id}`)).body, journal: await journalOf(store, started.body.run_id) };
}

/** The run's own model requests as the cap held them, in order: each one's hold, output limit, and the spend booked
 *  before it was admitted (its paid calls' charges among it). */
function heldOf(journal) {
  const limits = journal.filter((entry) => entry.kind === "faux.request").map((entry) => entry.data.outputTokensMax);
  const out = [];
  let booked = 0;
  for (const entry of journal) {
    if (entry.kind === "runner.request" && !entry.data.side && entry.data.host === undefined && entry.data.charged_by === undefined) out.push({ turn: entry.data.turn, heldUsd: entry.data.heldUsd, spentBefore: booked });
    if (entry.kind === "runner.turn" && typeof entry.data.usd === "number") booked += entry.data.usd;
  }
  return out.map((one, i) => ({ ...one, outputTokensMax: limits[i] }));
}

/** The faux harness's results for the call request `index` made (its call id ends `:<index>.0`). */
const resultsAt = (journal, index) => journal.filter((entry) => entry.kind === "faux.result" && String(entry.data.callId).endsWith(`:${index}.0`)).map((entry) => entry.data);

/** No request was held past what its cap left. */
function neverPast(held, capUsd, at) {
  for (const one of held) assert.ok(one.spentBefore + one.heldUsd <= capUsd + 1e-9, `${at}: turn ${one.turn} held $${one.heldUsd} on $${one.spentBefore} spent, past $${capUsd}`);
}

test("lead list on codex at $0.50, its input counted by the provider: the people search made while its request streams runs, at $0.17 of the cap, each output clamped, never past the cap", { timeout: 120_000 }, async (t) => {
  const { run, journal } = await runOf(t, "lead-counted", "Build a lead list on Codex: 9 requests, the people search at request 7 while it streams, its input counted.", 0.5, ["read", PEOPLE_TOOL]);
  const held = heldOf(journal);
  t.diagnostic(`holds: ${JSON.stringify(held.map((one) => [one.outputTokensMax, Number(one.heldUsd.toFixed(4))]))}`);
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Lead list built."], JSON.stringify(run.pending ?? run.error));
  assert.deepEqual(resultsAt(journal, 7).map((one) => one.refused === true), [false], "the people search ran, not refused for the reserve");
  // $0.115 of the model's requests booked before it, beside the two searches' $0.052: $0.17 of the cap.
  assert.ok(Math.abs(held[7].spentBefore - 0.1148) < 0.001, `the search's request admitted at $0.17 of the cap: $${held[7].spentBefore} of the model's`);
  assert.ok(held[7].outputTokensMax >= 3_072 && held[7].outputTokensMax < 128_000, `its output clamped, never under its least: ${held[7].outputTokensMax}`);
  assert.ok(run.cost.usd <= 0.5, `$${run.cost.usd}`);
  neverPast(held, 0.5, "counted");
});

test("lead list on codex at $0.50, its input bound only by its bytes: the people search is never refused for the reserve; its request's worst case does not fit what is left, so the run parks with the plain message naming the cap that sends it", { timeout: 120_000 }, async (t) => {
  const { run, journal } = await runOf(t, "lead-bytes", "Build a lead list on Codex: 9 requests, the people search at request 7 while it streams.", 0.5, ["read", PEOPLE_TOOL]);
  const held = heldOf(journal);
  t.diagnostic(`holds: ${JSON.stringify(held.map((one) => [one.outputTokensMax, Number(one.heldUsd.toFixed(4))]))}; results: ${JSON.stringify(journal.filter((entry) => entry.kind === "faux.result").map((entry) => [entry.data.callId, entry.data.refused === true]))}`);
  assert.deepEqual(resultsAt(journal, 7).filter((one) => one.refused === true), [], "the people search is not refused for the reserve");
  // Request 7: 32,100 tokens of prompt, 128,400 bytes, at $2.50 a million uncached ($0.321) and 3,072 tokens at $10 a
  // million ($0.031): $0.352 at its least, on $0.167 spent of $0.50. Not sent; the run asks for $0.52.
  assert.equal(run.status, "input_required", JSON.stringify(run.result ?? run.error));
  assert.equal(run.pending?.kind, "budget", JSON.stringify(run.pending));
  assert.match(run.pending.said, /^Not sent: this run has spent \$0\.17 of its \$0\.50 cap, and the next step needs at least \$0\.36\. Raise the cap to at least \$0\.52 to continue\.$/);
  assert.equal(run.pending.least_cap_usd, 0.52);
  assert.equal(held.length, 7, "requests 0 to 6 sent, request 7 not");
  neverPast(held, 0.5, "bytes");
});

test("kyb step on codex whose whole ask holds $1.62: a $1.50 cap that fits its input uncached and its least goes on with its output clamped; a $0.30 cap that does not parks with the plain message", { timeout: 120_000 }, async (t) => {
  const fits = await runOf(t, "kyb-fits", "Run a kyb step.", 1.5, ["read"]);
  const held = heldOf(fits.journal);
  t.diagnostic(`holds: ${JSON.stringify(held.map((one) => [one.outputTokensMax, Number(one.heldUsd.toFixed(4))]))}`);
  assert.deepEqual([fits.run.status, fits.run.result?.final_answer], ["completed", "Kyb step done."], JSON.stringify(fits.run.pending ?? fits.run.error));
  assert.equal(held.length, 1);
  assert.ok(held[0].outputTokensMax >= 1_024 && held[0].outputTokensMax < 128_000, `its output clamped, never under its least: ${held[0].outputTokensMax}`);
  // Its hold is its worst case at that output: 136,000 bytes at $2.50 a million and the output at $10.
  assert.ok(Math.abs(held[0].heldUsd - (136_000 * 2.5 + held[0].outputTokensMax * 10) / 1e6) < 1e-6, `held at its worst case: $${held[0].heldUsd}`);
  neverPast(held, 1.5, "kyb $1.50");
  const parks = await runOf(t, "kyb-parks", "Run a kyb step.", 0.3, ["read"]);
  assert.equal(parks.run.status, "input_required", JSON.stringify(parks.run.result ?? parks.run.error));
  assert.equal(parks.run.pending?.kind, "budget");
  assert.equal(parks.run.pending.said, "Not sent: the next step needs at least $0.36, and this run's cap is $0.30. Raise the cap to at least $0.36 to continue.");
  assert.equal(parks.run.cost.usd, 0);
});
