// The owner's private-network OAuth hosts (mcp-private-hosts.ts): an MCP server's authorization server on a private
// network is refused unless the owner listed its host, and even then only over https, only on a private-network range
// (RFC 1918, 100.64/10, fc00::/7), never on loopback, link-local (cloud metadata), unspecified, multicast or broadcast
// addresses, nor this machine's own. The rule is held by the token refresh (refreshed), the sign-in (McpServersOverStore)
// and the runner's claim (mcpClaim), each reading the one setting from the store. The networks here have no socket:
// names resolve from a table, and a request is answered here and recorded with the address it was dialled at. Public
// addresses are RFC 5737's, names RFC 2606's.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const { checkPrivateHosts, MCP_PRIVATE_HOSTS_KEY, PRIVATE_HOSTS_SESSION_ONLY, privateHostsRoute, privateOAuthHosts, savePrivateOAuthHosts } = await import("../dist/mcp-private-hosts.js");
const { refreshed } = await import("../dist/mcp-oauth.js");
const { mcpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { mcpClaim } = await import("../dist/runner/mcp-claim.js");
const { sealMcpCredential } = await import("../dist/store/index.js");
const { UNUSABLE } = await import("../dist/mcp-servers.js");

const AS = "as.corp.test";
const PUBLIC = "192.0.2.10";
const ACCESS = `not-a-secret-${"access"}`;
const REFRESH = `not-a-secret-${"refresh"}`;
const KEY = randomBytes(32);

/** A network with no socket: `names[host]` is what a name resolves to; a request is recorded as [url, address] and
 *  answered with a token or the authorization server's metadata. `local`: this machine's addresses (none by default). */
function networkOf(names, { local = [], metadata = {} } = {}) {
  const dialled = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return {
    dialled,
    lookup: async (host) => {
      const answer = names[host];
      if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return typeof answer === "function" ? answer() : answer;
    },
    fetch: async (url, init, address) => {
      dialled.push([url, address]);
      const at = new URL(url);
      if (at.pathname === "/token") return json({ access_token: `not-a-secret-${"new"}`, token_type: "Bearer", expires_in: 3600 });
      if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") return json({ resource: "https://mcp.example.test/mcp", authorization_servers: [`https://${AS}`] });
      if (at.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: `https://${AS}`, authorization_endpoint: `https://${AS}/authorize`, token_endpoint: `https://${AS}/token`, registration_endpoint: `https://${AS}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], ...metadata });
      if (at.pathname === "/register") return json({ client_id: "corp-client", redirect_uris: ["https://agentrun.example.test/cb"] });
      return new Response("not here", { status: 404 });
    },
    local: () => local,
  };
}

/** A token set whose authorization server's token endpoint is `tokenEndpoint`. */
const setAt = (tokenEndpoint, expiresAt) => ({
  tokens: { access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer" },
  obtained_at: new Date(T0 - 3_600_000).toISOString(),
  ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
  client: { client_id: "corp-client" },
  kind: "dynamic",
  discovery: { authorizationServerUrl: new URL(tokenEndpoint).origin, authorizationServerMetadata: { issuer: new URL(tokenEndpoint).origin, authorization_endpoint: `${new URL(tokenEndpoint).origin}/authorize`, token_endpoint: tokenEndpoint, response_types_supported: ["code"] } },
  resource: "https://mcp.example.test/mcp",
});

const PRIVATE_NETWORK = /is on a private network, refused: an owner can allow (\S+) in Settings → MCP servers/;
const PRIVATE_ADDRESS = /is a private address; refused/;

/** refreshed() against `answers` (what AS resolves to) with `allowed` listed: the outcome and what was dialled. */
async function refreshAgainst(answers, allowed, { endpoint = `https://${AS}/token`, own, local } = {}) {
  const host = new URL(endpoint).hostname;
  const network = networkOf({ [host]: answers }, { local });
  try {
    const set = await refreshed(setAt(endpoint), "https://mcp.example.test/mcp", undefined, network, { allowed, ...(own ? { own } : {}) });
    return { ok: set.tokens.access_token, dialled: network.dialled };
  } catch (error) {
    return { refused: error.message, dialled: network.dialled };
  }
}

test("the rule table: a listed host on a private network is dialled at the address checked; unlisted, it is refused naming the host and where to allow it", async () => {
  for (const address of ["10.20.30.40", "172.16.5.4", "192.168.7.8", "100.64.1.2", "fd12:3456::7", "::ffff:10.20.30.40"]) {
    const listed = await refreshAgainst([address], [AS]);
    assert.ok(listed.ok, `${address} listed: ${listed.refused}`);
    assert.deepEqual(listed.dialled, [[`https://${AS}/token`, address]], `${address}: dialled at the address checked`);
    const unlisted = await refreshAgainst([address], []);
    assert.match(unlisted.refused ?? "", PRIVATE_NETWORK, `${address} unlisted`);
    assert.equal(PRIVATE_NETWORK.exec(unlisted.refused)[1], AS, "the words name the host to allow");
    assert.deepEqual(unlisted.dialled, [], `${address} unlisted: nothing sent`);
  }
  // Another host listed is not this one.
  assert.match((await refreshAgainst(["10.20.30.40"], ["other.corp.test"])).refused ?? "", PRIVATE_NETWORK);
});

test("the rule table: loopback, link-local (cloud metadata), unspecified, multicast, broadcast and reserved addresses are refused even when listed, in the private-address words, and nothing is sent", async () => {
  for (const address of [
    "127.0.0.1", // key-gate: denylist a loopback address a listed host must still be refused at
    "169.254.169.254", // key-gate: denylist the link-local metadata address a listed host must still be refused at
    "::ffff:169.254.169.254", "::ffff:127.0.0.1", "fe80::1", "::1", "::", "0.0.0.0", "255.255.255.255", "224.0.0.1", "ff02::1", "198.18.0.1", "fec0::1",
  ]) {
    const out = await refreshAgainst([address], [AS]);
    assert.match(out.refused ?? "", PRIVATE_ADDRESS, `${address} listed`);
    assert.doesNotMatch(out.refused, /an owner can allow/, `${address}: listing could never help, so the words do not offer it`);
    assert.deepEqual(out.dialled, [], `${address}: nothing sent`);
  }
});

test("the rule table: every address a name resolves to must pass; one public and one private is refused unlisted and dialled listed; one private and one link-local is refused listed", async () => {
  const mixed = [PUBLIC, "10.20.30.40"];
  const unlisted = await refreshAgainst(mixed, []);
  assert.match(unlisted.refused ?? "", PRIVATE_NETWORK);
  assert.deepEqual(unlisted.dialled, []);
  const listed = await refreshAgainst(mixed, [AS]);
  assert.ok(listed.ok, listed.refused);
  assert.deepEqual(listed.dialled, [[`https://${AS}/token`, PUBLIC]], "dialled at an address it checked");
  const worse = await refreshAgainst(["10.20.30.40", "169.254.169.254"], [AS]); // key-gate: denylist a link-local address mixed into a listed host's answer
  assert.match(worse.refused ?? "", PRIVATE_ADDRESS);
  assert.deepEqual(worse.dialled, []);
});

test("the rule table: a listed host is still held to https; this machine's own addresses and this server's are refused even when listed", async (t) => {
  // A sign-in whose listed authorization server names a plain-http endpoint: refused in the check's words.
  const { store } = await storeOn(t);
  await savePrivateOAuthHosts(store, [AS]);
  const network = networkOf({ "mcp.example.test": [PUBLIC], [AS]: ["10.20.30.40"] }, { metadata: { authorization_endpoint: `http://${AS}/authorize` } });
  const registry = mcpServersOverStore(store, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, "test", network);
  registry.attach("https://agentrun.example.test", "http://agentrun.example.test:7340");
  await assert.rejects(registry.oauthStart("corp", { url: "https://mcp.example.test/mcp" }), (error) => /the authorization server's authorization endpoint is not https; refused\.$/.test(error.message));
  assert.ok(!network.dialled.some(([url]) => url.endsWith("/register")), "nothing registered");
  // A refresh at a plain-http token endpoint is refused unsent (by this check or the SDK's own TLS rule).
  const http = await refreshAgainst(["10.20.30.40"], [AS], { endpoint: `http://${AS}/token` });
  assert.ok(http.refused);
  assert.deepEqual(http.dialled, []);
  const local = await refreshAgainst(["10.20.30.40"], [AS], { local: ["10.20.30.40"] });
  assert.match(local.refused ?? "", PRIVATE_ADDRESS, "an address on this machine");
  const mapped = await refreshAgainst(["::ffff:10.20.30.40"], [AS], { local: ["10.20.30.40"] });
  assert.match(mapped.refused ?? "", PRIVATE_ADDRESS, "an address on this machine, IPv4-mapped");
  const own = await refreshAgainst(["10.20.30.40"], [AS], { own: ["http://10.20.30.40:7340"] });
  assert.match(own.refused ?? "", PRIVATE_ADDRESS, "this server's own address");
  assert.deepEqual([...local.dialled, ...mapped.dialled, ...own.dialled], []);
});

test("the rule table: hosts compare lowercase with every final dot gone; an IP literal is listed as its URL host", async () => {
  const upper = await refreshAgainst(["10.20.30.40"], [AS], { endpoint: "https://AS.Corp.TEST../token" });
  assert.ok(upper.ok, upper.refused);
  const literal = await refreshAgainst(undefined, ["[fd12:3456::7]"], { endpoint: "https://[fd12:3456:0::7]/token" });
  assert.ok(literal.ok, literal.refused);
  const v4 = await refreshAgainst(undefined, ["10.20.30.40"], { endpoint: "https://10.20.30.40/token" });
  assert.ok(v4.ok, v4.refused);
  assert.match((await refreshAgainst(undefined, [], { endpoint: "https://10.20.30.40/token" })).refused ?? "", /an owner can allow 10\.20\.30\.40 in/);
});

test("checkPrivateHosts: the list as kept (lowercase, final dots gone, IPv6 in its URL form, repeats once), and every bad entry refused in words", () => {
  assert.deepEqual(checkPrivateHosts({ hosts: [] }), []);
  assert.deepEqual(checkPrivateHosts({ hosts: ["AS.Corp.test.", "as.corp.test", "10.20.30.40", "fd12:3456:0::7", "[FD12:3456::8]", "100.64.1.2"] }), ["as.corp.test", "10.20.30.40", "[fd12:3456::7]", "[fd12:3456::8]", "100.64.1.2"]);
  const refusal = (hosts) => {
    try {
      checkPrivateHosts(typeof hosts === "object" && !Array.isArray(hosts) ? hosts : { hosts });
    } catch (error) {
      assert.equal(error.code, "input_invalid");
      return error.extra.fields;
    }
    assert.fail(`accepted ${JSON.stringify(hosts)}`);
  };
  for (const [entry, words] of [
    ["*.corp.test", /wildcard/],
    ["https://as.corp.test", /has a scheme/],
    ["10.0.0.0/8", /no address ranges \(CIDR\)/],
    ["as.corp.test/token", /no address ranges \(CIDR\) or paths/],
    ["as.corp.test:8443", /has a port/],
    ["", /1 to 253 characters/],
    ["a".repeat(254), /1 to 253 characters/],
    ["under_score.test", /not a host name/],
    ["-dash.test", /not a host name/],
    ["10.1", /write it as 10\.0\.0\.1/],
    ["localhost", /can't be allowed/],
    ["127.0.0.1", /can't be allowed/], // key-gate: denylist a loopback address the owner's list refuses
    ["169.254.169.254", /can't be allowed/], // key-gate: denylist the link-local metadata address the owner's list refuses
    ["fe80::1", /can't be allowed/],
    ["::1", /can't be allowed/],
    ["0.0.0.0", /can't be allowed/],
    ["255.255.255.255", /can't be allowed/],
    [PUBLIC, /nothing to allow/],
    [7, /as text/],
  ]) {
    const fields = refusal([entry]);
    assert.equal(fields[0].field, "hosts[0]", JSON.stringify(entry));
    assert.match(fields[0].message, words, JSON.stringify(entry));
  }
  assert.match(refusal(Array.from({ length: 33 }, (_, i) => `h${i}.corp.test`))[0].message, /at most 32 hosts/);
  assert.equal(refusal({ hosts: "as.corp.test" })[0].field, "hosts");
  assert.equal(refusal({})[0].reason, "missing");
  assert.equal(refusal({ hosts: [], extra: 1 })[0].field, "extra");
});

test("the setting lives in the store's settings under one key; a row of another shape reads as none allowed", async (t) => {
  const { store } = await storeOn(t);
  assert.deepEqual(await privateOAuthHosts(store), [], "refused by default");
  await savePrivateOAuthHosts(store, [AS]);
  assert.deepEqual(await store.settings.get(MCP_PRIVATE_HOSTS_KEY), { hosts: [AS] });
  assert.deepEqual(await privateOAuthHosts(store), [AS]);
  await store.settings.put(MCP_PRIVATE_HOSTS_KEY, [AS]);
  assert.deepEqual(await privateOAuthHosts(store), [], "fail closed");
});

test("a sign-in reads the setting from the store: unlisted, it does not start and says where to allow the host; listed, it starts at the private address", async (t) => {
  const { store } = await storeOn(t);
  const network = networkOf({ "mcp.example.test": [PUBLIC], [AS]: ["10.20.30.40"] });
  const registry = mcpServersOverStore(store, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, "test", network);
  registry.attach("https://agentrun.example.test", "http://agentrun.example.test:7340");
  await assert.rejects(registry.oauthStart("corp", { url: "https://mcp.example.test/mcp" }), (error) => error.code === "upstream_failed" && /The sign-in to https:\/\/mcp\.example\.test did not start: the authorization server's .* is on a private network, refused: an owner can allow as\.corp\.test in Settings → MCP servers\.$/.test(error.message));
  assert.ok(!network.dialled.some(([, address]) => address === "10.20.30.40"), "nothing sent to the private address");
  await savePrivateOAuthHosts(store, [AS]);
  const started = await registry.oauthStart("corp", { url: "https://mcp.example.test/mcp" });
  assert.equal(new URL(started.authorization_url).origin, `https://${AS}`);
  assert.ok(network.dialled.some(([url, address]) => url === `https://${AS}/register` && address === "10.20.30.40"), "registration went to the listed host's private address");
});

test("the runner's refresh reads the setting from the store: unlisted, the call is refused unsent naming the host to allow; listed, the refreshed token is handed over", async (t) => {
  const { store } = await storeOn(t);
  const url = "https://mcp.example.test/mcp";
  const set = setAt(`https://${AS}/token`, T0 - 1_000);
  await store.mcp.put({ name: "corp", url, auth: "oauth", tools: [{ name: "add", inputSchema: { type: "object" } }], sealed: sealMcpCredential(KEY, "corp", { type: "oauth", set }, url) });
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const network = networkOf({ [AS]: ["10.20.30.40"] });
  const claimOf = () => mcpClaim({ store, claim, grants: ["mcp:corp/add"], sealKey: KEY, signal: new AbortController().signal, bounds: { requestMs: 500, tries: 2 }, now: () => T0, network });

  const refused = await claimOf();
  assert.equal(refused.credentials.corp?.headers, undefined);
  assert.match(refused.credentials.corp?.unopened ?? "", new RegExp(`^${UNUSABLE.blocked}: .*is on a private network, refused: an owner can allow as\\.corp\\.test in Settings → MCP servers$`));
  assert.deepEqual(network.dialled, [], "nothing sent");
  refused.release();

  await savePrivateOAuthHosts(store, [AS]);
  const listed = await claimOf();
  assert.equal(listed.credentials.corp?.headers?.authorization, `Bearer not-a-secret-${"new"}`);
  assert.deepEqual(network.dialled, [[`https://${AS}/token`, "10.20.30.40"]]);
  listed.release();
});

test("the route: GET reads the list (none by default); a PUT not from the owner's signed-in page is 403 before its body is read and changes nothing; bad input is 422 in words; a PUT from the page replaces the list in the store", async (t) => {
  const { store } = await storeOn(t);
  const registry = mcpServersOverStore(store, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, "test");
  assert.deepEqual(await privateHostsRoute(registry, { method: "GET" }), { hosts: [] }, "refused by default");

  let read = 0;
  const body = (value) => async () => (read++, value);
  await assert.rejects(privateHostsRoute(registry, { method: "PUT", body: body({ hosts: [AS] }), bySession: false }), (error) => error.code === "forbidden" && error.message === PRIVATE_HOSTS_SESSION_ONLY);
  assert.equal(read, 0, "a token's body is never read");
  assert.match(PRIVATE_HOSTS_SESSION_ONLY, /owner's password sign-in in the console, never a token/);
  assert.deepEqual(await privateOAuthHosts(store), [], "nothing changed");

  await assert.rejects(privateHostsRoute(registry, { method: "PUT", body: body({ hosts: ["*.corp.test", "as.corp.test:8443", "169.254.169.254"] }), bySession: true }), (error) => { // key-gate: denylist the link-local metadata address the route refuses
    assert.equal(error.code, "input_invalid");
    assert.deepEqual(error.extra.fields.map((field) => field.field), ["hosts[0]", "hosts[1]", "hosts[2]"]);
    assert.match(error.extra.fields[2].message, /can't be allowed/);
    return true;
  });
  assert.deepEqual(await privateOAuthHosts(store), [], "nothing changed");

  assert.deepEqual(await privateHostsRoute(registry, { method: "PUT", body: body({ hosts: ["AS.Corp.test.", "fd12:3456::7"] }), bySession: true }), { hosts: [AS, "[fd12:3456::7]"] });
  assert.deepEqual(await store.settings.get(MCP_PRIVATE_HOSTS_KEY), { hosts: [AS, "[fd12:3456::7]"] }, "kept in the store's settings");
  assert.deepEqual(await privateHostsRoute(registry, { method: "GET" }), { hosts: [AS, "[fd12:3456::7]"] });
  assert.deepEqual(await privateHostsRoute(registry, { method: "PUT", body: body({ hosts: [] }), bySession: true }), { hosts: [] });
});
