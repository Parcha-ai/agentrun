// The workspace public-https MCP mode (AGENTRUN_API_ONLY_WORKSPACE_MCP_PUBLIC_HTTPS=1, the serve README's API-only
// section): on an API-only server, a workspace's token saves a per_run MCP server at any https origin, not only at the
// operator's AGENTRUN_API_ONLY_MCP_ORIGINS. Such a server is held to mcp-oauth.ts publicMcpServerAt at every request,
// its save, preview and refresh and each request of a run's calls: its name resolved then, every address public, the
// connection pinned to the address checked, never a private host the owner allows nor loopback on a local install, no
// cloud metadata name, no redirect followed. Headers, a bearer token, Composio and the token with no header stay at the
// list's origins, and with the setting off everything is as before. The networks here have no socket but the fake MCP
// server's (and a redirecting one on loopback): a refused address is never dialled. Public addresses are RFC 5737's,
// names RFC 2606's.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { serve } from "./support.mjs";
import { storeOn } from "./store-helpers.mjs";

const { mcpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { savePrivateOAuthHosts } = await import("../dist/mcp-private-hosts.js");
const { mcpForClaim } = await import("../dist/runner/mcp-run.js");
const { heldRedactor, keepText } = await import("../dist/runner/redact.js");
const { mcpRowKey, mcpView, requestNames } = await import("../dist/mcp-workspace.js");
const { inWorkspace } = await import("../dist/workspace-scope.js");
const { holdApiOnlyMcpOrigins, offApiOnlyMcpOrigins, offApiOnlyMcpOriginsWords } = await import("../dist/mcp-api-only-origins.js");
const { apiOnlyMcpPreview, apiOnlyMcpSave, apiOnlyRefusal } = await import("../dist/api-only.js");
const { mcpSourceKey, storedSource } = await import("../dist/mcp-sources.js");
const { sealRunMcpAuth } = await import("../dist/store/index.js");
const { saveMcpServer } = await import("../dist/mcp-store.js");

const KEY = randomBytes(32);
const W1 = "org:w1";
const SCOPED = randomBytes(24).toString("hex");
const OPERATOR = randomBytes(24).toString("hex");
const PUBLIC = "192.0.2.10";
const LISTED = "https://listed.example.com";
const PATH = "/settings/mcp-servers/contextforge";
const privateAddress = (host) => `The MCP server at ${host} is a private address; refused.`;
const add = (callId) => ({ callId, signal: new AbortController().signal });

/** Each refused class by the addresses in it: v4, v6, and the IPv4-mapped IPv6 form of the v4 ones. */
const REFUSED = {
  loopback: ["127.0.0.1", "127.45.6.7", "::1", "::ffff:127.0.0.1"],
  private: ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.1", "fc00::1", "fd12:3456::5", "::ffff:10.1.2.3", "::ffff:172.16.0.1", "::ffff:192.168.1.1"],
  "link-local": ["169.254.169.254", "169.254.1.1", "fe80::1", "::ffff:169.254.169.254"], // key-gate: denylist refused test targets
  cgnat: ["100.64.0.1", "100.127.255.254", "::ffff:100.64.0.1"],
  "this network": ["0.0.0.0", "0.1.2.3", "::", "::ffff:0.0.0.0"],
  "aws v6 metadata": ["fd00:ec2::254"], // key-gate: denylist a refused test target
};
const METADATA = ["metadata.google.internal", "metadata.goog", "metadata", "instance-data", "instance-data.ec2.internal", "METADATA.Google.Internal."];

/** A network whose names answer `names[host]` (a function: each lookup's answer) and whose only sockets are `routes`
 *  (host to the base URL it reaches, on loopback): a request is recorded as [url, address] and sent there; one to any
 *  other host is never sent. */
function routed(names, routes) {
  const dialled = [];
  const looked = [];
  const reach = (url, init, address) => {
    dialled.push([url, address]);
    const at = new URL(url);
    const to = routes[at.hostname];
    if (!to) return Promise.reject(new Error(`no socket for ${at.host}`));
    return fetch(`${to}${at.pathname}${at.search}`, init);
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

/** A loopback server that answers every request with a 307 to `to`. */
async function redirecting(t, to) {
  const server = createServer((req, res) => res.writeHead(307, { location: to }).end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A store holding the API-only list `origins` with the mode on (`publicHttps`), and the server's registry over it as a
 *  request sees it, on `network`, attached as a local install (loopback allowed to everything else). */
async function registryOn(t, network, { origins = [LISTED], publicHttps = true } = {}) {
  const { store, dir } = await storeOn(t);
  await holdApiOnlyMcpOrigins(store, true, origins, publicHttps);
  const registry = mcpServersOverStore(mcpView(store, requestNames), { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, "test", network);
  registry.attach("https://agents.example.test", "http://agents.example.test:7340", true);
  t.after(() => registry.close());
  return { store, dir, registry };
}

/** The token's save of a per_run server `name` at `url` in W1, as the route makes it. */
const savedInW1 = (registry, name, url) => inWorkspace(W1, () => registry.save(name, { url, auth: { type: "per_run" } }, undefined, undefined, undefined, undefined, undefined, undefined, true));

/** A refusal on url alone, in `words`. */
const refusedOnUrl = (words) => (error) => {
  assert.equal(error.code, "input_invalid", error.message);
  assert.deepEqual(error.extra.fields.map((field) => [field.field, field.reason, field.message]), [["url", "not_allowed", words]]);
  return true;
};

test("every refused class, v4, v6 and IPv4-mapped, by a name that resolves to it and as a literal address in the URL: refused at a workspace's save and preview under the mode, nothing dialled, on a local install whose owner allows the host", async (t) => {
  const names = {};
  const cases = [];
  let at = 0;
  for (const [kind, addresses] of Object.entries(REFUSED)) {
    for (const address of addresses) {
      const host = `h${(at += 1)}.example.test`;
      names[host] = [address];
      cases.push([kind, address, `https://${host}/mcp`, host]);
      const literal = address.includes(":") ? `[${address}]` : address;
      const url = new URL(`https://${literal}/mcp`);
      cases.push([kind, `${address} as written`, url.href, url.host]);
    }
  }
  const network = routed(names, {});
  const { store, registry } = await registryOn(t, network);
  // The owner allows every one of those names: the mode's servers stand on none of the owner's list.
  await savePrivateOAuthHosts(store, Object.keys(names));
  for (const [kind, address, url, host] of cases) {
    await assert.rejects(savedInW1(registry, "inside", url), refusedOnUrl(privateAddress(host)), `${kind} ${address}: the save`);
    await assert.rejects(inWorkspace(W1, () => registry.preview({ url, auth: { type: "per_run" } })), refusedOnUrl(privateAddress(host)), `${kind} ${address}: the preview`);
  }
  assert.deepEqual(network.dialled, [], "nothing dialled");
  assert.deepEqual(await store.mcp.servers(), [], "nothing saved");
});

test("the cloud metadata names are refused by name under the mode, before their name is looked up, whatever they would resolve to", async (t) => {
  const network = routed(Object.fromEntries(METADATA.map((host) => [host.toLowerCase().replace(/\.$/, ""), [PUBLIC]])), {});
  const { registry } = await registryOn(t, network);
  for (const host of METADATA) {
    const url = `https://${host}/computeMetadata/v1/`;
    const shown = new URL(url).host;
    await assert.rejects(savedInW1(registry, "meta", url), refusedOnUrl(`The MCP server at ${shown} is a cloud metadata service; refused.`), host);
  }
  assert.deepEqual([network.looked, network.dialled], [[], []], "nothing looked up or dialled");
});

test("a name the owner allows on a private network: under the mode a workspace's save there is refused; the owner's own save outside a workspace on the same store reaches it as before", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const network = routed({ "corp.example.test": ["10.20.30.40"] }, { "corp.example.test": fake.url.replace(/\/mcp$/, "") });
  const { store, registry } = await registryOn(t, network);
  await savePrivateOAuthHosts(store, ["corp.example.test"]);
  await assert.rejects(savedInW1(registry, "corp", "https://corp.example.test/mcp"), refusedOnUrl(privateAddress("corp.example.test")));
  assert.deepEqual(network.dialled, [], "the workspace's save sent nothing");
  const owners = await registry.save("corp", { url: "https://corp.example.test/mcp", auth: { type: "none" } });
  assert.ok(owners.tools.length > 0, "the owner's own server lists as before");
  assert.ok(network.dialled.every(([, address]) => address === "10.20.30.40"));
});

test("a public https name saves under the mode, dialled at the address checked: a name that answers inward after its check is never dialled there; its refresh and preview by name check again and refuse it once it resolves inward", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  // The first lookup answers public, every later one inward: the save's one check and its pinned dials.
  const answers = [[PUBLIC]];
  const network = routed({ "rebind.example.test": () => answers.shift() ?? ["10.20.30.40"] }, { "rebind.example.test": fake.url.replace(/\/mcp$/, "") });
  const { store, registry } = await registryOn(t, network);
  await savePrivateOAuthHosts(store, ["rebind.example.test"]);
  const saved = await savedInW1(registry, "srv", "https://rebind.example.test/mcp");
  assert.ok(saved.tools.some((tool) => tool.name === "add"), JSON.stringify(saved));
  assert.ok(network.dialled.length > 0 && network.dialled.every(([, address]) => address === PUBLIC), JSON.stringify(network.dialled));
  assert.equal(network.looked.length, 1, "one lookup: every request of the save went to the address it checked");
  assert.ok(await store.mcp.server(mcpRowKey("srv", W1)), "kept in W1's own row");
  const before = network.dialled.length;
  await assert.rejects(inWorkspace(W1, () => registry.refresh("srv")), refusedOnUrl(privateAddress("rebind.example.test")), "the refresh");
  await assert.rejects(inWorkspace(W1, () => registry.preview({ name: "srv" })), refusedOnUrl(privateAddress("rebind.example.test")), "the preview by name");
  assert.equal(network.dialled.length, before, "nothing sent once it resolves inward");
});

test("a redirect is never followed under the mode: at the save it is 422 redirect, and in a run the call fails; the address it points to (loopback) hears nothing", async (t) => {
  const fake = await startFakeMcp();
  // Where the redirect points: a server nothing else sends to, so any request it hears is a redirect followed.
  const target = await startFakeMcp();
  t.after(() => Promise.all([fake.close(), target.close()]));
  const bounce = await redirecting(t, target.url);
  let to = fake.url.replace(/\/mcp$/, "");
  const network = routed({ "hop.example.test": [PUBLIC] }, {});
  network.dial = network.fetch = (url, init, address) => {
    network.dialled.push([url, address]);
    const at = new URL(url);
    return fetch(`${to}${at.pathname}${at.search}`, init);
  };
  const { store, dir, registry } = await registryOn(t, network);
  // Saved while it answers; it redirects from the next request on.
  await savedInW1(registry, "srv", "https://hop.example.test/mcp");
  to = bounce;
  await assert.rejects(savedInW1(registry, "again", "https://hop.example.test/mcp"), (error) => {
    assert.equal(error.code, "input_invalid", error.message);
    assert.equal(error.extra.fields[0].reason, "redirect");
    return true;
  });
  assert.deepEqual(target.log, [], "the save followed no redirect");

  for (const [what, request] of [
    ["the preview by url", () => inWorkspace(W1, () => registry.preview({ url: "https://hop.example.test/mcp", auth: { type: "per_run" } }, undefined, true))],
    ["the preview by name", () => inWorkspace(W1, () => registry.preview({ name: "srv" }, undefined, true))],
    ["the refresh", () => inWorkspace(W1, () => registry.refresh("srv"))],
  ]) {
    await assert.rejects(request(), (error) => {
      assert.equal(error.code, "input_invalid", `${what}: ${error.message}`);
      assert.equal(error.extra.fields[0].reason, "redirect", what);
      return true;
    });
    assert.deepEqual(target.log, [], `${what} followed no redirect`);
  }

  const { call } = await w1Run(t, store, dir, network, "srv", "https://hop.example.test/mcp");
  const answer = await call("call-1");
  assert.equal(answer.isError, true, JSON.stringify(answer));
  assert.deepEqual(target.log, [], "the run's call followed no redirect");
});

test("a redirect is never followed in a workspace's sign-in discovery under the mode: the protected-resource metadata a 401 names, the authorization server's metadata, and the metadata the listing's own 401 probe reads each answer 307 to loopback, and loopback hears nothing", async (t) => {
  // Where every redirect points: a server nothing else sends to, so any request it hears is a redirect followed.
  const heardByTarget = [];
  const target = createServer((req, res) => (heardByTarget.push(req.url), res.writeHead(404).end()));
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => target.close(resolve)));
  const away = `http://127.0.0.1:${target.address().port}/elsewhere`;
  const ORIGIN = "https://disc.example.test";
  let variant;
  const heard = [];
  const server = createServer((req, res) => {
    heard.push(req.url);
    const json = (body) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url.startsWith("/.well-known/oauth-protected-resource")) return variant === "authorization server metadata" ? json({ resource: `${ORIGIN}/mcp`, authorization_servers: [`${ORIGIN}/as`] }) : res.writeHead(307, { location: away }).end();
    if (req.url.startsWith("/.well-known/oauth-authorization-server") || req.url.startsWith("/.well-known/openid-configuration") || req.url.startsWith("/as/.well-known/")) return variant === "authorization server metadata" ? res.writeHead(307, { location: away }).end() : res.writeHead(404).end();
    res.writeHead(401, { "www-authenticate": variant === "the listing's 401 probe" ? "Bearer" : `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"` }).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const network = routed({ "disc.example.test": [PUBLIC] }, { "disc.example.test": `http://127.0.0.1:${server.address().port}` });
  const { registry } = await registryOn(t, network);
  const seen = [];
  for (const [name, asked] of [["protected-resource metadata", /^\/\.well-known\/oauth-protected-resource/], ["authorization server metadata", /^\/(as\/)?\.well-known\/(oauth-authorization-server|openid-configuration)/], ["the listing's 401 probe", /^\/\.well-known\/oauth-protected-resource/]]) {
    variant = name;
    heard.length = 0;
    await assert.rejects(inWorkspace(W1, () => registry.preview({ url: `${ORIGIN}/mcp`, auth: { type: "per_run" } }, undefined, true)), (error) => {
      assert.equal(error.code, "auth_required", `${name}: ${error.message}`);
      return true;
    });
    seen.push({ name, asked: heard.some((path) => asked.test(path)), followed: heardByTarget.splice(0).length });
  }
  assert.deepEqual(seen, ["protected-resource metadata", "authorization server metadata", "the listing's 401 probe"].map((name) => ({ name, asked: true, followed: 0 })));
});

/** A W1 agent whose revision pins `name`'s add (as W1's row lists it), a run of it handed its own per_run header, claimed
 *  on a runner beside a local install (loopback allowed to everything else), and its add. */
async function w1Run(t, store, dir, network, name, url, runId = "run-1") {
  const row = await store.mcp.server(mcpRowKey(name, W1));
  const tools = row.tools.map(({ input_schema, ...tool }) => ({ ...tool, inputSchema: input_schema }));
  await store.agents.create({ id: `agent-${runId}`, name: `a-${runId}`, workspace: W1 }, { id: `rev-${runId}`, kind: "agentic", body: {}, mcpPin: { [name]: { url, tools } } });
  await store.runs.create({ id: runId, agentId: `agent-${runId}`, revisionId: `rev-${runId}` }, { body: { input: { content: "go" }, title: "go", place: { mode: "runner" } }, sealed: sealRunMcpAuth(KEY, runId, { [name]: { headers: { authorization: "Bearer run-own" }, origin: new URL(url).origin } }) });
  const claim = await store.claim(runId, "runner-a", { leaseMs: 600_000 });
  const mcp = await mcpForClaim({ redact: heldRedactor(keepText), loopback: true, claim, store, sealKey: KEY, grants: [`mcp:${name}/add`], harness: { commit: async () => undefined }, work: () => dir, network });
  t.after(() => mcp.release());
  const tool = mcp.tools.find((one) => one.name === `mcp__${name}__add`);
  assert.ok(tool, `granted: ${mcp.tools.map((one) => one.name)}`);
  return { mcp, call: (callId) => tool.call({ a: 2, b: 3 }, add(callId)) };
}

test("DNS rebinding at run time: a workspace's server saved public under the mode is checked again at every request of a run's calls; once its name resolves inward (a host the owner allows, loopback beside a local install, mapped, metadata, or one inward answer among public ones) the call is refused unsent, and it goes again once the name is public", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  let answer = [PUBLIC];
  const network = routed({ "rebind.example.test": () => answer }, { "rebind.example.test": fake.url.replace(/\/mcp$/, "") });
  const { store, dir, registry } = await registryOn(t, network);
  const url = "https://rebind.example.test/mcp";
  await savedInW1(registry, "srv", url);
  await savePrivateOAuthHosts(store, ["rebind.example.test"]);
  const { call } = await w1Run(t, store, dir, network, "srv", url);
  assert.deepEqual(await call("call-public"), { text: "5" }, "a public address is called");
  assert.ok(network.dialled.every(([, address]) => address === PUBLIC));
  for (const inward of [["10.20.30.40"], ["127.0.0.1"], ["::ffff:10.20.30.40"], ["::ffff:127.0.0.1"], ["169.254.169.254"], ["fd00:ec2::254"], [PUBLIC, "10.20.30.41"]]) { // key-gate: denylist refused test targets
    answer = inward;
    const heard = fake.log.length;
    const dialled = network.dialled.length;
    assert.deepEqual(await call(`call-${inward.join("-")}`), { text: `The MCP server srv's address is refused here: the MCP server at rebind.example.test is a private address; refused. Nothing was sent.`, isError: true }, inward.join(","));
    assert.equal(fake.log.length, heard, `${inward}: the server heard nothing`);
    assert.equal(network.dialled.length, dialled, `${inward}: nothing dialled`);
  }
  answer = [PUBLIC];
  assert.deepEqual(await call("call-public-again"), { text: "5" }, "public again: called");
});

test("at run time a workspace's own server under the mode is held to the stricter rule when the owner's shared server has the same name: the run's call follows its own row, as its claim does", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  let answer = [PUBLIC];
  const base = fake.url.replace(/\/mcp$/, "");
  const network = routed({ "rebind.example.test": () => answer, "shared.example.test": [PUBLIC] }, { "rebind.example.test": base, "shared.example.test": base });
  const { store, dir, registry } = await registryOn(t, network);
  await registry.save("srv", { url: "https://shared.example.test/mcp", auth: { type: "none" } });
  const url = "https://rebind.example.test/mcp";
  await savedInW1(registry, "srv", url);
  await savePrivateOAuthHosts(store, ["rebind.example.test"]);
  const { call } = await w1Run(t, store, dir, network, "srv", url);
  assert.deepEqual(await call("call-public"), { text: "5" });
  answer = ["10.20.30.40"];
  const dialled = network.dialled.length;
  assert.deepEqual(await call("call-inward"), { text: "The MCP server srv's address is refused here: the MCP server at rebind.example.test is a private address; refused. Nothing was sent.", isError: true });
  assert.equal(network.dialled.length, dialled, "nothing dialled");
});

test("rebinding inside one request at run time: a name that answers public to one lookup and inward to the next is dialled at the address its check saw, never at a second answer", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  let flip = false;
  const answers = [];
  const network = routed({ "flip.example.test": () => { flip = !flip; const answer = flip ? [PUBLIC] : ["10.20.30.40"]; answers.push(answer[0]); return answer; } }, { "flip.example.test": fake.url.replace(/\/mcp$/, "") });
  const { store, dir, registry } = await registryOn(t, network);
  const url = "https://flip.example.test/mcp";
  await savedInW1(registry, "srv", url);
  const { call } = await w1Run(t, store, dir, network, "srv", url);
  const from = network.dialled.length;
  const looked = answers.length;
  for (const callId of ["call-1", "call-2", "call-3"]) {
    const result = await call(callId);
    assert.ok(result.text === "5" || (result.isError === true && /is a private address; refused\. Nothing was sent\.$/.test(result.text)), JSON.stringify(result));
  }
  assert.ok(answers.length > looked && answers.slice(looked).includes("10.20.30.40"), "the name answered inward during the run");
  assert.ok(network.dialled.length > from, "the run dialled");
  assert.deepEqual(network.dialled.slice(from).filter(([, address]) => address !== PUBLIC), [], "every dial went to the public address a check saw");
});

test("at run time the stricter rule is a workspace's mode server's alone: the owner's shared server on the same store, at a host the owner allows on a private network, is called there as before", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const network = routed({ "corp.example.test": ["10.20.30.40"] }, { "corp.example.test": fake.url.replace(/\/mcp$/, "") });
  const { store, dir, registry } = await registryOn(t, network);
  await savePrivateOAuthHosts(store, ["corp.example.test"]);
  const url = "https://corp.example.test/mcp";
  await registry.save("corp", { url, auth: { type: "none" } });
  const row = await store.mcp.server("corp");
  await store.agents.create({ id: "agent-shared", name: "shared" }, { id: "rev-shared", kind: "agentic", body: {}, mcpPin: { corp: { url, tools: row.tools.map(({ input_schema, ...tool }) => ({ ...tool, inputSchema: input_schema })) } } });
  await store.runs.create({ id: "run-shared", agentId: "agent-shared", revisionId: "rev-shared" });
  const claim = await store.claim("run-shared", "runner-a", { leaseMs: 600_000 });
  const mcp = await mcpForClaim({ redact: heldRedactor(keepText), claim, store, sealKey: KEY, grants: ["mcp:corp/add"], harness: { commit: async () => undefined }, work: () => dir, network });
  t.after(() => mcp.release());
  assert.deepEqual(await mcp.tools.find((one) => one.name === "mcp__corp__add").call({ a: 2, b: 3 }, add("call-1")), { text: "5" });
  assert.equal(network.dialled.at(-1)[1], "10.20.30.40");
});

test("a call's rule is the one its claim opened: a workspace's mode server stays strict for the whole call when its row is removed mid-call (the owner's shared server of that name left) or the mode is turned off mid-call, so a request after it to a host the owner allows on a private network is refused unsent", async (t) => {
  const seen = [];
  for (const change of ["row removed", "mode off"]) {
    const fake = await startFakeMcp();
    t.after(() => fake.close());
    const base = fake.url.replace(/\/mcp$/, "");
    let armed = false;
    let looks = 0;
    let store;
    const network = routed({
      "midcall.example.test": async () => {
        if (!armed) return [PUBLIC];
        looks += 1;
        if (looks > 1) return ["10.20.30.40"];
        if (change === "row removed") await store.mcp.remove(mcpRowKey("srv", W1));
        else await holdApiOnlyMcpOrigins(store, true, [LISTED], false);
        return [PUBLIC];
      },
      "shared.example.test": [PUBLIC],
    }, { "midcall.example.test": base, "shared.example.test": base });
    const opened = await registryOn(t, network);
    store = opened.store;
    if (change === "row removed") await opened.registry.save("srv", { url: "https://shared.example.test/mcp", auth: { type: "none" } });
    const url = "https://midcall.example.test/mcp";
    await savedInW1(opened.registry, "srv", url);
    await savePrivateOAuthHosts(store, ["midcall.example.test"]);
    const { call } = await w1Run(t, store, opened.dir, network, "srv", url);
    const from = network.dialled.length;
    armed = true;
    const result = await call(`call-${change}`);
    seen.push({ change, requestAfterChange: looks >= 2, privateDials: network.dialled.slice(from).filter(([, address]) => address !== PUBLIC).length, isError: result.isError === true });
  }
  assert.deepEqual(seen, ["row removed", "mode off"].map((change) => ({ change, requestAfterChange: true, privateDials: 0, isError: true })));
});

test("a workspace's preview under the mode that a server answers 401 for OAuth discovers its sign-in under the same rule: a name that answers a host the owner allows on a private network at the discovery is refused there, nothing sent", async (t) => {
  let after = false;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/.well-known/")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: "https://signin.example.test/mcp", authorization_servers: ["https://signin.example.test"] }));
    res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="https://signin.example.test/.well-known/oauth-protected-resource/mcp"' }).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const signIn = async (scoped) => {
    after = false;
    const network = routed({ "signin.example.test": () => { const answer = after ? ["10.20.30.40"] : [PUBLIC]; after = true; return answer; } }, { "signin.example.test": `http://127.0.0.1:${server.address().port}` });
    const { store, registry } = await registryOn(t, network);
    await savePrivateOAuthHosts(store, ["signin.example.test"]);
    const body = { url: "https://signin.example.test/mcp", auth: { type: "per_run" } };
    await assert.rejects(scoped ? inWorkspace(W1, () => registry.preview(body, undefined, true)) : registry.preview(body), (error) => {
      assert.equal(error.code, "auth_required", error.message);
      assert.equal(error.extra.details.auth, "oauth");
      return true;
    });
    assert.ok(network.looked.length >= 2, `the discovery looked the name up again (${network.looked.length})`);
    return network.dialled.filter(([, address]) => address !== PUBLIC).map(([, address]) => address);
  };
  assert.deepEqual(await signIn(true), [], "the workspace's: nothing dialled at the private address");
  // The control: the owner's own preview, unscoped, discovers on the owner's rule as before, at the host it allows.
  assert.ok((await signIn(false)).includes("10.20.30.40"), "the owner's: its discovery reaches the host the owner allows");
});

test("the claim: a workspace's per_run server the token saved at an https origin off the list is usable while the store holds the mode, and refused in the off-list words once it does not; a shared one, a sealed one and a plain-http one stay refused", async (t) => {
  const { store } = await storeOn(t);
  const save = async (key, url, auth = "per_run", sealed = null) => {
    await store.mcp.put({ name: key, url, auth, tools: [], sealed });
    await store.settings.put(mcpSourceKey(key), storedSource({ source: "url", toolkit: null }, await store.mcp.server(key), false, true));
    return store.mcp.server(key);
  };
  const own = mcpRowKey("srv", W1);
  const ownRow = await save(own, "https://public.example.test/mcp");
  const shared = await save("shared", "https://public.example.test/mcp");
  const plain = await save(mcpRowKey("plain", W1), "http://public.example.test/mcp");
  const view = mcpView(store, requestNames);
  // W1's own server with headers the token sealed in its row, at the same origin.
  await inWorkspace(W1, () => saveMcpServer(view, KEY, { name: "sealed", url: "https://public.example.test/mcp", auth: "headers", tools: [], credential: { type: "headers", headers: { authorization: "Bearer sealed" } } }));
  await store.settings.put(mcpSourceKey(mcpRowKey("sealed", W1)), storedSource({ source: "url", toolkit: null }, await store.mcp.server(mcpRowKey("sealed", W1)), false, true));
  const asW1 = (name) => inWorkspace(W1, async () => offApiOnlyMcpOrigins(view, name, await view.mcp.server(name)));
  await holdApiOnlyMcpOrigins(store, true, [LISTED], true);
  assert.equal(await asW1("srv"), undefined, "W1's own, as a run's view reads it");
  assert.equal(await offApiOnlyMcpOrigins(store, own, ownRow), undefined, "W1's own, by its row key");
  assert.equal(await offApiOnlyMcpOrigins(store, "shared", shared), offApiOnlyMcpOriginsWords("shared"), "a shared one");
  assert.equal(await asW1("plain"), offApiOnlyMcpOriginsWords("plain"), "plain http");
  assert.equal(await asW1("sealed"), offApiOnlyMcpOriginsWords("sealed"), "headers sealed in W1's row");
  await holdApiOnlyMcpOrigins(store, true, [LISTED]);
  assert.equal(await asW1("srv"), offApiOnlyMcpOriginsWords("srv"), "the mode off: off the list");
  assert.equal(await offApiOnlyMcpOrigins(store, plain.name, plain), offApiOnlyMcpOriginsWords(plain.name));
});

test("the gates: under the mode a workspace's save takes per_run at any https address alone; http, another scheme, headers, a bearer token, a Composio name, no workspace and the mode off take the list as before", () => {
  const body = (url, auth = { type: "per_run" }) => ({ url, auth });
  const open = "https://mcp.example.com/mcp";
  assert.equal(apiOnlyMcpSave(body(open), false, [LISTED], true, true), true, "per_run, https, in a workspace");
  assert.equal(apiOnlyMcpSave(body(open), false, [], true, true), true, "with no list at all");
  for (const url of ["http://mcp.example.com/mcp", "ftp://mcp.example.com/mcp", "ws://mcp.example.com/mcp", "file:///etc/passwd", "not a url"]) {
    assert.equal(apiOnlyMcpSave(body(url), false, [LISTED], true, true), false, url);
    assert.equal(apiOnlyMcpPreview(body(url), [LISTED], true), false, `preview ${url}`);
  }
  assert.equal(apiOnlyMcpSave(body(open, { type: "headers", headers: { authorization: "Bearer x" } }), false, [LISTED], true, true), false, "headers");
  assert.equal(apiOnlyMcpSave(body(open, { type: "bearer", token: "x" }), false, [LISTED], true, true), false, "bearer");
  assert.equal(apiOnlyMcpSave(body(open), true, [LISTED], true, true), false, "a Composio preset's name");
  assert.equal(apiOnlyMcpSave(body(open), false, [LISTED], false, true), false, "no workspace");
  assert.equal(apiOnlyMcpSave(body(open), false, [LISTED], true, false), false, "the mode off");
  assert.equal(apiOnlyMcpSave(body(open), false, [], true, false), false, "the mode off, no list");
  assert.equal(apiOnlyMcpSave(body(`${LISTED}/mcp`, { type: "headers", headers: {} }), false, [LISTED], true, true), true, "headers at a listed origin, as before");
  assert.equal(apiOnlyMcpPreview(body(open), [LISTED], true), true, "preview per_run");
  assert.equal(apiOnlyMcpPreview({ url: open }, [LISTED], true), true, "preview with no credential");
  assert.equal(apiOnlyMcpPreview(body(open, { type: "bearer", token: "x" }), [LISTED], true), false, "preview bearer");
  assert.equal(apiOnlyMcpPreview(body(open), [LISTED], false), false, "preview, the mode off");
});

/** An API-only server whose MCP origin is one fake gateway's, the mode `on` or off, with the scoped token in W1 (`w1`) and
 *  the operator's unscoped one (`ops`). */
async function served(t, on) {
  const listed = await startFakeMcp();
  const other = await startFakeMcp();
  t.after(() => Promise.all([listed.close(), other.close()]));
  const server = await serve(t, { apiOnly: true, apiOnlyMcpOrigins: [new URL(listed.url).origin], ...(on ? { workspaceMcpPublicHttps: true } : {}), tokens: [{ id: "v2", token: SCOPED }, { id: "ops", token: OPERATOR }], workspaceTokens: ["v2"] });
  const w1 = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${SCOPED}`, "agentrun-workspace": W1 });
  const ops = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${OPERATOR}` });
  return { server, listed, other, w1, ops };
}

const notServed = (answer, path = PATH) => assert.deepEqual([answer.status, answer.body.error?.message], [404, apiOnlyRefusal(`/v2${path}`)], JSON.stringify(answer.body));

test("the routes under the mode: http and other schemes, headers and a bearer token off the list, and the token with no header are the refused route's 404; an https address on loopback (this test server allows loopback) is 422 at url, nothing sent; the listed origin saves as before", async (t) => {
  const s = await served(t, true);
  const loopback = new URL(s.other.url);
  for (const url of ["http://mcp.example.com/mcp", "ftp://mcp.example.com/mcp"]) {
    notServed(await s.w1("PUT", PATH, { url, auth: { type: "per_run" } }));
    notServed(await s.w1("POST", "/settings/mcp-servers/preview", { url, auth: { type: "per_run" } }), "/settings/mcp-servers/preview");
  }
  notServed(await s.w1("PUT", PATH, { url: "https://mcp.example.com/mcp", auth: { type: "headers", headers: { authorization: "Bearer x" } } }));
  notServed(await s.w1("PUT", PATH, { url: "https://mcp.example.com/mcp", auth: { type: "bearer", token: "x" } }));
  notServed(await s.ops("PUT", PATH, { url: "https://mcp.example.com/mcp", auth: { type: "per_run" } }));
  for (const host of [`127.0.0.1:${loopback.port}`, `localhost:${loopback.port}`, `[::1]:${loopback.port}`]) {
    for (const [method, path] of [["PUT", PATH], ["POST", "/settings/mcp-servers/preview"]]) {
      const refused = await s.w1(method, path, { url: `https://${host}/mcp`, auth: { type: "per_run" } });
      assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.fields?.map((field) => [field.field, field.reason, field.message])], [422, "input_invalid", [["url", "not_allowed", privateAddress(host)]]], `${method} ${host}: ${JSON.stringify(refused.body)}`);
    }
  }
  assert.equal(s.other.log.length, 0, "the loopback server heard nothing");
  const saved = await s.w1("PUT", PATH, { url: s.listed.url, auth: { type: "per_run" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await s.ops("GET", "/capabilities")).body.switches.AGENTRUN_API_ONLY_WORKSPACE_MCP_PUBLIC_HTTPS.on, true);
});

test("the mode off: a workspace's per_run save at an https origin off the list is the refused route's 404 as before, nothing sent, and the switch reads off", async (t) => {
  const s = await served(t, false);
  const offList = `https://127.0.0.1:${new URL(s.other.url).port}/mcp`;
  notServed(await s.w1("PUT", PATH, { url: offList, auth: { type: "per_run" } }));
  notServed(await s.w1("POST", "/settings/mcp-servers/preview", { url: offList, auth: { type: "per_run" } }), "/settings/mcp-servers/preview");
  assert.equal(s.other.log.length, 0, "nothing sent");
  assert.equal((await s.w1("PUT", PATH, { url: s.listed.url, auth: { type: "per_run" } })).status, 200, "the listed origin saves");
  assert.equal((await s.ops("GET", "/capabilities")).body.switches.AGENTRUN_API_ONLY_WORKSPACE_MCP_PUBLIC_HTTPS.on, false);
});
