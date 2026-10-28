// A run's timeline only grows: rows it has shown stay, in order, when a woken run's conversation has been compacted and
// its live view no longer holds the messages the summary replaced.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const COMPACT = new URL("./fixtures/faux-compact.mjs", import.meta.url).pathname;

test("after a compaction, a woken run's timeline still holds every message sent, in order", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: COMPACT });
  assert.equal((await api("POST", "/agents", agent("long"))).status, 201);
  const long = (n) => `Message ${n}. ${"word ".repeat(3_990)}`;
  const { body: run } = await api("POST", "/agents/long/runs", { input: { content: long(1) } });
  await follow(api, run.run_id, ["completed"]);
  for (let n = 2; n <= 6; n++) {
    assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: long(n) })).status, 202);
    await follow(api, run.run_id, ["completed"]);
  }
  const { rows } = (await api("GET", `/runs/${run.run_id}/timeline`)).body;
  assert.ok(rows.some((r) => r.kind === "phase" && /Summarized/.test(r.summary ?? "")), "the run compacted");
  const sent = rows.filter((r) => r.kind === "user_message").map((r) => /Message (\d+)\./.exec(r.text ?? r.summary ?? "")?.[1]);
  assert.deepEqual(sent, ["1", "2", "3", "4", "5", "6"], "every message, in the order sent");
  assert.equal(rows.filter((r) => r.kind === "final_answer").length, 6, "and every answer");
});
