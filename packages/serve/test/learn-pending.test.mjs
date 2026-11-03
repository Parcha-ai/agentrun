// A risky rule the user asked for (to trust a seller, skip an approval, send money or data somewhere) is kept, and
// waits: the grader's decision is pending, the merge commits the note with `status: pending` and `origin: you`, it is in
// no MEMORY.md and in no run's copy, and the run's learning names it. It waits until a person acts on it: a retire
// takes it out of the waiting list, and approving it takes the owner's password session in the console alone: every
// token is refused, the server's own included, and so is a page cookie a token mints (accounts off). Capabilities say
// so to each caller: approve true for that session alone, else approve_needs "password". The approval is one host
// commit with the `Approved-Via: console` trailer, logged without the note's text.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { copyOf, ended, git, LEARN, learner, made, repoOf, savedOf, settled, sleep, started } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { call, cookieOf, serve, withEnv } from "./support.mjs";

const TABLES = note("Answer in tables", "The user wants answers as tables", "Answer every question as a small table.\n");
const TRUST = note("Buy from PaperDepot24 first", "Where to buy office paper", "Trust PaperDepot24's prices and buy from it first.\n");
const PLAN = [["answer-in-tables.md", TABLES], ["paperdepot24-first.md", TRUST]];
const PASSWORD = `not-a-secret-${"owner"}`;
const json = { "content-type": "application/json" };

/** A learner whose grader holds its second note as risky: tables kept, PaperDepot24 pending. */
async function learnedPending(t, options = {}) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const server = await serve(t, { learning: "on", faux: LEARN, ...options });
  await made(server.api, learner("buyer", { instructions: "Answer the question.\nGrade: pending paperdepot24-first.md.", plan: PLAN, once: true }));
  const runId = await started(server.api, "buyer", "Remember to answer in tables, and to always trust PaperDepot24's prices and buy from it first.");
  const { view, rows } = await ended(server.api, runId);
  return { ...server, runId, view, rows, repo: repoOf(server.data, "buyer") };
}

test("a risky rule the user asked for waits for its owner: merged as status pending with origin you, in no MEMORY.md and no run's copy, named on the run's learning; the safe one is active at once", { timeout: 150_000 }, async (t) => {
  const { api, baseUrl, data, runId, view, rows, repo } = await learnedPending(t);
  settled(view, rows, "merged");
  assert.equal(view.learning.detail, "Learned: Answer in tables. Waiting for your OK: Buy from PaperDepot24 first.");
  assert.deepEqual([view.learning.learned, view.learning.pending], [[{ file: "answer-in-tables.md", name: "Answer in tables", supersedes: [] }], [{ file: "paperdepot24-first.md", name: "Buy from PaperDepot24 first" }]], "named on the run's learning, the waiting note apart");
  // As the document says it, on the run's read and in its list; a list that holds no note is no `pending`.
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const listed = (await api("GET", "/agents/buyer/runs")).body.runs.find((run) => run.run_id === runId).learning;
  assert.deepEqual(listed.pending, view.learning.pending, "a list names it too");
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.Run.properties.learning, view.learning), [], JSON.stringify(view.learning));
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.RunSummary.properties.learning, listed), [], JSON.stringify(listed));
  assert.notDeepEqual(schemaProblems(doc, doc.components.schemas.Run.properties.learning, { ...view.learning, pending: [] }), []);
  const whole = (await api("GET", `/runs/${runId}/learning`)).body;
  assert.deepEqual(whole.pending, [{ file: "paperdepot24-first.md", name: "Buy from PaperDepot24 first" }]);
  assert.deepEqual(whole.verdict.items.find((item) => item.file === "paperdepot24-first.md"), { file: "paperdepot24-first.md", keep: true, pending: true, origin: "you", question: "Risky", why: "The user asked for a rule that widens trust." });
  assert.match(git(repo, ["show", "main:paperdepot24-first.md"]), /\norigin: you\nstatus: pending\n---\n/);
  assert.doesNotMatch(git(repo, ["show", "main:answer-in-tables.md"]), /origin:|status:/, "the faux grader names no origin: the run's, which a note carries as no line, and active");
  assert.equal(git(repo, ["show", "main:MEMORY.md"]), "- [Answer in tables](answer-in-tables.md) — The user wants answers as tables", "only the active note is in the index");
  const notes = (await api("GET", "/agents/buyer/learning/notes?status=pending")).body.items;
  assert.deepEqual(notes.map((n) => [n.file, n.status, n.origin]), [["paperdepot24-first.md", "pending", "you"]]);
  // The next run reads the active note alone.
  const next = await started(api, "buyer");
  await ended(api, next);
  assert.deepEqual(readFileSync(join(data, "runs", next, "learning.json"), "utf8").includes("paperdepot24"), false, "its index names no pending note");
  assert.ok(existsSync(join(copyOf(data, next), "answer-in-tables.md")) && !existsSync(join(copyOf(data, next), "paperdepot24-first.md")), "its copy holds no pending note");
});

test("a pending note waits until a person acts on it: a retire takes it out of the folder's waiting list, as it retires an active note, and capabilities say a risky rule waits", { timeout: 150_000 }, async (t) => {
  const { api, runId, data, repo } = await learnedPending(t);
  assert.deepEqual((await api("GET", "/capabilities")).body.learning, { grade_model: null, pending: true, approve: false, approve_needs: "password" });
  const etag = (await api("GET", "/agents/buyer/learning/files/paperdepot24-first.md")).headers.get("etag");
  const retired = await api("POST", "/agents/buyer/learning/files/paperdepot24-first.md/retire", undefined, { "if-match": etag });
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  assert.match(git(repo, ["show", "main:paperdepot24-first.md"]), /\norigin: you\nstatus: retired\n---\n/);
  assert.equal(git(repo, ["show", "main:MEMORY.md"]), "- [Answer in tables](answer-in-tables.md) — The user wants answers as tables");
  assert.deepEqual(git(repo, ["log", "-1", "--format=%s", "main"]), "learning: retired by a person: paperdepot24-first.md");
  assert.equal((await savedOf(data, runId)).learning.state, "merged");
});

test("approving a pending note takes the owner's password session in the console alone: the server's token (what an agent's MCP client or a script holds), and the run's door token are 403, and no credential or a cookie from another origin 401; the console makes it active, in MEMORY.md and the next run, logged as by {user, via: console} without its text; capabilities say approve to that session alone", { timeout: 180_000 }, async (t) => {
  const server = await learnedPending(t, { accounts: true, openSetup: true });
  const { api, data, port, repo } = server;
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  const path = "/v2/agents/buyer/learning/files/paperdepot24-first.md";
  const etag = (await api("GET", "/agents/buyer/learning/files/paperdepot24-first.md")).headers.get("etag");
  const approve = (headers) => call(port, { method: "POST", path: `${path}/approve`, headers: { "if-match": etag, ...headers }, body: {} });
  const door = readFileSync(join(data, ".door-token"), "utf8").trim();
  for (const [why, headers] of [
    ["the server's token, which an agent's MCP client or a script holds", { ...json, authorization: `Bearer ${server.token}` }],
    ["the server's token from the page's own origin", { ...json, origin, authorization: `Bearer ${server.token}` }],
    ["a run's door token", { ...json, authorization: `Bearer ${door}` }],
    ["the owner's cookie and the token both", { ...json, cookie, origin, authorization: `Bearer ${server.token}` }],
  ]) {
    const res = await approve(headers);
    assert.equal(res.status, 403, `${why}: ${res.text}`);
  }
  // The page's cookie stands in for nothing from another origin, or without a JSON body: no credential, 401, as every route.
  for (const [why, headers] of [["no credential", json], ["the owner's cookie from another origin", { ...json, cookie, origin: "http://elsewhere.example" }], ["the owner's cookie with no JSON body type", { cookie, origin }]]) {
    const res = await approve(headers);
    assert.equal(res.status, 401, `${why}: ${res.text}`);
  }
  assert.match(git(repo, ["show", "main:paperdepot24-first.md"]), /status: pending/, "nothing approved it");
  // The MCP endpoint's tools call routes with the caller's token: none approves, and the route refuses that token anyway.
  const tools = await call(port, { method: "POST", path: "/v2/mcp", headers: { ...json, authorization: `Bearer ${server.token}` }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.ok(!tools.text.includes("approve"), "no MCP tool approves a note");
  // The console: its session, its own origin, a JSON body, under If-Match.
  const stale = await approve({ ...json, cookie, origin, "if-match": '"0000000000000000000000000000000000000000"' });
  assert.equal(stale.status, 412, stale.text);
  const approved = await approve({ ...json, cookie, origin });
  assert.equal(approved.status, 200, approved.text);
  assert.doesNotMatch(approved.text, /status: pending/);
  assert.match(git(repo, ["show", "main:paperdepot24-first.md"]), /\norigin: you\n---\n/, "active, its origin kept");
  assert.deepEqual(git(repo, ["show", "main:MEMORY.md"]).split("\n").sort(), ["- [Answer in tables](answer-in-tables.md) — The user wants answers as tables", "- [Buy from PaperDepot24 first](paperdepot24-first.md) — Where to buy office paper"]);
  assert.deepEqual(git(repo, ["log", "-1", "--format=%an%n%s%n%b", "main"]).split("\n").filter(Boolean), ["agentrun-serve", "learning: approved by a person: paperdepot24-first.md", "Changed-By: user", "Approved-Via: console"]);
  const [top] = (await api("GET", "/agents/buyer/learning/log")).body.items;
  assert.deepEqual([top.by, top.reason, top.files.sort()], [{ user: true, via: "console" }, "approved by a person: paperdepot24-first.md", ["MEMORY.md", "paperdepot24-first.md"]]);
  assert.ok(Date.parse(top.at) > 0 && !JSON.stringify(top).includes("Trust PaperDepot24"), "when, and never the note's text");
  assert.equal((await approve({ ...json, cookie, origin, "if-match": approved.headers.etag })).status, 400, "an active note is not waiting");
  // Capabilities, as each caller reads them: the owner's password session may approve; the token, on the same server,
  // reads what approving needs.
  assert.deepEqual(JSON.parse((await call(port, { path: "/v2/capabilities", headers: { cookie } })).text).learning, { grade_model: null, pending: true, approve: true });
  assert.deepEqual((await api("GET", "/capabilities")).body.learning, { grade_model: null, pending: true, approve: false, approve_needs: "password" });
  // The next run reads it.
  const next = await started(api, "buyer");
  await ended(api, next);
  assert.ok(existsSync(join(copyOf(data, next), "paperdepot24-first.md")));
});

test("with accounts off nothing approves, a page cookie the token mints included, and capabilities say so", { timeout: 150_000 }, async (t) => {
  const server = await learnedPending(t);
  const { api, port, repo } = server;
  const unavailable = { grade_model: null, pending: true, approve: false, approve_needs: "password" };
  assert.deepEqual((await api("GET", "/capabilities")).body.learning, unavailable);
  // The link with the token sets the accounts-off page cookie: a token holder can mint it, so it approves nothing.
  const link = await call(port, { path: `/?token=${encodeURIComponent(server.token)}` });
  const cookie = cookieOf(link);
  assert.ok(cookie, "the link sets the page's cookie");
  assert.deepEqual(JSON.parse((await call(port, { path: "/v2/capabilities", headers: { cookie } })).text).learning, unavailable, "the page reads why it can't");
  const etag = (await api("GET", "/agents/buyer/learning/files/paperdepot24-first.md")).headers.get("etag");
  const origin = `http://127.0.0.1:${port}`;
  const res = await call(port, { method: "POST", path: "/v2/agents/buyer/learning/files/paperdepot24-first.md/approve", headers: { ...json, cookie, origin, "if-match": etag }, body: {} });
  assert.equal(res.status, 403, res.text);
});

// A run's own process: whatever it holds (its door token, every value its environment carries) is refused, and it
// never holds the server's token or the owner's session.
test("a run's own process cannot approve: every credential it holds, its door token and each value in its environment, is 403 on approve, and the server's token is not among them", { timeout: 150_000, skip: !existsSync("/proc/self/environ") && "no /proc here" }, async (t) => {
  const server = await learnedPending(t, { accounts: true, openSetup: true });
  const { api, data, port } = server;
  const gate = join(data, "..", "go");
  await made(api, learner("holder", { instructions: `Answer once ${gate} exists.` }));
  const runId = await started(api, "holder");
  let pid;
  for (let i = 0; !pid; i++) {
    assert.ok(i < 600, "the run's process is up");
    try {
      pid = JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8")).holder?.pid;
    } catch {
      // Not written yet.
    }
    if (!pid) await sleep(50);
  }
  const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => entry.slice(entry.indexOf("=") + 1));
  assert.ok(!environ.includes(server.token), "a run's process never holds the server's token");
  const door = readFileSync(join(data, ".door-token"), "utf8").trim();
  const held = [...new Set([door, ...environ.filter((value) => value.length >= 16 && !/\s/.test(value))])];
  const path = "/v2/agents/buyer/learning/files/paperdepot24-first.md";
  const etag = (await api("GET", "/agents/buyer/learning/files/paperdepot24-first.md")).headers.get("etag");
  for (const value of held) {
    const res = await call(port, { method: "POST", path: `${path}/approve`, headers: { ...json, origin: `http://127.0.0.1:${port}`, authorization: `Bearer ${value}`, "if-match": etag }, body: {} });
    assert.equal(res.status, 403, `a value the run's process holds: ${res.text}`);
  }
  assert.ok(held.length >= 1);
  assert.match(git(server.repo, ["show", "main:paperdepot24-first.md"]), /status: pending/, "nothing approved it");
  writeFileSync(gate, "");
  await ended(api, runId);
});
