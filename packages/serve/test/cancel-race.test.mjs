// A cancel the server took while the run worked ends the run cancelled, and no read says it ended any other way first:
// a run's first terminal status is its last. The faux Codex harness answers, makes one more request that says nothing,
// and holds its turn with no request open, so the answer's row is in while the run works. The cancel ends that turn,
// whose end writes the second request's entry and reads the turn over; the run's process is held from exiting
// (EXIT_GATE missing), so the window between that read and the carry back stays open until the test lets it go.
// A cancel once the run reads completed is refused, and the run stays completed: run-end.test.mjs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const SLOW_EXIT = new URL("./fixtures/faux-answer-slow-exit.mjs", import.meta.url).pathname;
const SLOW_EXIT_HARNESS = new URL("./fixtures/faux-harness-slow-exit.mjs", import.meta.url).pathname;
const TERMINAL = ["completed", "failed", "cancelled"];
const usageOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage;
const answerRow = (r) => (r.kind === "final_answer" || r.kind === "text_block") && /Done\./.test(r.summary ?? r.text ?? "");
const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;

/** Until `signal` exists, for at most `ms`: the faux harness writes it once the turn holds. */
async function reached(signal, ms = 60_000) {
  for (const end = Date.now() + ms; !existsSync(signal); await new Promise((resolve) => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < end, `the turn never held (no ${signal} in ${ms} ms)`);
  }
}

/** Long polls the run's timeline from `after` as a client does (drop, then upsert), until `done(page, rows)`: every
 *  page's status, in order. */
async function watch(api, runId, done, { after = 0, deadlineMs, what }) {
  const view = new Map();
  const statuses = [];
  for (const end = Date.now() + deadlineMs; ; ) {
    const { status, body: page } = await (api.fresh ?? api)("GET", `/runs/${runId}/timeline?${new URLSearchParams({ ...(after ? { after: String(after) } : {}), wait_ms: "2000" })}`);
    assert.equal(status, 200, JSON.stringify(page));
    if (page.reset) view.clear();
    for (const id of page.drop) view.delete(id);
    for (const row of page.rows) view.set(row.id, row);
    after = page.next_after;
    statuses.push(page.status);
    const rows = [...view.values()].sort((a, b) => a.seq - b.seq);
    if (done(page, rows)) return { rows, statuses, after };
    assert.ok(Date.now() < end, `${what}: last ${page.status}/${page.state}, statuses ${statuses.join(", ")}`);
  }
}

/** A Codex run (under `cap`, when given) that answers, then makes a second request at `late` and holds its turn; it is
 *  cancelled once the answer's row is in. What every read after the cancel said, the end's view and the turn's cost. */
async function cancelledAfterAnswer(t, { cap, late } = {}) {
  const gate = join(await scratch(t), "gate");
  withEnv(t, { EXIT_GATE: gate });
  const { api } = await serve(t, { faux: SLOW_EXIT, harnessTable: fauxTable(SLOW_EXIT_HARNESS) });
  const signal = join(await scratch(t), "holds");
  const instructions = `Answer, then hold the turn${late === undefined ? "" : ` after a request at $${late}`} (signal ${signal}).`;
  assert.equal((await api("POST", "/agents", agent("answers", { harness: "codex", instructions }))).status, 201);
  const run = await api("POST", "/agents/answers/runs", { input: { content: "What is six times seven?" }, ...(cap === undefined ? {} : { max_cost_usd: cap }) });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await reached(signal);
  // The answer's row is in and the run works: the window a cancel lands in as the run answers, held open.
  const before = await watch(api, runId, (page, rows) => page.status === "working" && rows.some(answerRow), { deadlineMs: 30_000, what: "the answer's row, the run working" });
  const cancel = await api("POST", `/runs/${runId}/cancel`, {});
  assert.equal(cancel.status, 202, JSON.stringify(cancel.body));
  assert.deepEqual([cancel.body.cancel_requested, cancel.body.already_terminal, cancel.body.status], [true, false, "cancelled"], JSON.stringify(cancel.body));
  // The cancel ends the turn. Its end, the second request's entry and cost with it, is read while the process is held,
  // so whatever that read publishes stays to be seen until the gate.
  const cost = 0.001 + (late ?? 0.001);
  const held = await watch(api, runId, (page, rows) => page.state === "idle" && near(usageOf(rows)?.usd, cost), { deadlineMs: 20_000, what: "the cut turn's end, read while the run's process is held" });
  await writeFile(gate, "");
  const { pages } = await follow(api, runId, TERMINAL, { after: held.after, deadlineMs: 60_000 });
  const statuses = [...held.statuses, ...pages.map((page) => page.status)];
  const ended = (await api("GET", `/runs/${runId}`)).body;
  return { before, statuses, ended, cost };
}

test("codex: a cancel taken after the run's answer row is in ends it cancelled, and no read says completed first", { timeout: 180_000 }, async (t) => {
  const { statuses, ended } = await cancelledAfterAnswer(t);
  assert.equal(statuses.find((status) => TERMINAL.includes(status)), "cancelled", `the reads after the cancel: ${statuses.join(", ")}`);
  assert.equal(ended.status, "cancelled", JSON.stringify(ended));
});

test("codex: a cancel taken before the turn it cut puts the run over its cap ends it cancelled, and no read says failed first", { timeout: 180_000 }, async (t) => {
  // The second request costs more than the cap held for it, so the server's own check over the run's cost is the one
  // that reads it over; that cost reaches the server only with the cut turn's end, after the cancel.
  const { before, statuses, ended, cost } = await cancelledAfterAnswer(t, { cap: 10, late: 11 });
  assert.ok(!(usageOf(before.rows)?.usd > 10), `the case: the run is within its cap when the cancel lands (${JSON.stringify(usageOf(before.rows))})`);
  assert.equal(statuses.find((status) => TERMINAL.includes(status)), "cancelled", `the reads after the cancel: ${statuses.join(", ")}`);
  assert.equal(ended.status, "cancelled", JSON.stringify(ended));
  assert.ok(near(ended.cost?.usd, cost), `the case: the cost over the cap is in at the end (${JSON.stringify(ended.cost)})`);
  assert.notEqual(ended.error?.code, "spend_cap_reached", JSON.stringify(ended.error));
});
