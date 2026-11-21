// A template's composio trigger. Its `server` names one of the package's own MCP needs by its toolkit, as a catalog name
// mcp:<toolkit>/<tool> does: a `source: composio`, `required: true` need, so an apply never makes the trigger without a
// server. The apply binds it to the saved Composio server that need resolves to (serversFor): the one candidate, or the
// owner's pick under servers.<toolkit>. What makes it on Composio (its instance, the project's route here, a move of the
// project's subscription) is this server's to set, at the create: a package carrying any of them is refused when it is
// read, in words saying to make the trigger from the console on this server, before an apply could make a trigger that
// runs on someone else's instance or moves the project's subscription unasked. Its config values (the owner's repository,
// say) and its accept rules' where `in` values may take a parameter, filled at apply, one that is required or has a
// default so the trigger never fills empty; its server and event are the package's own.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PackageError, readPackage } from "../dist/templates.js";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { scratch, secretWritePath, serve } from "./support.mjs";

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const PUBLIC = "https://agentrun.example.com";
const TOOLS = [{ slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "Lists issues." }];
const NEED = { source: "composio", toolkit: "github", required: "true" };

/** The owner's repository as two parameters, required (as a shipped package's are) unless `optional` names one, with no
 *  default unless `defaults` gives it one. */
const REPO_PARAMETERS = ({ optional = [], defaults = {} } = {}) => ["owner", "repo"].map((name) => `${name}: { type: string${optional.includes(name) || name in defaults ? ", required: false" : ""}${name in defaults ? `, default: ${defaults[name]}` : ""}, description: "the repository's ${name}" }`);
/** A config naming the repository by its parameters. */
const REPO_CONFIG = '{ owner: "${parameters.owner}", repo: "${parameters.repo}" }';

const MANIFEST = (extra, { need = NEED, server = "github", event = "GITHUB_ISSUE_ADDED_EVENT", config = "{ owner: many-drop, repo: agentrun-scratch }", parameters = [] } = {}) => `---
name: issues
version: 0.1.0
description: Triages each new issue in one repository.
budget: { per_run_usd: 0.5 }
${parameters.length ? `parameters:\n${parameters.map((line) => `  ${line}`).join("\n")}\n` : ""}mcp:
  - source: ${need.source}
    toolkit: ${need.toolkit}
    tools: [GITHUB_LIST_ISSUES]
    required: ${need.required}
triggers:
  - name: new-issue
    source:
      kind: composio
      server: ${server}
      event: ${event}
      config: ${config}
${extra.map((line) => `      ${line}`).join("\n")}
    target: { kind: start_run, input: { content: "Triage the new issue." } }
---
Triage the issue with mcp:github/GITHUB_LIST_ISSUES.
`;

/** The issues package under a fresh templates folder: that folder (`root`) and the package's own (`dir`). */
async function packageWith(t, extra, options) {
  const root = join(await scratch(t), "templates");
  const dir = join(root, "issues");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), MANIFEST(extra, options));
  return { root, dir };
}

/** readPackage's problems for the package, its source's `extra` lines among the options (none: []). */
async function problemsOf(t, options = {}) {
  const { dir } = await packageWith(t, options.extra ?? [], options);
  try {
    readPackage(dir);
    return [];
  } catch (error) {
    assert.ok(error instanceof PackageError, String(error));
    return error.problems;
  }
}

/** A server serving the package (`manifest`, its options), with a fake Composio (GitHub, connected as agentrun-qa) and
 *  each saved Composio GitHub server of `names`; at the public URL unless `publicUrl` says none. */
async function withSaved(t, names, { manifest, publicUrl = PUBLIC } = {}) {
  const { root } = await packageWith(t, manifest?.extra ?? [], manifest);
  const composio = await startFakeComposio({ toolkits: { github: { no_auth: false, tools: TOOLS } }, authConfigs: { github: [{ id: "ac_managed", is_composio_managed: true }] }, active: ["github"] });
  t.after(() => composio.close());
  const server = await serve(t, { templates: root, ...(publicUrl ? { publicUrl } : {}), composioControl: { baseUrl: composio.baseUrl } });
  for (const name of names) {
    const saved = await server.api("PUT", `/settings/mcp-servers/${name}/composio`, { api_key: composio.apiKey, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "agentrun-qa" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  return { ...server, composio };
}

/** The apply's one trigger, as GET /triggers/{id} reads it. */
async function madeTrigger(api, applied) {
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.triggers.length, 1, JSON.stringify(applied.body));
  const read = await api("GET", `/triggers/${applied.body.triggers[0].trigger_id}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return read.body;
}

test("a package's composio trigger names its need's toolkit: the apply binds it to the one saved Composio server of that toolkit, whatever its name, and makes its instance", async (t) => {
  const { api, composio } = await withSaved(t, ["work-github"]);
  const applied = await api("POST", "/templates/issues/apply", { parameters: {} });
  const trigger = await madeTrigger(api, applied);
  assert.equal(trigger.source.server, "work-github");
  const [instance] = [...composio.instances.values()];
  assert.ok(instance, "its instance is made on Composio");
  assert.equal(trigger.source.instance_id, instance.id);
  assert.equal(instance.trigger_name, "GITHUB_ISSUE_ADDED_EVENT");
});

test("with two saved Composio servers of the toolkit, the trigger binds to the one the owner picks under servers.<toolkit>", async (t) => {
  const { api } = await withSaved(t, ["home-github", "work-github"]);
  const unpicked = await api("POST", "/templates/issues/apply", { parameters: {} });
  assert.equal(unpicked.status, 422, JSON.stringify(unpicked.body));
  assert.deepEqual(unpicked.body.error.fields.map((f) => f.field), ["servers.github"]);
  const applied = await api("POST", "/templates/issues/apply", { parameters: {}, servers: { github: "work-github" } });
  assert.equal((await madeTrigger(api, applied)).source.server, "work-github");
});

test("an apply on a server that can't set up a composio trigger yet (no public URL) makes the agent and skips the trigger, in the refusal's words and the console's path, as a github trigger with GitHub not connected is", async (t) => {
  const { api, composio } = await withSaved(t, ["work-github"], { publicUrl: null });
  const applied = await api("POST", "/templates/issues/apply", { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.triggers, [], "no trigger made");
  assert.equal(composio.instances.size, 0, "nothing made on Composio");
  const warning = applied.body.warnings.find((w) => w.field === "triggers.0");
  assert.equal(warning?.reason, "not_set_up_here", JSON.stringify(applied.body.warnings));
  assert.match(warning.message, /public URL/, "the refusal's own words");
  assert.match(`${warning.message} ${warning.fix ?? ""}`, /Triggers → New app trigger/);
  assert.equal((await api("GET", `/agents/${applied.body.agent_id}`)).status, 200, "the agent stands");
  assert.deepEqual((await api("GET", "/triggers")).body.triggers, []);
});

test("any other refusal of a package's composio trigger still undoes the apply: an event Composio doesn't know", async (t) => {
  const { api, composio } = await withSaved(t, ["work-github"], { manifest: { event: "GITHUB_NOT_AN_EVENT" } });
  const applied = await api("POST", "/templates/issues/apply", { parameters: {} });
  assert.ok(applied.status >= 400, `${applied.status}: ${JSON.stringify(applied.body)}`);
  assert.deepEqual((await api("GET", "/triggers")).body.triggers, [], "nothing kept");
  assert.equal(composio.instances.size, 0);
});

test("a package's composio trigger whose server names no composio need of the package is refused when it is read, saying to name a need's toolkit", async (t) => {
  for (const options of [{ server: "slack" }, { need: { ...NEED, source: "url" } }]) {
    const problems = await problemsOf(t, options);
    assert.ok(problems.some((one) => /^agent\.md: triggers\[0\]\.source\.server/.test(one) && /toolkit/.test(one) && /source: composio/.test(one)), `${JSON.stringify(options)}: ${JSON.stringify(problems)}`);
  }
});

test("the need a composio trigger names is required: an optional one could resolve to no server, so the package is refused when it is read", async (t) => {
  const problems = await problemsOf(t, { need: { ...NEED, required: "false" } });
  assert.ok(problems.some((one) => /^agent\.md: triggers\[0\]\.source\.server/.test(one) && /required: true/.test(one)), JSON.stringify(problems));
  assert.deepEqual(await problemsOf(t, {}), [], "the package with a required composio need reads");
});

test("a composio trigger's config values take parameters, filled at apply: the trigger and its instance on Composio carry the owner's repository", async (t) => {
  for (const parameters of [REPO_PARAMETERS(), REPO_PARAMETERS({ defaults: { repo: "web" } })]) assert.deepEqual(await problemsOf(t, { parameters, config: REPO_CONFIG }), [], `${parameters.join("; ")}: the package reads`);
  const { api, composio } = await withSaved(t, ["work-github"], { manifest: { parameters: REPO_PARAMETERS(), config: REPO_CONFIG } });
  const trigger = await madeTrigger(api, await api("POST", "/templates/issues/apply", { parameters: { owner: "acme", repo: "web" } }));
  assert.deepEqual(trigger.source.config, { owner: "acme", repo: "web" });
  const [instance] = [...composio.instances.values()];
  assert.deepEqual(instance?.trigger_config, { owner: "acme", repo: "web" }, "Composio's instance watches the owner's repository");
});

test("a parameter left out of the apply fills a composio trigger's config with its default", async (t) => {
  const { api, composio } = await withSaved(t, ["work-github"], { manifest: { parameters: REPO_PARAMETERS({ defaults: { repo: "web" } }), config: REPO_CONFIG } });
  const trigger = await madeTrigger(api, await api("POST", "/templates/issues/apply", { parameters: { owner: "acme" } }));
  assert.deepEqual(trigger.source.config, { owner: "acme", repo: "web" });
  assert.deepEqual([...composio.instances.values()][0]?.trigger_config, { owner: "acme", repo: "web" });
});

test("a composio trigger's config value naming an optional parameter with no default is refused when it is read: the trigger would fill it empty", async (t) => {
  const problems = await problemsOf(t, { parameters: REPO_PARAMETERS({ optional: ["repo"] }), config: REPO_CONFIG });
  assert.ok(problems.some((one) => /^agent\.md: parameters\.repo is used in triggers\[0\]\.source\.config/.test(one) && /required or has a default/.test(one)), JSON.stringify(problems));
  assert.ok(!problems.some((one) => /parameters\.owner/.test(one)), `the required one is fine: ${JSON.stringify(problems)}`);
});

test("a composio trigger's accept rules take a parameter in a where condition's in values, filled at apply, under the github rule: required or with a default", async (t) => {
  const accept = ['accept: [{ event: GITHUB_ISSUE_ADDED_EVENT, where: [{ pointer: /data/repo, in: ["${parameters.repo}"] }] }]'];
  const { api } = await withSaved(t, ["work-github"], { manifest: { parameters: REPO_PARAMETERS(), extra: accept } });
  const trigger = await madeTrigger(api, await api("POST", "/templates/issues/apply", { parameters: { owner: "acme", repo: "web" } }));
  assert.deepEqual(trigger.source.accept, [{ event: "GITHUB_ISSUE_ADDED_EVENT", where: [{ pointer: "/data/repo", in: ["web"] }] }]);
  const problems = await problemsOf(t, { parameters: REPO_PARAMETERS({ optional: ["repo"] }), extra: accept });
  assert.ok(problems.some((one) => /^agent\.md: parameters\.repo is used in triggers\[0\]\.source\.accept/.test(one) && /required or has a default/.test(one)), JSON.stringify(problems));
});

test("a composio trigger's server and event take no parameter: they are the package's own, and the refusal lists where a placeholder goes", async (t) => {
  const parameters = [...REPO_PARAMETERS(), 'kit: { type: string, required: false, default: github, description: "a toolkit" }'];
  for (const [field, options] of [["server", { server: '"${parameters.kit}"' }], ["event", { event: '"GITHUB_${parameters.kit}_EVENT"' }]]) {
    const problems = await problemsOf(t, { parameters, ...options });
    const refusal = problems.find((one) => one.startsWith(`agent.md: triggers[0].source.${field} holds \${parameters.kit}`));
    assert.ok(refusal, `${field}: ${JSON.stringify(problems)}`);
    assert.match(refusal, /a composio trigger's config values/);
    assert.match(refusal, /where in values/);
  }
});

for (const [what, extra] of [
  ["an instance and a route made on another server", ["instance_id: ti_someone_else", "hook: cph_0123456789abcdef01234567"]],
  ["a move of the project's subscription", ["move_subscription: true"]],
]) {
  test(`a template's composio trigger carrying ${what} is refused: the trigger is made from the console on this server`, async (t) => {
    const { dir } = await packageWith(t, extra);
    assert.throws(() => readPackage(dir), (error) => {
      assert.ok(error instanceof PackageError, String(error));
      assert.ok(error.problems.some((one) => /^agent\.md: triggers\[0\]\.source/.test(one) && /make (it|the trigger) from the console on this server/i.test(one)), JSON.stringify(error.problems));
      return true;
    });
  });
}
