// Template packages. readPackage is the one validator: the code-review package the server ships reads whole, and a
// malformed one is refused with every problem named, which also stops a server's start. Through the API, GET /v2/templates
// lists the packages, and POST /v2/templates/{template}/apply makes the package's agent with its skills and its model,
// then its triggers, or nothing that stays: parameters that do not check and a secret the server lacks make nothing, and
// a trigger the server refuses deletes the triggers made before it and archives the agent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyBodyOf, PackageError, packageModel, readPackage, readPackages } from "../dist/templates.js";
import { FINDINGS } from "./fixtures/faux-review.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { follow, scratch, serve, withEnv } from "./support.mjs";

const REVIEW = new URL("../templates/code-review/", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/templates/", import.meta.url).pathname;
const REVIEW_FAUX = new URL("./fixtures/faux-review.mjs", import.meta.url).pathname;
const KEY = "BRIEF_FEED_KEY";
const GITHUB_TOOLS = ["pull_request_read", "get_file_contents", "search_code", "get_repository_tree", "pull_request_review_write", "add_comment_to_pending_review"];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const file = (path) => readFileSync(join(REVIEW, path), "utf8");

/** A check of an answer against the served document's schema for it. */
async function documented(baseUrl) {
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  return (path, method, code, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[code].content["application/json"].schema, value), [], `${method} ${path} ${code}: ${JSON.stringify(value)}`);
}

/** The problems readPackage finds in a copy of the code-review package that `change` edits. */
async function problemsOf(t, change) {
  const dir = join(await scratch(t), "code-review");
  cpSync(REVIEW, dir, { recursive: true });
  const manifest = join(dir, "agent.md");
  await change({ dir, edit: (from, to) => writeFileSync(manifest, readFileSync(manifest, "utf8").replace(from, to)) });
  try {
    readPackage(dir);
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return error.problems;
  }
  return [];
}

test("the code-review package reads whole: its review skill with the rules beside it, its findings schema and its eval case", () => {
  const [review] = readPackages();
  assert.deepEqual([review.name, review.version, review.model, review.effort, review.budget, review.learning], ["code-review", "0.1.0", { tier: "fast", prefer: "openrouter/particle-ai/particle-1" }, "low", { per_run_usd: 0.5 }, false]);
  assert.deepEqual(Object.keys(review.skills).sort(), ["review/REVIEW.md", "review/SKILL.md"]);
  assert.equal(review.skills["review/REVIEW.md"], file("rules/REVIEW.md"), "the rule ships beside the SKILL.md that reads it");
  assert.match(review.skills["review/SKILL.md"], /## With GitHub MCP tools/);
  assert.deepEqual([review.output, review.evals, review.triggers, review.secrets], [{ schema: "findings.schema.json" }, ["null-name"], [], []]);
  assert.deepEqual([review.displayName, review.tools, review.mcp], ["Code review: ${parameters.repo}", undefined, [{ server: "github", tools: GITHUB_TOOLS, required: false }]]);
  assert.match(review.instructions, /\$\{parameters\.repo\}/, "placeholders stay unfilled until an apply");
});

test("the validator refuses a malformed package, naming each problem", async (t) => {
  const refused = async (change, pattern) => {
    const problems = await problemsOf(t, change);
    assert.ok(problems.some((p) => pattern.test(p)), `${pattern}: ${JSON.stringify(problems)}`);
  };
  await refused(({ dir }) => rmSync(join(dir, "agent.md")), /^agent\.md: missing/);
  await refused(({ edit }) => edit("version: 0.1.0", "version: v1"), /version is SemVer 2/);
  await refused(({ edit }) => edit("version: 0.1.0", "version: 2"), /version is 2, a number: .*never as definition\.version, which is the agent's revision number/);
  await refused(({ edit }) => edit("learning: false", "learning: false\ndefinition: { version: 2 }"), /no field definition/);
  await refused(({ edit }) => edit("name: code-review", "name: review-code"), /name is the folder's name/);
  await refused(({ edit }) => edit("budget: { per_run_usd: 0.50 }\n", 'triggers:\n  - name: nightly\n    source: { kind: schedule, cron: "0 9 * * *" }\n    target: { kind: start_run }\n'), /budget is required when the package has triggers/);
  await refused(({ edit }) => edit("learning: false", "learning: false\ntriggers:\n  - source: { kind: schedule, cron: \"0 9 * * *\" }\n    target: { kind: start_run }"), /triggers\[0\] has no name/);
  await refused(({ edit }) => edit("learning: false", "learning: false\ntriggers:\n  - name: mine\n    source: { kind: schedule, cron: \"0 9 * * *\" }\n    target: { kind: start_run, agent_id: other }"), /target is a start_run with no agent_id/);
  await refused(({ edit }) => edit("${parameters.repo} with", "${parameters.repository} with"), /\$\{parameters\.repository\} names no parameter/);
  await refused(({ edit }) => edit("effort: low", "effort: off"), /effort is one of/);
  await refused(({ edit }) => edit("tier: fast", "tier: cheap"), /model is \{tier: fast \| balanced \| strong/);
  await refused(({ edit }) => edit("tier: fast", "tier: constructor"), /model is \{tier: fast \| balanced \| strong/);
  await refused(({ edit }) => edit("author: { name: Parcha Labs }", "author: { name: Parcha Labs, emali: team@example.com }"), /author is \{name, email\?, url\?\}/);
  await refused(({ dir }) => rmSync(join(dir, "evals", "null-name", "graders"), { recursive: true }), /evals\/null-name: has no graders/);
  await refused(({ dir }) => writeFileSync(join(dir, "evals", "null-name", "graders", "schema.md"), "---\ntype: vibes\n---\nLooks right.\n"), /graders\/schema\.md: type is one of llm, regex/);
  await refused(({ dir }) => writeFileSync(join(dir, "evals", "null-name", "notes.txt"), "x"), /evals\/null-name\/notes\.txt: a case holds prompt\.md/);
  await refused(({ dir }) => rmSync(join(dir, "evals", "null-name", "prompt.md")), /evals\/null-name: has no prompt\.md/);
  await refused(({ dir }) => symlinkSync("/etc/hostname", join(dir, "skills", "review", "host.md")), /skills\/review\/host\.md: is not a regular file or a folder \(links are refused\)/);
  await refused(({ dir }) => writeFileSync(join(dir, "skills", "review", "REVIEW.md"), "mine"), /rules\/REVIEW\.md: skills\/review\/REVIEW\.md has the same name/);
  await refused(({ dir }) => mkdirSync(join(dir, "scripts")), /scripts\/: a package's folders are skills\/, rules\/ and evals\//);
  await refused(({ edit }) => edit("learning: false", "learning: false\nlearning: true"), /front matter is not YAML/);
  await refused(({ edit }) => edit("server: github", "server: GitHub_Server"), /mcp\[0\] is \{server: an MCP server's name/);
  await refused(({ edit }) => edit("tools: [pull_request_read,", "tools: [pull_request_read, pull_request_read,"), /mcp\[0\] is .*none twice/);
  await refused(({ edit }) => edit(/tools: \[pull_request_read.*\]/, "tools: []"), /mcp\[0\] is /);
  await refused(({ edit }) => edit("learning: false", "learning: false\ntools: [bash, mcp:github/search_code]"), /tools grants no MCP tool: mcp lists them/);
  await refused(({ edit }) => edit('display_name: "Code review: ${parameters.repo}"', 'display_name: "Review of ${parameters.repository}"'), /\$\{parameters\.repository\} names no parameter/);
  assert.deepEqual(await problemsOf(t, () => {}), [], "the copy itself is valid");

  // A broken package the server ships stops its start.
  const broken = join(await scratch(t), "templates");
  cpSync(REVIEW, join(broken, "code-review"), { recursive: true });
  writeFileSync(join(broken, "code-review", "agent.md"), file("agent.md").replace("version: 0.1.0\n", ""));
  await assert.rejects(serve(t, { templates: broken }), (error) => error instanceof PackageError && /version is SemVer 2/.test(error.message));
});

test("a package's model: its preferred one where this server runs it on the harness, else this server's model for its tier", async () => {
  const model = { tier: "fast", prefer: "openrouter/particle-ai/particle-1" };
  assert.equal(await packageModel({ OPENROUTER_API_KEY: "fake-test-key" }, model, "pi"), model.prefer, "a key for its provider runs it");
  assert.equal(await packageModel({ OPENAI_API_KEY: "fake-test-key", AGENT_MODEL_FAST: "openai/gpt-5-mini" }, model, "pi"), "openai/gpt-5-mini", "no OpenRouter key: the fast tier's");
  assert.equal(await packageModel({ OPENAI_API_KEY: "fake-test-key" }, { tier: "strong", prefer: model.prefer }, "pi"), "openai/gpt-6.1-sol", "no tier model set: the default of the key it has");
  assert.equal(await packageModel({ OPENAI_API_KEY: "fake-test-key", AGENT_MODEL: "openai/gpt-5" }, { tier: "balanced" }, "pi"), "openai/gpt-5", "balanced is the server's default");
  assert.equal(await packageModel({ ANTHROPIC_API_KEY: "fake-test-key", OPENROUTER_API_KEY: "fake-test-key" }, model, "claude-agent"), "anthropic/claude-sonnet-5-5", "a harness that cannot run it takes the tier's");
  assert.equal(await packageModel({}, model, "pi"), undefined, "no key at all: none, so the agent runs on the server's default");
  assert.equal(await packageModel({ OPENROUTER_API_KEY: "fake-test-key" }, undefined, "pi"), undefined, "a package that names none");
});

test("code-review through the API: listed, applied with a repo it makes the agent with the review skill, and its model, and a run's answer meets its findings schema", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl } = await serve(t, { faux: REVIEW_FAUX });
  const meets = await documented(baseUrl);

  const listed = await api("GET", "/templates");
  assert.equal(listed.status, 200);
  meets("/templates", "get", "200", listed.body);
  const review = listed.body.templates.find((x) => x.name === "code-review");
  assert.deepEqual([review.version, review.secrets, review.skills, review.evals, review.parameters.repo.required], ["0.1.0", [], ["review"], ["null-name"], true]);

  const applied = await api("POST", "/templates/code-review/apply", { parameters: { repo: "Parcha-ai/agentrun" } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  meets("/templates/{template}/apply", "post", "201", applied.body);
  assert.deepEqual([applied.body.template, applied.body.version, applied.body.trigger_ids], ["code-review", "0.1.0", []]);
  const skipped = applied.body.warnings.find((w) => w.field === "mcp.github");
  assert.match(skipped?.message ?? "", /No MCP server github is saved on this server, so the agent was made without its tools/, JSON.stringify(applied.body.warnings));
  assert.equal(applied.headers.get("location"), `/v2/agents/${applied.body.agent_id}`);

  const agent = (await api("GET", `/agents/${applied.body.agent_id}`)).body;
  meets("/agents/{agent_id}", "get", "200", agent);
  const { definition } = agent;
  assert.deepEqual([definition.name, definition.version, definition.harness, definition.thinking, definition.max_cost_usd, definition.learning, definition.skills], ["Code review: Parcha-ai/agentrun", 1, "pi", "low", 0.5, false, ["review"]], "definition.version is the revision number, never the package's");
  assert.deepEqual([definition.tools, definition.tool_settings], [[], undefined], "no box and no GitHub MCP server here: no tools");
  assert.equal(definition.model, "openrouter/particle-ai/particle-1", "its preferred model, which this server runs");
  assert.match(definition.instructions, /Clone https:\/\/github\.com\/Parcha-ai\/agentrun\s/);
  const files = Object.fromEntries(agent.skills.map((s) => [s.path, s.sha256]));
  assert.deepEqual(files, { "review/REVIEW.md": sha256(file("rules/REVIEW.md")), "review/SKILL.md": sha256(file("skills/review/SKILL.md")) });

  const other = await api("POST", "/templates/code-review/apply", { parameters: { repo: "Parcha-ai/agentrun" }, overrides: { model: "openrouter/other-lab/other-model" } });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  assert.notEqual(other.body.agent_id, applied.body.agent_id, "each apply makes its own agent");
  assert.equal((await api("GET", `/agents/${other.body.agent_id}`)).body.definition.model, "openrouter/other-lab/other-model", "the person applying overrides the model");

  const run = await api("POST", `/agents/${applied.body.agent_id}/runs`, { input: { content: file("evals/null-name/prompt.md").replace(/^---[\s\S]*?---\n/, "") } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
  const done = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.equal(done.cost.cap_usd, 0.5, "capped at the package's budget");
  const block = [...done.result.final_answer.matchAll(/```json\n([\s\S]*?)\n```/g)].at(-1)?.[1];
  assert.ok(block, `a fenced json block: ${done.result.final_answer}`);
  const schema = JSON.parse(file("findings.schema.json"));
  assert.deepEqual(schemaProblems(schema, schema, JSON.parse(block)), []);
  assert.deepEqual(JSON.parse(block), FINDINGS);
  assert.ok(schemaProblems(schema, schema, { ...FINDINGS, findings: [{ ...FINDINGS.findings[0], severity: "blocker" }] }).length, "the schema is a real check");
});

test("apply makes nothing when a secret is missing, its parameters do not check, or the package is unknown; it takes the token as creating an agent does", async (t) => {
  withEnv(t, {}, [KEY]);
  const { api, baseUrl } = await serve(t, { templates: FIXTURES });
  const refused = await api("POST", "/templates/nightly/apply", { parameters: { topic: "solar" } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.match(refused.body.error.message, /needs BRIEF_FEED_KEY.*Nothing was created/);
  assert.deepEqual(refused.body.error.fields.map((f) => [f.field, f.reason]), [[`secrets.${KEY}`, "not_set_up_here"]]);

  const field = async (body, name, reason) => {
    const answer = await api("POST", "/templates/nightly/apply", body);
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.ok(answer.body.error.fields.some((f) => f.field === name && f.reason === reason), `${name} ${reason}: ${JSON.stringify(answer.body.error.fields)}`);
  };
  await field({ parameters: {} }, "parameters.topic", "missing");
  await field({ parameters: { topic: "solar", words: "two hundred" } }, "parameters.words", "wrong_type");
  await field({ parameters: { topic: "solar", tone: "dry" } }, "parameters.tone", "not_allowed");
  await field({ parameters: { topic: "solar" }, overrides: { tools: ["bash"] } }, "overrides.tools", "not_allowed");
  await field({ parameters: { topic: "solar" }, overrides: { model: "particle-1" } }, "overrides.model", "bad_format");
  assert.equal((await api("POST", "/templates/nope/apply", { parameters: {} })).status, 404);
  const tracker = await api("POST", "/templates/watcher/apply", {});
  assert.equal(tracker.status, 409, JSON.stringify(tracker.body));
  assert.match(tracker.body.error.message, /needs the MCP server tracker.*Nothing was created/);
  assert.deepEqual(tracker.body.error.fields.map((f) => [f.field, f.reason]), [["mcp.tracker", "not_set_up_here"]]);

  const anonymous = await fetch(`${baseUrl}/templates/nightly/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parameters: { topic: "solar" } }) });
  assert.equal(anonymous.status, 401);
  assert.equal((await fetch(`${baseUrl}/templates`)).status, 401);
  assert.deepEqual([(await api("GET", "/agents")).body.agents, (await api("GET", "/triggers")).body.triggers], [[], []], "nothing was made");
});

test("a package's triggers are made on its agent, placeholders filled; a trigger the server refuses deletes the triggers made before it and archives the agent", async (t) => {
  withEnv(t, { [KEY]: "fake-test-key" });
  const { api } = await serve(t, { templates: FIXTURES });
  assert.deepEqual((await api("GET", "/templates")).body.templates.map((x) => x.name), ["broken", "nightly", "watcher"]);

  const body = { parameters: { topic: "solar", words: 200 } };
  const applied = await api("POST", "/templates/nightly/apply", body, { "idempotency-key": "nightly-1" });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const [id] = applied.body.trigger_ids;
  const trigger = (await api("GET", `/triggers/${id}`)).body;
  assert.deepEqual([trigger.name, trigger.enabled, trigger.source.cron], ["Morning brief", true, "0 9 * * *"]);
  assert.deepEqual(trigger.target, { kind: "start_run", agent_id: applied.body.agent_id, input: { content: "Today's brief on solar." } });
  const agent = (await api("GET", `/agents/${applied.body.agent_id}`)).body;
  assert.deepEqual([agent.definition.name, agent.definition.instructions, agent.definition.max_cost_usd], ["nightly", "Write a brief of about 200 words on solar.", 0.25]);
  const again = await api("POST", "/templates/nightly/apply", body, { "idempotency-key": "nightly-1" });
  assert.deepEqual([again.status, again.headers.get("idempotent-replayed"), again.body], [201, "true", applied.body], "the same key answers the first apply, and makes nothing");

  const broken = await api("POST", "/templates/broken/apply", { parameters: {} });
  assert.equal(broken.status, 422, JSON.stringify(broken.body));
  assert.deepEqual(broken.body.error.fields.map((f) => f.field), ["triggers.1.source.cron"]);
  assert.deepEqual((await api("GET", "/triggers")).body.triggers.map((x) => x.id), [id], "the broken package's first trigger is gone");
  assert.deepEqual((await api("GET", "/agents")).body.agents.map((a) => a.agent_id), [applied.body.agent_id], "its agent is not among the active ones");
  const archived = (await api("GET", "/agents?archived=true")).body.agents;
  assert.deepEqual(archived.map((a) => [a.definition.name, typeof a.archived_at]), [["broken", "string"]], "it is archived");
  assert.equal((await api("GET", `/triggers`)).body.triggers.some((x) => x.target.agent_id === archived[0].agent_id), false, "with no trigger left on it");
});

test("code-review on a server with a GitHub MCP server saved: its tools are granted and set to allow, beside the server's own", async (t) => {
  const { api } = await serve(t);
  const github = await startFakeMcp({ name: "github" });
  t.after(() => github.close());
  for (const name of GITHUB_TOOLS) github.tools[name] = { description: `GitHub's ${name}.`, input: { type: "object", properties: {}, additionalProperties: true }, run: () => ({ content: [{ type: "text", text: "{}" }] }) };
  assert.equal((await api("PUT", "/settings/mcp-servers/github", { url: github.url, auth: { type: "none" } })).status, 200);

  const applied = await api("POST", "/templates/code-review/apply", { parameters: { repo: "Parcha-ai/agentrun" } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.warnings.find((w) => w.field === "mcp.github"), undefined, "nothing skipped");
  const agent = (await api("GET", `/agents/${applied.body.agent_id}`)).body;
  const granted = GITHUB_TOOLS.map((name) => `mcp:github/${name}`);
  assert.deepEqual(agent.definition.tools, granted, "no box here, so the GitHub tools alone");
  assert.deepEqual(agent.definition.tool_settings, Object.fromEntries(granted.map((tool) => [tool, { permission: "allow" }])), "allowed, so a triggered run never waits on an ask");
  for (const tool of granted) assert.equal(agent.tools.find((x) => x.name === tool)?.permission, "allow", tool);
});

test("a parameter is read from the caller's own fields: a required one named constructor is missing from {parameters: {}}", async (t) => {
  const dir = join(await scratch(t), "inherits");
  mkdirSync(dir);
  writeFileSync(join(dir, "agent.md"), "---\nname: inherits\nversion: 1.0.0\ndescription: A parameter named as an Object property.\nparameters:\n  constructor: { type: string, required: true, description: the builder }\n---\nBuilt by ${parameters.constructor}.\n");
  const p = readPackage(dir);
  assert.throws(() => applyBodyOf(p, { parameters: {} }), (error) => error.extra?.fields?.some((f) => f.field === "parameters.constructor" && f.reason === "missing"));
  assert.deepEqual(applyBodyOf(p, { parameters: { constructor: "Ada" } }).parameters, { constructor: "Ada" });
});
