// A risky rule the user asked for (to trust a seller, skip an approval, send money or data somewhere) is kept, and
// waits: the grader's decision is pending, the merge commits the note with `status: pending` and `origin: you`, it is in
// no MEMORY.md and in no run's copy, and the run's learning names it. It waits until a person acts on it: a retire
// takes it out of the waiting list.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
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
