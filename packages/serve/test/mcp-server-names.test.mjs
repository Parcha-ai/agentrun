// GET /v2/settings/mcp-server-names: the names of the MCP servers saved here, and nothing else of them (no URL, header,
// token or Composio record), with the server's token, also on an API-only server, which serves no other settings route.
// A host that builds runs from saved servers reads it to hold back a job whose server isn't saved here, before its launch
// is refused for it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { serve } from "./support.mjs";

const SECRET = "names-route-sealed-header-value-0001";
/** A value the export scan reads as no secret, as api-only.test.mjs spells its wrong token. */
const notSecret = (name) => `not-a-secret-${name}`;

/** One request to `server` (its path from the root, with `authorization` when given): its status, body and raw text. */
async function send(server, path, authorization) {
  const res = await fetch(`${server.url}${path}`, { redirect: "manual", headers: authorization ? { authorization } : {} });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body: body ?? text, text };
}

test("an API token reads the saved servers' names, also on an API-only server; never a URL or a header; no token, or a wrong one, is 401", async (t) => {
  const upstream = await startFakeMcp({ token: SECRET });
  t.after(() => upstream.close());
  const whole = await serve(t, { runner: false });
  const empty = await send(whole, "/v2/settings/mcp-server-names", `Bearer ${whole.token}`);
  assert.deepEqual([empty.status, empty.body], [200, { names: [] }], "none saved: an empty list");
  for (const name of ["mail-reader", "crm"]) {
    const saved = await whole.api("PUT", `/settings/mcp-servers/${name}`, { url: upstream.url, auth: { type: "headers", headers: { authorization: `Bearer ${SECRET}` } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  const listed = await send(whole, "/v2/settings/mcp-server-names", `Bearer ${whole.token}`);
  assert.deepEqual([listed.status, listed.body], [200, { names: ["crm", "mail-reader"] }], "each saved server once, by name, sorted");
  await whole.stop();

  const server = await serve(t, { apiOnly: true, runner: false, data: whole.data });
  const names = await send(server, "/v2/settings/mcp-server-names", `Bearer ${server.token}`);
  assert.deepEqual([names.status, names.body], [200, { names: ["crm", "mail-reader"] }], `the API-only server serves it: ${names.text}`);
  const host = new URL(upstream.url).host;
  for (const value of [SECRET, upstream.url, host, "headers", "authorization"]) assert.equal(names.text.includes(value), false, `the answer holds no ${value}`);
  // Beside it, the full list (URLs, auth types, tools) stays refused on the API-only server.
  assert.equal((await send(server, "/v2/settings/mcp-servers", `Bearer ${server.token}`)).status, 404, "the full list is not served API-only");
  for (const [authorization, why] of [[undefined, "no token"], [`Bearer ${notSecret("token")}`, "a wrong token"]]) {
    const refused = await send(server, "/v2/settings/mcp-server-names", authorization);
    assert.equal(refused.status, 401, `${why}: ${refused.text}`);
    assert.equal(refused.text.includes("mail-reader") || refused.text.includes("crm"), false, `${why}: no name in the refusal`);
  }
});
