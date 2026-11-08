// An answered run's end, on every harness: the rows its first terminal read shows are the rows it ends with (none
// vanishes when its end is carried back from the agent store), and once the run is finishing a cancel is refused, so a
// run that answered ends completed. The run's process is held from exiting (EXIT_GATE missing), which holds the window
// between the answer and the carry back open.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const SLOW_EXIT = new URL("./fixtures/faux-answer-slow-exit.mjs", import.meta.url).pathname;
const SLOW_EXIT_HARNESS = new URL("./fixtures/faux-harness-slow-exit.mjs", import.meta.url).pathname;
const TERMINAL = ["completed", "failed", "cancelled"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A server whose runs answer and then cannot exit until `release` makes the gate's file. */
async function held(t) {
  const gate = join(await scratch(t), "gate");
  withEnv(t, { EXIT_GATE: gate });
  const { api } = await serve(t, { faux: SLOW_EXIT, harnessTable: fauxTable(SLOW_EXIT_HARNESS) });
  return { api, release: () => writeFile(gate, "") };
}

/** Starts a run of a new agent on `harness`; its one turn answers and ends (no tool, no model change). */
async function started(api, harness) {
  assert.equal((await api("POST", "/agents", agent(harness, { harness, instructions: "Answer the question." }))).status, 201);
  const run = await api("POST", `/agents/${harness}/runs`, { input: { content: "What is six times seven?" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

/** The whole timeline as served now, every page, without waiting for a change. */
async function timeline(api, runId) {
  const view = new Map();
  for (let after = 0; ; ) {
    const { status, body: page } = await api("GET", `/runs/${runId}/timeline?${new URLSearchParams(after ? { after: String(after) } : {})}`);
    assert.equal(status, 200, JSON.stringify(page));
    if (page.reset) view.clear();
    for (const id of page.drop) view.delete(id);
    for (const row of page.rows) view.set(row.id, row);
    after = page.next_after;
    if (!page.has_more) return [...view.values()].sort((a, b) => a.seq - b.seq);
  }
}

for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`${harness}: the rows of an answered run's first terminal read are the rows it ends with, and a cancel after that read leaves it completed`, { timeout: 120_000 }, async (t) => {
    const { api, release } = await held(t);
    const runId = await started(api, harness);
    let view;
    for (let i = 0; !TERMINAL.includes((view = (await api("GET", `/runs/${runId}`)).body).status); i++) {
      assert.ok(i < 600, `the run answers: last ${view.status}`);
      await sleep(50);
    }
    assert.equal(view.status, "completed", JSON.stringify(view));
    const first = await timeline(api, runId);
    const cancel = await api("POST", `/runs/${runId}/cancel`, {});
    assert.deepEqual([cancel.body.cancel_requested, cancel.body.already_terminal, cancel.body.status], [false, true, "completed"], JSON.stringify(cancel.body));
    await release();
    const { rows } = await follow(api, runId, TERMINAL, { deadlineMs: 60_000 });
    assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
    // Ids, not contents: a row may change under its id at the end (the usage row's totals).
    assert.deepEqual(rows.map((r) => r.id), first.map((r) => r.id));
  });

  test(`${harness}: a cancel once the run has answered, before any read says it ended, is refused and the run ends completed`, { timeout: 120_000 }, async (t) => {
    const { api, release } = await held(t);
    const runId = await started(api, harness);
    // The answer's row, and the run idle (its turn over: the answer can land while it still works), read from the timeline
    // alone: the run's own view is not asked before the cancel.
    for (let i = 0; !((await timeline(api, runId)).some((r) => r.kind === "final_answer" || r.kind === "text_block") && (await api("GET", `/runs/${runId}/timeline`)).body.state === "idle"); i++) {
      assert.ok(i < 600, "the run answers");
      await sleep(50);
    }
    const cancel = await api("POST", `/runs/${runId}/cancel`, {});
    assert.deepEqual([cancel.body.cancel_requested, cancel.body.already_terminal], [false, true], JSON.stringify(cancel.body));
    await release();
    await follow(api, runId, TERMINAL, { deadlineMs: 60_000 });
    assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
  });
}
