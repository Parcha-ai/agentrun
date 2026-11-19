// Which triggered runs are handed their trigger's last completed result after their message (trigger-targets.ts
// previousResultOf): only a schedule's, whose runs repeat one job, so a weekly digest leaves out what it reported. Every
// other source's firings are different events (alice's issue, then bob's; alice's mail, then bob's): one run's answer is
// never handed to the next, where bob's run could read, and a draft reply quote, what the agent answered about alice's.
// The email and feed sources' own tests hold theirs (email-trigger.test.mjs); this one, the pushed sources and the schedule.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { launchText } from "./email-support.mjs";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { connect, connectable, deliver as deliverGitHub, PUBLIC } from "./github-support.mjs";
import { asOwner, follow, secretWritePath } from "./support.mjs";
import { firings, made, schedule } from "./trigger-support.mjs";

const { Webhook } = createRequire(import.meta.url)("standardwebhooks");

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const SCHEMA = { type: "object", additionalProperties: false, required: ["triage"], properties: { triage: { type: "string" } } };
const ANSWER = { triage: "Issue #7 from alice: her refund of $120 is a duplicate of #3." };
const PREVIOUS = "The result of this trigger's last completed run";
/** The route of the project's Composio subscription here, from its webhook_url. */
const HOOK = new RegExp(`^${PUBLIC.replace(/\./g, "\\.")}/v2/hooks/composio/(cph_[0-9a-f]{24})$`);

/** A Composio delivery for instance `instance`, signed as Composio signs (Standard Webhooks headers, keyed by the secret's UTF-8). */
async function deliverComposio(baseUrl, hook, secret, instance, data) {
  const body = JSON.stringify({ id: `msg_${randomBytes(6).toString("hex")}`, type: "composio.trigger.message", metadata: { log_id: "log_1", trigger_slug: "GITHUB_ISSUE_ADDED_EVENT", trigger_id: instance, connected_account_id: "ca_fake_github", auth_config_id: "ac_managed", user_id: "agentrun-qa" }, data, timestamp: new Date().toISOString() });
  const id = `msg_${randomBytes(8).toString("hex")}`;
  const at = Math.floor(Date.now() / 1000);
  const signature = `v1,${createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${at}.${body}`).digest("base64")}`;
  const res = await fetch(`${baseUrl}/hooks/composio/${hook}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": signature }, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A Standard Webhooks delivery to webhook trigger `id`, signed with its signing secret. */
async function deliverWebhook(baseUrl, id, secret, payload) {
  const body = JSON.stringify(payload);
  const msg = `msg_${randomBytes(8).toString("hex")}`;
  const at = new Date();
  const res = await fetch(`${baseUrl}/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": msg, "webhook-timestamp": String(Math.floor(at.getTime() / 1000)), "webhook-signature": new Webhook(secret).sign(msg, at, body) }, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("only a schedule's run is handed its trigger's last completed result: a Composio, GitHub or webhook trigger's run for bob's event is handed nothing of alice's", { timeout: 240_000 }, async (t) => {
  const composio = await startFakeComposio({ toolkits: { github: { no_auth: false, tools: [{ slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "Lists issues." }] } }, authConfigs: { github: [{ id: "ac_managed", is_composio_managed: true }] }, active: ["github"] });
  t.after(() => composio.close());
  const server = await connectable(t, { composioControl: { baseUrl: composio.baseUrl } });
  const { api } = server;
  await connect(server);
  const saved = await api("PUT", "/settings/mcp-servers/gh/composio", { api_key: composio.apiKey, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "agentrun-qa" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await made(api, "answerer", { output_schema: SCHEMA });
  const target = { kind: "start_run", agent_id: "answerer", input: { content: `Answer with this json: ${JSON.stringify(ANSWER)}` }, max_cost_usd: 0.5 };
  // As the owner's signed-in session, the one shown a webhook trigger's signing secret.
  const owner = asOwner(server);
  const create = async (body) => {
    const res = await owner("POST", "/triggers", { ...body, target });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  /** Run `runId`'s message as it was given it (its launch). */
  const messageOf = (runId) => JSON.parse(launchText(server.data, runId)).input.content;
  /** The run trigger `id`'s `n`th firing started (none of `before`'s). */
  const startedBy = async (id, n, before) => {
    const run = (await firings(api, id, n)).find((f) => f.run_id && f.run_id !== before)?.run_id;
    assert.ok(run, `trigger ${id}'s firing ${n} started a run`);
    return run;
  };
  /** Fires a trigger for alice's event, then, once alice's run has completed with its structured answer, for bob's:
   *  what bob's run was handed, its message read as it was given it. */
  const twice = async (source, fire) => {
    const alice = await fire("alice", 7, undefined);
    await follow(api, alice, ["completed"]);
    assert.deepEqual((await api("GET", `/runs/${alice}`)).body.result.output, ANSWER, `${source}: alice's run has a structured answer`);
    const bob = await fire("bob", 8, alice);
    const message = messageOf(bob);
    await follow(api, bob, ["completed"]);
    return { block: message.includes(PREVIOUS), answer: message.includes(JSON.stringify(ANSWER, null, 2)), message };
  };

  // A schedule's runs repeat one job: its second run is handed what its first answered.
  const weekly = await create(schedule("answerer", { cron: "0 9 * * 1", timezone: "UTC" }, { enabled: false, name: "weekly" }));
  const scheduled = await twice("schedule", async (who) => {
    const fired = await api("POST", `/triggers/${weekly.id}/fire`, undefined, { "idempotency-key": `week-${who}` });
    assert.equal(fired.status, 202, JSON.stringify(fired.body));
    return fired.body.run_id;
  });

  // Composio: an event of the trigger's instance, one issue each.
  const issues = await create({ name: "composio issues", source: { kind: "composio", server: "gh", event: "GITHUB_ISSUE_ADDED_EVENT", config: { owner: "acme", repo: "widgets" } } });
  const hook = HOOK.exec(composio.subscriptions[0]?.webhook_url ?? "")?.[1];
  const composioSecret = composio.subscriptions[0].secret;
  const viaComposio = await twice("composio", async (who, number, before) => {
    const fired = await deliverComposio(server.baseUrl, hook, composioSecret, issues.source.instance_id, { title: `Refund for ${who}`, number, user: who });
    assert.equal(fired.status, 202, JSON.stringify(fired.body));
    return startedBy(issues.id, before ? 2 : 1, before);
  });

  // GitHub: an issue opened on the App's repository, one issue each.
  const opened = await create({ name: "github issues", source: { kind: "github", accept: [{ event: "issues", actions: ["opened"] }] } });
  const viaGitHub = await twice("github", async (who, number, before) => {
    const payload = { action: "opened", issue: { number, title: `Refund for ${who}`, user: { login: who } }, repository: { full_name: "acme/widgets" }, installation: { id: 777 }, sender: { login: who } };
    const fired = await deliverGitHub(server.baseUrl, server.github.app.webhook_secret, "issues", payload);
    assert.equal(fired.status, 202, JSON.stringify(fired.body));
    return startedBy(opened.id, before ? 2 : 1, before);
  });

  // A webhook: a signed request, one form submission each.
  const form = await create({ name: "form", source: { kind: "webhook" } });
  const viaWebhook = await twice("webhook", async (who, number, before) => {
    const fired = await deliverWebhook(server.baseUrl, form.id, form.signing_secret, { event: "form.submitted", data: { from: `${who}@example.com`, number } });
    assert.equal(fired.status, 202, JSON.stringify(fired.body));
    return startedBy(form.id, before ? 2 : 1, before);
  });

  const all = { schedule: scheduled, composio: viaComposio, github: viaGitHub, webhook: viaWebhook };
  const blocks = Object.fromEntries(Object.entries(all).map(([source, second]) => [source, second.block]));
  assert.deepEqual(blocks, { schedule: true, composio: false, github: false, webhook: false }, `only a schedule's second run is handed a "${PREVIOUS}" block`);
  const answers = Object.fromEntries(Object.entries(all).map(([source, second]) => [source, second.answer]));
  assert.deepEqual(answers, { schedule: true, composio: false, github: false, webhook: false }, "only a schedule's second run is handed its first's answer");
});
