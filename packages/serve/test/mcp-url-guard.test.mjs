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
import { asOwner, serve, withEnv } from "./support.mjs";
import { queued, storeOn } from "./store-helpers.mjs";

const { mcpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { savePrivateOAuthHosts } = await import("../dist/mcp-private-hosts.js");
const { mcpForClaim } = await import("../dist/runner/mcp-run.js");

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

test("loopback is a local install's alone: a server listening on loopback with no public address saves a loopback MCP server; one with a public address refuses it at the preview and the save, and it hears nothing", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const local = await serve(t, { runner: false });
  const saved = await local.api("PUT", "/settings/mcp-servers/here", { url: fake.url, auth: { type: "none" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const heard = fake.log.length;
  assert.ok(heard > 0, "the local install listed its tools");

  const hosted = await serve(t, { runner: false, publicUrl: "https://agents.example.test" });
  const host = new URL(fake.url).host;
  for (const [who, api] of [["a token", hosted.api], ["the owner", asOwner(hosted)]]) {
    refusedOnUrl(await api("POST", "/settings/mcp-servers/preview", { url: fake.url, auth: { type: "none" } }), privateAddress(host), `${who}'s preview`);
    refusedOnUrl(await api("PUT", "/settings/mcp-servers/here", { url: fake.url, auth: { type: "none" } }), privateAddress(host), `${who}'s save`);
    for (const url of [fake.url.replace("127.0.0.1", "localhost"), `http://[::1]:${new URL(fake.url).port}/mcp`]) { // key-gate: loopback-rule the loopback names a hosted server refuses
      refusedOnUrl(await api("PUT", "/settings/mcp-servers/here", { url, auth: { type: "none" } }), privateAddress(new URL(url).host), `${who}'s save of ${url}`);
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
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const mcp = await mcpForClaim({ claim, store, sealKey: KEY, grants: ["mcp:corp/add"], harness: { commit: async () => undefined }, work: () => dir, network });
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
