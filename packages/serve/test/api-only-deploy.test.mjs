// The API-only profile's deploy routes (api-only.ts): a backend that deploys agents to the server behind it applies a
// template, reads the agent and its revisions, moves its current revision back, and archives then deletes the agent, all
// with the server's token. Without the launch hook the apply makes no trigger of any kind: each is skipped and said (a
// schedule too, which would start runs on the server's own clock and model key, outside the backend's), and its dry run
// plans each as skipped, in the same words. With the hook it makes the schedule and feed triggers, since each firing goes
// to the backend, which starts the run through the API on its own keys and budget; their unarchive turns them on again,
// as no trigger route is served to. A webhook, GitHub, Composio or email trigger is never made here. Making a trigger,
// reading or changing one, the hooks and the settings stay refused. Off by default: the whole server's apply makes every
// trigger, as before.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { feed, posts } from "./feed-support.mjs";
import { follow, scratch, serve, withEnv } from "./support.mjs";
import { fakeClock, hookServer, until } from "./trigger-support.mjs";

const { apiOnlyTriggerSkipped } = await import("../dist/api-only.js");
const { NOT_SET_UP } = await import("../dist/runnable.js");
const { openapiDocument } = await import("../dist/openapi.js");
const { mintSecret, verify } = await import("../dist/standard-webhooks.js");
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
/** A schedule's or a feed's skip on a server with no launch hook, which would make it. */
const needsHook = (name, kind, pkg = "deployed") => `The ${pkg} template's trigger ${name} (${kind}) was not made: this server serves the run API only (AGENTRUN_API_ONLY=1) and has no launch hook, so its firings have nowhere to go. Start its runs through the API, or set the launch hook (AGENTRUN_LAUNCH_HOOK_URL and AGENTRUN_LAUNCH_HOOK_SECRET) and apply again: each firing then goes to your backend, which starts its run.`;
/** Any other source's skip, hook or not. */
const notHere = (name, kind, pkg = "deployed") => `The ${pkg} template's trigger ${name} (${kind}) was not made: this server serves the run API only (AGENTRUN_API_ONLY=1), which serves no route or setting a ${kind} trigger needs. Start its runs through the API instead.`;
const SKIPPED = [
  ["triggers.0", "not_set_up_here", needsHook("morning", "schedule")],
  ["triggers.1", "not_an_option", notHere("lead-form", "webhook")],
  ["triggers.2", "not_an_option", notHere("new-mail", "email")],
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

test("an API-only server purges one ended run of an agent its deploy made, with the token, as it may purge the whole agent: the agent kept", { timeout: 120_000 }, async (t) => {
  const server = await deployServer(t, { apiOnly: true, runner: true });
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  const started = await send(server, "POST", `/v2/agents/${agent}/runs`, { body: { input: { content: "Today's note." } } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const run = started.body.run_id;
  await follow(server.api, run, ["completed"]);

  const deleted = await send(server, "DELETE", `/v2/runs/${run}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  const read = await send(server, "GET", `/v2/runs/${run}`);
  assert.deepEqual([read.status, read.body.error?.code, read.body.error?.details?.run_id], [410, "purged", run], JSON.stringify(read.body));
  assert.deepEqual(await runsOf(server, agent), [], "no run of the agent is listed");
  const kept = await send(server, "GET", `/v2/agents/${agent}`);
  assert.deepEqual([kept.status, kept.body.agent_id], [200, agent], "the agent is kept");
  assert.equal((await server.store.agents.get(agent)).archivedAt, null, "and not archived");
});

test("on an API-only server a template's schedule is never armed on the triggers' own clock, so its time passing starts no run; the whole server arms it", { timeout: 60_000 }, async (t) => {
  const apiOnlyClock = fakeClock("2026-06-01T08:00:00Z");
  const wholeClock = fakeClock("2026-06-01T08:00:00Z");
  const apiOnly = await deployServer(t, { apiOnly: true, triggerClock: apiOnlyClock }, NO_MAIL);
  const whole = await deployServer(t, { triggerClock: wholeClock }, NO_MAIL);
  const hosted = await send(apiOnly, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(hosted.status, 201, JSON.stringify(hosted.body));
  assert.deepEqual(hosted.body.triggers, [], JSON.stringify(hosted.body.triggers));
  assert.deepEqual(skippedOf(hosted.body).map(([field, reason]) => [field, reason]), [["triggers.0", NOT_SET_UP], ["triggers.1", "not_an_option"]], "the schedule and the webhook both said");
  const own = await send(whole, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(own.status, 201, JSON.stringify(own.body));

  // The whole server's schedule is armed for its 09:00; a due schedule's run is the trigger tests' (on the same clock).
  await until(() => wholeClock.timer?.at === Date.parse("2026-06-01T09:00:00Z"), 20_000, "the whole server never armed its schedule for 09:00");
  // The API-only server holds no trigger, so its clock holds nothing to fire, and passing 09:00 fires nothing.
  assert.deepEqual(await apiOnly.store.triggers.list(hosted.body.agent_id), [], "it holds no trigger");
  assert.equal(apiOnlyClock.timer, null, "nothing armed on its clock");
  apiOnlyClock.to("2026-06-01T09:00:00Z");
  assert.deepEqual(await runsOf(apiOnly, hosted.body.agent_id), [], "no run started on the API-only server");
});

test("an API-only dry run plans each trigger as skipped, in the words its apply says them", { timeout: 60_000 }, async (t) => {
  const server = await deployServer(t, { apiOnly: true });
  const planned = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" }, dry_run: true } });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.deepEqual(planned.body.plan.triggers.map((one) => [one.name, one.kind, one.action, one.reason]), [
    ["morning", "schedule", "skip", needsHook("morning", "schedule")],
    ["lead-form", "webhook", "skip", notHere("lead-form", "webhook")],
    ["new-mail", "email", "skip", notHere("new-mail", "email")],
  ]);
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const said = skippedOf(applied.body).map(([field, , message]) => [planned.body.plan.triggers[Number(field.split(".")[1])].name, message]);
  assert.deepEqual(said, planned.body.plan.triggers.map((one) => [one.name, one.reason]), "the plan and the apply skip the same triggers, in the same words");
});

/** A package with a schedule and a feed whose feeds are a parameter, empty by default. */
const FEEDS = `---
name: deployed
version: 1.0.0
description: Reads the vendors' status feeds, and writes a note every morning.
budget: { per_run_usd: 0.5 }
tools: []
parameters:
  status_feeds: { type: array, items: { type: string }, required: false, default: [], description: "each vendor's status feed" }
triggers:
  - name: morning
    source: { kind: schedule, cron: "0 9 * * *", timezone: UTC }
    target: { kind: start_run, input: { content: "Today's note." } }
  - name: status
    source: { kind: feed, urls: "\${parameters.status_feeds}", every_s: 14400 }
    target: { kind: start_run, input: { content: "A vendor posted." } }
---
Read the vendors' status.
`;

test("an API-only redeploy leaves each trigger of the package the agent has already, a feed left empty included, and its dry run plans none removed", { timeout: 60_000 }, async (t) => {
  const server = await deployServer(t, { apiOnly: true }, FEEDS);
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  // Triggers of the package this agent has from before (made while the server was the whole server), off.
  const own = (id, name, source) => ({ id, agentId: agent, name, enabled: false, source, target: { kind: "start_run", agent_id: agent, input: { content: "Answer." } }, nextAt: null, catchupWindowS: 0, templateId: applied.body.template });
  await server.store.triggers.create(own("trg_morning", "morning", { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" }));
  await server.store.triggers.create(own("trg_status", "status", { kind: "feed", urls: ["https://status.example.com/feed.xml"], every_s: 14400 }));

  const planned = await send(server, "POST", "/v2/templates/deployed/apply", { body: { agent_id: agent, dry_run: true } });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.deepEqual(planned.body.plan.triggers.map((one) => [one.name, one.action]), [["morning", "skip"], ["status", "skip"]], "both skipped, neither removed");
  const redeployed = await send(server, "POST", "/v2/templates/deployed/apply", { body: { agent_id: agent } });
  assert.equal(redeployed.status, 200, JSON.stringify(redeployed.body));
  assert.deepEqual(skippedOf(redeployed.body).map(([field, reason]) => [field, reason]), [["triggers.0", "not_set_up_here"], ["triggers.1", "not_set_up_here"]], "each said once, as this profile's skip for want of the hook");
  assert.deepEqual((await server.store.triggers.list(agent)).map((row) => [row.id, row.enabled, row.source.urls ?? null]).sort(), [["trg_morning", false, null], ["trg_status", false, ["https://status.example.com/feed.xml"]]], "both left as they were");
});

test("an API-only redeploy that skips a trigger the agent has on says it is kept and still fires, and that the agent's archive turns it off", { timeout: 60_000 }, async (t) => {
  const server = await deployServer(t, { apiOnly: true });
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  await server.store.triggers.create({ id: "trg_morning", agentId: agent, name: "morning", enabled: true, source: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" }, target: { kind: "start_run", agent_id: agent, input: { content: "Answer." } }, nextAt: null, catchupWindowS: 0, templateId: applied.body.template });
  const redeployed = await send(server, "POST", "/v2/templates/deployed/apply", { body: { agent_id: agent, parameters: { topic: "tides" } } });
  assert.equal(redeployed.status, 200, JSON.stringify(redeployed.body));
  const [[field, , words]] = skippedOf(redeployed.body);
  assert.deepEqual([field, words], ["triggers.0", `${needsHook("morning", "schedule")} The agent's trigger trg_morning of that name is kept as it was, and still fires: archiving the agent turns it off.`]);
  assert.deepEqual((await server.store.triggers.list(agent)).map((row) => [row.id, row.enabled]), [["trg_morning", true]], "left as it was");
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
  assert.deepEqual(await server.store.triggers.list(agent), [], "the unarchive turns no trigger on, since none was made");
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

test("the profile's apply makes a schedule and a feed with the launch hook alone, and no other source, hook or not, one added later included", () => {
  // Each kind's reason, without the hook and with it (undefined: made). The words are SKIPPED's, through an apply.
  const reasons = (kind) => [false, true].map((hooked) => apiOnlyTriggerSkipped("pkg", { name: "one", source: { kind } }, hooked)?.reason);
  for (const kind of [...SOURCE_KINDS, "a-source-added-later"]) {
    assert.deepEqual(reasons(kind), kind === "schedule" || kind === "feed" ? [NOT_SET_UP, undefined] : ["not_an_option", "not_an_option"], kind);
  }
});

test("the apply's API description names the reason each API-only skip gives: a schedule's without the hook, and a webhook's", () => {
  const { description } = openapiDocument(() => undefined).paths["/templates/{template}/apply"].post;
  const unhooked = apiOnlyTriggerSkipped("pkg", { name: "one", source: { kind: "schedule" } }, false);
  const never = apiOnlyTriggerSkipped("pkg", { name: "one", source: { kind: "webhook" } }, true);
  const said = (reason) => `(reason \`${reason}\`)`;
  assert.ok(description.includes(`else a warning under \`triggers.<i>\` ${said(unhooked.reason)}`), `a schedule skipped for want of the hook: ${unhooked.reason}`);
  assert.ok(description.includes(`is never made there ${said(never.reason)}`), `a webhook, never made here: ${never.reason}`);
});

test("an API-only server with the launch hook makes the template's schedule, and its firing goes to the backend, which starts the run through the API; the webhook and email stay skipped", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T08:00:00Z");
  const secret = mintSecret();
  const hook = await hookServer(t);
  const server = await deployServer(t, { apiOnly: true, triggerClock: clock, launchHook: { url: hook.url, secret } });

  const planned = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" }, dry_run: true } });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.deepEqual(planned.body.plan.triggers.map((one) => [one.name, one.action, one.reason ?? null]), [
    ["morning", "create", null],
    ["lead-form", "skip", notHere("lead-form", "webhook")],
    ["new-mail", "skip", notHere("new-mail", "email")],
  ]);
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  assert.deepEqual(applied.body.triggers.map((one) => [one.name, one.kind]), [["morning", "schedule"]], "the schedule is made");
  assert.deepEqual(skippedOf(applied.body), SKIPPED.slice(1), "the webhook and email are skipped, and said");
  const [made] = await server.store.triggers.list(agent);
  assert.deepEqual([made.name, made.enabled], ["morning", true]);

  clock.to("2026-06-01T09:00:00Z");
  const [{ headers, body, sent }] = await until(() => hook.got.length && hook.got, 20_000, "the schedule's firing never reached the backend");
  assert.equal(verify(secret, headers, body, clock.now()), undefined, "signed with the hook's secret, stamped on the triggers' clock");
  assert.deepEqual([sent.agent_id, sent.trigger_id, sent.fired_at], [agent, made.id, "2026-06-01T09:00:00Z"]);
  assert.match(sent.input.content, /^Today's note on tides\./);
  await until(async () => (await server.store.triggers.firing(made.id, sent.firing_id))?.status === "sent", 20_000, "the firing was never recorded sent");
  assert.deepEqual(await runsOf(server, agent), [], "no run started here on the server's own model key");

  // The backend starts the run on its own budget, after its answer.
  const started = await send(server, "POST", `/v2/agents/${agent}/runs`, { body: { input: sent.input, max_cost_usd: 0.5, trigger_firing: { trigger_id: sent.trigger_id, firing_id: sent.firing_id } } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runs = await runsOf(server, agent);
  assert.deepEqual(runs.map((run) => run.run_id ?? run.id), [started.body.run_id], "the backend's one run");
  const firing = await server.store.triggers.firing(made.id, sent.firing_id);
  assert.deepEqual([firing.status, firing.runId], ["started", started.body.run_id]);
});

test("an API-only server with the launch hook makes a feed whose urls are given; one left empty is skipped for want of a feed, as on the whole server", { timeout: 60_000 }, async (t) => {
  const blog = await feed(t, { format: "rss", title: "Posts", items: posts(1) });
  const server = await deployServer(t, { apiOnly: true, launchHook: { url: (await hookServer(t)).url, secret: mintSecret() }, feedsAt: () => blog.url }, FEEDS);
  const given = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { status_feeds: ["https://status.example.com/feed.xml"] } } });
  assert.equal(given.status, 201, JSON.stringify(given.body));
  assert.deepEqual(given.body.triggers.map((one) => [one.name, one.kind]).sort(), [["morning", "schedule"], ["status", "feed"]]);
  assert.deepEqual(skippedOf(given.body), [], "none skipped");
  const empty = await send(server, "POST", "/v2/templates/deployed/apply", { body: {} });
  assert.equal(empty.status, 201, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.triggers.map((one) => one.name), ["morning"]);
  assert.deepEqual(skippedOf(empty.body).map(([field, reason, message]) => [field, reason, /no feed|status_feeds/.test(message)]), [["triggers.1", "not_set_up_here", true]], JSON.stringify(empty.body.warnings));
});

test("an API-only server with the launch hook unarchives an agent: the schedule its archive turned off is on again, as no trigger route is served to turn it on", { timeout: 60_000 }, async (t) => {
  // The triggers' own clock: no time of the schedule comes due on the wall clock while the test runs, and the one it
  // drives is settled before the test ends, so the teardown never closes the hook under a firing.
  const clock = fakeClock("2026-06-01T08:00:00Z");
  const hook = await hookServer(t);
  const server = await deployServer(t, { apiOnly: true, triggerClock: clock, launchHook: { url: hook.url, secret: mintSecret() } }, NO_MAIL);
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  const archived = await send(server, "POST", `/v2/agents/${agent}/archive`);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual((await server.store.triggers.list(agent)).map((row) => row.enabled), [false], "its schedule is off");
  const back = await send(server, "POST", `/v2/agents/${agent}/unarchive`);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(back.body.triggers_off, [], JSON.stringify(back.body));
  const [schedule] = await server.store.triggers.list(agent);
  assert.deepEqual([schedule.name, schedule.enabled, schedule.disabled ?? null, typeof schedule.nextAt], ["morning", true, null, "number"], JSON.stringify(schedule));

  // On again: its next time is handed to the backend, and the firing is settled before the test ends.
  clock.to("2026-06-01T09:00:00Z");
  const [{ sent }] = await until(() => hook.got.length && hook.got, 20_000, "the schedule's firing never reached the backend");
  await until(async () => (await server.store.triggers.firing(schedule.id, sent.firing_id))?.status === "sent", 20_000, "the firing was never recorded sent");
  assert.deepEqual([hook.got.length, sent.trigger_id, sent.fired_at], [1, schedule.id, "2026-06-01T09:00:00Z"]);
});

test("an API-only unarchive names a feed trigger that its first check turned off again: what is off is read after each turn-on, never assumed", { timeout: 60_000 }, async (t) => {
  const blog = await feed(t, { format: "rss", title: "Posts", items: posts(1) });
  const server = await deployServer(t, { apiOnly: true, launchHook: { url: (await hookServer(t)).url, secret: mintSecret() }, feedsAt: () => blog.url }, `---
name: deployed
version: 1.0.0
description: Writes a note on each new post.
budget: { per_run_usd: 0.5 }
tools: []
triggers:
  - name: posts
    source: { kind: feed, urls: ["https://blog.example/feed.xml"], every_s: 900 }
    target: { kind: start_run, input: { content: "A new post." } }
---
Write a short note on the post.
`);
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: {} });
  assert.deepEqual([applied.status, applied.body.triggers?.length], [201, 1], JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  assert.equal((await send(server, "POST", `/v2/agents/${agent}/archive`)).status, 200);
  blog.fail(410);
  const back = await send(server, "POST", `/v2/agents/${agent}/unarchive`);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const [row] = await server.store.triggers.list(agent);
  assert.deepEqual([row.enabled, row.disabled?.reason], [false, "source_unreadable"], JSON.stringify(row));
  assert.deepEqual(back.body.triggers_off, [{ id: row.id, name: "posts" }], JSON.stringify(back.body));
});

test("an API-only server without the hook turns no trigger on at an unarchive: one the agent had from before stays off and is named", { timeout: 60_000 }, async (t) => {
  const server = await deployServer(t, { apiOnly: true }, NO_MAIL);
  const applied = await send(server, "POST", "/v2/templates/deployed/apply", { body: { parameters: { topic: "tides" } } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = applied.body.agent_id;
  // A schedule the agent has from before (made while the server was the whole server).
  await server.store.triggers.create({ id: "trg_morning", agentId: agent, name: "morning", enabled: true, source: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" }, target: { kind: "start_run", agent_id: agent, input: { content: "Answer." } }, nextAt: Date.parse("2026-06-02T09:00:00Z"), catchupWindowS: 0, templateId: applied.body.template });
  assert.equal((await send(server, "POST", `/v2/agents/${agent}/archive`)).status, 200);
  const back = await send(server, "POST", `/v2/agents/${agent}/unarchive`);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(back.body.triggers_off, [{ id: "trg_morning", name: "morning" }], JSON.stringify(back.body));
  assert.deepEqual((await server.store.triggers.list(agent)).map((row) => row.enabled), [false]);
});
