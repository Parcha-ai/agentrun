// A turn whose model asks for two tools in one answer, on a harness other than pi. The faux harness stands in for
// claude-agent and codex alike: serve's adapter path, which writes the session's requests, calls and results to the run,
// is the same for both. The run completes with its final answer, both files are written, both calls show under the
// answer that asked for them and before their results, and no call reads as interrupted. The same holds when the calls
// end before the answer that asked for them is paid, as with Claude Code, whose cost comes in after its response: each
// result is stored before its call, and the timeline and the run's metrics still read each as its call's, once.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { agent, follow, runDir, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
// Under the faux harness claude-agent and codex run one path (the id is only a label), so codex stands for both.
const harness = "codex";

test(`${harness}: two tool calls in one answer, then the closing answer: the run completes, each call shows before its result under the answer that asked for it, none interrupted`, async (t) => {
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
  assert.equal(await readFile(join(runDir(data, runId), "work", "a.md"), "utf8"), "alpha");
  assert.equal(await readFile(join(runDir(data, runId), "work", "b.md"), "utf8"), "beta");

  const uses = rows.filter((r) => r.kind === "tool_use");
  const results = rows.filter((r) => r.kind === "tool_result");
  assert.deepEqual(uses.map((r) => r.tool_input_preview), ["a.md", "b.md"], JSON.stringify(rows.map((r) => [r.seq, r.kind, r.summary])));
  // Both calls belong to the first answer, never to the closing one.
  assert.equal(new Set(uses.map((r) => r.round)).size, 1, JSON.stringify(uses));
  const final = rows.find((r) => r.kind === "final_answer");
  assert.equal(final?.text, "Wrote a.md and b.md.", JSON.stringify(rows.map((r) => [r.seq, r.kind, r.summary])));
  assert.ok(uses.every((u) => u.seq < final.seq), "both calls come before the closing answer");
  for (const use of uses) {
    const result = results.find((r) => r.tool_use_id === use.tool_use_id);
    assert.ok(result && use.seq < result.seq, `${use.tool_input_preview}: its call before its result: ${JSON.stringify(rows.map((r) => [r.seq, r.kind, r.summary]))}`);
    assert.equal(result.tool_status, "success", JSON.stringify(result));
  }
  assert.deepEqual(rows.filter((r) => /interrupted/.test(r.summary ?? "") || String(r.id).includes(":interrupted:")), [], "no call reads as interrupted");
  assert.equal(rows.findLast((r) => r.kind === "usage")?.usage.requests, 2, "two model requests: the one that asked for both calls, and the answer");
});

test("claude-agent: two tool calls that end before their answer is paid: each call is stored before its result, at a cost still to come, and reads as its call's, once, none interrupted, and the run's metrics count two calls, none failed", async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  assert.equal((await api("POST", "/agents", agent("streamed", { harness: "claude-agent", instructions: "Write two files while answering.", tools: ["read", "write", "edit"] }))).status, 201);
  const started = await api("POST", "/agents/streamed/runs", { input: { content: "Write the word alpha to a.md and the word beta to b.md." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 20_000 });
  assert.deepEqual([last.status, last.final], ["completed", true], `${last.status}/${last.state}`);
  const shown = JSON.stringify(rows.map((r) => [r.seq, r.kind, r.summary]));

  // The store: each call before its result, the answer that holds it written at a cost still to come: the Timeline
  // never shows a result above its call.
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  const entries = db.prepare("SELECT id, record FROM entries WHERE conversation_id = 1 ORDER BY id").all().map((r) => ({ id: r.id, ...JSON.parse(r.record) }));
  db.close();
  const callAt = new Map();
  for (const e of entries) if (e.kind === "pi.assistant") for (const b of e.model?.[0]?.content ?? []) if (b.type === "toolCall") callAt.set(b.id, e.id);
  const stored = entries.filter((e) => e.kind === "pi.tool-result").map((e) => [e.model[0].toolCallId, callAt.get(e.model[0].toolCallId), e.id]);
  assert.equal(stored.length, 2, JSON.stringify(stored));
  for (const [call, at, result] of stored) assert.ok(at !== undefined && at < result, `the call ${call} (entry ${at}) is stored before its result (entry ${result})`);
  // And in the rows a reader sees: each call above its result.
  for (const use of rows.filter((r) => r.kind === "tool_use")) assert.ok(rows.findIndex((r) => r.kind === "tool_result" && r.tool_use_id === use.tool_use_id) > rows.indexOf(use), `${use.tool_use_id}: its call above its result: ${JSON.stringify(rows.map((r) => [r.seq, r.kind, r.tool_use_id]))}`);

  // The timeline reads each such result as its call's: each call once, with its one result, which names its file;
  // nothing interrupted.
  const uses = rows.filter((r) => r.kind === "tool_use");
  const results = rows.filter((r) => r.kind === "tool_result");
  assert.deepEqual(uses.map((r) => r.tool_input_preview), ["a.md", "b.md"], shown);
  for (const use of uses) {
    const of = results.filter((r) => r.tool_use_id === use.tool_use_id);
    assert.equal(of.length, 1, `${use.tool_input_preview}: one result: ${shown}`);
    assert.equal(of[0].tool_status, "success", JSON.stringify(of[0]));
    assert.match(of[0].summary, new RegExp(use.tool_input_preview.replace(".", "\\.")), `the result names ${use.tool_input_preview}: ${shown}`);
  }
  assert.deepEqual(rows.filter((r) => /interrupted/.test(r.summary ?? "") || String(r.id).includes(":interrupted:")), [], `no call reads as interrupted: ${shown}`);

  // The run's metrics: two write calls, none failed.
  const reader = openStoreReader(data);
  try {
    assert.deepEqual(reader.runMetrics(runId)?.tools, { write: { calls: 2, errors: 0 } });
  } finally {
    reader.close();
  }
});

for (const on of ["claude-agent", "codex"]) {
  test(`${on}: one answer that writes, calls, writes again and calls again, both calls ending before it is paid: one request for it, its cost known, the later text and call its continuation`, async (t) => {
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
    assert.equal((await api("POST", "/agents", agent("between", { harness: on, instructions: "Write between two calls.", tools: ["read", "write", "edit"] }))).status, 201);
    const started = await api("POST", "/agents/between/runs", { input: { content: "Write alpha to a.md and beta to b.md." } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 20_000 });
    assert.deepEqual([last.status, last.final], ["completed", true], `${last.status}/${last.state}`);
    const shown = JSON.stringify(rows.map((r) => [r.seq, r.kind, r.summary]));
    // The run's usage: two requests (the answer with both calls, and the closing one), at their known cost.
    const usage = rows.findLast((r) => r.kind === "usage")?.usage;
    assert.equal(usage?.requests, 2, `two requests: ${JSON.stringify(usage)}`);
    assert.equal(usage?.usd, 0.003, `the known cost of both: ${JSON.stringify(usage)}`);
    assert.equal((await api("GET", `/runs/${runId}`)).body.cost?.usd, 0.003, "the run's cost is known");
    // The store: the text and the call after the first call's end are that answer's continuation, marked so.
    const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    const entries = db.prepare("SELECT id, record FROM entries WHERE conversation_id = 1 ORDER BY id").all().map((r) => ({ id: r.id, ...JSON.parse(r.record) }));
    db.close();
    const answers = entries.filter((e) => e.kind === "pi.assistant").map((e) => (e.model?.[0]?.content ?? []).map((b) => (b.type === "text" ? b.text : `call:${b.name}`)).join(" | "));
    assert.deepEqual(answers, ["First I write a.md. | call:write", "Then b.md. | call:write", "Wrote both."], JSON.stringify(answers));
    const later = entries.findIndex((e) => e.kind === "pi.assistant" && JSON.stringify(e.model).includes("Then b.md."));
    assert.equal(entries[later - 1]?.kind, "agentrun.request_continued", "the later text and call are marked as the answer's continuation");
    // Each call above its result, in the rows a reader sees.
    for (const use of rows.filter((r) => r.kind === "tool_use")) assert.ok(rows.findIndex((r) => r.kind === "tool_result" && r.tool_use_id === use.tool_use_id) > rows.indexOf(use), shown);
  });
}
