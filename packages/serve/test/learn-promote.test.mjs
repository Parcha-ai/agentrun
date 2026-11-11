// A learned workflow the owner makes an agent of its own (POST /agents/{id}/learning/workflows/{name}/promote): a new
// agent whose revision is a workflow revision of the learned workflow.json, so its runs run the workflow's nodes with no
// agent loop and answer the workflow's output. Only an active one, only by the owner's session, checked again as a
// restore checks it, and under the source agent's policy as it is now, never more. The learned workflow stays as it is.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { git, resnap } from "./learn-support.mjs";
import { agent, answerFlow, call, cookieOf, follow, serve, withEnv } from "./support.mjs";

/** The owner's sign-in phrase on a test server with accounts (no real secret). */
const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
const DESCRIPTION = "Answers a question as a number; use when the person asks for the answer";
/** A learned workflow's two files, as a merge keeps them (`extra`: more front matter, a status). */
const flowFiles = (name, workflow, extra = "") => ({
  [`workflows/${name}/workflow.json`]: JSON.stringify(workflow),
  [`workflows/${name}/README.md`]: `---\nname: ${name}\ndescription: ${DESCRIPTION}\n${extra}---\n`,
});
/** A workflow whose one step reads a page with web_fetch: a call node, no model. */
const fetchFlow = () => ({
  v: 2, name: "read-site",
  schemas: { In: { type: "object", required: ["website"], properties: { website: { type: "string" } } }, Page: { type: "object" } },
  input: { schemaId: "In" },
  output: { schemaId: "Page", path: "home" },
  root: { node: "chain", steps: [{ node: "call", label: "Read the home page", via: "tool", tool: "web_fetch", args: { url: "{website}" }, out: "Page", as: "home", deadline_s: 60 }] },
});

/** A server with accounts and the owner's session; agent `source` (`extra`: more of its definition) learning, with
 *  `files` committed on its folder's main. */
async function owned(t, files, extra = {}) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const server = await serve(t, { learning: "on", accounts: true, openSetup: true });
  const { api, data, port } = server;
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  const made = await api("POST", "/agents", agent("source", { learning: true, ...extra }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await seedOf(data, "source");
  const repo = join(agentFolderOf(data, "source"), "learning");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, "source");
  const promote = (name, body = {}, headers = { ...json, cookie, origin }) => call(port, { method: "POST", path: `/v2/agents/source/learning/workflows/${encodeURIComponent(name)}/promote`, headers, body });
  const agentIds = async () => (await api("GET", "/agents")).body.agents.map((one) => one.agent_id).sort();
  return { ...server, server, repo, cookie, origin, promote, agentIds };
}

test("an active learned workflow is made an agent of its own by its owner: a workflow agent whose run answers the workflow's output, with no agent loop; the learned workflow stays as it was", { timeout: 150_000 }, async (t) => {
  const { api, repo, promote, agentIds } = await owned(t, flowFiles("answer", answerFlow()));
  const before = git(repo, ["rev-parse", "main"]);
  const made = await promote("answer");
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.agent_id, "answer", "named after the workflow");
  assert.equal(made.json.definition.name, "answer");
  assert.equal(made.json.definition.description, DESCRIPTION, "its README's description");
  assert.equal(made.headers.location, "/v2/agents/answer");
  assert.equal(made.json.kind, "workflow");
  // Its revision is a workflow revision of the learned workflow.json, whole.
  const read = (await api("GET", "/agents/answer")).body;
  assert.deepEqual(read.definition.workflow, answerFlow());
  assert.equal(read.definition.instructions, undefined, "no agent loop: no instructions");
  // A run of it answers the workflow's output: the value at its output path, the node's record.
  const started = await api("POST", "/agents/answer/runs", { input: { question: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.kind, "workflow");
  assert.deepEqual(run.result.output, { answer: 42 }, "the workflow's output");
  assert.equal(run.result.final_answer, null, "a workflow run's answer is its output, never an agent's reply");
  // The learned workflow is where it was: no commit, still active on the source agent.
  assert.equal(git(repo, ["rev-parse", "main"]), before, "the folder is never written");
  const still = (await api("GET", "/agents/source/learning")).body.workflows.find((item) => item.name === "answer");
  assert.equal(still?.status, "active");
  // Made again: a new agent, its id and name past the one there; a name given is its name.
  const again = await promote("answer");
  assert.equal(again.status, 201, again.text);
  assert.deepEqual([again.json.agent_id, again.json.definition.name], ["answer-2", "answer-2"]);
  const named = await promote("answer", { name: "Quick answers" });
  assert.equal(named.status, 201, named.text);
  assert.deepEqual([named.json.agent_id, named.json.definition.name], ["answer-3", "Quick answers"]);
  assert.deepEqual(await agentIds(), ["answer", "answer-2", "answer-3", "source"]);
  // A field it does not keep is 422 by field, and nothing is made.
  const extra = await promote("answer", { name: "x", tools: ["bash"] });
  assert.equal(extra.status, 422, extra.text);
  assert.ok(extra.json.error.fields.some((field) => field.field === "tools"), extra.text);
  assert.deepEqual(await agentIds(), ["answer", "answer-2", "answer-3", "source"]);
});

test("a learned workflow that waits for its owner's OK, or was retired, is 409 learned_not_active, and no agent is made; one not there is 404", { timeout: 150_000 }, async (t) => {
  const { promote, agentIds } = await owned(t, {
    ...flowFiles("held", answerFlow(), "status: pending\n"),
    ...flowFiles("gone", answerFlow(), "status: retired\n"),
  });
  const held = await promote("held");
  assert.deepEqual([held.status, held.json?.error?.code], [409, "learned_not_active"], held.text);
  assert.match(held.json.error.message, /waits for your OK/);
  const gone = await promote("gone");
  assert.deepEqual([gone.status, gone.json?.error?.code], [409, "learned_not_active"], gone.text);
  assert.match(gone.json.error.message, /retired/);
  const none = await promote("nothing-here");
  assert.equal(none.status, 404, none.text);
  assert.deepEqual(await agentIds(), ["source"], "nothing made");
});

test("making an agent of a learned workflow takes the owner's session: the server's token is 403, and nothing is made", { timeout: 150_000 }, async (t) => {
  const { server, promote, agentIds } = await owned(t, flowFiles("answer", answerFlow()));
  const byToken = await promote("answer", {}, { ...json, authorization: `Bearer ${server.token}` });
  assert.deepEqual([byToken.status, byToken.json?.error?.code], [403, "forbidden"], byToken.text);
  assert.match(byToken.json.error.message, /password sign-in/);
  assert.deepEqual(await agentIds(), ["source"]);
});

test("the new agent keeps the source agent's policy, never more: its tools are those its call nodes call, its tool settings, approvals and default cap the source's", { timeout: 150_000 }, async (t) => {
  const settings = { web_fetch: { permission: "allow" }, web_search: { permission: "deny" } };
  const { api, promote } = await owned(t, flowFiles("read-site", fetchFlow()), { tools: ["web_fetch", "web_search"], tool_settings: settings, approvals: "never", max_cost_usd: 2 });
  const made = await promote("read-site");
  assert.equal(made.status, 201, made.text);
  const definition = (await api("GET", "/agents/read-site")).body.definition;
  assert.deepEqual(definition.tools, ["web_fetch"], "only the tool its call node calls, never the source's others");
  assert.deepEqual(definition.tool_settings, settings, "the source's own tool settings");
  assert.equal(definition.approvals, "never", "the source's approvals");
  assert.equal(definition.max_cost_usd, 2, "the source's default cap");
});

test("a learned workflow the source agent's policy would not run is not made an agent: a call node on a tool set to ask under ask, one denied, or one the agent lacks is 400 with its problem, and nothing is made", { timeout: 150_000 }, async (t) => {
  for (const [label, extra, words] of [
    ["ask", { tools: ["web_fetch"], tool_settings: { web_fetch: { permission: "ask" } } }, /set to ask/],
    ["deny", { tools: ["web_fetch"], tool_settings: { web_fetch: { permission: "deny" } } }, /set to deny/],
    ["lacks", { tools: [] }, /web_fetch/],
  ]) {
    await t.test(label, async (t) => {
      const { promote, agentIds } = await owned(t, flowFiles("read-site", fetchFlow()), extra);
      const refused = await promote("read-site");
      assert.equal(refused.status, 400, refused.text);
      const problem = refused.json.error.problems?.find((one) => one.rule === "workflow");
      assert.ok(problem, refused.text);
      assert.equal(problem.path, "workflows/read-site/workflow.json");
      assert.match(problem.detail, words, problem.detail);
      assert.deepEqual(await agentIds(), ["source"], "nothing made");
    });
  }
});

test("a learned workflow holding one of the server's secrets now, or a code node, is not made an agent: 400 naming the rule, never the value, and nothing is made", { timeout: 150_000 }, async (t) => {
  const coded = answerFlow();
  coded.root.steps.push({ node: "code", label: "double", code: "(s) => ({ answer: { answer: s.answer.answer * 2 } })" });
  const { server, data, repo, promote, agentIds } = await owned(t, flowFiles("coded", coded));
  // The server's own token, written into an active workflow after the fact (as a value made secret later would be).
  const leaking = answerFlow(`Answer the question; sign in with ${server.token}.`);
  for (const [path, text] of Object.entries(flowFiles("leaking", leaking))) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", "workflows"]);
  git(repo, ["commit", "-q", "-m", "an active workflow now holding a secret"]);
  await resnap(data, "source");
  const secret = await promote("leaking");
  assert.equal(secret.status, 400, secret.text);
  assert.ok(secret.json.error.problems.some((one) => one.rule === "secret_value"), secret.text);
  assert.ok(!secret.text.includes(server.token), "never printed");
  const code = await promote("coded");
  assert.equal(code.status, 400, code.text);
  assert.ok(code.json.error.problems.some((one) => one.rule === "executable_node"), code.text);
  assert.deepEqual(await agentIds(), ["source"], "nothing made");
});
