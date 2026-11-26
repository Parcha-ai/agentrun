// Composio triggers set up from here (composio-triggers.ts, trigger-composio.ts): a saved Composio server lists its
// toolkit's events; a trigger of kind `composio` names that server, one event and its config, and making it makes the
// project's one webhook subscription at this server's address (reused after; one at someone else's address is refused,
// and moved only when asked), the trigger instance for the account the server is connected as, then the trigger. A
// delivery to /v2/hooks/composio/{hook}, checked once with the subscription's secret, fires each trigger whose instance
// is the delivery's metadata.trigger_id and whose filter takes it. Pause, resume and delete follow on Composio, and so does
// the server turning a trigger off itself; a user with several connected accounts is refused, never guessed at. The
// subscription's secret is sealed here and never answered, logged or put in an event.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { ComposioTriggers } from "../dist/composio-triggers.js";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { secretWritePath, serve } from "./support.mjs";
import { firings, made, until } from "./trigger-support.mjs";

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);
secretWritePath(["POST"], /^\/settings\/mcp-servers\/[^/]+\/composio\/rotate-secret$/);
secretWritePath(["DELETE"], /^\/settings\/mcp-servers\/[^/]+\/composio\/subscription$/);

const PUBLIC = "https://agentrun.example.com";
const TOOLS = [{ slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "Lists issues." }];
const OURS = new RegExp(`^${PUBLIC.replace(/\./g, "\\.")}/v2/hooks/composio/(cph_[0-9a-f]{24})$`);

/** A server with a saved GitHub Composio server `gh`, connected as agentrun-qa, and an agent `triage`. Every answer and
 *  log line is kept, for the secret's check. */
async function setup(t, { composio: given = {}, server: options = {}, connected = true, saveWith = {} } = {}) {
  const composio = await startFakeComposio({ toolkits: { github: { no_auth: false, tools: TOOLS } }, authConfigs: { github: [{ id: "ac_managed", is_composio_managed: true }] }, active: connected ? ["github"] : [], ...given });
  t.after(() => composio.close());
  const lines = [];
  const server = await serve(t, { publicUrl: PUBLIC, composioControl: { baseUrl: composio.baseUrl }, log: (line) => lines.push(line), ...options });
  const answers = [];
  const api = async (...args) => {
    const res = await server.api(...args);
    answers.push(JSON.stringify(res.body));
    return res;
  };
  const saved = await api("PUT", "/settings/mcp-servers/gh/composio", { api_key: composio.apiKey, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "agentrun-qa", ...saveWith });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await made(api, "triage");
  return { composio, server, api, lines, answers, baseUrl: server.baseUrl };
}

let count = 0;
const issueTrigger = (config = { owner: "many-drop", repo: "agentrun-scratch" }, extra = {}, sourceExtra = {}) => ({
  name: `issues ${++count}`,
  source: { kind: "composio", server: "gh", event: "GITHUB_ISSUE_ADDED_EVENT", config, ...sourceExtra },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage this issue." }, max_cost_usd: 0.5 },
  ...extra,
});

/** A delivery as Composio's V3 payload carries it, for instance `instance`. */
const delivery = (instance, data = { title: "[agent] fix the build", number: 7 }, slug = "GITHUB_ISSUE_ADDED_EVENT") =>
  JSON.stringify({ id: `msg_${randomBytes(6).toString("hex")}`, type: "composio.trigger.message", metadata: { log_id: "log_1", trigger_slug: slug, trigger_id: instance, connected_account_id: "ca_fake_github", auth_config_id: "ac_managed", user_id: "agentrun-qa" }, data, timestamp: new Date().toISOString() });

/** POST to /hooks/composio/{hook}, signed as Composio signs (Standard Webhooks headers, keyed by the secret's UTF-8). */
async function deliver(baseUrl, hook, body, secret) {
  const id = `msg_${randomBytes(8).toString("hex")}`;
  const at = Math.floor(Date.now() / 1000);
  const signature = `v1,${createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${at}.${body}`).digest("base64")}`;
  const res = await fetch(`${baseUrl}/hooks/composio/${hook}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": signature }, body });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json ?? text };
}

const hookOf = (s) => OURS.exec(s.composio.subscriptions[0]?.webhook_url ?? "")?.[1];

test("a saved Composio server lists its toolkit's events: name, description, config schema with its required fields, and whether Composio polls it", async (t) => {
  const s = await setup(t, { composio: { pageSize: 1 } });
  const res = await s.api("GET", "/settings/mcp-servers/gh/composio/events");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.toolkit, "github");
  assert.deepEqual(res.body.events.map((e) => e.slug), ["GITHUB_ISSUE_ADDED_EVENT", "GITHUB_STAR_ADDED_EVENT"], "every page is read");
  const [issue, star] = res.body.events;
  assert.equal(issue.name, "Issue Added Event");
  assert.match(issue.description, /new issue/);
  assert.deepEqual(issue.config.required, ["owner", "repo"]);
  assert.equal(issue.config.properties.owner.type, "string");
  assert.equal(issue.polled, false);
  assert.equal(star.polled, true);
  assert.ok(s.composio.to("/api/v3/triggers_types").every((c) => c.keyOk && c.query.toolkit_slugs === "github"), "asked with the saved key, for its toolkit");
  const none = await s.api("GET", "/settings/mcp-servers/nope/composio/events");
  assert.equal(none.status, 404);
});

test("the first Composio trigger makes the subscription at this server's address and the instance; the second reuses the subscription", async (t) => {
  const s = await setup(t);
  assert.equal(s.composio.subscriptions.length, 0);
  const first = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(s.composio.subscriptions.length, 1, "the subscription is made");
  const hook = hookOf(s);
  assert.ok(hook, `the subscription's address is this server's: ${s.composio.subscriptions[0].webhook_url}`);
  assert.deepEqual(s.composio.subscriptions[0].enabled_events, ["composio.trigger.message"]);
  assert.equal(s.composio.subscriptions[0].version, "V3");
  const [instance] = [...s.composio.instances.values()];
  assert.equal(instance.trigger_name, "GITHUB_ISSUE_ADDED_EVENT");
  assert.deepEqual(instance.trigger_config, { owner: "many-drop", repo: "agentrun-scratch" });
  assert.equal(instance.connected_account_id, "ca_fake_github", "for the account the server is connected as");
  assert.equal(first.body.source.instance_id, instance.id);
  assert.equal(first.body.source.hook, hook);
  assert.equal(first.body.hook_url, `${PUBLIC}/v2/hooks/composio/${hook}`);
  assert.equal(first.body.source.move_subscription, undefined, "the move flag is never kept");
  const second = await s.api("POST", "/triggers", issueTrigger({ owner: "many-drop", repo: "other" }));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(s.composio.to("/api/v3/webhook_subscriptions", "POST").length, 1, "the second reuses the subscription");
  assert.equal(s.composio.instances.size, 2);
  assert.equal(second.body.source.hook, hook);
  assert.notEqual(second.body.source.instance_id, first.body.source.instance_id);
});

test("a subscription at someone else's address is refused, naming it and saying what a move stops, and moved here only when asked", async (t) => {
  const s = await setup(t, { composio: { subscription: { webhook_url: "https://elsewhere.example/hooks/composio" } } });
  const refused = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "composio_subscription_elsewhere");
  // Only another server or a tool of the owner's can hold it now: the words say so, and that a move stops what it gets.
  const there = "https://elsewhere.example/hooks/composio";
  assert.equal(refused.body.error.message, `Composio sends this project's events to ${there} now. Moving them here stops them arriving there: anything listening at ${there} (another AgentRun server, or a tool of yours) gets no more events.`);
  assert.equal(refused.body.error.details.webhook_url, "https://elsewhere.example/hooks/composio");
  assert.equal(s.composio.subscriptions[0].webhook_url, "https://elsewhere.example/hooks/composio", "not moved");
  assert.equal(s.composio.instances.size, 0, "no instance made");
  assert.equal((await s.api("GET", "/triggers")).body.triggers.length, 0, "no trigger kept");
  const moved = await s.api("POST", "/triggers", issueTrigger(undefined, {}, { move_subscription: true }));
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.ok(hookOf(s), "moved to this server's address");
  assert.equal(s.composio.subscriptions.length, 1, "the one subscription, moved");
  assert.equal(moved.body.source.move_subscription, undefined);
});

test("an account that isn't connected answers the connect link, and leaves nothing made on Composio", async (t) => {
  const s = await setup(t, { connected: false });
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "composio_not_connected");
  assert.equal(res.body.error.details.connect_url, "https://connect.composio.test/link/ac_managed");
  assert.match(res.body.error.message, /agentrun-qa/);
  assert.equal(s.composio.subscriptions.length, 0, "the subscription this create made is undone");
  assert.equal(s.composio.instances.size, 0);
  assert.equal((await s.api("GET", "/triggers")).body.triggers.length, 0);
});

test("several connected accounts: refused, naming each with when it was made, and nothing is made on Composio", async (t) => {
  // A trigger running as the wrong account, unseen, is worse than a refusal: the owner disconnects the extra one.
  const s = await setup(t, { composio: { accounts: { github: [{ id: "ca_other_github", status: "ACTIVE", auth_config: "ac_managed", created_at: "2026-11-10T08:00:00.000Z" }] } } });
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "composio_account_ambiguous");
  assert.deepEqual(res.body.error.details.accounts, [{ id: "ca_other_github", created_at: "2026-11-10T08:00:00.000Z" }, { id: "ca_fake_github", created_at: "2026-11-13T20:26:18.916Z" }]);
  for (const words of [/agentrun-qa/, /ca_other_github \(connected 2026-11-10T08:00:00\.000Z\)/, /ca_fake_github \(connected 2026-11-13T20:26:18\.916Z\)/, /disconnect/i]) assert.match(res.body.error.message, words);
  assert.equal(s.composio.subscriptions.length, 0);
  assert.equal(s.composio.instances.size, 0);
  assert.equal((await s.api("GET", "/triggers")).body.triggers.length, 0);
});

test("an account Composio answers as another user's is never the one a trigger runs as: with no account of the server's user, it is refused as not connected, and nothing is made", async (t) => {
  // A Composio that answers every user's accounts under the config, whatever user_ids names.
  const s = await setup(t, { connected: false, composio: { ignoreUserIds: true, accounts: { github: [{ id: "ca_someone_github", user: "someone-else", status: "ACTIVE", auth_config: "ac_managed", created_at: "2026-11-10T08:00:00.000Z" }] } } });
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(res.body.error?.code, "composio_not_connected", JSON.stringify(res.body));
  assert.deepEqual(upsertedAs(s.composio), [], "no trigger instance runs as another user's account");
  assert.equal((await s.api("GET", "/triggers")).body.triggers.length, 0);
});

test("an account Composio answers with no user_id is never the one a trigger runs as: refused as not connected, and nothing is made", async (t) => {
  const s = await setup(t, { connected: false, composio: { accounts: { github: [{ id: "ca_nouser_github", user: null, status: "ACTIVE", auth_config: "ac_managed", created_at: "2026-11-10T08:00:00.000Z" }] } } });
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(res.body.error?.code, "composio_not_connected", JSON.stringify(res.body));
  assert.deepEqual(upsertedAs(s.composio), [], "no trigger instance runs as an account of no named user");
  assert.equal((await s.api("GET", "/triggers")).body.triggers.length, 0);
});

for (const [blank, said] of [[" ", "a space"], ["", "empty"]]) {
  test(`a trigger on a server whose saved Composio user is blank (${said}) is refused before Composio is asked anything: no account read, no connect link`, async (t) => {
    const s = await setup(t, { connected: false });
    // A row whose URL names a blank user (an older or damaged save; a save itself refuses one). Only a URL with no user_id
    // at all takes the default user.
    const row = await s.server.store.mcp.server("gh");
    const url = new URL(row.url);
    url.searchParams.set("user_id", blank);
    await s.server.store.mcp.put({ ...row, url: url.href });
    const before = s.composio.calls.length;
    const res = await s.api("POST", "/triggers", issueTrigger());
    assert.deepEqual([res.status, res.body.error?.fields?.map((f) => f.field)], [422, ["source.server"]], JSON.stringify(res.body));
    assert.deepEqual(s.composio.calls.slice(before).map((call) => `${call.method} ${call.path}`), [], "Composio was asked nothing: no connected accounts, no connect link");
    assert.equal((await s.api("GET", "/triggers")).body.triggers.length, 0);
  });
}

for (const [blank, said] of [[" ", "a space"], ["", "empty"]]) {
  test(`a server whose saved Composio user is blank (${said}) keeps its routes, and its delete takes the project's turn`, async (t) => {
    const s = await setup(t);
    const blankUser = async () => {
      const row = await s.server.store.mcp.server("gh");
      const url = new URL(row.url);
      url.searchParams.set("user_id", blank);
      await s.server.store.mcp.put({ ...row, url: url.href });
    };
    // A create holds the project's turn at its upsert; the row is saved blank meanwhile (an older or damaged save).
    const upsert = s.composio.hold("/upsert", "POST");
    const create = s.api("POST", "/triggers", issueTrigger());
    await upsert.reached;
    await blankUser();
    // Its routes send Composio no user: they answer, not as if the server were missing.
    const events = await s.api("GET", "/settings/mcp-servers/gh/composio/events");
    assert.equal(events.status, 200, JSON.stringify(events.body));
    const listed = await s.api("GET", "/settings/mcp-servers/gh/composio/triggers");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    // Its delete waits for the create's turn: it checks who uses the server only once the create is saved or undone. Each
    // step that takes a project's turn from here (composio-triggers.ts serial, the server's own instance of the class) is
    // seen as it takes its place, and says as it begins whether the create's upsert was let go: a delete that takes its
    // place is seen at once, and one that skips the turn answers instead, each with no clock.
    assert.equal(typeof ComposioTriggers.prototype.serial, "function", "the project's turn is taken by ComposioTriggers' serial, the method seen below");
    const { serial } = ComposioTriggers.prototype;
    t.after(() => void (ComposioTriggers.prototype.serial = serial));
    let released = false;
    const began = [];
    let placed;
    const inTurn = new Promise((resolve) => (placed = resolve));
    ComposioTriggers.prototype.serial = function (key, step) {
      placed();
      return serial.call(this, key, () => (began.push(released), step()));
    };
    const removed = s.api("DELETE", "/settings/mcp-servers/gh");
    assert.equal(await Promise.race([inTurn.then(() => "in the project's turn"), removed.then(() => "answered")]), "in the project's turn", "the delete takes its place in the project's turn, behind the create holding it, never answered past it");
    released = true;
    upsert.release();
    const [made, gone] = await Promise.all([create, removed]);
    assert.ok(began.length > 0 && began.every(Boolean), `each step in the project's turn, the delete's among them, began only once the create's upsert was let go: ${JSON.stringify(began)}`);
    // The create finds the row's user blank on its re-check and undoes what it made; the delete then finds no trigger.
    assert.deepEqual([made.status, made.body.error?.fields?.map((f) => f.field)], [422, ["source.server"]], JSON.stringify(made.body));
    assert.ok(gone.status < 300, JSON.stringify(gone.body));
    assert.equal((await s.api("GET", "/triggers")).body.triggers.length, 0);
  });
}

// A server saved with auth_config_id stands on that config: its MCP server serves only the accounts under it, so its
// triggers run as one of those, and its connect link is made under it. The user here has a GitHub account under the
// managed config too, which that server never serves.
const BOTH_CONFIGS = { github: [{ id: "ac_managed", is_composio_managed: true }, { id: "ac_custom", is_composio_managed: false }] };
const upsertedAs = (composio) => composio.calls.filter((call) => call.method === "POST" && call.path.endsWith("/upsert")).map((call) => call.body.connected_account_id);

test("a server saved with auth_config_id: its trigger runs as the account under that config, though the user has one under the managed config too", async (t) => {
  const accounts = { github: [{ id: "ca_managed_github", status: "ACTIVE", auth_config: "ac_managed", created_at: "2026-11-10T08:00:00.000Z" }, { id: "ca_custom_github", status: "ACTIVE", auth_config: "ac_custom", created_at: "2026-11-11T08:00:00.000Z" }] };
  const s = await setup(t, { connected: false, composio: { authConfigs: BOTH_CONFIGS, accounts }, saveWith: { auth_config_id: "ac_custom" } });
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(upsertedAs(s.composio), ["ca_custom_github"], "made as the account under the saved config");
  assert.equal(s.composio.instances.size, 1);
});

test("a server saved with auth_config_id and no account under it: the connect link is made under that config, and nothing is made on Composio", async (t) => {
  const s = await setup(t, { connected: false, composio: { authConfigs: BOTH_CONFIGS }, saveWith: { auth_config_id: "ac_custom" } });
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "composio_not_connected");
  assert.equal(res.body.error.details.connect_url, "https://connect.composio.test/link/ac_custom", "the link is under the saved config");
  assert.match(res.body.error.message, /under auth config ac_custom/);
  assert.equal(s.composio.subscriptions.length, 0);
  assert.equal(s.composio.instances.size, 0);
  assert.equal((await s.api("GET", "/triggers")).body.triggers.length, 0);
});

test("a server saved on the managed config, the user with an account under a custom config too: its trigger runs as the managed config's account", async (t) => {
  const accounts = { github: [{ id: "ca_managed_github", status: "ACTIVE", auth_config: "ac_managed", created_at: "2026-11-10T08:00:00.000Z" }, { id: "ca_custom_github", status: "ACTIVE", auth_config: "ac_custom", created_at: "2026-11-11T08:00:00.000Z" }] };
  const s = await setup(t, { connected: false, composio: { authConfigs: BOTH_CONFIGS, accounts } });
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(upsertedAs(s.composio), ["ca_managed_github"], "made as the account under the managed config the server stands on");
});

test("a server saved on the managed config, as before: its trigger runs as its account, and with none the link is under the managed config", async (t) => {
  const s = await setup(t, { composio: { authConfigs: BOTH_CONFIGS } });
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(upsertedAs(s.composio), ["ca_fake_github"]);
  const s2 = await setup(t, { connected: false, composio: { authConfigs: BOTH_CONFIGS } });
  const none = await s2.api("POST", "/triggers", issueTrigger());
  assert.equal(none.status, 409, JSON.stringify(none.body));
  assert.equal(none.body.error.details.connect_url, "https://connect.composio.test/link/ac_managed");
});

test("a server with no recorded auth config (saved before one was): its trigger looks across every config and links under the managed one, as before", async (t) => {
  const accounts = { github: [{ id: "ca_custom_github", status: "ACTIVE", auth_config: "ac_custom", created_at: "2026-11-11T08:00:00.000Z" }] };
  const composio = await startFakeComposio({ toolkits: { github: { no_auth: false, tools: TOOLS } }, authConfigs: BOTH_CONFIGS, accounts });
  t.after(() => composio.close());
  const kept = new Map();
  const sealed = { get: (scope, field) => kept.get(`${scope}/${field}`), set: async (scope, field, value) => void kept.set(`${scope}/${field}`, value), remove: async (scope) => void [...kept.keys()].filter((k) => k.startsWith(`${scope}/`)).forEach((k) => kept.delete(k)) };
  const triggers = new ComposioTriggers({ control: { baseUrl: composio.baseUrl }, publicUrl: PUBLIC, sealed, credential: async () => ({ key: composio.apiKey, user: "agentrun-qa", toolkit: "github" }), holders: async () => [], say: () => {} });
  const source = { kind: "composio", server: "gh", event: "GITHUB_ISSUE_ADDED_EVENT", config: { owner: "many-drop", repo: "agentrun-scratch" } };
  await triggers.make(source, "trg_a", true, async (s) => s);
  assert.deepEqual(upsertedAs(composio), ["ca_custom_github"], "the one ACTIVE account, under any config");
  const listing = composio.calls.find((call) => call.method === "GET" && call.path === "/api/v3/connected_accounts");
  assert.equal(listing.query.auth_config_ids, undefined, "not narrowed to a config");
  // No ACTIVE account at all: the link is under the managed config.
  const none = await startFakeComposio({ toolkits: { github: { no_auth: false, tools: TOOLS } }, authConfigs: BOTH_CONFIGS });
  t.after(() => none.close());
  const bare = new ComposioTriggers({ control: { baseUrl: none.baseUrl }, publicUrl: PUBLIC, sealed, credential: async () => ({ key: none.apiKey, user: "agentrun-qa", toolkit: "github" }), holders: async () => [], say: () => {} });
  await assert.rejects(bare.make(source, "trg_b", true, async (s) => s), (error) => error.code === "composio_not_connected" && error.extra.details?.connect_url === "https://connect.composio.test/link/ac_managed");
});

test("a trigger whose server's Composio user is no Composio user id (a blank one) never asks for its accounts, and runs as none of them", async (t) => {
  // A Composio that answers every user's accounts, with no user_id on them, as it would for a user_ids it trims to empty.
  const accounts = { github: [{ id: "ca_anyone_github", user: null, status: "ACTIVE", auth_config: "ac_managed", created_at: "2026-11-11T08:00:00.000Z" }] };
  const composio = await startFakeComposio({ toolkits: { github: { no_auth: false, tools: TOOLS } }, authConfigs: BOTH_CONFIGS, accounts, ignoreUserIds: true });
  t.after(() => composio.close());
  const kept = new Map();
  const sealed = { get: (scope, field) => kept.get(`${scope}/${field}`), set: async (scope, field, value) => void kept.set(`${scope}/${field}`, value), remove: async (scope) => void [...kept.keys()].filter((k) => k.startsWith(`${scope}/`)).forEach((k) => kept.delete(k)) };
  const triggers = new ComposioTriggers({ control: { baseUrl: composio.baseUrl }, publicUrl: PUBLIC, sealed, credential: async () => ({ key: composio.apiKey, user: " ", toolkit: "github" }), holders: async () => [], say: () => {} });
  const source = { kind: "composio", server: "gh", event: "GITHUB_ISSUE_ADDED_EVENT", config: { owner: "many-drop", repo: "agentrun-scratch" } };
  await triggers.make(source, "trg_blank", true, async (s) => s).catch(() => undefined);
  assert.deepEqual(composio.calls.filter((call) => call.method === "GET" && call.path === "/api/v3/connected_accounts").map((call) => call.query), [], "Composio's connected accounts were never asked for a blank user");
  assert.deepEqual(upsertedAs(composio), [], "no trigger instance runs as an account of no one user");
});

// The create reads the server's credential first and again just before it saves. A save over the server in between, with
// another key or now on another auth config, would leave the trigger on an account the server no longer serves: refused,
// and what the create made is undone. Driven here by a credential that answers otherwise on its second read.
async function racedCreate(t, second) {
  const composio = await startFakeComposio({ toolkits: { github: { no_auth: false, tools: TOOLS } }, authConfigs: BOTH_CONFIGS, active: ["github"] });
  t.after(() => composio.close());
  const kept = new Map();
  const sealed = { get: (scope, field) => kept.get(`${scope}/${field}`), set: async (scope, field, value) => void kept.set(`${scope}/${field}`, value), remove: async (scope) => void [...kept.keys()].filter((k) => k.startsWith(`${scope}/`)).forEach((k) => kept.delete(k)) };
  const first = { key: composio.apiKey, user: "agentrun-qa", toolkit: "github", auth_config: "ac_managed" };
  let reads = 0;
  const triggers = new ComposioTriggers({ control: { baseUrl: composio.baseUrl }, publicUrl: PUBLIC, sealed, credential: async () => (++reads === 1 ? first : { ...first, ...second(composio) }), holders: async () => [], say: () => {} });
  const source = { kind: "composio", server: "gh", event: "GITHUB_ISSUE_ADDED_EVENT", config: { owner: "many-drop", repo: "agentrun-scratch" } };
  const error = await triggers.make(source, "trg_raced", true, async (s) => s).then(() => undefined, (refused) => refused);
  return { composio, error, reads };
}

test("a save over the server onto another auth config while a trigger is being made: refused as a key change is, and what the create made is undone", async (t) => {
  const { composio, error, reads } = await racedCreate(t, () => ({ auth_config: "ac_custom" }));
  assert.ok(error, `the create is refused (the credential was read ${reads} times)`);
  assert.equal(error.code, "input_invalid");
  assert.equal(error.extra.fields[0].field, "source.server");
  assert.match(error.extra.fields[0].message, /another auth config/);
  assert.equal(composio.subscriptions.length, 0, "the subscription it made is undone");
  assert.ok([...composio.instances.values()].every((i) => i.disabled_at !== null) || composio.instances.size === 0, "no instance left on");
});

test("a save over the server with another key while a trigger is being made: refused, as before, and what the create made is undone", async (t) => {
  const { composio, error } = await racedCreate(t, () => ({ key: "another-fake-key" }));
  assert.ok(error, "the create is refused");
  assert.equal(error.extra.fields[0].field, "source.server");
  assert.match(error.extra.fields[0].message, /gh was saved again with another Composio key while this trigger was being made/);
  assert.equal(composio.subscriptions.length, 0);
});

test("a failure after the subscription undoes it: nothing is left on Composio or here", async (t) => {
  const s = await setup(t, { composio: { fail: { path: "/upsert", status: 500 } } });
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(res.status, 424, JSON.stringify(res.body));
  assert.equal(s.composio.subscriptions.length, 0, "the subscription made for it is deleted");
  assert.equal((await s.api("GET", "/triggers")).body.triggers.length, 0);
  // A config Composio refuses is said in its words, under the source's config.
  const s2 = await setup(t);
  const bad = await s2.api("POST", "/triggers", issueTrigger({ owner: "many-drop" }));
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.ok(bad.body.error.fields.some((f) => f.field === "source.config" && /repo/.test(f.message)), JSON.stringify(bad.body.error.fields));
  assert.equal(s2.composio.subscriptions.length, 0);
});

test("a delivery starts only its own trigger, matched by instance id; two triggers on two repositories never cross", async (t) => {
  const s = await setup(t);
  const a = (await s.api("POST", "/triggers", issueTrigger({ owner: "many-drop", repo: "a" }))).body;
  const b = (await s.api("POST", "/triggers", issueTrigger({ owner: "many-drop", repo: "b" }))).body;
  const hook = hookOf(s);
  const secret = s.composio.subscriptions[0].secret;
  const fired = await deliver(s.baseUrl, hook, delivery(a.source.instance_id), secret);
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  assert.equal(fired.body.firings.length, 1);
  const [firing] = await firings(s.api, a.id, 1);
  assert.equal(firing.by, "composio");
  assert.equal((await s.api("GET", `/triggers/${b.id}/firings`)).body.firings.length, 0, "the other repository's trigger did not fire");
  // An instance no trigger holds is answered ignored; a wrong secret, an unknown hook and the bare route are the one 401.
  assert.deepEqual((await deliver(s.baseUrl, hook, delivery("ti_someone_else"), secret)).body, { ok: "ignored" });
  assert.equal((await deliver(s.baseUrl, hook, delivery(a.source.instance_id), "cmp_whsec-not-the-one-1234567890")).status, 401);
  assert.equal((await deliver(s.baseUrl, `cph_${"0".repeat(24)}`, delivery(a.source.instance_id), secret)).status, 401);
  assert.equal((await fetch(`${s.baseUrl}/hooks/composio`, { method: "POST", body: "{}" })).status, 401);
});

test("the filter holds: a delivery its accept doesn't take is ignored, one it takes fires", async (t) => {
  const s = await setup(t);
  const accept = [{ event: "GITHUB_ISSUE_ADDED_EVENT", where: [{ pointer: "/data/title", prefix: "[agent]" }] }];
  const made = await s.api("POST", "/triggers", issueTrigger(undefined, {}, { accept }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.source.accept, accept);
  const secret = s.composio.subscriptions[0].secret;
  const other = await deliver(s.baseUrl, hookOf(s), delivery(made.body.source.instance_id, { title: "other" }), secret);
  assert.deepEqual(other.body, { ok: "ignored" });
  const taken = await deliver(s.baseUrl, hookOf(s), delivery(made.body.source.instance_id, { title: "[agent] do X" }), secret);
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  assert.equal((await firings(s.api, made.body.id, 1)).length, 1);
  // A rule naming another event than the trigger's is refused: it could never take a delivery.
  const wrong = await s.api("POST", "/triggers", issueTrigger({ owner: "x", repo: "y" }, {}, { accept: [{ event: "SLACK_NEW_MESSAGE" }] }));
  assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
  assert.ok(wrong.body.error.fields.some((f) => f.field === "source.accept[0].event"), JSON.stringify(wrong.body.error.fields));
  // The Edit filter's PATCH keeps what was made on Composio; changing the server, event or config is refused.
  const patched = await s.api("PATCH", `/triggers/${made.body.id}`, { source: { ...made.body.source, accept: [{ event: "GITHUB_ISSUE_ADDED_EVENT" }] } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.source.instance_id, made.body.source.instance_id);
  const moved = await s.api("PATCH", `/triggers/${made.body.id}`, { source: { ...made.body.source, config: { owner: "x", repo: "z" } } });
  assert.equal(moved.status, 422, JSON.stringify(moved.body));
});

test("pause, resume and delete reach Composio; the instance goes with the last trigger that holds it", async (t) => {
  const s = await setup(t);
  const one = (await s.api("POST", "/triggers", issueTrigger())).body;
  const id = one.source.instance_id;
  const paused = await s.api("PATCH", `/triggers/${one.id}`, { enabled: false });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.composio, undefined, "nothing to do by hand");
  assert.ok(s.composio.instances.get(id).disabled_at, "disabled on Composio");
  await s.api("PATCH", `/triggers/${one.id}`, { enabled: true });
  assert.equal(s.composio.instances.get(id).disabled_at, null, "enabled on Composio");
  // The same config twice shares Composio's one instance (its upsert answers the same id).
  const two = (await s.api("POST", "/triggers", issueTrigger())).body;
  assert.equal(two.source.instance_id, id);
  await s.api("PATCH", `/triggers/${one.id}`, { enabled: false });
  assert.equal(s.composio.instances.get(id).disabled_at, null, "still on: the other holder is on");
  await s.api("PATCH", `/triggers/${two.id}`, { enabled: false });
  assert.ok(s.composio.instances.get(id).disabled_at, "off once every holder is paused");
  assert.equal((await s.api("DELETE", `/triggers/${one.id}`)).status, 204);
  assert.ok(s.composio.instances.has(id), "kept while another trigger holds it");
  assert.equal((await s.api("DELETE", `/triggers/${two.id}`)).status, 204);
  assert.equal(s.composio.instances.has(id), false, "deleted with the last");
});

test("a Composio failure on pause or delete is said, with what to do by hand; the change still holds here", async (t) => {
  const s = await setup(t, { composio: { fail: { path: (path) => path.startsWith("/api/v3/trigger_instances/manage/"), status: 500 } } });
  const one = (await s.api("POST", "/triggers", issueTrigger())).body;
  const paused = await s.api("PATCH", `/triggers/${one.id}`, { enabled: false });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.enabled, false, "paused here");
  assert.equal(paused.body.composio.done, false);
  assert.match(paused.body.composio.note, new RegExp(one.source.instance_id));
  assert.match(paused.body.composio.note, /https:\/\/platform\.composio\.dev/);
  const deleted = await s.api("DELETE", `/triggers/${one.id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.deleted, true);
  assert.equal(deleted.body.composio.done, false);
  assert.match(deleted.body.composio.note, new RegExp(one.source.instance_id));
  assert.equal((await s.api("GET", `/triggers/${one.id}`)).status, 404, "gone here");
});

test("deleting the last trigger on while a paused one still holds the instance turns it off on Composio, and keeps it", async (t) => {
  const s = await setup(t);
  const on = (await s.api("POST", "/triggers", issueTrigger())).body;
  const paused = (await s.api("POST", "/triggers", issueTrigger(undefined, { enabled: false }))).body;
  const shared = on.source.instance_id;
  assert.equal(paused.source.instance_id, shared);
  assert.equal(s.composio.instances.get(shared).disabled_at, null, "on: a trigger that holds it is on");
  const deleted = await s.api("DELETE", `/triggers/${on.id}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.ok(s.composio.instances.has(shared), "kept: the paused trigger still holds it");
  assert.ok(s.composio.instances.get(shared).disabled_at, "off: no trigger left that holds it is on, so Composio stops polling");
});

test("two creates at once on one project: the first one's failure undoes only what it alone made, and the second keeps its subscription, secret and instance", async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  // The first upsert fails, slowly: the second create runs meanwhile.
  const s = await setup(t, { composio: { fail: { path: "/upsert", method: "POST", status: 500, times: 1, wait: held } } });
  const upserts = () => s.composio.calls.filter((c) => c.method === "POST" && c.path.endsWith("/upsert")).length;
  const first = s.api("POST", "/triggers", issueTrigger({ owner: "many-drop", repo: "a" }));
  for (let i = 0; i < 200 && upserts() < 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(upserts(), 1, "the first create is at its upsert");
  const second = s.api("POST", "/triggers", issueTrigger({ owner: "many-drop", repo: "b" }));
  // The second is made before the first answers, or waits for it: either way, the first's failure answers after.
  await Promise.race([second, new Promise((r) => setTimeout(r, 1500))]);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 424, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(s.composio.subscriptions.length, 1, "the subscription the second uses is at Composio");
  assert.equal(hookOf(s), b.body.source.hook, "at the second's hook");
  assert.ok(s.composio.instances.has(b.body.source.instance_id), "the second's instance is kept");
  const fired = await deliver(s.baseUrl, b.body.source.hook, delivery(b.body.source.instance_id), s.composio.subscriptions[0].secret);
  assert.equal(fired.status, 202, `the secret is kept here: ${JSON.stringify(fired.body)}`);
  assert.equal((await s.api("GET", "/triggers")).body.triggers.filter((x) => x.source.kind === "composio").length, 1);
});

test("a subscription whose secret can't be kept here is deleted at Composio again: nothing is left there", async (t) => {
  // A secret this server won't keep (under 8 bytes): the local write fails after Composio made the subscription.
  const s = await setup(t, { composio: { madeSecret: "short" } });
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.notEqual(res.status, 201, JSON.stringify(res.body));
  assert.equal(s.composio.to("/api/v3/webhook_subscriptions", "POST").length, 1, "Composio made it");
  assert.equal(s.composio.subscriptions.length, 0, "and deleted it again");
  assert.equal(s.composio.instances.size, 0);
  assert.equal((await s.api("GET", "/triggers")).body.triggers.filter((x) => x.source.kind === "composio").length, 0);
});

test("a saved server's triggers read each instance's state on Composio past its first page", async (t) => {
  const s = await setup(t, { composio: { instancePage: 2 } });
  for (const repo of ["a", "b", "c"]) assert.equal((await s.api("POST", "/triggers", issueTrigger({ owner: "many-drop", repo }))).status, 201);
  assert.equal(s.composio.instances.size, 3);
  const listed = await s.api("GET", "/settings/mcp-servers/gh/composio/triggers");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.triggers.length, 3);
  assert.deepEqual(listed.body.triggers.map((x) => x.on_composio), ["on", "on", "on"], JSON.stringify(listed.body.triggers));
});

test("a pause that takes the project's turn after a later resume leaves the instance as the trigger now stands: on", async (t) => {
  const composio = await startFakeComposio({ toolkits: { github: { no_auth: false, tools: TOOLS } }, active: ["github"] });
  t.after(() => composio.close());
  const kept = new Map();
  const sealed = { get: (scope, field) => kept.get(`${scope}/${field}`), set: async (scope, field, value) => void kept.set(`${scope}/${field}`, value), remove: async (scope) => void [...kept.keys()].filter((k) => k.startsWith(`${scope}/`)).forEach((k) => kept.delete(k)) };
  let holders = [];
  const triggers = new ComposioTriggers({ control: { baseUrl: composio.baseUrl }, publicUrl: PUBLIC, sealed, credential: async () => ({ key: composio.apiKey, user: "agentrun-qa", toolkit: "github" }), holders: async () => holders, say: () => {} });
  const source = { kind: "composio", server: "gh", event: "GITHUB_ISSUE_ADDED_EVENT", config: { owner: "many-drop", repo: "agentrun-scratch" } };
  const made = await triggers.make(source, "trg_a", true, async (s) => s);
  const instance = made.instance_id;
  // Another create holds the project's turn while the pause, then the resume, are saved here: the trigger is on.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const other = triggers.make({ ...source, config: { owner: "many-drop", repo: "other" } }, "trg_b", true, async (s) => (await held, s));
  holders = [{ id: "trg_a", name: "a", enabled: true, source: made }];
  // The resume's step takes the turn first, the pause's last.
  const resumed = triggers.turned(made, "trg_a", true);
  const paused = triggers.turned(made, "trg_a", false);
  release();
  await other;
  await Promise.all([resumed, paused]);
  assert.equal(composio.instances.get(instance).disabled_at, null, "on at Composio: the trigger is on here");
});

test("deleting the project's subscription while a create waits on its instance is refused once the create holds it; the create keeps it", async (t) => {
  const s = await setup(t);
  const upsert = s.composio.hold("/upsert", "POST");
  const create = s.api("POST", "/triggers", issueTrigger());
  await upsert.reached;
  const forget = s.api("DELETE", "/settings/mcp-servers/gh/composio/subscription");
  // Deleted before the create answers, or waits for it: either way, the create answers after.
  await Promise.race([forget, new Promise((r) => setTimeout(r, 1500))]);
  upsert.release();
  const [made, forgot] = await Promise.all([create, forget]);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(s.composio.subscriptions.length, 1, "the subscription the create uses is at Composio");
  assert.equal(forgot.status, 409, JSON.stringify(forgot.body));
  assert.equal(forgot.body.error.code, "composio_in_use");
  const fired = await deliver(s.baseUrl, made.body.source.hook, delivery(made.body.source.instance_id), s.composio.subscriptions[0].secret);
  assert.equal(fired.status, 202, `its secret is kept here: ${JSON.stringify(fired.body)}`);
});

test("a rotate while a create holds an older read of the subscription keeps the new secret here", async (t) => {
  const s = await setup(t);
  const first = await s.api("POST", "/triggers", issueTrigger({ owner: "many-drop", repo: "a" }));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // The next create's read of the subscription answers the secret as it is now, and arrives late.
  const read = s.composio.hold("/api/v3/webhook_subscriptions", "GET");
  const create = s.api("POST", "/triggers", issueTrigger({ owner: "many-drop", repo: "b" }));
  await read.reached;
  const rotate = s.api("POST", "/settings/mcp-servers/gh/composio/rotate-secret");
  await Promise.race([rotate, new Promise((r) => setTimeout(r, 1500))]);
  read.release();
  const [made, rotated] = await Promise.all([create, rotate]);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  const now = s.composio.subscriptions[0].secret;
  const fired = await deliver(s.baseUrl, hookOf(s), delivery(made.body.source.instance_id), now);
  assert.equal(fired.status, 202, `the secret kept here is Composio's new one: ${JSON.stringify(fired.body)}`);
});

test("a failed read of the instances leaves every trigger's state at Composio unknown, never missing", async (t) => {
  const s = await setup(t, { composio: { fail: { path: "/api/v3/trigger_instances/active", method: "GET", status: 500 } } });
  for (const repo of ["a", "b"]) assert.equal((await s.api("POST", "/triggers", issueTrigger({ owner: "many-drop", repo }))).status, 201);
  const listed = await s.api("GET", "/settings/mcp-servers/gh/composio/triggers");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(listed.body.composio_error, "said");
  assert.deepEqual(listed.body.triggers.map((x) => x.on_composio), ["unknown", "unknown"], JSON.stringify(listed.body.triggers));
});

test("while Composio triggers use a server, a save over it as another user and an ordinary save that moves it off Composio are refused in the delete's words: the server, its trigger and what they stand on at Composio stay; a save as the same user goes through, and once the trigger is gone so does the move", async (t) => {
  const s = await setup(t);
  const made = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const before = (await s.api("GET", "/settings/mcp-servers/gh")).body;
  const first = s.composio.mcpIds[0];
  const refused = `gh has Composio triggers: ${made.body.name}. Delete it first, then save the server again.`;
  const asOther = { api_key: s.composio.apiKey, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "someone-else" };

  const over = await s.api("PUT", "/settings/mcp-servers/gh/composio", asOther);
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.deepEqual([over.body.error.code, over.body.error.message, over.body.error.details], ["composio_in_use", refused, { triggers: [{ id: made.body.id, name: made.body.name }] }]);
  assert.ok(s.composio.mcpLive.has(first), "the server's MCP server stays at Composio");
  assert.ok(!s.composio.mcpLive.has(s.composio.mcpIds[1]), "the refused save's own MCP server is removed there");

  const other = await startFakeMcp();
  t.after(() => other.close());
  const moved = await s.api("PUT", "/settings/mcp-servers/gh", { url: other.url, auth: { type: "none" } });
  assert.equal(moved.status, 409, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.error.code, moved.body.error.message], ["composio_in_use", refused]);
  const after = (await s.api("GET", "/settings/mcp-servers/gh")).body;
  assert.deepEqual([after.url, after.auth, after.source], [before.url, before.auth, before.source], "the server is as it was");
  assert.ok(s.composio.mcpLive.has(first), "and so is its MCP server at Composio");
  assert.equal(s.composio.instances.size, 1, "its trigger's instance stays");
  assert.equal((await s.api("GET", `/triggers/${made.body.id}`)).status, 200);

  // The same user's save (its tools again): what the trigger stands on is unchanged, so it goes through.
  const same = await s.api("PUT", "/settings/mcp-servers/gh/composio", { ...asOther, user_id: "agentrun-qa" });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal((await s.api("DELETE", `/triggers/${made.body.id}`)).status, 204);
  const movedNow = await s.api("PUT", "/settings/mcp-servers/gh", { url: other.url, auth: { type: "none" } });
  assert.equal(movedNow.status, 200, JSON.stringify(movedNow.body));
});

test("a save over a server its trigger uses: one that keeps its user and auth config (its tools alone) removes at Composio only the earlier MCP server, and the trigger stays subscribed as it was; one as another user, or of another toolkit (another auth config, or none), is refused and leaves the server's record of what it stands on, and the trigger, untouched", async (t) => {
  const s = await setup(t, { composio: {
    toolkits: { github: { no_auth: false, tools: TOOLS }, linear: { no_auth: false, tools: [{ slug: "LINEAR_LIST_ISSUES", name: "List issues", description: "Lists issues." }] }, hackernews: { no_auth: true, tools: [{ slug: "HACKERNEWS_GET_FRONTPAGE", name: "Front page", description: "Reads the front page." }] } },
    authConfigs: { github: [{ id: "ac_managed", is_composio_managed: true }], linear: [{ id: "ac_linear", is_composio_managed: true }] },
    active: ["github", "linear"],
  } });
  const made = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const record = async () => s.server.store.settings.get("mcp.composio/gh");
  const kept = { instances: [...s.composio.instances.keys()], subscriptions: s.composio.subscriptions.length };
  const deletesFrom = (from) => s.composio.calls.slice(from).filter((call) => call.method === "DELETE").map((call) => call.path);
  const body = { api_key: s.composio.apiKey, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "agentrun-qa" };

  // Its tools again, as the same user under the same auth config: what the trigger runs as is unchanged.
  const stood = await record();
  let from = s.composio.calls.length;
  const same = await s.api("PUT", "/settings/mcp-servers/gh/composio", body);
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.deepEqual(deletesFrom(from), [`/api/v3.1/mcp/${s.composio.mcpIds[0]}`], "the earlier MCP server alone: no account, no auth config");
  assert.deepEqual(same.body.composio, { removed: true, note: `Removed in Composio: the MCP server ${s.composio.mcpIds[0]}.` });
  const now = await record();
  assert.deepEqual([now.user, now.auth_config, now.accounts], [stood.user, stood.auth_config, stood.accounts], "it stands on what it stood on");
  assert.deepEqual({ instances: [...s.composio.instances.keys()], subscriptions: s.composio.subscriptions.length }, kept, "the trigger's instance and the project's subscription stay");
  assert.equal((await s.api("GET", `/triggers/${made.body.id}`)).body.enabled, true);

  // As another user: refused in words, nothing written, nothing removed but the refused save's own MCP server.
  from = s.composio.calls.length;
  const other = await s.api("PUT", "/settings/mcp-servers/gh/composio", { ...body, user_id: "someone-else" });
  assert.equal(other.status, 409, JSON.stringify(other.body));
  assert.equal(other.body.error.message, `gh has Composio triggers: ${made.body.name}. Delete it first, then save the server again.`);
  assert.deepEqual(deletesFrom(from), [`/api/v3.1/mcp/${s.composio.mcpIds[2]}`], "the refused save's own MCP server alone");
  assert.deepEqual(await record(), now, "the record of what it stands on is as it was");
  assert.ok(s.composio.mcpLive.has(s.composio.mcpIds[1]), "the server's MCP server stays");
  assert.deepEqual({ instances: [...s.composio.instances.keys()], subscriptions: s.composio.subscriptions.length }, kept);
  assert.equal((await s.api("GET", `/triggers/${made.body.id}`)).body.enabled, true);

  // Of another toolkit, as the same user: another auth config (linear's), or none (hackernews needs no sign-in), so what
  // the trigger runs as would change. Refused the same way.
  const shown = (await s.api("GET", "/settings/mcp-servers/gh")).body;
  for (const [toolkit, tool] of [["linear", "LINEAR_LIST_ISSUES"], ["hackernews", "HACKERNEWS_GET_FRONTPAGE"]]) {
    from = s.composio.calls.length;
    const ids = s.composio.mcpIds.length;
    const kit = await s.api("PUT", "/settings/mcp-servers/gh/composio", { ...body, toolkit, tools: [tool] });
    assert.equal(kit.status, 409, `${toolkit}: ${JSON.stringify(kit.body)}`);
    assert.deepEqual([kit.body.error.code, kit.body.error.message], ["composio_in_use", `gh has Composio triggers: ${made.body.name}. Delete it first, then save the server again.`], toolkit);
    assert.equal(s.composio.mcpIds.length, ids + 1, `${toolkit}: the refused save made one MCP server`);
    assert.deepEqual(deletesFrom(from), [`/api/v3.1/mcp/${s.composio.mcpIds[ids]}`], `${toolkit}: the refused save's own MCP server alone`);
    assert.deepEqual(await record(), now, `${toolkit}: the record of what it stands on is as it was`);
    assert.ok(s.composio.mcpLive.has(s.composio.mcpIds[1]), `${toolkit}: the server's MCP server stays`);
    assert.deepEqual({ instances: [...s.composio.instances.keys()], subscriptions: s.composio.subscriptions.length }, kept, toolkit);
    assert.equal((await s.api("GET", `/triggers/${made.body.id}`)).body.enabled, true, toolkit);
  }
  assert.deepEqual((await s.api("GET", "/settings/mcp-servers/gh")).body, shown, "the server reads as it did");
});

test("deleting the saved server while its first trigger waits on its instance: no trigger outlives its server, and Composio keeps nothing orphaned", async (t) => {
  const s = await setup(t);
  const upsert = s.composio.hold("/upsert", "POST");
  const create = s.api("POST", "/triggers", issueTrigger());
  await upsert.reached;
  const remove = s.api("DELETE", "/settings/mcp-servers/gh");
  // Deleted before the create answers, or waits for it: either way, the create answers after.
  await Promise.race([remove, new Promise((r) => setTimeout(r, 1500))]);
  upsert.release();
  const [made, removed] = await Promise.all([create, remove]);
  const kept = (await s.api("GET", "/triggers")).body.triggers.filter((x) => x.source.kind === "composio");
  const server = (await s.api("GET", "/settings/mcp-servers/gh")).status;
  if (made.status === 201) {
    // The create won: the delete is refused, naming it, and the server stays.
    assert.equal(removed.status, 409, `the server's delete is refused while its trigger uses it: ${JSON.stringify(removed.body)}`);
    assert.equal(removed.body.error.code, "composio_in_use");
    assert.equal(server, 200, "the server is kept");
    assert.deepEqual(kept.map((x) => x.id), [made.body.id]);
  } else {
    // The delete won: the create is refused and undone on Composio.
    assert.equal(kept.length, 0, "no trigger names the deleted server");
    assert.equal(s.composio.instances.size, 0, "no instance left on Composio");
    assert.equal(s.composio.subscriptions.length, 0, "no subscription left on Composio");
  }
  for (const trigger of kept) assert.equal(server, 200, `${trigger.id} names a saved server`);
});

test("a trigger the server turns off itself (its agent archived, a failure streak) is off on Composio too, as a pause is", async (t) => {
  const s = await setup(t);
  await made(s.api, "other");
  // Two triggers on one config share the instance: it stays on while the other is on.
  const one = (await s.api("POST", "/triggers", issueTrigger())).body;
  const two = (await s.api("POST", "/triggers", issueTrigger(undefined, { target: { kind: "start_run", agent_id: "other", input: { content: "Triage this issue." }, max_cost_usd: 0.5 } }))).body;
  const shared = one.source.instance_id;
  assert.equal(two.source.instance_id, shared);
  assert.equal((await s.api("POST", "/agents/other/archive")).status, 200);
  assert.equal((await s.api("GET", `/triggers/${two.id}`)).body.disabled.reason, "agent_archived");
  assert.equal(s.composio.instances.get(shared).disabled_at, null, "still on: the other trigger holds it");
  assert.equal((await s.api("POST", "/agents/triage/archive")).status, 200);
  assert.ok(s.composio.instances.get(shared).disabled_at, "off once no trigger that holds it is on");
  // Five failed firings in a row: the trigger pauses itself, and its instance is turned off on Composio.
  assert.equal((await s.api("POST", "/agents", { definition: { id: "unrunnable", version: 1, name: "Unrunnable", harness: "claude-agent", instructions: "Triage.", tools: [], max_cost_usd: 0.5 } })).status, 201);
  const flaky = (await s.api("POST", "/triggers", issueTrigger({ owner: "many-drop", repo: "flaky" }, { target: { kind: "start_run", agent_id: "unrunnable", input: { content: "Triage this issue." }, max_cost_usd: 0.5 } }))).body;
  assert.ok(flaky.source?.instance_id, JSON.stringify(flaky));
  const secret = s.composio.subscriptions[0].secret;
  for (let n = 1; n <= 5; n++) {
    assert.equal((await deliver(s.baseUrl, hookOf(s), delivery(flaky.source.instance_id), secret)).status, 202);
    const [last] = await firings(s.api, flaky.id, n);
    assert.equal(last.status, "failed", JSON.stringify(last));
  }
  assert.equal((await s.api("GET", `/triggers/${flaky.id}`)).body.disabled?.reason, "auto_paused");
  // Composio is told after the pause holds here, as an owner's pause is, and nothing the test awaits waits for it (an
  // archive's answer does: the asserts above read it at once).
  assert.ok(await until(() => s.composio.instances.get(flaky.source.instance_id).disabled_at), "the paused trigger's instance is off on Composio");
});

test("a Composio failure turning off a trigger the server turned off itself is said, with what to turn off by hand", async (t) => {
  const s = await setup(t, { composio: { fail: { path: (path) => path.startsWith("/api/v3/trigger_instances/manage/"), method: "PATCH", status: 500 } } });
  const one = (await s.api("POST", "/triggers", issueTrigger())).body;
  assert.equal((await s.api("POST", "/agents/triage/archive")).status, 200);
  assert.equal((await s.api("GET", `/triggers/${one.id}`)).body.enabled, false, "off here");
  assert.equal(s.composio.instances.get(one.source.instance_id).disabled_at, null, "Composio didn't turn it off");
  assert.ok(s.lines.some((line) => line.includes(one.id) && line.includes(one.source.instance_id) && line.includes("https://platform.composio.dev")), "the log says what to turn off there, and where");
});

test("a saved server with Composio triggers can't be deleted: refused, naming them", async (t) => {
  const s = await setup(t);
  const one = (await s.api("POST", "/triggers", issueTrigger())).body;
  const res = await s.api("DELETE", "/settings/mcp-servers/gh");
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "composio_in_use");
  assert.match(res.body.error.message, new RegExp(one.name));
  assert.equal((await s.api("GET", "/settings/mcp-servers/gh")).status, 200, "kept");
  assert.equal(s.composio.to(`/api/v3.1/mcp/${s.composio.mcpId}`, "DELETE").length, 0, "nothing deleted on Composio");
  // Its triggers and their state at Composio, for Settings and the trigger's page.
  const listed = await s.api("GET", "/settings/mcp-servers/gh/composio/triggers");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.triggers.map((x) => [x.id, x.instance_id, x.on_composio]), [[one.id, one.source.instance_id, "on"]]);
  assert.equal(listed.body.subscription.ours, true);
});

test("with no public address, making a Composio trigger is refused in words saying Composio can't reach this server", async (t) => {
  const s = await setup(t, { server: { publicUrl: undefined } });
  // The capabilities say so first, for the console to turn New app trigger off.
  assert.equal((await s.api("GET", "/capabilities")).body.features.triggers.public_url, false);
  const res = await s.api("POST", "/triggers", issueTrigger());
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "composio_no_public_url");
  assert.match(res.body.error.message, /Composio can't reach this server/);
  assert.equal(s.composio.calls.filter((c) => c.path.startsWith("/api/v3/webhook_subscriptions") || c.path.startsWith("/api/v3/trigger_instances")).length, 0, "Composio was asked nothing");
});

test("the capabilities say whether this server has a public address Composio can send to, and never the address", async (t) => {
  const s = await setup(t);
  const caps = (await s.api("GET", "/capabilities")).body;
  assert.equal(caps.features.triggers.public_url, true);
  assert.ok(!JSON.stringify(caps).includes("agentrun.example.com"), "the address itself is not answered");
});

test("a saved Composio server's own routes send Composio no user: its events, its triggers, the subscription's rotate and delete, and the server's delete in the project's turn each ask by the key alone", async (t) => {
  const s = await setup(t);
  // What each route asked Composio, apart from the trigger's own create and delete, which send the server's user.
  const routed = [];
  const route = async (step, ...args) => {
    const from = s.composio.calls.length;
    const res = await s.api(...args);
    routed.push(...s.composio.calls.slice(from).map((call) => ({ step, ...call })));
    return res;
  };
  const one = (await s.api("POST", "/triggers", issueTrigger())).body;
  assert.ok(one.id, JSON.stringify(one));
  assert.equal((await route("events", "GET", "/settings/mcp-servers/gh/composio/events")).status, 200);
  assert.equal((await route("triggers", "GET", "/settings/mcp-servers/gh/composio/triggers")).status, 200);
  assert.equal((await route("rotate", "POST", "/settings/mcp-servers/gh/composio/rotate-secret")).status, 200);
  assert.equal((await s.api("DELETE", `/triggers/${one.id}`)).status, 204);
  assert.equal((await route("forget", "DELETE", "/settings/mcp-servers/gh/composio/subscription")).status, 200);
  assert.ok((await route("delete", "DELETE", "/settings/mcp-servers/gh")).status < 300);
  // Each route asked Composio something, so none of the checks below holds by asking nothing.
  assert.deepEqual([...new Set(routed.map(({ step }) => step))], ["events", "triggers", "rotate", "forget", "delete"], `each route asked Composio: ${JSON.stringify(routed.map(({ step, method, path }) => `${step} ${method} ${path}`))}`);
  const sentUser = routed.filter(({ query, body }) => Object.hasOwn(query ?? {}, "user_id") || Object.hasOwn(query ?? {}, "user_ids") || JSON.stringify(body ?? {}).includes('"user_id"'));
  assert.deepEqual(sentUser.map(({ step, method, path }) => `${step} ${method} ${path}`), [], "no route sends Composio a user_id, in its query or its body");
});

test("rotate keeps the new secret: the old one signs nothing from then on; the subscription is deleted only once no trigger uses it", async (t) => {
  const s = await setup(t);
  const one = (await s.api("POST", "/triggers", issueTrigger())).body;
  const old = s.composio.subscriptions[0].secret;
  const rotated = await s.api("POST", "/settings/mcp-servers/gh/composio/rotate-secret");
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.deepEqual(rotated.body, { rotated: true });
  const fresh = s.composio.subscriptions[0].secret;
  assert.notEqual(fresh, old);
  assert.equal((await deliver(s.baseUrl, hookOf(s), delivery(one.source.instance_id), old)).status, 401, "the old secret signs nothing");
  assert.equal((await deliver(s.baseUrl, hookOf(s), delivery(one.source.instance_id), fresh)).status, 202, "the new one does");
  const held = await s.api("DELETE", "/settings/mcp-servers/gh/composio/subscription");
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.error.code, "composio_in_use");
  assert.equal((await s.api("DELETE", `/triggers/${one.id}`)).status, 204);
  const gone = await s.api("DELETE", "/settings/mcp-servers/gh/composio/subscription");
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.deepEqual(gone.body, { deleted: true });
  assert.equal(s.composio.subscriptions.length, 0);
  assert.equal(s.composio.instances.size, 0);
});

test("the subscription's secret appears in no answer, log line or run input", async (t) => {
  const s = await setup(t);
  const one = (await s.api("POST", "/triggers", issueTrigger())).body;
  const first = s.composio.subscriptions[0].secret;
  await s.api("GET", `/triggers/${one.id}`);
  await s.api("GET", "/triggers");
  await s.api("GET", "/settings/mcp-servers/gh");
  await s.api("GET", "/settings/mcp-servers/gh/composio/triggers");
  await s.api("POST", "/settings/mcp-servers/gh/composio/rotate-secret");
  const second = s.composio.subscriptions[0].secret;
  const fired = await deliver(s.baseUrl, hookOf(s), delivery(one.source.instance_id), second);
  assert.equal(fired.status, 202);
  s.answers.push(JSON.stringify(fired.body));
  const [firing] = await firings(s.api, one.id, 1);
  if (firing.run_id) s.answers.push(JSON.stringify((await s.api("GET", `/runs/${firing.run_id}/events`)).body));
  for (const secret of [first, second]) {
    assert.ok(!s.answers.some((a) => a.includes(secret)), "no answer holds the secret");
    assert.ok(!s.lines.some((l) => l.includes(secret)), "no log line holds the secret");
  }
});
