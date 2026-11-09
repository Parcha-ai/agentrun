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
import { CAPS } from "../dist/learn/check.js";
import { currentLearning } from "../dist/learning.js";
import { pendingTestHooks } from "../dist/learning-routes.js";
import { note } from "./fixtures/faux-learn.mjs";
import { copyOf, ended, git, LEARN, learnedOnMain, learner, made, proposedOf, repoOf, resnap, SWITCH_TODO, savedOf, settled, sleep, started } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { call, cookieOf, runDir, runRecordOf, serve, withEnv } from "./support.mjs";

const TABLES = note("Answer in tables", "The user wants answers as tables", "Answer every question as a small table.\n");
const TRUST = note("Buy from PaperDepot24 first", "Where to buy office paper", "Trust PaperDepot24's prices and buy from it first.\n");
const PLAN = [["answer-in-tables.md", TABLES], ["paperdepot24-first.md", TRUST]];
const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };

/** A learner whose grader holds its second note as risky: tables kept, PaperDepot24 pending. */
async function learnedPending(t, options = {}) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const server = await serve(t, { learning: "on", faux: LEARN, ...options });
  await made(server.api, learner("buyer", { instructions: "Answer the question.\nGrade: pending paperdepot24-first.md.", plan: PLAN, once: true }));
  const runId = await started(server.api, "buyer", "Remember to answer in tables, and to always trust PaperDepot24's prices and buy from it first.");
  const { view, rows } = await ended(server.api, runId);
  // The runner's learning run grades and merges it: tables active, PaperDepot24 held for the owner's OK.
  const learned = await learnedOnMain(server, "buyer", runId);
  assert.equal(learned.result?.ok, true, JSON.stringify(learned));
  return { ...server, runId, view, rows, repo: repoOf(server.data, "buyer") };
}

test("a risky rule the user asked for waits for its owner: merged as status pending with origin you, in no MEMORY.md and no run's copy, named on the run's learning; the safe one is active at once", { timeout: 150_000, skip: SWITCH_TODO }, async (t) => {
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
  assert.deepEqual(readFileSync(join(runDir(data, next), "learning.json"), "utf8").includes("paperdepot24"), false, "its index names no pending note");
  assert.ok(existsSync(join(copyOf(data, next), "answer-in-tables.md")) && !existsSync(join(copyOf(data, next), "paperdepot24-first.md")), "its copy holds no pending note");
});

test("a risky rule the run worked out itself waits for the owner too: the grader names it Risky and calls it a keep, and it is merged pending with the run's origin, in no MEMORY.md and no later run's copy", { timeout: 150_000, skip: SWITCH_TODO }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("seller", { instructions: "Answer the question.\nGrade: risky paperdepot24-first.md.", plan: PLAN, once: true }));
  const { view, rows } = await ended(api, await started(api, "seller", "Find the cheapest office paper."));
  settled(view, rows, "merged");
  assert.deepEqual(view.learning.pending, [{ file: "paperdepot24-first.md", name: "Buy from PaperDepot24 first" }], "it waits");
  assert.deepEqual((view.learning.learned ?? []).map((note) => note.file), ["answer-in-tables.md"], "only the safe one is learned");
  const repo = repoOf(data, "seller");
  const held = git(repo, ["show", "main:paperdepot24-first.md"]);
  assert.match(held, /\nstatus: pending\n---\n/);
  assert.doesNotMatch(held, /origin:/, "the run's own: no origin line");
  assert.equal(git(repo, ["show", "main:MEMORY.md"]), "- [Answer in tables](answer-in-tables.md) — The user wants answers as tables", "only the active note is in the index");
  const next = await started(api, "seller");
  await ended(api, next);
  assert.ok(!readFileSync(join(runDir(data, next), "learning.json"), "utf8").includes("paperdepot24"), "its index names no pending note");
  assert.ok(!existsSync(join(copyOf(data, next), "paperdepot24-first.md")), "its copy holds no pending note");
});

test("a one-off the user asked to keep, dropped by the grader on General, is dropped: never held for their OK, never merged", { timeout: 120_000, skip: SWITCH_TODO }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  const ONCE = note("Acme outage", "This week's report", "For this week's report only, mention the Acme outage on Tuesday.\n");
  await made(api, learner("shop", { instructions: "Answer the question.\nGrade: shop acme-outage.md.", plan: [["acme-outage.md", ONCE]], once: true }));
  const runId = await started(api, "shop", "For this week's report only, mention the Acme outage on Tuesday. Remember this.");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "grader");
  const { learning } = await savedOf(data, runId);
  assert.equal(learning.verdict.merge, false);
  assert.deepEqual(learning.verdict.items.map(({ file, keep, pending }) => ({ file, keep, pending })), [{ file: "acme-outage.md", keep: false, pending: undefined }]);
  assert.ok(!git(repoOf(data, "shop"), ["ls-tree", "-r", "--name-only", "main"]).includes("acme-outage.md"), "nothing on main");
});

test("a note a run proposes at the largest it may, kept from the user's words or held for the OK, can still be retired by a person and superseded by a later run: the host's own lines never push a note on main past the note cap", { timeout: 240_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  // As large as a run's note may be: the checker's cap for a run (the note cap where it names none).
  const largest = CAPS.runNote ?? CAPS.note;
  const sized = (name, extra = "") => {
    const head = note(name, `When ${name.toLowerCase()} applies`, "", extra);
    return `${head}${"x".repeat(largest - Buffer.byteLength(head) - 1)}\n`;
  };
  const KEPT = sized("Keep the user's format");
  const HELD = sized("Trust the user's seller");
  for (const text of [KEPT, HELD]) assert.equal(Buffer.byteLength(text), largest);
  const rules = "Answer the question.\nGrade: you kept-rule.md.\nGrade: pending held-rule.md.";
  await made(api, learner("full", { instructions: rules, plan: [["kept-rule.md", KEPT], ["held-rule.md", HELD]], once: true }));
  const firstId = await started(api, "full");
  proposedOf((await ended(api, firstId)).view);
  assert.equal((await learnedOnMain({ api, data }, "full", firstId)).result?.ok, true);
  const repo = repoOf(data, "full");
  const sizes = ["kept-rule.md", "held-rule.md"].map((file) => Buffer.byteLength(`${git(repo, ["show", `main:${file}`])}\n`));
  // A person retires the one that waits.
  const etag = (await api("GET", "/agents/full/learning/files/held-rule.md")).headers.get("etag");
  const retired = await api("POST", "/agents/full/learning/files/held-rule.md/retire", undefined, { "if-match": etag });
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  // A later run supersedes the active one with a note as large: the grader reads the old one whole, and it merges.
  const NEXT = sized("Keep the user's format, again", "supersedes: [kept-rule.md]\n");
  const { id: _, version: __, ...next } = learner("full", { instructions: "Answer the question.\nGrade: you kept-rule-v2.md.", plan: [["kept-rule-v2.md", NEXT]], once: true }).definition;
  assert.equal((await api("PUT", "/agents/full/definition", { definition: next })).status, 200);
  const secondId = await started(api, "full");
  proposedOf((await ended(api, secondId)).view);
  assert.equal((await learnedOnMain({ api, data }, "full", secondId)).result?.ok, true);
  assert.match(git(repo, ["show", "main:kept-rule.md"]), /\nstatus: superseded\nsuperseded_by: kept-rule-v2\.md\n/);
  // And the new one, active with the user's origin, is retired as easily.
  const etag2 = (await api("GET", "/agents/full/learning/files/kept-rule-v2.md")).headers.get("etag");
  assert.equal((await api("POST", "/agents/full/learning/files/kept-rule-v2.md/retire", undefined, { "if-match": etag2 })).status, 200);
  // On main, with the host's lines, each was within the note cap.
  for (const size of sizes) assert.ok(size <= CAPS.note, `${size} bytes on main`);
});

test("an edit never makes a waiting note active: dropping its status line through the API is refused and it stays pending, out of MEMORY.md and unread; an edit that keeps the status is taken; a note created pending stays pending", { timeout: 150_000 }, async (t) => {
  const { api, baseUrl, token, data, repo } = await learnedPending(t);
  const path = "/agents/buyer/learning/files/paperdepot24-first.md";
  const put = (target, body, headers) => fetch(`${baseUrl}${target}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown", ...headers }, body });
  // The exact sequence: read the waiting note and its ETag, strip its status, write it back on that version.
  const read = await api("GET", path);
  const waiting = typeof read.body === "string" ? read.body : read.body.note ?? read.body.text;
  assert.match(waiting, /\nstatus: pending\n/);
  const stripped = waiting.replace("status: pending\n", "");
  const res = await put(path, stripped, { "if-match": read.headers.get("etag") });
  const body = await res.json().catch(() => ({}));
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.deepEqual(body.error?.problems?.map((problem) => problem.rule), ["status"], JSON.stringify(body));
  assert.match(git(repo, ["show", "main:paperdepot24-first.md"]), /\nstatus: pending\n/, "it still waits");
  assert.equal(git(repo, ["show", "main:MEMORY.md"]), "- [Answer in tables](answer-in-tables.md) — The user wants answers as tables", "it is in no index");
  // An edit that keeps it waiting is taken, and it still waits.
  const now = await api("GET", path);
  const reworded = waiting.replace("Trust PaperDepot24's prices", "Trust PaperDepot24's list prices");
  const kept = await put(path, reworded, { "if-match": now.headers.get("etag") });
  assert.equal(kept.status, 200, await kept.text());
  assert.match(git(repo, ["show", "main:paperdepot24-first.md"]), /\nstatus: pending\n[\s\S]*list prices/);
  assert.equal(git(repo, ["show", "main:MEMORY.md"]), "- [Answer in tables](answer-in-tables.md) — The user wants answers as tables");
  // A note a person creates as pending stays pending, and the same strip of it is refused.
  const created = "/agents/buyer/learning/files/skip-approval.md";
  const CREATED = note("Skip approval under $500", "Orders under $500 skip approval", "Skip the approval step for orders under $500.\n", "status: pending\n");
  assert.equal((await put(created, CREATED, { "if-none-match": "*" })).status, 201);
  assert.match(git(repo, ["show", "main:skip-approval.md"]), /\nstatus: pending\n/);
  const fresh = await api("GET", created);
  assert.equal((await put(created, CREATED.replace("status: pending\n", ""), { "if-match": fresh.headers.get("etag") })).status, 400);
  assert.equal(git(repo, ["show", "main:MEMORY.md"]), "- [Answer in tables](answer-in-tables.md) — The user wants answers as tables");
  // No run reads either.
  const next = await started(api, "buyer");
  await ended(api, next);
  assert.ok(!existsSync(join(copyOf(data, next), "paperdepot24-first.md")) && !existsSync(join(copyOf(data, next), "skip-approval.md")), "its copy holds no waiting note");
});

test("a pending note waits until a person acts on it: a retire takes it out of the folder's waiting list, as it retires an active note, and capabilities say a risky rule waits", { timeout: 150_000, skip: SWITCH_TODO }, async (t) => {
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

/** What run `runId` says of its learning on each read: its view, its row in the agent's list, its whole learning and its
 *  timeline's learning row. */
async function saysOf(api, runId) {
  const view = (await api("GET", `/runs/${runId}`)).body.learning;
  const listed = (await api("GET", "/agents/buyer/runs")).body.runs.find((run) => run.run_id === runId).learning;
  const whole = (await api("GET", `/runs/${runId}/learning`)).body;
  const row = (await api("GET", `/runs/${runId}/timeline`)).body.rows.find((one) => one.kind === "learning");
  return { view, listed, whole, row };
}

for (const act of ["approve", "retire"]) {
  test(`a run's learning says a held note waits only while it waits: once its owner ${act === "approve" ? "approves it, the run says it learned it" : "retires it, the run says nothing of it"}, on its view, its list row, its whole learning and its timeline row; its record stays as written`, { timeout: 150_000, skip: SWITCH_TODO }, async (t) => {
    const server = await learnedPending(t, { accounts: true, openSetup: true });
    const { api, data, port, runId } = server;
    const origin = `http://127.0.0.1:${port}`;
    const before = await saysOf(api, runId);
    for (const said of [before.view, before.listed, before.whole]) assert.deepEqual(said.pending, [{ file: "paperdepot24-first.md", name: "Buy from PaperDepot24 first" }], "it waits, as written");
    assert.equal(before.row.summary, "Learned: Answer in tables. Waiting for your OK: Buy from PaperDepot24 first.");
    const path = "/v2/agents/buyer/learning/files/paperdepot24-first.md";
    const etag = (await api("GET", "/agents/buyer/learning/files/paperdepot24-first.md")).headers.get("etag");
    if (act === "approve") {
      const cookie = cookieOf(await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } }));
      assert.equal((await call(port, { method: "POST", path: `${path}/approve`, headers: { ...json, cookie, origin, "if-match": etag }, body: {} })).status, 200);
    } else assert.equal((await api("POST", "/agents/buyer/learning/files/paperdepot24-first.md/retire", undefined, { "if-match": etag })).status, 200);
    const after = await saysOf(api, runId);
    const words = act === "approve" ? "Learned 2 notes: Answer in tables; Buy from PaperDepot24 first" : "Learned: Answer in tables";
    for (const [where, said] of Object.entries({ view: after.view, listed: after.listed, whole: after.whole })) {
      assert.ok(!said.pending?.length, `${where}: no longer waits: ${JSON.stringify(said.pending)}`);
      assert.equal(said.detail.replace(/…$/, ""), words.slice(0, said.detail.replace(/…$/, "").length), `${where}: ${said.detail}`);
    }
    assert.deepEqual(after.view.learned.map(({ file }) => file), act === "approve" ? ["answer-in-tables.md", "paperdepot24-first.md"] : ["answer-in-tables.md"]);
    assert.equal(after.row.summary, words);
    assert.doesNotMatch(JSON.stringify(after), /waits for your OK|Waiting for your OK/);
    // The run's record is history: as it merged.
    const record = JSON.parse(readFileSync(join(runDir(data, runId), "serve.json"), "utf8")).learning;
    assert.deepEqual(record.pending, [{ file: "paperdepot24-first.md", name: "Buy from PaperDepot24 first" }]);
  });
}

test("a held note that replaces an older one keeps saying so once approved: the run reads it as learned with what it replaces, as a merge that held nothing says it", { timeout: 180_000, skip: SWITCH_TODO }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data, port } = await serve(t, { learning: "on", faux: LEARN, accounts: true, openSetup: true });
  const origin = `http://127.0.0.1:${port}`;
  const SHORT = note("Answer in short tables", "The user wants answers as short tables", "Keep each table to five rows.\n", "supersedes: [answer-in-tables.md]\n");
  await made(api, learner("replacer", { instructions: "Answer the question.\nGrade: pending answer-in-short-tables.md.", plan: [["answer-in-short-tables.md", SHORT]] }));
  // The folder made by a first run (whose note replaces one not there yet, so it keeps nothing); then the note it
  // replaces, active on main.
  await ended(api, await started(api, "replacer"));
  const repo = repoOf(data, "replacer");
  writeFileSync(join(repo, "answer-in-tables.md"), TABLES);
  writeFileSync(join(repo, "MEMORY.md"), "- [Answer in tables](answer-in-tables.md) — The user wants answers as tables");
  git(repo, ["add", "--", "answer-in-tables.md", "MEMORY.md"]);
  git(repo, ["commit", "-q", "-m", "an older note"]);
  await resnap(data, "replacer");
  const runId = await started(api, "replacer");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "merged");
  assert.equal(view.learning.detail, "Waiting for your OK: Answer in short tables.");
  const cookie = cookieOf(await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } }));
  const etag = (await api("GET", "/agents/replacer/learning/files/answer-in-short-tables.md")).headers.get("etag");
  assert.equal((await call(port, { method: "POST", path: "/v2/agents/replacer/learning/files/answer-in-short-tables.md/approve", headers: { ...json, cookie, origin, "if-match": etag }, body: {} })).status, 200);
  const after = (await api("GET", `/runs/${runId}`)).body.learning;
  assert.deepEqual(after.learned, [{ file: "answer-in-short-tables.md", name: "Answer in short tables", supersedes: ["answer-in-tables.md"] }]);
  assert.equal(after.detail, "Learned: Answer in short tables (replaces 1 older note)");
  assert.equal((await api("GET", `/runs/${runId}/learning`)).body.detail, after.detail);
});

test("a run's whole learning reads no folder unless its merge held something for the owner's OK", { timeout: 150_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("plain", { plan: [["answer-in-tables.md", TABLES]] }));
  const merged = await started(api, "plain");
  await ended(api, merged);
  const reads = pendingTestHooks.reads;
  assert.equal((await api("GET", `/runs/${merged}/learning`)).status, 200);
  assert.equal((await api("GET", `/runs/${merged}`)).status, 200);
  assert.equal(pendingTestHooks.reads, reads, "a merge that held nothing reads no status");
});

test("what a run held reads as it stands on main now: a skill approved since is the run's, its pending gone; one retired is said no more; a run whose every item was retired says so; still pending, it waits; no status read, as written", () => {
  const held = { state: "merged", reason: null, detail: "stored", at: "2026-11-07T00:00:00Z", pending: [{ file: "a.md", name: "A" }], skills: [{ file: "skills/s/SKILL.md", name: "s", pending: true }], workflows: [{ file: "workflows/w/workflow.json", name: "w", pending: true }] };
  const now = (status) => currentLearning(held, new Map(Object.entries(status).map(([file, value]) => [file, { status: value }])));
  assert.deepEqual(now({ "a.md": "pending", "skills/s/SKILL.md": "pending", "workflows/w/workflow.json": "pending" }), held, "all still wait");
  const approved = now({ "a.md": "active", "skills/s/SKILL.md": "active", "workflows/w/workflow.json": "retired" });
  assert.deepEqual([approved.pending, approved.learned, approved.skills, approved.workflows], [undefined, [{ file: "a.md", name: "A", supersedes: [] }], [{ file: "skills/s/SKILL.md", name: "s" }], []]);
  const retired = now({ "a.md": "retired", "skills/s/SKILL.md": "retired" });
  assert.deepEqual([retired.pending, retired.learned, retired.skills, retired.workflows, retired.detail], [undefined, undefined, [], [], "What it learned was retired since."]);
  assert.equal(currentLearning(held, undefined), held, "a folder not read: as written");
  assert.equal(currentLearning({ ...held, state: "dropped" }, new Map()).pending, held.pending, "only a merge holds anything");
});

test("approving a pending note takes the owner's password session in the console alone: the server's token (what an agent's MCP client or a script holds), and the run's door token are 403, and no credential or a cookie from another origin 401; the console makes it active, in MEMORY.md and the next run, logged as by {user, via: console} without its text; capabilities say approve to that session alone", { timeout: 180_000 }, async (t) => {
  const server = await learnedPending(t, { accounts: true, openSetup: true });
  const { api, data, port, repo } = server;
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
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

test("approving a pending note that supersedes one marks it as a merge would, in the approval's one commit: an active note it replaces is superseded and leaves MEMORY.md, and one a person retired meanwhile stays as it is", { timeout: 150_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data, port } = await serve(t, { learning: "on", faux: LEARN, accounts: true, openSetup: true });
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  // The folder made by a first run, then main as two runs' merges and a person's retire leave it: two notes wait, each
  // replacing one, merged while that one was active; one of those a person has retired since.
  await made(api, learner("keeper"));
  await ended(api, await started(api, "keeper"));
  const repo = repoOf(data, "keeper");
  const SOURCES = note("Quote sources", "Name the page each figure came from", "Name the page each figure came from.\n", "status: retired\n");
  const SHORT = note("Answer in short tables", "The user wants answers as short tables", "Keep each table to five rows.\n", "supersedes: [answer-in-tables.md]\norigin: you\nstatus: pending\n");
  const CITED = note("Cite every figure", "Link the page each figure came from", "Link each figure's page beside it.\n", "supersedes: [quote-sources.md]\norigin: you\nstatus: pending\n");
  const files = { "answer-in-tables.md": TABLES, "quote-sources.md": SOURCES, "answer-in-short-tables.md": SHORT, "cite-every-figure.md": CITED, "MEMORY.md": "- [Answer in tables](answer-in-tables.md) — The user wants answers as tables\n" };
  for (const [file, text] of Object.entries(files)) writeFileSync(join(repo, file), text);
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "merged and retired"]);
  await resnap(data, "keeper");
  const approve = async (file) => {
    const etag = (await api("GET", `/agents/keeper/learning/files/${file}`)).headers.get("etag");
    const res = await call(port, { method: "POST", path: `/v2/agents/keeper/learning/files/${file}/approve`, headers: { ...json, cookie, origin, "if-match": etag }, body: {} });
    assert.equal(res.status, 200, res.text);
  };
  const changed = () => git(repo, ["diff-tree", "-r", "--name-status", "--no-commit-id", "main"]).split("\n");

  // An active note replaced: superseded by the approved one, out of MEMORY.md, in the approval's own commit.
  const before = git(repo, ["rev-parse", "main"]);
  await approve("answer-in-short-tables.md");
  assert.equal(git(repo, ["rev-parse", "main^"]), before, "one commit");
  assert.equal(git(repo, ["log", "-1", "--format=%s", "main"]), "learning: approved by a person: answer-in-short-tables.md");
  assert.deepEqual(changed(), ["M\tMEMORY.md", "M\tanswer-in-short-tables.md", "M\tanswer-in-tables.md"]);
  assert.equal(git(repo, ["show", "main:answer-in-short-tables.md"]), note("Answer in short tables", "The user wants answers as short tables", "Keep each table to five rows.\n", "supersedes: [answer-in-tables.md]\norigin: you\n").trimEnd());
  assert.equal(git(repo, ["show", "main:answer-in-tables.md"]), note("Answer in tables", "The user wants answers as tables", "Answer every question as a small table.\n", "status: superseded\nsuperseded_by: answer-in-short-tables.md\n").trimEnd());
  assert.equal(git(repo, ["show", "main:MEMORY.md"]), "- [Answer in short tables](answer-in-short-tables.md) — The user wants answers as short tables");
  const [top] = (await api("GET", "/agents/keeper/learning/log")).body.items;
  assert.deepEqual([top.by, top.files.sort()], [{ user: true, via: "console" }, ["MEMORY.md", "answer-in-short-tables.md", "answer-in-tables.md"]]);

  // A replaced note a person retired meanwhile: it stays retired, as it was, and the approval changes only its own note
  // and MEMORY.md.
  const retired = git(repo, ["rev-parse", "main:quote-sources.md"]);
  await approve("cite-every-figure.md");
  assert.deepEqual(changed(), ["M\tMEMORY.md", "M\tcite-every-figure.md"]);
  assert.equal(git(repo, ["rev-parse", "main:quote-sources.md"]), retired, "the retired note is unchanged");
  assert.deepEqual(git(repo, ["show", "main:MEMORY.md"]).split("\n").sort(), ["- [Answer in short tables](answer-in-short-tables.md) — The user wants answers as short tables", "- [Cite every figure](cite-every-figure.md) — Link the page each figure came from"]);
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
      pid = runRecordOf(data, runId).holder?.pid;
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
