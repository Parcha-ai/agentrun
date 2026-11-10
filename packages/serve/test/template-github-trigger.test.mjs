// A template whose trigger is a github source (POST /v2/templates/{template}/apply): its parameters fill the trigger's
// accept (a where condition's `in` values), as they fill its display name and instructions. With GitHub connected the
// trigger is made and the answer says what it runs on; with none, the agent is still made and the trigger is skipped
// with a warning under triggers.<i>, never a whole-apply refusal. End to end, a signed pull_request for the repository
// fires a run and one for another repository fires none.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PackageError, readPackage } from "../dist/templates.js";
import { connect, connectable, deliver, firstInput } from "./github-support.mjs";
import { scratch } from "./support.mjs";
import { firings, keyOf } from "./trigger-support.mjs";

const REPO = "acme/widgets";
const ACCEPT = '[{ event: pull_request, actions: [opened, reopened, synchronize, ready_for_review], where: [{ pointer: /repository/full_name, in: ["${parameters.repo}"] }] }]';
const CONNECT_WORDS = "Connect GitHub in Settings, then apply again to review pull requests automatically.";
const pr = (repo, extra = {}) => ({ action: "opened", number: 12, pull_request: { number: 12, draft: false, title: "Add a thing" }, repository: { full_name: repo }, installation: { id: 777 }, sender: { login: "dev" }, ...extra });

/** A template package in a directory of its own: code-review with the github trigger proposed for it, its repository a
 *  parameter. `accept` and `parameter` vary it for the manifest's checks. */
function manifest({ name = "code-review", accept = ACCEPT, parameter = 'repo: { type: string, required: true, pattern: "^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$", description: "the repository, as owner/name" }' } = {}) {
  return `---\nname: ${name}\nversion: 1.0.0\ndescription: Reviews each pull request to one repository.\ndisplay_name: "Code review: \${parameters.repo}"\nparameters:\n  ${parameter}\nbudget: { per_run_usd: 1.00 }\napprovals: never\ntriggers:\n  - name: pull-requests\n    source: { kind: github, accept: ${accept} }\n    target: { kind: start_run, input: { content: "Review the pull request." } }\n---\nReview the pull requests to \${parameters.repo}.\n`;
}

async function templatesWith(t, text = manifest()) {
  const dir = join(await scratch(t), "templates");
  mkdirSync(join(dir, "code-review"), { recursive: true });
  writeFileSync(join(dir, "code-review", "agent.md"), text);
  return dir;
}

async function problems(t, text) {
  const dir = await templatesWith(t, text);
  try {
    readPackage(join(dir, "code-review"));
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return error.problems;
  }
  return [];
}

test("a github trigger's accept may take a parameter in a where condition's in values, and nowhere else; the parameter is required or has a default, so the trigger never fills empty", async (t) => {
  assert.deepEqual(await problems(t, manifest()), [], "the proposed trigger reads");
  const elsewhere = await problems(t, manifest({ accept: '[{ event: "${parameters.repo}" }]' }));
  assert.ok(elsewhere.some((p) => /triggers\[0\]\.source holds \$\{parameters\.repo\}/.test(p)), JSON.stringify(elsewhere));
  const pointer = await problems(t, manifest({ accept: '[{ event: pull_request, where: [{ pointer: "/${parameters.repo}", exists: true }] }]' }));
  assert.ok(pointer.some((p) => /triggers\[0\]\.source holds \$\{parameters\.repo\}/.test(p)), JSON.stringify(pointer));
  const optional = await problems(t, manifest({ parameter: 'repo: { type: string, description: "the repository, as owner/name" }' }));
  assert.ok(optional.includes("agent.md: parameters.repo is used in triggers[0].source.accept, so it is required or has a default: a github trigger filled empty takes no event"), JSON.stringify(optional));
});

test("(a) GitHub connected: the template's github trigger is made with the repository filled in, and the answer says what it runs on", { timeout: 120_000 }, async (t) => {
  const server = await connectable(t, { templates: await templatesWith(t) });
  await connect(server);
  const applied = await server.api("POST", "/templates/code-review/apply", { parameters: { repo: REPO } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.trigger_ids.length, 1, JSON.stringify(applied.body));
  const trigger = (await server.api("GET", `/triggers/${applied.body.trigger_ids[0]}`)).body;
  assert.equal(trigger.source.kind, "github");
  assert.deepEqual(trigger.source.accept[0].where, [{ pointer: "/repository/full_name", in: [REPO] }], "the repository filled in");
  assert.equal(trigger.target.agent_id, applied.body.agent_id);
  assert.deepEqual(applied.body.warnings.filter((w) => w.field === "triggers.0"), [{ field: "triggers.0", reason: "not_an_option", message: `Code review runs on each pull request to ${REPO}.` }]);
});

test("(b) GitHub not connected: the agent is still made, its github trigger is skipped with a warning under triggers.0, and the apply answers 201, never 409", { timeout: 120_000 }, async (t) => {
  // The proposed trigger, its repository a parameter; and one that names its repository itself, which any server reads.
  const fixed = manifest({ name: "repo-watch", accept: `[{ event: pull_request, where: [{ pointer: /repository/full_name, in: ["${REPO}"] }] }]` });
  for (const [template, text] of [["repo-watch", fixed], ["code-review", manifest()]]) {
    const dir = join(await scratch(t), "templates");
    mkdirSync(join(dir, template), { recursive: true });
    writeFileSync(join(dir, template, "agent.md"), text);
    const server = await connectable(t, { templates: dir });
    const applied = await server.api("POST", `/templates/${template}/apply`, { parameters: { repo: REPO } });
    assert.equal(applied.status, 201, `${template}: ${JSON.stringify(applied.body)}`);
    assert.deepEqual(applied.body.trigger_ids, [], template);
    const agent = await server.api("GET", `/agents/${applied.body.agent_id}`);
    assert.equal(agent.status, 200, JSON.stringify(agent.body));
    assert.equal(agent.body.archived_at ?? null, null, `${template}: made, and not archived`);
    assert.deepEqual(applied.body.warnings.filter((w) => w.field === "triggers.0"), [{ field: "triggers.0", reason: "not_set_up_here", message: CONNECT_WORDS }], template);
    assert.deepEqual((await server.api("GET", "/triggers")).body.triggers, [], `${template}: no trigger`);
  }
});

test("(c) end to end: a signed pull_request for the template's repository fires a run of its agent, and one for another repository fires none", { timeout: 120_000 }, async (t) => {
  const server = await connectable(t, { templates: await templatesWith(t) });
  await connect(server);
  const applied = await server.api("POST", "/templates/code-review/apply", { parameters: { repo: REPO } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const [id] = applied.body.trigger_ids;
  const { webhook_secret: secret } = server.github.app;
  const other = await deliver(server.baseUrl, secret, "pull_request", pr("acme/other"));
  assert.deepEqual([other.status, other.body], [200, { ok: "ignored" }], "another repository: no trigger takes it");
  assert.deepEqual((await server.api("GET", `/triggers/${id}/firings`)).body.firings, [], "another repository fires nothing");
  const fired = await deliver(server.baseUrl, secret, "pull_request", pr(REPO));
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  const hash = `sha256:${createHash("sha256").update(fired.body_text).digest("hex")}`;
  assert.deepEqual(fired.body.firings.map((f) => f.key), [keyOf("github", id, hash)], "its own firing");
  const [firing] = await firings(server.api, id, 1);
  assert.ok(firing.run_id, JSON.stringify(firing));
  const run = (await server.api("GET", `/runs/${firing.run_id}`)).body;
  assert.equal(run.agent_id, applied.body.agent_id, "a run of the template's agent");
  const { content } = await firstInput(t, server, firing.run_id);
  assert.match(content, /^Review the pull request\./);
  assert.match(content, /repo="acme\/widgets"/);
});
