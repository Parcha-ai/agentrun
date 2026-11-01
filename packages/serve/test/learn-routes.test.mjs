// A person sees and controls what an agent has learned, through the API: the agent's index, notes, log and counts; a
// run's learning whole and its diff; a note edited (If-Match), created (If-None-Match: *) and retired, each one host
// commit by a person with no grader, the structural checks still applied, and the next run starting from the result.
// A write that names no version is 428, a stale one 412; MEMORY.md is the server's and never written.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { copyOf, ended, git, LEARN, learner, made, objects, repoOf, settled, started } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, follow, serve } from "./support.mjs";

const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const SOURCES = note("Quote sources", "Name the page each figure came from");
const TABLES = note("Prefers tables", "Answer with a table when comparing");
const EDITED = note("Check units", "Convert every amount to the answer's unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const ASK = note("Ask first", "Ask which currency when the question names none");
const line = (file, name, description) => `- [${name}](${file}) — ${description}`;
/** A new file's patch as git writes it, hunks only. */
const added = (text) => {
  const lines = text.split("\n").slice(0, -1);
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((one) => `+${one}\n`).join("")}`;
};
/** The index under `# Learned` in a prompt, or undefined. */
const learnedIn = (prompt) => /\n# Learned\n\n[^\n]*\n\n([\s\S]*?)(?:\n\n|\n<\/instructions>|\n?$)/.exec(prompt)?.[1];

test("a person sees what the agent learned and controls it: the view, the log by run and by person, a run's diff and its drop, an edit, a create and a retire through preconditions, the checks on a person's note, and the next run reading the result", { timeout: 300_000 }, async (t) => {
  const { api, baseUrl, data, token } = await serve(t, { learning: "on", faux: LEARN });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const answer = (path, method = "get", status = "200") => doc.paths[path][method].responses[status].content["application/json"].schema;
  const meets = (path, value, method, status) => assert.deepEqual(schemaProblems(doc, answer(path, method, status), value), [], `${path}: ${JSON.stringify(value)}`);
  /** A text write: a PUT of `text`, or a retire, with the headers given. */
  const write = async (path, text, headers = {}) => {
    const res = await fetch(`${baseUrl}${path}`, { method: text === undefined ? "POST" : "PUT", headers: { authorization: `Bearer ${token}`, ...(text === undefined ? {} : { "content-type": "text/markdown" }), ...headers }, body: text });
    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {}
    return { status: res.status, headers: res.headers, text: body, body: json };
  };
  const id = "keeper";
  const repo = repoOf(data, id);
  const files = `/agents/${id}/learning/files`;
  const blob = (file) => `"${git(repo, ["rev-parse", `main:${file}`])}"`;

  // An agent whose learning was never on has no folder: an empty view; its run has no learning and no diff.
  await made(api, agent("plain"));
  const plain = (await api("GET", "/agents/plain/learning")).body;
  assert.deepEqual(plain, { agent: "plain", main: null, index: "", notes: { items: [], total: 0, next_cursor: null }, log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 } });
  meets("/agents/{agent_id}/learning", plain);
  const plainRun = await started(api, "plain");
  await follow(api, plainRun, ["completed"]);
  const none = await fetch(`${baseUrl}/runs/${plainRun}/learning`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual([none.status, await none.json()], [200, null]);
  assert.equal((await api("GET", `/runs/${plainRun}/learning/diff`)).status, 404);
  assert.equal((await api("GET", "/agents/nobody/learning")).status, 404);

  // Run 1 merges two notes.
  await made(api, learner(id, { instructions: "Say your prompt.", plan: [["check-units.md", UNITS], ["quote-sources.md", SOURCES]], once: true }));
  const one = await started(api, id);
  const first = await ended(api, one);
  settled(first.view, first.rows, "merged");
  const main1 = git(repo, ["rev-parse", "main"]);
  // Run 2 proposes a note the grader drops.
  const two2 = learner(id, { instructions: "Say your prompt.\nGrade: drop.", plan: [["prefers-tables.md", TABLES]], once: true, version: 2 });
  assert.equal((await api("PUT", `/agents/${id}/definition`, two2)).status, 200);
  const two = await started(api, id);
  const second = await ended(api, two);
  settled(second.view, second.rows, "dropped", "grader");
  assert.equal(git(repo, ["rev-parse", "main"]), main1, "the drop moved nothing");

  // The agent's view: main, its index, the notes, the log entry by run 1, and the runs' counts.
  const view = (await api("GET", `/agents/${id}/learning`)).body;
  meets("/agents/{agent_id}/learning", view);
  assert.equal(view.main, main1);
  assert.equal(view.index, `${line("check-units.md", "Check units", "Convert every amount to one unit before comparing")}\n${line("quote-sources.md", "Quote sources", "Name the page each figure came from")}\n`);
  assert.deepEqual(view.notes.items.map((n) => [n.file, n.status, n.type, n.superseded_by]), [["check-units.md", "active", "reference", null], ["quote-sources.md", "active", "reference", null]]);
  assert.deepEqual(view.notes.items[0], { file: "check-units.md", name: "Check units", description: "Convert every amount to one unit before comparing", type: "reference", status: "active", superseded_by: null, text: UNITS });
  assert.deepEqual(view.log, { items: [{ by: { run: one }, commit: main1, at: view.log.items[0].at, reason: "Each note is general and new.", files: ["MEMORY.md", "check-units.md", "quote-sources.md"] }], total: 1, next_cursor: null });
  assert.deepEqual(view.counts, { merged: 1, dropped: { grader: 1 }, in_progress: 0 });

  // Run 1's diff: its merge against its parent, as git writes it, hunks only.
  const diff1 = (await api("GET", `/runs/${one}/learning/diff`)).body;
  meets("/runs/{run_id}/learning/diff", diff1);
  assert.deepEqual([diff1.base, diff1.head], [git(repo, ["rev-parse", `${main1}^`]), main1]);
  assert.deepEqual(diff1.files.map((f) => [f.path, f.status]), [["MEMORY.md", "modified"], ["check-units.md", "added"], ["quote-sources.md", "added"]]);
  assert.equal(diff1.files[1].patch, added(UNITS));
  assert.match(diff1.files[0].patch, /^@@ -0,0 \+1,2 @@\n\+- \[Check units\]/);
  // Run 2: its learning whole shows the drop, and its diff its proposal against its seed.
  const learned2 = (await api("GET", `/runs/${two}/learning`)).body;
  meets("/runs/{run_id}/learning", learned2);
  assert.deepEqual({ ...learned2, at: undefined, detail: undefined, cost_usd: undefined, tokens: undefined }, { run: two, state: "dropped", reason: "grader", detail: undefined, at: undefined, seed: main1, merged: null, verdict: { merge: false, reason: "A note is about the one case it came from." }, problems: [], cost_usd: undefined, tokens: undefined });
  assert.ok(learned2.cost_usd.reflect === null && learned2.cost_usd.grade > 0 && learned2.tokens.grade.input > 0, JSON.stringify(learned2));
  assert.deepEqual((await api("GET", `/runs/${two}/learning/diff`)).body, { base: main1, head: null, files: [{ path: "prefers-tables.md", status: "added", patch: added(TABLES) }] });
  const learned1 = (await api("GET", `/runs/${one}/learning`)).body;
  assert.deepEqual([learned1.state, learned1.merged, learned1.verdict.merge], ["merged", main1, true]);

  // One note as text, with its ETag: its blob id on main.
  const read = await api("GET", `${files}/check-units.md`);
  assert.deepEqual([read.status, read.body, read.headers.get("etag"), read.headers.get("content-type"), read.headers.get("x-content-type-options")], [200, UNITS, blob("check-units.md"), "text/markdown; charset=utf-8", "nosniff"]);
  assert.equal((await api("GET", `${files}/MEMORY.md`)).body, view.index, "the index reads, too");
  assert.equal((await api("GET", `${files}/nothing.md`)).status, 404);

  // A person edits it with the ETag it read: one commit by a person, the index rebuilt, the folder's files main's.
  const etag1 = read.headers.get("etag");
  assert.deepEqual([(await write(`${files}/check-units.md`, EDITED)).status], [428], "no precondition");
  const star = await write(`${files}/check-units.md`, EDITED, { "if-match": "*" });
  assert.deepEqual([star.status, star.body?.error.code], [428, "precondition_required"], "If-Match: * names no version");
  const edited = await write(`${files}/check-units.md`, EDITED, { "if-match": etag1 });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.text, EDITED);
  const etag2 = edited.headers.get("etag");
  assert.ok(etag2 !== etag1 && etag2 === blob("check-units.md"), "a new ETag, the new blob's");
  assert.deepEqual(git(repo, ["log", "-1", "--format=%an%n%s%n%b", "main"]).split("\n").filter(Boolean), ["agentrun-serve", "learning: edited by a person: check-units.md", "Changed-By: user"]);
  assert.ok(git(repo, ["show", "main:MEMORY.md"]).includes(line("check-units.md", "Check units", "Convert every amount to the answer's unit before comparing")));
  assert.equal(readFileSync(join(repo, "check-units.md"), "utf8"), EDITED, "the checked-out file is main's");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  const stale = await write(`${files}/check-units.md`, UNITS, { "if-match": etag1 });
  assert.deepEqual([stale.status, stale.body?.error.code], [412, "precondition_failed"], "a stale ETag");
  assert.equal(blob("check-units.md"), etag2, "and nothing written");

  // A person creates a note: If-None-Match: *, once.
  const created = await write(`${files}/ask-first.md`, ASK, { "if-none-match": "*" });
  assert.deepEqual([created.status, created.text, created.headers.get("location"), created.headers.get("etag")], [201, ASK, `/v2/${files.slice(1)}/ask-first.md`, blob("ask-first.md")]);
  assert.equal((await write(`${files}/ask-first.md`, ASK, { "if-none-match": "*" })).status, 412, "the name is taken");
  assert.equal((await write(`${files}/new-one.md`, ASK, { "if-match": etag2 })).status, 412, "If-Match on a note that is not there");

  // A person retires one: status retired, out of the index, kept in the notes and in history.
  const before = (await api("GET", `${files}/quote-sources.md`)).headers.get("etag");
  assert.equal((await write(`${files}/quote-sources.md/retire`, undefined)).status, 428);
  const retired = await write(`${files}/quote-sources.md/retire`, undefined, { "if-match": before });
  assert.equal(retired.status, 200, retired.text);
  assert.equal(retired.text, SOURCES.replace("type: reference\n", "type: reference\nstatus: retired\n"));
  assert.equal(retired.headers.get("etag"), blob("quote-sources.md"));
  assert.equal((await write(`${files}/quote-sources.md/retire`, undefined, { "if-match": before })).status, 412, "a stale retire");
  const index = git(repo, ["show", "main:MEMORY.md"]);
  assert.equal(index, `${line("ask-first.md", "Ask first", "Ask which currency when the question names none")}\n${line("check-units.md", "Check units", "Convert every amount to the answer's unit before comparing")}`);
  assert.equal(git(repo, ["log", "-1", "--format=%s", "main"]), "learning: retired by a person: quote-sources.md");

  // MEMORY.md is the server's; a name outside the folder's flat notes is refused.
  for (const res of [await write(`${files}/MEMORY.md`, ASK, { "if-match": blob("MEMORY.md") }), await write(`${files}/MEMORY.md/retire`, undefined, { "if-match": blob("MEMORY.md") })]) {
    assert.deepEqual([res.status, res.body.error.code], [400, "bad_request"]);
    assert.match(res.body.error.message, /MEMORY\.md is built by the server/);
  }
  for (const name of ["notes.txt", "%2E%2E%2Fx.md", ".hidden.md", "a%2Fb.md"]) assert.equal((await write(`${files}/${name}`, ASK, { "if-none-match": "*" })).status, 400, name);
  assert.equal((await write(`${files}/a/b.md`, ASK, { "if-none-match": "*" })).status, 404, "a path is no route");

  // The checks still apply to a person's note: one holding a host secret (the server's own token) is 400 with
  // problems that do not hold it, and nothing is committed or written to git.
  const head = git(repo, ["rev-parse", "main"]);
  const leak = await write(`${files}/leak.md`, note("Leak", "The server's token", `It is ${token}.\n`), { "if-none-match": "*" });
  assert.deepEqual([leak.status, leak.body?.error.code, leak.body?.error.problems], [400, "bad_request", [{ rule: "secret_value", path: "leak.md", detail: "it holds a value the host named as secret" }]]);
  assert.ok(!leak.text.includes(token), "the refusal does not hold it");
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Error" }, leak.body), []);
  assert.equal(git(repo, ["rev-parse", "main"]), head, "nothing committed");
  assert.ok(!objects(repo).includes(token), "no git object holds it");
  assert.deepEqual((await write(`${files}/check-units.md`, "no front matter\n", { "if-match": etag2 })).body.error.problems.map((p) => p.rule), ["note"]);
  assert.deepEqual((await write(`${files}/check-units.md`, EDITED.replace("Amounts", "Amo​unts"), { "if-match": etag2 })).body.error.problems.map((p) => p.rule), ["invisible_unicode"]);
  assert.equal(git(repo, ["rev-parse", "main"]), head);

  // The log: every change on main, newest first, by run or by person.
  const view2 = (await api("GET", `/agents/${id}/learning`)).body;
  meets("/agents/{agent_id}/learning", view2);
  assert.deepEqual(view2.log.items.map((c) => [c.by, c.reason, c.files]), [
    [{ user: true }, "retired by a person: quote-sources.md", ["MEMORY.md", "quote-sources.md"]],
    [{ user: true }, "created by a person: ask-first.md", ["MEMORY.md", "ask-first.md"]],
    [{ user: true }, "edited by a person: check-units.md", ["MEMORY.md", "check-units.md"]],
    [{ run: one }, "Each note is general and new.", ["MEMORY.md", "check-units.md", "quote-sources.md"]],
  ]);
  assert.deepEqual(view2.notes.items.map((n) => [n.file, n.status]), [["ask-first.md", "active"], ["check-units.md", "active"], ["quote-sources.md", "retired"]], "active first, then newest first");
  assert.equal(view2.index, `${index}\n`);

  // The next run reads the edit and the new note, and not the retired one.
  const three = await started(api, id);
  const third = await ended(api, three);
  assert.equal(learnedIn(third.view.result.final_answer), index, third.view.result.final_answer);
  assert.ok(existsSync(join(copyOf(data, three), "ask-first.md")) && !existsSync(join(copyOf(data, three), "quote-sources.md")), "the retired note is not in its .learning/");
  assert.equal(readFileSync(join(copyOf(data, three), "check-units.md"), "utf8"), EDITED);

  // Pages: opaque cursors, each read at the commit the first page was, so a write between pages moves nothing.
  const page1 = (await api("GET", `/agents/${id}/learning/notes?limit=1`)).body;
  meets("/agents/{agent_id}/learning/notes", page1);
  assert.deepEqual([page1.items.map((n) => n.file), page1.total], [["ask-first.md"], 3]);
  assert.equal((await write(`${files}/zz-later.md`, note("Later", "Written between pages"), { "if-none-match": "*" })).status, 201);
  const page2 = (await api("GET", `/agents/${id}/learning/notes?limit=1&cursor=${page1.next_cursor}`)).body;
  const page3 = (await api("GET", `/agents/${id}/learning/notes?limit=1&cursor=${page2.next_cursor}`)).body;
  assert.deepEqual([page2.items.map((n) => n.file), page3.items.map((n) => n.file), page3.next_cursor, page3.total], [["check-units.md"], ["quote-sources.md"], null, 3]);
  assert.deepEqual((await api("GET", `/agents/${id}/learning/notes?status=retired`)).body.items.map((n) => n.file), ["quote-sources.md"]);
  const log1 = (await api("GET", `/agents/${id}/learning/log?limit=3`)).body;
  meets("/agents/{agent_id}/learning/log", log1);
  const log2 = (await api("GET", `/agents/${id}/learning/log?limit=3&cursor=${log1.next_cursor}`)).body;
  assert.deepEqual([log1.total, log1.items.length, log2.items.map((c) => c.by), log2.next_cursor], [5, 3, [{ user: true }, { run: one }], null]);
  for (const query of ["limit=0", "limit=201", "limit=x", "cursor=bm9wZQ", "status=bogus"]) assert.equal((await api("GET", `/agents/${id}/learning/notes?${query}`)).status, 400, query);
  assert.deepEqual((await api("GET", `/agents/${id}/learning`)).body.counts, { merged: 1, dropped: { grader: 2 }, in_progress: 0 });

  // An archived agent's learning reads, its runs still counted, and takes a person's write, as its definition does.
  assert.equal((await api("POST", `/agents/${id}/archive`)).status, 200);
  assert.deepEqual((await api("GET", `/agents/${id}/learning`)).body.counts, { merged: 1, dropped: { grader: 2 }, in_progress: 0 });
  assert.equal((await write(`${files}/zz-later.md`, note("Later", "Written while archived"), { "if-match": blob("zz-later.md") })).status, 200);
});
