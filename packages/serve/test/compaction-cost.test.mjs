// pi's compaction summary is a paid request: a run that compacts counts it in its requests and its cost, and /usage
// agrees with the run's cost. Its cost entry carries its tokens.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const COMPACT = new URL("./fixtures/faux-compact.mjs", import.meta.url).pathname;
const usageOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage;
/** The run's store entries of `kind`, with their data. */
const entries = (data, runId, kind) => {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === kind);
  } finally {
    db.close();
  }
};

test("a run that compacts counts the summary as a paid request: its cost is in the run's total and in /usage", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: COMPACT });
  assert.equal((await api("POST", "/agents", agent("long"))).status, 201);
  // Six messages at the size limit: past the window's threshold, with older turns to summarize.
  const long = (n) => `Message ${n}. ${"word ".repeat(3_990)}`;
  const { body: run } = await api("POST", "/agents/long/runs", { input: { content: long(1) } });
  await follow(api, run.run_id, ["completed"]);
  for (let n = 2; n <= 6; n++) {
    assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: long(n) })).status, 202);
    await follow(api, run.run_id, ["completed"]);
  }
  const compactions = entries(data, run.run_id, "pi.compaction");
  assert.ok(compactions.length >= 1, "the run compacted");
  const answers = entries(data, run.run_id, "pi.assistant");
  const paid = answers.reduce((sum, entry) => sum + entry.model[0].usage.cost.total, 0);
  const summaries = entries(data, run.run_id, "agentrun.request_cost");
  assert.equal(summaries.length, compactions.length, "each summary's cost is written");
  const summarized = summaries.reduce((sum, entry) => sum + entry.data.usd, 0);
  assert.ok(summarized > 0, "a summary is paid");
  for (const { data } of summaries) {
    assert.deepEqual(Object.keys(data.usage ?? {}).sort(), ["cacheRead", "cacheWrite", "input", "output"], "each summary's cost entry carries its tokens, in pi's shape");
    assert.ok(Object.values(data.usage).every(Number.isSafeInteger) && data.usage.input > 0 && data.usage.output > 0, `a summary's tokens are counts: ${JSON.stringify(data.usage)}`);
  }
  const { rows } = await follow(api, run.run_id, ["completed"]);
  const usage = usageOf(rows);
  assert.equal(usage.requests, answers.length + summaries.length, "every request counts: the answers and the summaries");
  assert.equal(usage.usd, Math.round((paid + summarized) * 1e6) / 1e6, "the run's cost includes the summaries'");
  const view = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.equal(view.cost.usd, usage.usd);
  const total = (await api("GET", "/usage?group_by=agent")).body.total_usd;
  assert.ok(Math.abs(total - usage.usd) < 1e-9, `/usage agrees with the run's cost: ${total} vs ${usage.usd}`);
});
