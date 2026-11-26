// A run's learned workflow calls, each from its own record (runner/workflow-calls.ts workflowCallsOf): the learned_workflow
// tool keeps one entry beside every call it ends (LEARNED_NODES: the workflow, its digest, who called it, how it ended),
// whoever called it, a refusal before any node included. A run's metrics keep them as `workflow_calls`
// (workflow-first.ts pathMetrics, with why its first choice did or did not serve, `first_choice`); the ledger row keeps
// them (learn/ledger.ts record), and the money rule counts a run on the served side of the workflow it charges
// (costLineOf, workflowCostsOf): the platform's when the platform served it first, else each one the agent called that ran:
//   - a call's caller, digest and outcome come from its record; the platform's call ends as its WORKFLOW_FIRST entry
//     says, and one a crash cut before its record is that entry's alone, its cost unknown; a call refused before any
//     node ran is `refused`, and counts on no side;
//   - a call's $ is what its window booked (its start to its end) of host work, and the requests named under it: exact,
//     or null when another call ran beside it (on pi, a sibling subagent's too); never a guessed $0;
//   - a replay or a shadow run keeps no calls: they serve no one;
//   - a run whose record keeps no calls (one that ended before calls were kept) is charged as its path says: the
//     workflow and digest it names when its path is `workflow` or `handed_back`, so a stop made before stays made.
// The tool's own record is checked on a stand-in model registry: no network, no key.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { workflowCallsOf } = await import("../dist/runner/workflow-calls.js");
const { costLineOf, pathMetrics, workflowCostsOf, workflowDigest, WORKFLOW_FIRST, WORKFLOW_FIRST_CALL } = await import("../dist/runner/workflow-first.js");
const { LEARNED_ALLOWED, LEARNED_NODES, learnedCallRan } = await import("../dist/learned-nodes.js");
const { record } = await import("../dist/learn/ledger.js");
const { learnedWorkflowTool } = await import("../dist/learned-workflow.js");

const D = "d".repeat(16);
const START = "agentrun.call.start";
const END = "agentrun.call.end";
const ROOT = 1;
const SESSION = 2;
const start = (callId, tool = "learned_workflow") => ({ kind: START, conversationId: ROOT, data: { callId, tool, input: {}, replaySafe: false } });
const end = (callId, status = "done") => ({ kind: END, conversationId: ROOT, data: { callId, status } });
const kept = (call, over = {}) => ({ kind: LEARNED_NODES, conversationId: ROOT, data: { call, workflow: "a", digest: D, caller: call === WORKFLOW_FIRST_CALL ? "platform" : "agent", nodes: [], ...over } });
/** One booked request in the model session: `host` set for a node's (a learned workflow's side call), else the agent's own. */
const booked = (turn, usd, data = {}) => [
  { kind: "runner.request", conversationId: SESSION, data: { turn, model: "m", ...data } },
  { kind: "runner.turn", conversationId: SESSION, data: { turn, usd, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } },
];
const node = (turn, usd) => booked(turn, usd, { host: "learned_workflow", side: true });

test("an agent's call is its record's: its workflow, digest, caller and outcome, and what its nodes booked in its window, the agent's own requests left out", () => {
  const entries = [
    ...booked(1, 1), // the agent's own turn, before the call
    start("c1"), ...node(2, 0.25), ...node(3, 0.5), kept("c1", { ended: "escalated" }), end("c1"),
    ...booked(4, 2), // the agent's turn after the hand-back
    start("c2"), kept("c2", { workflow: "b", digest: "e".repeat(16), ended: "complete" }), end("c2"),
  ];
  assert.deepEqual(workflowCallsOf(entries), [
    { workflow: "a", digest: D, caller: "agent", outcome: "handed_back", usd: 0.75 },
    { workflow: "b", digest: "e".repeat(16), caller: "agent", outcome: "answered", usd: 0 },
  ]);
  // A call stopped or thrown keeps no `ended`: failed. A record that names no digest or caller is left out.
  assert.deepEqual(workflowCallsOf([start("c1"), kept("c1"), end("c1", "interrupted")]).map((call) => call.outcome), ["failed"]);
  assert.deepEqual(workflowCallsOf([start("c1"), kept("c1", { digest: undefined, ended: "complete" }), end("c1")]), []);
  assert.deepEqual(workflowCallsOf([start("c1"), kept("c1", { caller: "someone", ended: "complete" }), end("c1")]), []);
  // A call run again (after a park or a crash) is one call, its newest record's.
  assert.deepEqual(workflowCallsOf([start("c1"), kept("c1"), kept("c1", { ended: "complete" }), end("c1")]).map((call) => call.outcome), ["answered"]);
});

test("a call's $ is exact or unknown, never a guess: a paid request named under it counts, another call beside it makes it null", () => {
  const nested = [start("c1"), ...node(2, 0.25), start("c1/mcp-1", "mcp__x__read"), ...booked(3, 0.1, { call: "c1/mcp-1" }), end("c1/mcp-1"), kept("c1", { ended: "complete" }), end("c1")];
  assert.equal(workflowCallsOf(nested)[0].usd, 0.35, "its nested call is its own");
  const beside = [start("c1"), start("r1", "read"), ...node(2, 0.25), end("r1"), kept("c1", { ended: "complete" }), end("c1")];
  assert.equal(workflowCallsOf(beside)[0].usd, null, "another call started within its window");
  const open = [start("r1", "read"), start("c1"), ...node(2, 0.25), kept("c1", { ended: "complete" }), end("c1"), end("r1")];
  assert.equal(workflowCallsOf(open)[0].usd, null, "another call still open at its start");
  const unpriced = [start("c1"), { kind: "runner.request", conversationId: SESSION, data: { turn: 2, host: "learned_workflow" } }, kept("c1", { ended: "complete" }), end("c1")];
  assert.equal(workflowCallsOf(unpriced)[0].usd, null, "a request with no booked cost");
  assert.equal(workflowCallsOf([kept("c1", { ended: "complete" })])[0].usd, null, "no start: no window");
});

test("a call with a request a crash cut, booked at its hold, has an unknown $: the hold is the most it can cost, never what it cost, on its record and its ledger row", () => {
  const cut = (turn, hold) => [
    { kind: "runner.request", conversationId: SESSION, data: { turn, model: "m", host: "learned_workflow", side: true } },
    { kind: "runner.turn", conversationId: SESSION, data: { turn, usd: null, cut: true, bookedUsd: hold, rule: "cut", atMost: true } },
  ];
  const entries = [start("c1"), ...node(2, 0.25), ...cut(3, 0.5), kept("c1", { ended: "complete" }), end("c1")];
  const calls = workflowCallsOf(entries);
  assert.equal(calls[0].usd, null, "its call's $ is unknown");
  const { row } = record({ id: "r1", agentId: "agent-1", startedAt: 1, costUsd: 1, costAtMostUsd: 1, metrics: { path: "agent", workflow_calls: calls }, rounds: [] });
  assert.equal(row.workflowCalls[0].usd, null, "its ledger row keeps it unknown");
  assert.equal(workflowCallsOf([start("c1"), ...cut(3, 0.5), kept("c1", { ended: "complete" }), end("c1")])[0].usd, null, "the cut request alone");
});

test("on pi a call's window opens at the answer that asked for it and closes at its tool result; an answer that asked for two is no window of one", () => {
  const asked = (...ids) => ({ kind: "pi.assistant", conversationId: ROOT, model: [{ role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "learned_workflow", arguments: {} })) }] });
  const result = (id) => ({ kind: "pi.tool-result", conversationId: ROOT, model: [{ role: "toolResult", toolCallId: id }] });
  const one = [...booked(1, 1), asked("c1"), ...node(2, 0.25), kept("c1", { ended: "complete" }), result("c1"), ...booked(3, 2)];
  assert.equal(workflowCallsOf(one)[0].usd, 0.25, "the node's request alone: not the answer that asked, nor the one after");
  const two = [...booked(1, 1), asked("c1", "r1"), ...node(2, 0.25), kept("c1", { ended: "complete" }), result("c1"), result("r1")];
  assert.equal(workflowCallsOf(two)[0].usd, null);
});

test("a refused call ran nothing, so its $ is 0 wherever its window can't be told apart: two denied calls in one pi answer, a platform call with no start", () => {
  const asked = (...ids) => ({ kind: "pi.assistant", conversationId: ROOT, model: [{ role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "learned_workflow", arguments: {} })) }] });
  const result = (id) => ({ kind: "pi.tool-result", conversationId: ROOT, model: [{ role: "toolResult", toolCallId: id }] });
  const refused = { ended: "failed", refused: true };
  const two = [...booked(1, 1), asked("c1", "c2"), kept("c1", refused), kept("c2", refused), result("c1"), result("c2"), ...booked(2, 1)];
  assert.deepEqual(workflowCallsOf(two).map(({ outcome, usd }) => [outcome, usd]), [["refused", 0], ["refused", 0]]);
  assert.deepEqual(workflowCallsOf([kept(WORKFLOW_FIRST_CALL, refused)]).map(({ caller, outcome, usd }) => [caller, outcome, usd]), [["platform", "refused", 0]]);
});

test("on pi a subagent's call is its own only while no other conversation works: a sibling subagent running beside it makes its $ unknown", () => {
  const CHILD = 3;
  const SIBLING = 4;
  const asked = (conversationId, ...calls) => ({ kind: "pi.assistant", conversationId, model: [{ role: "assistant", content: calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })) }] });
  const result = (conversationId, id, details) => ({ kind: "pi.tool-result", conversationId, model: [{ role: "toolResult", toolCallId: id, ...(details ? { details } : {}) }] });
  // The agent asks one subagent; its child calls the workflow alone: the subagent's call holds it, the window is its own.
  const alone = [asked(ROOT, ["s1", "subagent"]), asked(CHILD, ["c1", "learned_workflow"]), ...node(2, 0.25), kept("c1", { ended: "complete" }), result(CHILD, "c1"), result(ROOT, "s1", { conversationId: CHILD })];
  assert.equal(workflowCallsOf(alone)[0].usd, 0.25, "the subagent call that holds the child is no other call");
  // Two subagents at once: the sibling's host work lands inside the child's call window, so the call's $ is unknown.
  const siblings = [
    asked(ROOT, ["s1", "subagent"], ["s2", "subagent"]),
    asked(SIBLING, ["w1", "web_search"]),
    asked(CHILD, ["c1", "learned_workflow"]), ...node(2, 0.25), ...booked(3, 0.4, { host: "web_search", side: true }), kept("c1", { ended: "complete" }), result(CHILD, "c1"),
    result(SIBLING, "w1"), result(ROOT, "s1", { conversationId: CHILD }), result(ROOT, "s2", { conversationId: SIBLING }),
  ];
  assert.equal(workflowCallsOf(siblings)[0].usd, null, "a sibling's call still open at its start");
  const busy = [
    asked(ROOT, ["s1", "subagent"], ["s2", "subagent"]),
    asked(CHILD, ["c1", "learned_workflow"]), ...node(2, 0.25), asked(SIBLING, ["w1", "web_search"]), ...booked(3, 0.4, { host: "web_search", side: true }), result(SIBLING, "w1"), kept("c1", { ended: "complete" }), result(CHILD, "c1"),
    result(ROOT, "s1", { conversationId: CHILD }), result(ROOT, "s2", { conversationId: SIBLING }),
  ];
  assert.equal(workflowCallsOf(busy)[0].usd, null, "another conversation worked within its window");
});

test("on pi a toolCall that never got its result (its turn aborted) closes at its conversation's next answer: it holds no later call's window open", () => {
  const CHILD = 3;
  const asked = (conversationId, ...calls) => ({ kind: "pi.assistant", conversationId, model: [{ role: "assistant", content: calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })) }] });
  const result = (conversationId, id) => ({ kind: "pi.tool-result", conversationId, model: [{ role: "toolResult", toolCallId: id }] });
  // The root's web_search was cut with its turn: the root's next answer asks for the workflow, which is its call alone.
  const aborted = [asked(ROOT, ["w1", "web_search"]), ...booked(1, 1), asked(ROOT, ["c1", "learned_workflow"]), ...node(2, 0.25), kept("c1", { ended: "complete" }), result(ROOT, "c1")];
  assert.equal(workflowCallsOf(aborted)[0].usd, 0.25);
  // Another conversation's call with no result yet is still open: it may be at work in the window.
  const other = [asked(CHILD, ["w1", "web_search"]), asked(ROOT, ["c1", "learned_workflow"]), ...node(2, 0.25), kept("c1", { ended: "complete" }), result(ROOT, "c1")];
  assert.equal(workflowCallsOf(other)[0].usd, null);
});

test("a call whose record says refused is refused only while nothing was booked under its call id: one an earlier attempt spent under is failed, at what it booked or unknown, never $0", () => {
  const refused = { ended: "failed", refused: true };
  const outcomes = (entries) => workflowCallsOf(entries).map(({ caller, outcome, usd }) => [caller, outcome, usd]);
  // A CLI's call: the attempt a crash cut booked a node, its rerun refused before any node ran (a call node's tool set
  // to deny since, refused at runLearned; or its gate).
  assert.deepEqual(outcomes([start("c1"), ...node(2, 0.25), start("c1"), kept("c1", refused), end("c1")]), [["agent", "failed", 0.25]]);
  // The cut attempt's request booked with no figure: its $ is unknown.
  const cut = [{ kind: "runner.request", conversationId: SESSION, data: { turn: 2, model: "m", host: "learned_workflow", side: true } }, { kind: "runner.turn", conversationId: SESSION, data: { turn: 2, usd: null, cut: true } }];
  assert.deepEqual(outcomes([start("c1"), ...cut, start("c1"), kept("c1", refused), end("c1")]), [["agent", "failed", null]]);
  // A paid request named under it, its window shared with another call: booked under its id, its $ unknown.
  assert.deepEqual(outcomes([start("c1"), start("r1", "read"), ...booked(2, 0.1, { call: "c1/mcp-1" }), end("r1"), kept("c1", refused), end("c1")]), [["agent", "failed", null]]);
  // The platform's call, no start, a paid request named under it: failed, its $ unknown.
  assert.deepEqual(outcomes([...booked(2, 0.1, { call: WORKFLOW_FIRST_CALL }), kept(WORKFLOW_FIRST_CALL, refused)]), [["platform", "failed", null]]);
  // Nothing booked under it (the agent's own turns beside it are never its): refused at $0.
  assert.deepEqual(outcomes([...booked(1, 1), start("c1"), kept("c1", refused), end("c1"), ...booked(3, 1)]), [["agent", "refused", 0]]);
});

test("whether an attempt of a call refused at its gate may have run: its newest allow mark or record says, and with neither, the bridge's word that it is issued again", () => {
  const mark = (call) => ({ kind: LEARNED_ALLOWED, data: { call } });
  const record = (call, over = {}) => ({ kind: LEARNED_NODES, data: { call, nodes: [], ended: "failed", ...over } });
  assert.equal(learnedCallRan([mark("c1")], "c1"), true, "let go once");
  assert.equal(learnedCallRan([mark("c1"), record("c1", { refused: true })], "c1", true), false, "refused since: its newest says it ran nothing, replayed or not");
  assert.equal(learnedCallRan([record("c1", { refused: true }), mark("c1")], "c1"), true, "let go after its refusal");
  assert.equal(learnedCallRan([record("c1")], "c1"), true, "a record that ran");
  assert.equal(learnedCallRan([mark("c2")], "c1"), false, "another call's mark");
  assert.equal(learnedCallRan([], "c1"), false, "never let go");
  // A run begun before the marks existed has none: an attempt its bridge says was made (`replayed`) may have run.
  assert.equal(learnedCallRan([], "c1", true), true, "issued again, nothing kept");
});

test("a call refused before any node ran is `refused`: it ran nothing, and the money rule counts it on no side", () => {
  assert.deepEqual(workflowCallsOf([start("c1"), kept("c1", { ended: "failed", refused: true }), end("c1")]).map((call) => call.outcome), ["refused"]);
  assert.deepEqual(workflowCallsOf([start("c1"), kept("c1", { ended: "failed" }), end("c1")]).map((call) => call.outcome), ["failed"], "one that ran and failed is failed");
  // The platform's call a check refused before any node ran is refused too, whatever its WORKFLOW_FIRST entry says.
  const platform = [start(WORKFLOW_FIRST_CALL), kept(WORKFLOW_FIRST_CALL, { ended: "failed", refused: true }), end(WORKFLOW_FIRST_CALL), { kind: WORKFLOW_FIRST, conversationId: ROOT, data: { workflow: "a", digest: D, revision: "s", call: WORKFLOW_FIRST_CALL, outcome: "handed_back" } }];
  assert.deepEqual(workflowCallsOf(platform).map((call) => [call.caller, call.outcome]), [["platform", "refused"]]);
  // Ten cheap served runs, and ten newer runs whose agent's call was refused at a by-hand-sized all-in: the workflow's
  // line is its ten served runs alone, under the by-hand cost, so it serves.
  const served = (i) => ({ metrics: { path: "workflow", workflow: "a", workflow_digest: D, workflow_calls: [{ workflow: "a", digest: D, caller: "platform", outcome: "answered", usd: 0.1 }] }, allInUsd: 0.1, startedAt: i });
  const refused = (i) => ({ metrics: { path: "handed_back", workflow_calls: [{ workflow: "a", digest: D, caller: "agent", outcome: "refused", usd: 0 }] }, allInUsd: 1.9, startedAt: 100 + i });
  const past = { runs: [...Array.from({ length: 10 }, (_, i) => served(i)), ...Array.from({ length: 10 }, (_, i) => refused(i))], by_hand: { runs: 20, mean_usd: 1 }, by_hand_unknown: 0 };
  assert.deepEqual(costLineOf(past, "a", D).served, { runs: 10, mean_usd: 0.1 });
  assert.deepEqual(workflowCostsOf(past).map(({ workflow, state, served }) => ({ workflow, state, served })), [{ workflow: "a", state: "serving", served: { runs: 10, mean_usd: 0.1 } }]);
  // Refused calls alone name no workflow on the cost page.
  assert.deepEqual(workflowCostsOf({ ...past, runs: past.runs.filter((run) => run.startedAt >= 100) }), []);
});

test("a run whose record keeps no calls is charged as its path says: a workflow stopped on runs from before calls were kept stays stopped", () => {
  const by_hand = { runs: 10, mean_usd: 1 };
  // Its served runs as the record of a run that ended before calls were kept reads: path, workflow and digest, no calls.
  const old = (i, path = "workflow", over = {}) => ({ metrics: { path, workflow: "a", workflow_digest: D, ...over }, allInUsd: 2, startedAt: i });
  const stopped = { runs: Array.from({ length: 10 }, (_, i) => old(i, i % 2 ? "workflow" : "handed_back")), by_hand, by_hand_unknown: 0 };
  assert.deepEqual(costLineOf(stopped, "a", D).served, { runs: 10, mean_usd: 2 });
  assert.deepEqual(workflowCostsOf(stopped).map(({ workflow, digest, state }) => [workflow, digest, state]), [["a", D, "needs_revision"]]);
  // Mixed: five old runs and five whose record keeps the platform's call: ten served runs, still over the line.
  const kept = (i) => ({ metrics: { path: "workflow", workflow: "a", workflow_digest: D, workflow_calls: [{ workflow: "a", digest: D, caller: "platform", outcome: "answered", usd: 0.5 }] }, allInUsd: 2, startedAt: 100 + i });
  const mixed = { runs: [...Array.from({ length: 5 }, (_, i) => old(i)), ...Array.from({ length: 5 }, (_, i) => kept(i))], by_hand, by_hand_unknown: 0 };
  assert.deepEqual(costLineOf(mixed, "a", D).served, { runs: 10, mean_usd: 2 });
  assert.deepEqual(workflowCostsOf(mixed).map(({ state }) => state), ["needs_revision"]);
  // The path alone never charges more than it did: the agent's path, another digest, or no digest charges nothing; and a
  // record that keeps calls (refused ones included) is charged by its calls, never its path.
  const none = [old(0, "agent"), old(1, "workflow", { workflow_digest: "e".repeat(16) }), old(2, "handed_back", { workflow_digest: undefined }), old(3, "handed_back", { workflow_calls: [{ workflow: "a", digest: D, caller: "agent", outcome: "refused", usd: 0 }] })];
  assert.deepEqual(costLineOf({ runs: none, by_hand, by_hand_unknown: 0 }, "a", D).served, { runs: 0, mean_usd: null });
});

test("whose run it is: one the platform served first counts for that workflow alone; one only the agent called counts for each workflow that ran", () => {
  const call = (workflow, caller, outcome = "answered") => ({ workflow, digest: D, caller, outcome, usd: 0.05 });
  const runs = (calls, allIn = 1.2) => Array.from({ length: 10 }, (_, i) => ({ metrics: { path: "handed_back", workflow_calls: calls }, allInUsd: allIn, startedAt: i }));
  const by_hand = { runs: 10, mean_usd: 1 };
  // The platform ran A first and handed back; the agent then called B: the run is A's.
  const both = { runs: runs([call("a", "platform", "handed_back"), call("b", "agent")]), by_hand, by_hand_unknown: 0 };
  assert.deepEqual(workflowCostsOf(both).map(({ workflow, state }) => [workflow, state]), [["a", "needs_revision"]]);
  assert.deepEqual(costLineOf(both, "b", D).served, { runs: 0, mean_usd: null }, "B is charged nothing for A's run");
  // The agent alone called A and B: each that ran is charged the run.
  const agent = { runs: runs([call("a", "agent"), call("b", "agent")]), by_hand, by_hand_unknown: 0 };
  assert.deepEqual(workflowCostsOf(agent).map(({ workflow, state }) => [workflow, state]), [["a", "needs_revision"], ["b", "needs_revision"]]);
  // The platform's call refused before any node ran served nothing first: the run is the agent's calls'.
  const refusedFirst = { runs: runs([call("a", "platform", "refused"), call("b", "agent")]), by_hand, by_hand_unknown: 0 };
  assert.deepEqual(workflowCostsOf(refusedFirst).map(({ workflow }) => workflow), ["b"]);
});

test("the platform's call ends as its WORKFLOW_FIRST entry says; one a crash cut before its record is that entry's alone, its cost unknown", () => {
  const served = (outcome) => ({ kind: WORKFLOW_FIRST, conversationId: ROOT, data: { workflow: "a", digest: D, revision: "s", call: WORKFLOW_FIRST_CALL, outcome } });
  // Its workflow completed, and its answer could not be shaped to the agent's schema: handed back.
  const shaped = [start(WORKFLOW_FIRST_CALL), ...node(1, 0.2), kept(WORKFLOW_FIRST_CALL, { ended: "complete" }), end(WORKFLOW_FIRST_CALL), served("handed_back")];
  assert.deepEqual(workflowCallsOf(shaped), [{ workflow: "a", digest: D, caller: "platform", outcome: "handed_back", usd: 0.2 }]);
  assert.deepEqual(workflowCallsOf([start(WORKFLOW_FIRST_CALL), end(WORKFLOW_FIRST_CALL, "interrupted"), served("handed_back")]), [{ workflow: "a", digest: D, caller: "platform", outcome: "handed_back", usd: null }]);
  // The money rule's stop is no call.
  assert.deepEqual(workflowCallsOf([{ kind: WORKFLOW_FIRST, conversationId: ROOT, data: { workflow: "a", digest: D, revision: "s", outcome: "needs_revision", served_usd: 2, by_hand_usd: 1, runs: 10 } }]), []);
});

test("a learning run's metrics keep its calls and its first choice's reason; a replay or a shadow keeps no calls; a run that learns nothing keeps neither", () => {
  const entries = [start("c1"), ...node(2, 0.25), kept("c1", { ended: "complete" }), end("c1")];
  const launch = { input: { q: 1 }, learning: { seed: "seed-1", workflows: ["a"] } };
  const metrics = pathMetrics(launch, { path: "workflow", workflow: "a" }, entries, "none_fit");
  assert.deepEqual(metrics.workflow_calls, [{ workflow: "a", digest: D, caller: "agent", outcome: "answered", usd: 0.25 }]);
  assert.equal(metrics.first_choice, "none_fit");
  assert.equal(metrics.workflow_digest, undefined, "the top-level digest stays the platform's call's, which the audits read");
  assert.deepEqual(pathMetrics(launch, { path: "agent", workflow: null }, []).workflow_calls, [], "a learning run that called none keeps an empty list");
  const replay = pathMetrics({ ...launch, replay: { of: "r0", workflow: "a", digest: D } }, { path: "workflow", workflow: "a" }, entries, "replay");
  assert.equal(replay.workflow_calls, undefined);
  assert.equal(replay.first_choice, "replay");
  assert.equal(pathMetrics({ input: {}, audit: { of: "r0", workflow: "a", digest: D } }, undefined, entries).workflow_calls, undefined);
  assert.deepEqual(pathMetrics({ input: {} }, undefined, entries, "none_laid"), {});
});

test("the ledger row keeps the run's calls, and the money rule counts a run whose agent called the workflow at its digest", () => {
  const call = { workflow: "a", digest: D, caller: "agent", outcome: "handed_back", usd: 0.25 };
  const { row } = record({ id: "r1", agentId: "agent-1", startedAt: 1, costUsd: 1, costAtMostUsd: null, metrics: { path: "handed_back", workflow: "a", workflow_calls: [call, { workflow: "a" }] }, rounds: [] });
  assert.deepEqual(row.workflowCalls, [call], "each call checked, one off its shape left out");
  assert.deepEqual(record({ id: "r2", agentId: "agent-1", startedAt: 2, costUsd: 1, costAtMostUsd: null, metrics: { path: "agent" }, rounds: [] }).row.workflowCalls, []);
  const past = {
    runs: [
      { metrics: { path: "handed_back", workflow: "a", workflow_calls: [call] }, allInUsd: 1.5, startedAt: 3 },
      { metrics: { path: "workflow", workflow: "a", workflow_digest: D, workflow_calls: [{ ...call, caller: "platform", outcome: "answered" }] }, allInUsd: 0.5, startedAt: 2 },
      // A run that named the workflow but kept no calls (one from before calls were kept) counts as its path says.
      { metrics: { path: "handed_back", workflow: "a", workflow_digest: D }, allInUsd: 9, startedAt: 1 },
    ],
    by_hand: { runs: 1, mean_usd: 1 },
    by_hand_unknown: 0,
  };
  assert.deepEqual(costLineOf(past, "a", D).served, { runs: 3, mean_usd: 3.666667 });
  assert.deepEqual(workflowCostsOf(past).map(({ workflow, digest, served }) => ({ workflow, digest, served })), [{ workflow: "a", digest: D, served: { runs: 3, mean_usd: 3.666667 } }]);
});

// The tool's record, on a stand-in model: a one-node workflow whose node submits its answer at once.
const MODEL = { id: "stand-in", provider: "stand-in", api: "stand-in", name: "stand-in", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content, stopReason) => ({ role: "assistant", content, stopReason, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage, timestamp: Date.now() });
const FLOW = {
  v: 2, name: "one-step",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
};

test("the learned_workflow tool keeps its call's record whoever called it, a refusal before any node included", { timeout: 60_000 }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "workflow-calls-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const models = {
    getModel: () => MODEL,
    getModels: () => [MODEL],
    completeSimple: async (_model, context) => ((context?.messages ?? []).some((m) => m.role === "toolResult") ? message([{ type: "text", text: "Done." }], "stop") : message([{ type: "toolCall", id: "submit-1", name: "submit", arguments: { value: { answer: 42 } } }], "toolUse")),
  };
  const text = JSON.stringify(FLOW);
  const tool = learnedWorkflowTool({ workflows: [{ name: "one-step", description: "One step", workflow: text }], granted: [], env: {}, work, models, modelOf: () => ({ provider: MODEL.provider, modelId: MODEL.id }), policy: () => "allow", denyFrom: () => "default" });
  const call = async (callId, input) => {
    const entries = [];
    const api = { callId, commit: async (change) => change({ appendEntry: async (_conversation, entry) => void entries.push(entry) }) };
    await tool.execute({ name: "one-step", input }, api, {});
    return entries.filter((entry) => entry.kind === LEARNED_NODES).map((entry) => entry.data);
  };
  const [agent] = await call("call-1", { question: "six times seven" });
  assert.deepEqual({ call: agent.call, workflow: agent.workflow, digest: agent.digest, caller: agent.caller, ended: agent.ended }, { call: "call-1", workflow: "one-step", digest: workflowDigest({ workflow: text }), caller: "agent", ended: "complete" });
  const [platform] = await call(WORKFLOW_FIRST_CALL, { question: "six times seven" });
  assert.equal(platform.caller, "platform");
  const refused = await call("call-2", "not an object");
  assert.equal(refused.length, 1, "a call refused before any node still keeps its record");
  assert.deepEqual({ caller: refused[0].caller, ended: refused[0].ended, nodes: refused[0].nodes, refused: refused[0].refused }, { caller: "agent", ended: "failed", nodes: [], refused: true });
  assert.equal(agent.refused, undefined, "a call that ran is no refusal");
});
