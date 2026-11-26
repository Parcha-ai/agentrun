// A package's model choices (manifest `model.choices`): a few named models the owner picks one of at install, each with
// its harness, an optional warning shown word for word and a setup note. Apply takes `overrides.choice` and runs the
// agent on exactly that model and harness, or refuses: never the tier's model in its place.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { choiceUnrunnable, PackageError, packageModel, readPackage } from "../dist/templates.js";
import { schemaProblems } from "./schema-support.mjs";
import { scratch, serve, withEnv } from "./support.mjs";

const FREE = "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free";
/** A model neither pi's catalog nor serve's own free list names. */
const UNLISTED = "openrouter/nobody/no-such-model:free";
const WARNING = "Free models may keep and train on what you send. Your email goes to whoever serves this model.";
const NOTE = "Turn on OpenRouter Settings → Privacy → ZDR only.";

/** A package with the choices block `choices` (YAML under model:), harness list `harness` (null: none, so any). */
const manifest = (choices, harness = "[codex, pi]") => `---
name: inbox
version: 1.0.0
description: Sorts an inbox.
tools: []
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

test("a choice runs only where its harness is available, its model in that harness's catalog with a key for it, and never through a gateway", async () => {
  const env = { OPENROUTER_API_KEY: "fake-test-key" };
  const free = { id: "free", label: "Free model", model: FREE, harness: "pi", secrets: [] };
  const up = { available: true };
  assert.equal(await choiceUnrunnable(env, free, up), undefined);
  assert.equal(await choiceUnrunnable(env, free, { available: false, reason: "Its install failed its check." }), "pi is not available here: Its install failed its check");
  assert.equal(await choiceUnrunnable(env, free, undefined), "pi is not available here");
  assert.match(await choiceUnrunnable(env, { ...free, model: UNLISTED }, up), /is not a model pi runs here/);
  assert.match(await choiceUnrunnable({}, free, up), /No OpenRouter key here for/);
  assert.match(await choiceUnrunnable({ ...env, AGENT_MODEL_BASE_URL: "https://gateway.example/v1", AGENT_MODEL_API_KEY: "fake-test-key" }, free, up), /through a gateway, which has not said it serves that model/);
  assert.match(await choiceUnrunnable(env, { ...free, harness: "claude-agent" }, up), /claude-agent does not run that model here/);
  // Checked on the harness's own route, as a save and a run are: codex reaches an OpenAI model through OpenRouter's key
  // alone, and claude-agent an Anthropic one, with no OpenAI or Anthropic key here.
  assert.equal(await choiceUnrunnable(env, { ...free, model: "openai/gpt-6.1-sol", harness: "codex" }, up), undefined);
  assert.equal(await choiceUnrunnable(env, { ...free, model: "anthropic/claude-sonnet-5.5", harness: "claude-agent" }, up), undefined);
  assert.deepEqual(await packageModel(env, { tier: "balanced", prefer: "openai/gpt-6.1-sol" }, "codex"), { model: "openai/gpt-6.1-sol" }, "a package's prefer, the same");
  // claude-agent takes any Anthropic id on its own route: one no catalog here lists is refused all the same, before an
  // agent is made whose runs would fail at the provider.
  const anthropic = { ANTHROPIC_API_KEY: "fake-test-key" };
  assert.match(await choiceUnrunnable(anthropic, { ...free, model: "anthropic/no-such-model", harness: "claude-agent" }, up) ?? "", /no model catalog here lists it/);
  assert.equal(await choiceUnrunnable(anthropic, { ...free, model: "anthropic/claude-haiku-5-5", harness: "claude-agent" }, up), undefined);
  assert.deepEqual(await packageModel(anthropic, { tier: "balanced", prefer: "anthropic/no-such-model" }, "claude-agent"), { refused: { why: "no model catalog here lists it", fix: "Apply with overrides.model." } });
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

/** A package that prefers `prefer` on pi, its tier fast. */
const preferring = (prefer) => `---
name: inbox
version: 1.0.0
description: Sorts an inbox.
tools: []
harness: [pi]
model: { tier: fast, prefer: ${prefer} }
---
Sort the inbox.
`;

test("a package whose model.prefer this server can't run is 409 naming the model and the fix, never the tier's model in its place", async (t) => {
  // A fast tier model is here (an OpenAI key and AGENT_MODEL_FAST): the old silent fallback had one to swap in.
  withEnv(t, { OPENAI_API_KEY: "fake-test-key", AGENT_MODEL_FAST: "openai/gpt-6-luna" }, ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "AGENT_MODEL", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY"]);
  const { api } = await serve(t, { faux: undefined, harnesses: false, runner: false, templates: await packageDir(t, preferring("openrouter/particle-ai/particle-1")) });
  const before = (await api("GET", "/agents")).body.agents.length;
  const keyless = await api("POST", "/templates/inbox/apply", {});
  assert.equal(keyless.status, 409, JSON.stringify(keyless.body));
  assert.equal(keyless.body.error.code, "agent_not_runnable");
  assert.deepEqual(keyless.body.error.fields.map((f) => [f.field, f.reason]), [["model", "not_set_up_here"]]);
  const { message, fields: [field] } = keyless.body.error;
  assert.match(message, /The inbox template prefers openrouter\/particle-ai\/particle-1, which this server can't run on pi: no OpenRouter key is saved here\. Nothing was created\./);
  assert.equal(field.fix, "Save an OpenRouter key in Settings → Model keys, or apply with overrides.model.");
  assert.equal((await api("GET", "/agents")).body.agents.length, before, "nothing was made");
  // The fix it names works: a model of the owner's own.
  const own = await api("POST", "/templates/inbox/apply", { overrides: { model: "openai/gpt-6-luna" } });
  assert.equal(own.status, 201, JSON.stringify(own.body));
});

test("a dry run lists the keys missing here even where the model needs one of them (its prefer, or a choice), and the apply itself is still refused", async (t) => {
  withEnv(t, { OPENAI_API_KEY: "fake-test-key", AGENT_MODEL_FAST: "openai/gpt-6-luna" }, ["OPENROUTER_API_KEY", "PARALLEL_API_KEY", "ANTHROPIC_API_KEY", "AGENT_MODEL", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY"]);
  const keyed = preferring("openrouter/particle-ai/particle-1").replace("model:", "secrets: [OPENROUTER_API_KEY]\nmodel:");
  const { api } = await serve(t, { faux: undefined, harnesses: false, runner: false, templates: await packageDir(t, keyed) });
  const before = (await api("GET", "/agents")).body.agents.length;
  const plan = await api("POST", "/templates/inbox/apply", { dry_run: true });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.deepEqual(plan.body.plan.missing_secrets, ["OPENROUTER_API_KEY"]);
  const applied = await api("POST", "/templates/inbox/apply", {});
  assert.equal(applied.status, 409, JSON.stringify(applied.body));
  assert.equal(applied.body.error.code, "agent_not_runnable");
  assert.equal((await api("GET", "/agents")).body.agents.length, before, "nothing was made");
});

test("a dry run with a model choice whose key is missing lists the key, where the apply refuses", async (t) => {
  withEnv(t, { OPENAI_API_KEY: "fake-test-key" }, ["OPENROUTER_API_KEY", "PARALLEL_API_KEY", "ANTHROPIC_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY"]);
  const { api } = await serve(t, { faux: undefined, harnesses: false, runner: false, templates: await packageDir(t, manifest(CHOICES)) });
  const plan = await api("POST", "/templates/inbox/apply", { dry_run: true, overrides: { choice: "free" } });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.deepEqual(plan.body.plan.missing_secrets, ["OPENROUTER_API_KEY"]);
  const applied = await api("POST", "/templates/inbox/apply", { overrides: { choice: "free" } });
  assert.equal(applied.status, 409, JSON.stringify(applied.body));
  assert.equal(applied.body.error.code, "agent_not_runnable");
});

test("a model.prefer no catalog here lists is 409 naming it, and the fix is another model, not a key", async (t) => {
  withEnv(t, { OPENROUTER_API_KEY: "fake-test-key", AGENT_MODEL_FAST: "openrouter/openai/gpt-6-luna" }, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AGENT_MODEL", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY"]);
  const { api } = await serve(t, { faux: undefined, harnesses: false, runner: false, templates: await packageDir(t, preferring(UNLISTED)) });
  const unknown = await api("POST", "/templates/inbox/apply", {});
  assert.equal(unknown.status, 409, JSON.stringify(unknown.body));
  assert.equal(unknown.body.error.code, "agent_not_runnable");
  assert.match(unknown.body.error.message, new RegExp(`prefers ${UNLISTED.replace(/[.:/]/g, "\\$&")}, which this server can't run on pi: no model catalog here lists it\\. Nothing was created\\.`));
  assert.equal(unknown.body.error.fields[0].fix, "Apply with overrides.model.");
});
