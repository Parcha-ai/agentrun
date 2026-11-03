// A turn whose model asks for two tools in one answer, on a harness other than pi. The faux harness stands in for
// claude-agent and codex alike: serve's adapter path, which writes the session's requests, calls and results to the run,
// is the same for both. The run completes with its final answer, both files are written, both calls show under the
// answer that asked for them, each one row with its result, and no call reads as interrupted.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
// Under the faux harness claude-agent and codex run one path (the id is only a label), so codex stands for both.
const harness = "codex";

test(`${harness}: two tool calls in one answer, then the closing answer: the run completes, each call shows under the answer that asked for it, one row with its result, none interrupted`, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const id = `two-${harness}`;
  assert.equal((await api("POST", "/agents", agent(id, { harness, instructions: "Write two files in one answer.", tools: ["read", "write", "edit"] }))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Write the word alpha to a.md and the word beta to b.md." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 20_000 });
  assert.deepEqual([last.status, last.final], ["completed", true], `${last.status}/${last.state}`);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Wrote a.md and b.md."], JSON.stringify(run));
  assert.equal(await readFile(join(data, "runs", runId, "work", "a.md"), "utf8"), "alpha");
  assert.equal(await readFile(join(data, "runs", runId, "work", "b.md"), "utf8"), "beta");

  const uses = rows.filter((r) => r.kind === "tool_use");
  assert.deepEqual(uses.map((r) => r.tool_input_preview), ["a.md", "b.md"], JSON.stringify(rows.map((r) => [r.seq, r.kind, r.summary])));
  // Both calls belong to the first answer, never to the closing one.
  assert.equal(new Set(uses.map((r) => r.round)).size, 1, JSON.stringify(uses));
  const final = rows.find((r) => r.kind === "final_answer");
  assert.equal(final?.text, "Wrote a.md and b.md.", JSON.stringify(rows.map((r) => [r.seq, r.kind, r.summary])));
  assert.ok(uses.every((u) => u.seq < final.seq), "both calls come before the closing answer");
  assert.deepEqual(uses.map((r) => [r.tool_status, r.path, r.summary]), [["success", "a.md", "Wrote a.md: ok"], ["success", "b.md", "Wrote b.md: ok"]], JSON.stringify(rows.map((r) => [r.seq, r.kind, r.summary])));
  assert.deepEqual(rows.filter((r) => r.kind === "tool_result"), [], "no result row besides a call's own");
  assert.deepEqual(rows.filter((r) => r.tool_status === "interrupted" || /interrupted/.test(r.summary ?? "")), [], "no call reads as interrupted");
  assert.equal(rows.findLast((r) => r.kind === "usage")?.usage.requests, 2, "two model requests: the one that asked for both calls, and the answer");
});
