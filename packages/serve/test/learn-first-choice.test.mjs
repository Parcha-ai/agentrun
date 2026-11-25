// firstChoice (runner/workflow-first.ts), the one place that decides which learned workflow the platform runs first on a
// run, as a table: each reason it gives (FIRST_REASONS), from the facts it is told alone. It is pure: it reads, settles and
// starts nothing; when it needs a fact (the promotion's verdict on the laid digest, the champions, the agent's past runs)
// it asks for it (FirstAsk), and its gatherer (workflowFirstOf) reads it and asks again. The money rule it holds a
// workflow to counts every run that called the workflow at its digest (metrics.workflow_calls), the agent's own calls
// as well as the platform's. It fails closed: past runs it can't read leave the run to the agent. The same rule holds the
// agent's own learned_workflow tool (toolStopsOf): a workflow over the line leaves it, whoever made the calls.
import assert from "node:assert/strict";
import { test } from "node:test";

const { COST_WINDOW, FIRST_REASONS, firstChoice, toolStopsOf, workflowDigest, workflowFirstOf } = await import("../dist/runner/workflow-first.js");
const { costStopOverStore } = await import("../dist/store-reads/learning.js");

const flow = (name, text = `{"name":"${name}"}`) => ({ name, description: `${name} does it`, workflow: text });
const A = flow("a");
const B = flow("b");
const A_CHAMPION = flow("a", '{"name":"a","champion":true}');
const B_CHAMPION = flow("b", '{"name":"b","champion":true}');
const LAUNCH = { input: { question: "q" }, learning: { seed: "seed-1", workflows: ["a", "b"] } };

/** The facts of a claim that laid `workflows`, each fitting the run's input when its text is in `fit`. */
const facts = (over = {}) => ({
  kind: "agentic", workflows: [A, B], launch: LAUNCH, promotion: "laid", money: false,
  fits: (workflow) => (over.fit ?? [A.workflow]).includes(workflow.workflow),
  ...over,
});
/** `runs` runs that called `name` at `digest` (by `caller`), each at `allIn` all-in, and the agent's by-hand mean. */
const past = (name, digest, runs, allIn, byHand, caller = "agent") => ({
  runs: Array.from({ length: runs }, (_, i) => ({ metrics: { path: "handed_back", workflow: name, workflow_calls: [{ workflow: name, digest, caller, outcome: "answered", usd: allIn / 2 }] }, allInUsd: allIn, startedAt: i })),
  by_hand: byHand === null ? null : { runs: 5, mean_usd: byHand },
  by_hand_unknown: 0,
});
const reasonOf = (step) => ("ask" in step ? `ask:${step.ask}` : step.reason);

test("each reason firstChoice gives, from the facts it is told", () => {
  const dA = workflowDigest(A);
  const rows = [
    ["a run that is not agentic", facts({ kind: "workflow" }), "none_laid"],
    ["a claim that laid no workflow", facts({ workflows: [] }), "none_laid"],
    ["a run that learns nothing", facts({ launch: { input: { question: "q" } } }), "none_laid"],
    ["a replay of a laid workflow", facts({ launch: { ...LAUNCH, replay: { of: "run-0", workflow: "a", digest: dA } } }), "replay"],
    ["a replay of a workflow its claim did not lay", facts({ launch: { ...LAUNCH, replay: { of: "run-0", workflow: "zz", digest: dA } } }), "replay_missing"],
    ["a launch with workflow_first: false", facts({ launch: { ...LAUNCH, workflowFirst: false } }), "off"],
    ["no laid workflow takes the input", facts({ fit: [] }), "none_fit"],
    ["two laid workflows take the input", facts({ fit: [A.workflow, B.workflow] }), "many_fit"],
    ["the one that fits, its verdict not asked yet", facts(), "ask:verdict"],
    ["the one that fits, not promoted", facts({ verdict: { digest: dA, serving: undefined } }), "not_promoted"],
    ["the one that fits, its champion does not", facts({ verdict: { digest: dA, serving: { workflow: A_CHAMPION } } }), "champion_misfit"],
    ["the one that fits, promoted", facts({ verdict: { digest: dA, serving: { workflow: A, promotion: 7 } } }), "served"],
    ["none fits, the champions not asked yet", facts({ fit: [A_CHAMPION.workflow, B_CHAMPION.workflow], promotion: "champions" }), "ask:champions"],
    ["none fits, two champions do", facts({ fit: [A_CHAMPION.workflow, B_CHAMPION.workflow], promotion: "champions", champions: [{ workflow: A_CHAMPION }, { workflow: B_CHAMPION }] }), "many_champions"],
    ["none fits, no champion does", facts({ fit: [], promotion: "champions", champions: [undefined, { workflow: B_CHAMPION }] }), "none_fit"],
    ["none fits, one champion does", facts({ fit: [A_CHAMPION.workflow], promotion: "champions", champions: [{ workflow: A_CHAMPION, promotion: 3 }, undefined] }), "served"],
    ["promoted, the money rule's runs not read yet", facts({ promotion: "none", money: true }), "ask:past"],
    ["promoted, the runs could not be read", facts({ promotion: "none", money: true, past: { unread: "store down" } }), "past_unread"],
    ["promoted, under COST_WINDOW calls", facts({ promotion: "none", money: true, past: past("a", dA, COST_WINDOW - 1, 9, 1) }), "served"],
    ["promoted, under COST_WINDOW calls and no by-hand cost", facts({ promotion: "none", money: true, past: past("a", dA, COST_WINDOW - 1, 9, null) }), "served"],
    ["promoted, COST_WINDOW calls and no by-hand cost", facts({ promotion: "none", money: true, past: past("a", dA, COST_WINDOW, 9, null) }), "no_by_hand_cost"],
    ["promoted, under the by-hand cost", facts({ promotion: "none", money: true, past: past("a", dA, COST_WINDOW, 0.5, 1) }), "served"],
    ["promoted, at or over the by-hand cost over the agent's own calls", facts({ promotion: "none", money: true, past: past("a", dA, COST_WINDOW, 2, 1) }), "cost_stop"],
    ["promoted, at or over it over the platform's calls", facts({ promotion: "none", money: true, past: past("a", dA, COST_WINDOW, 2, 1, "platform") }), "cost_stop"],
  ];
  for (const [why, told, reason] of rows) assert.equal(reasonOf(firstChoice(told)), reason, why);
  // Every reason the chooser gives is named once (`held` is the spec builders', for a claim a check refused).
  const given = new Set(rows.map(([, , reason]) => reason).filter((reason) => !reason.startsWith("ask:")));
  assert.deepEqual([...FIRST_REASONS].filter((reason) => !given.has(reason)), ["held"]);
});

test("what firstChoice serves: the one that fits at its digest and promotion, a champion in its place, the replay alone; the money rule's stop names its two numbers", () => {
  const dA = workflowDigest(A);
  const served = firstChoice(facts({ verdict: { digest: dA, serving: { workflow: A, promotion: 7 } } }));
  assert.deepEqual(served, { serve: { name: "a", digest: dA, promotion: 7, input: { question: "q" }, revision: "seed-1" }, reason: "served", said: [] });
  const champion = firstChoice(facts({ fit: [A_CHAMPION.workflow], promotion: "champions", champions: [{ workflow: A_CHAMPION, promotion: 3 }, undefined] }));
  assert.equal(champion.champion, A_CHAMPION);
  assert.equal(champion.serve.digest, workflowDigest(A_CHAMPION));
  assert.match(champion.said[0], /a's revision does not take this run's input; its champion/);
  const replay = firstChoice(facts({ outputSchema: { type: "object" }, launch: { ...LAUNCH, replay: { of: "run-0", workflow: "a", digest: "f".repeat(16) } } }));
  assert.deepEqual(replay.serve, { name: "a", digest: "f".repeat(16), input: { question: "q" }, revision: "seed-1", replay: true, outputSchema: { type: "object" } });
  const stop = firstChoice(facts({ promotion: "none", money: true, past: past("a", dA, COST_WINDOW, 2, 1) }));
  assert.deepEqual(stop.revise, { workflow: "a", digest: dA, served_usd: 2, by_hand_usd: 1, runs: COST_WINDOW, revision: "seed-1" });
  assert.equal(stop.serve, undefined);
  assert.match(stop.said[0], new RegExp(`cost \\$2 a run over its last ${COST_WINDOW} served runs, at or over \\$1 by hand`));
  // A run that called another workflow, or this one at another digest, counts nothing toward its line.
  assert.equal(firstChoice(facts({ promotion: "none", money: true, past: past("b", dA, COST_WINDOW, 2, 1) })).reason, "served");
  assert.equal(firstChoice(facts({ promotion: "none", money: true, past: past("a", "0".repeat(16), COST_WINDOW, 2, 1) })).reason, "served");
});

test("workflowFirstOf asks each fact once, through the gate and the reader it is handed, and logs what firstChoice said", async () => {
  const asked = [];
  const gate = Object.assign(async (workflow, digest) => (asked.push(["verdict", workflow.name, digest]), { workflow, promotion: 2 }), { champion: async () => (asked.push(["champion"]), undefined) });
  const lines = [];
  // The input fits A's schema (one required field the input has), not B's.
  const schema = (required) => JSON.stringify({ v: 2, name: required, schemas: { In: { type: "object", required: [required], properties: { [required]: { type: "string" } } } }, input: { schemaId: "In" }, root: { node: "chain", steps: [] } });
  const a = flow("a", schema("question"));
  const b = flow("b", schema("other"));
  const choice = await workflowFirstOf("agentic", [a, b], LAUNCH, (line) => lines.push(line), async () => { asked.push(["past"]); throw new Error("store down"); }, gate);
  assert.deepEqual(asked, [["verdict", "a", workflowDigest(a)], ["past"]]);
  assert.equal(choice.reason, "past_unread", "it fails closed");
  assert.equal(choice.serve, undefined);
  assert.equal("said" in choice, false, "the log lines go to the log, not the choice");
  assert.match(lines.join("\n"), /could not read the agent's past runs \(store down\); a does not run first, the agent takes this run/);
  const served = await workflowFirstOf("agentic", [a, b], LAUNCH, () => {}, async () => ({ runs: [], by_hand: null, by_hand_unknown: 0 }), gate);
  assert.equal(served.serve.promotion, 2);
});

test("the money rule holds the agent's learned_workflow tool too: one over the line at the digest the tool runs leaves it and asks for its revision; runs it can't read leave the tool nothing", () => {
  const dA = workflowDigest(A);
  const over = toolStopsOf(past("a", dA, COST_WINDOW, 2, 1), [A, B]);
  assert.deepEqual(over.flows, [B]);
  assert.deepEqual(over.stops, [{ workflow: "a", digest: dA, served_usd: 2, by_hand_usd: 1, runs: COST_WINDOW }]);
  assert.match(over.said.join("\n"), new RegExp(`a cost \\$2 a run over its last ${COST_WINDOW} served runs, at or over \\$1 by hand.*the learned_workflow tool leaves it out`));
  assert.deepEqual(toolStopsOf(past("a", dA, COST_WINDOW, 0.5, 1), [A, B]), { flows: [A, B], stops: [], said: [] }, "under the line");
  assert.deepEqual(toolStopsOf(past("a", "0".repeat(16), COST_WINDOW, 2, 1), [A, B]).flows, [A, B], "over the line at another digest");
  // COST_WINDOW served runs and no by-hand cost to hold them to: out of the tool, as out of the first call
  // (no_by_hand_cost), with no stop, since there is no by-hand figure for a revision to beat. Under COST_WINDOW it stays.
  const none = toolStopsOf(past("a", dA, COST_WINDOW, 9, null), [A, B]);
  assert.deepEqual([none.flows, none.stops], [[B], []], "never run unchecked by the tool");
  assert.match(none.said.join("\n"), /no by-hand cost to hold a to .*the learned_workflow tool leaves it out/);
  assert.deepEqual(toolStopsOf(past("a", dA, COST_WINDOW - 1, 9, null), [A, B]).flows, [A, B], "under COST_WINDOW served runs");
  const unread = toolStopsOf({ unread: "store down" }, [A, B]);
  assert.deepEqual([unread.flows, unread.stops], [[], []]);
  assert.match(unread.said.join("\n"), /could not read the agent's past runs \(store down\); the learned_workflow tool runs none of a, b/);
});

test("the money rule's decision over the store fails closed: past runs it can't read stop every workflow", async () => {
  const stop = await costStopOverStore({ runs: { list: async () => { throw new Error("store down"); } } }, "agent-1");
  assert.equal(stop("a", workflowDigest(A)), true);
});
