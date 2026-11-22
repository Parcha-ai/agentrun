// The API-only profile's deploy routes (api-only.ts): a backend that deploys agents to the server behind it applies a
// template, reads the agent and its revisions, moves its current revision back, and archives then deletes the agent, all
// with the server's token. The apply makes no trigger of any kind: each is skipped and said (a schedule too, which would
// start runs on the server's own clock and model key, outside the backend's), and its dry run plans each as skipped, in
// the same words. Making a trigger, reading or changing one, the hooks and the settings stay refused. Off by default: the
// whole server's apply makes every trigger, as before.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { scratch, serve, withEnv } from "./support.mjs";
import { fakeClock } from "./trigger-support.mjs";

const { apiOnlyTriggerSkipped } = await import("../dist/api-only.js");
const { SOURCE_KINDS } = await import("../dist/triggers.js");

const MANIFEST = `---
name: deployed
version: 1.0.0
description: Writes a note on a topic every morning, on each lead a form sends, and on new mail.
budget: { per_run_usd: 0.5 }
tools: []
parameters:
  topic: { type: string, description: "the topic" }
triggers:
  - name: morning
    source: { kind: schedule, cron: "0 9 * * *", timezone: UTC }
    target: { kind: start_run, input: { content: "Today's note on \${parameters.topic}." } }
  - name: lead-form
    source: { kind: webhook }
    target: { kind: start_run, input: { content: "A lead arrived." } }
  - name: new-mail
    source: { kind: email, every_s: 60 }
    target: { kind: start_run, input: { content: "Sort the new mail." } }
---
Write a short note about \${parameters.topic}.
`;

/** The same package without its email trigger: a whole server with no email account refuses that one at apply. */
const NO_MAIL = MANIFEST.replace(/ {2}- name: new-mail\n(?: {4}.*\n){2}/, "");

/** A server with the `deployed` template (`manifest`), its options `options` (apiOnly or not), no runner. */
async function deployServer(t, options, manifest = MANIFEST) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const root = join(await scratch(t), "templates");
  mkdirSync(join(root, "deployed"), { recursive: true });
  writeFileSync(join(root, "deployed", "agent.md"), manifest);
  return serve(t, { templates: root, runner: false, ...options });
}

/** One request to `server` (its path from the root, the token unless `token` is false): its status and body. */
async function send(server, method, path, { token = true, body } = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${server.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json ?? text };
}

/** The profile's 404 for `path`. */
const refusedHere = (answer, path, what) => assert.deepEqual([answer.status, answer.body.error?.code, answer.body.error?.message], [404, "not_found", `this server serves the run API only (AGENTRUN_API_ONLY=1): ${path} is not served here`], `${what}: ${JSON.stringify(answer.body)}`);

/** The apply's warnings for the triggers it skipped: field, reason and words. */
const skippedOf = (body) => body.warnings.filter((one) => /^triggers\.\d+$/.test(one.field)).map((one) => [one.field, one.reason, one.message]);
const notMade = (name, kind) => `The deployed template's trigger ${name} (${kind}) was not made: this server serves the run API only (AGENTRUN_API_ONLY=1), so a run starts here through the API alone, never on a trigger. Start its runs through the API instead.`;
const SKIPPED = [
  ["triggers.0", "not_an_option", notMade("morning", "schedule")],
  ["triggers.1", "not_an_option", notMade("lead-form", "webhook")],
  ["triggers.2", "not_an_option", notMade("new-mail", "email")],
];

/** The runs of `agent` on `server`, through its API. */
const runsOf = async (server, agent) => {
  const listed = await send(server, "GET", `/v2/runs?agent=${agent}`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  return listed.body.runs;
};

test("an API-only server applies a template, reads its agent and revisions, moves its current revision back, and archives and deletes it, with the token", { timeout: 120_000 }, async (t) => {
  const server = await deployServer(t, { apiOnly: true });

  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  assert.deepEqual(applied.body.triggers, [], "no trigger is made, a schedule included");
  assert.deepEqual(skippedOf(applied.body), SKIPPED, "each trigger is skipped, and said");
  assert.equal(applied.body.webhook_secrets, undefined, "no webhook secret is minted");
  assert.ok(!applied.body.warnings.some((one) => one.field === "triggers.1.secret"), "nor said");
  assert.deepEqual(await server.store.triggers.list(agent), [], "the store holds no trigger");

  const read = await send(server, "GET", `/v2/agents/${agent}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual([read.body.agent_id, read.body.definition.instructions], [agent, "Write a short note about tides."], "the agent's read");
  const first = read.body.revision;
  assert.equal((await fetch(`${server.url}/v2/agents/${agent}`, { method: "HEAD", headers: { authorization: `Bearer ${server.token}` } })).status, 200, "HEAD as GET");

  // A redeploy: the same template onto the agent it made, with another topic, writes its second revision.
  const redeployed = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "currents" }, agent_id: agent } });
  assert.equal(redeployed.status, 200, JSON.stringify(redeployed.body));
  assert.deepEqual([redeployed.body.agent_id, redeployed.body.agent_change, redeployed.body.revision_version], [agent, "updated", 2], "a new revision of the same agent");
  assert.deepEqual(redeployed.body.triggers, [], "still no trigger");
  assert.deepEqual(skippedOf(redeployed.body), SKIPPED, "and the same three skipped");

  const revisions = await send(server, "GET", `/v2/agents/${agent}/revisions`);
  assert.equal(revisions.status, 200, JSON.stringify(revisions.body));
  assert.deepEqual(revisions.body.revisions.map((one) => [one.version, one.current]), [[2, true], [1, false]], "both revisions, the second current");
  assert.equal(revisions.body.revisions[1].revision, first);

  // A rollback: the first revision current again.
  const moved = await send(server, "POST", `/v2/agents/${agent}/current`, { body: { revision: first } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.revision, moved.body.definition.instructions], [first, "Write a short note about tides."], "the first revision is current");
  assert.equal((await send(server, "GET", `/v2/agents/${agent}`)).body.revision, first, "and reads so");

  // Everything else of agents, triggers, hooks and settings stays the profile's 404.
  const trigger = "trg_0123456789abcdef01234567";
  for (const [what, method, path, body] of [
    ["a trigger made", "POST", "/v2/triggers", { name: "extra", agent_id: agent, source: { kind: "schedule", every_s: 3600 }, target: { kind: "start_run", input: { content: "Hi" } } }],
    ["the triggers list", "GET", "/v2/triggers"],
    ["a trigger's read", "GET", `/v2/triggers/${trigger}`],
    ["a trigger's change", "PATCH", `/v2/triggers/${trigger}`, { enabled: false }],
    ["a trigger's fire", "POST", `/v2/triggers/${trigger}/fire`, {}],
    ["a trigger's firings", "GET", `/v2/triggers/${trigger}/firings`],
    ["a webhook hook", "POST", `/v2/hooks/${trigger}`, {}],
    ["a settings read", "GET", "/v2/settings/tools"],
    ["a settings write", "PUT", "/v2/settings/tools", { web_search: "parallel" }],
    ["the agents list", "GET", "/v2/agents"],
    ["an agent made", "POST", "/v2/agents", { definition: { name: "Other", instructions: "Answer.", skills: [], tools: [] } }],
    ["an agent's edit", "PUT", `/v2/agents/${agent}/definition`, { definition: { instructions: "Something else." } }],
    ["the templates list", "GET", "/v2/templates"],
  ]) refusedHere(await send(server, method, path, body === undefined ? {} : { body }), path, what);
  assert.deepEqual(await server.store.triggers.list(agent), [], "no trigger made");

  // Each takes the token.
  for (const [method, path, body] of [["POST", "/v2/templates/deployed/apply", { parameters: { topic: "waves" } }], ["GET", `/v2/agents/${agent}`], ["GET", `/v2/agents/${agent}/revisions`], ["POST", `/v2/agents/${agent}/current`, { revision: first }], ["POST", `/v2/agents/${agent}/archive`]]) {
    const answer = await send(server, method, path, { token: false, ...(body ? { body } : {}) });
    assert.deepEqual([answer.status, answer.body.error?.code], [401, "unauthenticated"], `${method} ${path} without the token`);
  }
  assert.equal((await server.store.agents.get(agent)).archivedAt, null, "nothing archived without the token");

  // A delete: archived first, then purged.
  const archived = await send(server, "POST", `/v2/agents/${agent}/archive`);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.triggers_off, [], "no trigger to turn off");
  const deleted = await send(server, "DELETE", `/v2/agents/${agent}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  const gone = await send(server, "GET", `/v2/agents/${agent}`);
  assert.deepEqual([gone.status, gone.body.error?.code], [410, "purged"], JSON.stringify(gone.body));
});

test("on an API-only server a template's schedule starts no run when its time passes, on the triggers' own clock; on the whole server it does", { timeout: 60_000 }, async (t) => {
  const apiOnlyClock = fakeClock("2026-06-01T08:00:00Z");
  const wholeClock = fakeClock("2026-06-01T08:00:00Z");
  const apiOnly = await deployServer(t, { apiOnly: true, triggerClock: apiOnlyClock }, NO_MAIL);
  const whole = await deployServer(t, { triggerClock: wholeClock }, NO_MAIL);
  const hosted = await send(apiOnly, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(hosted.status, 201, JSON.stringify(hosted.body));
  assert.deepEqual(hosted.body.triggers, [], JSON.stringify(hosted.body.triggers));
  assert.deepEqual(skippedOf(hosted.body).map(([field]) => field), ["triggers.0", "triggers.1"], "the schedule and the webhook both said");
  const own = await send(whole, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(own.status, 201, JSON.stringify(own.body));

  apiOnlyClock.to("2026-06-01T09:00:00Z");
  wholeClock.to("2026-06-01T09:00:00Z");
  // The whole server's schedule starts its run: the clock reaches it, so this server's would too had it made one.
  for (const end = Date.now() + 20_000; (await runsOf(whole, own.body.agent_id)).length === 0; await sleep(100)) assert.ok(Date.now() < end, "the whole server's schedule never started its run");
  await sleep(500);
  assert.deepEqual(await runsOf(apiOnly, hosted.body.agent_id), [], "no run started on the API-only server");
  assert.deepEqual(await apiOnly.store.triggers.list(hosted.body.agent_id), [], "and it holds no trigger");
});

test("an API-only dry run plans each trigger as skipped, in the words its apply says them", { timeout: 60_000 }, async (t) => {
  const server = await deployServer(t, { apiOnly: true });
  const planned = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" }, dry_run: true } });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.deepEqual(planned.body.plan.triggers.map((one) => [one.name, one.kind, one.action, one.reason]), [
    ["morning", "schedule", "skip", notMade("morning", "schedule")],
    ["lead-form", "webhook", "skip", notMade("lead-form", "webhook")],
    ["new-mail", "email", "skip", notMade("new-mail", "email")],
  ]);
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const said = skippedOf(applied.body).map(([field, , message]) => [planned.body.plan.triggers[Number(field.split(".")[1])].name, message]);
  assert.deepEqual(said, planned.body.plan.triggers.map((one) => [one.name, one.reason]), "the plan and the apply skip the same triggers, in the same words");
});

test("an API-only server unarchives an agent it archived, so an archive sent by mistake is undone", { timeout: 60_000 }, async (t) => {
  const server = await deployServer(t, { apiOnly: true });
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  assert.equal((await send(server, "POST", `/v2/agents/${agent}/archive`)).status, 200);
  const back = await send(server, "POST", `/v2/agents/${agent}/unarchive`);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal((await server.store.agents.get(agent)).archivedAt, null, "not archived");
  assert.deepEqual(back.body.triggers_off, [], JSON.stringify(back.body));
});

test("off by default: the whole server's unarchive turns none of its triggers on, and names each one its archive turned off, as before", { timeout: 60_000 }, async (t) => {
  const server = await deployServer(t, {}, NO_MAIL);
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  assert.equal((await send(server, "POST", `/v2/agents/${agent}/archive`)).status, 200);
  const back = await send(server, "POST", `/v2/agents/${agent}/unarchive`);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(back.body.triggers_off.map((one) => one.name).sort(), ["lead-form", "morning"], JSON.stringify(back.body));
  assert.deepEqual((await server.store.triggers.list(agent)).map((row) => row.enabled), [false, false], "both stay off");
});

test("an API-only server reads an agent its inline runs made", { timeout: 60_000 }, async (t) => {
  const server = await deployServer(t, { apiOnly: true });
  const inline = await send(server, "POST", "/v2/runs", { body: { external: { source: "backend", kind: "expert", id: "read-1", version: 1 }, definition: { name: "Expert 1", instructions: "Answer.", skills: [], tools: [] }, input: { content: "Hi" } } });
  assert.equal(inline.status, 202, JSON.stringify(inline.body));
  const read = await send(server, "GET", `/v2/agents/${inline.body.agent_id}`);
  assert.deepEqual([read.status, read.body.agent_id, read.body.definition?.name], [200, inline.body.agent_id, "Expert 1"], JSON.stringify(read.body));
  assert.equal((await send(server, "GET", "/v2/agents/agent_missing")).status, 404, "an agent it does not have is the route's own 404");
  assert.notEqual((await send(server, "GET", "/v2/agents/agent_missing")).body.error?.message?.includes("AGENTRUN_API_ONLY"), true, "not the profile's");
});

test("off by default: the whole server's apply makes the webhook trigger too, and refuses the email trigger with no email account, as before", { timeout: 60_000 }, async (t) => {
  const server = await deployServer(t, {}, NO_MAIL);
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.triggers.map((one) => [one.name, one.kind]), [["morning", "schedule"], ["lead-form", "webhook"]]);
  assert.ok(!JSON.stringify(applied.body.warnings).includes("AGENTRUN_API_ONLY"), JSON.stringify(applied.body.warnings));

  const whole = await deployServer(t, {});
  const refused = await send(whole, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.deepEqual([refused.status, refused.body.error?.fields?.map((one) => one.field)], [422, ["triggers.2.source.account"]], JSON.stringify(refused.body));
});

test("the profile's apply makes no trigger of any source, one added later included", () => {
  for (const kind of [...SOURCE_KINDS, "a-source-added-later"]) assert.equal(apiOnlyTriggerSkipped("pkg", { name: "one", source: { kind } }), `The pkg template's trigger one (${kind}) was not made: this server serves the run API only (AGENTRUN_API_ONLY=1), so a run starts here through the API alone, never on a trigger. Start its runs through the API instead.`, kind);
});
