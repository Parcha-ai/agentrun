// The decision-demo workflows (examples/decision-demos/workflows/*.json) are saved as agents the way their run.mjs saves
// them, through the v2 API: each must be accepted. A refusal that means the example itself is wrong (422: a tool this host
// does not bind, a node schema it refuses) fails here, so a shipped example that would 422 can never hide from CI. A
// warning that a key is not set, or a provider is not set up, is the host's, not the example's, and is fine.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "./support.mjs";

const WORKFLOWS = fileURLToPath(new URL("../../../examples/decision-demos/workflows/", import.meta.url));

/** The tools a workflow's call nodes name, as run.mjs's callTools has them: a revision lists each tool its workflow calls. */
function callTools(node, found = new Set()) {
  if (Array.isArray(node)) node.forEach((n) => callTools(n, found));
  else if (node && typeof node === "object") {
    if (node.node === "call" && node.via === "tool" && typeof node.tool === "string") found.add(node.tool);
    Object.values(node).forEach((v) => callTools(v, found));
  }
  return [...found];
}

/** Saves `workflow` as agent `id` the way run.mjs does, and says what about the example was refused, if anything. */
async function refusalOf(api, id, workflow) {
  const tools = callTools(workflow.root);
  const made = await api("POST", "/agents", { definition: { id, name: id, workflow, ...(tools.length ? { tools } : {}) } });
  if (made.status === 422) return `422 ${JSON.stringify(made.body?.error?.fields ?? made.body)}`;
  if (made.status !== 201) return `${made.status} ${JSON.stringify(made.body)}`;
  // A warning is the host's (a key or provider not set up here); one saying the example names something no host offers is not.
  const wrong = (made.body.warnings ?? []).filter((w) => w.reason === "not_an_option");
  return wrong.length ? `warned not_an_option ${JSON.stringify(wrong)}` : undefined;
}

const examples = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".json")).sort();

test("every decision-demo workflow saves as an agent through the API: none is refused for a reason that means the example is wrong", { timeout: 120_000 }, async (t) => {
  assert.ok(examples.length >= 5, `the examples are there: ${examples.join(", ")}`);
  const { api } = await serve(t);
  const refused = [];
  for (const file of examples) {
    const why = await refusalOf(api, basename(file, ".json"), JSON.parse(readFileSync(join(WORKFLOWS, file), "utf8")));
    if (why) refused.push(`${file}: ${why}`);
  }
  assert.deepEqual(refused, [], "no example is refused");
});

test("the check catches an example broken the way a removed tool breaks one: a call node naming fetch_page is refused at definition.workflow", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  const broken = JSON.parse(readFileSync(join(WORKFLOWS, "merchant-mcc.json"), "utf8").replaceAll('"tool": "web_fetch"', '"tool": "fetch_page"'));
  assert.notEqual(JSON.stringify(broken).indexOf('"fetch_page"'), -1, "the copy names fetch_page");
  const why = await refusalOf(api, "merchant-mcc-fetch-page", broken);
  assert.match(why ?? "", /^422 .*"field":"definition\.workflow","reason":"not_an_option"/, `refused as the example's own fault: ${why}`);
});
