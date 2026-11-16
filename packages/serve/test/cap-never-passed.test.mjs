// A cap is never passed (codex and claude-agent through the faux harness, priced as Claude Sonnet 5.5): every request is
// held at its worst case, its whole input bound uncached, so neither a cache miss nor a request a crash cut can book the
// run past its cap. Codex-shaped requests (their bound the body's bytes, 32,000 output tokens asked, 3,072 at least) on
// caps a few requests deep:
//   - a cache miss billed at the most its bound allows (every byte a token, all of it a cache write) costs no more than
//     its request was held at, and the run's spend stays within its cap; a request whose worst case does not fit what is
//     left is not sent, and the run parks for a raise instead.
//   - a request admitted and then cut by a crash, with no usage, counts at its hold, which fit what was left.
// What the cap counts is read from the run's own records (the kernel's sessionSpendOf over each of its sessions).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { sessionSpendOf } from "@parcha/agentrun-kernel";
import { agent, follow, journalOf, scratch, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SONNET = new URL("./fixtures/faux-sonnet55.mjs", import.meta.url).pathname;
const CRASHABLE = { leaseMs: 1_500, renewEveryMs: 300, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
const ENDED = ["completed", "failed", "cancelled", "input_required"];

/** What the run's cap counts as spent, from its records: each of its sessions' requests as sessionSpendOf counts them (a
 *  cut one at the figure the cap holds it at), summed; and each request the cap held, with what it was booked at. */
function capSpend(data, runId) {
  const entries = journalOf(data, runId).filter((entry) => entry.kind === "runner.request" || entry.kind === "runner.turn");
  const sessions = Map.groupBy(entries, (entry) => entry.conversationId);
  let spent = 0;
  const requests = [];
  for (const records of sessions.values()) {
    const read = sessionSpendOf(records);
    assert.notEqual(read.spentUsd, null, `every request counted: ${JSON.stringify(records.map((r) => r.data))}`);
    spent += read.spentUsd;
    for (const { turn, usd } of read.figures) requests.push({ turn, heldUsd: read.held.get(turn), usd });
  }
  return { spent, requests };
}

/** A run of agent `id` on `harness` told `instructions` under `capUsd`. */
async function start(api, id, harness, instructions, capUsd) {
  assert.equal((await api("POST", "/agents", agent(id, { harness, instructions, tools: ["read"] }))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "go" }, max_cost_usd: capUsd });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body.run_id;
}

/** No request was booked past its hold, and the run's spend is within its cap. */
function withinCap(data, runId, capUsd, at) {
  const { spent, requests } = capSpend(data, runId);
  for (const one of requests) assert.ok(one.usd === null || one.heldUsd === undefined || one.usd <= one.heldUsd + 1e-9, `${at}: turn ${one.turn} booked $${one.usd}, past its hold $${one.heldUsd}`);
  assert.ok(spent <= capUsd + 1e-9, `${at}: the run's records count $${spent} spent on a $${capUsd} cap`);
  return { spent, requests };
}

for (const harness of ["codex", "claude-agent"]) {
  // $0.15: the miss at request 3 is billed $0.136 (53,200 bytes at $2.50 a million and 300 output tokens). A request held
  // as if it read request 2's cache would be admitted there on its warm hold, about $0.012 plus its output, and pass the
  // cap by the miss. $0.21: room for request 3's worst case, so the miss is sent, and billed under its hold.
  for (const capUsd of [0.15, 0.21]) {
    test(`${harness}: a cache miss billed at the most its bound allows, on a $${capUsd} cap, books no request past its hold and the run never past its cap`, { timeout: 120_000 }, async (t) => {
      const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: SONNET });
      const runId = await start(api, `miss-${harness}-${capUsd * 100}`, harness, "Grow a Codex-shaped context for 4 requests, missing the cache at request 3.", capUsd);
      await follow(api, runId, ENDED, { deadlineMs: 100_000 });
      const run = (await api("GET", `/runs/${runId}`)).body;
      const { spent, requests } = withinCap(data, runId, capUsd, `${harness} at $${capUsd}`);
      t.diagnostic(`${run.status} ${run.pending?.kind ?? ""}: spent $${spent.toFixed(4)}; ${JSON.stringify(requests.map((one) => [Number((one.heldUsd ?? 0).toFixed(4)), one.usd === null ? null : Number(one.usd.toFixed(4))]))}`);
      if (capUsd === 0.21) {
        // The miss was sent: four requests and the answer, the miss among them booked at $0.136, under its hold.
        assert.ok(requests.some((one) => one.usd !== null && one.usd > 0.13), `the miss was sent and booked: ${JSON.stringify(requests)}`);
      }
      // Ended within the cap: the job done, or parked for a raise; never failed past it.
      assert.ok(run.status === "completed" || run.pending?.kind === "budget", `${run.status}: ${JSON.stringify(run.pending ?? run.error)}`);
    });
  }

  test(`${harness}: a request admitted and cut by a crash, with no usage, counts at its hold, and the run never passes its cap`, { timeout: 120_000 }, async (t) => {
    // $0.21: request 3's worst case fits what is left ($0.168 of it), so it is sent; the crash cuts it; it then counts at
    // what it was held at. Held at a warm guess, it would count at that hold plus its bound, about $0.29, past the cap.
    const capUsd = 0.21;
    const { api, data, crashRunner } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: SONNET, runnerTiming: CRASHABLE });
    const go = join(await scratch(t), "go");
    const runId = await start(api, `cut-${harness}`, harness, `Grow a Codex-shaped context for 4 requests, cut at request 3 until ${go}.`, capUsd);
    // Requests 0 to 2 answered, request 3 admitted and held: the crash cuts it.
    for (let i = 0; journalOf(data, runId).filter((entry) => entry.kind === "runner.request" && !entry.data.side).length < 4; i++) {
      assert.ok(i < 600, "request 3 is admitted");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await crashRunner();
    await writeFile(go, "");
    await follow(api, runId, ENDED, { deadlineMs: 100_000 });
    const run = (await api("GET", `/runs/${runId}`)).body;
    const entries = journalOf(data, runId);
    assert.ok(entries.some((entry) => entry.kind === "runner.turn" && entry.data.cut === true), `request 3 was booked cut: ${JSON.stringify(entries.filter((entry) => entry.kind === "runner.turn").map((entry) => entry.data))}`);
    const { spent, requests } = withinCap(data, runId, capUsd, `${harness} cut`);
    t.diagnostic(`${run.status} ${run.pending?.kind ?? ""}: spent $${spent.toFixed(4)}; ${JSON.stringify(requests.map((one) => [Number((one.heldUsd ?? 0).toFixed(4)), one.usd === null ? null : Number(one.usd.toFixed(4))]))}`);
    assert.ok(run.status === "completed" || run.pending?.kind === "budget", `${run.status}: ${JSON.stringify(run.pending ?? run.error)}`);
  });
}
