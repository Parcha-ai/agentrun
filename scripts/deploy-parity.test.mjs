// The deploy parity check's pure half (deploy-parity.mjs): one agent as two installs answer for it, described without
// anything either host set on its own, and diffed into named differences. The same agent read twice is []. Each change a
// deploy could make (a skill dropped, the model swapped, a tool kind lost, a trigger dropped, a key renamed) is exactly
// one difference naming its field. A field a side does not serve is unread, never counted as equal. The reader
// (deploy-parity-read.mjs) is checked against an answering function, and its command against loopback listeners.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as parity from "./deploy-parity.mjs";
import { readAgent } from "./deploy-parity-read.mjs";
import { DEFINITION_FIELDS } from "../packages/serve/dist/validate.js";
import { cli, keptEnv } from "../packages/agentrun/test/support.mjs";

const { describeAgent, parityDiff, readinessOf, unreadFields } = parity;
const CHECK = new URL("./deploy-parity-read.mjs", import.meta.url).pathname;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** The package files' content hashes, by what each file holds. */
const H = Object.fromEntries(["manifest", "answer", "style", "digest", "reference", "triage"].map((name) => [name, sha256(name)]));
const SOL = "openai/gpt-6.1-sol";
const TIERS = { fast: "openai/gpt-6-luna", balanced: "openai/gpt-6-terra", strong: SOL };

/** The agent as one install answers GET /v2/agents/{id}: `id`, `at` and `servers` are that host's own. */
function agentOn({ id = "agt_a1", at = "2026-11-24T08:00:00.000Z", slack = "slack", github = "github", docs = "docs" } = {}) {
  return {
    agent_id: id,
    definition: {
      id, version: 3, name: "Parity fixture", description: "One of each kind an agent carries.", instructions: "Digest the day.\n",
      model: SOL, model_tiers: { ...TIERS }, thinking: "high", learning: true,
      input_schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false },
      output_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
      approvals: "never", harness: "codex", place: { mode: "local" }, computer: { kind: "none", provider: `prov-${id}` },
      skills: ["digest", "triage"],
      tools: ["read", "web_fetch", "monid:apollo/people/match", `mcp:${slack}/SLACK_SEND_MESSAGE`, `mcp:${github}/get_file_contents`, `mcp:${docs}/search_docs`],
      tool_settings: { [`mcp:${slack}/SLACK_SEND_MESSAGE`]: { channel: "C0PARITY01" } },
      max_cost_usd: 2.5, max_requests: 40,
    },
    kind: "agentic", mcp_pin: { [`${slack}`]: { listed_at: at } }, revision: `rev_${id}`, revisions: 3, source: null,
    template: { id: `upload:parity-fixture-${id}`, version: "1.0.0", sha: `sha-${id}` },
    skills: [
      { path: "digest/SKILL.md", sha256: "d1", size_bytes: 400 }, { path: "digest/reference.md", sha256: "d2", size_bytes: 90 },
      { path: "digest/STYLE.md", sha256: "r1", size_bytes: 60 }, { path: "triage/SKILL.md", sha256: "t1", size_bytes: 300 },
      { path: "triage/STYLE.md", sha256: "r1", size_bytes: 60 },
    ],
    sign_ins: [], runs: { count: 4, live: 0 }, own_computer: null, region: "local", home_etag: `etag-${id}`, archived_at: null,
    console_url: `http://${id}.example/agents/${id}`, created_at: at, updated_at: at, run_blockers: null,
  };
}
/** That install's triggers (GET /v2/triggers), another agent's among them. */
function triggersOn({ id = "agt_a1", at = "2026-11-24T08:00:00.000Z" } = {}) {
  const host = { id: `trg_${id}_x`, failures_in_a_row: 0, disabled: null, last_run_id: null, created_at: at, updated_at: at, last_firing: null };
  return [
    { ...host, id: `trg_${id}_1`, name: "weekday-digest", enabled: true, source: { kind: "schedule", cron: "0 8 * * 1-5", timezone: "UTC" }, target: { kind: "start_run", agent_id: id, input: { content: "Write today's digest." } }, catchup_window_s: 3600, max_active_runs: null, next_at: at },
    { ...host, id: `trg_${id}_2`, name: "inbound", hook_url: `http://${id}.example/v2/hooks/trg_${id}_2`, secret: "set", enabled: true, source: { kind: "webhook" }, target: { kind: "start_run", agent_id: id, input: { content: "Triage what arrived." } }, catchup_window_s: 3600, max_active_runs: 2, next_at: null },
    { ...host, id: "trg_other", name: "other", enabled: true, source: { kind: "schedule", cron: "0 9 * * *" }, target: { kind: "start_run", agent_id: "agt_other", input: {} }, catchup_window_s: 3600, max_active_runs: null, next_at: at },
  ];
}
/** That install's saved MCP servers, under the names its owner gave them. */
const serversOn = ({ slack = "slack", github = "github", docs = "docs" } = {}) => [
  { name: slack, url: "https://mcp.example/slack", source: "composio", toolkit: "slack" },
  { name: github, url: "https://mcp.example/github", source: "github", toolkit: "github" },
  { name: docs, url: "https://docs.example/mcp", source: "url", toolkit: "docs" },
];
/** GET /v2/templates/{id} for the agent's package. */
const templateOf = (agent, secrets = ["MONID_API_KEY", "PARALLEL_API_KEY"]) => ({ template: { id: agent.template.id, sha: agent.template.sha, secrets } });
/** The files of the agent's package (GET /v2/agents/{id}/package), each by its content hash as readAgent reads them: the
 *  export names each MCP tool in them by its toolkit, and ships a rule beside every skill once, under rules/. */
const packageFilesOf = () => [
  { path: "agent.md", sha256: H.manifest }, { path: "answer.schema.json", sha256: H.answer }, { path: "rules/STYLE.md", sha256: H.style },
  { path: "skills/digest/SKILL.md", sha256: H.digest }, { path: "skills/digest/reference.md", sha256: H.reference }, { path: "skills/triage/SKILL.md", sha256: H.triage },
];

/** Source A as read, and target B: another host, its own ids, times and server names. */
function pair() {
  const a = agentOn();
  const b = agentOn({ id: "agt_b9", at: "2026-11-25T10:30:00.000Z", slack: "team-slack", github: "gh", docs: "team-docs" });
  return {
    a, b,
    readA: () => ({ agent: structuredClone(a), triggers: triggersOn(), servers: serversOn(), template: templateOf(a), packageFiles: packageFilesOf() }),
    readB: () => ({ agent: structuredClone(b), triggers: triggersOn({ id: "agt_b9", at: "2026-11-25T10:30:00.000Z" }), servers: serversOn({ slack: "team-slack", github: "gh", docs: "team-docs" }), template: templateOf(b), packageFiles: packageFilesOf() }),
  };
}
const diffOf = (readA, readB) => parityDiff(describeAgent(readA), describeAgent(readB));

test("the same agent on two hosts is [] once each host's ids, times, links, places, pins, providers and MCP server names are left out", () => {
  const { readA, readB } = pair();
  assert.deepEqual(diffOf(readA(), readB()), []);
  assert.deepEqual(unreadFields(describeAgent(readA()), describeAgent(readB())), []);
  // An agent diffed with itself, and its description is plain data: JSON round-trips it.
  const described = describeAgent(readA());
  assert.deepEqual(JSON.parse(JSON.stringify(described)), described);
  assert.deepEqual(parityDiff(described, described), []);
});

test("the description holds every field a deploy carries, by its portable name", () => {
  const { fields } = describeAgent(pair().readA());
  // Every field a deploy carries but checkout, which this agent does not set (a field not set is absent, as in JSON).
  assert.deepEqual(Object.keys(fields).sort(), ["approvals", "budget", "computer", "description", "effort", "harness", "input_schema", "instructions", "learning", "mcp_tools", "model", "model_tiers", "name", "output_schema", "secrets", "skills", "tool_settings", "tools", "triggers"]);
  assert.deepEqual(fields.harness, "codex");
  assert.deepEqual(fields.effort, "high");
  assert.deepEqual(fields.tools, { "monid:apollo/people/match": null, read: null, web_fetch: null });
  assert.deepEqual(fields.mcp_tools, { "mcp:composio:slack/SLACK_SEND_MESSAGE": { channel: "C0PARITY01" }, "mcp:github:github/get_file_contents": null, "mcp:url:docs/search_docs": null });
  assert.deepEqual(Object.keys(fields.skills), ["digest", "triage"]);
  assert.deepEqual(fields.skills.digest, { "digest/SKILL.md": "d1", "digest/STYLE.md": "r1", "digest/reference.md": "d2" });
  assert.deepEqual(fields.secrets, ["MONID_API_KEY", "PARALLEL_API_KEY"]);
  assert.deepEqual(Object.keys(fields.triggers), ["inbound", "weekday-digest"], "the other agent's trigger is not this one's");
  assert.deepEqual(fields.triggers.inbound, { enabled: true, source: { kind: "webhook" }, target: { kind: "start_run", input: { content: "Triage what arrived." } }, catchup_window_s: 3600, max_active_runs: 2 });
  assert.deepEqual(fields.computer, { kind: "none" });
  assert.deepEqual(fields.budget, { max_cost_usd: 2.5, max_requests: 40 });
  assert.equal(fields.instructions, "Digest the day.", "trimmed, as a package's body is read");
});

/** Each mutant: what a deploy that drops or changes one field leaves on the target, and the one difference it is. */
const MUTANTS = [
  {
    name: "a skill dropped",
    mutate: (read) => { read.agent.skills = read.agent.skills.filter((skill) => !skill.path.startsWith("triage/")); read.agent.definition.skills = ["digest"]; },
    want: [{ field: "skills.triage", kind: "missing", source: { "triage/SKILL.md": "t1", "triage/STYLE.md": "r1" }, target: undefined }],
  },
  {
    name: "a skill file's bytes changed",
    mutate: (read) => { read.agent.skills.find((skill) => skill.path === "digest/reference.md").sha256 = "d2-other"; },
    want: [{ field: "skills.digest", kind: "changed", source: { "digest/SKILL.md": "d1", "digest/STYLE.md": "r1", "digest/reference.md": "d2" }, target: { "digest/SKILL.md": "d1", "digest/STYLE.md": "r1", "digest/reference.md": "d2-other" } }],
  },
  {
    name: "the model swapped",
    mutate: (read) => { read.agent.definition.model = "openai/gpt-6-terra"; },
    want: [{ field: "model", kind: "changed", source: SOL, target: "openai/gpt-6-terra" }],
  },
  {
    name: "the harness fell back to the default",
    mutate: (read) => { read.agent.definition.harness = "pi"; },
    want: [{ field: "harness", kind: "changed", source: "codex", target: "pi" }],
  },
  {
    name: "a tool kind lost (the url MCP server's tools)",
    mutate: (read) => { read.agent.definition.tools = read.agent.definition.tools.filter((tool) => !tool.startsWith("mcp:team-docs/")); },
    want: [{ field: "mcp_tools.mcp:url:docs/search_docs", kind: "missing", source: null, target: undefined }],
  },
  {
    name: "a tool kind lost (monid's)",
    mutate: (read) => { read.agent.definition.tools = read.agent.definition.tools.filter((tool) => !tool.startsWith("monid:")); },
    want: [{ field: "tools.monid:apollo/people/match", kind: "missing", source: null, target: undefined }],
  },
  {
    name: "a pin lost",
    mutate: (read) => { delete read.agent.definition.tool_settings; },
    want: [{ field: "mcp_tools.mcp:composio:slack/SLACK_SEND_MESSAGE", kind: "changed", source: { channel: "C0PARITY01" }, target: null }],
  },
  {
    name: "a trigger dropped",
    mutate: (read) => { read.triggers = read.triggers.filter((trigger) => trigger.name !== "inbound"); },
    want: [{ field: "triggers.inbound", kind: "missing", source: { enabled: true, source: { kind: "webhook" }, target: { kind: "start_run", input: { content: "Triage what arrived." } }, catchup_window_s: 3600, max_active_runs: 2 }, target: undefined }],
  },
  {
    name: "a trigger's bound changed",
    mutate: (read) => { read.triggers.find((trigger) => trigger.name === "inbound").max_active_runs = null; },
    want: [{ field: "triggers.inbound.max_active_runs", kind: "changed", source: 2, target: null }],
  },
  {
    name: "a key renamed",
    mutate: (read) => { read.template.template.secrets = ["MONID_API_KEY", "PARALLEL_KEY"]; },
    want: [{ field: "secrets", kind: "changed", source: ["MONID_API_KEY", "PARALLEL_API_KEY"], target: ["MONID_API_KEY", "PARALLEL_KEY"] }],
  },
  {
    name: "a tool the source never had",
    mutate: (read) => { read.agent.definition.tools.push("bash"); },
    want: [{ field: "tools.bash", kind: "extra", source: undefined, target: null }],
  },
  {
    name: "the budget's request cap dropped",
    mutate: (read) => { delete read.agent.definition.max_requests; },
    want: [{ field: "budget", kind: "changed", source: { max_cost_usd: 2.5, max_requests: 40 }, target: { max_cost_usd: 2.5 } }],
  },
  {
    name: "the effort dropped",
    mutate: (read) => { delete read.agent.definition.thinking; },
    want: [{ field: "effort", kind: "missing", source: "high", target: undefined }],
  },
];

for (const mutant of MUTANTS) {
  test(`one difference, named: ${mutant.name}`, () => {
    const { readA, readB } = pair();
    const target = readB();
    mutant.mutate(target);
    assert.deepEqual(diffOf(readA(), target), mutant.want);
  });
}

test("a difference is missing on the source's side and extra on the target's: the same change read the other way round", () => {
  const { readA, readB } = pair();
  const source = readA();
  source.triggers = source.triggers.filter((trigger) => trigger.name !== "inbound");
  assert.deepEqual(diffOf(source, readB()).map(({ field, kind }) => [field, kind]), [["triggers.inbound", "extra"]]);
});

test("what a side does not serve is unread, never equal: the triggers, the MCP servers' sources and the declared keys", () => {
  const { readA, readB } = pair();
  const target = { ...readB(), triggers: null, servers: null, template: null };
  const a = describeAgent(readA());
  const b = describeAgent(target);
  assert.deepEqual(b.unread.map((one) => one.field), ["mcp_tools", "secrets", "triggers"]);
  for (const one of b.unread) assert.ok(typeof one.why === "string" && one.why.length > 0, JSON.stringify(one));
  assert.deepEqual(parityDiff(a, b), [], "an unread field is no difference");
  assert.deepEqual(unreadFields(a, b).map((one) => [one.field, one.side]), [["mcp_tools", "target"], ["secrets", "target"], ["triggers", "target"]]);
  // A server list that names servers without their source (an API-only install's names) leaves the MCP tools unread.
  const names = describeAgent({ ...readB(), servers: serversOn({ slack: "team-slack", github: "gh", docs: "team-docs" }).map(({ name }) => ({ name })) });
  assert.deepEqual(names.unread.map((one) => one.field), ["mcp_tools"]);
  // A template answer for another upload of the package than the agent's: its keys are not the agent's, so unread.
  const moved = readB();
  moved.template.template.sha = "sha-newer-upload";
  assert.deepEqual(describeAgent(moved).unread.map((one) => one.field), ["secrets"]);
  // An agent made from no package declares no keys: [] read, not unread.
  const plain = readB();
  plain.agent.template = null;
  assert.deepEqual([describeAgent({ ...plain, template: null }).fields.secrets, describeAgent({ ...plain, template: null }).unread], [[], []]);
});

test("readiness on the target is a warning, never a difference: a key it lacks, a required MCP need with no server, a run blocker", () => {
  const { b } = pair();
  const blockers = { message: "codex is not set up here.", fields: [{ field: "harness", reason: "not_set_up", message: "codex is not set up here." }] };
  const warnings = readinessOf({ agent: { ...b, run_blockers: blockers }, plan: { missing_secrets: ["PARALLEL_API_KEY"], unmatched_mcp: [{ source: "url", toolkit: "docs", required: false }] } });
  assert.deepEqual(warnings, [
    { kind: "key_missing", field: "secrets.PARALLEL_API_KEY" },
    { kind: "mcp_missing", field: "mcp.url:docs", required: false },
    { kind: "not_runnable", field: "run_blockers.harness", message: "codex is not set up here." },
  ]);
  assert.deepEqual(readinessOf({ agent: { ...b, run_blockers: { message: "Not runnable.", fields: [] } }, plan: { missing_secrets: [], unmatched_mcp: [] } }), [{ kind: "not_runnable", field: "run_blockers", message: "Not runnable." }]);
  assert.deepEqual(readinessOf({ agent: b, plan: null }), [{ kind: "plan_unread", field: "plan" }]);
});

test("readAgent reads the agent, its triggers, its servers, its package's keys and the plan, each a request of its own; one not served is null, the agent's own a refusal", async () => {
  const { a } = pair();
  const seen = [];
  const answers = {
    "GET /agents/agt_a1": [200, a],
    "GET /triggers": [200, { triggers: triggersOn() }],
    "GET /settings/mcp-servers": [200, { servers: serversOn() }],
    [`GET /templates/${encodeURIComponent(a.template.id)}`]: [200, templateOf(a)],
    [`POST /templates/${encodeURIComponent(a.template.id)}/apply`]: [200, { plan: { missing_secrets: [], unmatched_mcp: [] } }],
  };
  const api = async (method, path, body) => {
    seen.push([method, path, body]);
    const [status, value] = answers[`${method} ${path}`] ?? [404, { error: { code: "not_found", message: "Not found." } }];
    return { status, body: value };
  };
  const read = await readAgent(api, "agt_a1");
  assert.deepEqual(read, { agent: a, triggers: triggersOn(), servers: serversOn(), template: templateOf(a), plan: { missing_secrets: [], unmatched_mcp: [] } });
  assert.deepEqual(seen.find(([method]) => method === "POST")[2], { dry_run: true, agent_id: "agt_a1" }, "the plan is a dry run onto the agent itself");
  assert.ok(seen.every(([method, path]) => method === "GET" || path.endsWith("/apply")), "nothing but reads and a dry run");

  // An install that serves none of the rest (an API-only one): each is null, so the description says it is unread.
  for (const key of ["GET /triggers", "GET /settings/mcp-servers", `GET /templates/${encodeURIComponent(a.template.id)}`, `POST /templates/${encodeURIComponent(a.template.id)}/apply`]) delete answers[key];
  assert.deepEqual(await readAgent(api, "agt_a1"), { agent: a, triggers: null, servers: null, template: null, plan: null });

  // No agent: a refusal naming it, never a description of nothing.
  await assert.rejects(readAgent(api, "agt_nope"), /agt_nope: 404 Not found\./);
});

test("every field of a definition is compared, but those HOST_SET names with why: a field serve adds later is compared by default", () => {
  const host = parity.HOST_SET ?? {};
  for (const [field, why] of Object.entries(host)) assert.ok(DEFINITION_FIELDS.includes(field) && typeof why === "string" && why.length > 0, `${field}: ${why}`);
  const ignored = [];
  for (const field of [...DEFINITION_FIELDS, "a_field_serve_adds_later"]) {
    if (Object.hasOwn(host, field)) continue;
    const { readA, readB } = pair();
    const target = readB();
    target.agent.definition[field] = { guard: field };
    if (diffOf(readA(), target).length === 0) ignored.push(field);
  }
  assert.deepEqual(ignored, [], "each field here changed on the target and the check saw no difference");
});

test("two saved servers of one source and toolkit keep a grant each: the target losing one of them is a difference", () => {
  const { readA, readB } = pair();
  const source = readA();
  source.servers.push({ name: "slack-ops", url: "https://mcp.example/slack-ops", source: "composio", toolkit: "slack" });
  source.agent.definition.tools.push("mcp:slack-ops/SLACK_SEND_MESSAGE");
  const both = readB();
  both.servers.push({ name: "team-slack-ops", url: "https://mcp.example/slack-ops", source: "composio", toolkit: "slack" });
  both.agent.definition.tools.push("mcp:team-slack-ops/SLACK_SEND_MESSAGE");
  assert.deepEqual(diffOf(source, both), [], "both grants on both sides, under other names");
  // The target kept the unpinned grant alone: the pinned one, and its pin, are gone.
  const one = readB();
  one.servers.push({ name: "team-slack-ops", url: "https://mcp.example/slack-ops", source: "composio", toolkit: "slack" });
  one.agent.definition.tools = [...one.agent.definition.tools.filter((tool) => tool !== "mcp:team-slack/SLACK_SEND_MESSAGE"), "mcp:team-slack-ops/SLACK_SEND_MESSAGE"];
  delete one.agent.definition.tool_settings;
  assert.deepEqual(diffOf(source, one).map(({ field, kind }) => [field, kind]), [["mcp_tools.mcp:composio:slack/SLACK_SEND_MESSAGE", "changed"]]);
});

test("an MCP tool the instructions name by the target's own server name is the same tool: apply renames it, the check reads it by its toolkit", () => {
  const { readA, readB } = pair();
  const source = readA();
  source.agent.definition.instructions = "Post with mcp:slack/SLACK_SEND_MESSAGE, read with mcp:github/*.\n";
  const target = readB();
  target.agent.definition.instructions = "Post with mcp:team-slack/SLACK_SEND_MESSAGE, read with mcp:gh/*.\n";
  assert.deepEqual(diffOf(source, target), []);
  assert.equal(describeAgent(target).fields.instructions, "Post with mcp:slack/SLACK_SEND_MESSAGE, read with mcp:github/*.");
  // Another tool is still another tool.
  target.agent.definition.instructions = "Post with mcp:team-slack/SLACK_DELETE_MESSAGE, read with mcp:gh/*.\n";
  assert.deepEqual(diffOf(source, target).map(({ field }) => field), ["instructions"]);
  // A server saved nowhere here, and a name that is the tail of a longer word, stay as written.
  target.agent.definition.instructions = "xmcp:team-slack/SLACK_SEND_MESSAGE and mcp:nowhere/a_tool";
  assert.equal(describeAgent(target).fields.instructions, "xmcp:team-slack/SLACK_SEND_MESSAGE and mcp:nowhere/a_tool");
});

test("skill files are compared by the content hashes of the agent's package: a rule is beside each skill, the agent's own listing is not read, and a file without a 64-hex hash is unread", () => {
  const { readA, readB } = pair();
  const { fields } = describeAgent(readA());
  assert.deepEqual(fields.skill_files, {
    digest: { "digest/SKILL.md": H.digest, "digest/STYLE.md": H.style, "digest/reference.md": H.reference },
    triage: { "triage/SKILL.md": H.triage, "triage/STYLE.md": H.style },
  });
  // GET /agents/{id} lists the files as the target stored them, its own server names in them: never compared.
  const listed = readB();
  listed.agent.skills[0].sha256 = "renamed-on-the-target";
  assert.deepEqual(diffOf(readA(), listed), []);
  // A file the package answers without a hash (a renamed field, say) is never an equal undefined.
  for (const sha of [undefined, "D1", "abc"]) {
    const bad = readB();
    bad.packageFiles.find((file) => file.path === "skills/digest/SKILL.md").sha256 = sha;
    assert.deepEqual(describeAgent(bad).unread.map((one) => one.field), ["skill_files"], String(sha));
  }
  assert.deepEqual(describeAgent({ ...readB(), packageFiles: null }).unread.map((one) => one.field), ["skill_files"]);
});

test("readAgent reads the agent's package and hashes each file's bytes, text or base64", async () => {
  const { a } = pair();
  const files = [{ path: "agent.md", encoding: "utf8", content: "---\nname: x\n---\nBody.\n" }, { path: "skills/x/logo.png", encoding: "base64", content: Buffer.from([0, 1, 2, 255]).toString("base64") }];
  const answers = { "GET /agents/agt_a1": [200, a], [`GET /agents/agt_a1/package`]: [200, { name: "x", files, sha256: "0".repeat(64), report: { blocked: [], remade: [] } }] };
  const api = async (method, path) => {
    const [status, value] = answers[`${method} ${path}`] ?? [404, { error: { code: "not_found", message: "Not found." } }];
    return { status, body: value };
  };
  const read = await readAgent(api, "agt_a1");
  assert.deepEqual(read.packageFiles, [
    { path: "agent.md", sha256: sha256("---\nname: x\n---\nBody.\n") },
    { path: "skills/x/logo.png", sha256: createHash("sha256").update(Buffer.from([0, 1, 2, 255])).digest("hex") },
  ]);
  delete answers["GET /agents/agt_a1/package"];
  assert.equal((await readAgent(api, "agt_a1")).packageFiles, null);
});

/** A loopback listener answering with `answer(request)` (`[status, body]`), each request's method, path and
 *  Authorization header kept in `seen`: `{base, seen}`, `base` ending /v2. Closed at the test's end. */
async function listener(t, answer = () => [404, { error: { code: "not_found", message: "Not found." } }]) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, path: request.url, authorization: request.headers.authorization ?? null });
    const [status, body] = answer(request);
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}/v2`, seen };
}

/** A scratch folder with `name` holding `text`: its path. Removed at the test's end. */
function scratchFile(t, name, text) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-parity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}

test("--lock gives the target's agent id alone: the target token goes to --target and nowhere a lock names", async (t) => {
  const { a, b } = pair();
  const attacker = await listener(t);
  const source = await listener(t, (request) => (request.url === "/v2/agents/agt_a1" ? [200, a] : [404, {}]));
  const target = await listener(t, (request) => (request.url === "/v2/agents/agt_b9" ? [200, b] : [404, {}]));
  const env = { ...keptEnv(), AGENTRUN_PARITY_SOURCE_TOKEN: "source-secret", AGENTRUN_PARITY_TARGET_TOKEN: "target-secret" };
  const from = ["--source", source.base, "--source-agent", "agt_a1"];
  const elsewhere = scratchFile(t, "deploy.json", JSON.stringify({ target: attacker.base, agent_id: "agt_b9" }));

  // No --target: the lock's address is never taken, so nothing is sent anywhere.
  const bare = await cli(env, [...from, "--lock", elsewhere], { bin: CHECK });
  assert.deepEqual(attacker.seen, [], "the address the lock names got no request, so no Authorization header");
  assert.equal(bare.code, 2, bare.err);
  assert.match(bare.err, /--target/);
  // A lock that names another target than --target: refused, nothing sent.
  const crossed = await cli(env, [...from, "--target", target.base, "--lock", elsewhere], { bin: CHECK });
  assert.equal(crossed.code, 2, crossed.err);
  assert.deepEqual([attacker.seen, source.seen, target.seen], [[], [], []]);
  // The lock of a deploy to --target: its agent id is read, each token goes to its own install.
  const own = scratchFile(t, "deploy.json", JSON.stringify({ target: `${target.base}/`, agent_id: "agt_b9" }));
  const run = await cli(env, [...from, "--target", target.base, "--lock", own], { bin: CHECK });
  assert.equal(run.code, 1, run.err);
  assert.deepEqual([...new Set(source.seen.map((one) => one.authorization))], ["Bearer source-secret"]);
  assert.deepEqual([...new Set(target.seen.map((one) => one.authorization))], ["Bearer target-secret"]);
  assert.ok(target.seen.some((one) => one.path === "/v2/agents/agt_b9"));
  assert.deepEqual(attacker.seen, []);
});

test("bad input exits 2 with one line, never a stack trace: an unknown option, a lock not there, a lock that is not JSON", async (t) => {
  const env = keptEnv();
  const from = ["--source", "http://127.0.0.1:9/v2", "--source-agent", "agt_a1", "--target", "http://127.0.0.1:9/v2"];
  for (const args of [[...from, "--target-agent", "agt_b9", "--nope"], [...from, "--lock", join(tmpdir(), "deploy-parity-no-such-lock.json")], [...from, "--lock", scratchFile(t, "deploy.json", "{not json")]]) {
    const run = await cli(env, args, { bin: CHECK });
    assert.equal(run.code, 2, `${args.at(-1)}: ${run.err}`);
    assert.equal(run.err.trim().split("\n").length, 1, run.err);
    assert.match(run.err, /^deploy-parity: /);
    assert.equal(run.out, "");
  }
});
