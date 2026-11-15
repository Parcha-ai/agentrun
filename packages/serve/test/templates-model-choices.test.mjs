// A package's model choices (manifest `model.choices`): a few named models the owner picks one of at install, each with
// its harness, an optional warning shown word for word and a setup note. Apply takes `overrides.choice` and runs the
// agent on exactly that model and harness, or refuses: never the tier's model in its place.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PackageError, readPackage } from "../dist/templates.js";
import { schemaProblems } from "./schema-support.mjs";
import { scratch, serve, withEnv } from "./support.mjs";

const FREE = "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free";
/** A free model pi's catalog does not list. */
const UNLISTED = "openrouter/inclusionai/ling-3.2-flash:free";
const WARNING = "Free models may keep and train on what you send. Your email goes to whoever serves this model.";
const NOTE = "Turn on OpenRouter Settings → Privacy → ZDR only.";

/** A package with the choices block `choices` (YAML under model:), harness list `harness` (null: none, so any). */
const manifest = (choices, harness = "[codex, pi]") => `---
name: inbox
version: 1.0.0
description: Sorts an inbox.
${harness === null ? "" : `harness: ${harness}\n`}model:
  tier: balanced
${choices}
---
Sort the inbox.
`;
const CHOICES = `  choices:
    - id: free
      label: Free model
      model: ${FREE}
      harness: pi
      warning: "${WARNING}"
      note: "${NOTE}"
      secrets: [OPENROUTER_API_KEY]
    - id: unlisted
      label: Unlisted free model
      model: ${UNLISTED}
      harness: pi
    - id: searched
      label: With search
      model: openrouter/particle-ai/particle-1
      harness: pi
      secrets: [PARALLEL_API_KEY]`;

async function packageDir(t, text) {
  const dir = join(await scratch(t), "templates");
  mkdirSync(join(dir, "inbox"), { recursive: true });
  writeFileSync(join(dir, "inbox", "agent.md"), text);
  return dir;
}

async function problemsOf(t, text) {
  try {
    readPackage(join(await packageDir(t, text), "inbox"));
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return error.problems;
  }
  return [];
}

test("a package reads its model choices, each with its harness, warning, note and secrets", async (t) => {
  const p = readPackage(join(await packageDir(t, manifest(CHOICES)), "inbox"));
  assert.deepEqual(p.model.choices[0], { id: "free", label: "Free model", model: FREE, harness: "pi", warning: WARNING, note: NOTE, secrets: ["OPENROUTER_API_KEY"] });
  assert.deepEqual(p.model.choices.map((c) => [c.id, c.secrets]), [["free", ["OPENROUTER_API_KEY"]], ["unlisted", []], ["searched", ["PARALLEL_API_KEY"]]]);
});

test("the validator refuses a choice whose harness is not one of the package's, and each other broken rule, in words that say the rule", async (t) => {
  const refused = async (choices, pattern, harness) => {
    const problems = await problemsOf(t, manifest(choices, harness));
    assert.ok(problems.some((p) => pattern.test(p)), `${pattern}: ${JSON.stringify(problems)}`);
  };
  const one = (fields) => `  choices:\n    - { id: free, label: Free model, model: "${FREE}", harness: pi${fields} }`;
  await refused(one("").replace("harness: pi", "harness: claude-agent"), /model\.choices\[0\]\.harness is one of the package's harness list \(codex, pi\)/);
  await refused(one("").replace("harness: pi", "harness: emacs"), /model\.choices\[0\]\.harness is one of pi, claude-agent, codex, opencode/, null);
  await refused("  choices: []", /model\.choices is a list of 1 to 3 choices/);
  await refused(`  choices:\n${[1, 2, 3, 4].map((n) => `    - { id: c${n}, label: C${n}, model: "${FREE}", harness: pi }`).join("\n")}`, /model\.choices is a list of 1 to 3 choices/);
  await refused(one("").replace("id: free", "id: Free_Model"), /model\.choices\[0\]\.id is lowercase letters, digits and dashes/);
  await refused(`${one("")}\n    - { id: free, label: Again, model: "${FREE}", harness: pi }`, /model\.choices\[1\]\.id free is an earlier choice's/);
  await refused(one("").replace("label: Free model", `label: ${"x".repeat(41)}`), /model\.choices\[0\]\.label is text of 1 to 40 characters/);
  await refused(one("").replace(`model: "${FREE}"`, "model: nemotron"), /model\.choices\[0\]\.model is "provider\/model-id"/);
  await refused(one(`, warning: "${"w".repeat(301)}"`), /model\.choices\[0\]\.warning is text of 1 to 300 characters, shown word for word/);
  await refused(one(`, note: ""`), /model\.choices\[0\]\.note is text of 1 to 300 characters/);
  await refused(one(", secrets: [BRIEF_FEED_KEY]"), /model\.choices\[0\]\.secrets names BRIEF_FEED_KEY, a key this server cannot hold/);
  await refused(one(", tier: fast"), /model\.choices\[0\] has no field tier: a choice is \{id, label, model, harness, warning\?, note\?, secrets\?\}/);
  assert.deepEqual(await problemsOf(t, manifest(one(""))), [], "one choice with no warning reads");
  assert.deepEqual(await problemsOf(t, manifest(one("").replace("harness: pi", "harness: claude-agent"), "[pi, claude-agent]")), [], "any harness of the package's list");
});

/** A server with an OpenRouter key alone (no other model key, no gateway), serving the inbox package. */
async function inboxServer(t, more = {}) {
  withEnv(t, { OPENROUTER_API_KEY: "fake-test-key", ...more }, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY"]);
  return serve(t, { faux: undefined, harnesses: false, runner: false, templates: await packageDir(t, manifest(CHOICES)) });
}

test("GET /templates shows a package's model choices, as the served schema says", async (t) => {
  const { api, baseUrl } = await inboxServer(t);
  const listed = await api("GET", "/templates");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.deepEqual(schemaProblems(doc, doc.paths["/templates"].get.responses["200"].content["application/json"].schema, listed.body), []);
  const [inbox] = listed.body.templates;
  assert.deepEqual(inbox.model.choices, [
    { id: "free", label: "Free model", model: FREE, harness: "pi", warning: WARNING, note: NOTE, secrets: ["OPENROUTER_API_KEY"] },
    { id: "unlisted", label: "Unlisted free model", model: UNLISTED, harness: "pi", warning: null, note: null, secrets: [] },
    { id: "searched", label: "With search", model: "openrouter/particle-ai/particle-1", harness: "pi", warning: null, note: null, secrets: ["PARALLEL_API_KEY"] },
  ]);
});

test("apply with overrides.choice makes the agent on the choice's model and harness; an unknown id, or a choice beside overrides.model, is 422", async (t) => {
  const { api } = await inboxServer(t);
  const applied = await api("POST", "/templates/inbox/apply", { overrides: { choice: "free" } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const { definition } = (await api("GET", `/agents/${applied.body.agent_id}`)).body;
  assert.deepEqual([definition.model, definition.harness], [FREE, "pi"], "the choice's model on the choice's harness, never the package's first harness");
  assert.deepEqual(applied.body.warnings.filter((w) => w.field === "model"), [], "no model warning: the agent got what was picked");

  const field = async (overrides, reason) => {
    const answer = await api("POST", "/templates/inbox/apply", { overrides });
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.deepEqual(answer.body.error.fields.map((f) => [f.field, f.reason]), [["overrides.choice", reason]], JSON.stringify(answer.body.error.fields));
    return answer.body.error.fields[0].message;
  };
  assert.match(await field({ choice: "paid" }, "not_an_option"), /overrides\.choice is one of free, unlisted, searched/);
  assert.match(await field({ choice: "free", model: FREE }, "not_allowed"), /overrides\.choice and overrides\.model/);
});

test("a choice whose model this server can't run is 409 naming the model, never the tier's model in its place; a choice's missing secret is 409 as a package's is", async (t) => {
  const { api } = await inboxServer(t);
  const before = (await api("GET", "/agents")).body.agents.length;
  const unlisted = await api("POST", "/templates/inbox/apply", { overrides: { choice: "unlisted" } });
  assert.equal(unlisted.status, 409, JSON.stringify(unlisted.body));
  assert.equal(unlisted.body.error.code, "agent_not_runnable");
  assert.match(unlisted.body.error.message, new RegExp(`Unlisted free model runs ${UNLISTED.replace(/[.:/]/g, "\\$&")} on pi, which this server can't run.*Nothing was created`));
  assert.deepEqual(unlisted.body.error.fields.map((f) => [f.field, f.reason]), [["overrides.choice", "not_set_up_here"]]);

  const searched = await api("POST", "/templates/inbox/apply", { overrides: { choice: "searched" } });
  assert.equal(searched.status, 409, JSON.stringify(searched.body));
  assert.equal(searched.body.error.code, "agent_not_runnable");
  assert.deepEqual(searched.body.error.fields.map((f) => [f.field, f.reason]), [["secrets.PARALLEL_API_KEY", "not_set_up_here"]]);
  assert.equal((await api("GET", "/agents")).body.agents.length, before, "nothing was made");
});
