// An agent exported as a template package (GET /v2/agents/{id}/package): its current revision written in the package
// format, which readPackage takes unchanged. Every bundled template applied here and exported is its own package again;
// an export applied on another server and exported there is the same package, byte for byte (the sha256); an agent this
// server only mirrors (native, CLI learning, SDK, external) is refused; nothing that names this host (a box, a computer
// provider, a pin of this server's listings) is in it; and what cannot travel is named: blocked (the export is refused by
// the CLI) or remade (the target sets it up again).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { memoryFiles, readPackage, readPackages } from "../dist/templates.js";
import { schemaProblems } from "./schema-support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { scratch, serve } from "./support.mjs";

const TEMPLATES = new URL("../templates/", import.meta.url).pathname;
/** Each bundled template's parameters for its apply here: what an owner would give, so every pin fills. */
const PARAMETERS = {
  "code-review": { owner: "Parcha-ai", repo: "agentrun" },
  "inbound-lead": { icp: "Seed-stage fintech companies in the US.", slack_channel: "C0SALES123" },
  kyb: {},
  "market-monitor": { competitors: "Acme (acme.example)", channel: "C0MKTINTEL" },
  "release-notes": { owner: "Parcha-ai", repo: "agentrun" },
};

/** The contract's sha256: hex over the files sorted by path, each `path NUL bytes NUL`. */
const bytesOf = (file) => Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
function sha256Of(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) hash.update(file.path).update(Buffer.from([0])).update(bytesOf(file)).update(Buffer.from([0]));
  return hash.digest("hex");
}
/** The answer's files read as a package, as readPackage reads one held in memory. */
const asPackage = (answer) => readPackage(memoryFiles(answer.name, `the export of ${answer.name}`, new Map(answer.files.map((file) => [file.path, bytesOf(file)]))));
/** The answer's files written into `dir/<name>/`, as `agentrun export` writes them. */
function writeOut(dir, answer) {
  for (const file of answer.files) {
    const at = join(dir, answer.name, file.path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, bytesOf(file));
  }
}
/** Every file of a folder, by path from it. */
const filesUnder = (dir, sub = "") => readdirSync(join(dir, sub)).flatMap((name) => (statSync(join(dir, sub, name)).isDirectory() ? filesUnder(dir, join(sub, name)) : [join(sub, name)]));
/** The manifest in an answer's agent.md front matter. */
const manifestOf = (answer) => parseYaml(/^---\n([\s\S]*?)\n---/.exec(bytesOf(answer.files.find((file) => file.path === "agent.md")).toString("utf8"))[1]);

/** A check of an answer against the served document's schema for it. */
async function documented(baseUrl) {
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  return (path, method, code, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[code].content["application/json"].schema, value), [], `${method} ${path} ${code}: ${JSON.stringify(value)}`);
}

/** Fakes standing in for each MCP server the bundled templates need (GitHub's, and Composio's HubSpot, Slack and Gmail),
 *  each tool a template lists served, started once for a test. */
async function standIns(t) {
  const needs = readPackages().flatMap((pkg) => pkg.mcp);
  const fakes = {};
  for (const need of needs) {
    fakes[need.toolkit] ??= { source: need.source, fake: await startFakeMcp({ name: need.toolkit }) };
    for (const name of need.tools) fakes[need.toolkit].fake.tools[name] = { description: `${need.toolkit}'s ${name}.`, input: { type: "object", properties: {}, additionalProperties: true }, run: () => ({ content: [{ type: "text", text: "{}" }] }) };
  }
  t.after(() => Promise.all(Object.values(fakes).map(({ fake }) => fake.close())));
  return fakes;
}
/** Each stand-in saved on a server, under its toolkit's name, as the source and toolkit it fakes. */
async function saveStandIns(api, fakes) {
  for (const [toolkit, { source, fake }] of Object.entries(fakes)) {
    const saved = await api("PUT", `/settings/mcp-servers/${toolkit}`, { url: fake.url, auth: { type: "none" }, source, toolkit });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
}
/** A package's every MCP tool, as an apply's grants name them. */
const everyTool = (pkg) => pkg.mcp.flatMap((need) => need.tools.map((tool) => `mcp:${need.toolkit}/${tool}`));

/** The agent `id` as a server holds it: its definition (less its id and revision number), its skill files and its
 *  triggers (less their ids, times and the agent they name), to compare an agent across servers. */
async function agentOn(api, id) {
  const agent = (await api("GET", `/agents/${id}`)).body;
  // Its place is where this server put it (a host stamp a package never carries); the computer it shows is compared.
  const { id: _id, version: _version, place: _place, ...definition } = agent.definition;
  // A package's body is read trimmed (readPackage), so the instructions' outer whitespace (a parameter filled with
  // nothing at their end) does not travel.
  definition.instructions = definition.instructions?.trim();
  const triggers = (await api("GET", "/triggers")).body.triggers.filter((trigger) => trigger.target?.agent_id === id).map((trigger) => {
    const { agent_id: _agent, ...target } = trigger.target;
    return { name: trigger.name, enabled: trigger.enabled, source: trigger.source, target, catchup_window_s: trigger.catchup_window_s, max_active_runs: trigger.max_active_runs };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
  return { definition, skills: agent.skills.map((skill) => [skill.path, skill.sha256]), triggers };
}

/** Each bundled template applied on `api` with its parameters and every tool granted: its agent's id, by template. */
async function applyEvery(api) {
  const made = {};
  for (const pkg of readPackages()) {
    const applied = await api("POST", `/templates/${pkg.id}/apply`, { parameters: PARAMETERS[pkg.name], grants: everyTool(pkg) });
    assert.equal(applied.status, 201, `${pkg.name}: ${JSON.stringify(applied.body)}`);
    made[pkg.name] = applied.body.agent_id;
  }
  return made;
}

test("every bundled template, applied and exported, is the template's own package: its skills and rules byte for byte, its schemas, and the manifest the apply compiled", { timeout: 300_000 }, async (t) => {
  const fakes = await standIns(t);
  const { api, baseUrl } = await serve(t, { mcpStandIns: true });
  await saveStandIns(api, fakes);
  const check = await documented(baseUrl);
  const made = await applyEvery(api);
  for (const template of readPackages()) {
    const id = made[template.name];
    const exported = await api("GET", `/agents/${id}/package`);
    // A workflow template's agent is a workflow revision, which an export does not write (409 not_exportable, as the
    // route documents): the rest of this test is an agentic package's.
    if (template.workflow) {
      assert.deepEqual([exported.status, exported.body.error?.code], [409, "not_exportable"], template.name);
      continue;
    }
    assert.equal(exported.status, 200, `${template.name}: ${JSON.stringify(exported.body)}`);
    check("/agents/{agent_id}/package", "get", "200", exported.body);
    const answer = exported.body;
    assert.deepEqual(answer.report, { blocked: [], remade: answer.report.remade }, `${template.name}: nothing blocks a template's own agent`);
    assert.equal(answer.sha256, sha256Of(answer.files), `${template.name}: the sha256 is the contract's, over its files`);
    assert.deepEqual(answer.files.map((file) => file.path), [...answer.files.map((file) => file.path)].sort(), "its files sorted by path");
    // The answer's files pass readPackage unchanged.
    const pkg = asPackage(answer);
    assert.equal(answer.name, template.name);
    assert.equal(pkg.version, template.version, "the version of the package it was applied from");

    // The template's own files, byte for byte, but what an apply consumes or an agent never holds:
    //  - evals/: the package's test data, never part of an agent;
    //  - agent.md: its body is the instructions with the apply's parameters filled, and its manifest is what the apply
    //    made of the template (no parameters, model choices, `allow` asks, gallery fields or comments; the computer list
    //    read down to the one this server picked), checked field by field below.
    const dir = join(TEMPLATES, template.name);
    const own = filesUnder(dir).filter((path) => !path.startsWith("evals/") && path !== "agent.md");
    const exportedFiles = new Map(answer.files.map((file) => [file.path, bytesOf(file).toString("utf8")]));
    for (const path of own.filter((one) => one.startsWith("skills/") || one.startsWith("rules/"))) assert.equal(exportedFiles.get(path), readFileSync(join(dir, path), "utf8"), `${template.name}: ${path}, byte for byte`);
    assert.deepEqual([...exportedFiles.keys()].filter((path) => path.startsWith("skills/") || path.startsWith("rules/")).sort(), own.filter((path) => path.startsWith("skills/") || path.startsWith("rules/")).sort(), `${template.name}: no other skill or rule file`);
    // The answer's schema at the template's own path (a root file's bytes are the export's JSON of it).
    assert.equal(pkg.output?.schema, template.output?.schema, `${template.name}: the answer's schema keeps its path`);
    assert.deepEqual(pkg.outputSchema, template.outputSchema);
    assert.deepEqual(pkg.inputSchema, template.inputSchema, `${template.name}: its typed input`);
    assert.deepEqual(pkg.skills, template.skills, `${template.name}: every skill file, rules beside each SKILL.md, as an apply copies them`);

    const agent = (await api("GET", `/agents/${id}`)).body.definition;
    const manifest = manifestOf(answer);
    assert.equal(manifest.approvals, template.approvals ?? "ask", `${template.name}: approvals always written, ask where the template sets none`);
    assert.ok(manifest.model && typeof manifest.model.tier === "string", `${template.name}: the model always written`);
    assert.equal(manifest.model.prefer, agent.model, `${template.name}: the agent's own model`);
    assert.deepEqual(manifest.harness, [agent.harness]);
    assert.equal(pkg.effort, template.effort);
    assert.deepEqual(pkg.budget, template.budget);
    assert.deepEqual(pkg.learning, template.learning);
    assert.equal(pkg.checkout, template.checkout);
    assert.deepEqual(pkg.secrets, template.secrets);
    assert.equal(pkg.instructions, agent.instructions.trim(), "the body is the agent's instructions, read trimmed as any package body is");
    assert.equal(pkg.displayName, agent.name);
    assert.equal(pkg.description, agent.description);
    assert.deepEqual(pkg.tools, agent.tools.filter((tool) => !tool.startsWith("mcp:")), `${template.name}: the agent's own tools`);
    // Its MCP needs: the template's, by source and toolkit, each tool the agent was granted, its pins as the apply filled them.
    assert.deepEqual(pkg.mcp.map((need) => [need.source, need.toolkit, need.tools]), template.mcp.map((need) => [need.source, need.toolkit, need.tools]), template.name);
    for (const need of pkg.mcp) for (const [tool, pin] of Object.entries(need.pin)) assert.deepEqual(pin, agent.tool_settings[`mcp:${need.toolkit}/${tool}`].pin, `${template.name}: ${tool}'s pin`);
    // Its triggers, with no agent_id: the ones the apply made here. A github trigger is skipped at apply on a server GitHub
    // is not connected to (this one), so the agent has none to export.
    const had = (await api("GET", "/triggers")).body.triggers.filter((trigger) => trigger.target.agent_id === id).map((trigger) => trigger.name);
    const kept = template.triggers.filter((trigger) => had.includes(trigger.name));
    assert.deepEqual(kept.map((trigger) => trigger.name), template.triggers.filter((trigger) => trigger.source.kind !== "github").map((trigger) => trigger.name), `${template.name}: every trigger but a github one made here`);
    assert.deepEqual(pkg.triggers.map((trigger) => [trigger.name, trigger.source.kind, trigger.target.agent_id]), kept.map((trigger) => [trigger.name, trigger.source.kind, undefined]), `${template.name}: its triggers, with no agent_id`);
    // A trigger the target makes anew (its own secret, its GitHub App) is named as remade.
    for (const trigger of kept.filter((one) => ["webhook", "github", "composio", "email"].includes(one.source.kind))) assert.ok(answer.report.remade.some((entry) => entry.kind === "trigger" && entry.name === trigger.name), `${template.name}: ${trigger.name} remade`);
    if (template.learning !== undefined && template.learning !== false) assert.ok(answer.report.remade.some((entry) => entry.kind === "learning"), `${template.name}: learning starts fresh on the target`);
  }
});

test("round trip: each export applied on another server and exported there is the same package, the same sha256, and the same agent", { timeout: 300_000 }, async (t) => {
  const fakes = await standIns(t);
  const a = await serve(t, { mcpStandIns: true });
  await saveStandIns(a.api, fakes);
  const made = await applyEvery(a.api);
  // An export writes an agentic package only (a workflow template's agent is refused, 409: the test above), so the round
  // trip is each agentic template's.
  for (const pkg of readPackages()) if (pkg.workflow) delete made[pkg.name];
  // An agent no template made: its skill, typed input, budget and a schedule.
  const skill = "---\nname: digest\ndescription: How the weekly digest is written.\n---\nOne line per change, newest first.\n";
  const own = await a.api("POST", "/agents", {
    definition: {
      name: "Weekly digest", description: "Writes the week's digest.", instructions: "Write the week's digest from the changes you are given.", harness: "pi", tools: ["read"], skills: ["digest"], max_cost_usd: 1, learning: false,
      input_schema: { type: "object", additionalProperties: false, required: ["week"], properties: { week: { type: "string", pattern: "^\\d{4}-W\\d{2}$", description: "The ISO week." }, tone: { type: "string", enum: ["plain", "warm"], default: "plain" } } },
    },
    skills: { "digest/SKILL.md": skill },
  });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const scheduled = await a.api("POST", "/triggers", { name: "Mondays", source: { kind: "schedule", cron: "0 9 * * 1", timezone: "UTC" }, target: { kind: "start_run", agent_id: own.body.agent_id, input: { week: "2026-W01" } } });
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
  made["weekly-digest"] = own.body.agent_id;

  const dir = await scratch(t);
  const first = {};
  for (const [name, id] of Object.entries(made)) {
    const exported = await a.api("GET", `/agents/${id}/package`);
    assert.equal(exported.status, 200, `${name}: ${JSON.stringify(exported.body)}`);
    assert.deepEqual(exported.body.report.blocked, [], name);
    assert.equal(exported.body.name, name, "a template's agent is named as its template, another by its own name");
    first[name] = exported.body;
    writeOut(dir, exported.body);
  }
  // The other server takes the folders as the template tests take a package: its templates, applied there.
  const b = await serve(t, { mcpStandIns: true, templates: dir });
  await saveStandIns(b.api, fakes);
  for (const [name, id] of Object.entries(made)) {
    const pkg = asPackage(first[name]);
    const applied = await b.api("POST", `/templates/${name}/apply`, { grants: everyTool(pkg) });
    assert.equal(applied.status, 201, `${name}: ${JSON.stringify(applied.body)}`);
    assert.deepEqual(await agentOn(b.api, applied.body.agent_id), await agentOn(a.api, id), `${name}: the same agent on the other server`);
    const again = await b.api("GET", `/agents/${applied.body.agent_id}/package`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.sha256, first[name].sha256, `${name}: the same package, byte for byte`);
    assert.deepEqual(again.body.files, first[name].files);
  }
  // Every folder written is one readPackage takes from disk, as `agentrun template validate` reads it.
  for (const name of Object.keys(made)) assert.equal(readPackage(join(dir, name)).name, name);
});

test("an agent this server mirrors is not exported: native, CLI learning, SDK and external agents answer 409 not_exportable, an unknown agent 404", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const { api, baseUrl } = server;
  const native = { runtime: "claude-code", project: "/fixture/project", selector: { kind: "project" }, machine_id: "machine-1", fingerprint: "f", configuration: [], skills: [], mcp_servers: [], issues: [], capabilities: { launch: true }, connected: true };
  await server.store.agents.create({ id: "native-agent", name: "Native" }, { id: "native-rev", kind: "agentic", body: { instructions: "Work in the project.", native } });
  await server.store.agents.create({ id: "cli-agent", name: "CLI learning" }, { id: "cli-rev", kind: "agentic", body: { instructions: "Learn from the CLI.", cli_learning: { runtime: "codex", connection_id: "connection-1", project: "/fixture/project" } } });
  const sdk = await api("POST", "/agents", { definition: { id: "sdk-agent", name: "SDK", instructions: "Keep the policy.", sdk: { runtime: "claude-agent-sdk" }, learning: false, tools: [] } });
  assert.equal(sdk.status, 201, JSON.stringify(sdk.body));
  const inline = await api("POST", "/runs", { external: { source: "backend", kind: "expert", id: "export-1", version: 1 }, definition: { name: "Expert", instructions: "Answer the question.", skills: [], tools: [], harness: "pi" }, input: { content: "What is six times seven." } });
  assert.equal(inline.status, 202, JSON.stringify(inline.body));
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.ok(doc.paths["/agents/{agent_id}/package"]?.get, "the operation is documented");
  for (const [id, kind] of [["native-agent", "native"], ["cli-agent", "CLI learning"], ["sdk-agent", "SDK"], [inline.body.agent_id, "external"]]) {
    const refused = await api("GET", `/agents/${id}/package`);
    assert.equal(refused.status, 409, `${kind}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error.code, "not_exportable", kind);
    assert.ok(refused.body.error.message.length > 0, kind);
  }
  assert.equal((await api("GET", "/agents/no-such-agent/package")).status, 404);
});

test("nothing of this host is in a package: no box, no computer provider, no place, no MCP or monid pin; approvals is written even when the definition has none", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const mcpPin = { docs: { url: "https://docs.example/mcp", tools: [{ name: "search", inputSchema: { type: "object" } }] } };
  const monidPin = { "apollo/people/match": { description: "Match a person.", input: { type: "object" }, usd: 0.1 } };
  await server.store.agents.create({ id: "boxed", name: "Boxed" }, { id: "boxed-rev", kind: "agentic", body: { instructions: "Build it.", tools: ["read", "bash"], computer: { kind: "sandbox", provider: "box-provider-here", needs: ["ffmpeg"] }, place: { mode: "sandbox", box: "box-provider-here" }, maxCostUsd: 1 }, mcpPin, monidPin });
  // A revision saved before the computer setting keeps its place alone: the computer the API shows is the place's.
  await server.store.agents.create({ id: "placed", name: "Placed" }, { id: "placed-rev", kind: "agentic", body: { instructions: "Build it.", tools: ["read", "bash"], place: { mode: "sandbox", box: "box-provider-here" } } });
  for (const id of ["boxed", "placed"]) {
    const exported = await api("GET", `/agents/${id}/package`);
    assert.equal(exported.status, 200, `${id}: ${JSON.stringify(exported.body)}`);
    const text = exported.body.files.map((file) => bytesOf(file).toString("utf8")).join("\n");
    assert.doesNotMatch(text, /box-provider-here/, `${id}: the box is this host's`);
    assert.doesNotMatch(text, /docs\.example|apollo\/people/, `${id}: pins are this server's listings`);
    const manifest = manifestOf(exported.body);
    for (const key of ["place", "mcp_pin", "monid_pin", "provider"]) assert.equal(manifest[key], undefined, `${id}: no ${key}`);
    assert.deepEqual(manifest.computer, ["shell"], `${id}: a shell, whichever the target gives`);
    // The programs its sandbox must have travel (computer.needs as the package's needs); the box that has them does not.
    assert.deepEqual(manifest.needs, id === "boxed" ? ["ffmpeg"] : undefined, `${id}: its sandbox's needs`);
    assert.equal(manifest.approvals, "ask", `${id}: approvals, though the definition sets none`);
    assert.ok(manifest.model && manifest.model.tier, `${id}: the model, though the definition names none`);
    asPackage(exported.body);
  }
});

test("what cannot travel is named: a local or unsaved MCP server and one with its own auth header are blocked; a webhook trigger, a paired computer and a sign-in are remade", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { mcpStandIns: true });
  const { api, baseUrl } = server;
  const local = await startFakeMcp({ name: "local" });
  t.after(() => local.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/local", { url: local.url, auth: { type: "none" } })).status, 200);
  const keyed = await startFakeMcp({ name: "keyed" });
  t.after(() => keyed.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/keyed", { url: keyed.url, auth: { type: "bearer", token: `not-a-secret-${"agent-package-bearer"}` } })).status, 200);
  const paired = "cmp-abcdefghijkmnpqr";
  // `mcp:stdio-tools/run`: a server saved nowhere here, as a local process the agent was given on its own machine is.
  await server.store.agents.create({ id: "watcher", name: "Watcher" }, { id: "watcher-rev", kind: "agentic", body: { instructions: "Watch the desktop.", tools: ["read", "mcp:local/add", "mcp:keyed/add", "mcp:stdio-tools/run"], computer: { kind: "desktop", provider: paired }, maxCostUsd: 1 } });
  const hook = await api("POST", "/triggers", { name: "Inbound", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "watcher", input: { content: "A new event." } } });
  assert.equal(hook.status, 201, JSON.stringify(hook.body));
  // A browser sign-in the agent saved: its session is this server's, sealed here.
  await server.store.signIns.save({ agentId: "watcher", provider: "browserbase", name: "Work", pointerSealed: new Uint8Array([1, 2, 3]) });

  const exported = await api("GET", "/agents/watcher/package");
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  (await documented(baseUrl))("/agents/{agent_id}/package", "get", "200", exported.body);
  const { blocked, remade } = exported.body.report;
  const named = (list, kind, name) => list.find((entry) => entry.kind === kind && entry.name === name);
  assert.match(named(blocked, "mcp_server", "local")?.reason ?? "", /this machine/, JSON.stringify(blocked));
  assert.match(named(blocked, "mcp_server", "keyed")?.reason ?? "", /auth/, JSON.stringify(blocked));
  assert.match(named(blocked, "mcp_server", "stdio-tools")?.reason ?? "", /not a saved MCP server/, JSON.stringify(blocked));
  assert.ok(named(remade, "trigger", "Inbound"), JSON.stringify(remade));
  assert.ok(named(remade, "paired_computer", paired), JSON.stringify(remade));
  assert.ok(named(remade, "sign_in", "browserbase"), JSON.stringify(remade));
  for (const entry of [...blocked, ...remade]) assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, JSON.stringify(entry));
  // The package left behind is still one: the blocked servers' tools out of it, the webhook trigger in it with no secret.
  const pkg = asPackage(exported.body);
  assert.deepEqual(pkg.mcp, []);
  assert.deepEqual(pkg.triggers.map((trigger) => [trigger.name, trigger.source, trigger.target.agent_id]), [["Inbound", { kind: "webhook" }, undefined]]);
  assert.doesNotMatch(exported.body.files.map((file) => bytesOf(file).toString("utf8")).join("\n"), /whsec_|not-a-secret/, "no secret");

  // A credential in the clear where an export copies a field as it is: a feed's URL (a query parameter named like one), a
  // trigger's input and an MCP tool's pin. Each is blocked by its field, and its value is in no file and no answer.
  const leak = (word) => `leak-${word}-${"export-custody"}-9c1e`;
  const slack = await startFakeMcp({ name: "slack" });
  t.after(() => slack.close());
  for (const name of ["post", "search"]) slack.tools[name] = { description: `slack's ${name}.`, input: { type: "object", properties: {}, additionalProperties: true }, run: () => ({ content: [{ type: "text", text: "{}" }] }) };
  assert.equal((await api("PUT", "/settings/mcp-servers/slack", { url: slack.url, auth: { type: "none" }, source: "composio", toolkit: "slack" })).status, 200);
  // search's keys pin holds names (the fields a call may give), not values: it is no credential, though `keys` reads as one.
  const toolSettings = { "mcp:slack/post": { pin: { channel: "C0STATUS", api_key: leak("pin"), token: [leak("one"), leak("other")] } }, "mcp:slack/search": { pin: { channel: "C0STATUS", properties: { keys: ["hs_lead_score"] } } } };
  await server.store.agents.create({ id: "leaky", name: "Leaky" }, { id: "leaky-rev", kind: "agentic", body: { instructions: "Say what changed.", tools: ["read", "mcp:slack/post", "mcp:slack/search"], toolSettings, maxCostUsd: 1 } });
  const words = ["token", "key", "secret", "sig", "password"];
  const triggers = [
    { name: "Keyed feeds", source: { kind: "feed", urls: words.map((word, i) => `https://status.example.com/${i}.xml?${word}=${leak(word)}`), every_s: 3600 }, input: { content: "A new status." } },
    { name: "Paged feed", source: { kind: "feed", urls: ["https://status.example.com/feed.xml?page=2"], every_s: 3600 }, input: { content: "A new status." } },
    { name: "Daily", source: { kind: "schedule", cron: "0 9 * * *" }, input: { content: "Check the status.", api_key: leak("input") } },
  ];
  for (const { name, source, input } of triggers) {
    const made = await api("POST", "/triggers", { name, enabled: false, source, target: { kind: "start_run", agent_id: "leaky", input } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
  }
  const leaky = await api("GET", "/agents/leaky/package");
  assert.equal(leaky.status, 200, JSON.stringify(leaky.body));
  (await documented(baseUrl))("/agents/{agent_id}/package", "get", "200", leaky.body);
  const fields = leaky.body.report.blocked.map((entry) => `${entry.kind} ${entry.name}`).sort();
  assert.deepEqual(fields, ["pin slack: pin.post.api_key", "pin slack: pin.post.token.0", "pin slack: pin.post.token.1", "trigger Daily: target.input.api_key", ...words.map((_, i) => `trigger Keyed feeds: source.urls.${i}`)], JSON.stringify(leaky.body.report.blocked));
  for (const entry of leaky.body.report.blocked) assert.match(entry.reason, /credential in the clear/, JSON.stringify(entry));
  assert.doesNotMatch(JSON.stringify(leaky.body), /leak-/, "no value in any file or in the report");
  // What holds none still travels: the feed whose query is a page, and the tool whose pin is a channel.
  const kept = asPackage(leaky.body);
  assert.deepEqual(kept.triggers.map((trigger) => [trigger.name, trigger.source.urls]), [["Paged feed", ["https://status.example.com/feed.xml?page=2"]]]);
  assert.deepEqual(kept.mcp.map((need) => [need.toolkit, need.tools, need.pin]), [["slack", ["post", "search"], { search: { channel: "C0STATUS", properties: { keys: ["hs_lead_score"] } } }]]);
});

test("what the agent may not do here, it may not do from the package: a tool its own settings deny, by the tool's key, its server's wildcard or bash's, is not granted; a trigger that messages one of its runs is remade", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { mcpStandIns: true });
  const { api } = server;
  const slack = await startFakeMcp({ name: "slack" });
  t.after(() => slack.close());
  for (const name of ["search", "fetch", "post"]) slack.tools[name] = { description: `slack's ${name}.`, input: { type: "object", properties: {}, additionalProperties: true }, run: () => ({ content: [{ type: "text", text: "{}" }] }) };
  const saved = await api("PUT", "/settings/mcp-servers/slack", { url: slack.url, auth: { type: "none" }, source: "composio", toolkit: "slack" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  // The server's wildcard denies every tool of it but fetch, which its own key asks for (the most specific key holds); bash
  // is denied, and so is every shell tool, which reads bash's setting.
  const toolSettings = { "mcp:slack/*": { permission: "deny" }, "mcp:slack/fetch": { permission: "ask" }, bash: { permission: "deny" } };
  await server.store.agents.create({ id: "guarded", name: "Guarded" }, { id: "guarded-rev", kind: "agentic", body: { instructions: "Read the channel.", tools: ["read", "bash", "mcp:slack/search", "mcp:slack/fetch", "mcp:slack/post"], toolSettings, maxCostUsd: 1 } });
  // A trigger that messages a run of the agent: the run is this server's.
  await server.store.triggers.create({ id: "trg-poke", agentId: "guarded", name: "Poke", enabled: false, source: { kind: "schedule", every_s: 3600 }, target: { kind: "message_run", run_id: "run-of-guarded", input: { content: "Poke." } }, nextAt: null, catchupWindowS: 3600 });

  const exported = await api("GET", "/agents/guarded/package");
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const pkg = asPackage(exported.body);
  assert.deepEqual(pkg.tools, ["read"], "bash denied here is not granted there");
  assert.deepEqual(pkg.mcp.map((need) => [need.toolkit, need.tools]), [["slack", ["fetch"]]], "search and post, denied by the server's wildcard, are not granted there");
  assert.deepEqual(pkg.triggers, [], "a package names no run");
  assert.ok(exported.body.report.remade.some((entry) => entry.kind === "trigger" && entry.name === "Poke"), JSON.stringify(exported.body.report));

  // Bash's read-only policy holds a background shell tool granted without bash; a package writes the policy only beside
  // bash, so the export is blocked rather than let the target run what is refused here.
  await server.store.agents.create({ id: "backgrounded", name: "Backgrounded" }, { id: "backgrounded-rev", kind: "agentic", body: { instructions: "Watch the build.", tools: ["read", "bash_background"], toolSettings: { bash: { policy: "read-only" } }, computer: { kind: "sandbox" }, maxCostUsd: 1 } });
  const background = await api("GET", "/agents/backgrounded/package");
  assert.equal(background.status, 200, JSON.stringify(background.body));
  assert.match(background.body.report.blocked.find((entry) => entry.kind === "tool_policy" && entry.name === "bash")?.reason ?? "", /read-only.*bash_background/, JSON.stringify(background.body.report));

  // Every kind a note has is one the document lists, so a kind left out of it fails here: these answers carry the
  // trigger and tool_policy kinds, and a kind it does not list is refused.
  const check = await documented(server.baseUrl);
  for (const id of ["guarded", "backgrounded"]) check("/agents/{agent_id}/package", "get", "200", (await api("GET", `/agents/${id}/package`)).body);
  const unlisted = structuredClone(background.body);
  unlisted.report.blocked[0].kind = "not_a_kind";
  assert.throws(() => check("/agents/{agent_id}/package", "get", "200", unlisted), /not_a_kind|enum|one of/, "a kind the document does not list");
});
