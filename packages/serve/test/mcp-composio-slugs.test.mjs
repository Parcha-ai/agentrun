// The Composio preset reads a toolkit's tools at its latest version, every page: the picker (POST .../composio/tools)
// lists what Composio serves today, not only its base version (00000000_00, which leaves out tools added since: linear
// 21 of 48, stripe 33 of 435, live 11-18), and a save (PUT .../{name}/composio) refuses a slug Composio doesn't list
// before it makes anything there. The fake Composio (fixtures/fake-composio.mjs) lists a toolkit's `latest` tools only
// with toolkit_versions=latest, and pages its list with `toolsPage`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { secretWritePath, serve } from "./support.mjs";

secretWritePath(["POST"], /^\/settings\/mcp-servers\/composio\/tools$/);
secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const tool = (slug) => ({ slug, name: slug, description: `${slug}.` });
// The fake MCP server Composio's address leads to serves add, slow_write, delete_thing and paid (fake-mcp-server.mjs).
const BASE = [tool("add"), tool("paid")];
const LATEST = [tool("delete_thing")];
const TOOLKITS = {
  hackernews: { no_auth: true, tools: BASE, latest: LATEST },
  linear: { no_auth: false, tools: [tool("LINEAR_LIST_LINEAR_ISSUES")], latest: [tool("LINEAR_LIST_ISSUES_BY_TEAM_ID")] },
};

async function setup(t, options = {}) {
  const composio = await startFakeComposio({ toolkits: TOOLKITS, ...options });
  t.after(() => composio.close());
  const server = await serve(t, { composioControl: { baseUrl: composio.baseUrl } });
  return { composio, server, api: server.api };
}
const save = (s, name, tools) => s.api("PUT", `/settings/mcp-servers/${name}/composio`, { api_key: s.composio.apiKey, toolkit: "hackernews", tools });
/** Whether Composio was asked to make anything: any call but a read. */
const writes = (s) => s.composio.calls.filter((call) => call.method !== "GET");

test("the picker lists a tool only the toolkit's latest version has", async (t) => {
  const s = await setup(t);
  const res = await s.api("POST", "/settings/mcp-servers/composio/tools", { api_key: s.composio.apiKey, toolkit: "linear" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.tools.map((t) => t.slug), ["LINEAR_LIST_LINEAR_ISSUES", "LINEAR_LIST_ISSUES_BY_TEAM_ID"]);
  for (const call of s.composio.to("/api/v3/tools")) assert.equal(call.query.toolkit_versions, "latest", "the tool list is asked at the latest version");
});

test("a save naming a slug Composio doesn't list is 422 under tools, naming it, and nothing is made at Composio", async (t) => {
  const s = await setup(t);
  const res = await save(s, "hn", ["add", "ADD", "HACKERNEWS_GONE"]);
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "input_invalid");
  assert.deepEqual(res.body.error.fields.map((f) => [f.field, f.reason]), [["tools", "not_found"]]);
  const message = res.body.error.fields[0].message;
  assert.match(message, /\bADD \(did you mean add\?\)/, "the listed slug in another case is named");
  assert.match(message, /\bHACKERNEWS_GONE:/, "a slug no listed one matches but for case is named without a guess");
  assert.doesNotMatch(message, /\badd\b(?! ?\?)/, "a slug it lists is not named as missing");
  assert.deepEqual(writes(s), [], "no auth config, MCP server or connect link was made");
  assert.equal((await s.api("GET", "/settings/mcp-servers/hn")).status, 404, "nothing is saved");
});

test("a slug that differs from a listed one by more than case gets no guess", async (t) => {
  const s = await setup(t);
  // ad is a letter short of add, delete a _WORD short of delete_thing: neither is the listed slug in another case.
  const res = await save(s, "hn", ["ad", "delete"]);
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.deepEqual(res.body.error.fields.map((f) => [f.field, f.reason]), [["tools", "not_found"]]);
  const message = res.body.error.fields[0].message;
  assert.doesNotMatch(message, /did you mean/, "only a slug that differs by case alone gets a guess");
  assert.match(message, /has no action ad or delete: /, "the slugs are named, joined by or");
  assert.deepEqual(writes(s), []);
});

test("a save whose slugs all exist, one of them only at the latest version, goes on as before", async (t) => {
  const s = await setup(t);
  const res = await save(s, "hn", ["add", "delete_thing"]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.not_served, undefined, "every granted action is served");
  assert.deepEqual(s.composio.to("/api/v3.1/mcp/servers/custom", "POST")[0].body.allowed_tools, ["add", "delete_thing"]);
  assert.equal((await s.api("GET", "/settings/mcp-servers/hn")).status, 200, "it is saved");
});

test("paging: a slug on a later page of the tool list counts, and one on no page is refused", async (t) => {
  const s = await setup(t, { toolsPage: 1 });
  const res = await save(s, "hn", ["delete_thing", "paid"]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const read = s.composio.to("/api/v3/tools");
  assert.deepEqual(read.map((call) => call.query.cursor), [undefined, "1", "2"], "the save read every page");
  assert.ok(read.every((call) => call.query.toolkit_versions === "latest"));

  const missing = await setup(t, { toolsPage: 1 });
  const refused = await save(missing, "hn", ["paid", "slow_write"]);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(refused.body.error.fields[0].message, /slow_write/);
  assert.deepEqual(writes(missing), []);
});

test("a list longer than its page limit refuses nothing past what it read: the save reads 10 pages and the check after it names the action", async (t) => {
  // 11 actions, one a page: the 11th is past the 10 pages the save reads. The fake MCP server serves `add`, not ACTION_11.
  const eleven = [tool("add"), ...Array.from({ length: 10 }, (_, i) => tool(`ACTION_${i + 2}`))];
  const s = await setup(t, { toolkits: { hackernews: { no_auth: true, tools: eleven } }, toolsPage: 1 });
  const res = await save(s, "hn", ["add", "ACTION_11"]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const read = s.composio.to("/api/v3/tools");
  assert.deepEqual(read.map((call) => call.query.cursor), [undefined, "1", "2", "3", "4", "5", "6", "7", "8", "9"], "exactly 10 pages were read");
  assert.deepEqual(res.body.not_served, ["ACTION_11"], "the check after the save names the action its server leaves out");
  assert.deepEqual(s.composio.to("/api/v3.1/mcp/servers/custom", "POST")[0].body.allowed_tools, ["add", "ACTION_11"]);
});

test("a slug is at most 128 characters: one past it is 422 invalid under tools before Composio is asked anything", async (t) => {
  const s = await setup(t);
  const at = await save(s, "hn", ["add", "A".repeat(128)]);
  assert.equal(at.status, 422, JSON.stringify(at.body));
  assert.deepEqual(at.body.error.fields.map((f) => [f.field, f.reason]), [["tools", "not_found"]], "128 characters is not refused for its length, only as not listed");
  assert.ok(at.body.error.fields[0].message.includes("A".repeat(128)), "it is named whole");

  const past = await setup(t);
  const res = await save(past, "hn", ["add", "A".repeat(129)]);
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.deepEqual(res.body.error.fields.map((f) => [f.field, f.reason]), [["tools", "invalid"]], "129 characters is refused at the input check");
  assert.deepEqual(past.composio.calls, [], "Composio was asked nothing");
});
