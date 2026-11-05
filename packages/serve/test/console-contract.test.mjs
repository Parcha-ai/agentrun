// The public console client against the standalone server and real child processes on its scripted model.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createClient, ClientError, follow } from "../../../apps/console/dist/library/index.js";
import { startServe } from "../dist/index.js";
import { agent, flowAgent, FAUX, scratch, serve } from "./support.mjs";

const typed = (server, token = server.token) => createClient({ base: server.baseUrl, auth: { type: "bearer", token } });
const refusal = (status, code) => (error) => error instanceof ClientError && error.status === status && error.code === code;

/** Stop at a state the non-final timeline keeps polling, using the request's abort instead of a timing delay. */
async function until(v2, runId, status) {
  const ctl = new AbortController();
  let page;
  let rows = [];
  await follow(v2, runId, { signal: ctl.signal, waitMs: 2_000, minDelayMs: 0,
    onRows: (next) => { rows = next; },
    onPage: (next) => { page = next; if (next.status === status && !next.has_more) ctl.abort(); },
  });
  assert.equal(page.status, status);
  return { page, rows };
}

const finish = async (v2, id) => {
  const rows = [];
  const page = await follow(v2, id, { waitMs: 2_000, minDelayMs: 0, onRows: (next) => { rows.splice(0, rows.length, ...next); } });
  assert.equal(page.final, true);
  return { run: await v2.getRun(id), page, rows };
};

test("the exported console client preserves native revisions, request identity, input and file bytes across restart", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const server = await serve(t, { data });
  let v2 = typed(server);
  const ids = {};

  await t.test("capabilities and unauthorized reads use the real server contract", async () => {
    assert.ok((await v2.capabilities()).harnesses.some((h) => h.id === "pi" && h.available));
    await assert.rejects(typed(server, "incorrect-token").listRuns(), refusal(401, "unauthenticated"));
  });

  await t.test("skills survive an edit, equivalent saves do not duplicate revisions, stale edits are refused", async () => {
    const made = await v2.createAgent({ ...agent("console-writer", { tools: ["write"], skills: ["cite"] }), skills: { "cite/SKILL.md": "# Cite\nPreserve original evidence.\n" } });
    ids.revision = made.revision;
    const { etag } = await v2.getAgent(made.agent_id);
    const changed = await v2.updateDefinition(made.agent_id, { definition: { instructions: "Write a concise report." } }, etag);
    assert.notEqual(changed.agent.revision, made.revision);
    assert.deepEqual(changed.agent.skills.map((s) => s.path), ["cite/SKILL.md"]);
    await assert.rejects(v2.updateDefinition(made.agent_id, { definition: { instructions: "Overwrite someone else's edit." } }, etag), refusal(412, "precondition_failed"));
    const same = await v2.updateDefinition(made.agent_id, { definition: { instructions: "Write a concise report." } }, changed.etag);
    assert.equal(same.agent.revision, changed.agent.revision);
    assert.equal((await v2.listRevisions(made.agent_id)).revisions.length, 2);
    await assert.rejects(v2.updateDefinition(made.agent_id, { definition: { tools: ["unsupported-tool"] } }, changed.etag), refusal(422, "input_invalid"));
  });

  await t.test("a selected old revision is pinned and duplicate submissions return the same run", async () => {
    const body = { input: { content: "Write the report." }, revision: ids.revision };
    const first = await v2.startRun("console-writer", body, "console-contract-writer-1");
    const duplicate = await v2.startRun("console-writer", body, "console-contract-writer-1");
    assert.equal(duplicate.run.run_id, first.run.run_id);
    ids.writer = first.run.run_id;
    const { run, rows } = await finish(v2, ids.writer);
    assert.equal(run.revision, ids.revision);
    assert.equal(run.agent_version, 1);
    assert.equal(run.status, "completed");
    assert.equal(run.result.final_answer, "I wrote report.md.");
    assert.ok(rows.some((r) => r.kind === "tool_result"));
    assert.equal((await v2.listAgentRuns("console-writer")).runs.length, 1);
    assert.equal(await v2.readFile(ids.writer, "report.md"), "# Report\n\nThe answer is 42.\n");
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    await writeFile(join(data, "runs", ids.writer, "work", "plot.png"), original);
    const files = await v2.listFiles(ids.writer);
    assert.deepEqual([files.complete, files.truncated], [true, false]);
    assert.ok(files.files.some((f) => f.path === "plot.png"));
    assert.deepEqual(new Uint8Array(await (await v2.readFileBlob(ids.writer, "plot.png")).arrayBuffer()), original);
    await assert.rejects(v2.readFileBlob(ids.writer, ".agents/skills/cite/SKILL.md"), refusal(403, "system_file_forbidden"));
    await assert.rejects(typed(server, "incorrect-token").readFileBlob(ids.writer, "plot.png"), refusal(401, "unauthenticated"));
  });

  await t.test("a real ask_person request is answered once and returns its final result", async () => {
    await v2.createAgent(agent("console-regions", { tools: ["ask_person"] }));
    const started = await v2.startRun("console-regions", { input: { content: "Pick a region." } }, "console-contract-question-1");
    ids.question = started.run.run_id;
    const waiting = await until(v2, ids.question, "input_required");
    assert.equal(waiting.page.state, "waiting");
    const sent = await v2.sendMessage(ids.question, "EU", "console-contract-answer-1");
    const repeated = await v2.sendMessage(ids.question, "EU", "console-contract-answer-1");
    assert.deepEqual(repeated, sent);
    assert.equal(sent.mode, "answer");
    const { run, rows } = await finish(v2, ids.question);
    assert.equal(run.result.final_answer, '{"region":"EU"}');
    assert.equal(rows.filter((r) => r.kind === "user_message" && r.text === "EU").length, 1);
  });

  await t.test("stop keeps a run continuable; cancellation makes a different run terminal", async () => {
    await v2.createAgent(agent("console-slow"));
    const stopped = await v2.startRun("console-slow", { input: { content: "Take your time." } }, "console-contract-stop-1");
    await until(v2, stopped.run.run_id, "working");
    const stop = await v2.stop(stopped.run.run_id);
    assert.equal(stop.stopped, true);
    assert.equal((await until(v2, stopped.run.run_id, "input_required")).page.state, "idle");
    assert.equal((await v2.sendMessage(stopped.run.run_id, "go on", "console-contract-follow-up-1")).mode, "follow_up");
    assert.equal((await finish(v2, stopped.run.run_id)).run.result.final_answer, "On go on: done.");
    const cancelled = await v2.startRun("console-slow", { input: { content: "Take your time." } }, "console-contract-cancel-1");
    ids.cancelled = cancelled.run.run_id;
    const accepted = await v2.cancel(ids.cancelled);
    assert.equal(accepted.cancel_requested, true);
    assert.equal((await finish(v2, ids.cancelled)).run.status, "cancelled");
    await assert.rejects(v2.sendMessage(ids.cancelled, "again", "console-contract-cancelled-message-1"), refusal(409, "not_continuable"));
  });

  await t.test("workflow capabilities and failures remain distinct from agentic continuation", async () => {
    await v2.createAgent(flowAgent("console-workflow"));
    const started = await v2.startRun("console-workflow", { input: { question: "What is six times seven?" } }, "console-contract-workflow-1");
    const { run } = await finish(v2, started.run.run_id);
    assert.equal(run.kind, "workflow");
    assert.deepEqual(run.result.output, { answer: 42 });
    await assert.rejects(v2.sendMessage(run.run_id, "again", "console-contract-workflow-message-1"), refusal(501, "unsupported_here"));
    const failed = await v2.startRun("console-slow", { input: { content: "Fail now." } }, "console-contract-failure-1");
    const failure = (await finish(v2, failed.run.run_id)).run;
    assert.equal(failure.status, "failed");
    assert.equal(failure.error.code, "run_failed");
    const first = await v2.listRuns(1);
    assert.ok(first.next_cursor);
    const second = await v2.listRuns(1, first.next_cursor);
    assert.notEqual(second.runs[0].run_id, first.runs[0].run_id);
  });

  await t.test("restart reopens completed and cancelled runs and resets an old cursor", async () => {
    const timeline = await v2.getTimeline(ids.writer);
    await server.close();
    const reopened = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "2s" });
    t.after(() => reopened.close());
    v2 = typed(reopened);
    assert.equal((await v2.getRun(ids.writer)).result.final_answer, "I wrote report.md.");
    assert.equal((await v2.getRun(ids.cancelled)).status, "cancelled");
    assert.equal((await v2.getTimeline(ids.writer, { after: timeline.next_after })).reset, true);
    assert.equal(await v2.readFile(ids.writer, "report.md"), "# Report\n\nThe answer is 42.\n");
    await assert.rejects(v2.sendMessage(ids.cancelled, "after restart", "console-contract-after-restart-1"), refusal(409, "not_continuable"));
  });
});
