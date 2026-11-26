// An MCP server's own URL is held to the rule an authorization server's endpoint is (mcp-oauth.ts mcpServerAt, its
// `checked`): a server with no credential is not a secret write, so a token could otherwise save one on this server's
// network and read which ports answer from the probe's errors. At every door that dials it (the preview, the save, the
// tools' refresh, the sign-in) a private-network address is refused before anything is sent unless the owner allows its
// host (Settings → MCP servers, the private-hosts list), loopback is refused unless this server is a local install, and
// link-local and cloud metadata addresses are refused whatever the list says. Every address a name resolves to is
// checked, and the one dialled is one checked. On the runner each request of a call is checked again. The private
// addresses here are never reached: a refusal names its rule, and the networks of the registry's and the runner's tests
// have no socket but the fake MCP server's. Public addresses are RFC 5737's, names RFC 2606's.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";
import { asOwner, serve, withEnv } from "./support.mjs";
import { queued, storeOn } from "./store-helpers.mjs";

const { mcpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { savePrivateOAuthHosts } = await import("../dist/mcp-private-hosts.js");
const { mcpForClaim } = await import("../dist/runner/mcp-run.js");
const { heldRedactor, keepText } = await import("../dist/runner/redact.js");

const KEY = randomBytes(32);
const PAGE = "Settings → MCP servers";
const onPrivateNetwork = (host, named = host) => `The MCP server at ${host} is on a private network, refused: an owner can allow ${named} in ${PAGE}.`;
const privateAddress = (host) => `The MCP server at ${host} is a private address; refused.`;

/** Each private-network range an owner may allow a host on, by an address in it, and the words its refusal says. */
const PRIVATE = [
  ["https://10.20.30.40/mcp", onPrivateNetwork("10.20.30.40")],
  ["https://172.16.5.4/mcp", onPrivateNetwork("172.16.5.4")],
  ["https://172.31.255.1/mcp", onPrivateNetwork("172.31.255.1")],
  ["https://192.168.1.20/mcp", onPrivateNetwork("192.168.1.20")],
  ["https://100.64.0.7/mcp", onPrivateNetwork("100.64.0.7")],
  ["https://[fd12:3456::5]/mcp", onPrivateNetwork("[fd12:3456::5]")],
];
/** What no list allows: link-local, cloud metadata (IPv4, AWS's IPv6, Alibaba's in 100.64/10) and the unspecified address. */
const NEVER = [
  ["https://169.254.169.254/latest/meta-data", privateAddress("169.254.169.254")], // key-gate: denylist a refused test target
  ["https://169.254.10.1/mcp", privateAddress("169.254.10.1")], // key-gate: denylist a refused test target
  ["https://[fd00:ec2::254]/mcp", privateAddress("[fd00:ec2::254]")], // key-gate: denylist a refused test target
  ["https://100.100.100.200/mcp", privateAddress("100.100.100.200")], // key-gate: denylist a refused test target
  ["https://[fe80::1]/mcp", privateAddress("[fe80::1]")], // key-gate: denylist a refused test target
  ["https://0.0.0.0/mcp", privateAddress("0.0.0.0")], // key-gate: denylist a refused test target
];

/** `answer` is 422 on url alone, in `words`, saying nothing else. */
function refusedOnUrl(answer, words, where) {
  assert.deepEqual([answer.status, answer.body.error?.code], [422, "input_invalid"], `${where}: ${JSON.stringify(answer.body)}`);
  assert.deepEqual(answer.body.error.fields.map((field) => [field.field, field.message]), [["url", words]], where);
}

test("each private-network range, link-local and cloud metadata are refused at the preview and the save, by a token and by the owner's session, in words, and nothing is kept", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { runner: false });
  const owner = asOwner(server);
  for (const [url, words] of [...PRIVATE, ...NEVER]) {
    for (const [who, api] of [["a token", server.api], ["the owner", owner]]) {
      refusedOnUrl(await api("POST", "/settings/mcp-servers/preview", { url, auth: { type: "none" } }), words, `${who}'s preview of ${url}`);
      refusedOnUrl(await api("PUT", "/settings/mcp-servers/inside", { url, auth: { type: "none" } }), words, `${who}'s save of ${url}`);
    }
    // A credential with it, the owner's alone to send: refused the same, before it goes anywhere.
    refusedOnUrl(await owner("PUT", "/settings/mcp-servers/inside", { url, auth: { type: "bearer", token: `not-a-secret-${"inside"}` } }), words, `the owner's save of ${url} with a bearer`);
  }
  assert.deepEqual((await server.api("GET", "/settings/mcp-servers")).body, { servers: [] }, "nothing kept");
});

test("a loopback MCP URL: saved with AGENTRUN_MCP_ALLOW_LOOPBACK=1 (the test servers' default), refused at the preview and the save without it, https as http, nothing sent", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const local = await serve(t, { runner: false });
  const saved = await local.api("PUT", "/settings/mcp-servers/here", { url: fake.url, auth: { type: "none" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const heard = fake.log.length;
  assert.ok(heard > 0, "the local install listed its tools");

  // A server its operator never said is a local install (a hosted one, its public address set or not): refused, in words
  // naming the variable that says so.
  const hosted = await serve(t, { runner: false, publicUrl: "https://agents.example.test", mcpLoopback: false });
  const machine = (url) => `${new URL(url).hostname} is this machine; restart the server with AGENTRUN_MCP_ALLOW_LOOPBACK=1 to allow it, only on a machine you alone use.`;
  for (const [who, api] of [["a token", hosted.api], ["the owner", asOwner(hosted)]]) {
    refusedOnUrl(await api("POST", "/settings/mcp-servers/preview", { url: fake.url, auth: { type: "none" } }), machine(fake.url), `${who}'s preview`);
    refusedOnUrl(await api("PUT", "/settings/mcp-servers/here", { url: fake.url, auth: { type: "none" } }), machine(fake.url), `${who}'s save`);
    // Loopback is this machine whatever the scheme: an https one is refused the same.
    const port = new URL(fake.url).port;
    const others = [fake.url.replace("127.0.0.1", "localhost"), `http://[::1]:${port}/mcp`, `https://127.0.0.1:${port}/mcp`, `https://localhost:${port}/mcp`]; // key-gate: loopback-rule the loopback names a hosted server refuses
    for (const url of others) {
      refusedOnUrl(await api("PUT", "/settings/mcp-servers/here", { url, auth: { type: "none" } }), machine(url), `${who}'s save of ${url}`);
    }
  }
  assert.equal(fake.log.length, heard, "the hosted server sent it nothing");
});

/** A network with one socket, the fake MCP server's: `names[host]` is what a name resolves to (a function, each lookup's
 *  answer); a request is recorded as [url, address] and sent to `fake` as it would reach the address it was dialled at. */
function networkTo(fake, names) {
  const dialled = [];
  const looked = [];
  const reach = (url, init, address) => {
    dialled.push([url, address]);
    const at = new URL(url);
    return fetch(`${fake.url.replace(/\/mcp$/, "")}${at.pathname}${at.search}`, init);
  };
  return {
    dialled,
    looked,
    lookup: async (host) => {
      looked.push(host);
      const answer = names[host];
      if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return typeof answer === "function" ? answer() : answer;
    },
    fetch: reach,
    dial: reach,
    local: () => [],
  };
}

/** The registry the server builds over a store, reaching `network`, attached as a server with a public address is. */
async function hostedRegistry(t, network) {
  const { store } = await storeOn(t);
  const registry = mcpServersOverStore(store, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, "test", network);
  registry.attach("https://agents.example.test", "http://agents.example.test:7340", false);
  return { store, registry };
}

test("a name is held to every address it resolves to: one resolving to a private address is refused at the preview, the save, the refresh and the sign-in's start, unsent, until the owner allows its host; then it saves, dialled at the address checked", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const network = networkTo(fake, { "mcp.corp.test": ["10.20.30.40"], "mixed.corp.test": ["192.0.2.10", "10.20.30.41"], "gone.example.test": [] });
  const { store, registry } = await hostedRegistry(t, network);
  const url = "https://mcp.corp.test/mcp";
  const refused = (host) => (error) => error.code === "input_invalid" && error.extra.fields?.[0]?.field === "url" && error.extra.fields[0].message === onPrivateNetwork(host);
  await assert.rejects(registry.preview({ url, auth: { type: "none" } }), refused("mcp.corp.test"), "the preview");
  await assert.rejects(registry.save("corp", { url, auth: { type: "none" } }), refused("mcp.corp.test"), "the save");
  await assert.rejects(registry.oauthStart("corp", { url }), refused("mcp.corp.test"), "the sign-in's start");
  // A name with a public address among its answers is held to all of them.
  await assert.rejects(registry.save("mixed", { url: "https://mixed.corp.test/mcp", auth: { type: "none" } }), refused("mixed.corp.test"), "a name with one private answer");
  assert.deepEqual(network.dialled, [], "nothing sent");
  // A name that resolves to nothing is the unreachable server it always was.
  await assert.rejects(registry.save("gone", { url: "https://gone.example.test/mcp", auth: { type: "none" } }), (error) => error.code === "upstream_failed" && error.message === "Could not reach the MCP server at https://gone.example.test (ENOTFOUND).");

  await savePrivateOAuthHosts(store, ["mcp.corp.test"]);
  const saved = await registry.save("corp", { url, auth: { type: "none" } });
  assert.deepEqual(saved.tools.map((tool) => tool.name).sort(), ["add", "delete_thing", "paid", "slow_write"]);
  assert.ok(network.dialled.length > 0 && network.dialled.every(([to, address]) => to.startsWith("https://mcp.corp.test/") && address === "10.20.30.40"), JSON.stringify(network.dialled));
  assert.equal((await registry.preview({ name: "corp" })).tools.length, 4, "the preview by name");
  // Taken off the list, the saved server's refresh is refused unsent.
  await savePrivateOAuthHosts(store, []);
  const before = network.dialled.length;
  await assert.rejects(registry.refresh("corp"), refused("mcp.corp.test"), "the refresh");
  await assert.rejects(registry.preview({ name: "corp" }), refused("mcp.corp.test"), "the preview by name");
  assert.equal(network.dialled.length, before, "nothing sent once it is off the list");
});

test("loopback, link-local and metadata stay refused even when the owner lists a name that resolves to one", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const network = networkTo(fake, { "loop.corp.test": ["127.0.0.1"], "meta.corp.test": ["169.254.169.254"], "imds.corp.test": ["fd00:ec2::254"], "ali.corp.test": ["100.100.100.200"] }); // key-gate: loopback-rule names that resolve to loopback and metadata, refused
  const { store, registry } = await hostedRegistry(t, network);
  await savePrivateOAuthHosts(store, ["loop.corp.test", "meta.corp.test", "imds.corp.test", "ali.corp.test"]);
  for (const host of ["loop.corp.test", "meta.corp.test", "imds.corp.test", "ali.corp.test"]) {
    await assert.rejects(registry.save("listed", { url: `https://${host}/mcp`, auth: { type: "none" } }), (error) => error.code === "input_invalid" && error.extra.fields?.[0]?.message === privateAddress(host), host);
  }
  assert.deepEqual(network.dialled, [], "nothing sent");
});

test("on the runner, a pinned server whose name resolves to a private address at call time is refused unsent, in words; a run with the host allowed calls it at the address checked", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  let answer = ["192.0.2.10"];
  const network = networkTo(fake, { "mcp.example.test": () => answer });
  const { store, dir } = await storeOn(t);
  const url = "https://mcp.example.test/mcp";
  await store.mcp.put({ name: "corp", url, auth: "none", tools: [{ name: "add", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }], sealed: null });
  // The revision as its save pinned it: the granted tool, the server's URL then.
  await queued(store, "run-1", { mcpPin: { corp: { url, tools: [{ name: "add", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }] } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const mcp = await mcpForClaim({ redact: heldRedactor(keepText), claim, store, sealKey: KEY, grants: ["mcp:corp/add"], harness: { commit: async () => undefined }, work: () => dir, network });
  t.after(() => mcp.release());
  const add = mcp.tools.find((tool) => tool.name === "mcp__corp__add");
  const call = (callId) => add.call({ a: 2, b: 3 }, { callId, signal: new AbortController().signal });

  assert.deepEqual(await call("call-1"), { text: "5" }, "a public address is called");
  assert.ok(network.dialled.every(([, address]) => address === "192.0.2.10"));
  // Its name now resolves to a private address: refused before anything leaves, on the connection already open too.
  answer = ["10.20.30.40"];
  const sent = fake.log.length;
  const refused = await call("call-2");
  assert.deepEqual(refused, { text: `The MCP server corp's address is refused here: the MCP server at mcp.example.test is on a private network, refused: an owner can allow mcp.example.test in ${PAGE}. Nothing was sent.`, isError: true });
  assert.equal(fake.log.length, sent, "the server heard nothing");
  assert.ok(!network.dialled.some(([, address]) => address === "10.20.30.40"), "nothing dialled at the private address");
  // The owner allows it: the next call goes, dialled at the address checked.
  await savePrivateOAuthHosts(store, ["mcp.example.test"]);
  assert.deepEqual(await call("call-3"), { text: "5" });
  assert.deepEqual(network.dialled.at(-1)[1], "10.20.30.40");
  // Metadata is never allowed, listed or not.
  answer = ["169.254.169.254"]; // key-gate: denylist a refused test target
  assert.deepEqual(await call("call-4"), { text: `The MCP server corp's address is refused here: the MCP server at mcp.example.test is a private address; refused. Nothing was sent.`, isError: true });
});

test("on the runner, a server whose saved URL carries a credential in its query ends the claim before anything is sent, its URL never named", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const { store, dir } = await storeOn(t);
  const secret =`not-a-secret-${"pinned-query"}`;
  await store.mcp.put({ name: "old", url: `${fake.url}?api_key=${secret}`, auth: "none", tools: [{ name: "add", input_schema: { type: "object" } }], sealed: null });
  // A revision saved before a save refused such a URL: its pin holds it.
  await queued(store, "run-1", { mcpPin: { old: { url: `${fake.url}?api_key=${secret}`, tools: [{ name: "add", inputSchema: { type: "object" } }] } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await assert.rejects(mcpForClaim({ redact: heldRedactor(keepText), loopback: true, claim, store, sealKey: KEY, grants: ["mcp:old/add"], harness: { commit: async () => undefined }, work: () => dir }), (error) => {
    assert.equal(error.message, "The MCP server old can't be used: api_key in the URL's query looks like a credential; send it as a header instead (Headers). Nothing was sent.");
    return true;
  });
  assert.equal(fake.log.length, 0, "nothing sent");
});

test("on the runner beside a local install, a server saved on loopback at that server's own port (where it listens, or its public address on loopback) is refused unsent, in words; another loopback port is still reached", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const { store, dir } = await storeOn(t);
  const tools = { add: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } };
  await store.mcp.put({ name: "inward", url: fake.url, auth: "none", tools: [{ name: "add", input_schema: tools.add }], sealed: null });
  /** run `runId`'s add on a runner beside a local install whose own addresses are `own`. */
  const addOn = async (runId, own) => {
    await queued(store, runId, { mcpPin: { inward: { url: fake.url, tools: [{ name: "add", inputSchema: tools.add }] } } });
    const claim = await store.claim(runId, "runner-local", { leaseMs: 60_000 });
    const mcp = await mcpForClaim({ redact: heldRedactor(keepText), loopback: true, own, claim, store, sealKey: KEY, grants: ["mcp:inward/add"], harness: { commit: async () => undefined }, work: () => dir });
    t.after(() => mcp.release());
    const add = mcp.tools.find((tool) => tool.name === "mcp__inward__add");
    return (callId) => add.call({ a: 2, b: 3 }, { callId, signal: new AbortController().signal });
  };
  const at = new URL(fake.url);
  const elsewhere = `http://127.0.0.1:${at.port === "1" ? 2 : 1}`;
  // The fake stands where the server beside the runner listens, then where its public address (a local proxy) is.
  for (const [runId, own] of [["run-1", [at.origin]], ["run-2", [elsewhere, `https://localhost:${at.port}`]]]) {
    const call = await addOn(runId, own);
    const sent = fake.log.length;
    assert.deepEqual(await call(`call-${runId}`), { text: `The MCP server inward's address is refused here: the MCP server at ${at.host} is a private address; refused. Nothing was sent.`, isError: true }, runId);
    assert.equal(fake.log.length, sent, `${runId}: the server heard nothing`);
  }
  assert.deepEqual(await (await addOn("run-3", [elsewhere]))("call-3"), { text: "5" }, "a loopback port that isn't the server's own is reached");
});

test("on the runner beside a local install, a token refresh whose authorization server sits at that server's own port is refused unsent, in words, and the call with it; at another loopback port the refresh goes and the call answers", async (t) => {
  const { store, clock, dir } = await storeOn(t);
  const registry = mcpServersOverStore(store, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, "test");
  registry.attach("http://127.0.0.1:9", "http://127.0.0.1:9", true); // key-gate: loopback-rule a local install's own address in a test, never an endpoint
  t.after(() => registry.close());
  const oauth = await startFakeOAuth();
  const fake = await startFakeMcp({ token: oauth.accepts, oauth: oauth.issuer });
  t.after(() => Promise.all([fake.close(), oauth.close()]));
  const started = await registry.oauthStart("docs", { url: fake.url });
  const back = new URL((await fetch(started.authorization_url, { redirect: "manual" })).headers.get("location"));
  await registry.oauthCallback(new URLSearchParams({ code: back.searchParams.get("code"), state: back.searchParams.get("state") }));
  const row = await store.mcp.server("docs");
  const pin = { docs: { url: row.url, tools: row.tools.map(({ input_schema, ...tool }) => ({ ...tool, inputSchema: input_schema })) } };
  const refreshes = () => oauth.log.filter((entry) => entry.path === "/token" && entry.form.grant_type === "refresh_token").length;
  /** run `runId`'s add on a runner beside a local install whose own addresses are `own`, once the access token ran out. */
  const addOn = async (runId, own) => {
    await queued(store, runId, { mcpPin: pin });
    const claim = await store.claim(runId, "runner-local", { leaseMs: 10 * 3_600_000 });
    const mcp = await mcpForClaim({ redact: heldRedactor(keepText), loopback: true, own, claim, store, sealKey: KEY, grants: ["mcp:docs/add"], harness: { commit: async () => undefined }, work: () => dir });
    t.after(() => mcp.release());
    const add = mcp.tools.find((tool) => tool.name === "mcp__docs__add");
    return add.call({ a: 2, b: 3 }, { callId: `call-${runId}`, signal: new AbortController().signal });
  };
  clock.now += 3_600_000 + 1_000;
  oauth.expire();
  const issuer = new URL(oauth.issuer);
  const heard = { oauth: oauth.log.length, mcp: fake.log.length };
  const refused = await addOn("run-1", [issuer.origin]);
  // The words a sign-in's start says of such an endpoint (mcp-oauth.ts checked), after the claim's for a blocked refresh.
  assert.deepEqual(refused, { text: `The MCP server docs's credential can't be used right now: its sign-in server's address is refused here: the authorization server's endpoint ${issuer.origin}/token is a private address; refused.`, isError: true });
  assert.equal(oauth.log.length, heard.oauth, "the authorization server heard nothing");
  assert.equal(refreshes(), 0, "no refresh sent");
  const sent = fake.log.length;
  assert.deepEqual(await addOn("run-2", [`http://127.0.0.1:${issuer.port === "1" ? 2 : 1}`]), { text: "5" }, "an authorization server at a loopback port that isn't the server's own is reached");
  assert.equal(refreshes(), 1, "refreshed once there");
  assert.ok(fake.log.length > sent, "and the call went");
});

test("on the runner beside a local install, a run whose revision has no pin is pinned at its claim by listing its servers; one saved at that server's own port is never listed: nothing sent, nothing pinned, the claim refused in its words for a server it can't list; at another loopback port it is listed, pinned and called", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const { store, dir } = await storeOn(t);
  const tools = { add: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } };
  await store.mcp.put({ name: "inward", url: fake.url, auth: "none", tools: [{ name: "add", input_schema: tools.add }], sealed: null });
  /** a run of a revision saved with no pin, granting inward's add, claimed on a runner beside a local install whose own
   *  addresses are `own`. */
  const claimOn = async (runId, own) => {
    await store.agents.create({ id: `agent-${runId}`, name: `agent-${runId}` }, { id: `rev-${runId}`, kind: "agentic", body: { instructions: "Answer.", tools: ["mcp:inward/add"] } });
    await store.runs.create({ id: runId, agentId: `agent-${runId}`, revisionId: `rev-${runId}` });
    const claim = await store.claim(runId, "runner-local", { leaseMs: 60_000 });
    return mcpForClaim({ redact: heldRedactor(keepText), loopback: true, own, claim, store, sealKey: KEY, grants: ["mcp:inward/add"], harness: { commit: async () => undefined }, work: () => dir });
  };
  const at = new URL(fake.url);
  const sent = fake.log.length;
  await assert.rejects(claimOn("run-1", [at.origin]), (error) => {
    assert.equal(error.message, "The MCP tool mcp:inward/add was not pinned when this agent's revision was saved, so this run cannot call it. Save the agent again to pin it. Nothing was sent.");
    return true;
  });
  assert.equal(fake.log.length, sent, "the server heard nothing: no listing");
  assert.equal((await store.agents.revision("rev-run-1"))?.mcpPin ?? null, null, "nothing pinned");
  const mcp = await claimOn("run-2", [`http://127.0.0.1:${at.port === "1" ? 2 : 1}`]);
  t.after(() => mcp.release());
  assert.ok((await store.agents.revision("rev-run-2"))?.mcpPin?.inward, "listed and pinned");
  const add = mcp.tools.find((tool) => tool.name === "mcp__inward__add");
  assert.deepEqual(await add.call({ a: 2, b: 3 }, { callId: "call-2", signal: new AbortController().signal }), { text: "5" }, "a loopback port that isn't the server's own is reached");
});

test("two runners on one store, one beside a local install and one not: a server saved on loopback is reached by the first alone, the other's runs send it nothing, whatever order they start in", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const { store, dir } = await storeOn(t);
  await store.mcp.put({ name: "local", url: fake.url, auth: "none", tools: [{ name: "add", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }], sealed: null });
  /** run `runId`'s add, on a runner told (or not) that the server beside it is a local install. */
  const addOn = async (runId, runner, loopback) => {
    await queued(store, runId, { mcpPin: { local: { url: fake.url, tools: [{ name: "add", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }] } } });
    const claim = await store.claim(runId, runner, { leaseMs: 60_000 });
    const mcp = await mcpForClaim({ redact: heldRedactor(keepText), claim, store, sealKey: KEY, grants: ["mcp:local/add"], harness: { commit: async () => undefined }, work: () => dir, ...(loopback === undefined ? {} : { loopback }) });
    t.after(() => mcp.release());
    const add = mcp.tools.find((tool) => tool.name === "mcp__local__add");
    return (callId) => add.call({ a: 2, b: 3 }, { callId, signal: new AbortController().signal });
  };
  const local = await addOn("run-1", "runner-local", true);
  const hosted = await addOn("run-2", "runner-hosted", false);
  const unsaid = await addOn("run-3", "runner-unsaid", undefined);
  assert.deepEqual(await local("call-1"), { text: "5" }, "the local install's runner reaches it");
  for (const [call, which] of [[hosted, "a hosted runner"], [unsaid, "a runner told nothing"]]) {
    const sent = fake.log.length;
    const refused = await call(`call-${which}`);
    assert.equal(refused.isError, true, `${which}: ${JSON.stringify(refused)}`);
    assert.match(refused.text, /^The MCP server local's address is refused here: .*Nothing was sent\.$/, which);
    assert.equal(fake.log.length, sent, `${which}: the server heard nothing`);
  }
  // The local runner's call again, after the others': nothing either did moved what the other may reach.
  assert.deepEqual(await local("call-2"), { text: "5" });
  const sent = fake.log.length;
  assert.equal((await hosted("call-again")).isError, true);
  assert.equal(fake.log.length, sent, "and the hosted runner's still sends nothing");
});
