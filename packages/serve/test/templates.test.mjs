// Template packages. readPackage is the one validator: the code-review package the server ships reads whole, and a
// malformed one is refused with every problem named, which also stops a server's start. Through the API, GET /v2/templates
// lists the packages, and POST /v2/templates/{template}/apply makes the package's agent with its skills and its model,
// then its triggers, or nothing that stays: parameters that do not check and a secret the server lacks make nothing, and
// a trigger the server refuses deletes the triggers made before it and archives the agent.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyBodyOf, compiled, PackageError, packageModel, readPackage, readPackages } from "../dist/templates.js";
import { AGENT_LAYER_PINS } from "../dist/tool-plane.js";
import { FINDINGS } from "./fixtures/faux-review.mjs";

/** An apply's warnings that a granted tool needs a key this server lacks (runnable.ts: "The tool <t> needs <key>"). */
const keyedWarnings = (body) => body.warnings.filter((w) => w.reason === "not_set_up_here" && /^The tool \S+ needs /.test(w.message ?? ""));
import { schemaProblems } from "./schema-support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { follow, scratch, serve, withEnv } from "./support.mjs";

const REVIEW = new URL("../templates/code-review/", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/templates/", import.meta.url).pathname;
const REVIEW_FAUX = new URL("./fixtures/faux-review.mjs", import.meta.url).pathname;
const KEY = "PARALLEL_API_KEY";
const GITHUB_READS = ["pull_request_read", "get_file_contents", "search_code", "get_repository_tree"];
const GITHUB_TOOLS = [...GITHUB_READS, "pull_request_review_write", "add_comment_to_pending_review"];
/** code-review's pin of its review write: COMMENT reviews only, never APPROVE, REQUEST_CHANGES or resolve_thread. */
const REVIEW_PIN = { method: ["create", "submit_pending", "delete_pending"], event: [null, "COMMENT"] };
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
  assert.deepEqual(Object.keys(review.skills).sort(), ["review/REVIEW.md", "review/SKILL.md", "review/findings.schema.json"]);
  assert.equal(review.skills["review/findings.schema.json"], file("findings.schema.json"), "the answer's schema ships beside the SKILL.md that names it");
  assert.equal(review.skills["review/REVIEW.md"], file("rules/REVIEW.md"), "the rule ships beside the SKILL.md that reads it");
  assert.match(review.skills["review/SKILL.md"], /## With GitHub MCP tools/);
  assert.deepEqual([review.output, review.evals, review.triggers, review.secrets], [{ schema: "findings.schema.json" }, ["clean-refactor", "injection", "null-name", "off-by-one", "re-review", "repo-rule"], [], []]);
  assert.deepEqual([review.displayName, review.tools, review.mcp], ["Code review: ${parameters.repo}", ["read"], [{ server: "github", tools: GITHUB_TOOLS, required: false, allow: GITHUB_READS, pin: { pull_request_review_write: { method: ["create", "submit_pending", "delete_pending"], event: [null, "COMMENT"] } } }]]);
  assert.match(review.instructions, /\$\{parameters\.repo\}/, "placeholders stay unfilled until an apply");
});

test("a package names each trigger once, compared as a trigger keeps its name (trimmed): two that differ only by spaces are refused, so an apply never meets the store's one name per agent", async (t) => {
  const twice = (second) => ({ edit }) => edit("learning: false", `learning: false\ntriggers:\n  - name: nightly\n    source: { kind: schedule, cron: "0 9 * * *" }\n    target: { kind: start_run }\n  - name: ${second}\n    source: { kind: schedule, cron: "0 10 * * *" }\n    target: { kind: start_run }`);
  for (const second of ["nightly", '"nightly "', '" nightly"']) {
    const problems = await problemsOf(t, twice(second));
    assert.ok(problems.includes("agent.md: triggers[1]: two triggers are named nightly"), `${second}: ${JSON.stringify(problems)}`);
  }
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
  await refused(({ edit }) => edit("tools: [read]", "tools: [read, mcp:github/search_code]"), /tools grants no MCP tool: mcp lists them/);
  await refused(({ edit }) => edit('display_name: "Code review: ${parameters.repo}"', 'display_name: "Review of ${parameters.repository}"'), /\$\{parameters\.repository\} names no parameter/);
  // The keys a package needs are keys this server can hold: Settings saves them, and a run is handed them.
  await refused(({ edit }) => edit("learning: false", "learning: false\nsecrets: [BRIEF_FEED_KEY]"), /secrets names BRIEF_FEED_KEY, a key this server cannot hold/);
  // What an apply would refuse is refused here: a trigger's body, a tool this server does not bind, a skill file's path.
  const trigger = (source, rest = "") => edit => edit("learning: false", `learning: false\ntriggers:\n  - name: nightly\n    source: ${source}\n    target: { kind: start_run, input: { content: Go. } }${rest}`);
  await refused(({ edit }) => trigger("{ kind: schedule, cron: every morning }")(edit), /triggers\[0\]\.source\.cron: cron is five fields/);
  await refused(({ edit }) => trigger('{ kind: schedule, cron: "0 9 * * *" }', "\n    colour: red")(edit), /triggers\[0\]\.colour: /);
  await refused(({ edit }) => trigger("{ kind: schedule, at: next tuesday }")(edit), /triggers\[0\]\.source\.at: at is an RFC 3339 date-time/);
  // A trigger's input is the run's input: the package's agent takes {content: text}, so another one is refused here.
  await refused(({ edit }) => edit("learning: false", "learning: false\ntriggers:\n  - name: nightly\n    source: { kind: schedule, cron: \"0 9 * * *\" }\n    target: { kind: start_run, input: { content: 5 } }"), /triggers\[0\]\.target\.input\.content: /);
  await refused(({ edit }) => edit("learning: false", "learning: false\ntriggers:\n  - name: nightly\n    source: { kind: schedule, cron: \"0 9 * * *\" }\n    target: { kind: start_run, input: { text: Go. } }"), /triggers\[0\]\.target\.input\.content: /);
  // A date is checked for its form alone: one that has passed stops no server's start; an apply refuses it.
  assert.deepEqual(await problemsOf(t, ({ edit }) => trigger('{ kind: schedule, at: "2020-01-01T00:00:00Z" }')(edit)), [], "a date that has passed still reads");
  // A schedule's cron and timezone may come from a parameter with a default, which is checked here as the schedule.
  const scheduled = (cron, spec) => ({ edit }) => {
    edit("learning: false", `learning: false\ntriggers:\n  - name: nightly\n    source: { kind: schedule, cron: "${cron}", timezone: "\${parameters.zone}" }\n    target: { kind: start_run, input: { content: Go. } }`);
    edit("  repo: {", `${spec}\n  zone: { type: string, default: UTC, description: the zone }\n  repo: {`);
  };
  await refused(scheduled("${parameters.cron}", "  cron: { type: string, description: the schedule }"), /parameters\.cron is used in triggers\[0\]\.source\.cron, so it needs a default/);
  await refused(scheduled("${parameters.cron}", '  cron: { type: string, default: "every morning", description: the schedule }'), /triggers\[0\]\.source\.cron: cron is five fields/);
  await refused(scheduled("${parameters.cron}", "  cron: { type: string, default: 7, description: the schedule }"), /parameters\.cron\.default is a string/);
  assert.deepEqual(await problemsOf(t, scheduled("${parameters.cron}", '  cron: { type: string, default: "0 8 * * 1", description: the schedule }')), [], "a schedule from parameters with good defaults reads");
  await refused(({ edit }) => trigger('{ kind: schedule, cron: "${parameters.repo}" }')(edit), /parameters\.repo is used in triggers\[0\]\.source\.cron, so it needs a default/);
  await refused(({ edit }) => edit("learning: false", 'learning: false\ntriggers:\n  - name: "nightly ${parameters.repo}"\n    source: { kind: schedule, cron: "0 9 * * *" }\n    target: { kind: start_run, input: { content: Go. } }'), /triggers\[0\]\.name holds \$\{parameters\.repo\}: a placeholder goes in display_name, the instructions, a trigger's target\.input, a schedule's cron and timezone, or an mcp pin's values/);
  await refused(({ edit }) => edit("tools: [read]", "tools: [read, bassh]"), /tools: bassh is not a tool this server binds/);
  await refused(({ dir }) => writeFileSync(join(dir, "skills", "review", "a\\b.md"), "x"), /skills\/review\/a\\b\.md: the skill path/);
  // An MCP tool is one tool by its name: `*`, the server's wildcard, is none; and a package asks allow only of its own.
  await refused(({ edit }) => edit("tools: [pull_request_read,", "tools: ['*', pull_request_read,"), /mcp\[0\] is /);
  await refused(({ edit }) => edit("allow: [pull_request_read,", "allow: [create_repository, pull_request_read,"), /mcp\[0\] is .*allow\?: the tools of its tools it asks the owner to allow/);
  // Bounded: a file, the whole package, and its number of files.
  await refused(({ dir }) => writeFileSync(join(dir, "skills", "review", "big.md"), "x".repeat(256 * 1024 + 1)), /skills\/review\/big\.md: is over 262144 bytes/);
  await refused(({ dir }) => { for (let i = 0; i < 5; i++) writeFileSync(join(dir, "skills", "review", `part-${i}.md`), "x".repeat(250 * 1024)); }, /the package's files are over 1048576 bytes together/);
  await refused(({ dir }) => { mkdirSync(join(dir, "evals", "null-name", "fixtures")); for (let i = 0; i < 260; i++) writeFileSync(join(dir, "evals", "null-name", "fixtures", `${i}.txt`), "x"); }, /the package holds over 256 files/);
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
  assert.deepEqual(listed.body.templates.map((x) => x.name), ["code-review", "inbound-lead", "kyb", "market-monitor", "release-notes"]);
  const review = listed.body.templates.find((x) => x.name === "code-review");
  assert.deepEqual([review.version, review.secrets, review.skills, review.evals, review.parameters.repo.required], ["0.1.0", [], ["review"], ["clean-refactor", "injection", "null-name", "off-by-one", "re-review", "repo-rule"], true]);

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
  assert.deepEqual([definition.tools, definition.tool_settings], [["read"], undefined], "no box and no GitHub MCP server here: its read alone, for the skill's rules");
  assert.equal(definition.model, "openrouter/particle-ai/particle-1", "its preferred model, which this server runs");
  assert.match(definition.instructions, /clone https:\/\/github\.com\/Parcha-ai\/agentrun\s/);
  assert.match(definition.instructions, /With the GitHub tools \(`mcp:github\/\.\.\.`\) and no shell, read everything through them/);
  const files = Object.fromEntries(agent.skills.map((s) => [s.path, s.sha256]));
  assert.deepEqual(files, { "review/REVIEW.md": sha256(file("rules/REVIEW.md")), "review/SKILL.md": sha256(file("skills/review/SKILL.md")), "review/findings.schema.json": sha256(file("findings.schema.json")) }, "the skill, its rule and its answer schema reach the agent");

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
  assert.match(refused.body.error.message, /needs PARALLEL_API_KEY.*Nothing was created/);
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

test("a package's triggers are made on its agent, placeholders filled; a trigger the server would refuse refuses the apply before anything is made", async (t) => {
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
  assert.deepEqual(broken.body.error.fields.map((f) => [f.field, f.message]), [["triggers.1.source.at", "at is in the past"]]);
  assert.deepEqual((await api("GET", "/triggers")).body.triggers.map((x) => x.id), [id], "the broken package's first trigger was never made");
  assert.deepEqual((await api("GET", "/agents")).body.agents.map((a) => a.agent_id), [applied.body.agent_id], "nor its agent");
  assert.deepEqual((await api("GET", "/agents?archived=true")).body.agents, [], "every trigger is checked before the agent is made, so a refused one archives nothing");
});

test("code-review's GitHub tools: granted, never allowed by the package itself; only the owner's grants at apply become allow, and a deny the owner set stays", async (t) => {
  const { api } = await serve(t);
  const github = await startFakeMcp({ name: "github" });
  t.after(() => github.close());
  for (const name of GITHUB_TOOLS) github.tools[name] = { description: `GitHub's ${name}.`, input: { type: "object", properties: {}, additionalProperties: true }, run: () => ({ content: [{ type: "text", text: "{}" }] }) };
  assert.equal((await api("PUT", "/settings/mcp-servers/github", { url: github.url, auth: { type: "none" } })).status, 200);
  const granted = GITHUB_TOOLS.map((name) => `mcp:github/${name}`);
  const permissions = async (id) => Object.fromEntries((await api("GET", `/agents/${id}`)).body.tools.filter((x) => granted.includes(x.name)).map((x) => [x.name.slice("mcp:github/".length), x.permission]));

  // What a consent screen shows: each tool, and the permission the package asks for it.
  const listed = (await api("GET", "/templates")).body.templates.find((x) => x.name === "code-review");
  assert.deepEqual(listed.mcp, [{ server: "github", required: false, tools: GITHUB_TOOLS.map((name) => ({ name, tool: `mcp:github/${name}`, asks: GITHUB_READS.includes(name) ? "allow" : "ask", ...(name === "pull_request_review_write" ? { pin: REVIEW_PIN } : {}) })) }]);

  // No grants: the tools are the agent's, each at the owner's own setting (here the default, ask).
  const plain = await api("POST", "/templates/code-review/apply", { parameters: { repo: "Parcha-ai/agentrun" } });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(plain.body.warnings.find((w) => w.field === "mcp.github"), undefined, "nothing skipped");
  const agent = (await api("GET", `/agents/${plain.body.agent_id}`)).body;
  assert.deepEqual(agent.definition.tools, ["read", ...granted], "its read, for the skill's rules, and the GitHub tools; no box here, so no shell");
  assert.deepEqual(agent.definition.tool_settings, AGENT_LAYER_PINS ? { "mcp:github/pull_request_review_write": { pin: { event: [null, "COMMENT"], method: ["create", "delete_pending", "submit_pending"] } } } : undefined, "the package sets no permission");
  // Its review write is bounded to COMMENT reviews even once granted; until the store cutover the apply says how.
  if (!AGENT_LAYER_PINS) {
    const pinned = plain.body.warnings.filter((w) => w.field.startsWith("pins."));
    assert.deepEqual(pinned.map((w) => [w.field, w.reason]), [["pins.mcp:github/pull_request_review_write", "not_set_up_here"]]);
    assert.match(pinned[0].message, /^mcp:github\/pull_request_review_write is not pinned to event in \(absent \| COMMENT\), method in \(create \| delete_pending \| submit_pending\) for this agent yet/);
  }
  assert.deepEqual(await permissions(plain.body.agent_id), Object.fromEntries(GITHUB_TOOLS.map((name) => [name, "ask"])));

  // The owner's grants, and only those, become allow; one the package does not list is refused, and nothing is made.
  const reads = GITHUB_READS.map((name) => `mcp:github/${name}`);
  const before = (await api("GET", "/agents")).body.agents.length;
  const stranger = await api("POST", "/templates/code-review/apply", { parameters: { repo: "Parcha-ai/agentrun" }, grants: [...reads, "mcp:github/create_repository", "mcp:github/*"] });
  assert.equal(stranger.status, 422, JSON.stringify(stranger.body));
  assert.deepEqual(stranger.body.error.fields.map((f) => [f.field, f.reason]), [["grants.4", "not_allowed"], ["grants.5", "not_allowed"]]);
  assert.equal((await api("GET", "/agents")).body.agents.length, before, "nothing was made");

  // A deny the owner set on this server is never lifted by a grant: the agent's runs stay refused the tool, and the apply says so.
  assert.equal((await api("PUT", "/settings/tools", { "mcp:github/get_file_contents": { permission: "deny" } })).status, 200);
  const consented = await api("POST", "/templates/code-review/apply", { parameters: { repo: "Parcha-ai/agentrun" }, grants: reads });
  assert.equal(consented.status, 201, JSON.stringify(consented.body));
  assert.deepEqual((await api("GET", `/agents/${consented.body.agent_id}`)).body.definition.tool_settings, Object.fromEntries(reads.filter((tool) => tool !== "mcp:github/get_file_contents").map((tool) => [tool, { permission: "allow" }])));
  assert.deepEqual(await permissions(consented.body.agent_id), { pull_request_read: "allow", get_file_contents: "deny", search_code: "allow", get_repository_tree: "allow", pull_request_review_write: "ask", add_comment_to_pending_review: "ask" });
  assert.deepEqual(consented.body.warnings.filter((w) => w.field.startsWith("grants.")).map((w) => [w.field, w.reason]), [["grants.mcp:github/get_file_contents", "not_allowed"]]);
});

test("every package this server ships applies on a server with nothing saved: no key, no MCP server; what it lacks is a warning, and no tool it grants needs a key", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "KERNEL_API_KEY", "TYPESAFE_API_KEY"]);
  const { api } = await serve(t);
  const parameters = {
    "code-review": { repo: "Parcha-ai/agentrun" },
    "inbound-lead": { icp: "B2B fintech, 50-2000 people, US or EU; never gambling operators", post_to: "none" },
    kyb: { risk_appetite: "medium" },
    "market-monitor": { competitors: "Acme (acme.example)" },
    "release-notes": { repo: "Parcha-ai/agentrun" },
  };
  const listed = (await api("GET", "/templates")).body.templates;
  assert.deepEqual(listed.map((x) => x.name), Object.keys(parameters), "a new package gets its parameters here");
  for (const { name, mcp } of listed) {
    const applied = await api("POST", `/templates/${name}/apply`, { parameters: parameters[name] });
    // An MCP server a package cannot work without is the one refusal: 409 naming it, nothing made.
    const required = mcp.filter((need) => need.required).map((need) => `mcp.${need.server}`);
    if (required.length) {
      assert.equal(applied.status, 409, `${name}: ${JSON.stringify(applied.body)}`);
      assert.deepEqual(applied.body.error.fields.map((f) => f.field), required);
      continue;
    }
    assert.equal(applied.status, 201, `${name}: ${JSON.stringify(applied.body)}`);
    const keyed = keyedWarnings(applied.body);
    assert.deepEqual(keyed, [], `${name} grants a tool that needs a key, so its runs would be refused here`);
    const agent = (await api("GET", `/agents/${applied.body.agent_id}`)).body;
    assert.equal(agent.definition.tool_settings, undefined, `${name}: no grant was given, so no tool is allowed`);
  }
});

test("the keyed-tool check above sees a tool that needs a key: a package granting monid.run is warned, the warning the check reads", async (t) => {
  withEnv(t, {}, ["MONID_API_KEY"]);
  const dir = join(await scratch(t), "templates");
  mkdirSync(join(dir, "keyed"), { recursive: true });
  writeFileSync(join(dir, "keyed", "agent.md"), "---\nname: keyed\nversion: 1.0.0\ndescription: Grants a tool that needs a key.\ntools: [monid.run]\n---\nRun.\n");
  const { api } = await serve(t, { templates: dir });
  const applied = await api("POST", "/templates/keyed/apply", {});
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(keyedWarnings(applied.body).length, 1, JSON.stringify(applied.body.warnings));
});

test("no package lets its agent write or send unasked: each MCP tool a package lists is a known read or write, and no write is in its allow", () => {
  // An agent that reads untrusted content (pages, PRs, payloads) never gets a write or send tool at allow: a pin fixes a
  // send's destination, but not what it says, nor a write's record, so a write asks until the owner grants it at apply. A tool new to a package is
  // classified here before it ships.
  const WRITES = new Set(["github/pull_request_review_write", "github/add_comment_to_pending_review", "github/issue_write", "hubspot/manage_crm_objects", "slack/slack_send_message", "gmail/GMAIL_SEND_EMAIL"]);
  const READS = new Set([
    ...["pull_request_read", "get_file_contents", "search_code", "get_repository_tree", "list_releases", "get_latest_release", "get_release_by_tag", "list_tags", "get_tag", "list_commits", "get_commit", "search_pull_requests", "search_issues", "get_label"].map((tool) => `github/${tool}`),
    ...["search_crm_objects", "get_crm_objects", "search_properties", "tool_guidance"].map((tool) => `hubspot/${tool}`),
  ]);
  const listed = readPackages().flatMap((p) => p.mcp.flatMap((need) => need.tools.map((tool) => ({ p: p.name, id: `${need.server}/${tool}`, allowed: need.allow.includes(tool) }))));
  for (const { p, id } of listed) assert.ok(WRITES.has(id) || READS.has(id), `${p} lists ${id}, neither a known read nor a known write: classify it here`);
  assert.deepEqual(listed.filter((x) => x.allowed && WRITES.has(x.id)).map((x) => `${x.p}: ${x.id}`), [], "a write at allow");
  assert.ok(listed.some((x) => WRITES.has(x.id)) && listed.some((x) => x.allowed), "the check sees both writes and allowed tools");
});

test("a package with a webhook trigger, on a server with no seal key to keep its secret, is refused before anything is made", async (t) => {
  withEnv(t, {}, ["AGENTRUN_SEAL_KEY"]);
  const { api } = await serve(t);
  const refused = await api("POST", "/templates/inbound-lead/apply", { parameters: { icp: "B2B fintech", post_to: "none" } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.deepEqual(refused.body.error.fields.map((f) => [f.field, f.reason]), [["triggers.0", "not_set_up_here"]]);
  assert.match(refused.body.error.fields[0].fix, /AGENTRUN_SEAL_KEY/);
  assert.deepEqual([(await api("GET", "/agents?archived=true")).body.agents, (await api("GET", "/triggers")).body.triggers], [[], []], "nothing was made, not even an archived agent");
});

test("a server-wide deny of every tool of an MCP server (mcp:<server>/*) keeps each grant of it denied", async (t) => {
  const { api } = await serve(t);
  const github = await startFakeMcp({ name: "github" });
  t.after(() => github.close());
  for (const name of GITHUB_TOOLS) github.tools[name] = { description: `GitHub's ${name}.`, input: { type: "object", properties: {}, additionalProperties: true }, run: () => ({ content: [{ type: "text", text: "{}" }] }) };
  assert.equal((await api("PUT", "/settings/mcp-servers/github", { url: github.url, auth: { type: "none" } })).status, 200);
  assert.equal((await api("PUT", "/settings/tools", { "mcp:github/*": { permission: "deny" } })).status, 200);
  const granted = GITHUB_TOOLS.map((name) => `mcp:github/${name}`);
  const applied = await api("POST", "/templates/code-review/apply", { parameters: { repo: "Parcha-ai/agentrun" }, grants: granted });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = (await api("GET", `/agents/${applied.body.agent_id}`)).body;
  assert.equal(agent.definition.tool_settings, undefined, "no grant is written over the wildcard deny");
  assert.deepEqual(agent.tools.filter((x) => granted.includes(x.name)).map((x) => [x.name, x.permission]), granted.map((tool) => [tool, "deny"]));
  assert.deepEqual(applied.body.warnings.filter((w) => w.field.startsWith("grants.")).map((w) => w.field), granted.map((tool) => `grants.${tool}`));
});

test("a key the owner saved in Settings, not set where the server starts, is a package's secret", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, [KEY]);
  const { api } = await serve(t, { templates: FIXTURES });
  const body = { parameters: { topic: "solar" } };
  assert.equal((await api("POST", "/templates/nightly/apply", body)).status, 409, "not set, not saved");
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { [KEY]: "fake-test-key" } })).status, 204);
  const applied = await api("POST", "/templates/nightly/apply", body);
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
});

test("an apply whose parameters, filled in, make a body over POST /v2/agents' 1 MiB limit is 413, and makes nothing", async (t) => {
  const dir = join(await scratch(t), "templates");
  mkdirSync(join(dir, "echo"), { recursive: true });
  writeFileSync(join(dir, "echo", "agent.md"), "---\nname: echo\nversion: 1.0.0\ndescription: Repeats its text.\nparameters:\n  text: { type: string, required: true, description: the text }\n---\n${parameters.text}\n\n${parameters.text}\n");
  const { api } = await serve(t, { templates: dir });
  const answer = await api("POST", "/templates/echo/apply", { parameters: { text: "x".repeat(600 * 1024) } });
  assert.equal(answer.status, 413, JSON.stringify(answer.body).slice(0, 300));
  assert.equal(answer.body.error.code, "payload_too_large");
  assert.deepEqual((await api("GET", "/agents")).body.agents, [], "nothing was made");
});

test("market-monitor's schedule comes from its parameters: Monday 08:00 UTC by default, the owner's own when given, and a bad one refuses the apply before anything is made", async (t) => {
  const { api } = await serve(t);
  const apply = (parameters) => api("POST", "/templates/market-monitor/apply", { parameters: { competitors: "Acme (acme.example)", ...parameters } });
  const sourceOf = async (applied) => (await api("GET", `/triggers/${applied.body.trigger_ids[0]}`)).body.source;
  const plain = await apply({});
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual(await sourceOf(plain), { kind: "schedule", cron: "0 8 * * 1", timezone: "UTC" });
  const own = await apply({ cron: "30 9 * * 2", timezone: "Europe/Madrid" });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.deepEqual(await sourceOf(own), { kind: "schedule", cron: "30 9 * * 2", timezone: "Europe/Madrid" });
  const agents = (await api("GET", "/agents")).body.agents.length;
  for (const [given, field] of [[{ cron: "every morning" }, "triggers.0.source.cron"], [{ timezone: "Mars/Olympus" }, "triggers.0.source.timezone"]]) {
    const bad = await apply(given);
    assert.equal(bad.status, 422, JSON.stringify(bad.body));
    assert.deepEqual(bad.body.error.fields.map((f) => f.field), [field]);
  }
  assert.equal((await api("GET", "/agents")).body.agents.length, agents, "a refused schedule makes no agent");
  assert.deepEqual((await api("GET", "/agents?archived=true")).body.agents, [], "and archives none");
});

test("every shipped package's agent gets its answer schema beside its skill, and its skill names that file", () => {
  for (const p of readPackages()) {
    if (!p.output) continue;
    const skills = Object.keys(p.skills).filter((path) => path.endsWith("/SKILL.md")).map((path) => path.slice(0, -"/SKILL.md".length));
    for (const skill of skills) {
      assert.ok(Object.hasOwn(p.skills, `${skill}/${p.output.schema}`), `${p.name}: ${skill}/${p.output.schema} ships with the agent`);
      assert.match(p.skills[`${skill}/SKILL.md`], new RegExp(p.output.schema.replace(/\./g, "\\.")), `${p.name}: the ${skill} skill names its schema`);
    }
  }
});

test("a parameter is read from the caller's own fields: a required one named constructor is missing from {parameters: {}}", async (t) => {
  const dir = join(await scratch(t), "inherits");
  mkdirSync(dir);
  writeFileSync(join(dir, "agent.md"), "---\nname: inherits\nversion: 1.0.0\ndescription: A parameter named as an Object property.\nparameters:\n  constructor: { type: string, required: true, description: the builder }\n---\nBuilt by ${parameters.constructor}.\n");
  const p = readPackage(dir);
  assert.throws(() => applyBodyOf(p, { parameters: {} }), (error) => error.extra?.fields?.some((f) => f.field === "parameters.constructor" && f.reason === "missing"));
  assert.deepEqual(applyBodyOf(p, { parameters: { constructor: "Ada" } }).parameters, { constructor: "Ada" });
});

/** The problems readPackage finds in a package of one Slack send, whose `mcp` entry is `entry` (YAML). */
function pinProblems(t, entry) {
  return scratch(t).then((root) => {
    const dir = join(root, "sender");
    mkdirSync(dir);
    writeFileSync(join(dir, "agent.md"), `---\nname: sender\nversion: 1.0.0\ndescription: Sends one message.\nparameters:\n  channel: { type: string, description: the channel's id }\n  count: { type: integer, description: how many }\nmcp:\n  - server: slack\n    tools: [slack_send_message, slack_search]\n${entry}\n---\nSend to \${parameters.channel}.\n`);
    try {
      return { p: readPackage(dir), problems: [] };
    } catch (error) {
      assert.ok(error instanceof PackageError, error.stack);
      return { problems: error.problems };
    }
  });
}

test("an mcp entry's pin is checked: each tool one of the entry's, 1 to 8 arguments, each a scalar, a placeholder only a declared parameter", async (t) => {
  const { p } = await pinProblems(t, '    pin: { slack_send_message: { channel_id: "${parameters.channel}", limit: "${parameters.count}", unfurl_links: false, thread_ts: null } }');
  assert.deepEqual(p.mcp[0].pin, { slack_send_message: { channel_id: "${parameters.channel}", limit: "${parameters.count}", unfurl_links: false, thread_ts: null } });
  // compiled() fills it: one placeholder alone takes the parameter's value and type; a pin whose parameter is missing denies.
  const SEND = "mcp:slack/slack_send_message";
  const made = compiled(p, { channel: "C0123", count: 3 }, { mcp: p.mcp, defaultTools: [], grants: [SEND], pins: true });
  assert.deepEqual(made.agent.definition.tool_settings, { [SEND]: { permission: "allow", pin: { channel_id: "C0123", limit: 3, unfurl_links: false, thread_ts: null } } });
  assert.deepEqual([made.unpinned, made.unkept], [[], []]);
  const later = compiled(p, { channel: "C0123", count: 3 }, { mcp: p.mcp, defaultTools: [], grants: [], pins: false });
  assert.equal(later.agent.definition.tool_settings, undefined);
  assert.deepEqual(later.unkept, [{ tool: SEND, pin: { channel_id: "C0123", limit: 3, unfurl_links: false, thread_ts: null } }]);
  for (const given of [{ count: 3 }, { channel: "", count: 3 }]) {
    const empty = compiled(p, given, { mcp: p.mcp, defaultTools: [], grants: [SEND], pins: true });
    assert.deepEqual(empty.agent.definition.tool_settings, { [SEND]: { permission: "deny" } }, JSON.stringify(given));
    assert.deepEqual(empty.unpinned, [{ tool: SEND, parameters: ["channel"] }]);
  }
  // A one-of list is filled item by item, in its order; an item whose parameter is missing denies as a scalar's does.
  const { p: listed } = await pinProblems(t, '    pin: { slack_send_message: { channel_id: [C0GENERAL1, "${parameters.channel}"], limit: [null, "${parameters.count}"] } }');
  assert.deepEqual(compiled(listed, { channel: "C0123", count: 3 }, { mcp: listed.mcp, defaultTools: [], grants: [], pins: true }).agent.definition.tool_settings, { [SEND]: { pin: { channel_id: ["C0123", "C0GENERAL1"], limit: [null, 3] } } }, "in its one form");
  assert.deepEqual(compiled(listed, { count: 3 }, { mcp: listed.mcp, defaultTools: [], grants: [], pins: true }).unpinned, [{ tool: SEND, parameters: ["channel"] }]);
  const refused = async (entry, pattern) => {
    const { problems } = await pinProblems(t, entry);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${pattern}: ${JSON.stringify(problems)}`);
  };
  await refused('    pin: { slack_delete_message: { channel_id: "C0123" } }', /mcp\[0\]\.pin\.slack_delete_message: slack_delete_message is not one of this entry's tools/);
  await refused('    pin: { slack_send_message: { channel_id: [["C0123"], "C0456"] } }', /mcp\[0\]\.pin\.slack_send_message\.channel_id is a JSON scalar .* or a list of 1 to 16 of them/);
  await refused('    pin: { slack_send_message: { channel_id: { id: "C0123" } } }', /mcp\[0\]\.pin\.slack_send_message\.channel_id is a JSON scalar/);
  await refused("    pin: { slack_send_message: { channel_id: [] } }", /mcp\[0\]\.pin\.slack_send_message\.channel_id is a JSON scalar/);
  await refused('    pin: { slack_send_message: { channel_id: ["${parameters.chanel}", C0123] } }', /\$\{parameters\.chanel\} names no parameter/);
  await refused('    pin: { slack_send_message: { channel_id: "${parameters.chanel}" } }', /\$\{parameters\.chanel\} names no parameter/);
  await refused("    pin: { slack_send_message: {} }", /mcp\[0\]\.pin\.slack_send_message is an object of 1 to 8/);
  await refused(`    pin: { slack_send_message: { ${Array.from({ length: 9 }, (_, i) => `a${i}: x`).join(", ")} } }`, /mcp\[0\]\.pin\.slack_send_message is an object of 1 to 8/);
  await refused("    pin: [slack_send_message]", /mcp\[0\]\.pin is \{<tool>: \{<argument>:/);
  // A placeholder is still refused anywhere else in a trigger, and the refusal names a pin as a place one goes.
  const { problems } = await pinProblems(t, "    pin: { slack_send_message: { channel_id: x } }\ntriggers:\n  - name: hook\n    source: { kind: webhook, name: \"${parameters.channel}\" }\n    target: { kind: start_run }\nbudget: { per_run_usd: 1 }");
  assert.ok(problems.some((problem) => /a placeholder goes in display_name, the instructions, a trigger's target\.input, a schedule's cron and timezone, or an mcp pin's values/.test(problem)), JSON.stringify(problems));
});

test("market-monitor's sends are pinned to its channel: the consent screen shows each pin, apply writes it filled, and with no channel the sends are denied with a warning", async (t) => {
  const { api } = await serve(t);
  const slack = await startFakeMcp({ name: "slack" });
  t.after(() => slack.close());
  slack.tools.slack_send_message = { description: "Slack's send.", input: { type: "object", properties: { channel_id: { type: "string" }, message: { type: "string" } }, additionalProperties: true }, run: () => ({ content: [{ type: "text", text: "{}" }] }) };
  assert.equal((await api("PUT", "/settings/mcp-servers/slack", { url: slack.url, auth: { type: "none" } })).status, 200);
  const SEND = "mcp:slack/slack_send_message";

  const listed = (await api("GET", "/templates")).body.templates.find((x) => x.name === "market-monitor");
  assert.deepEqual(listed.mcp.map((need) => need.tools), [
    [{ name: "slack_send_message", tool: SEND, asks: "ask", pin: { channel_id: "${parameters.channel}" } }],
    [{ name: "GMAIL_SEND_EMAIL", tool: "mcp:gmail/GMAIL_SEND_EMAIL", asks: "ask", pin: { recipient_email: "${parameters.channel}", cc: null, bcc: null, extra_recipients: null } }],
  ]);
  const inbound = (await api("GET", "/templates")).body.templates.find((x) => x.name === "inbound-lead");
  assert.deepEqual(inbound.mcp.find((need) => need.server === "slack").tools, [{ name: "slack_send_message", tool: SEND, asks: "ask", pin: { channel_id: "${parameters.slack_channel}" } }]);
  assert.equal(inbound.mcp.find((need) => need.server === "hubspot").tools.find((x) => x.name === "manage_crm_objects").pin, undefined, "its CRM write stays unpinned: the SOP's email match proves the record");

  const settingsOf = async (applied) => (await api("GET", `/agents/${applied.body.agent_id}`)).body.definition.tool_settings;
  const pinWarnings = (applied) => applied.body.warnings.filter((w) => w.field.startsWith("pins."));
  // A channel given: the pin, filled, whatever the permission (here the owner's default, ask), and with the grant, allow.
  // Until the store cutover (AGENT_LAYER_PINS) the agent keeps no pin of its own: the answer says so, with the server's
  // setting that holds the send meanwhile, and the send asks unless granted.
  const given = await api("POST", "/templates/market-monitor/apply", { parameters: { competitors: "Acme (acme.example)", channel: "C0MKTINTEL" } });
  assert.equal(given.status, 201, JSON.stringify(given.body));
  assert.equal((await api("GET", `/agents/${given.body.agent_id}`)).body.tools.find((x) => x.name === SEND).permission, "ask");
  const granted = await api("POST", "/templates/market-monitor/apply", { parameters: { competitors: "Acme (acme.example)", channel: "C0MKTINTEL" }, grants: [SEND] });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  if (AGENT_LAYER_PINS) {
    assert.deepEqual(await settingsOf(given), { [SEND]: { pin: { channel_id: "C0MKTINTEL" } } });
    assert.deepEqual(pinWarnings(given), []);
    assert.deepEqual(await settingsOf(granted), { [SEND]: { permission: "allow", pin: { channel_id: "C0MKTINTEL" } } });
  } else {
    assert.equal(await settingsOf(given), undefined);
    assert.deepEqual(await settingsOf(granted), { [SEND]: { permission: "allow" } });
    for (const applied of [given, granted]) {
      assert.deepEqual(pinWarnings(applied).map((w) => [w.field, w.reason]), [[`pins.${SEND}`, "not_set_up_here"]]);
      assert.match(pinWarnings(applied)[0].message, /^mcp:slack\/slack_send_message is not pinned to channel_id = C0MKTINTEL for this agent yet/);
      assert.match(pinWarnings(applied)[0].fix, /\{"mcp:slack\/slack_send_message":\{"pin":\{"channel_id":"C0MKTINTEL"\}\}\}/);
    }
  }

  // No channel: the send has no destination, so it can't run at all, granted or not, and the answer says so.
  const none = await api("POST", "/templates/market-monitor/apply", { parameters: { competitors: "Acme (acme.example)" }, grants: [SEND] });
  assert.equal(none.status, 201, JSON.stringify(none.body));
  assert.deepEqual(await settingsOf(none), { [SEND]: { permission: "deny" } });
  assert.equal((await api("GET", `/agents/${none.body.agent_id}`)).body.tools.find((x) => x.name === SEND).permission, "deny");
  const warned = pinWarnings(none);
  assert.deepEqual(warned.map((w) => [w.field, w.reason]), [[`pins.${SEND}`, "not_set_up_here"]]);
  assert.match(warned[0].message, /fixed by the channel parameter, which was not given, so the agent was made with mcp:slack\/slack_send_message set to deny/);
  // Gmail is not saved here: skipped, so no pin of it is written.
  assert.ok(none.body.warnings.some((w) => w.field === "mcp.gmail"));
});
