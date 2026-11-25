// The learning view (GET /agents/{id}/learning) says of each workflow whether it serves, in one word: `pending` and
// `retired` as its README.md says, else the promotions read's own state for it (GET .../learning/promotions
// `serving[].state`, from the same records): `serving`, `checking`, `held` or `stopped`. A workflow whose check held twice
// and stopped never reads as though it served; one with no promotion record yet reads `checking` (the first run it fits
// starts its check).
import assert from "node:assert/strict";
import { test } from "node:test";
import { workflow } from "./learn-format-support.mjs";
import { learner, made, putLearning } from "./learn-support.mjs";
import { putPromotions } from "./learned-workflow-seed-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { serve } from "./support.mjs";

const readme = (name, extra = "") => `---\nname: ${name}\ndescription: Answers the ${name} question; use when asked\n${extra}---\n`;
const draft = (name, extra = "") => ({ [`workflows/${name}/README.md`]: readme(name, extra), [`workflows/${name}/workflow.json`]: workflow({ name }) });
const CHECK = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, n: 5, of: [] };
const at = (minutes) => new Date(Date.UTC(2026, 10, 18, 9, minutes)).toISOString();

test("each workflow's status says whether it serves: promoted serving, held twice stopped, held once held, no record checking, pending pending", { timeout: 60_000 }, async (t) => {
  const { api, baseUrl, store } = await serve(t, { learning: "on" });
  await made(api, learner("viewer"));
  const files = { ...draft("promoted"), ...draft("stopped"), ...draft("held"), ...draft("fresh"), ...draft("waits", "status: pending\n"), ...draft("replays") };
  await putLearning(store, "viewer", files);
  await putPromotions(store, "viewer", [
    { workflow: "promoted", digest: "a".repeat(16), at: at(1), decided: "promote", reason: "checked: promoted", check: { ...CHECK, attempt: 1, agreed: 5, alone: 5 } },
    // The live demo's: its check held, its recompile's check held too, and it stopped.
    { workflow: "stopped", digest: "b".repeat(16), at: at(2), decided: "hold", reason: "checked: held", check: { ...CHECK, attempt: 1, agreed: 1, alone: 2 } },
    { workflow: "stopped", digest: "c".repeat(16), at: at(3), decided: "hold", reason: "checked: held again, stopped", check: { ...CHECK, attempt: 2, agreed: 1, alone: 2, stopped: true } },
    { workflow: "held", digest: "d".repeat(16), at: at(4), decided: "hold", reason: "checked: held", check: { ...CHECK, attempt: 1, agreed: 1, alone: 2 } },
    { workflow: "replays", digest: "e".repeat(16), at: at(5), decided: "replaying", reason: "checking", check: { ...CHECK, attempt: 1 } },
  ]);

  const view = await api("GET", "/agents/viewer/learning");
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const status = Object.fromEntries(view.body.workflows.map((one) => [one.name, one.status]));
  assert.deepEqual(status, { fresh: "checking", held: "held", promoted: "serving", replays: "checking", stopped: "stopped", waits: "pending" });

  // The same word the promotions read says, for every workflow it lists.
  const promotions = await api("GET", "/agents/viewer/learning/promotions");
  assert.equal(promotions.status, 200, JSON.stringify(promotions.body));
  for (const one of promotions.body.serving) assert.equal(status[one.workflow], one.state, one.workflow);

  // As the API document says.
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.deepEqual(schemaProblems(doc, doc.paths["/agents/{agent_id}/learning"].get.responses["200"].content["application/json"].schema, view.body), []);
});

// The money rule (runner/workflow-first.ts) stops a promoted workflow from running first once its last COST_WINDOW served
// runs cost as much as the agent by hand: no promotion record says so, yet the agent takes its runs. Its status, the
// promotions read's state and the cost read's state say the same: it does not serve.
test("a promoted workflow the money rule stopped reads stopped, never serving, in the learning view and the promotions read", { timeout: 60_000 }, async (t) => {
  // No runner beside the server: the test claims and ends each seeded run itself (one beside would claim it first).
  const { api, store } = await serve(t, { learning: "on", runner: false });
  await made(api, learner("costly"));
  const files = { ...draft("dear"), ...draft("cheap") };
  await putLearning(store, "costly", files);
  const promoted = (workflow, digest, minutes) => ({ workflow, digest, at: at(minutes), decided: "promote", reason: "checked: promoted", check: { ...CHECK, attempt: 1, agreed: 5, alone: 5 } });
  await putPromotions(store, "costly", [promoted("dear", "f".repeat(16), 1), promoted("cheap", "9".repeat(16), 2)]);

  const revisionId = (await store.agents.get("costly")).currentRevision;
  const body = { input: { content: "Go." }, title: "t", place: { mode: "runner" }, learning: { seed: "a".repeat(40), section: "" } };
  let n = 0;
  const end = async (costUsd, metrics) => {
    const id = `run-${String((n += 1)).padStart(3, "0")}`;
    await store.runs.create({ id, agentId: "costly", revisionId }, { body });
    await store.runs.update(await store.claim(id, "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd, metrics });
  };
  await end(0.1, { path: "agent" });
  // Ten served runs each: `dear` at $0.50 a run against $0.10 by hand (over the line), `cheap` at $0.01 (under it).
  const served = (workflow, digest) => ({ path: "workflow", workflow, workflow_digest: digest, workflow_calls: [{ workflow, digest, caller: "platform", outcome: "answered", usd: null }] });
  for (let i = 0; i < 10; i += 1) await end(0.5, served("dear", "f".repeat(16)));
  for (let i = 0; i < 10; i += 1) await end(0.01, served("cheap", "9".repeat(16)));

  const cost = await api("GET", "/agents/costly/learning/cost");
  assert.equal(cost.status, 200, JSON.stringify(cost.body));
  assert.deepEqual(cost.body.workflows.map((one) => [one.workflow, one.state]), [["cheap", "serving"], ["dear", "needs_revision"]], "the money rule stopped `dear`");

  const view = await api("GET", "/agents/costly/learning");
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const status = Object.fromEntries(view.body.workflows.map((one) => [one.name, one.status]));
  assert.deepEqual(status, { cheap: "serving", dear: "stopped" });
  const promotions = await api("GET", "/agents/costly/learning/promotions");
  assert.equal(promotions.status, 200, JSON.stringify(promotions.body));
  assert.deepEqual(promotions.body.serving.map((one) => [one.workflow, one.digest, one.state]), [["cheap", "9".repeat(16), "serving"], ["dear", "f".repeat(16), "stopped"]], "its champion is still named; its state says it does not run first");
});
