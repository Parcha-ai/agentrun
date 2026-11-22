// A retired workflow draft can be read whole and brought back. The learning view says of each retired draft when, and by
// whom, it was retired (`retired: {at, by}`); its files' GET serves their whole text, read-only. A restore (POST
// .../restore on its README.md) gives it back the status it had before its retire (learn-restore-keeps-hold.test.mjs), in
// one commit on main, its owner's password session alone, as an approval is; and it checks the draft again as a run's
// draft is checked, so a value a retire took out of every run (a secret, a hidden character) never comes back through it.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { ended, git, LEARN, learnedOnMain, learner, made, repoOf, started } from "./learn-support.mjs";
import { call, cookieOf, serve, withEnv } from "./support.mjs";

const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
const PRICE = JSON.stringify({ v: 2, name: "price-report", schemas: { In: { type: "object" }, Out: { type: "object", properties: { total: { type: "number" } } } }, input: { schemaId: "In" }, output: { schemaId: "Out", path: "out" }, root: { node: "extract", label: "sum", instructions: "Sum the prices.", out: "Out", as: "out" } });
const priceReadme = (extra = "", description = "Sums the three shop prices; use for the morning report") => `---\nname: price-report\ndescription: ${description}\n${extra}---\n`;
const README = "workflows/price-report/README.md";
const FLOW = "workflows/price-report/workflow.json";

/** A server with accounts and the owner's session, agent `keeper` (its definition's `extra` fields) with a folder;
 *  `files` committed on main; `env`, more of the server's environment. */
async function keeper(t, files, extra = {}, before = async () => {}, env = {}) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY"]);
  // `env`: what the server starts with beside that (a decision provider's key, its faux), set after the clear.
  withEnv(t, env);
  const server = await serve(t, { learning: "on", faux: LEARN, accounts: true, openSetup: true });
  const { api, data, port } = server;
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  await before({ port, cookie, origin }, t);
  await made(api, learner("keeper", extra));
  await ended(api, await started(api, "keeper"));
  const repo = repoOf(data, "keeper");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "the folder as runs left it"]);
  const etag = async (file) => (await api("GET", `/agents/keeper/learning/files/${encodeURIComponent(file)}`)).headers.get("etag");
  const restore = async (file, headers) => call(port, { method: "POST", path: `/v2/agents/keeper/learning/files/${encodeURIComponent(file)}/restore`, headers: { "if-match": await etag(file), ...headers }, body: {} });
  const retire = async (file) => {
    const res = await api("POST", `/agents/keeper/learning/files/${encodeURIComponent(file)}/retire`, undefined, { "if-match": await etag(file) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };
  const flowOf = async (name) => (await api("GET", "/agents/keeper/learning")).body.workflows.find((item) => item.name === name);
  return { ...server, server, repo, cookie, origin, restore, retire, etag, flowOf };
}

test("a retired draft is read whole and restored by its owner by its README.md: the view says when and that a person retired it, its files serve their text, a token is refused, the owner's session makes it active again in one commit", { timeout: 150_000 }, async (t) => {
  const { api, repo, cookie, origin, restore, retire, server, flowOf } = await keeper(t, { [FLOW]: PRICE, [README]: priceReadme() });
  await retire(README);
  const shown = await flowOf("price-report");
  assert.equal(shown?.status, "retired", JSON.stringify(shown));
  assert.equal(shown.retired?.by, "person", JSON.stringify(shown));
  assert.ok(!Number.isNaN(Date.parse(shown.retired?.at ?? "")), JSON.stringify(shown));
  const readme = await api("GET", `/agents/keeper/learning/files/${encodeURIComponent(README)}`);
  assert.equal(readme.status, 200);
  assert.match(String(readme.body), /description: Sums the three shop prices[\s\S]*status: retired/);
  const flow = await api("GET", `/agents/keeper/learning/files/${encodeURIComponent(FLOW)}`);
  assert.equal(flow.status, 200);
  assert.match(typeof flow.body === "string" ? flow.body : JSON.stringify(flow.body), /Sum the prices\./, "its workflow.json, read-only");
  // The server's token is not the owner: refused as an approval is.
  const byToken = await restore(README, { ...json, authorization: `Bearer ${server.token}` });
  assert.equal(byToken.status, 403, byToken.text);
  // A draft is restored by its README.md alone.
  const byJson = await restore(FLOW, { ...json, cookie, origin });
  assert.equal(byJson.status, 400, byJson.text);
  assert.match(byJson.text, /restored by its README\.md/);
  const before = git(repo, ["rev-parse", "main"]).trim();
  const restored = await restore(README, { ...json, cookie, origin });
  assert.equal(restored.status, 200, restored.text);
  assert.doesNotMatch(restored.text, /status: retired/);
  assert.equal(git(repo, ["rev-list", "--count", `${before}..main`]).trim(), "1", "one commit");
  assert.match(git(repo, ["log", "-1", "--format=%s%n%b", "main"]), new RegExp(`^learning: restored by a person: ${README.replace(/[./]/g, "\\$&")}[\\s\\S]*Changed-By: user`));
  const again = await flowOf("price-report");
  assert.deepEqual([again.status, again.retired, again.last_change?.kind, again.last_change?.by], ["checking", undefined, "restored", "person"], JSON.stringify(again));
  // An active draft is not retired: 400, nothing written.
  const active = await restore(README, { ...json, cookie, origin });
  assert.equal(active.status, 400, active.text);
  assert.match(active.text, /is not retired: it is active/);
});

test("a restore checks the draft again as a run's draft is checked: a retired README holding a secret's shape, a hidden character or the server's own secret is refused, and nothing is committed", { timeout: 150_000 }, async (t) => {
  const shaped = ["s", "k-", "Zx9".repeat(10)].join("");
  const hidden = `Sums the shop prices${String.fromCodePoint(0x202e)} in a table`;
  const draft = (name, description) => ({ [`workflows/${name}/workflow.json`]: PRICE.replace('"price-report"', `"${name}"`), [`workflows/${name}/README.md`]: `---\nname: ${name}\ndescription: ${description}\nstatus: retired\nretired_from: active\n---\n` });
  const { repo, cookie, origin, restore, server, data } = await keeper(t, { ...draft("shaped", `Signs in with ${shaped}`), ...draft("hidden", hidden) });
  // The server's own token, written into a retired draft after the fact (as a value made secret later would be).
  mkdirSync(join(repo, "workflows", "token"), { recursive: true });
  for (const [file, text] of Object.entries(draft("token", `Calls it with ${server.token}`))) writeFileSync(join(repo, file), text);
  git(repo, ["add", "--", "workflows/token"]);
  git(repo, ["commit", "-q", "-m", "a draft now holding a secret"]);
  const before = git(repo, ["rev-parse", "main"]).trim();
  for (const [name, rule] of [["shaped", "secret_shape"], ["hidden", "invisible_unicode"], ["token", "secret_value"]]) {
    const res = await restore(`workflows/${name}/README.md`, { ...json, cookie, origin });
    assert.ok(res.status >= 400 && res.status < 500, `${name}: ${res.status} ${res.text}`);
    assert.match(res.text, new RegExp(rule), `${name}: ${res.text}`);
    assert.ok(!res.text.includes(server.token) && !res.text.includes(shaped), `${name}: never printed`);
  }
  assert.equal(git(repo, ["rev-parse", "main"]).trim(), before, "nothing committed");
});

test("every draft in the learning view says its last change, from the newest commit on its files: learned by a run, then approved, retired and restored by a person, each with when", { timeout: 200_000 }, async (t) => {
  const { api, data, cookie, origin, port, restore, retire, etag, flowOf } = await keeper(t, { [FLOW]: PRICE, [README]: priceReadme("status: pending\n") });
  // A draft a run's compile kept: learned, by the run.
  await made(api, learner("learnt", { learning: { compile_after: 1 } }));
  const learntRun = await started(api, "learnt");
  await ended(api, learntRun);
  assert.equal((await learnedOnMain({ api, data }, "learnt", learntRun)).result?.ok, true);
  const learnt = (await api("GET", "/agents/learnt/learning")).body.workflows.find((item) => item.name === "answer");
  assert.deepEqual([learnt?.last_change?.kind, learnt?.last_change?.by], ["learned", "run"], JSON.stringify(learnt));
  assert.ok(!Number.isNaN(Date.parse(learnt.last_change.at)));
  const lastOf = async () => (await flowOf("price-report"))?.last_change;
  // Approved by its owner.
  const approved = await call(port, { method: "POST", path: `/v2/agents/keeper/learning/files/${encodeURIComponent(README)}/approve`, headers: { ...json, cookie, origin, "if-match": await etag(README) }, body: {} });
  assert.equal(approved.status, 200, approved.text);
  assert.deepEqual([(await lastOf())?.kind, (await lastOf())?.by], ["approved", "person"]);
  // Retired, then restored.
  await retire(README);
  assert.deepEqual([(await lastOf())?.kind, (await lastOf())?.by], ["retired", "person"]);
  assert.equal((await restore(README, { ...json, cookie, origin })).status, 200);
  const last = await lastOf();
  assert.deepEqual([last?.kind, last?.by], ["restored", "person"]);
  assert.ok(!Number.isNaN(Date.parse(last.at)));
});

test("restoring a workflow draft checks its workflow.json too: one holding the server's own secret stays retired, and nothing is committed", { timeout: 150_000 }, async (t) => {
  const { repo, cookie, origin, restore, server, data } = await keeper(t, { [FLOW]: PRICE, [README]: priceReadme("status: retired\n") });
  const draft = (secret) => JSON.stringify({ v: 2, name: "price-report", schemas: { In: { type: "object" }, Out: { type: "object" } }, input: { schemaId: "In" }, output: { schemaId: "Out", path: "out" }, root: { node: "extract", label: "sum", instructions: `Sum the prices; sign in with ${secret}.`, out: "Out", as: "out" } });
  writeFileSync(join(repo, FLOW), draft(server.token));
  git(repo, ["add", "--", FLOW]);
  git(repo, ["commit", "-q", "-m", "a retired draft now holding a secret"]);
  const before = git(repo, ["rev-parse", "main"]).trim();
  const res = await restore(README, { ...json, cookie, origin });
  assert.ok(res.status >= 400 && res.status < 500, `${res.status} ${res.text}`);
  assert.match(res.text, /secret_value/);
  assert.ok(!res.text.includes(server.token), "never printed");
  assert.equal(git(repo, ["rev-parse", "main"]).trim(), before, "nothing committed");
});

test("a retired draft whose workflow.json the learning checker refuses is not restored: it stays retired, nothing committed", { timeout: 150_000 }, async (t) => {
  const BAD = JSON.stringify({ v: 2, name: "price-report", schemas: { In: { type: "object" }, Out: { type: "object", properties: { total: { type: "number" } } } }, input: { schemaId: "In" }, output: { schemaId: "Out", path: "out" }, root: { node: "extract", label: "sum", instructions: "Sum.", out: "Out", as: "out", tools: ["web_fetch"] } });
  const { repo, cookie, origin, restore } = await keeper(t, { [FLOW]: BAD, [README]: priceReadme("status: retired\n") });
  const before = git(repo, ["rev-parse", "main"]).trim();
  const refused = await restore(README, { ...json, cookie, origin });
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.text, /"rule":"workflow","path":"workflows\/price-report\/workflow\.json"/, refused.text);
  assert.equal(git(repo, ["rev-parse", "main"]).trim(), before, "nothing committed");
});

test("a retired workflow draft with a judge node is restored when the server has the decision provider it asks, as a run's learning end checks it (LS-07)", { timeout: 150_000 }, async (t) => {
  const { CANARY } = await import("./fixtures/faux-jev.mjs");
  const JUDGE = JSON.stringify({
    v: 2, name: "claim-check",
    schemas: { In: { type: "object", required: ["claim"], properties: { claim: { type: "string" } } }, Check: { type: "object", required: ["right"], properties: { right: { type: "boolean", description: "Is the claim right?" } } } },
    input: { schemaId: "In" }, output: { schemaId: "Check", path: "check" },
    root: { node: "chain", steps: [{ node: "judge", label: "check", state: { claim: "{claim}" }, out: "Check", as: "check" }] },
  });
  // Retired while active (#2316: a restore gives back the status its retire recorded, else waits for the owner's OK).
  const CLAIM = "---\nname: claim-check\ndescription: Checks whether a claim is right\nstatus: retired\nretired_from: active\n---\n";
  const { cookie, origin, restore, flowOf } = await keeper(t, { "workflows/claim-check/workflow.json": JUDGE, "workflows/claim-check/README.md": CLAIM }, {}, undefined, { TYPESAFE_API_KEY: CANARY, AGENTRUN_SERVE_FAUX_JEV: new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname });
  const restored = await restore("workflows/claim-check/README.md", { ...json, cookie, origin });
  assert.equal(restored.status, 200, restored.text);
  const flow = await flowOf("claim-check");
  assert.equal(flow?.status, "checking", JSON.stringify(flow));
});

/** The fake MCP server saved as `fake`, no auth (its tool `add` among those it lists), closed when the test ends. */
async function saveFakeMcp({ port, cookie, origin }, t) {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  // A server's save is the owner's (a secret write): their session's.
  const saved = await call(port, { method: "PUT", path: "/v2/settings/mcp-servers/fake", headers: { ...json, cookie, origin }, body: { url: fake.url, auth: { type: "none" } } });
  assert.equal(saved.status, 200, saved.text);
}

// Walk 6 on #2479: a retired draft whose call node runs an MCP tool the agent's own tool settings deny stays retired,
// and the refusal names where the deny was set: the agent's tool settings, never the server.
test("a retired draft calling an MCP tool the agent's tool settings deny is not restored: the refusal says it is set to deny for this agent", { timeout: 150_000 }, async (t) => {
  const TICKET = "---\nname: file-ticket\ndescription: Files a ticket; use when asked to file one\nstatus: retired\n---\n";
  const DRAFT = JSON.stringify({ v: 2, name: "file-ticket", schemas: { Q: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, R: { type: "object" } }, input: { schemaId: "Q" }, output: { schemaId: "R", path: "r" }, root: { node: "call", label: "Add them", via: "tool", tool: "mcp:fake/add", args: { a: "{a}", b: "{b}" }, out: "R", as: "r", deadline_s: 30 } });
  const { repo, cookie, origin, restore } = await keeper(t, { "workflows/file-ticket/workflow.json": DRAFT, "workflows/file-ticket/README.md": TICKET }, { tools: ["mcp:fake/add"], tool_settings: { "mcp:fake/add": { permission: "deny" } } }, saveFakeMcp);
  const before = git(repo, ["rev-parse", "main"]).trim();
  const refused = await restore("workflows/file-ticket/README.md", { ...json, cookie, origin });
  assert.equal(refused.status, 400, refused.text);
  const problem = JSON.parse(refused.text).error.problems.find((one) => one.rule === "workflow");
  assert.equal(problem?.detail, "This workflow's call node calls mcp:fake/add, which is set to deny for this agent. (the call node at /root)", refused.text);
  assert.equal(git(repo, ["rev-parse", "main"]).trim(), before, "nothing committed");
});
