// Learn: a completed run of a revision that lists `learn` commits the agent's next revision, with each lesson the run
// noted as a skill, learned-<12 hex>/SKILL.md, and a dry run that previews it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, startRun } from "./support.mjs";

const RATE_LIMIT = "The state registry rate-limits at 1 request a second.";
const LEARNED = /^learned-[0-9a-f]{12}\/SKILL\.md$/;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Start a run of agent `id` (made first when `extra` is given) and follow it until it is `until`. */
async function ran(api, id, content, extra, until = ["completed"]) {
  const run = extra ? await startRun(api, id, content, extra) : (await api("POST", `/agents/${id}/runs`, { input: { content } })).body;
  await follow(api, run.run_id, until);
  return run.run_id;
}

test("a run whose model called learn: Learn commits the next revision with the lesson as a skill, current, and the next run reads it", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", { ...agent("learner", { tools: ["learn"], skills: ["cite"] }), skills: { "cite/SKILL.md": "# Cite\n" } })).status, 201);
  const before = (await api("GET", "/agents/learner")).body;
  const runId = await ran(api, "learner", "Learn the rate limit.");
  const learned = await api("POST", "/agents/learner/learn", { run_id: runId });
  assert.equal(learned.status, 201, JSON.stringify(learned.body));
  assert.deepEqual(Object.keys(learned.body).sort(), ["learned", "note", "revision"]);
  assert.equal(learned.body.note, `learned from run ${runId}`);
  assert.equal(learned.body.learned.length, 1);
  assert.match(learned.body.learned[0], LEARNED);
  assert.equal(learned.headers.get("etag"), `"${learned.body.revision}"`);
  const name = learned.body.learned[0].slice(0, -"/SKILL.md".length);

  const after = (await api("GET", "/agents/learner")).body;
  assert.equal(after.revision, learned.body.revision, "the learned revision is current");
  assert.deepEqual(after.definition, { ...before.definition, version: 2, skills: ["cite", name] }, "the definition is the current one, plus the learned skill");
  assert.deepEqual(after.skills.map((s) => s.path), ["cite/SKILL.md", learned.body.learned[0]]);
  const text = `A lesson learned in run ${runId}:\n\n${RATE_LIMIT}\n`;
  assert.deepEqual(after.skills.map(({ sha256, size_bytes }) => [sha256, size_bytes]), [
    [before.skills[0].sha256, before.skills[0].size_bytes],
    [sha256(text), Buffer.byteLength(text)],
  ], "the current revision's skill is carried over as it was, and the learned one is the lesson, word for word");
  const [newest, first] = (await api("GET", "/agents/learner/revisions")).body.revisions;
  assert.deepEqual([newest.revision, newest.parent, newest.current, newest.note], [learned.body.revision, before.revision, true, `learned from run ${runId}`]);
  assert.equal(first.revision, before.revision);

  const next = await ran(api, "learner", "What did earlier runs learn?");
  assert.equal((await api("GET", `/runs/${next}`)).body.result.final_answer, `I know: ${RATE_LIMIT}`, "the next run's prompt holds the lesson");
  const again = await api("POST", "/agents/learner/learn", { run_id: runId });
  assert.deepEqual([again.status, again.body.error.code], [409, "not_learnable"], "the current revision holds what the run learned already");
  assert.equal((await api("GET", "/agents/learner/revisions")).body.revisions.length, 2);
});

test("a dry run previews what Learn would commit, the files and the base, and commits nothing; a commit from that base is exactly it", async (t) => {
  const { api } = await serve(t);
  const runId = await ran(api, "previewed", "Learn the rate limit.", { tools: ["learn"] });
  const before = (await api("GET", "/agents/previewed")).body;
  const preview = await api("POST", "/agents/previewed/learn", { run_id: runId, dry_run: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(Object.keys(preview.body).sort(), ["base", "learned"]);
  assert.equal(preview.body.base, before.revision, "the base is the revision the commit would build on");
  assert.equal(preview.body.learned.length, 1);
  const [{ path, text }] = preview.body.learned;
  assert.match(path, LEARNED);
  assert.equal(text, `A lesson learned in run ${runId}:\n\n${RATE_LIMIT}\n`, "the file's whole text");
  const still = await api("GET", "/agents/previewed/revisions");
  assert.deepEqual([still.body.revisions.length, (await api("GET", "/agents/previewed")).body.revision], [1, before.revision], "a dry run commits nothing");
  assert.equal((await api("POST", "/agents/previewed/learn", { run_id: runId, dry_run: true })).status, 200, "and can be asked again");

  const committed = await api("POST", "/agents/previewed/learn", { run_id: runId, base: preview.body.base });
  assert.equal(committed.status, 201, JSON.stringify(committed.body));
  assert.deepEqual(committed.body.learned, [path]);
  const after = (await api("GET", "/agents/previewed")).body;
  assert.deepEqual(after.skills.find((skill) => skill.path === path).sha256, sha256(text), "what was committed is what the preview showed");
  const [newest] = (await api("GET", "/agents/previewed/revisions")).body.revisions;
  assert.equal(newest.parent, preview.body.base);
});

test("a commit from a stale base is 412: the agent's current revision moved since the preview, and nothing is committed", async (t) => {
  const { api } = await serve(t);
  const runId = await ran(api, "stale", "Learn the rate limit.", { tools: ["learn"] });
  const preview = (await api("POST", "/agents/stale/learn", { run_id: runId, dry_run: true })).body;
  await api("PUT", "/agents/stale/definition", { definition: { instructions: "Answer briefly.", tools: ["learn"] } });
  const stale = await api("POST", "/agents/stale/learn", { run_id: runId, base: preview.base });
  assert.deepEqual([stale.status, stale.body.error.code], [412, "precondition_failed"], JSON.stringify(stale.body));
  assert.equal((await api("GET", "/agents/stale/revisions")).body.revisions.length, 2, "the edit, and no learned revision");
  const fresh = (await api("POST", "/agents/stale/learn", { run_id: runId, dry_run: true })).body;
  assert.notEqual(fresh.base, preview.base);
  assert.equal((await api("POST", "/agents/stale/learn", { run_id: runId, base: fresh.base })).status, 201, "a preview of the new current commits");
});

test("Learn builds on the agent's current revision: an edit made since the run is kept, and the learned revision's parent is the edit", async (t) => {
  const { api } = await serve(t);
  const runId = await ran(api, "moved", "Learn the rate limit.", { tools: ["learn"] });
  const edit = (await api("PUT", "/agents/moved/definition", { definition: { instructions: "Answer briefly.", tools: ["learn", "read"] } })).body;
  const learned = await api("POST", "/agents/moved/learn", { run_id: runId });
  assert.equal(learned.status, 201, JSON.stringify(learned.body));
  const [newest] = (await api("GET", "/agents/moved/revisions")).body.revisions;
  assert.deepEqual([newest.revision, newest.parent, newest.version], [learned.body.revision, edit.revision, 3]);
  assert.deepEqual([newest.definition.instructions, newest.definition.tools], ["Answer briefly.", ["learn", "read"]]);
});

test("a learned revision is exactly as runnable as its source: Learn adds skills, which change no blocker or warning, so it skips the save check", async (t) => {
  const { blockersOf } = await import("../dist/runnable.js");
  const { api } = await serve(t);
  const runId = await ran(api, "kept", "Learn the rate limit.", { tools: ["learn"] });
  // The source: the current revision, with a tool this host binds but whose variables it does not set (a warning).
  const edit = await api("PUT", "/agents/kept/definition", { definition: { instructions: "Answer.", tools: ["learn", "browser"] } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const source = (await api("GET", "/agents/kept")).body.definition;
  const learned = await api("POST", "/agents/kept/learn", { run_id: runId });
  assert.equal(learned.status, 201, JSON.stringify(learned.body));
  const made = (await api("GET", "/agents/kept")).body.definition;
  assert.notDeepEqual(made.skills, source.skills, "the learned revision differs from its source by its skills");
  // The whole definition, as serve hands a revision to the check: a check that came to read skills would see them.
  const shape = (definition) => ({ kind: "agentic", ...definition });
  for (const env of [{}, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" }]) {
    const [before, after] = [await blockersOf(env, shape(source)), await blockersOf(env, shape(made))];
    assert.deepEqual(after, before, JSON.stringify(env));
  }
  const warned = await blockersOf({}, shape(source));
  assert.ok(warned.some((b) => b.reason === "not_set_up_here" && b.host), "the case with a warning is a real one");
});

/** One request with every header the caller names, Host and Origin included (fetch sets those itself). */
function call(port, { method = "GET", path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    req.once("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("who may call Learn: the Bearer token, or the page's cookie on a same-origin JSON POST, as on every /v2 route; nothing else", async (t) => {
  const { api, port, token } = await serve(t);
  const runId = await ran(api, "guarded", "Learn the rate limit.", { tools: ["learn"] });
  const opened = await call(port, { path: `/?token=${token}` });
  const cookie = opened.headers["set-cookie"][0].split(";")[0];
  const origin = `http://127.0.0.1:${port}`;
  const json = { "content-type": "application/json" };
  const learn = (headers) => call(port, { method: "POST", path: "/v2/agents/guarded/learn", headers, body: { run_id: runId } });
  for (const [why, headers] of [
    ["no credential", json],
    ["a wrong token", { ...json, authorization: "Bearer not-the-token" }],
    ["the cookie from another origin", { ...json, cookie, origin: "https://evil.example" }],
    ["the cookie with no origin", { ...json, cookie }],
    ["the cookie with a body that is not JSON", { "content-type": "text/plain", cookie, origin }],
    ["the cookie beside a wrong Bearer header", { ...json, cookie, origin, authorization: "Bearer not-the-token" }],
  ]) {
    const refused = await learn(headers);
    assert.deepEqual([refused.status, refused.json.error.code], [401, "unauthenticated"], why);
  }
  assert.equal((await api("GET", "/agents/guarded/revisions")).body.revisions.length, 1, "no refused call committed anything");
  const page = await learn({ ...json, cookie, origin });
  assert.equal(page.status, 201, JSON.stringify(page.json));
  const other = await ran(api, "guarded", "Learn the rate limit.");
  const bearer = await call(port, { method: "POST", path: "/v2/agents/guarded/learn", headers: { ...json, authorization: `Bearer ${token}` }, body: { run_id: other } });
  assert.equal(bearer.status, 201, JSON.stringify(bearer.json));
  assert.equal((await api("GET", "/agents/guarded/revisions")).body.revisions.length, 3);
});

test("a body that is not {run_id} is 422, and an agent or a run that is not here is 404", async (t) => {
  const { api } = await serve(t);
  await api("POST", "/agents", agent("strict", { tools: ["learn"] }));
  for (const body of [{}, { run_id: 7 }, { run_id: "../x" }, { run_id: "r", extra: true }, { run_id: "r", dry_run: "yes" }, { run_id: "r", base: 3 }, { run_id: "r", base: "../x" }]) {
    const answer = await api("POST", "/agents/strict/learn", body);
    assert.deepEqual([answer.status, answer.body.error.code], [422, "input_invalid"], JSON.stringify(body));
  }
  assert.equal((await api("POST", "/agents/strict/learn", { run_id: "no-such-run" })).status, 404);
  assert.equal((await api("POST", "/agents/nobody/learn", { run_id: "no-such-run" })).status, 404);
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.features.learn, true);
  assert.deepEqual(caps.tools.filter((tool) => tool.name === "learn").map(({ available, nodes }) => ({ available, nodes })), [{ available: true, nodes: false }], "an agentic revision may name learn; a workflow's model node may not");
});

test("a run that learned nothing is not learnable (409)", async (t) => {
  const { api } = await serve(t);
  const runId = await ran(api, "quiet", "What is six times seven?", { tools: ["learn"] });
  const answer = await api("POST", "/agents/quiet/learn", { run_id: runId });
  assert.deepEqual([answer.status, answer.body.error.code, answer.body.error.message], [409, "not_learnable", "the run learned nothing"]);
});

test("a run of a revision that does not list learn is not learnable (409), even when its model called learn", async (t) => {
  const { api } = await serve(t);
  const runId = await ran(api, "plain", "Learn the rate limit.", { tools: [] });
  const answer = await api("POST", "/agents/plain/learn", { run_id: runId });
  assert.deepEqual([answer.status, answer.body.error.code], [409, "not_learnable"]);
  assert.match(answer.body.error.message, /does not list the learn tool/);
});

test("a run that is not final is not learnable (409)", async (t) => {
  const { api } = await serve(t);
  const gate = join(await scratch(t), "go");
  const run = await startRun(api, "busy", `Answer once ${gate} exists.`, { tools: ["learn"] });
  const answer = await api("POST", "/agents/busy/learn", { run_id: run.run_id });
  assert.deepEqual([answer.status, answer.body.error.code], [409, "not_learnable"]);
  assert.match(answer.body.error.message, /not final/);
  await writeFile(gate, "");
  await follow(api, run.run_id, ["completed"]);
});

test("another agent's run is not learnable here (409)", async (t) => {
  const { api } = await serve(t);
  const runId = await ran(api, "teacher", "Learn the rate limit.", { tools: ["learn"] });
  await api("POST", "/agents", agent("student", { tools: ["learn"] }));
  const answer = await api("POST", "/agents/student/learn", { run_id: runId });
  assert.deepEqual([answer.status, answer.body.error.code], [409, "not_learnable"]);
  assert.match(answer.body.error.message, /teacher/);
  assert.equal((await api("GET", "/agents/student/revisions")).body.revisions.length, 1);
});

test("the guard checks each learn call in the run: a lesson that repeats the run's input is refused where the model can restate it", async (t) => {
  const { api } = await serve(t);
  const content = "Learn this case: invoice 4821 for Acme Holdings.";
  const runId = await ran(api, "careful", content, { tools: ["learn"] });
  assert.equal((await api("GET", `/runs/${runId}`)).body.result.final_answer, "Not noted: it repeats data from this case. Restate it as a general rule.");
  const answer = await api("POST", "/agents/careful/learn", { run_id: runId });
  assert.deepEqual([answer.status, answer.body.error.message], [409, "the run learned nothing"], "a refused call stored nothing");
});

test("the host's secrets are the values of its keys, tokens, secrets and passwords of 8 characters or more: a shorter value is a placeholder", async () => {
  const { secretsOf } = await import("../dist/learn.js");
  const env = { AGENT_MODEL_API_KEY: "none", OPENAI_API_KEY: "fake-test-key", DB_PASSWORD: "not-a-secret", SHORT_TOKEN: " ab cd ", NODE_ENV: "production", PATH: "/usr/bin" };
  assert.deepEqual(secretsOf(env, ["ar_local_the-server-token"]), ["fake-test-key", "not-a-secret", "ar_local_the-server-token"]);
});

/** A test's own variable in the server's environment, which its run processes inherit; put back after the test. */
function setEnv(t, name, value) {
  const saved = process.env[name];
  process.env[name] = value;
  t.after(() => (saved === undefined ? delete process.env[name] : (process.env[name] = saved)));
}

test("a placeholder key under 8 characters does not refuse a lesson that holds the same word: AGENT_MODEL_API_KEY=none", async (t) => {
  setEnv(t, "AGENT_MODEL_API_KEY", "none");
  const { api } = await serve(t);
  const file = join(await scratch(t), "word.txt");
  await writeFile(file, "none\n");
  const runId = await ran(api, "placeholder", `Learn what ${file} holds.`, { tools: ["learn"] });
  const preview = await api("POST", "/agents/placeholder/learn", { run_id: runId, dry_run: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.match(preview.body.learned[0].text, /The registry key is none\./);
  assert.equal((await api("POST", "/agents/placeholder/learn", { run_id: runId, base: preview.body.base })).status, 201);
});

test("a key of 8 characters or more in the run's environment is refused at the learn call, never echoed, and nothing is learned", async (t) => {
  const secret = "probe-secret-0123456789";
  setEnv(t, "LEARN_PROBE_API_KEY", secret);
  const { api } = await serve(t);
  const file = join(await scratch(t), "key.txt");
  await writeFile(file, `${secret}\n`);
  const runId = await ran(api, "keyed", `Learn what ${file} holds.`, { tools: ["learn"] });
  const answer = (await api("GET", `/runs/${runId}`)).body.result.final_answer;
  assert.match(answer, /^Not noted: it holds a value the host keeps secret/);
  assert.ok(!answer.includes(secret));
  const learned = await api("POST", "/agents/keyed/learn", { run_id: runId });
  assert.deepEqual([learned.status, learned.body.error.message], [409, "the run learned nothing"]);
  assert.ok(!JSON.stringify(learned.body).includes(secret));
});

test("a key of 8 characters or more the server holds now refuses a lesson at a dry run and at Learn (422), never echoed, though the run's process never had it", async (t) => {
  const data = join(await scratch(t), "agents");
  const secret = "rotated-secret-0123456789";
  const file = join(await scratch(t), "key.txt");
  await writeFile(file, `${secret}\n`);
  const first = await serve(t, { data });
  const runId = await ran(first.api, "rotated", `Learn what ${file} holds.`, { tools: ["learn"] });
  await first.close();
  setEnv(t, "LEARN_ROTATED_API_KEY", secret);
  const { api } = await serve(t, { data });
  for (const body of [{ run_id: runId, dry_run: true }, { run_id: runId }]) {
    const answer = await api("POST", "/agents/rotated/learn", body);
    assert.deepEqual([answer.status, answer.body.error.code, answer.body.error.fields.map((f) => f.reason)], [422, "input_invalid", ["secret_value"]], JSON.stringify(body));
    assert.ok(!JSON.stringify(answer.body).includes(secret), "the refusal never repeats the value");
  }
  assert.equal((await api("GET", "/agents/rotated/revisions")).body.revisions.length, 1, "nothing committed");
});

test("a lesson the guard refuses is 422 naming the rule, never the value, and commits nothing", async (t) => {
  const { api, token } = await serve(t);
  const file = join(await scratch(t), "key.txt");
  await writeFile(file, `${token}\n`);
  const runId = await ran(api, "leaky", `Learn what ${file} holds.`, { tools: ["learn"] });
  const answer = await api("POST", "/agents/leaky/learn", { run_id: runId });
  assert.deepEqual([answer.status, answer.body.error.code], [422, "input_invalid"], JSON.stringify(answer.body));
  assert.deepEqual(answer.body.error.fields.map((f) => f.reason), ["secret_value"], "the server's token is a secret the run's process never held");
  assert.ok(!JSON.stringify(answer.body).includes(token), "the refusal never repeats the value");
  const preview = await api("POST", "/agents/leaky/learn", { run_id: runId, dry_run: true });
  assert.deepEqual([preview.status, preview.body.error.fields.map((f) => f.reason)], [422, ["secret_value"]], "a dry run runs the guard too");
  assert.ok(!JSON.stringify(preview.body).includes(token));
  assert.equal((await api("GET", "/agents/leaky/revisions")).body.revisions.length, 1);
});
