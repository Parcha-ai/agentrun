// A Claude Code or Codex run's Timeline rows carry the time each entry was written, as a pi run's do (#2206): the
// loop's CLI record (adapter-loop.ts openCliRecord) stamps each of its entries (`at`), and the store's read of the record
// (store-reads/journal.ts piShaped) carries that time onto the pi-shaped message the renderer dates its row by. Before,
// every row of such a run read 1970-01-01T00:00:00.000Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const SCRIPT = fixture("faux-gate.mjs");

for (const harness of ["claude-agent", "codex"]) {
  test(`a ${harness} run's Timeline rows are dated when they were written, within the run's start and end, never 1970`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { faux: SCRIPT, harnessTable: fauxTable(SCRIPT) });
    assert.equal((await api("POST", "/agents", agent(`dated-${harness}`, { harness, instructions: "Answer." }))).status, 201);
    const before = Date.now();
    const started = await api("POST", `/agents/dated-${harness}/runs`, { input: { content: "Say something." } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const { rows } = await follow(api, started.body.run_id, ["completed"], { deadlineMs: 90_000 });
    const after = Date.now();
    const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
    // The person's message and the model's answer are rows of the run's own record.
    const shown = rows.filter((row) => row.kind === "user_message" || row.kind === "final_answer");
    assert.deepEqual(shown.map((row) => row.kind), ["user_message", "final_answer"], JSON.stringify(rows.map((row) => [row.kind, row.summary])));
    const [from, to] = [Date.parse(view.created_at), Date.parse(view.ended_at ?? new Date(after).toISOString())];
    for (const row of shown) {
      for (const field of ["timestamp", "created_at"]) {
        const at = Date.parse(row[field]);
        assert.ok(at > 0, `${harness} ${row.kind}: its ${field} is ${row[field]}, never epoch 0`);
        // Within the run's start and end (a second's slack either side for the clocks' rounding).
        assert.ok(at >= Math.min(from, before) - 1_000 && at <= Math.max(to, after) + 1_000, `${harness} ${row.kind}: its ${field} ${row[field]} is within the run (${view.created_at} to ${view.ended_at})`);
      }
    }
    // In the order they were written: the answer no earlier than the message it answers.
    assert.ok(Date.parse(shown[1].created_at) >= Date.parse(shown[0].created_at), `${harness}: the answer is dated after the message`);
  });
}
