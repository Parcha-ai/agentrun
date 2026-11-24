// Deploy parity, end to end through the HTTP API: the parity fixture (fixtures/parity-agent: one of each kind a deploy
// carries, on codex with a model that is not the default) installed on A, then deployed by `agentrun deploy` the two ways
// it deploys (a package folder, and an install's agent by its export), and the agent read back on each target is the
// same as A's, field by field (scripts/deploy-parity.mjs): no difference, and no field unread. Three servers with the
// faux model and stand-in MCP servers, each saving the servers under names of its own; the keys are fakes. Each server
// takes serve's test harness table (fixtures/faux-table.mjs): codex keeps its facts and runs any model, so the fixture's
// harness and preferred model are what its agent gets, as on a server with codex and an OpenAI key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { serve, withEnv } from "../../serve/test/support.mjs";
import { startFakeMcp } from "../../serve/test/fixtures/fake-mcp-server.mjs";
import { KEY as MONID_KEY } from "../../serve/test/fixtures/faux-monid.mjs";
import { fauxTable } from "../../serve/test/fixtures/faux-table.mjs";
import { describeAgent } from "../../../scripts/deploy-parity.mjs";
import { parityOf, readAgent } from "../../../scripts/deploy-parity-read.mjs";
import { cli, keptEnv, scratch } from "./support.mjs";

const FIXTURE = new URL("./fixtures/parity-agent/", import.meta.url).pathname;
const FAUX_MONID = new URL("../../serve/test/fixtures/faux-monid.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("../../serve/test/fixtures/faux-harness.mjs", import.meta.url).pathname;
const CHECK = new URL("../../../scripts/deploy-parity-read.mjs", import.meta.url).pathname;
/** The fixture's MCP needs, as its manifest lists them. */
const NEEDS = [
  { source: "composio", toolkit: "slack", tools: ["SLACK_SEND_MESSAGE"] },
  { source: "github", toolkit: "github", tools: ["get_file_contents"] },
  { source: "url", toolkit: "docs", tools: ["search_docs"] },
];
const GRANTS = NEEDS.flatMap((need) => need.tools.map((tool) => `mcp:${need.toolkit}/${tool}`));

/** The fixture's files, as an import takes them: every file under it but a hidden one, by path. */
const filesUnder = (dir, sub = "") => readdirSync(join(dir, sub)).filter((name) => !name.startsWith(".")).flatMap((name) => (statSync(join(dir, sub, name)).isDirectory() ? filesUnder(dir, join(sub, name)) : [join(sub, name)]));
const fixtureFiles = () => filesUnder(FIXTURE).sort().map((path) => ({ path, encoding: "utf8", content: readFileSync(join(FIXTURE, path), "utf8") }));

/** One stand-in MCP server per need, each listing the need's tools, closed at the test's end. */
async function standIns(t) {
  const fakes = {};
  for (const need of NEEDS) {
    fakes[need.toolkit] = await startFakeMcp({ name: need.toolkit });
    for (const name of need.tools) fakes[need.toolkit].tools[name] = { description: `${need.toolkit}'s ${name}.`, input: { type: "object", properties: {}, additionalProperties: true }, run: () => ({ content: [{ type: "text", text: "{}" }] }) };
  }
  t.after(() => Promise.all(Object.values(fakes).map((fake) => fake.close())));
  return fakes;
}

/** A server with the stand-ins saved under `names` (toolkit -> the name this install's owner gave it; a toolkit with no
 *  name is not saved there), and monid's fake. */
async function install(t, fakes, names) {
  const server = await serve(t, { mcpStandIns: true, runner: false, fauxMonid: FAUX_MONID, harnessTable: fauxTable(FAUX_HARNESS) });
  for (const need of NEEDS.filter((one) => names[one.toolkit])) {
    const saved = await server.api("PUT", `/settings/mcp-servers/${names[need.toolkit]}`, { url: fakes[need.toolkit].url, auth: { type: "none" }, source: need.source, toolkit: need.toolkit });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  return server;
}

/** The CLI signed in to `base` with `token` (its config file, 0600): how a deploy reaches the install an agent is on. */
function signedIn(dir, base, token) {
  mkdirSync(join(dir, ".config", "agentrun"), { recursive: true });
  writeFileSync(join(dir, ".config", "agentrun", "config.json"), `${JSON.stringify({ base_url: base, api_key: token })}\n`, { mode: 0o600 });
}

/** The check's command in a child process beside the servers (they answer from this process, so never a blocking
 *  spawnSync): `{code, out, err}`. */
const check = (args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CHECK, ...args], { env: { ...keptEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.once("close", (code) => (clearTimeout(timer), resolve({ code, out, err })));
});

test("the parity fixture installed on A and deployed by agentrun deploy, as a folder to B and as A's agent to C, is the same agent on each: every field read on both sides, no difference", { timeout: 300_000 }, async (t) => {
  withEnv(t, { OPENROUTER_API_KEY: "fake-test-key", PARALLEL_API_KEY: "fake-test-key", MONID_API_KEY: MONID_KEY }, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY"]);
  const fakes = await standIns(t);
  const a = await install(t, fakes, { slack: "slack", github: "github", docs: "docs" });
  const b = await install(t, fakes, { slack: "team-slack", github: "team-github", docs: "team-docs" });
  const c = await install(t, fakes, { slack: "work-slack", github: "work-github" });

  // On A: the fixture uploaded and applied with every MCP tool granted (the folder leg's source), and again without the
  // url server's tool (the install leg's source: a url server on this machine never leaves it, agent-package.ts).
  const imported = await a.api("POST", "/templates/import", { files: fixtureFiles() });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const apply = `/templates/${encodeURIComponent(imported.body.template.id)}/apply`;
  const every = await a.api("POST", apply, { parameters: {}, grants: GRANTS });
  assert.equal(every.status, 201, JSON.stringify(every.body));
  const noDocs = await a.api("POST", apply, { parameters: {}, grants: GRANTS.filter((tool) => !tool.startsWith("mcp:docs/")) });
  assert.equal(noDocs.status, 201, JSON.stringify(noDocs.body));

  // The source holds what the fixture declares, so a deploy that loses a field cannot pass by losing it on A too.
  const source = describeAgent(await readAgent(a.api, every.body.agent_id));
  assert.deepEqual(source.unread, [], "A serves every read");
  assert.deepEqual([source.fields.harness, source.fields.model, source.fields.effort, source.fields.approvals], ["codex", "openai/gpt-6.1-sol", "high", "never"]);
  for (const tool of ["read", "web_fetch", "monid:apollo/people/match"]) assert.ok(Object.hasOwn(source.fields.tools, tool), `${tool}: ${JSON.stringify(source.fields.tools)}`);
  assert.deepEqual(Object.keys(source.fields.mcp_tools).sort(), ["mcp:composio:slack/SLACK_SEND_MESSAGE", "mcp:github:github/get_file_contents", "mcp:url:docs/search_docs"]);
  assert.deepEqual(Object.keys(source.fields.skills), ["digest", "triage"]);
  assert.deepEqual(Object.keys(source.fields.triggers), ["inbound", "weekday-digest"]);
  assert.deepEqual(source.fields.secrets, ["MONID_API_KEY", "PARALLEL_API_KEY"]);
  assert.deepEqual(source.fields.budget, { max_cost_usd: 2.5, max_requests: 40 });

  // Leg 1: the folder, copied out of the repository first (a deploy writes its lock beside the package).
  const { dir, env } = scratch("parity");
  const pkg = join(dir, "parity-agent");
  cpSync(FIXTURE, pkg, { recursive: true });
  const toB = await cli({ ...env, AGENTRUN_API_KEY: b.token }, ["deploy", pkg, "--to", b.baseUrl, "--yes"]);
  assert.equal(toB.code, 0, toB.err);
  const onB = toB.json();
  const folder = parityOf(await readAgent(a.api, every.body.agent_id), await readAgent(b.api, onB.agent_id));
  t.diagnostic(`folder leg warnings: ${JSON.stringify(folder.warnings)}`);

  // Leg 2: A's agent by its export, the CLI signed in to A and deploying to C with C's key.
  signedIn(dir, a.baseUrl, a.token);
  const toC = await cli({ ...env, AGENTRUN_API_KEY: c.token }, ["deploy", noDocs.body.agent_id, "--base-url", a.baseUrl, "--to", c.baseUrl, "--yes"]);
  assert.equal(toC.code, 0, toC.err);
  const onC = toC.json();
  const agentLeg = parityOf(await readAgent(a.api, noDocs.body.agent_id), await readAgent(c.api, onC.agent_id));
  t.diagnostic(`install leg warnings: ${JSON.stringify(agentLeg.warnings)}`);

  // Both legs read before either is asserted, so a deploy that drops a field names it on every leg it drops it on.
  const found = { folder: { differences: folder.differences, unread: folder.unread }, install: { differences: agentLeg.differences, unread: agentLeg.unread } };
  assert.deepEqual(found, { folder: { differences: [], unread: [] }, install: { differences: [], unread: [] } }, `parity differences: ${JSON.stringify(found, null, 2)}`);
  assert.deepEqual([folder.pass, agentLeg.pass], [true, true]);

  // The check's own command says the same over HTTP: the folder leg's target and agent read from the lock it wrote.
  const run = await check(["--source", a.baseUrl, "--source-agent", every.body.agent_id, "--lock", join(pkg, ".agentrun", "deploy.json")], { AGENTRUN_PARITY_SOURCE_TOKEN: a.token, AGENTRUN_PARITY_TARGET_TOKEN: b.token });
  assert.equal(run.code, 0, `${run.err}\n${run.out}`);
  const answer = JSON.parse(run.out);
  assert.deepEqual([answer.pass, answer.differences, answer.unread], [true, [], []]);
  assert.match(run.err, /^PASS: /m);
  for (const token of [a.token, b.token]) assert.ok(token && !(run.out + run.err).includes(token), "no token in what it prints");
});
