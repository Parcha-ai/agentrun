// What a turn the instance's own drain cuts after its answer entry is written comes back as, at the next open. Two
// places the drain can land, per the session's own record of the turn:
// (A) the session still holds the turn open (it was cut mid-work, after its answer): the next open resumes it;
// (B) the session ended the turn, and only the root's turn end was cut: the next open restores that end from the answer.
// A guard of what the next open does in each place (it passes on the code as it is): each test also writes what it saw as a
// diagnostic. In (B) nothing is left to resume: the session's turn is over, and its answer is on the root.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const CUT = new URL("./fixtures/faux-harness-turn-end-cut.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const recordOf = (data, runId) => { try { return JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8")); } catch { return null; } };
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
const shown = (rows) => rows.map((r) => [r.kind, r.summary]);

/** The run's store entries, read once its process lets go of the store; a read that finds it held tries again. */
function storeEntries(data, runId) {
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(String(row.record)));
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
}
const turnEnds = (data, runId) => storeEntries(data, runId).filter((e) => e.kind === "adapter.turn_end").map((e) => ({ status: e.data?.status, answer: e.data?.answer ?? null }));
/** The store id of the turn's answer entry, "Saved answer.". */
const savedAnswer = (data, runId) => storeEntries(data, runId).find((e) => e.kind === "pi.assistant" && JSON.stringify(e.model ?? []).includes("Saved answer."))?.id;

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness} (A): a drain that cuts a turn after its answer entry, the turn still open in the session: the next open resumes it`, { timeout: 180_000 }, async (t) => {
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, drainTimeout: "1s" });
    const dir = await scratch(t);
    const [go, held] = [join(dir, "go"), join(dir, "held")];
    assert.equal((await api("POST", "/agents", agent(`drained-${harness}`, { harness, instructions: `Answer, then hold until ${go} (signal ${held}), then end showing nothing.` }))).status, 201);
    const runId = (await api("POST", `/agents/drained-${harness}/runs`, { input: { content: "hi" } })).body.run_id;
    for (const end = Date.now() + 55_000; ; await sleep(50)) {
      const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows ?? [];
      if (rows.some((r) => r.kind === "final_answer" && r.text === "Saved answer.") && (await readFile(held).then(() => true, () => false))) break;
      assert.ok(Date.now() < end, "the answer's row is in and the turn holds");
    }
    // The instance's own drain: SIGTERM to the run's process, as a server stop sends it.
    const pid = recordOf(data, runId).holder.pid;
    process.kill(pid, "SIGTERM");
    for (const end = Date.now() + 30_000; !gone(pid); await sleep(50)) assert.ok(Date.now() < end, "the drained process is gone");
    const record = recordOf(data, runId);
    await writeFile(go, "");
    const { rows, last } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 90_000 });
    const view = (await api("GET", `/runs/${runId}`)).body;
    for (let end = Date.now() + 60_000; ; await sleep(100)) { const now = recordOf(data, runId)?.holder?.pid; if (now === undefined || gone(now)) break; assert.ok(Date.now() < end, "the run's process lets go"); }
    const seen = { drained: { status: record?.status, detail: record?.detail }, status: view.status, final_answer: view.result?.final_answer ?? null, rows: shown(rows), turnEnds: turnEnds(data, runId) };
    t.diagnostic(JSON.stringify(seen));
    assert.equal(last.status, "completed", JSON.stringify(seen));
    assert.equal(seen.final_answer, "Saved answer.", JSON.stringify(seen));
    assert.ok(rows.some((r) => r.kind === "phase" && r.summary === "Resumed after the server stopped"), `resumed: ${JSON.stringify(seen)}`);
    // One end for the turn, completed, naming its saved answer: the resumed turn's, and no other.
    const saved = savedAnswer(data, runId);
    assert.ok(saved !== undefined, `setup: the answer's entry is on the root: ${JSON.stringify(seen)}`);
    assert.deepEqual(seen.turnEnds, [{ status: "completed", answer: saved }], `one turn end, completed, naming the saved answer: ${JSON.stringify(seen)}`);
  });
}

test("claude-agent (B): a server drain that cuts only the root's turn end, the session having ended the turn after its answer: the next open restores it completed", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const [arm, held, go, signal] = [join(dir, "arm"), join(dir, "held"), join(dir, "go"), join(dir, "signal")];
  withEnv(t, { TURN_END_ARM: arm, TURN_END_HELD: held });
  // The run's process holds at the first write of a turn's end on the root; the server's own stop (close: SIGTERM, then
  // SIGKILL past the drain) ends it there.
  await writeFile(arm, "0");
  await writeFile(go, "");
  const options = { data, port: 0, faux: FAUX, fauxHarness: CUT, drainTimeout: "1s" };
  const one = await startServe(options);
  let closed = false;
  t.after(() => (closed ? undefined : one.close()));
  let api = client(one.baseUrl, one.token);
  assert.equal((await api("POST", "/agents", agent("ended", { harness: "claude-agent", instructions: `Answer, then hold until ${go} (signal ${signal}), then end showing nothing.` }))).status, 201);
  const runId = (await api("POST", "/agents/ended/runs", { input: { content: "hi" } })).body.run_id;
  let hold = null;
  for (const end = Date.now() + 55_000; !(hold = JSON.parse(await readFile(held, "utf8").catch(() => "null"))); await sleep(50)) assert.ok(Date.now() < end, "the turn reaches the write of its end");
  const before = hold.since.join(", ");
  assert.ok(hold.since.includes("faux.turn_end"), `the session ended the turn before the root's end: ${before}`);
  const rowsBefore = (await api("GET", `/runs/${runId}/timeline`)).body.rows ?? [];
  closed = true;
  await one.close();
  const record = recordOf(data, runId);
  const two = await startServe(options);
  t.after(() => two.close());
  api = client(two.baseUrl, two.token);
  const { rows, last } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 90_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  for (let end = Date.now() + 60_000; ; await sleep(100)) { const now = recordOf(data, runId)?.holder?.pid; if (now === undefined || gone(now)) break; assert.ok(Date.now() < end, "the run's process lets go"); }
  const seen = { heldAt: hold.at, writtenBefore: before, rowsBefore: shown(rowsBefore), stopped: { status: record?.status, detail: record?.detail }, status: view.status, final_answer: view.result?.final_answer ?? null, rows: shown(rows), turnEnds: turnEnds(data, runId) };
  t.diagnostic(JSON.stringify(seen));
  assert.equal(last.status, "completed", JSON.stringify(seen));
  assert.equal(seen.final_answer, "Saved answer.", JSON.stringify(seen));
  // One end for the turn, the restored one, completed, naming its saved answer.
  const saved = savedAnswer(data, runId);
  assert.ok(saved !== undefined, `setup: the answer's entry is on the root: ${JSON.stringify(seen)}`);
  assert.deepEqual(seen.turnEnds, [{ status: "completed", answer: saved }], `one turn end, completed, naming the saved answer: ${JSON.stringify(seen)}`);
});
