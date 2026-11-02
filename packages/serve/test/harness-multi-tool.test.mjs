// A turn whose model asks for two tools in one answer, on a harness other than pi. The faux harness stands in for
// claude-agent and codex alike: serve's adapter path, which writes the session's requests, calls and results to the run,
// is the same for both. The run completes with its final answer, both files are written, both calls show under the
// answer that asked for them and before their results, and no call reads as interrupted.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

for (const harness of ["claude-agent", "codex"]) {
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
    assert.equal(await readFile(join(data, "runs", runId, "work", "a.md"), "utf8"), "alpha");
    assert.equal(await readFile(join(data, "runs", runId, "work", "b.md"), "utf8"), "beta");

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
}
