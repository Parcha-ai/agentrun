// MCP's secret writes through the server's one gate (secret-writes.ts, in the dispatch): a saved server's PUT that carries
// a bearer token is the owner's session's alone (the token gets 403 in SECRET_WRITE_REFUSAL and nothing is kept); a PUT
// that carries none (auth none, or prices with the sealed credential kept) is still the token's to make.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { call, serve, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const json = { "content-type": "application/json" };
const TOKEN = `not-a-secret-${randomBytes(12).toString("hex")}`;

test("a token's PUT of a bearer token is 403 in the one refusal and keeps nothing; the owner's session saves it; the token's edits of non-secret fields go through", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { SECRET_WRITE_REFUSAL } = await import("../dist/secret-writes.js");
  const { asOwner } = await import("./support.mjs");
  const server = await serve(t, { runner: false });
  const fake = await startFakeMcp({ token: TOKEN });
  const open = await startFakeMcp();
  t.after(() => Promise.all([fake.close(), open.close()]));
  const bearer = { authorization: `Bearer ${server.token}` };
  const put = (name, body) => call(server.port, { method: "PUT", path: `/v2/settings/mcp-servers/${name}`, headers: { ...json, ...bearer }, body });

  const byToken = await put("fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(byToken.status, 403, byToken.text);
  assert.equal(byToken.json?.error?.message, SECRET_WRITE_REFUSAL);
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

  const prices = await put("fake", { url: fake.url, auth: { type: "bearer" }, prices: { add: 0.01 } });
  assert.equal(prices.status, 200, `a token edits the prices, the sealed token kept: ${prices.text}`);
  assert.deepEqual(prices.json.prices, { add: 0.01 }, "the prices kept, served on the read");
  assert.ok(!(prices.json.not_metered ?? []).includes("add"), "add is metered now");
  const none = await put("open", { url: open.url, auth: { type: "none" } });
  assert.equal(none.status, 200, `a token saves a server that takes no credential: ${none.text}`);
});
