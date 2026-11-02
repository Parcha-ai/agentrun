// A capped run on claude-agent or codex (the faux harness standing in for either) whose process dies mid-request: the cut
// request counts at the worst case the run's cap held for it, which is written on the request's record before it leaves,
// so the run's next process goes on while the cap leaves room, and refuses with the cap's message once it does not. Its
// shown cost stays unknown: the request's own price never came in. Faux model priced on output only ($100 a million
// output tokens, 16,384 of them): each request's worst case is $1.6384. One server for the file: each test makes its
// own agent and run on it, and kills only that run's own process.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { agent, follow, scratch, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const WORST = 16_384 * 100 / 1e6;
const usageOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage;

let server;
const stops = [];
before(async () => {
  server = await serve({ after: (stop) => stops.push(stop) }, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
});
after(async () => {
  for (const stop of stops.reverse()) await stop();
});

/** The run's runner records of `kind`, read from its store once its process has let it go. */
function records(runId, kind) {
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(server.data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === kind);
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
}

/** A run on `harness` under `cap` whose second request is cut by a SIGKILL of its own process. The faux harness answers
 *  the first request ($0.002, a tool call), holds the second until `go` exists, and answers the turn's next request "After
 *  the cut.". The kill waits until the second request is admitted: its mark is on the run's root only once its
 *  runner.request record is written, and the live usage then counts it, in flight, as a second request. */
async function cutByCrash(t, harness, cap) {
  const { api, data } = server;
  const go = join(await scratch(t), "go");
  const id = `capped-${harness}-${String(cap).replace(".", "-")}`;
  assert.equal((await api("POST", "/agents", agent(id, { harness, instructions: `Cut until ${go}.` }))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" }, max_cost_usd: cap });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  for (let i = 0; usageOf((await api("GET", `/runs/${runId}/timeline`)).body.rows)?.requests !== 2; i++) {
    assert.ok(i < 600, "the second request is admitted and recorded");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(go, "");
  // This run's own process, by its own record: never this test's process (which the server runs in) or another run's.
  const { holder } = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
  assert.ok(Number.isInteger(holder.pid) && holder.pid !== process.pid, JSON.stringify(holder));
  process.kill(holder.pid, "SIGKILL");
  return { api, runId };
}

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a capped run whose process dies mid-request goes on: the cut request counts at the worst case held for it`, { timeout: 120_000 }, async (t) => {
    const { api, runId } = await cutByCrash(t, harness, 10);
    await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    const run = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([run.status, run.result?.final_answer], ["completed", "After the cut."], JSON.stringify(run.error));
    assert.equal(run.cost.usd, null, "the cut request's own price never came in: the shown cost is unknown");
    const held = records(runId, "runner.request").map((r) => r.data.heldUsd);
    assert.equal(held.length, 3, "the first, the cut one, and the one after it");
    assert.ok(held.every((usd) => Math.abs(usd - WORST) < 1e-9), `each request's record holds its worst case: ${JSON.stringify(held)}`);
  });

  test(`${harness}: a capped run whose process dies mid-request, when the held worst case leaves no room: refused with the cap's message`, { timeout: 120_000 }, async (t) => {
    // $3 holds the first two requests ($0.002 spent, then $1.6384 held), not a third $1.6384 beside them.
    const { api, runId } = await cutByCrash(t, harness, 3);
    await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    const run = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([run.status, run.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(run.error));
    assert.match(run.error.message, /could cost up to \$1\.638400, and with \$1\.640400 spent/);
    assert.equal(records(runId, "runner.request").length, 2, "the third request is refused before its record");
  });
}
