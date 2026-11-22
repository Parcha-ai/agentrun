// A template package uploaded whole (POST /v2/templates/import {files}) and an apply's plan (POST /v2/templates/{id}/apply
// {dry_run: true}). An upload is checked by the one checker, under the GitHub import's limits and in its words, stored under
// `upload:<name>` with the package's sha256 as its sha, and replaced by the next upload of that name; it asks no publisher
// trust, as the caller is this server's owner. A plan says what the apply would do (create or revise, the keys and MCP
// servers this server lacks, each trigger's fate, the computer) and writes nothing. An agent's delete removes the upload
// it was applied from once no other agent here was, an API-only server's too. An API-only server takes an upload and
// refuses a GitHub source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { serve, withEnv } from "./support.mjs";

const enc = encodeURIComponent;

/** A check of an answer against the served document's schema for it. */
async function documented(api) {
  const doc = (await api("GET", "/openapi.json")).body;
  return (path, method, code, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[code].content["application/json"].schema, value), [], `${method} ${path} ${code}: ${JSON.stringify(value)}`);
}

const SKILL = `---
name: check
description: Check what changed and say it in one line.
---
# Check

Say what changed.
`;

/** A small package's agent.md: `extra` lines go in its front matter. */
const agentMd = ({ name = "pr-alert", version = "0.1.0", extra = [] } = {}) => `---
name: ${name}
version: ${version}
description: Says what changed in the repository today.
budget: { per_run_usd: 1.00 }
${extra.join("\n")}
---
You check what changed. Use your check skill.
`;

const DAILY = ["triggers:", "  - name: daily", "    source: { kind: schedule, cron: \"0 8 * * *\" }", "    target: { kind: start_run, input: { content: \"Run the daily check.\" } }"];
const HOURLY = ["  - name: hourly", "    source: { kind: schedule, cron: \"0 * * * *\" }", "    target: { kind: start_run, input: { content: \"Run the hourly check.\" } }"];

/** The package's files as a Map of path to bytes. */
const pkg = (agent = agentMd({ extra: DAILY }), more = {}) => new Map([["agent.md", Buffer.from(agent)], ["skills/check/SKILL.md", Buffer.from(SKILL)], ...Object.entries(more).map(([path, data]) => [path, Buffer.isBuffer(data) ? data : Buffer.from(data)])]);
/** The upload body's files: utf8 text, a file whose bytes are not text as base64. */
const filesOf = (files) => [...files].map(([path, data]) => (Buffer.from(data.toString("utf8")).equals(data) ? { path, encoding: "utf8", content: data.toString("utf8") } : { path, encoding: "base64", content: data.toString("base64") }));
/** The package's sha256 as the contract has it: hex over its files sorted by path, each `path NUL bytes NUL`. */
const sha256Of = (files) => {
  const hash = createHash("sha256");
  for (const [path, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) hash.update(path).update("\0").update(data).update("\0");
  return hash.digest("hex");
};

test("an upload is checked and stored as an import is, under upload:<name> with its sha256, asks no publisher trust, is replaced by the next upload of its name, and is kept across a restart", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { runner: false });
  const { api } = server;
  const first = pkg(undefined, { "rules/STYLE.md": "Keep it short.\n", "skills/check/table.bin": Buffer.from([0, 255, 1, 254]) });
  const preview = await api("POST", "/templates/import", { files: filesOf(first), dry_run: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual([preview.body.template.id, preview.body.template.source, preview.body.template.sha, preview.body.template.publisher, preview.body.template.bundled], ["upload:pr-alert", "upload:pr-alert", sha256Of(first), null, false]);
  assert.equal(preview.body.stored, false);
  assert.match(preview.body.instructions, /Use your check skill/);
  assert.deepEqual((await api("GET", "/templates")).body.templates.filter((one) => !one.bundled), [], "a dry run stores nothing");

  const stored = await api("POST", "/templates/import", { files: filesOf(first) });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.deepEqual([stored.body.stored, stored.body.replaced, stored.body.publisher_trusted], [true, null, true]);
  const second = pkg(agentMd({ version: "0.2.0", extra: DAILY }));
  const again = await api("POST", "/templates/import", { files: filesOf(second) });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.replaced, sha256Of(first), "the next upload of the name replaces it");
  const check = await documented(api);
  check("/templates/import", "post", "200", preview.body);
  check("/templates/import", "post", "201", again.body);
  const listed = () => api("GET", "/templates").then((answer) => answer.body.templates.filter((one) => !one.bundled).map((one) => [one.id, one.version, one.sha, one.publisher]));
  assert.deepEqual(await listed(), [["upload:pr-alert", "0.2.0", sha256Of(second), null]]);

  // Applied, the agent keeps where it came from: the upload's id and the package's sha256.
  const applied = await api("POST", `/templates/${enc("upload:pr-alert")}/apply`, { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = await api("GET", `/agents/${applied.body.agent_id}`);
  assert.deepEqual([agent.body.template.id, agent.body.template.sha], ["upload:pr-alert", sha256Of(second)]);
  check("/agents/{agent_id}", "get", "200", agent.body);

  await server.stop();
  const restarted = await serve(t, { data: server.data, runner: false });
  assert.deepEqual((await restarted.api("GET", "/templates")).body.templates.filter((one) => !one.bundled).map((one) => [one.id, one.version, one.sha]), [["upload:pr-alert", "0.2.0", sha256Of(second)]]);
  assert.equal((await restarted.api("DELETE", `/templates/${enc("upload:pr-alert")}`)).status, 204);
});

test("an upload is refused in the GitHub import's words, storing nothing: a path that is not plain, over 1 MiB of agent files, over 256 files, over the bytes an import keeps, and an agent.md that does not check", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { runner: false });
  const refused = async (body, field, pattern) => {
    const answer = await api("POST", "/templates/import", body);
    assert.equal(answer.status, 422, JSON.stringify(answer.body).slice(0, 2000));
    assert.equal(answer.body.error.fields[0].field, field, JSON.stringify(answer.body).slice(0, 2000));
    assert.match(answer.body.error.message, pattern);
  };
  const files = filesOf(pkg());
  for (const path of ["../agent.md", "/etc/passwd", "skills//check/x.md", "skills/./x.md", "skills/check/"]) {
    await refused({ files: [...files, { path, encoding: "utf8", content: "x" }] }, "package", /a path that is not plain: refused/);
  }
  await refused({ files: [...files, files[1]] }, "package", /holds "skills\/check\/SKILL\.md" twice/);
  const big = "x".repeat(200_000);
  await refused({ files: [...files, ...[1, 2, 3, 4, 5, 6].map((i) => ({ path: `rules/R${i}.md`, encoding: "utf8", content: big }))] }, "package", /the package's files are over 1048576 bytes together/);
  await refused({ files: [...files, ...Array.from({ length: 256 }, (_, i) => ({ path: `rules/r${i}.md`, encoding: "utf8", content: "x" }))] }, "package", /The package holds over 256 files\./);
  await refused({ files: [...files, ...Array.from({ length: 3 }, (_, i) => ({ path: `evals/big/f${i}.txt`, encoding: "utf8", content: "y".repeat(3 << 20) }))] }, "package", /The package's files are over the 8388608 bytes an import keeps\./);
  await refused({ files: filesOf(pkg(agentMd({ version: "1.0" }))) }, "package", /agent\.md: version is 1, a number: a package's version is SemVer text/);
  await refused({ files: filesOf(new Map([["skills/check/SKILL.md", Buffer.from(SKILL)]])) }, "package", /agent\.md: missing/);
  await refused({ files: [...files, { path: "extra/x.md", encoding: "utf8", content: "x" }] }, "package", /a package's folders are skills\/, rules\/ and evals\//);
  // The body's own shape.
  await refused({ files, source: "github:acme/agents" }, "files", /source or files, not both/);
  await refused({ files: "agent.md" }, "files", /files is a list of \{path, encoding, content\}/);
  await refused({ files: [{ path: "agent.md", encoding: "hex", content: "00" }] }, "files.0.encoding", /utf8 or base64/);
  await refused({ files: [{ path: "agent.md", encoding: "base64", content: "not base64!" }] }, "files.0.content", /not base64/);
  await refused({ files: [] }, "files", /files is a list of \{path, encoding, content\}/);
  await refused({ files, trust_publisher: true }, "trust_publisher", /an upload asks no publisher's trust/);
  assert.deepEqual((await api("GET", "/templates")).body.templates.filter((one) => !one.bundled), []);
});

test("an apply's dry run answers its plan and writes nothing: create or revise, the keys and MCP servers missing here, each trigger made, kept or removed, and the computer", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { runner: false });
  const counts = async (agentId) => [
    (await api("GET", "/agents")).body.agents.length,
    (await api("GET", "/triggers")).body.triggers.length,
    agentId ? (await api("GET", `/agents/${agentId}/revisions`)).body.revisions.length : 0,
  ];
  const upload = async (files) => {
    const answer = await api("POST", "/templates/import", { files: filesOf(files) });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    return `/templates/${enc(answer.body.template.id)}/apply`;
  };

  // A key this server does not hold: the plan names it; the apply itself is refused (409), nothing made either way.
  const keyed = await upload(pkg(agentMd({ name: "keyed", extra: ["secrets: [PARALLEL_API_KEY]", ...DAILY] })));
  const before = await counts();
  const plan = await api("POST", keyed, { dry_run: true, parameters: {} });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.deepEqual(plan.body, { plan: { action: "create", agent_id: null, current_revision_id: null, missing_secrets: ["PARALLEL_API_KEY"], unmatched_mcp: [], triggers: [{ name: "daily", kind: "schedule", action: "create" }], computer: null } });
  assert.deepEqual(await counts(), before, "a plan writes nothing");
  const refused = await api("POST", keyed, { parameters: {} });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.deepEqual(await counts(), before);

  // An optional MCP need with no saved server, and one that is required.
  const mcp = await upload(pkg(agentMd({ name: "mcp-need", extra: ["mcp:", "  - { source: composio, toolkit: slack, tools: [SLACK_SEND_MESSAGE], required: false, reason: \"Posts the line.\" }", "  - { source: composio, toolkit: gmail, tools: [GMAIL_SEND_EMAIL], required: true, reason: \"Mails the line.\" }"] })));
  const needs = await api("POST", mcp, { dry_run: true });
  assert.equal(needs.status, 200, JSON.stringify(needs.body));
  assert.deepEqual(needs.body.plan.unmatched_mcp, [{ source: "composio", toolkit: "slack", required: false }, { source: "composio", toolkit: "gmail", required: true }]);
  assert.deepEqual(needs.body.plan.missing_secrets, []);

  // A revise: the agent's current revision, the trigger the package keeps (update), one it adds, one it drops.
  const path = await upload(pkg());
  const made = await api("POST", path, { parameters: {} });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const agentId = made.body.agent_id;
  const current = (await api("GET", `/agents/${agentId}`)).body.revision;
  await upload(pkg(agentMd({ version: "0.2.0", extra: [...DAILY, ...HOURLY] })));
  const grown = await api("POST", path, { dry_run: true, agent_id: agentId, parameters: {} });
  assert.equal(grown.status, 200, JSON.stringify(grown.body));
  assert.deepEqual(grown.body.plan, { action: "revise", agent_id: agentId, current_revision_id: current, missing_secrets: [], unmatched_mcp: [], triggers: [{ name: "daily", kind: "schedule", action: "update" }, { name: "hourly", kind: "schedule", action: "create" }], computer: null });
  const check = await documented(api);
  for (const answer of [plan, needs, grown]) check("/templates/{template}/apply", "post", "200", answer.body);
  await upload(pkg(agentMd({ version: "0.3.0", extra: ["triggers:", ...HOURLY] })));
  const before2 = await counts(agentId);
  const shrunk = await api("POST", path, { dry_run: true, agent_id: agentId });
  assert.deepEqual(shrunk.body.plan.triggers, [{ name: "hourly", kind: "schedule", action: "create" }, { name: "daily", kind: "schedule", action: "remove" }]);
  assert.deepEqual(await counts(agentId), before2, "a revise's plan writes nothing either");

  // Its checks are the apply's: an agent that is not there, a dry_run that is not a boolean.
  assert.equal((await api("POST", path, { dry_run: true, agent_id: "agent_nope" })).status, 404);
  const bad = await api("POST", path, { dry_run: "yes" });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.equal(bad.body.error.fields[0].field, "dry_run");
});

test("an apply, and its plan, hold to what the caller read: the agent's revision and the package's sha (412 when another, nothing changed); the answer names the revision it wrote", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { runner: false });
  const upload = async (files) => {
    const answer = await api("POST", "/templates/import", { files: filesOf(files) });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    return answer.body.template;
  };
  const first = await upload(pkg());
  const path = `/templates/${enc(first.id)}/apply`;
  const made = await api("POST", path, { parameters: {}, sha: first.sha });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const agentId = made.body.agent_id;
  const read = (await api("GET", `/agents/${agentId}`)).body.revision;
  assert.equal(made.body.revision_id, read, "the answer names the revision the agent runs");
  (await documented(api))("/templates/{template}/apply", "post", "201", made.body);
  const revisions = async () => (await api("GET", `/agents/${agentId}/revisions`)).body.revisions.length;

  // Another upload of the same name since this caller read the package: its sha is not the one they planned.
  const second = await upload(pkg(agentMd({ version: "0.2.0", extra: [...DAILY, ...HOURLY] })));
  const count = await revisions();
  for (const dry of [true, false]) {
    const swapped = await api("POST", path, { parameters: {}, agent_id: agentId, revision: read, sha: first.sha, ...(dry ? { dry_run: true } : {}) });
    assert.equal(swapped.status, 412, JSON.stringify(swapped.body));
    assert.equal(swapped.body.error.code, "precondition_failed");
  }
  assert.equal(await revisions(), count, "nothing written");

  // A revision written after this caller read the agent: theirs is stale.
  const other = await api("POST", path, { parameters: {}, agent_id: agentId, sha: second.sha });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.notEqual(other.body.revision_id, read);
  assert.equal(other.body.revision_id, (await api("GET", `/agents/${agentId}`)).body.revision);
  const after = await revisions();
  for (const dry of [true, false]) {
    const stale = await api("POST", path, { parameters: {}, agent_id: agentId, revision: read, sha: second.sha, ...(dry ? { dry_run: true } : {}) });
    assert.equal(stale.status, 412, JSON.stringify(stale.body));
    assert.equal(stale.body.error.code, "precondition_failed");
  }
  assert.equal(await revisions(), after, "nothing written");
  const fresh = await api("POST", path, { parameters: {}, agent_id: agentId, revision: other.body.revision_id, sha: second.sha });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.agent_change, "unchanged");
  assert.equal(fresh.body.revision_id, other.body.revision_id, "an apply that writes nothing names the revision it kept");

  // A revision with no agent, and a sha that is not one.
  const loose = await api("POST", path, { parameters: {}, revision: read, sha: "nope" });
  assert.equal(loose.status, 422, JSON.stringify(loose.body));
  assert.deepEqual(loose.body.error.fields.map((f) => f.field).sort(), ["revision", "sha"]);
});

test("a plan lists the monid key as missing where a monid grant is pinned when the agent is saved, as the apply refuses it; with the key here the plan lists none", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, ["MONID_API_KEY"]);
  const files = filesOf(pkg(agentMd({ name: "enricher", extra: ["tools: [read, monid:faux/person/enrich]"] })));
  const planOf = async (api) => {
    const answer = await api("POST", "/templates/import", { files });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    const apply = `/templates/${enc(answer.body.template.id)}/apply`;
    const plan = await api("POST", apply, { dry_run: true, parameters: {} });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    return { apply, plan: plan.body.plan };
  };
  const { api } = await serve(t, { runner: false });
  const { apply, plan } = await planOf(api);
  assert.deepEqual(plan.missing_secrets, ["MONID_API_KEY"]);
  const applied = await api("POST", apply, { parameters: {} });
  assert.notEqual(applied.status, 201, "the apply itself is refused for want of the key");
  assert.match(JSON.stringify(applied.body), /no monid key here/);
  assert.equal((await api("GET", "/agents")).body.agents.length, 0, "nothing made");

  withEnv(t, { MONID_API_KEY: "fake-test-key" });
  const keyed = await serve(t, { runner: false });
  assert.deepEqual((await planOf(keyed.api)).plan.missing_secrets, []);
});

test("an agent's delete removes the upload it was applied from once no other agent here was, archived ones too, in the same write; a package imported from GitHub stays", { timeout: 120_000 }, async (t) => {
  // A package imported from GitHub, as its import stores it, served from the next start.
  const GITHUB = "github:acme/agents/templates/watch";
  const first = await serve(t, { runner: false });
  const base64 = (files) => Object.fromEntries([...files].map(([path, data]) => [path, data.toString("base64")]));
  await first.store.importedTemplates.put({ id: GITHUB, source: GITHUB, sha: "a".repeat(40), publisher: "acme", files: base64(pkg(agentMd({ name: "watch" }))) });
  await first.stop();
  const server = await serve(t, { data: first.data, runner: false });
  const { api, store } = server;
  const stored = async () => (await store.importedTemplates.list()).map((row) => row.id).sort();
  const served = async () => (await api("GET", "/templates")).body.templates.filter((one) => !one.bundled).map((one) => one.id).sort();
  const apply = async (id) => {
    const applied = await api("POST", `/templates/${enc(id)}/apply`, { parameters: {} });
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    return applied.body.agent_id;
  };
  const archive = async (id) => assert.equal((await api("POST", `/agents/${id}/archive`)).status, 200);
  const remove = async (id) => assert.equal((await api("DELETE", `/agents/${id}`)).status, 204);

  assert.equal((await api("POST", "/templates/import", { files: filesOf(pkg(agentMd())) })).status, 201);
  const one = await apply("upload:pr-alert");
  const two = await apply("upload:pr-alert");
  const watch = await apply(GITHUB);
  assert.deepEqual(await stored(), [GITHUB, "upload:pr-alert"]);

  // Another agent applied from it, archived, keeps it.
  await archive(two);
  await archive(one);
  await remove(one);
  assert.deepEqual(await stored(), [GITHUB, "upload:pr-alert"], "two, archived, was applied from it");
  assert.deepEqual(await served(), [GITHUB, "upload:pr-alert"]);
  // The last one's delete removes it, from the store and from what this server serves.
  await remove(two);
  assert.deepEqual(await stored(), [GITHUB]);
  assert.deepEqual(await served(), [GITHUB]);
  assert.equal((await api("POST", `/templates/${enc("upload:pr-alert")}/apply`, { parameters: {} })).status, 404);
  // A package imported from GitHub is the owner's to remove: its last agent's delete keeps it.
  await archive(watch);
  await remove(watch);
  assert.deepEqual(await stored(), [GITHUB]);
  assert.deepEqual(await served(), [GITHUB]);
  // A package's agents edited after the apply still name it: their delete removes it too.
  assert.equal((await api("POST", "/templates/import", { files: filesOf(pkg(agentMd())) })).status, 201);
  const edited = await apply("upload:pr-alert");
  assert.equal((await api("PUT", `/agents/${edited}/definition`, { definition: { instructions: "Edited after the apply." } })).status, 200);
  await archive(edited);
  await remove(edited);
  assert.deepEqual(await stored(), [GITHUB]);
});

test("an upload its agent's purge removed stops being served by the DELETE sent again after a purge that committed and never answered; an upload put in while the server reads its store stays served", { timeout: 60_000 }, async (t) => {
  const server = await serve(t, { runner: false });
  const { api, store } = server;
  const served = async () => (await api("GET", "/templates")).body.templates.filter((one) => !one.bundled).map((one) => one.id);
  assert.equal((await api("POST", "/templates/import", { files: filesOf(pkg(agentMd())) })).status, 201);
  const applied = await api("POST", `/templates/${enc("upload:pr-alert")}/apply`, { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal((await api("POST", `/agents/${applied.body.agent_id}/archive`)).status, 200);
  // The purge's write committed, and the DELETE that sent it ended before it answered.
  await store.agents.purge(applied.body.agent_id);
  assert.deepEqual(await served(), ["upload:pr-alert"]);
  assert.equal((await api("DELETE", `/agents/${applied.body.agent_id}`)).status, 204);
  assert.deepEqual(await served(), []);

  // Only the package read before the store's rows goes: one uploaded while they are read is served.
  const { dropRemovedUploads, importedPackage } = await import("../dist/template-import.js");
  const { TemplateRegistry } = await import("../dist/templates.js");
  const upload = (name, version) => importedPackage(`upload:${name}`, { source: `upload:${name}`, sha: version.replaceAll(".", "").padEnd(64, "0"), publisher: "" }, pkg(agentMd({ name, version })));
  const registry = new TemplateRegistry([]);
  registry.put(upload("pr-alert", "0.1.0"));
  registry.put(upload("gone", "0.1.0"));
  const fresh = upload("pr-alert", "0.2.0");
  await dropRemovedUploads({ registry, store: { importedTemplates: { list: async () => (registry.put(fresh), []) } } });
  assert.deepEqual(registry.list().map((one) => one.id), ["upload:pr-alert"]);
  assert.equal(registry.get("upload:pr-alert"), fresh);
});

test("an API-only server takes an upload ({files}) and refuses a GitHub source", { timeout: 60_000 }, async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  const post = async (body) => {
    const res = await fetch(`${server.url}/v2/templates/import`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const stored = await post({ files: filesOf(pkg()) });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.equal(stored.body.template.id, "upload:pr-alert");
  const github = await post({ source: "github:acme/agents/templates/kyb@main", trust_publisher: true });
  assert.equal(github.status, 422, JSON.stringify(github.body));
  assert.deepEqual([github.body.error.fields[0].field, github.body.error.fields[0].reason], ["source", "not_allowed"]);
  assert.match(github.body.error.fields[0].message, /serves the API alone: a package is uploaded here as \{files\}/);
});

test("on an API-only server, which serves no template list or delete, an upload applied, archived and deleted through the API leaves no upload behind", { timeout: 60_000 }, async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  const send = async (method, path, body) => {
    const res = await fetch(`${server.url}/v2${path}`, { method, headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const stored = async () => (await server.store.importedTemplates.list()).map((row) => row.id);
  assert.equal((await send("GET", "/templates")).status, 404, "no template list here");
  assert.equal((await send("DELETE", `/templates/${enc("upload:pr-alert")}`)).status, 404, "no template delete here");

  const uploaded = await send("POST", "/templates/import", { files: filesOf(pkg(agentMd())) });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const applied = await send("POST", `/templates/${enc("upload:pr-alert")}/apply`, { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.deepEqual(await stored(), ["upload:pr-alert"]);
  assert.equal((await send("POST", `/agents/${applied.body.agent_id}/archive`)).status, 200);
  const deleted = await send("DELETE", `/agents/${applied.body.agent_id}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.deepEqual(await stored(), [], "the upload went with the only agent applied from it");
  assert.equal((await send("POST", `/templates/${enc("upload:pr-alert")}/apply`, { parameters: {} })).status, 404);
});
