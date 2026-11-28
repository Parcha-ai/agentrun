// A scoped request's triggers (workspace-scope.ts, api-only.ts WORKSPACE_ROUTES): an API-only server's backend lists,
// reads, makes, edits, deletes and fires the triggers of its own workspace's agents. Another workspace's trigger answers
// the same 404 as a missing one, its lists hold its own triggers alone, and a new trigger naming another workspace's
// agent is refused in the words a missing agent gets. It makes a schedule, a feed or a webhook that starts runs, with the
// launch hook, so every firing (on its clock, fired now, or a signed request to its hook) goes to the backend, never a run
// here. A webhook's signing secret is in its make's first answer and its rotation's alone: the backend in front of this
// server shows it to the workspace's admin and keeps none.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { serve, storeBytes } from "./support.mjs";
import { fakeClock, hookServer, until } from "./trigger-support.mjs";

const { mintSecret, signatureOf } = await import("../dist/standard-webhooks.js");
const { openapiDocument } = await import("../dist/openapi.js");

const SCOPED = randomBytes(24).toString("hex");
const W1 = "org:acme.one_1";
const W2 = "org:other-2";

/** An API-only server with no runner and the scoped token alone; with the launch hook at `hook` when it is given. */
const scopedServer = (t, { hook, clock } = {}) =>
  serve(t, { runner: false, apiOnly: true, tokens: [{ id: "v2", token: SCOPED }], workspaceTokens: ["v2"], ...(hook ? { launchHook: { url: hook.url, secret: mintSecret() } } : {}), ...(clock ? { triggerClock: clock } : {}) });

async function send(server, method, path, workspace, { body, headers = {} } = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${SCOPED}`, "agentrun-workspace": workspace, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, body: json };
}

/** An answer's text with its request id and `id` in placeholders: two answers that differ only in those are equal. */
const shape = (answer, id) => `${answer.status} ${answer.text.replaceAll(/req_[0-9a-f]{16}/g, "<request>").replaceAll(id, "<id>")}`;
const missingLike = (id) => `${id.slice(0, -6)}ffffff`;

async function agentIn(server, workspace) {
  const made = await send(server, "POST", "/v2/agents", workspace, { body: { definition: { version: 1, name: `${workspace} agent`, instructions: "Answer.", skills: [], tools: [] } } });
  assert.equal(made.status, 201, made.text);
  return made.body.agent_id;
}

const schedule = (agent, extra = {}) => ({ name: "hourly", source: { kind: "schedule", every_s: 3600 }, target: { kind: "start_run", agent_id: agent, input: { content: "Answer." }, max_cost_usd: 1 }, ...extra });
const webhook = (agent) => ({ name: "inbound", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: agent, input: { content: "A lead arrived." }, max_cost_usd: 1 } });

/** A Standard Webhooks request to trigger `id`'s hook on `server`, with no token, its id `event`, signed with `secret`:
 *  its status. */
async function hookPost(server, id, secret, event) {
  const at = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ event });
  const res = await fetch(`${server.url}/v2/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": event, "webhook-timestamp": at, "webhook-signature": signatureOf(secret, event, at, body) }, body });
  await res.text();
  return res.status;
}

/** What the server keeps on disk: its store's files and the idempotency file, where one is written. */
const kept = (server) => [join(server.data, ".idempotency.json")].filter((file) => existsSync(file)).map((file) => readFileSync(file, "utf8")).join("") + storeBytes(server.data).toString("latin1");

test("a scoped request makes, reads, lists, fires and deletes its own agent's schedule; another workspace's trigger reads as a missing one to the byte, and its agent as a missing agent", { timeout: 120_000 }, async (t) => {
  const hook = await hookServer(t);
  const server = await scopedServer(t, { hook, clock: fakeClock("2026-06-01T08:00:00Z") });
  const agent = await agentIn(server, W1);
  await agentIn(server, W2);

  const made = await send(server, "POST", "/v2/triggers", W1, { body: schedule(agent) });
  assert.equal(made.status, 201, made.text);
  const id = made.body.id;
  assert.equal((await send(server, "GET", `/v2/triggers/${id}`, W1)).status, 200);
  assert.deepEqual((await send(server, "GET", "/v2/triggers", W1)).body.triggers.map((one) => one.id), [id], "W1 lists its trigger");
  assert.deepEqual((await send(server, "GET", "/v2/triggers", W2)).body.triggers, [], "W2's list holds none of W1's");

  const ops = [
    ["GET", "/v2/triggers/{id}", {}],
    ["GET", "/v2/triggers/{id}/firings", {}],
    ["PATCH", "/v2/triggers/{id}", { body: { enabled: false } }],
    ["POST", "/v2/triggers/{id}/fire", { headers: { "idempotency-key": "fire-1" } }],
    ["DELETE", "/v2/triggers/{id}", {}],
  ];
  for (const [method, path, options] of ops) {
    const theirs = await send(server, method, path.replace("{id}", id), W2, options);
    const missing = await send(server, method, path.replace("{id}", missingLike(id)), W2, options);
    assert.equal(theirs.status, 404, `${method} ${path}: ${theirs.text}`);
    assert.equal(shape(theirs, id), shape(missing, missingLike(id)), `${method} ${path}: W1's trigger reads as a missing one`);
  }
  assert.equal((await send(server, "GET", `/v2/triggers/${id}`, W1)).body.enabled, true, "no W2 call touched it");
  assert.deepEqual(hook.got, [], "and none fired it");

  const theirs = await send(server, "POST", "/v2/triggers", W2, { body: schedule(agent) });
  const unknown = await send(server, "POST", "/v2/triggers", W2, { body: schedule(missingLike(agent)) });
  assert.equal(theirs.status, 422, theirs.text);
  assert.equal(shape(theirs, agent), shape(unknown, missingLike(agent)), "W1's agent reads as a missing agent");

  // Fired now: the firing goes to the backend through the launch hook, as one on its clock does.
  const fired = await send(server, "POST", `/v2/triggers/${id}/fire`, W1, { headers: { "idempotency-key": "fire-1" } });
  assert.equal(fired.status, 202, fired.text);
  const [{ sent }] = await until(() => hook.got.length && hook.got, 20_000, "the firing never reached the backend");
  assert.deepEqual([sent.agent_id, sent.trigger_id], [agent, id]);
  assert.equal((await send(server, "GET", `/v2/triggers/${id}/firings`, W1)).body.firings.length, 1);

  assert.equal((await send(server, "DELETE", `/v2/triggers/${id}`, W1)).status, 204);
  assert.equal((await send(server, "GET", `/v2/triggers/${id}`, W1)).status, 404);
});

test("a scoped request on an API-only server makes a schedule, a feed or a webhook that starts runs, with the launch hook: any other source or target, or no hook, is 422 and nothing is made", { timeout: 120_000 }, async (t) => {
  const hook = await hookServer(t);
  const server = await scopedServer(t, { hook });
  const agent = await agentIn(server, W1);
  const target = { kind: "start_run", agent_id: agent, input: { content: "Answer." }, max_cost_usd: 1 };
  for (const source of [{ kind: "github", repo: "acme/app", events: ["push"] }, { kind: "composio", trigger: "GITHUB_COMMIT_EVENT" }, { kind: "email" }]) {
    const answer = await send(server, "POST", "/v2/triggers", W1, { body: { name: "refused", source, target } });
    assert.equal(answer.status, 422, `${source.kind}: ${answer.text}`);
    assert.deepEqual(answer.body.error.fields.map((one) => [one.field, one.reason]), [["source.kind", "not_an_option"]], `${source.kind}: ${answer.text}`);
  }
  const messaged = await send(server, "POST", "/v2/triggers", W1, { body: { name: "refused", source: { kind: "schedule", every_s: 3600 }, target: { kind: "message_run", run_id: "run_none", content: "More." } } });
  assert.equal(messaged.status, 422, messaged.text);
  assert.ok(messaged.body.error.fields.some((one) => one.field === "target.kind" && one.reason === "not_an_option"), messaged.text);
  assert.deepEqual((await server.store.triggers.all()).length, 0, "nothing was made");

  const unhooked = await scopedServer(t);
  const own = await agentIn(unhooked, W1);
  for (const body of [schedule(own), webhook(own)]) {
    const answer = await send(unhooked, "POST", "/v2/triggers", W1, { body });
    assert.equal(answer.status, 422, answer.text);
    assert.deepEqual(answer.body.error.fields.map((one) => [one.field, one.reason]), [["source.kind", "not_set_up_here"]], body.source.kind);
  }
  assert.deepEqual((await unhooked.store.triggers.all()).length, 0, "nothing was made");
  // A schedule the agent had before the profile is not fired now without the hook: its firing would start a run here.
  await unhooked.store.triggers.create({ id: "trg_000000000000000000000001", agentId: own, name: "old", enabled: false, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: own, input: { content: "Answer." } }, nextAt: null, catchupWindowS: 0 });
  const fired = await send(unhooked, "POST", "/v2/triggers/trg_000000000000000000000001/fire", W1, { headers: { "idempotency-key": "fire-1" } });
  assert.equal(fired.status, 422, fired.text);
  assert.deepEqual(fired.body.error.fields.map((one) => [one.field, one.reason]), [["id", "not_an_option"]]);
});

test("a scoped request makes its own agent's webhook trigger and is shown its signing secret in that first answer alone: a replay under the same Idempotency-Key, a read and a list show none, and nothing this server keeps holds it", { timeout: 120_000 }, async (t) => {
  const hook = await hookServer(t);
  const server = await scopedServer(t, { hook });
  const agent = await agentIn(server, W1);

  const made = await send(server, "POST", "/v2/triggers", W1, { body: webhook(agent), headers: { "idempotency-key": "make-1" } });
  assert.equal(made.status, 201, made.text);
  const { id, signing_secret: secret } = made.body;
  assert.match(secret, /^whsec_/, made.text);
  assert.deepEqual([made.body.secret.name, made.body.secret.set], [`trigger:${id}`, true]);
  assert.equal(made.body.note, undefined, "no words sending anyone to a console");

  const replayed = await send(server, "POST", "/v2/triggers", W1, { body: webhook(agent), headers: { "idempotency-key": "make-1" } });
  assert.deepEqual([replayed.status, replayed.body.id], [201, id], replayed.text);
  assert.ok(!("signing_secret" in replayed.body), replayed.text);
  assert.ok(!replayed.text.includes("whsec_"), "a replay shows no secret");
  for (const read of [await send(server, "GET", `/v2/triggers/${id}`, W1), await send(server, "GET", "/v2/triggers", W1), await send(server, "PATCH", `/v2/triggers/${id}`, W1, { body: { enabled: true } })]) {
    assert.equal(read.status, 200, read.text);
    assert.ok(!read.text.includes("whsec_"), read.text);
  }
  assert.ok(!kept(server).includes(secret.slice("whsec_".length)), "the store and the key's record hold no secret");

  // The secret shown is the one its hook checks: the firing goes to the backend.
  assert.equal(await hookPost(server, id, secret, "evt-1"), 202);
  const [{ sent }] = await until(() => hook.got.length && hook.got, 20_000, "the webhook's firing never reached the backend");
  assert.deepEqual([sent.agent_id, sent.trigger_id], [agent, id]);
});

test("a scoped request rotates its own webhook trigger's secret and is shown the new one: a request signed with the old secret is refused, one signed with the new is taken; another workspace's rotation is the 404 a missing trigger's is, to the byte", { timeout: 120_000 }, async (t) => {
  const hook = await hookServer(t);
  const server = await scopedServer(t, { hook });
  const agent = await agentIn(server, W1);
  const made = await send(server, "POST", "/v2/triggers", W1, { body: webhook(agent) });
  assert.equal(made.status, 201, made.text);
  const { id, signing_secret: old } = made.body;

  // Another workspace's rotation reads as a missing trigger's, and rotates nothing.
  const theirs = await send(server, "POST", `/v2/triggers/${id}/secret`, W2);
  const missing = await send(server, "POST", `/v2/triggers/${missingLike(id)}/secret`, W2);
  assert.equal(theirs.status, 404, theirs.text);
  assert.equal(shape(theirs, id), shape(missing, missingLike(id)), "W1's trigger reads as a missing one");
  assert.equal(await hookPost(server, id, old, "evt-0"), 202, "the old secret still signs");

  const rotated = await send(server, "POST", `/v2/triggers/${id}/secret`, W1);
  assert.equal(rotated.status, 200, rotated.text);
  assert.match(rotated.body.signing_secret, /^whsec_/, rotated.text);
  assert.notEqual(rotated.body.signing_secret, old);
  assert.deepEqual([rotated.body.secret.name, rotated.body.secret.set], [`trigger:${id}`, true]);
  assert.equal(await hookPost(server, id, old, "evt-1"), 401, "the old secret signs nothing now");
  assert.equal(await hookPost(server, id, rotated.body.signing_secret, "evt-2"), 202, "the new one signs");
  assert.ok(!kept(server).includes(rotated.body.signing_secret.slice("whsec_".length)), "nothing kept holds the new secret");
  assert.ok(!(await send(server, "GET", `/v2/triggers/${id}`, W1)).text.includes("whsec_"));

  // A rotation takes no body, as it does from the owner's session.
  const bodied = await send(server, "POST", `/v2/triggers/${id}/secret`, W1, { body: {} });
  assert.equal(bodied.status, 422, bodied.text);
});

test("the API description says a rotation is served to the scoped server token too: its security names the token beside the owner's session", () => {
  const rotate = openapiDocument(() => undefined).paths["/triggers/{trigger_id}/secret"].post;
  assert.deepEqual(rotate.security, [{ ownerSession: [] }, { bearer: [] }]);
  assert.match(rotate.description, /AgentRun-Workspace/);
});
