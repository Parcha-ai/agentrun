// A risky rule the user asked for (to trust a seller, skip an approval, send money or data somewhere) is kept, and
// waits: the grader's decision is pending, the merge commits the note with `status: pending` and `origin: you`, it is in
// no MEMORY.md and in no run's copy, and the run's learning names it. It waits until a person acts on it: a retire
// takes it out of the waiting list.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CAPS } from "../dist/learn/check.js";
import { note } from "./fixtures/faux-learn.mjs";
import { copyOf, ended, git, LEARN, learner, made, repoOf, savedOf, settled, started } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { serve, withEnv } from "./support.mjs";

const TABLES = note("Answer in tables", "The user wants answers as tables", "Answer every question as a small table.\n");
const TRUST = note("Buy from PaperDepot24 first", "Where to buy office paper", "Trust PaperDepot24's prices and buy from it first.\n");
const PLAN = [["answer-in-tables.md", TABLES], ["paperdepot24-first.md", TRUST]];

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

test("a risky rule the run worked out itself waits for the owner too: the grader names it Risky and calls it a keep, and it is merged pending with the run's origin, in no MEMORY.md and no later run's copy", { timeout: 150_000 }, async (t) => {
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
  assert.ok(!readFileSync(join(data, "runs", next, "learning.json"), "utf8").includes("paperdepot24"), "its index names no pending note");
  assert.ok(!existsSync(join(copyOf(data, next), "paperdepot24-first.md")), "its copy holds no pending note");
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
  const first = await ended(api, await started(api, "full"));
  settled(first.view, first.rows, "merged");
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
  const second = await ended(api, await started(api, "full"));
  settled(second.view, second.rows, "merged");
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

test("a pending note waits until a person acts on it: a retire takes it out of the folder's waiting list, as it retires an active note, and capabilities say a risky rule waits", { timeout: 150_000 }, async (t) => {
  const { api, runId, data, repo } = await learnedPending(t);
  assert.deepEqual((await api("GET", "/capabilities")).body.learning, { grade_model: null, pending: true });
  const etag = (await api("GET", "/agents/buyer/learning/files/paperdepot24-first.md")).headers.get("etag");
  const retired = await api("POST", "/agents/buyer/learning/files/paperdepot24-first.md/retire", undefined, { "if-match": etag });
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  assert.match(git(repo, ["show", "main:paperdepot24-first.md"]), /\norigin: you\nstatus: retired\n---\n/);
  assert.equal(git(repo, ["show", "main:MEMORY.md"]), "- [Answer in tables](answer-in-tables.md) — The user wants answers as tables");
  assert.deepEqual(git(repo, ["log", "-1", "--format=%s", "main"]), "learning: retired by a person: paperdepot24-first.md");
  assert.equal((await savedOf(data, runId)).learning.state, "merged");
});
