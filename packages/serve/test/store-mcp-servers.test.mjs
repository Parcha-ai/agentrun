// The owner's MCP registry over the store (mcp-servers-store.ts): a read shows the auth's header names, the credential's
// state, the OAuth note and whether a sign-in expired, all opened from the one sealed blob; never the credential itself.
// The probe round-trips (preview/save/refresh against a live server) are covered by the integration test once the switch
// wires this in; here the view is seeded through the store primitive, and the validation refusals are checked before any
// probe. A real store on a temp file.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { mcpServersOverStore } from "../dist/mcp-servers-store.js";
import { saveMcpServer } from "../dist/mcp-store.js";

const KEY = Buffer.from(randomBytes(32));
const env = (key = KEY) => ({ AGENTRUN_SEAL_KEY: Buffer.from(key).toString("base64") });
const reg = (store, e = env()) => mcpServersOverStore(store, e, "1.0.0");
const ACCESS = `not-a-secret-${"access"}`;
const oauthSet = (over = {}) => ({ tokens: { access_token: ACCESS, scope: "repo issues" }, obtained_at: "2026-11-09T00:00:00.000Z", expires_at: "2026-11-09T01:00:00.000Z", client: { client_id: "cli-1" }, kind: "dynamic", discovery: {}, ...over });

test("a headers server reads: auth header names (not values), credential sealed, tools gated, prices/not_metered, server_info + instructions; never the credential", async (t) => {
  const { store } = await storeOn(t);
  await saveMcpServer(store, KEY, {
    name: "github", url: "https://mcp.example.com/github", auth: "headers", protocol: "2025-06-18",
    tools: [{ name: "create_issue" }, { name: "list_repos" }], prices: { create_issue: 0.01 },
    serverInfo: { name: "GitHub", version: "1" }, instructions: "Use create_issue.",
    credential: { type: "headers", headers: { authorization: "Bearer gh-secret", "x-extra": "v" } },
  });
  const view = await reg(store).get("github");
  assert.equal(view.name, "github");
  assert.deepEqual(view.auth, { type: "headers", headers: ["authorization", "x-extra"] }, "header names, never values");
  assert.equal(view.credential, "sealed");
  assert.deepEqual(view.server_info, { name: "GitHub", version: "1" });
  assert.equal(view.instructions, "Use create_issue.");
  assert.deepEqual(view.not_metered, ["list_repos"], "the unpriced tool is called out");
  assert.ok(view.tools.every((tool) => "permission" in tool), "each tool carries its gate permission");
  assert.ok(view.listed_at && view.updated_at, "both timestamps present");
  assert.ok(!JSON.stringify(view).includes("gh-secret"), "the credential is never in the view");
});

test("a none-auth server reads credential null and no header names", async (t) => {
  const { store } = await storeOn(t);
  await saveMcpServer(store, KEY, { name: "public", url: "https://mcp.example.com/public", auth: "none", tools: [] });
  const view = await reg(store).get("public");
  assert.equal(view.credential, null);
  assert.deepEqual(view.auth, { type: "none" });
  const list = await reg(store).list();
  assert.deepEqual(list.servers.map((s) => s.name), ["public"]);
});

test("an oauth server reads its note from the sealed token set; an expired sign-in reads credential expired", async (t) => {
  const { store } = await storeOn(t);
  await saveMcpServer(store, KEY, { name: "linear", url: "https://mcp.example.com/linear", auth: "oauth", protocol: "2025-06-18", tools: [], credential: { type: "oauth", set: oauthSet() } });
  const view = await reg(store).get("linear");
  assert.equal(view.credential, "sealed");
  assert.deepEqual(view.oauth, { expires_at: "2026-11-09T01:00:00.000Z", scopes: ["repo", "issues"], client: "dynamic", client_id: "cli-1" });
  assert.ok(!JSON.stringify(view).includes(ACCESS), "the access token is never in the view");
  // A sign-in the runner marked expired (expired:true inside the sealed credential).
  await saveMcpServer(store, KEY, { name: "linear", url: "https://mcp.example.com/linear", auth: "oauth", protocol: "2025-06-18", tools: [], credential: { type: "oauth", set: oauthSet(), expired: true } });
  assert.equal((await reg(store).get("linear")).credential, "expired");
});

test("a credential under another seal key reads unreadable; with no seal key it reads seal_key_missing", async (t) => {
  const { store } = await storeOn(t);
  await saveMcpServer(store, KEY, { name: "github", url: "https://mcp.example.com/github", auth: "headers", tools: [], credential: { type: "headers", headers: { authorization: "Bearer x" } } });
  assert.equal((await reg(store, env(randomBytes(32))).get("github")).credential, "unreadable", "another key: unreadable");
  assert.equal((await reg(store, {}).get("github")).credential, "seal_key_missing", "no key: seal_key_missing");
});

test("remove drops the server; an unknown server is not_found on get and remove", async (t) => {
  const { store } = await storeOn(t);
  await saveMcpServer(store, KEY, { name: "github", url: "https://mcp.example.com/github", auth: "none", tools: [] });
  await reg(store).remove("github");
  assert.equal(await store.mcp.server("github"), undefined, "gone");
  await assert.rejects(() => reg(store).get("nope"), (e) => e.code === "not_found");
  await assert.rejects(() => reg(store).remove("nope"), (e) => e.code === "not_found");
});

test("save, preview and oauthStart refuse a bad body before any network probe", async (t) => {
  const { store } = await storeOn(t);
  const r = reg(store);
  await assert.rejects(() => r.save("github", { url: "not a url" }), (e) => e.code === "input_invalid" && e.extra.fields.some((f) => f.field === "url"));
  await assert.rejects(() => r.save("BAD NAME", { url: "https://x.example", auth: { type: "none" } }), (e) => e.code === "input_invalid" && e.extra.fields[0].field === "name");
  await assert.rejects(() => r.preview({ url: "https://x.example/", auth: { type: "bearer" } }), (e) => e.code === "input_invalid" && e.extra.fields.some((f) => f.field === "auth.token"));
  await assert.rejects(() => r.oauthStart("github", { url: "https://x.example", scopes: [] }), (e) => e.code === "input_invalid" && e.extra.fields.some((f) => f.field === "scopes"));
  await assert.rejects(() => r.oauthStart("github", { url: "https://x.example", client_secret: `not-a-secret-${"client"}` }), (e) => e.code === "input_invalid" && e.extra.fields.some((f) => f.field === "client_id"));
});

test("a header server with no seal key is refused a save (never kept in the clear)", async (t) => {
  const { store } = await storeOn(t);
  await assert.rejects(() => reg(store, {}).save("github", { url: "https://x.example/", auth: { type: "headers", headers: { authorization: "Bearer x" } } }), (e) => e.code === "no_sealing_key");
});
