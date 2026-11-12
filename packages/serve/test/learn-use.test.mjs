// A run started with `learning: "use"` starts from what its agent learned (its notes, skills and learned workflows, as a
// run that learns is given them) and writes nothing: no end-of-run turn, no proposal, no grade, no merge, and a follow-up
// to it learns nothing either. So held-out runs read one learned state, frozen, however many run at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, LEARN, learner, made, reflectRows, repoOf, started } from "./learn-support.mjs";
import { agent, follow, serve } from "./support.mjs";

const PLAN = [["check-units.md", note("Check units", "Convert every amount to one unit before comparing")]];

test("a run's learning is \"use\" or absent: anything else is refused at its field, before a run starts", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, agent("plain"));
  for (const learning of [true, false, "on", "notes", 1]) {
    const res = await api("POST", "/agents/plain/runs", { input: { content: "Go." }, learning });
    assert.equal(res.status, 422, `${JSON.stringify(learning)}: ${JSON.stringify(res.body)}`);
    const issue = res.body.error.fields?.find((one) => one.field === "learning");
    assert.match(issue?.message ?? "", /"use"/, JSON.stringify(res.body.error));
  }
});

test("a \"use\" run starts from what its agent learned and keeps nothing: no end-of-run turn, no proposal, no learning run, main as it was; a follow-up to it keeps nothing either", { timeout: 150_000 }, async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("frozen", { plan: PLAN, instructions: "Answer the question.\nSay your prompt." }));
  const taught = await started(api, "frozen");
  assert.equal((await ended(api, taught)).view.learning?.state, "merged");
  const repo = repoOf(data, "frozen");
  const main = git(repo, ["rev-parse", "main"]);

  const runId = await started(api, "frozen", "Go again.", { learning: "use" });
  const launch = (await store.runs.launch(runId)).body;
  assert.deepEqual(launch.learning.given.map(({ file }) => file), ["check-units.md"], "given what its agent learned");
  assert.equal(launch.learning.use, true, "its launch says it only uses it");
  const { rows, last } = await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  assert.match(rows.find((row) => row.kind === "final_answer")?.text ?? "", /Check units/, "its prompt holds the learned note");
  assert.equal(reflectRows(rows).length, 0, "no end-of-run turn");
  assert.equal(last.status, "completed");
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([view.learning?.state, view.learning?.reason], ["dropped", "use"], JSON.stringify(view.learning));
  assert.equal(typeof view.learning.detail, "string");
  assert.equal(await store.learning.proposal(runId), undefined, "no proposal kept");
  assert.equal(await store.runs.get(`${runId}-learning`), undefined, "no learning run");

  // A follow-up: answered, and still nothing kept.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Review: the reference answer is 42." })).status, 202);
  const again = await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  assert.equal(reflectRows(again.rows).length, 0, "no end-of-run turn after the follow-up");
  assert.equal(await store.learning.proposal(runId), undefined);
  assert.equal(git(repo, ["rev-parse", "main"]), main, "main as it was");
});

test("\"use\" on a server whose learning is off gives nothing learned, as every run there", { timeout: 90_000 }, async (t) => {
  const { api, store } = await serve(t, { learning: "off", faux: LEARN });
  await made(api, learner("off", { plan: PLAN }));
  const runId = await started(api, "off", "Go.", { learning: "use" });
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal((await store.runs.launch(runId)).body.learning, undefined);
  assert.equal((await api("GET", `/runs/${runId}`)).body.learning, null);
});
