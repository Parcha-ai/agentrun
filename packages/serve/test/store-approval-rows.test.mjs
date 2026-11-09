// A call that waited for a person's approval reads in order over the one store (store-view.ts timelineOverStore): the call
// held, then the approval row, then what came of it, from the run's agentrun.ask and agentrun.answer entries, as the
// file-backed path reads it (runs.ts withApprovals). A Deny's words are "You declined <tool>[: <note>]", an Allow's note is
// shown nowhere (as on main), and an empty result reads "(no output)". The runner writes an answer as { callId, approved, note? }.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { timelineOverStore } = await import("../dist/store-view.js");
const { outcomeShows } = await import("../dist/run-view.js");

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
    await add({ kind: "agentrun.answer", data: { callId: call.id, approved: call.answer.approved, ...(call.answer.note !== undefined ? { note: call.answer.note } : {}) } });
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
