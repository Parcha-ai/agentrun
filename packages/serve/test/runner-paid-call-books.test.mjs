// A pi run through the dispatch runs its paid web tools and books them as main's per-run process does: web_search, bound by
// adapterRunSpecFromLaunch under the run's plane (web_search -> Parallel), is no longer refused by a runner-settle seam. Its
// Parallel search is a paid call on the run's spend cap (paid-calls.ts): held at Parallel's price before it is sent and
// counted at the charge, so what fits the cap is sent and counted, and one past the cap is refused and never sent. The fake
// Parallel (fixtures/faux-parallel.mjs) answers in place of the network, on the canary key the plane hands the run; it files
// one line per request it is sent, so a request never sent leaves no line.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { specFor } from "./runner-spec-support.mjs";

const { useSpend } = await import("../dist/cap.js");
const { parallelSearchFee } = await import("../dist/paid-calls.js");
const { CANARY } = await import("./fixtures/faux-parallel.mjs");

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const CALLS_ENV = "AGENTRUN_TEST_FAUX_PARALLEL_CALLS";

/** The run's tool environment for a Parallel-planed web_search: the faux Parallel on the canary key, no socket. */
const parallelEnv = () => ({ AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_PARALLEL: FAUX_PARALLEL, PARALLEL_API_KEY: CANARY });
/** A spec whose web_search is bound under a plane that resolves it to Parallel, on the faux's key. */
const webSearchSpec = (t) => specFor(t, { body: { tools: ["web_search"] }, launch: { plane: { web_search: "parallel" } }, env: parallelEnv() });
/** The /v1/search requests the fake Parallel was sent, from its call log. */
const searchesSent = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.path === "/v1/search");

/** `calls` records the paid charges a run's spend took; its cap is `cap` and it has spent `spent` so far. */
function spend(t, { cap, spent = 0 }) {
  const charges = [];
  t.after(() => useSpend(undefined));
  useSpend({ cap, spent: () => spent, add: (usd) => charges.push(usd) });
  return charges;
}

/** The fake Parallel's call log for this test, cleaned up after it. */
function callLog(t) {
  const file = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-paid-")), "calls.ndjson");
  writeFileSync(file, "");
  const before = process.env[CALLS_ENV];
  process.env[CALLS_ENV] = file;
  t.after(() => {
    if (before === undefined) delete process.env[CALLS_ENV]; else process.env[CALLS_ENV] = before;
    rmSync(file, { force: true });
  });
  return file;
}

test("a web_search that fits the cap runs through Parallel and is counted at Parallel's price on the run's spend", async (t) => {
  const { spec } = await webSearchSpec(t);
  const file = callLog(t);
  const charges = spend(t, { cap: 1 });
  const webSearch = spec.session.tools.find((tool) => tool.name === "web_search");
  assert.ok(webSearch, "web_search is bound");
  const answer = await webSearch.call({ query: "widgets", n: 5 }, { callId: "c1", signal: new AbortController().signal, attempt: 0 });
  assert.doesNotMatch(answer.text ?? "", /spend_cap_reached|"error"/, `the search ran, not refused: ${answer.text}`);
  assert.match(answer.text ?? "", /"provider":"parallel"/, `it answered through Parallel: ${answer.text}`);
  assert.equal(searchesSent(file).length, 1, "one search was sent to Parallel");
  assert.equal(charges.length, 1, "one paid call was counted on the run's spend");
  assert.ok(Math.abs(charges[0] - parallelSearchFee(5).usd) < 1e-12, `counted at Parallel's price (${parallelSearchFee(5).usd}): ${charges[0]}`);
});

test("a web_search past the cap is refused before it runs: nothing is sent to Parallel, nothing is counted", async (t) => {
  const { spec } = await webSearchSpec(t);
  const file = callLog(t);
  // Parallel's fast search is $0.001; a cap with less than that left cannot hold it.
  const charges = spend(t, { cap: 0.0005, spent: 0 });
  const webSearch = spec.session.tools.find((tool) => tool.name === "web_search");
  const answer = await webSearch.call({ query: "widgets", n: 5 }, { callId: "c1", signal: new AbortController().signal, attempt: 0 });
  assert.match(answer.text ?? "", /spend_cap_reached/, `refused in the cap's words: ${answer.text}`);
  assert.equal(searchesSent(file).length, 0, "nothing was sent to Parallel");
  assert.equal(charges.length, 0, "nothing was counted on the run's spend");
});
