// The learning view (GET /agents/{id}/learning) says of each workflow whether it serves, in one word: `pending` and
// `retired` as its README.md says, else the promotions read's own state for it (GET .../learning/promotions
// `serving[].state`, from the same records): `serving`, `checking`, `held` or `stopped`. A workflow whose check held twice
// and stopped never reads as though it served; one with no promotion record yet reads `checking` (the first run it fits
// starts its check).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { workflow } from "./learn-format-support.mjs";
import { git, learner, made, resnap } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { serve } from "./support.mjs";

const readme = (name, extra = "") => `---\nname: ${name}\ndescription: Answers the ${name} question; use when asked\n${extra}---\n`;
const draft = (name, extra = "") => ({ [`workflows/${name}/README.md`]: readme(name, extra), [`workflows/${name}/workflow.json`]: workflow({ name }) });
const CHECK = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, n: 5, of: [] };
const at = (minutes) => new Date(Date.UTC(2026, 10, 18, 9, minutes)).toISOString();

test("each workflow's status says whether it serves: promoted serving, held twice stopped, held once held, no record checking, pending pending", { timeout: 60_000 }, async (t) => {
  const { api, data, baseUrl, store } = await serve(t, { learning: "on" });
  await made(api, learner("viewer"));
  await seedOf(data, "viewer");
  const repo = join(agentFolderOf(data, "viewer"), "learning");
  const files = { ...draft("promoted"), ...draft("stopped"), ...draft("held"), ...draft("fresh"), ...draft("waits", "status: pending\n"), ...draft("replays") };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, "viewer");
  await store.settings.put("learning.promotions.viewer", { v: 1, items: [
    { workflow: "promoted", digest: "a".repeat(16), at: at(1), decided: "promote", reason: "checked: promoted", check: { ...CHECK, attempt: 1, agreed: 5, alone: 5 } },
    // The live demo's: its check held, its recompile's check held too, and it stopped.
    { workflow: "stopped", digest: "b".repeat(16), at: at(2), decided: "hold", reason: "checked: held", check: { ...CHECK, attempt: 1, agreed: 1, alone: 2 } },
    { workflow: "stopped", digest: "c".repeat(16), at: at(3), decided: "hold", reason: "checked: held again, stopped", check: { ...CHECK, attempt: 2, agreed: 1, alone: 2, stopped: true } },
    { workflow: "held", digest: "d".repeat(16), at: at(4), decided: "hold", reason: "checked: held", check: { ...CHECK, attempt: 1, agreed: 1, alone: 2 } },
    { workflow: "replays", digest: "e".repeat(16), at: at(5), decided: "replaying", reason: "checking", check: { ...CHECK, attempt: 1 } },
  ] });

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
