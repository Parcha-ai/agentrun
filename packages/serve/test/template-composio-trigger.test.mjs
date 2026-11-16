// A template's composio trigger. Its `server` names one of the package's own MCP needs by its toolkit, as a catalog name
// mcp:<toolkit>/<tool> does: a `source: composio`, `required: true` need, so an apply never makes the trigger without a
// server. The apply binds it to the saved Composio server that need resolves to (serversFor): the one candidate, or the
// owner's pick under servers.<toolkit>. What makes it on Composio (its instance, the project's route here, a move of the
// project's subscription) is this server's to set, at the create: a package carrying any of them is refused when it is
// read, in words saying to make the trigger from the console on this server, before an apply could make a trigger that
// runs on someone else's instance or moves the project's subscription unasked.
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

const MANIFEST = (extra, { need = NEED, server = "github" } = {}) => `---
name: issues
version: 0.1.0
description: Triages each new issue in one repository.
budget: { per_run_usd: 0.5 }
mcp:
  - source: ${need.source}
    toolkit: ${need.toolkit}
    tools: [GITHUB_LIST_ISSUES]
    required: ${need.required}
triggers:
  - name: new-issue
    source:
      kind: composio
      server: ${server}
      event: GITHUB_ISSUE_ADDED_EVENT
      config: { owner: many-drop, repo: agentrun-scratch }
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

/** readPackage's problems for the package (none: []). */
async function problemsOf(t, options) {
  const { dir } = await packageWith(t, [], options);
  try {
    readPackage(dir);
    return [];
  } catch (error) {
    assert.ok(error instanceof PackageError, String(error));
    return error.problems;
  }
}

/** A server serving the package, with a fake Composio (GitHub, connected as agentrun-qa) and each saved Composio GitHub
 *  server of `names`. */
async function withSaved(t, names) {
  const { root } = await packageWith(t, []);
  const composio = await startFakeComposio({ toolkits: { github: { no_auth: false, tools: TOOLS } }, authConfigs: { github: [{ id: "ac_managed", is_composio_managed: true }] }, active: ["github"] });
  t.after(() => composio.close());
  const server = await serve(t, { templates: root, publicUrl: PUBLIC, composioControl: { baseUrl: composio.baseUrl } });
  for (const name of names) {
    const saved = await server.api("PUT", `/settings/mcp-servers/${name}/composio`, { api_key: composio.apiKey, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "agentrun-qa" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  return { ...server, composio };
}

/** The apply's one trigger, as GET /triggers/{id} reads it. */
async function madeTrigger(api, applied) {
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.trigger_ids.length, 1, JSON.stringify(applied.body));
  const read = await api("GET", `/triggers/${applied.body.trigger_ids[0]}`);
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
