// MCP's secret writes through the server's one gate (secret-writes.ts, in the dispatch): a saved server's PUT that carries
// a bearer token is the owner's session's alone (the token gets 403 in SECRET_WRITE_REFUSAL and nothing is kept). The
// token saves over only a server it saved (mcp-secret-writes.ts tokenWriteOverRefused): its edit of the owner's server,
// prices alone, is 403 too and the row stays as it was; a new server that takes no credential, and its own edits of it,
// are the token's to make.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { call, serve, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const json = { "content-type": "application/json" };
const TOKEN = `not-a-secret-${randomBytes(12).toString("hex")}`;

test("a token's PUT of a bearer token is 403 in the one refusal and keeps nothing; the owner's session saves it; the token edits only the servers it saved", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { SECRET_WRITE_REFUSAL } = await import("../dist/secret-writes.js");
  const { tokenWriteOverWords } = await import("../dist/mcp-secret-writes.js");
  const { asOwner } = await import("./support.mjs");
  const server = await serve(t, { runner: false });
  const fake = await startFakeMcp({ token: TOKEN });
  const open = await startFakeMcp();
  t.after(() => Promise.all([fake.close(), open.close()]));
  const bearer = { authorization: `Bearer ${server.token}` };
  const put = (name, body) => call(server.port, { method: "PUT", path: `/v2/settings/mcp-servers/${name}`, headers: { ...json, ...bearer }, body });

  const byToken = await put("fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(byToken.status, 403, byToken.text);
  assert.ok(String(byToken.json?.error?.message).startsWith(SECRET_WRITE_REFUSAL));
  assert.ok(!byToken.text.includes(TOKEN), "the refusal never echoes the value");
  assert.equal((await call(server.port, { path: "/v2/settings/mcp-servers/fake", headers: bearer })).status, 404, "nothing was kept");
  assert.equal(fake.log.length, 0, "nothing was sent to the MCP server");

  const owner = asOwner(server);
  const asked = new Date().toISOString();
  const saved = await owner("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  const answered = new Date().toISOString();
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const { changed_at: changed, ...secret } = saved.body.secret;
  assert.deepEqual(secret, { name: "mcp:fake", set: true, source: "console" });
  // The credential's own time is this save's: an ISO instant between the request and its answer.
  assert.match(changed, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `changed_at is an ISO time: ${changed}`);
  assert.ok(asked <= changed && changed <= answered, `changed_at ${changed} is the save's time (${asked} .. ${answered})`);

  // The owner's server stays the owner's: the token's edit of its prices alone, the sealed token kept, is refused in
  // words naming the server, with the console's Change form for it, and nothing of the row changes.
  const before = (await call(server.port, { path: "/v2/settings/mcp-servers/fake", headers: bearer })).json;
  const prices = await put("fake", { url: fake.url, auth: { type: "bearer" }, prices: { add: 0.01 } });
  assert.equal(prices.status, 403, `a token's edit of the owner's server is refused: ${prices.text}`);
  assert.ok(String(prices.json?.error?.message).startsWith(tokenWriteOverWords("fake", true)));
  assert.match(String(prices.json?.error?.message), /Use another name, or change it from the owner's signed-in session\. Finish it in the console: /, "a server with an owner's session sends the caller there");
  assert.match(String(prices.json?.error?.details?.console_url), /[#&?]change=fake\b/, "the link opens the server's Change form");
  assert.deepEqual((await call(server.port, { path: "/v2/settings/mcp-servers/fake", headers: bearer })).json, before, "the owner's row is as it was");
  const owners = await owner("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer" }, prices: { add: 0.01 } });
  assert.equal(owners.status, 200, `the owner's session edits the prices, the sealed token kept: ${JSON.stringify(owners.body)}`);
  assert.deepEqual(owners.body.prices, { add: 0.01 }, "the prices kept, served on the read");
  assert.ok(!(owners.body.not_metered ?? []).includes("add"), "add is metered now");

  const none = await put("open", { url: open.url, auth: { type: "none" } });
  assert.equal(none.status, 200, `a token saves a server that takes no credential: ${none.text}`);
  const own = await put("open", { url: open.url, auth: { type: "none" }, prices: { add: 0.02 } });
  assert.equal(own.status, 200, `the token edits a server it saved: ${own.text}`);
  assert.deepEqual(own.json.prices, { add: 0.02 });
});
