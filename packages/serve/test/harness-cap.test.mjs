// A capped run on claude-agent or codex (the faux harness standing in for either) whose process dies mid-request: the cut
// request counts at the worst case the run's cap held for it, which is written on the request's record before it leaves,
// so the run's next process goes on while the cap leaves room, and refuses with the cap's message once it does not. Its
// shown cost stays unknown: the request's own price never came in. Faux model priced on output only ($100 a million
// output tokens, 16,384 of them): each request's worst case is $1.6384.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, scratch, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const WORST = 16_384 * 100 / 1e6;

/** The run's runner records of `kind`, read from its store once its process has let it go. */
function records(data, runId, kind) {
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === kind);
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
}

/** A run on `harness` under `cap` whose second request is cut by a SIGKILL of its process (its own pid). The faux
 *  harness answers the first request ($0.002, a tool call), holds the second until `go` exists, and answers the turn's
 *  next request "After the cut.". */
async function cutByCrash(t, harness, cap) {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
  const go = join(await scratch(t), "go");
  const id = `capped-${harness}-${String(cap).replace(".", "-")}`;
  assert.equal((await api("POST", "/agents", agent(id, { harness, instructions: `Cut until ${go}.` }))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" }, max_cost_usd: cap });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  // The first request answered (its tool's row is in); the second is then admitted, recorded and left in flight.
  for (let i = 0; !(await api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "tool_result"); i++) {
    assert.ok(i < 300, "the first request's tool row");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(go, "");
  const { holder } = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
  process.kill(holder.pid, "SIGKILL");
  return { api, data, runId };
}

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a capped run whose process dies mid-request goes on: the cut request counts at the worst case held for it`, { timeout: 120_000 }, async (t) => {
    const { api, data, runId } = await cutByCrash(t, harness, 10);
    await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    const run = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([run.status, run.result?.final_answer], ["completed", "After the cut."], JSON.stringify(run.error));
    assert.equal(run.cost.usd, null, "the cut request's own price never came in: the shown cost is unknown");
    const held = records(data, runId, "runner.request").map((r) => r.data.heldUsd);
    assert.ok(held.length >= 3 && held.every((usd) => Math.abs(usd - WORST) < 1e-9), `each request's record holds its worst case: ${JSON.stringify(held)}`);
  });

  test(`${harness}: a capped run whose process dies mid-request, when the held worst case leaves no room: refused with the cap's message`, { timeout: 120_000 }, async (t) => {
    // $3 holds the first two requests ($0.002 spent, then $1.6384 held), not a third $1.6384 beside them.
    const { api, runId } = await cutByCrash(t, harness, 3);
    await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    const run = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([run.status, run.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(run.error));
    assert.match(run.error.message, /could cost up to \$1\.638400, and with \$1\.640400 spent/);
  });
}
