// A call that waited for a person's approval reads in order over the one store (run-timeline-served.ts, the Timeline
// GET /runs/{id}/timeline serves): the call
// held, then the approval row, then what came of it, from the run's agentrun.ask and agentrun.answer entries, as the
// file-backed path reads it (runs.ts withApprovals). A Deny's words are "You declined <tool>[: <note>]", an Allow's note is
// shown nowhere (as on main), and an empty result reads "(no output)". The runner writes an answer as { callId, approved, note? }.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { servedTimelineRows } = await import("../dist/run-timeline-served.js");
/** The run's Timeline rows as GET /runs/{id}/timeline serves them. */
const timelineOverStore = (store, runId, deps) => servedTimelineRows({ ...deps, keyEnv: () => ({}) }, store, runId, context);
const { outcomeShows, withApprovalRows } = await import("../dist/run-view.js");
const { ChangeClock, RowLog } = await import("../dist/rows.js");

const iso = (ms) => new Date(ms).toISOString();
const ROOT = 1;
/** A held value the run's redactor cuts: built at run time, never a literal. */
const HELD = ["held", "value", "x".repeat(24)].join("-");
const deps = { origin: "https://run.test", serverSecrets: () => [HELD] };

/** A run whose journal holds, for each call in `calls`, the model's call, the gate's ask, and, if answered, the answer and
 *  the call's result; then the model's last word. Answered calls run in place (the runner's way), so the result is real. */
async function runWith(t, calls, { ended = true } = {}) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "A" }, { id: "rev-1", kind: "agentic", body: { instructions: "Fetch." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Fetch it." } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const j = store.journal(claim);
  const writes = [{ type: "conversation", value: { id: ROOT } }];
  const add = async (entry) => writes.push({ type: "entry", value: { id: await j.mintId(), conversationId: ROOT, ...entry } });
  await add({ kind: "pi.user", model: [{ role: "user", content: "Fetch it.", timestamp: T0 }] });
  let at = T0 + 1_000;
  for (const call of calls) {
    await add({ kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: call.id, name: call.tool, arguments: call.args }], timestamp: (at += 100) }] });
    await add({ kind: "agentrun.ask", data: { callId: call.id, tool: call.tool, args: call.args, requestedAt: iso((at += 100)) } });
    if (!call.answer) continue;
    await add({ kind: "agentrun.answer", data: { callId: call.id, approved: call.answer.approved, ...(call.answer.note !== undefined ? { note: call.answer.note } : {}), ...(call.answer.by ? { by: call.answer.by } : {}) } });
    await add({ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: call.id, toolName: call.tool, content: [{ type: "text", text: call.result.text }], isError: call.result.isError, timestamp: (at += 100) }] });
  }
  if (ended) await add({ kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], timestamp: (at += 100) }] });
  await commitWrites(j, writes, context);
  if (ended) await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", endedAt: at + 100 });
  else await store.runs.update(claim, { state: "parked" });
  return store;
}

const fetchCall = (id, answer, result) => ({ id, tool: "web_fetch", args: { url: "https://example.test" }, ...(answer ? { answer, result } : {}) });
/** The rows of call `id`, then the next two rows: what a person reads for that call. */
function readFor(rows, id) {
  // The call's own rows: its call's and its result's (the approval row carries the call's id too, as runs.ts's does).
  const own = rows.filter((row) => row.tool_use_id === id && (row.kind === "tool_use" || row.kind === "tool_result"));
  const last = rows.indexOf(own.at(-1));
  return { own: own.map((row) => [row.kind, row.summary]), after: rows.slice(last + 1, last + 3) };
}

test("an allowed call reads held, then your approval, then that it ran; a note sent with the allow is shown nowhere", async (t) => {
  const store = await runWith(t, [fetchCall("c1", { approved: true, note: "only the home page" }, { text: "fetched", isError: false })]);
  const rows = await timelineOverStore(store, "run-1", deps);
  const { own, after } = readFor(rows, "c1");
  assert.deepEqual(own, [["tool_use", "Held for your approval"], ["tool_result", "Held for your approval"]], JSON.stringify(rows.map((r) => [r.kind, r.summary])));
  assert.deepEqual([after[0]?.kind, after[0]?.summary], ["tool_approval_requested", 'Asked your approval: web_fetch {"url":"https://example.test"}']);
  assert.deepEqual([after[1]?.kind, after[1]?.origin, after[1]?.summary], ["phase", "server", "AgentRun: web_fetch ran once you allowed it; its result went to the agent"]);
  assert.equal(JSON.stringify(rows).includes("only the home page"), false, "the allow's note is on no row");
  assert.equal(after[1]?.text, "web_fetch ran once you allowed it. Its result:\nfetched");
});

test("an allowed call whose result is empty says it gave no output, never 'Its result:' and nothing", async (t) => {
  const store = await runWith(t, [fetchCall("c1", { approved: true }, { text: "", isError: false })]);
  const { after } = readFor(await timelineOverStore(store, "run-1", deps), "c1");
  assert.equal(after[1]?.summary, "AgentRun: web_fetch ran once you allowed it; its result went to the agent");
  assert.equal(after[1]?.text, "web_fetch ran once you allowed it. Its result: (no output)");
  assert.equal(outcomeShows("bash", { decision: "allow" }, "  \n", false), "bash ran once you allowed it. Its result: (no output)");
  assert.equal(outcomeShows("bash", { decision: "allow" }, "boom", true), "bash ran once you allowed it, and failed. Its result:\nboom");
});

test("a denied call reads held, then your approval, then 'You declined <tool>: <note>', one colon; no note ends with a period", async (t) => {
  const refusal = "The user denied this web_fetch call. It was not run: nothing was sent and nothing was charged. Reason: use scratch instead";
  const store = await runWith(t, [fetchCall("c1", { approved: false, note: "use scratch instead" }, { text: refusal, isError: true }), fetchCall("c2", { approved: false }, { text: "The user denied this web_fetch call.", isError: true })]);
  const rows = await timelineOverStore(store, "run-1", deps);
  const one = readFor(rows, "c1");
  assert.deepEqual(one.own.map(([, s]) => s), ["Held for your approval", "Held for your approval"]);
  assert.equal(one.after[0]?.summary, 'Asked your approval: web_fetch {"url":"https://example.test"}');
  assert.equal(one.after[1]?.summary, "AgentRun: You declined web_fetch: use scratch instead");
  assert.equal(one.after[1]?.text, `You declined web_fetch.\n${refusal}`);
  assert.equal(readFor(rows, "c2").after[1]?.summary, "AgentRun: You declined web_fetch.");
  assert.equal(rows.some((row) => /:saved:/.test(row.id)), false, "no Saved row for a call that never ran");
});

test("a note is redacted whole, its links' query values elided, cut to its first line at 200 code points", async (t) => {
  const note = `use scratch, see https://files.example/doc?sig=s3cr3tQuery and ${HELD} ${"a".repeat(260)}\nsecond line`;
  const store = await runWith(t, [fetchCall("c1", { approved: false, note }, { text: "refused", isError: true })]);
  const summary = readFor(await timelineOverStore(store, "run-1", deps), "c1").after[1]?.summary ?? "";
  assert.match(summary, /^AgentRun: You declined web_fetch: use scratch, see https:\/\/files\.example\/doc\?sig=/);
  assert.equal(summary.includes("s3cr3tQuery"), false, summary);
  assert.equal(summary.includes(HELD.slice(0, 12)), false, summary);
  assert.equal(summary.includes("second line"), false);
  assert.ok(Array.from(summary).length <= "AgentRun: You declined web_fetch: ".length + 200, `${Array.from(summary).length}`);
  assert.ok(summary.endsWith("…"));
});

test("a call still waiting reads not run yet, then waiting for your approval, and no outcome", async (t) => {
  const store = await runWith(t, [fetchCall("c1")], { ended: false });
  const rows = await timelineOverStore(store, "run-1", deps);
  const { own, after } = readFor(rows, "c1");
  assert.deepEqual(own, [["tool_use", "Not run yet: it waits for your approval"]]);
  assert.equal(after[0]?.summary, 'Waiting for your approval: web_fetch {"url":"https://example.test"}');
  assert.equal(rows.some((row) => /^AgentRun: /.test(row.summary ?? "")), false);
});

test("two approvals in one run each read in order, and reading the rows twice gives the same rows", async (t) => {
  const store = await runWith(t, [fetchCall("c1", { approved: true }, { text: "one", isError: false }), fetchCall("c2", { approved: false, note: "not that page twice" }, { text: "refused", isError: true })]);
  const rows = await timelineOverStore(store, "run-1", deps);
  for (const [id, outcome] of [["c1", "AgentRun: web_fetch ran once you allowed it; its result went to the agent"], ["c2", "AgentRun: You declined web_fetch: not that page twice"]]) {
    const { own, after } = readFor(rows, id);
    assert.deepEqual([...own.map(([, s]) => s), after[0]?.kind, after[1]?.summary], ["Held for your approval", "Held for your approval", "tool_approval_requested", outcome], id);
  }
  assert.deepEqual(await timelineOverStore(store, "run-1", deps), rows, "the same rows read again");
});

test("a parked write that was allowed shows no Saved row: the outcome row says it ran, never the call's own Saved row", async (t) => {
  const write = { id: "w1", tool: "write", args: { path: "hello.txt", content: "hello" }, answer: { approved: true }, result: { text: "Successfully wrote 5 bytes to hello.txt", isError: false } };
  const store = await runWith(t, [write]);
  const rows = await timelineOverStore(store, "run-1", deps);
  assert.deepEqual(rows.filter((row) => /^Saved /.test(row.summary ?? "")).map((row) => row.summary), [], JSON.stringify(rows.map((r) => [r.id, r.kind, r.summary])));
  assert.equal(readFor(rows, "w1").after[1]?.summary, "AgentRun: write ran once you allowed it; its result went to the agent");
});

test("a person's message that declined a waiting call is their own row, their words whole, after the outcome", async (t) => {
  const said = `use the cached copy instead, not ${HELD}`;
  const store = await runWith(t, [fetchCall("c1", { approved: false, note: said, by: "message" }, { text: `The user denied this web_fetch call. Reason: ${said}`, isError: true })]);
  const rows = await timelineOverStore(store, "run-1", deps);
  const { after } = readFor(rows, "c1");
  assert.deepEqual([after[0]?.summary.split(":")[0], after[1]?.summary], ["Declined by your message", "AgentRun: Your message declined web_fetch."]);
  const persons = rows.filter((row) => row.kind === "user_message");
  assert.equal(persons.length, 2, JSON.stringify(rows.map((r) => [r.kind, r.summary])));
  assert.equal(persons[0].text, "Fetch it.");
  assert.ok(persons[1].text.startsWith("use the cached copy instead, not "), persons[1].text);
  assert.equal(persons[1]?.summary?.startsWith("You: use the cached copy instead, not "), true, persons[1]?.summary);
  assert.equal(JSON.stringify(persons[1]).includes(HELD.slice(0, 12)), false, "their words go through the run's redactor");
  assert.ok(rows.indexOf(persons[1]) > rows.indexOf(after[1]), "after the outcome");
});

test("served across reads, a call's approval row moves below the call's result once it ran: held, held, your approval, the outcome", () => {
  // The Timeline route keeps the seq each row id was first served with (rows.ts RowLog): the approval row is served while
  // the call waits, before its result row exists. Once the result is in, the approval and outcome rows must still read
  // after it, as the person reads a call: what it was, that it waited, what came of it.
  const use = { id: "1:a", kind: "tool_use", tool_use_id: "c1", tool_name: "web_fetch", summary: "Fetching", text: "" };
  const result = { id: "1:b", kind: "tool_result", tool_use_id: "c1", tool_name: "web_fetch", summary: "Fetched: ok", text: "fetched", tool_status: "success" };
  const answer = { id: "1:c", kind: "final_answer", summary: "done", text: "done" };
  const asks = new Map([["c1", { id: "c1", call_id: "c1", tool: "web_fetch", args_json: '{"url":"https://example.test"}', requested_at: "" }]]);
  const same = (text) => text;
  for (const decision of ["allow", "deny"]) {
    const log = new RowLog(new ChangeClock());
    log.sync(withApprovalRows([use], asks, {}, same));
    // A deny's outcome shows at once, before the refusal is the call's result.
    if (decision === "deny") log.sync(withApprovalRows([use], asks, { c1: { decision, answered_at: "" } }, same));
    log.sync(withApprovalRows([use, result, answer], asks, { c1: { decision, answered_at: "" } }, same));
    const read = log.rows().map((row) => `${row.kind}: ${row.summary.split(":")[0]}`);
    assert.deepEqual(read, ["tool_use: Held for your approval", "tool_result: Held for your approval", "tool_approval_requested: Asked your approval", `phase: AgentRun`, "final_answer: done"], `${decision}: ${JSON.stringify(read)}`);
  }
});

