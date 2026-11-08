// A person sees the skills and workflow drafts an agent learned beside its notes, and approves one that waits: the
// agent's learning lists each (its name, description, the run that kept it, its size, its status and its version), its
// files read as text, a person's edit and retire stay for notes, and the owner's password session in the console alone
// makes a waiting skill or draft active, in one host commit. A run's learning names the skill and the workflow it kept.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, learnedOnMain, learner, LEARN, made, proposedOf, repoOf, RUN_END_TODO, started } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { call, cookieOf, runDir, serve, withEnv } from "./support.mjs";

const SKILL = "---\nname: find-policies\ndescription: Find a store's refund and shipping policies\n---\n# Find policies\n\n1. Open the policies page first.\n";
const DRAFT = JSON.stringify({
  v: 2,
  name: "find-policies",
  schemas: { Store: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, Policies: { type: "object", properties: { refund: { type: "string" } }, required: ["refund"] } },
  input: { schemaId: "Store" },
  output: { schemaId: "Policies", path: "policies" },
  root: { node: "agent", label: "find", instructions: "Find the store's refund policy from its public pages.", out: "Policies", as: "policies", tools: [] },
}, null, 2);
const DESCRIPTION = "Finds a store's refund policy; use when a case asks for it";
const ANSWER = [
  `\`\`\`note check-units.md\n${note("Check units", "Convert every amount to one unit before comparing")}\`\`\``,
  `\`\`\`\`skill find-policies\n${SKILL}\`\`\`\``,
  `\`\`\`\`workflow find-policies\n---\ndescription: ${DESCRIPTION}\n---\n${DRAFT}\n\`\`\`\``,
].join("\n\n");
const SKILL_FILE = "skills/find-policies/SKILL.md";
const DRAFT_FILE = "workflows/find-policies/workflow.json";
const README_FILE = "workflows/find-policies/README.md";
const json = { "content-type": "application/json" };
const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const enc = encodeURIComponent;

/** A server for learning, and agent `id` whose run answers a note, a skill and a draft, its grader told `more`. */
async function learned(t, id, more = [], options = {}) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const server = options.server ?? (await serve(t, { learning: "on", faux: LEARN, ...options.serve }));
  await made(server.api, learner(id, { instructions: ["Answer the question.", `Answer: ${JSON.stringify(ANSWER)}`, ...more].join("\n") }));
  const runId = await started(server.api, id);
  const { view } = await ended(server.api, runId);
  proposedOf(view);
  const merged = await learnedOnMain(server, id, runId);
  assert.equal(merged.result?.ok, true, JSON.stringify(merged));
  return { ...server, runId, view, repo: repoOf(server.data, id) };
}

test("the agent's learning lists the skill and the workflow it learned beside its notes: name, description, the run that kept it, size, status and version; each file reads as text; a person's edit and retire stay for notes; the run's learning names them", { timeout: 180_000, skip: RUN_END_TODO }, async (t) => {
  const { api, baseUrl, runId, view, repo } = await learned(t, "keeper");
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const agentSchema = doc.paths["/agents/{agent_id}/learning"].get.responses["200"].content["application/json"].schema;
  const agent = (await api("GET", "/agents/keeper/learning")).body;
  assert.deepEqual(schemaProblems(doc, agentSchema, agent), [], JSON.stringify(agent));
  const blob = (path) => git(repo, ["rev-parse", `main:${path}`]);
  const size = (path) => Number(git(repo, ["cat-file", "-s", `main:${path}`]));
  assert.deepEqual(agent.skills, [{ name: "find-policies", file: SKILL_FILE, description: "Find a store's refund and shipping policies", status: "active", run: runId, bytes: size(SKILL_FILE), etag: `"${blob(SKILL_FILE)}"`, last_change: { kind: "learned", by: "run", at: agent.skills[0]?.last_change?.at } }]);
  assert.deepEqual(agent.workflows, [{ name: "find-policies", file: DRAFT_FILE, readme: README_FILE, description: DESCRIPTION, status: "active", run: runId, bytes: size(DRAFT_FILE), etag: `"${blob(README_FILE)}"`, last_change: { kind: "learned", by: "run", at: agent.workflows[0]?.last_change?.at } }]);
  assert.deepEqual(agent.notes.items.map((item) => item.file), ["check-units.md"], "the notes are notes alone");
  // Each file, as text with its version.
  const read = async (file) => api("GET", `/agents/keeper/learning/files/${enc(file)}`);
  for (const [file, type, text] of [[SKILL_FILE, "text/markdown", SKILL], [DRAFT_FILE, "application/json", `${DRAFT}\n`], [README_FILE, "text/markdown", `---\nname: find-policies\ndescription: ${DESCRIPTION}\n---\n`]]) {
    const res = await read(file);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get("etag"), `"${blob(file)}"`, file);
    assert.match(res.headers.get("content-type"), new RegExp(`^${type.replace("/", "\\/")}`), file);
    assert.equal(typeof res.body === "string" ? res.body : JSON.stringify(res.body), typeof res.body === "string" ? text : JSON.stringify(JSON.parse(text)), file);
  }
  for (const bad of ["skills/find-policies/run.sh", "skills/Find/SKILL.md", "workflows/x/other.json"]) assert.equal((await read(bad)).status, 400, bad);
  assert.equal((await read("skills/missing/SKILL.md")).status, 404);
  // A person's edit and create are for notes: a skill or a draft is changed by a run. A draft is retired by its README.md.
  const etag = (await read(SKILL_FILE)).headers.get("etag");
  const put = await api("PUT", `/agents/keeper/learning/files/${enc(SKILL_FILE)}`, { text: SKILL.replace("first", "second") }, { "if-match": etag });
  assert.equal(put.status, 400, JSON.stringify(put.body));
  const json = await read(DRAFT_FILE);
  assert.equal((await api("POST", `/agents/keeper/learning/files/${enc(DRAFT_FILE)}/retire`, undefined, { "if-match": json.headers.get("etag") })).status, 400);
  assert.equal(git(repo, ["show", `main:${SKILL_FILE}`]), SKILL.trimEnd(), "nothing written");
  // The run's learning names the skill and the workflow it kept, on its read, its list and its learning whole.
  const kept = { skills: [{ file: SKILL_FILE, name: "find-policies" }], workflows: [{ file: DRAFT_FILE, name: "find-policies" }] };
  assert.deepEqual([view.learning.skills, view.learning.workflows], [kept.skills, kept.workflows]);
  const listed = (await api("GET", "/agents/keeper/runs")).body.runs.find((run) => run.run_id === runId).learning;
  assert.deepEqual([listed.skills, listed.workflows], [kept.skills, kept.workflows]);
  const whole = (await api("GET", `/runs/${runId}/learning`)).body;
  assert.deepEqual([whole.skills, whole.workflows], [kept.skills, kept.workflows]);
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.Run.properties.learning, view.learning), [], JSON.stringify(view.learning));
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.RunSummary.properties.learning, listed), [], JSON.stringify(listed));
  assert.deepEqual(schemaProblems(doc, doc.paths["/runs/{run_id}/learning"].get.responses["200"].content["application/json"].schema, whole), [], JSON.stringify(whole));
  // An agent that never learned lists none.
  await made(api, learner("blank"));
  const blank = (await api("GET", "/agents/blank/learning")).body;
  assert.deepEqual([blank.skills, blank.workflows], [[], []]);
});

test("a skill or a draft that waits for its owner's OK is listed pending, and approving it takes the owner's password session in the console alone: one host commit drops its status line, logged as by {user, via: console}; a token is 403 and an active one is 400", { timeout: 240_000 }, async (t) => {
  const first = await learned(t, "skiller", ["Grade: pending skills/find-policies/SKILL.md."], { serve: { accounts: true, openSetup: true } });
  const { api, port, repo } = first;
  const second = await learned(t, "flower", ["Grade: pending workflows/find-policies/workflow.json."], { server: first });
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  const listing = async (id) => (await api("GET", `/agents/${id}/learning`)).body;
  const skilled = await listing("skiller");
  assert.deepEqual([skilled.skills[0].status, skilled.workflows[0].status], ["pending", "active"]);
  const flowed = await listing("flower");
  assert.deepEqual([flowed.skills[0].status, flowed.workflows[0].status], ["active", "pending"]);
  const approve = (id, file, etag, headers) => call(port, { method: "POST", path: `/v2/agents/${id}/learning/files/${enc(file)}/approve`, headers: { "if-match": etag, ...headers }, body: {} });
  // A token is refused, as for a note.
  assert.equal((await approve("skiller", SKILL_FILE, skilled.skills[0].etag, { ...json, authorization: `Bearer ${first.token}` })).status, 403);
  const before = git(repo, ["rev-parse", "main"]);
  // The owner's session approves the skill: its SKILL.md is active, in one commit.
  const approved = await approve("skiller", SKILL_FILE, skilled.skills[0].etag, { ...json, cookie, origin });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.text, SKILL);
  assert.equal(git(repo, ["rev-parse", "main^"]), before, "one commit");
  assert.deepEqual(git(repo, ["log", "-1", "--format=%s%n%b", "main"]).split("\n").filter(Boolean), [`learning: approved by a person: ${SKILL_FILE}`, "Changed-By: user", "Approved-Via: console"]);
  assert.deepEqual(git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "main"]).split("\n"), [SKILL_FILE], "the skill alone changed");
  assert.equal((await listing("skiller")).skills[0].status, "active");
  assert.equal((await approve("skiller", SKILL_FILE, approved.headers.etag, { ...json, cookie, origin })).status, 400, "an active skill is not waiting");
  // A stale version is 412.
  const waiting = flowed.workflows[0];
  assert.equal((await approve("flower", waiting.readme, '"0000000000000000000000000000000000000000"', { ...json, cookie, origin })).status, 412);
  // The draft is approved by its README, the file that says it waits.
  const flowRepo = second.repo;
  assert.match(git(flowRepo, ["show", `main:${README_FILE}`]), /\nstatus: pending\n---$/);
  const draft = await approve("flower", waiting.readme, waiting.etag, { ...json, cookie, origin });
  assert.equal(draft.status, 200, draft.text);
  assert.doesNotMatch(git(flowRepo, ["show", `main:${README_FILE}`]), /status/);
  assert.equal((await listing("flower")).workflows[0].status, "active");
  const top = (await api("GET", "/agents/flower/learning/log")).body.items[0];
  assert.deepEqual([top.by, top.files], [{ user: true, via: "console" }, [README_FILE]]);
});

test("a person retires a learned skill or a workflow draft as they retire a note: If-Match on its SKILL.md or its README.md, status: retired in one host commit, listed retired, and the next run no longer gets it; a stale ETag is 412, and a token may retire as it may retire a note", { timeout: 240_000 }, async (t) => {
  const { api, data, repo } = await learned(t, "retirer");
  const files = "/agents/retirer/learning/files";
  const read = (file) => api("GET", `${files}/${enc(file)}`);
  const before = (await read(SKILL_FILE)).headers.get("etag");
  // A stale ETag: the version it names is not main's.
  assert.equal((await api("POST", `${files}/${enc(SKILL_FILE)}/retire`, undefined, { "if-match": '"0000000000000000000000000000000000000000"' })).status, 412);
  // The token retires it, as it retires a note: the file's text with status: retired, under its new ETag.
  const retired = await api("POST", `${files}/${enc(SKILL_FILE)}/retire`, undefined, { "if-match": before });
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  assert.match(retired.body, /^---\n[\s\S]*\nstatus: retired\n[\s\S]*---\n# Find policies/);
  assert.notEqual(retired.headers.get("etag"), before);
  assert.equal(retired.headers.get("etag"), (await read(SKILL_FILE)).headers.get("etag"), "the ETag a read answers now");
  assert.equal(git(repo, ["log", "-1", "--format=%s", "main"]), `learning: retired by a person: ${SKILL_FILE}`);
  assert.deepEqual(git(repo, ["show", "--name-only", "--format=", "main"]).split("\n").filter(Boolean), [SKILL_FILE], "one file changed");
  // A draft by its README.md.
  const readme = await api("POST", `${files}/${enc(README_FILE)}/retire`, undefined, { "if-match": (await read(README_FILE)).headers.get("etag") });
  assert.equal(readme.status, 200, JSON.stringify(readme.body));
  assert.match(readme.body, /\nstatus: retired\n/);
  // Listed retired.
  const view = (await api("GET", "/agents/retirer/learning")).body;
  assert.deepEqual([view.skills.map((s) => [s.file, s.status]), view.workflows.map((w) => [w.file, w.status])], [[[SKILL_FILE, "retired"]], [[DRAFT_FILE, "retired"]]]);
  // Retiring it again answers it as it is, and commits nothing.
  const main = git(repo, ["rev-parse", "main"]);
  assert.equal((await api("POST", `${files}/${enc(SKILL_FILE)}/retire`, undefined, { "if-match": retired.headers.get("etag") })).status, 200);
  assert.equal(git(repo, ["rev-parse", "main"]), main);
  // The next run no longer gets it: not in its pin, not in its work.
  const next = await started(api, "retirer");
  const pin = JSON.parse(readFileSync(join(runDir(data, next), "learning.json"), "utf8"));
  assert.ok(!(pin.skills ?? []).some((path) => path.startsWith("find-policies/")), JSON.stringify(pin));
  assert.throws(() => readFileSync(join(runDir(data, next), "work", ".agents", "skills", "find-policies", "SKILL.md")), /ENOENT/);
  await ended(api, next);
});
