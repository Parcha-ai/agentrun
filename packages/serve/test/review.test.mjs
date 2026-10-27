// Review: once a learning run's branch is proposed, the server curates it in the agent's queue, with the checker on the
// host's tools, the injection screen and the judge: auto merges it, approve holds a plan until a person decides. With no
// screen or no judge nothing is curated and the branch waits. A merged branch is deleted. The faux model; a faux screen
// and a scripted judge, injected through serve's `learning` option.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { learningId, proposeLearning, recordsOf } from "@parcha/pi-agent-learn";
import { local, openRepo } from "@parcha/pi-git-remote";
import { childEnv } from "../dist/runs.js";
import { readRunState, writeRunState } from "../dist/learning.js";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const RATE_LIMIT = "The state registry rate-limits at 1 request a second.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bareOf = (data, id) => join(data, "agents", id, "learning.git");
const git = (dir, ...args) => execFileSync("git", ["--git-dir", dir, ...args], { encoding: "utf8" }).trim();
const tip = (dir, ref) => { try { return git(dir, "rev-parse", "--verify", "-q", `${ref}^{commit}`); } catch { return undefined; } };
const show = (dir, ref, path) => { try { return git(dir, "show", `${ref}:${path}`); } catch { return undefined; } };
const branches = (dir) => git(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean).sort();
/** Every commit, tree and blob reachable from `ref`, as one text. */
const reachable = (dir, ref) => git(dir, "rev-list", "--objects", ref).split("\n").map((line) => git(dir, "cat-file", "-p", line.split(" ")[0])).join("\n");

const SCREEN = { classify: async () => 0.05, threshold: 0.6 };
/** A scripted judge that finds every note general and harmless; it counts its calls and what each cost. */
function judge() {
  const calls = [];
  const run = async (params) => {
    const [q] = Object.keys(params.questions);
    calls.push(q);
    return { answers: { [q]: { type: "noul", noul: { general: 0.95 }[q] ?? 0.02 } }, model: "fake", usage: null, cost_usd: 0.001 };
  };
  return { run, calls };
}

/** The run's learning state once `pred` holds for it. */
async function stateOf(data, agentId, runId, pred = () => true, deadlineMs = 30_000) {
  for (const end = Date.now() + deadlineMs; ; await sleep(50)) {
    const state = await readRunState(data, agentId, runId);
    if (state && pred(state)) return state;
    assert.ok(Date.now() < end, `the run ${runId} reached its state; last ${JSON.stringify(state)}`);
  }
}
const settled = (state) => !["proposed"].includes(state.state);

/** A run of `id` that notes RATE_LIMIT, ended. */
async function learned(api, id) {
  const { body: run } = await api("POST", `/agents/${id}/runs`, { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  return run.run_id;
}

test("auto: the run's note merges into main with a two-parent merge, its branch is deleted, and the judge's cost is the agent's, never the run's", async (t) => {
  const j = judge();
  const { api, data, learning } = await serve(t, { learning: { screen: SCREEN, judge: j.run } });
  assert.equal(typeof learning?.review, "function", "the server has a review");
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const runId = await learned(api, "calc");
  const cost = (await api("GET", `/runs/${runId}`)).body.cost;
  const state = await stateOf(data, "calc", runId, settled);
  assert.equal(state.state, "merged", JSON.stringify(state));
  const bare = bareOf(data, "calc");
  assert.equal(state.merge, tip(bare, "main"));
  assert.equal(git(bare, "rev-list", "--parents", "-n", "1", "main").split(" ").length, 3, "a two-parent merge");
  assert.ok(show(bare, "main", `learnings/${learningId(runId, RATE_LIMIT)}.md`), "the note is on main");
  assert.deepEqual(branches(bare).filter((b) => b.startsWith("runs/")), [], "the merged branch is deleted");
  assert.ok(state.review_usd > 0, "the judge's cost is recorded on the agent's learning line");
  assert.deepEqual((await api("GET", `/runs/${runId}`)).body.cost, cost, "and never moves the final run's cost");
});

test("no injection screen: nothing is curated, main stays, the branch waits; a restart with a screen merges it", async (t) => {
  const j = judge();
  const first = await serve(t, { learning: { judge: j.run } });
  await first.api("POST", "/agents", agent("calc", { learning: "auto" }));
  const before = tip(bareOf(first.data, "calc"), "main");
  const runId = await learned(first.api, "calc");
  const state = await stateOf(first.data, "calc", runId, settled);
  assert.deepEqual([state.state, state.reason], ["no_screen", "no injection screen on this server"]);
  assert.equal(tip(bareOf(first.data, "calc"), "main"), before, "main does not move: no refusal merge either");
  assert.ok(branches(bareOf(first.data, "calc")).includes(`runs/${runId}`), "the branch waits");
  assert.deepEqual(j.calls, [], "the judge was never asked");
  await first.close();
  const again = await serve(t, { data: first.data, learning: { screen: SCREEN, judge: j.run } });
  assert.equal((await stateOf(again.data, "calc", runId, (s) => s.state === "merged")).state, "merged", "the start-time pass curates it");
});

test("no judge: with no TYPESAFE_API_KEY the server starts, and the run's state says so", async (t) => {
  withEnv(t, {}, ["TYPESAFE_API_KEY"]);
  const { api, data } = await serve(t, { learning: { screen: SCREEN } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const runId = await learned(api, "calc");
  const state = await stateOf(data, "calc", runId, settled);
  assert.deepEqual([state.state, state.reason], ["no_judge", "no judge on this server"]);
  assert.ok(branches(bareOf(data, "calc")).includes(`runs/${runId}`));
});

test("TYPESAFE_API_KEY is the server's: a run's environment never has it", () => {
  const env = childEnv({ PATH: "/bin", TYPESAFE_API_KEY: "ts-key-value-123456", OPENAI_API_KEY: "model-key" }, "server-token");
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, "model-key", "a model key still passes");
});

test("the screen on the real merge path: at the threshold refused, just under merged, a screen that throws refused as unjudged", async (t) => {
  const score = { now: 0.6 };
  const screen = { classify: async () => (typeof score.now === "function" ? score.now() : score.now), threshold: 0.6 };
  const { api, data } = await serve(t, { learning: { screen, judge: judge().run } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const note = (runId) => show(bareOf(data, "calc"), "main", `learnings/${learningId(runId, RATE_LIMIT)}.md`);
  const at = await learned(api, "calc");
  const atState = await stateOf(data, "calc", at, settled);
  assert.equal(atState.state, "merged", "a refusal is still a merge of the run");
  assert.match(JSON.stringify(atState.verdict), /injection screen: 0\.60 at or over 0\.60/);
  assert.equal(note(at), undefined);
  score.now = () => { throw new Error("the judge is down"); };
  const thrown = await learned(api, "calc");
  assert.match(JSON.stringify((await stateOf(data, "calc", thrown, settled)).verdict), /could not judge/);
  assert.equal(note(thrown), undefined);
  score.now = 0.59;
  const under = await learned(api, "calc");
  await stateOf(data, "calc", under, settled);
  assert.ok(note(under), "just under the threshold merges");
});

test("approve: a plan is held and main stays; approve lands it, refuse lands the memo with the reason, a stale plan is planned again, each decision names who made it", async (t) => {
  const { api, data, learning } = await serve(t, { learning: { screen: SCREEN, judge: judge().run } });
  await api("POST", "/agents", agent("calc", { learning: "approve" }));
  const bare = bareOf(data, "calc");
  const held = async () => {
    const before = tip(bare, "main");
    const runId = await learned(api, "calc");
    const state = await stateOf(data, "calc", runId, settled);
    assert.equal(state.state, "awaiting_approval", JSON.stringify(state));
    assert.equal(tip(bare, "main"), before, "nothing lands while it waits");
    assert.ok(existsSync(join(data, "agents", "calc", "learning", "runs", `${runId}.plan.json`)), "the plan is kept beside the state");
    return runId;
  };
  const one = await held();
  assert.equal((await learning.approve("calc", one, "member:ana")).status, "landed");
  const approved = await readRunState(data, "calc", one);
  assert.deepEqual([approved.state, approved.decided_by, approved.decision], ["merged", "member:ana", "approve"]);
  assert.ok(show(bare, "main", `learnings/${learningId(one, RATE_LIMIT)}.md`));
  assert.ok(!branches(bare).includes(`runs/${one}`), "its branch is deleted");

  const two = await held();
  await assert.rejects(learning.refuse("calc", two, "member:bo", "two\nlines"), /one line/);
  assert.equal((await learning.refuse("calc", two, "member:bo", "Too close to one case.")).status, "landed");
  const refused = await readRunState(data, "calc", two);
  assert.deepEqual([refused.state, refused.decided_by, refused.decision], ["merged", "member:bo", "refuse"]);
  assert.equal(show(bare, "main", `learnings/${learningId(two, RATE_LIMIT)}.md`), undefined);
  assert.match(show(bare, "main", `memos/${two}.md`), /refused by a person: Too close to one case\./);

  const three = await held();
  await api("PUT", "/agents/calc/definition", { definition: { instructions: "Answer, briefly.", skills: [], tools: [] } });
  assert.equal((await learning.approve("calc", three, "member:ana")).status, "stale", "main moved: the plan is stale");
  const replanned = await readRunState(data, "calc", three);
  assert.equal(replanned.state, "awaiting_approval", "and is planned again, waiting for a decision");
  assert.equal((await learning.approve("calc", three, "member:ana")).status, "landed");
  await assert.rejects(learning.approve("calc", three, "member:ana"), /not waiting for approval/);
});

test("approve survives a restart: the start-time pass never curates a held run without hold, and approving after it works", async (t) => {
  const j = judge();
  const first = await serve(t, { learning: { screen: SCREEN, judge: j.run } });
  await first.api("POST", "/agents", agent("calc", { learning: "approve" }));
  const runId = await learned(first.api, "calc");
  await stateOf(first.data, "calc", runId, (s) => s.state === "awaiting_approval");
  const main = tip(bareOf(first.data, "calc"), "main");
  await first.close();
  const again = await serve(t, { data: first.data, learning: { screen: SCREEN, judge: j.run } });
  await again.learning.settled();
  assert.equal(tip(bareOf(again.data, "calc"), "main"), main, "the start-time pass landed nothing");
  assert.equal((await readRunState(again.data, "calc", runId)).state, "awaiting_approval");
  assert.equal((await again.learning.approve("calc", runId, "member:ana")).status, "landed");
});

test("a held run is never judged again when the next run is reviewed", async (t) => {
  const j = judge();
  const { api, data } = await serve(t, { learning: { screen: SCREEN, judge: j.run } });
  await api("POST", "/agents", agent("calc", { learning: "approve" }));
  const one = await learned(api, "calc");
  await stateOf(data, "calc", one, settled);
  const perRun = j.calls.length;
  assert.ok(perRun > 0);
  const two = await learned(api, "calc");
  await stateOf(data, "calc", two, settled);
  assert.equal(j.calls.length, 2 * perRun, "the second review asked only about the second run");
});

test("learning turned off after the run: the branch is left and nothing is curated", async (t) => {
  const j = judge();
  const { api, data, learning } = await serve(t, { learning: { judge: j.run } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const runId = await learned(api, "calc");
  await stateOf(data, "calc", runId, settled);
  await api("PUT", "/agents/calc/definition", { definition: { instructions: "Answer.", skills: [], tools: [], learning: null } });
  await learning.review("calc", runId);
  const state = await readRunState(data, "calc", runId);
  assert.equal(state.state, "off");
  assert.ok(branches(bareOf(data, "calc")).includes(`runs/${runId}`));
  assert.deepEqual(j.calls, []);
});

/** Proposes `files` for agent `id`'s run `runId` as the server would, and records it as proposed. */
async function planted(t, data, id, runId, { candidates = [], workflows } = {}) {
  const repo = await openRepo({ dir: join(await scratch(t), "planter"), remote: local(bareOf(data, id)) });
  const main = await repo.resolve("main");
  const target = { snapshot: async (doc) => (doc.definition.kind === "learn.seed" ? { sha: main, index: [], omitted: [], workflows: [], copied: false } : { order: candidates.map((c) => c.callId), byCall: Object.fromEntries(candidates.map((c) => [c.callId, c])) }) };
  const result = await proposeLearning({ repo, runId, target, secrets: [], caseValues: [], ...(workflows ? { workflows } : {}) });
  assert.equal(result.status, "proposed", JSON.stringify(result));
  await writeRunState(data, id, runId, { state: "proposed", branch: `runs/${runId}`, base: main, sha: result.sha });
}

test("the checker gets the host's tools: a draft calling a bound tool passes it, one calling another tool is refused", async (t) => {
  const { api, data, learning } = await serve(t, { learning: { screen: SCREEN, judge: judge().run } });
  assert.equal(typeof learning?.review, "function", "the server has a review");
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const doc = (tool) => ({
    v: 2, name: `look-${tool.replace(/\W/g, "")}`,
    schemas: { In: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, Out: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
    input: { schemaId: "In" }, output: { schemaId: "Out", path: "out" },
    root: { node: "call", label: "look", via: "tool", tool, args: { path: "{path}" }, out: "Out", as: "out", deadline_s: 20 },
  });
  const draft = (tool) => { const d = doc(tool); return { [d.name]: { files: recordsOf(d.name, d, "2026-10-27T08:00:00.000Z") } }; };
  await planted(t, data, "calc", "plant-bound", { workflows: draft("read") });
  await learning.review("calc", "plant-bound");
  assert.doesNotMatch(JSON.stringify((await readRunState(data, "calc", "plant-bound")).verdict), /the checker refuses/);
  await planted(t, data, "calc", "plant-other", { workflows: draft("prices.quote") });
  await learning.review("calc", "plant-other");
  assert.match(JSON.stringify((await readRunState(data, "calc", "plant-other")).verdict), /the checker refuses the run's branch/);
});

test("the server's own token in a note is refused by the review and never reaches main", async (t) => {
  const { api, data, token, learning } = await serve(t, { learning: { screen: SCREEN, judge: judge().run } });
  assert.equal(typeof learning?.review, "function", "the server has a review");
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const text = `Call the API with the bearer ${token} when it asks.`;
  await planted(t, data, "calc", "plant-token", { candidates: [{ callId: "c1", type: "lesson", text, evidence: [] }] });
  await learning.review("calc", "plant-token");
  const state = await readRunState(data, "calc", "plant-token");
  assert.equal(state.state, "merged");
  assert.ok(reachable(bareOf(data, "calc"), "--all").includes(token), "control: the token is on the run's branch");
  assert.equal(reachable(bareOf(data, "calc"), "main").includes(token), false, "nothing reachable from main holds it");
});

test("a merged branch the server could not delete is deleted at the next start; one that moved after its merge is kept", async (t) => {
  const first = await serve(t, { learning: { screen: SCREEN, judge: judge().run } });
  await first.api("POST", "/agents", agent("calc", { learning: "auto" }));
  const bare = bareOf(first.data, "calc");
  const [one, two] = [await learned(first.api, "calc"), await learned(first.api, "calc")];
  for (const runId of [one, two]) await stateOf(first.data, "calc", runId, (s) => s.state === "merged");
  await first.close();
  // As if the server stopped between the merge and the delete: both branches are back at the tips they merged.
  for (const runId of [one, two]) {
    const state = await readRunState(first.data, "calc", runId);
    git(bare, "update-ref", `refs/heads/runs/${runId}`, state.sha);
    await writeRunState(first.data, "calc", runId, { ...state, pruned: false });
  }
  const repo = await openRepo({ dir: join(await scratch(t), "mover"), remote: local(bare) });
  const moved = await repo.commitTo(`runs/${two}`, { files: { [`memos/${two}.md`]: "moved\n" }, message: "moved", trailers: { "Run-Id": ["mover", two] } });
  await repo.push(moved.sha, `runs/${two}`);
  const again = await serve(t, { data: first.data, learning: { screen: SCREEN, judge: judge().run } });
  await again.learning.settled();
  assert.ok(!branches(bare).includes(`runs/${one}`), "the merged branch at its tip is deleted");
  assert.ok(branches(bare).includes(`runs/${two}`), "the one that moved is kept");
});
