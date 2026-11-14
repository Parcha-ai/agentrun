// Where a template's MCP tools come from (templates/README.md, "mcp"): a package names each by its source and toolkit
// ({source: composio | github | url, toolkit}), never by the name an owner saves a server under, and names its tools
// mcp:<toolkit>/<tool> inside. A saved MCP server records its own {source, toolkit}: the Composio preset sets composio and
// its toolkit, a server on the GitHub App is github/github, any other is url with the toolkit the owner gives it. Apply
// maps each need to the saved server whose record matches (the owner picks when several do) and rewrites the exact
// prefix mcp:<toolkit>/ to mcp:<server>/ in the agent it makes. Also here: the display-only category and tags, and the
// examples/ folder, checked and never applied.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sourceOf, storedSource } from "../dist/mcp-sources.js";
import { PackageError, packageView, readPackage } from "../dist/templates.js";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";
import { scratch, secretWritePath, serve, withEnv } from "./support.mjs";

// The Composio preset takes the owner's session, as the console sends it.
secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const MANIFEST = `---
name: notes-digest
version: 1.0.0
description: Reads your notes and sends one on.
category: research
tags: [notes, digest]
mcp:
  - source: url
    toolkit: notes
    tools: [list_notes, send_note]
    required: false
    reason: "Reads your notes and sends the digest on."
    allow: [list_notes]
    pin: { send_note: { to: "\${parameters.to}" } }
parameters:
  to: { type: string, description: "where the digest goes" }
---
Call mcp:notes/list_notes, then mcp:notes/send_note once. The text xmcp:notes/list_notes is not a tool name.
`;
const SKILL = "---\nname: digest\ndescription: How to digest notes.\n---\nRead with mcp:notes/list_notes first.\n";

/** The notes-digest package written under a fresh folder, `change` applied to its files first: its folder. */
async function notesPackage(t, change = () => {}) {
  const root = join(await scratch(t), "templates");
  const dir = join(root, "notes-digest");
  const files = { "agent.md": MANIFEST, "skills/digest/SKILL.md": SKILL, "report.schema.json": JSON.stringify({ type: "object", required: ["summary"], properties: { summary: { type: "string", contentMediaType: "text/markdown" } } }), "examples/monday/input.json": JSON.stringify({ content: "Digest this week's notes." }), "examples/monday/output.json": JSON.stringify({ summary: "Three notes." }), "examples/monday/output.md": "Three notes.\n" };
  files["agent.md"] = files["agent.md"].replace("parameters:", "output: { schema: report.schema.json }\nparameters:");
  change(files);
  for (const [path, text] of Object.entries(files)) {
    if (text === undefined) continue;
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { root, dir };
}

/** readPackage's problems with the package `change` makes (none: []). */
async function problems(t, change) {
  const { dir } = await notesPackage(t, change);
  try {
    readPackage(dir);
    return [];
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return error.problems;
  }
}

/** A fake MCP server serving the notes tools. */
async function notesServer(t) {
  const fake = await startFakeMcp({ name: "notes" });
  t.after(() => fake.close());
  for (const name of ["list_notes", "send_note"]) fake.tools[name] = { description: `The ${name} tool.`, input: { type: "object", properties: { to: { type: "string" } }, additionalProperties: true }, run: () => ({ content: [{ type: "text", text: "[]" }] }) };
  return fake;
}

test("a package names an MCP need by its source and toolkit, with a reason, and its category and tags; examples/ is read and listed", async (t) => {
  const { dir } = await notesPackage(t);
  const p = readPackage(dir);
  assert.deepEqual(p.mcp, [{ source: "url", toolkit: "notes", tools: ["list_notes", "send_note"], required: false, reason: "Reads your notes and sends the digest on.", allow: ["list_notes"], pin: { send_note: { to: "${parameters.to}" } } }]);
  const view = packageView(p);
  assert.deepEqual([view.category, view.tags, view.examples], ["research", ["notes", "digest"], ["monday"]]);
  assert.deepEqual(view.mcp, [{ source: "url", toolkit: "notes", required: false, reason: "Reads your notes and sends the digest on.", tools: [{ name: "list_notes", tool: "mcp:notes/list_notes", asks: "allow" }, { name: "send_note", tool: "mcp:notes/send_note", asks: "ask", pin: { to: "${parameters.to}" } }] }]);
  assert.ok(!Object.keys(p.skills).some((path) => path.includes("examples")), "an example never reaches the agent");
});

test("the validator refuses an MCP need in the old shape or a bad one, a category or tag outside the rule, and an example that does not check", async (t) => {
  const edit = (from, to) => (files) => void (files["agent.md"] = files["agent.md"].replace(from, to));
  const has = async (change, pattern) => {
    const found = await problems(t, change);
    assert.ok(found.some((p) => pattern.test(p)), `${pattern} in ${JSON.stringify(found)}`);
  };
  assert.deepEqual(await problems(t, () => {}), []);
  await has(edit("source: url\n    toolkit: notes", "server: notes"), /mcp\[0\] is \{source: composio \| github \| url, toolkit/);
  await has(edit("source: url", "source: zapier"), /mcp\[0\] is \{source: composio \| github \| url/);
  await has(edit("source: url\n    toolkit: notes", "source: github\n    toolkit: gh"), /mcp\[0\]: a github source's toolkit is github/);
  await has(edit("toolkit: notes", "toolkit: Notes_Kit"), /mcp\[0\] is \{source/);
  await has(edit(`reason: "Reads your notes and sends the digest on."`, `reason: "${"x".repeat(281)}"`), /mcp\[0\] is \{source/);
  await has(edit("parameters:", "mcp_again: 1\nparameters:"), /no field mcp_again/);
  await has((files) => void (files["agent.md"] = files["agent.md"].replace("    pin: { send_note: { to: \"${parameters.to}\" } }\n", "    pin: { send_note: { to: \"${parameters.to}\" } }\n  - source: composio\n    toolkit: notes\n    tools: [other]\n")), /mcp\[1\]: the toolkit notes is listed twice/);
  await has(edit("category: research", "category: games"), /category is one of engineering, security, sales, marketing, research, finance, operations, compliance, personal/);
  await has(edit("tags: [notes, digest]", "tags: [Notes]"), /tags is a list of at most 8 tags/);
  await has(edit("tags: [notes, digest]", `tags: [${Array.from({ length: 9 }, (_, i) => `t${i}`).join(", ")}]`), /tags is a list of at most 8 tags/);
  await has((files) => void (files["examples/monday/input.json"] = "[1]"), /examples\/monday\/input\.json: .*input/);
  await has((files) => void (files["examples/monday/output.json"] = JSON.stringify({ summary: 3 })), /examples\/monday\/output\.json: does not match the output schema/);
  await has((files) => void (files["examples/monday/output.json"] = undefined), /examples\/monday: has no output\.json/);
  await has((files) => void (files["examples/monday/run.sh"] = "echo hi\n"), /examples\/monday\/run\.sh: an example holds input\.json, output\.json and output\.md only/);
  await has((files) => void (files["docs/notes.md"] = "x\n"), /a package's folders are skills\/, rules\/, evals\/ and examples\//);
});

test("a saved MCP server records its source and toolkit: url with none by default, the owner's toolkit when given, composio from the preset; removed with the server", async (t) => {
  const composio = await startFakeComposio({ toolkits: { hackernews: { no_auth: true, tools: [{ slug: "add", name: "Add", description: "Adds." }] } } });
  t.after(() => composio.close());
  const { api } = await serve(t, { composioControl: { baseUrl: composio.baseUrl } });
  const fake = await notesServer(t);
  const read = async (name) => {
    const { body } = await api("GET", `/settings/mcp-servers/${name}`);
    return [body.source, body.toolkit];
  };
  assert.equal((await api("PUT", "/settings/mcp-servers/my-notes", { url: fake.url, auth: { type: "none" } })).status, 200);
  assert.deepEqual(await read("my-notes"), ["url", null]);
  assert.equal((await api("PUT", "/settings/mcp-servers/my-notes", { url: fake.url, auth: { type: "none" }, toolkit: "notes" })).status, 200);
  assert.deepEqual(await read("my-notes"), ["url", "notes"]);
  // A save that names neither keeps the record; the list shows it too.
  assert.equal((await api("PUT", "/settings/mcp-servers/my-notes", { url: fake.url, auth: { type: "none" } })).status, 200);
  assert.deepEqual(await read("my-notes"), ["url", "notes"]);
  assert.deepEqual((await api("GET", "/settings/mcp-servers")).body.servers.map((s) => [s.name, s.source, s.toolkit]), [["my-notes", "url", "notes"]]);
  const bad = await api("PUT", "/settings/mcp-servers/my-notes", { url: fake.url, auth: { type: "none" }, source: "zapier", toolkit: "Not A Slug" });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.deepEqual(bad.body.error.fields.map((f) => f.field).sort(), ["source", "toolkit"]);
  // The Composio preset records composio and its toolkit, whatever the name it is saved under.
  const preset = await api("PUT", "/settings/mcp-servers/hn-feed/composio", { api_key: composio.apiKey, toolkit: "hackernews", tools: ["add"] });
  assert.equal(preset.status, 200, JSON.stringify(preset.body));
  assert.deepEqual(await read("hn-feed"), ["composio", "hackernews"]);
  // Removed with its server: a server saved again under the name starts from url with none.
  assert.equal((await api("DELETE", "/settings/mcp-servers/my-notes")).status, 204);
  assert.equal((await api("PUT", "/settings/mcp-servers/my-notes", { url: fake.url, auth: { type: "none" } })).status, 200);
  assert.deepEqual(await read("my-notes"), ["url", null]);
});

test("a server's record is read only for the server row it was written for: one left behind by a removal cut short, or written for no row, is never another server's", async (t) => {
  const server = await serve(t);
  const { api, store } = server;
  const fake = await notesServer(t);
  const read = async (name) => {
    const { body } = await api("GET", `/settings/mcp-servers/${name}`);
    return [body.source, body.toolkit];
  };
  assert.equal((await api("PUT", "/settings/mcp-servers/my-notes", { url: fake.url, auth: { type: "none" }, toolkit: "notes" })).status, 200);
  assert.deepEqual(await read("my-notes"), ["url", "notes"]);
  // The row goes and its record stays (a removal cut short between its two writes, or one that raced a save).
  assert.ok(await store.mcp.remove("my-notes"));
  assert.ok(await store.settings.get("mcp.source/my-notes"), "the record was left behind");
  assert.equal((await api("PUT", "/settings/mcp-servers/my-notes", { url: fake.url, auth: { type: "none" } })).status, 200);
  assert.deepEqual(await read("my-notes"), ["url", null], "a server saved again under the name is not read as the old one's toolkit");
  // A record written for no row (its server's save lost to a removal): never read for a row saved after.
  await store.settings.put("mcp.source/other", { source: "composio", toolkit: "slack", of: 1 });
  assert.equal((await api("PUT", "/settings/mcp-servers/other", { url: fake.url, auth: { type: "none" } })).status, 200);
  assert.deepEqual(await read("other"), ["url", null]);
  // A removal leaves a record written for another row (a server saved again meanwhile) in place, and takes its own.
  await store.settings.put("mcp.source/other", { source: "url", toolkit: "later", of: -1 });
  assert.equal((await api("DELETE", "/settings/mcp-servers/other")).status, 204);
  assert.deepEqual(await store.settings.get("mcp.source/other"), { source: "url", toolkit: "later", of: -1 });
  assert.equal((await api("DELETE", "/settings/mcp-servers/my-notes")).status, 204);
  assert.equal((await api("PUT", "/settings/mcp-servers/my-notes", { url: fake.url, auth: { type: "none" }, toolkit: "notes" })).status, 200);
  assert.equal((await api("DELETE", "/settings/mcp-servers/my-notes")).status, 204);
  assert.equal(await store.settings.get("mcp.source/my-notes"), undefined, "its own record goes with it");
});

test("what a server is, read: github/github on the GitHub App or at its address; composio with no toolkit yet on Composio's hosts; else url; a record counts only for its row", () => {
  const origin = "https://api.githubcopilot.com";
  assert.deepEqual(sourceOf({ url: "https://backend.composio.dev/v3/mcp/abc?user_id=u", auth: "headers", createdAt: 5 }, undefined, origin), { source: "composio", toolkit: null });
  assert.deepEqual(sourceOf({ url: "https://mcp.composio.dev/x", auth: "none", createdAt: 5 }, undefined, origin), { source: "composio", toolkit: null });
  assert.deepEqual(sourceOf({ url: "https://notcomposio.dev/x", auth: "none", createdAt: 5 }, undefined, origin), { source: "url", toolkit: null });
  assert.deepEqual(sourceOf({ url: "https://api.githubcopilot.com/mcp/", auth: "bearer", createdAt: 5 }, undefined, origin), { source: "github", toolkit: "github" });
  const record = storedSource({ source: "composio", toolkit: "slack" }, { createdAt: 5 });
  assert.deepEqual(sourceOf({ url: "https://backend.composio.dev/v3/mcp/abc", auth: "headers", createdAt: 5 }, record, origin), { source: "composio", toolkit: "slack" });
  assert.deepEqual(sourceOf({ url: "https://backend.composio.dev/v3/mcp/abc", auth: "headers", createdAt: 6 }, record, origin), { source: "composio", toolkit: null }, "written for another row");
  assert.deepEqual(sourceOf({ url: "https://mcp.example.com/mcp", auth: "none" }, record, origin), { source: "url", toolkit: null }, "no row yet");
  assert.deepEqual(sourceOf({ url: "https://mcp.example.com/mcp", auth: "none", createdAt: 5 }, { source: "url", toolkit: "notes" }, origin), { source: "url", toolkit: null }, "a record naming no row");
});

test("a sign-in carries the server's source and toolkit: the server it saves records them; a bad one is refused before anything is sent", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t);
  const as = await startFakeOAuth();
  const mcp = await startFakeMcp({ token: as.accepts, oauth: as.issuer });
  t.after(() => Promise.all([as.close(), mcp.close()]));
  const bad = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url, source: "composio" });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.deepEqual(bad.body.error.fields.map((f) => [f.field, f.reason]), [["toolkit", "missing"]]);
  assert.equal(as.log.length, 0, "nothing was sent to the authorization server");
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url, toolkit: "notion" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const asked = await fetch(started.body.authorization_url, { redirect: "manual" });
  assert.equal(asked.status, 302, await asked.text());
  const back = await fetch(asked.headers.get("location"), { redirect: "manual", headers: { cookie: started.headers.get("set-cookie").split(";")[0] } });
  assert.equal(back.headers.get("location"), "/#/settings/mcp?server=docs&sign_in=ok");
  const { body } = await api("GET", "/settings/mcp-servers/docs");
  assert.deepEqual([body.auth.type, body.source, body.toolkit], ["oauth", "url", "notion"]);
});

test("apply maps each need to the saved server whose source and toolkit match and rewrites mcp:<toolkit>/ to its name; none matching is not set up; the owner picks among several", async (t) => {
  const { root, dir } = await notesPackage(t);
  const { api } = await serve(t, { templates: root });
  const fake = await notesServer(t);

  // Saved under another name with no toolkit: not this need's server. The agent is made without its tools, said.
  assert.equal((await api("PUT", "/settings/mcp-servers/my-notes", { url: fake.url, auth: { type: "none" } })).status, 200);
  const unmatched = await api("POST", "/templates/notes-digest/apply", { parameters: { to: "me" }, grants: ["mcp:notes/list_notes"] });
  assert.equal(unmatched.status, 201, JSON.stringify(unmatched.body));
  assert.deepEqual(unmatched.body.servers, { notes: null });
  const notSetUp = unmatched.body.warnings.find((w) => w.field === "mcp.notes");
  assert.equal(notSetUp?.reason, "not_set_up_here", JSON.stringify(unmatched.body.warnings));
  assert.match(notSetUp.message, /No saved MCP server is url notes/);
  assert.ok(!(await api("GET", `/agents/${unmatched.body.agent_id}`)).body.definition.tools?.some((tool) => tool.startsWith("mcp:")), "no MCP tool");

  // The owner says what it is: the need maps to it, and every mcp:notes/ the agent gets reads mcp:my-notes/.
  assert.equal((await api("PUT", "/settings/mcp-servers/my-notes", { url: fake.url, auth: { type: "none" }, toolkit: "notes" })).status, 200);
  const applied = await api("POST", "/templates/notes-digest/apply", { parameters: { to: "me" }, grants: ["mcp:notes/list_notes"] });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.servers, { notes: "my-notes" });
  assert.equal(applied.body.warnings.find((w) => w.field.startsWith("mcp.") || w.field.startsWith("servers.")), undefined, JSON.stringify(applied.body.warnings));
  const agent = (await api("GET", `/agents/${applied.body.agent_id}`)).body;
  const { definition } = agent;
  assert.ok(definition.tools.includes("mcp:my-notes/list_notes"), JSON.stringify(definition.tools));
  assert.ok(!definition.tools.some((tool) => tool.startsWith("mcp:notes/")), JSON.stringify(definition.tools));
  assert.deepEqual(definition.tool_settings, { "mcp:my-notes/list_notes": { permission: "allow" }, "mcp:my-notes/send_note": { pin: { to: "me" } } });
  assert.equal(definition.instructions, "Call mcp:my-notes/list_notes, then mcp:my-notes/send_note once. The text xmcp:notes/list_notes is not a tool name.");
  assert.equal(Object.fromEntries(agent.skills.map((s) => [s.path, s.sha256]))["digest/SKILL.md"], sha256(SKILL.replace("mcp:notes/", "mcp:my-notes/")));

  // A grant names the package's own tool (mcp:<toolkit>/<tool>): the saved name is no grant of the package.
  const byServer = await api("POST", "/templates/notes-digest/apply", { parameters: { to: "me" }, grants: ["mcp:my-notes/list_notes"] });
  assert.equal(byServer.status, 422, JSON.stringify(byServer.body));
  assert.deepEqual(byServer.body.error.fields.map((f) => f.field), ["grants.0"]);

  // Two match: the one named as the toolkit is taken, said; the owner's pick takes another; a pick that is not one of them is refused.
  assert.equal((await api("PUT", "/settings/mcp-servers/notes", { url: fake.url, auth: { type: "none" }, toolkit: "notes" })).status, 200);
  const two = await api("POST", "/templates/notes-digest/apply", { parameters: { to: "me" } });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  assert.deepEqual(two.body.servers, { notes: "notes" });
  assert.match(two.body.warnings.find((w) => w.field === "servers.notes")?.message ?? "", /my-notes and notes/);
  const picked = await api("POST", "/templates/notes-digest/apply", { parameters: { to: "me" }, servers: { notes: "my-notes" }, grants: ["mcp:notes/list_notes"] });
  assert.equal(picked.status, 201, JSON.stringify(picked.body));
  assert.deepEqual(picked.body.servers, { notes: "my-notes" });
  assert.equal(picked.body.warnings.find((w) => w.field === "servers.notes"), undefined);
  assert.equal((await api("PUT", "/settings/mcp-servers/elsewhere", { url: fake.url, auth: { type: "none" } })).status, 200);
  for (const servers of [{ notes: "elsewhere" }, { notes: "nowhere" }, { other: "notes" }]) {
    const refused = await api("POST", "/templates/notes-digest/apply", { parameters: { to: "me" }, servers });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.deepEqual(refused.body.error.fields.map((f) => f.field), [`servers.${Object.keys(servers)[0]}`]);
  }
  void dir;
});

test("a required need with no matching saved server refuses the apply, naming the source and toolkit and how to set it up", async (t) => {
  const { root } = await notesPackage(t, (files) => void (files["agent.md"] = files["agent.md"].replace("source: url", "source: composio").replace("required: false", "required: true")));
  const { api } = await serve(t, { templates: root });
  const fake = await notesServer(t);
  // A url server with the toolkit is not a Composio one.
  assert.equal((await api("PUT", "/settings/mcp-servers/notes", { url: fake.url, auth: { type: "none" }, toolkit: "notes" })).status, 200);
  const refused = await api("POST", "/templates/notes-digest/apply", { parameters: { to: "me" } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  const field = refused.body.error.fields.find((f) => f.field === "mcp.notes");
  assert.equal(field?.reason, "not_set_up_here");
  assert.match(field.fix, /Add from Composio/);
  assert.match(field.fix, /list_notes, send_note/);
  // The owner says it is a Composio server: it maps.
  assert.equal((await api("PUT", "/settings/mcp-servers/notes", { url: fake.url, auth: { type: "none" }, source: "composio", toolkit: "notes" })).status, 200);
  const applied = await api("POST", "/templates/notes-digest/apply", { parameters: { to: "me" } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.servers, { notes: "notes" });
});
