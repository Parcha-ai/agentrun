// A person sees and controls what an agent has learned, through the API: the agent's index, notes, log and counts; a
// run's learning whole and its diff; a note edited (If-Match), created (If-None-Match: *) and retired, each one host
// commit by a person with no grader, the structural checks still applied, and the next run starting from the result.
// A write that names no version is 428, a stale one 412; MEMORY.md is the server's and never written.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, LEARN, learner, made, objects, repoOf, savedOf, settled, started, turnCopyOf } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { learningTestHooks } from "../dist/learning.js";
import { agent, call, follow, scratch, serve, withEnv } from "./support.mjs";

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
  assert.deepEqual(plain, { agent: "plain", main: null, index: "", notes: { items: [], total: 0, next_cursor: null }, log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 }, impact: null });
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
  assert.deepEqual(view.notes.items[0], { file: "check-units.md", name: "Check units", description: "Convert every amount to one unit before comparing", type: "reference", status: "active", superseded_by: null, text: UNITS, etag: `"${git(repoOf(data, id), ["rev-parse", "main:check-units.md"])}"` });
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
  assert.deepEqual({ ...learned2, at: undefined, detail: undefined, cost_usd: undefined, tokens: undefined }, { run: two, state: "dropped", reason: "grader", detail: undefined, at: undefined, seed: main1, merged: null, verdict: { merge: false, reason: "A note is about the one case it came from.", items: [{ file: "prefers-tables.md", keep: false, question: "General", why: "It is about one case." }] }, problems: [], cost_usd: undefined, tokens: undefined });
  assert.ok(Object.keys(learned2.cost_usd).join() === "grade" && learned2.cost_usd.grade > 0 && learned2.tokens.grade.input > 0, JSON.stringify(learned2));
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
  assert.deepEqual((await write(`${files}/check-units.md`, EDITED.replace("Amounts", "Amo\u200bunts"), { "if-match": etag2 })).body.error.problems.map((p) => p.rule), ["invisible_unicode"]);
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
  // Its copy, as the run settled: set aside from its work, as its end-of-run turn left it.
  assert.ok(existsSync(join(turnCopyOf(data, three), "ask-first.md")) && !existsSync(join(turnCopyOf(data, three), "quote-sources.md")), "the retired note is not in its .learning/");
  assert.equal(readFileSync(join(turnCopyOf(data, three), "check-units.md"), "utf8"), EDITED);

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
  // The counts leave archived runs out, as GET /stats does: an archived drop is no longer counted, and the two agree.
  const counted = async () => [(await api("GET", `/agents/${id}/learning`)).body.counts, (({ runs: _, ...rest }) => rest)((await api("GET", `/stats?agent=${id}`)).body.learning)];
  assert.deepEqual(await counted(), [{ merged: 1, dropped: { grader: 2 }, in_progress: 0 }, { merged: 1, dropped: { grader: 2 }, in_progress: 0 }]);
  assert.equal((await api("POST", `/runs/${two}/archive`)).status, 200);
  assert.deepEqual(await counted(), [{ merged: 1, dropped: { grader: 1 }, in_progress: 0 }, { merged: 1, dropped: { grader: 1 }, in_progress: 0 }]);

  // An archived agent's learning reads, counted as GET /stats counts it, and takes a person's write, as its definition does.
  assert.equal((await api("POST", `/agents/${id}/archive`)).status, 200);
  const [mine, stats] = await counted();
  assert.deepEqual(mine, stats);
  assert.equal((await write(`${files}/zz-later.md`, note("Later", "Written while archived"), { "if-match": blob("zz-later.md") })).status, 200);
});

test("the console's page writes a note under its session as JSON {text} from its own origin: an edit and a create land as a Bearer text write does; text under the cookie alone is refused and changes nothing; a JSON body out of shape is refused by field", { timeout: 60_000 }, async (t) => {
  const { api, data, port, token } = await serve(t);
  await made(api, learner("paged"));
  const repo = repoOf(data, "paged");
  const files = "/v2/agents/paged/learning/files";
  const cookie = (await call(port, { path: `/?token=${token}` })).headers["set-cookie"][0].split(";")[0];
  const origin = `http://127.0.0.1:${port}`;
  const page = (method, path, body, headers = {}) => call(port, { method, path, headers: { cookie, origin, "content-type": "application/json", ...headers }, body });
  const head = () => git(repo, ["rev-parse", "main"]);

  // A create, then an edit, as the page sends them: one commit each by a person, answered as text with the new ETag.
  const created = await page("PUT", `${files}/from-page.md`, { text: ASK }, { "if-none-match": "*" });
  assert.deepEqual([created.status, created.text, created.headers["content-type"]], [201, ASK, "text/markdown; charset=utf-8"]);
  assert.equal(created.headers.etag, `"${git(repo, ["rev-parse", "main:from-page.md"])}"`);
  const edited = await page("PUT", `${files}/from-page.md`, { text: EDITED }, { "if-match": created.headers.etag });
  assert.deepEqual([edited.status, edited.text], [200, EDITED]);
  assert.ok(edited.headers.etag !== created.headers.etag && edited.headers.etag === `"${git(repo, ["rev-parse", "main:from-page.md"])}"`);
  assert.deepEqual(git(repo, ["log", "-2", "--format=%s %(trailers:key=Changed-By,valueonly)", "main"]).split("\n").filter(Boolean), ["learning: edited by a person: from-page.md user", "learning: created by a person: from-page.md user"]);
  assert.equal((await page("PUT", `${files}/from-page.md`, { text: ASK }, { "if-match": created.headers.etag })).status, 412, "the same precondition");
  assert.equal((await page("PUT", `${files}/from-page.md`, { text: ASK })).status, 428);

  // Text under the cookie alone is no credential (the page's write rule), and changes nothing; with the Bearer it lands.
  const before = head();
  for (const type of ["text/plain", "text/markdown"]) {
    const sent = await call(port, { method: "PUT", path: `${files}/from-page.md`, headers: { cookie, origin, "content-type": type, "if-match": edited.headers.etag }, body: ASK });
    assert.equal(sent.status, 401, type);
  }
  assert.equal(head(), before, "nothing written");
  const scripted = await call(port, { method: "PUT", path: `${files}/from-page.md`, headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown", "if-match": edited.headers.etag }, body: ASK });
  assert.deepEqual([scripted.status, scripted.text], [200, ASK]);

  // A JSON body out of shape: not an object is 400; a missing or wrong text, or another field, 422 by field.
  const etag = scripted.headers.etag;
  for (const [body, status, fields] of [["not json", 400, undefined], [JSON.stringify(["text"]), 400, undefined], [{}, 422, ["text"]], [{ text: 7 }, 422, ["text"]], [{ text: ASK, note: "x" }, 422, ["note"]], [{ text: "\ud800" }, 422, ["text"]]]) {
    const res = await page("PUT", `${files}/from-page.md`, body, { "if-match": etag });
    assert.deepEqual([res.status, res.json?.error.fields?.map((f) => f.field)], [status, fields], JSON.stringify(body));
  }
  assert.equal(head(), git(repo, ["rev-parse", "main"]));
  assert.equal(`"${git(repo, ["rev-parse", "main:from-page.md"])}"`, etag, "nothing written");
  // The page's retire is JSON too.
  const retired = await page("POST", `${files}/from-page.md/retire`, {}, { "if-match": etag });
  assert.deepEqual([retired.status, git(repo, ["show", "main:MEMORY.md"])], [200, ""]);
});

test("a link planted at the agent's learning folder makes a person's edit, create and retire an error, and its reads too: the host never follows it, writes nothing where it points and answers none of it", { timeout: 60_000 }, async (t) => {
  const { api, data, port, token } = await serve(t);
  await made(api, learner("linked"));
  const repo = repoOf(data, "linked");
  const files = "/v2/agents/linked/learning/files";
  const headers = (more) => ({ authorization: `Bearer ${token}`, ...more });
  const put = (file, text, more) => call(port, { method: "PUT", path: `${files}/${file}`, headers: headers({ "content-type": "text/markdown", ...more }), body: text });
  const retire = (file, more) => call(port, { method: "POST", path: `${files}/${file}/retire`, headers: headers(more) });

  // The folder, made by a person's create, moved out of the data directory with a link to it left in its place.
  const created = await put("check-units.md", UNITS, { "if-none-match": "*" });
  assert.equal(created.status, 201);
  const outside = join(await scratch(t), "learning");
  renameSync(repo, outside);
  symlinkSync(outside, repo);
  const state = () => ({
    main: git(outside, ["rev-parse", "main"]),
    objects: objects(outside),
    files: Object.fromEntries(readdirSync(outside).filter((file) => file !== ".git").sort().map((file) => [file, readFileSync(join(outside, file), "utf8")])),
    git: readdirSync(join(outside, ".git")).sort(),
  });
  const before = state();
  assert.deepEqual(Object.keys(before.files), ["MEMORY.md", "check-units.md"]);

  for (const [what, send] of [
    ["an edit", () => put("check-units.md", EDITED, { "if-match": created.headers.etag })],
    ["a create", () => put("ask-first.md", ASK, { "if-none-match": "*" })],
    ["a retire", () => retire("check-units.md", { "if-match": created.headers.etag })],
  ]) {
    const res = await send();
    assert.deepEqual([res.status, res.json?.error?.code], [500, "internal"], what);
    assert.match(res.json.error.message, /symbolic link/, what);
    assert.ok(!res.text.includes(outside), `${what}: the answer never names where the link points`);
  }
  // The reads check the same levels, making nothing: the view, its pages and a file answer the same error, holding none
  // of what the folder the link points at holds.
  for (const path of ["/v2/agents/linked/learning", "/v2/agents/linked/learning/notes", "/v2/agents/linked/learning/log", `${files}/check-units.md`]) {
    const res = await call(port, { path, headers: headers() });
    assert.deepEqual([res.status, res.json?.error?.code], [500, "internal"], path);
    assert.match(res.json.error.message, /symbolic link/, path);
    for (const held of [outside, before.main, "Convert every amount"]) assert.ok(!res.text.includes(held), `${path}: the answer holds ${held}`);
  }
  assert.ok(lstatSync(repo).isSymbolicLink(), "the link is left where it was");
  assert.deepEqual(state(), before, "nothing written where the link points: main, its objects, its files and its .git as they were");
});

test("a restarted server counts an agent's runs that tried to learn from the learning ledger, as GET /stats does: its view's counts read with runs/ unreadable", { timeout: 180_000 }, async (t) => {
  const first = await serve(t, { learning: "on", faux: LEARN });
  const { data } = first;
  await made(first.api, learner("counted", { plan: [["check-units.md", UNITS]], once: true }));
  const merged = await ended(first.api, await started(first.api, "counted"));
  settled(merged.view, merged.rows, "merged");
  // The second run's index names the note: it plans nothing, and its learning is dropped as empty.
  const empty = await ended(first.api, await started(first.api, "counted"));
  settled(empty.view, empty.rows, "dropped", "empty");
  assert.equal((await first.api("GET", `/runs/${empty.view.run_id}/learning`)).body.verdict, null, "no grade ran, so no verdict");
  for (const { view } of [merged, empty]) await savedOf(data, view.run_id);
  const want = { merged: 1, dropped: { empty: 1 }, in_progress: 0 };
  assert.deepEqual((await first.api("GET", "/agents/counted/learning")).body.counts, want);
  await first.close();
  // The restarted server holds neither run: both are counted from the ledger, and no run's files are opened.
  const again = await serve(t, { learning: "on", faux: LEARN, data });
  const runs = join(data, "runs");
  chmodSync(runs, 0o000);
  try {
    assert.deepEqual((await again.api("GET", "/agents/counted/learning")).body.counts, want, "read back from the ledger");
    assert.deepEqual((await again.api("GET", "/stats?agent=counted")).body.learning, { runs: 2, ...want });
  } finally {
    chmodSync(runs, 0o700);
  }
});

test("each note in the view and in its pages carries its ETag, the one its file's GET answers: a retire or an edit by it changes exactly the version shown, and a card shown before a change is 412", { timeout: 60_000 }, async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  await made(api, agent("carded"));
  const files = "/agents/carded/learning/files";
  for (const [file, text] of [["check-units.md", UNITS], ["quote-sources.md", SOURCES]]) assert.equal((await api("PUT", `${files}/${file}`, { text }, { "if-none-match": "*" })).status, 201);
  const etags = async () => Object.fromEntries(await Promise.all(["check-units.md", "quote-sources.md"].map(async (file) => [file, (await api("GET", `${files}/${file}`)).headers.get("etag")])));
  const cards = (items) => Object.fromEntries(items.map((item) => [item.file, item.etag]));
  const view = (await api("GET", "/agents/carded/learning")).body;
  const read = await etags();
  assert.match(read["check-units.md"], /^"[0-9a-f]{40,64}"$/);
  assert.deepEqual(cards(view.notes.items), read, "the view's cards");
  const page = (await api("GET", "/agents/carded/learning/notes?limit=1")).body;
  const next = (await api("GET", `/agents/carded/learning/notes?limit=1&cursor=${page.next_cursor}`)).body;
  assert.deepEqual(cards([...page.items, ...next.items]), read, "and the pages'");
  for (const body of [view, page]) assert.deepEqual(schemaProblems(doc, doc.paths["/agents/{agent_id}/learning"].get.responses["200"].content["application/json"].schema.properties.notes, body.notes ?? body), []);

  // An edit by the card's ETag lands, and the card the view now shows carries the new one.
  const edited = await api("PUT", `${files}/check-units.md`, { text: EDITED }, { "if-match": view.notes.items.find((item) => item.file === "check-units.md").etag });
  assert.equal(edited.status, 200);
  const after = cards((await api("GET", "/agents/carded/learning")).body.notes.items);
  assert.equal(after["check-units.md"], edited.headers.get("etag"));
  // The card shown before the edit is stale: a retire by it is 412, and nothing changes.
  assert.equal((await api("POST", `${files}/check-units.md/retire`, undefined, { "if-match": view.notes.items.find((item) => item.file === "check-units.md").etag })).status, 412);
  // A retire by the card's ETag lands.
  assert.equal((await api("POST", `${files}/quote-sources.md/retire`, undefined, { "if-match": after["quote-sources.md"] })).status, 200);
  assert.deepEqual((await api("GET", "/agents/carded/learning")).body.notes.items.map((item) => [item.file, item.status]), [["check-units.md", "active"], ["quote-sources.md", "retired"]]);
});

test("a commit's notes are read once: a later page and the view at the same main read no note again, and a log page reads only its own commits", { timeout: 60_000 }, async (t) => {
  const { api, port, token } = await serve(t);
  await made(api, learner("paged"));
  const files = "/v2/agents/paged/learning/files";
  for (const [file, text] of [["a-one.md", note("One", "The first")], ["b-two.md", note("Two", "The second")], ["c-three.md", note("Three", "The third")]]) {
    const res = await call(port, { method: "PUT", path: `${files}/${file}`, headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown", "if-none-match": "*" }, body: text });
    assert.equal(res.status, 201, file);
  }
  const calls = [];
  learningTestHooks.git = (args) => calls.push(args);
  t.after(() => void (learningTestHooks.git = undefined));
  /** The git calls since the last look that read history, a tree or a note, each with its page bounds, if any. */
  const reads = () => calls.splice(0).filter(([command, ...rest]) => ["log", "rev-list", "ls-tree"].includes(command) || (command === "cat-file" && rest.includes("--batch"))).map((args) => [args[0], ...args.filter((arg) => /^--(skip|max-count)=/.test(arg))]);

  // The first page at main reads its notes; the next, at the same commit, reads none of them again.
  const page1 = (await api("GET", "/agents/paged/learning/notes?limit=1")).body;
  assert.deepEqual([page1.items.map((n) => n.file), page1.total], [["c-three.md"], 3]);
  assert.ok(reads().some(([command]) => command === "cat-file"), "the first page reads the notes");
  const page2 = (await api("GET", `/agents/paged/learning/notes?limit=1&cursor=${page1.next_cursor}`)).body;
  assert.deepEqual(page2.items.map((n) => n.file), ["b-two.md"]);
  assert.deepEqual(reads(), [], "a later page at the same commit reads no note, tree or history");

  // The log reads its page's commits alone (skip and max-count), counting them once a commit.
  const log1 = (await api("GET", "/agents/paged/learning/log?limit=1")).body;
  assert.deepEqual([log1.items.map((c) => c.reason), log1.total], [["created by a person: c-three.md"], 3]);
  assert.deepEqual(reads().sort(), [["log", "--skip=0", "--max-count=1"], ["rev-list"]]);
  const log2 = (await api("GET", `/agents/paged/learning/log?limit=1&cursor=${log1.next_cursor}`)).body;
  assert.deepEqual([log2.items.map((c) => c.reason), log2.total], [["created by a person: b-two.md"], 3]);
  assert.deepEqual(reads(), [["log", "--skip=1", "--max-count=1"]]);

  // The view at the same main: its notes as kept, its log's first page read.
  const view = (await api("GET", "/agents/paged/learning")).body;
  assert.deepEqual([view.notes.items.map((n) => n.file), view.log.items.length], [["c-three.md", "b-two.md", "a-one.md"], 3]);
  assert.deepEqual(reads(), [["log", "--skip=0", "--max-count=20"]]);
});

test("a note's name that holds a value made secret after it was written is never shown: the view, the notes, the log, the run's diff and the notes a run learned and used read it [redacted], its route answers the real name only to a caller who knows it, and a retire by it takes it out of the index", { timeout: 240_000 }, async (t) => {
  // Built at the run: a value no file of this repository holds, made a launcher's secret only once its note is on main.
  const value = ["s3cret", "store", "pass", process.pid, Date.now().toString(36)].join("-");
  const named = `${value}.md`;
  const OLD = note("Old plan", "Plan the answer before writing it");
  const NEW = note("Plan", "Plan the answer, then check it", "Plan the answer, then check it.\n", "supersedes: [old-plan.md]\n");
  withEnv(t, {}, ["AGENT_MODEL_API_KEY"]);
  const first = await serve(t, { learning: "on", faux: LEARN });
  const { data } = first;
  await made(first.api, learner("namer", { plan: [["old-plan.md", OLD]], once: true }));
  const one = await ended(first.api, await started(first.api, "namer"));
  settled(one.view, one.rows, "merged");
  assert.equal((await first.api("PUT", "/agents/namer/definition", learner("namer", { plan: [[named, NEW]], once: true, version: 2 }))).status, 200);
  const two = await ended(first.api, await started(first.api, "namer"));
  settled(two.view, two.rows, "merged");
  const before = (await first.api("GET", "/agents/namer/learning")).body;
  assert.deepEqual(before.notes.items.map((n) => [n.file, n.status, n.superseded_by]), [[named, "active", null], ["old-plan.md", "superseded", named]], "shown as it is while no secret");
  assert.deepEqual(two.view.learning.learned, [{ file: named, name: "Plan", supersedes: ["old-plan.md"] }], "shown as it is while no secret");
  // A third run reads the note by that name.
  assert.equal((await first.api("PUT", "/agents/namer/definition", learner("namer", { tools: ["write", "read"], instructions: `Answer the question.\nRead: ${JSON.stringify([`.learning/${named}`])}`, version: 3 }))).status, 200);
  const three = await ended(first.api, await started(first.api, "namer"));
  assert.deepEqual(three.view.learning.used, [{ file: named, name: "Plan" }], "shown as it is while no secret");
  await first.close();

  // The server again, with the name's value as a launcher's secret (the model key).
  process.env.AGENT_MODEL_API_KEY = value;
  const { api } = await serve(t, { learning: "on", faux: LEARN, data });
  const view = (await api("GET", "/agents/namer/learning")).body;
  assert.deepEqual(view.notes.items.map((n) => [n.file, n.status, n.superseded_by]), [["[redacted]", "active", null], ["old-plan.md", "superseded", "[redacted]"]]);
  assert.deepEqual(view.log.items.map((c) => c.files), [["MEMORY.md", "old-plan.md", "[redacted]"], ["MEMORY.md", "old-plan.md"]]);
  const page1 = (await api("GET", "/agents/namer/learning/notes?limit=1")).body;
  const page2 = (await api("GET", `/agents/namer/learning/notes?limit=1&cursor=${page1.next_cursor}`)).body;
  assert.deepEqual([...page1.items, ...page2.items].map((n) => [n.file, n.superseded_by]), [["[redacted]", null], ["old-plan.md", "[redacted]"]]);
  const log = (await api("GET", "/agents/namer/learning/log?limit=1")).body;
  assert.deepEqual(log.items[0].files, ["MEMORY.md", "old-plan.md", "[redacted]"]);
  const diff = (await api("GET", `/runs/${two.view.run_id}/learning/diff`)).body;
  assert.deepEqual(diff.files.map((f) => [f.path, f.status, f.withheld ?? null]), [["MEMORY.md", "modified", "secret"], ["old-plan.md", "modified", "secret"], ["[redacted]", "added", null]]);
  // The route answers the real name to a caller who knows it, and its text is cut as any text is.
  const own = await api("GET", `/agents/namer/learning/files/${named}`);
  assert.deepEqual([own.status, own.body], [200, NEW]);
  const old = await api("GET", "/agents/namer/learning/files/old-plan.md");
  assert.equal(old.status, 200);
  // A retire by that name revokes the note, whatever its name holds: out of the index, its answer and the log cut of it.
  const retire = await api("POST", `/agents/namer/learning/files/${named}/retire`, undefined, { "if-match": own.headers.get("etag") });
  assert.deepEqual([retire.status, retire.body], [200, NEW.replace("supersedes: [old-plan.md]\n", "supersedes: [old-plan.md]\nstatus: retired\n")]);
  assert.equal(git(repoOf(data, "namer"), ["show", "main:MEMORY.md"]), "", "no active note is left in the index");
  const after = (await api("GET", "/agents/namer/learning")).body;
  assert.deepEqual([after.index, after.log.items[0].by, after.log.items[0].reason, after.log.items[0].files], ["", { user: true }, "retired by a person: [redacted].md", ["MEMORY.md", "[redacted]"]]);
  assert.deepEqual(after.notes.items.map((n) => [n.file, n.status]), [["[redacted]", "retired"], ["old-plan.md", "superseded"]]);
  const learned = (await api("GET", `/runs/${two.view.run_id}/learning`)).body;
  assert.deepEqual(learned.verdict.items, [{ file: "[redacted]", keep: true, why: "It holds as a general rule." }], "the grader's item names the note [redacted]");
  // What run two learned and run three used, on each run's view and in the list, name the note [redacted].
  const runTwo = (await api("GET", `/runs/${two.view.run_id}`)).body.learning;
  const runThree = (await api("GET", `/runs/${three.view.run_id}`)).body.learning;
  const listed = (await api("GET", "/agents/namer/runs")).body.runs;
  assert.deepEqual([runTwo.learned, runThree.used], [[{ file: "[redacted]", name: "Plan", supersedes: ["old-plan.md"] }], [{ file: "[redacted]", name: "Plan" }]]);
  const inList = (runId) => listed.find((run) => run.run_id === runId).learning;
  assert.deepEqual([inList(two.view.run_id).learned, inList(three.view.run_id).used], [runTwo.learned, runThree.used], "and in the list");
  const shown = JSON.stringify([view, page1, page2, log, diff, learned, old.body, [...old.headers], [...own.headers], retire.body, [...retire.headers], after, runTwo, runThree, listed]);
  assert.ok(!shown.includes(value), "the value is nowhere a person reads");
});

test("a key a person saves on the server is cut like the server's own secrets, from the next read on: notes a run and a host commit put on main holding it read [redacted] in the view, the notes, the file, the log and the run's diff and learning, and a person's note holding it is refused", { timeout: 240_000 }, async (t) => {
  // Built at the run: a value no file of this repository holds, saved as a tool key only once notes holding it are on main.
  const value = ["saved", "store", "pass", process.pid, Date.now().toString(36)].join("-");
  const named = `${value}.md`;
  const KEPT = note("Saved", "Where the store's pass is kept", `The store's pass is ${value}.\n`);
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "TYPESAFE_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("saver", { plan: [[named, KEPT]], once: true }));
  const run = await ended(api, await started(api, "saver"));
  settled(run.view, run.rows, "merged");
  // A host commit too: a note whose text holds the value.
  const repo = repoOf(data, "saver");
  writeFileSync(join(repo, "host.md"), note("Host", "What the host wrote", `The pass is ${value}.\n`));
  git(repo, ["add", "host.md"]);
  git(repo, ["commit", "-q", "-m", "a host's hand"]);
  assert.ok(JSON.stringify((await api("GET", "/agents/saver/learning")).body).includes(value), "shown as it is while no secret");

  // Saved through the settings API, the server running on: each read after it cuts the value.
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: value } })).status, 204);
  const view = (await api("GET", "/agents/saver/learning")).body;
  assert.deepEqual(view.notes.items.map((n) => n.file).sort(), ["[redacted]", "host.md"]);
  assert.ok(view.notes.items.every((n) => n.text.includes("[redacted]")), JSON.stringify(view.notes.items));
  const notes = (await api("GET", "/agents/saver/learning/notes?limit=1")).body;
  const log = (await api("GET", "/agents/saver/learning/log")).body;
  assert.deepEqual(log.items.map((c) => c.files), [["MEMORY.md", "[redacted]"]]);
  const own = await api("GET", `/agents/saver/learning/files/${named}`);
  const host = await api("GET", "/agents/saver/learning/files/host.md");
  assert.deepEqual([own.status, own.body, host.status, host.body], [200, KEPT.replace(value, "[redacted]"), 200, note("Host", "What the host wrote", "The pass is [redacted].\n")]);
  const index = await api("GET", "/agents/saver/learning/files/MEMORY.md");
  const diff = (await api("GET", `/runs/${run.view.run_id}/learning/diff`)).body;
  assert.deepEqual(diff.files.map((f) => f.path).sort(), ["MEMORY.md", "[redacted]"]);
  const learned = (await api("GET", `/runs/${run.view.run_id}/learning`)).body;
  assert.deepEqual(learned.verdict.items.map((item) => item.file), ["[redacted]"]);
  const shown = JSON.stringify([view, notes, log, own.body, [...own.headers], host.body, index.body, diff, learned]);
  assert.ok(!shown.includes(value), "the value is nowhere a person reads");
  // A person's note holding the saved value is refused, as one holding the server's own secrets is, and nothing is written.
  const main = git(repo, ["rev-parse", "main"]);
  const refused = await api("PUT", "/agents/saver/learning/files/leak.md", { text: note("Leak", "A leak", `It is ${value}.\n`) }, { "if-none-match": "*" });
  assert.deepEqual([refused.status, refused.body?.error?.problems?.map((p) => p.rule)], [400, ["secret_value"]], JSON.stringify(refused.body));
  assert.ok(!JSON.stringify(refused.body).includes(value), "the refusal holds no value");
  assert.equal(git(repo, ["rev-parse", "main"]), main, "nothing committed");
});

test("a retire is always the way out: a note at the 4 KB cap retires, and so does one whose text holds a value made secret after it was written, its answers and the log cut of it; only a note out of format is refused", { timeout: 120_000 }, async (t) => {
  // Built at the run: a value no file of this repository holds, made a launcher's secret only once its note is on main.
  const value = ["vault", "code", process.pid, Date.now().toString(36)].join("-");
  withEnv(t, {}, ["AGENT_MODEL_API_KEY"]);
  const first = await serve(t);
  const { data } = first;
  await made(first.api, learner("revoker"));
  const repo = repoOf(data, "revoker");
  const files = "/agents/revoker/learning/files";
  const head = note("Full", "A note at the cap", "");
  const full = `${head}${"x".repeat(4095 - Buffer.byteLength(head))}\n`;
  assert.equal(Buffer.byteLength(full), 4096);
  const VAULT = note("Vault", "Where the vault code is", `The vault code is ${value}.\n`);
  for (const [file, text] of [["full.md", full], ["vault.md", VAULT]]) assert.equal((await first.api("PUT", `${files}/${file}`, { text }, { "if-none-match": "*" })).status, 201, file);
  // Out of format, by an operator's hand on main: a note over the cap, and a file with no front matter.
  writeFileSync(join(repo, "huge.md"), note("Huge", "Over the cap", `${"y".repeat(5000)}\n`));
  writeFileSync(join(repo, "bare.md"), "no front matter\n");
  git(repo, ["add", "huge.md", "bare.md"]);
  git(repo, ["commit", "-q", "-m", "an operator's hand"]);
  await first.close();

  // The server again, with the vault code as a launcher's secret (the model key).
  process.env.AGENT_MODEL_API_KEY = value;
  const { api } = await serve(t, { data });
  const etag = async (file) => (await api("GET", `${files}/${file}`)).headers.get("etag");
  // The note at the cap retires, its status line on top of the cap.
  const capped = await api("POST", `${files}/full.md/retire`, undefined, { "if-match": await etag("full.md") });
  assert.deepEqual([capped.status, Buffer.byteLength(capped.body)], [200, 4112], JSON.stringify(capped.body).slice(0, 200));
  // The note holding the value made secret retires: out of the index, its answer and the log cut of the value.
  const vault = await api("POST", `${files}/vault.md/retire`, undefined, { "if-match": await etag("vault.md") });
  assert.equal(vault.status, 200, JSON.stringify(vault.body));
  assert.ok(vault.body.includes("status: retired\n") && vault.body.includes("The vault code is [redacted]."), vault.body);
  const index = git(repo, ["show", "main:MEMORY.md"]);
  assert.ok(!index.includes("vault.md") && !index.includes("full.md"), index);
  const view = (await api("GET", "/agents/revoker/learning")).body;
  assert.deepEqual(view.log.items.map((c) => [c.by, c.reason, c.files]).slice(0, 2), [[{ user: true }, "retired by a person: vault.md", ["MEMORY.md", "vault.md"]], [{ user: true }, "retired by a person: full.md", ["MEMORY.md", "full.md"]]]);
  assert.ok(!JSON.stringify([vault.body, [...vault.headers], view]).includes(value), "the value is nowhere a person reads");
  // Out of format is still refused, and nothing is committed.
  const main = git(repo, ["rev-parse", "main"]);
  const huge = await api("POST", `${files}/huge.md/retire`, undefined, { "if-match": await etag("huge.md") });
  assert.deepEqual([huge.status, huge.body?.error?.problems?.map((p) => p.rule)], [400, ["too_large"]]);
  const bare = await api("POST", `${files}/bare.md/retire`, undefined, { "if-match": await etag("bare.md") });
  assert.deepEqual([bare.status, bare.body?.error?.problems?.map((p) => p.rule)], [400, ["note"]]);
  assert.equal(git(repo, ["rev-parse", "main"]), main, "nothing committed");
});

test("an edit of a note whose text holds a value made secret after it was written is refused, whatever the ETag: its read shows [redacted], so saving it would write [redacted] over the hidden text; main untouched, and the editor is told why", { timeout: 120_000 }, async (t) => {
  // Built at the run: a value no file of this repository holds, made a launcher's secret only once its note is on main.
  const value = ["vault", "code", process.pid, Date.now().toString(36)].join("-");
  withEnv(t, {}, ["AGENT_MODEL_API_KEY"]);
  const first = await serve(t);
  const { data } = first;
  await made(first.api, learner("masked"));
  const repo = repoOf(data, "masked");
  const files = "/agents/masked/learning/files";
  const VAULT = note("Vault", "Where the vault code is", `The vault code is ${value}.\nAsk the shift lead before opening it.\n`);
  assert.equal((await first.api("PUT", `${files}/vault.md`, { text: VAULT }, { "if-none-match": "*" })).status, 201);
  await first.close();

  // The server again, with the vault code as a launcher's secret (the model key).
  process.env.AGENT_MODEL_API_KEY = value;
  const { api } = await serve(t, { data });
  const read = await api("GET", `${files}/vault.md`);
  const shownText = typeof read.body === "string" ? read.body : read.body.text;
  assert.ok(shownText.includes("The vault code is [redacted].") && !shownText.includes(value), shownText);
  const main = git(repo, ["rev-parse", "main"]);
  // The person edits an unrelated line of what they were shown, with the note's own ETag.
  const edited = shownText.replace("Ask the shift lead", "Ask the duty manager");
  const put = await api("PUT", `${files}/vault.md`, { text: edited }, { "if-match": read.headers.get("etag") });
  assert.equal(put.status, 400, JSON.stringify(put.body));
  assert.deepEqual(put.body?.error?.problems?.map((p) => [p.rule, p.path]), [["secret_value", "vault.md"]]);
  assert.match(put.body.error.problems[0].detail, /secret/i);
  assert.equal(git(repo, ["rev-parse", "main"]), main, "nothing committed");
  assert.ok(git(repo, ["show", "main:vault.md"]).includes(`The vault code is ${value}.`), "the hidden text is kept");
  // A retire is still the way out.
  assert.equal((await api("POST", `${files}/vault.md/retire`, undefined, { "if-match": read.headers.get("etag") })).status, 200);
});

test("a file on main that is not a note (over the read cap, not UTF-8, executable or a link) is never written over: a create of its name is 412, and an edit or a retire by its blob is 412 with no hint to create it, main untouched", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t);
  await made(api, learner("holder"));
  const repo = repoOf(data, "holder");
  const files = "/agents/holder/learning/files";
  assert.equal((await api("PUT", `${files}/kept.md`, { text: UNITS }, { "if-none-match": "*" })).status, 201, "the folder made by a create");
  // By an operator's hand on main, each a file the notes leave out: over the 1 MiB read cap, not UTF-8, mode 100755,
  // and a symbolic link (mode 120000).
  writeFileSync(join(repo, "big.md"), `${SOURCES}${"a".repeat(1 << 20)}\n`);
  writeFileSync(join(repo, "latin.md"), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
  writeFileSync(join(repo, "exec.md"), TABLES);
  chmodSync(join(repo, "exec.md"), 0o755);
  symlinkSync("kept.md", join(repo, "link.md"));
  git(repo, ["add", "big.md", "latin.md", "exec.md", "link.md"]);
  git(repo, ["update-index", "--chmod=+x", "exec.md"]);
  git(repo, ["commit", "-q", "-m", "an operator's hand"]);
  const tree = (file) => git(repo, ["ls-tree", "-l", "main", "--", file]);
  assert.deepEqual(["big.md", "latin.md", "exec.md", "link.md"].map((file) => tree(file).split(/\s+/)[0]), ["100644", "100644", "100755", "120000"]);
  const main = git(repo, ["rev-parse", "main"]);
  for (const file of ["big.md", "latin.md", "exec.md", "link.md"]) {
    const before = tree(file);
    const etag = `"${git(repo, ["rev-parse", `main:${file}`])}"`;
    assert.equal((await api("GET", `${files}/${file}`)).status, 404, `${file} is no note to read`);
    const created = await api("PUT", `${files}/${file}`, { text: ASK }, { "if-none-match": "*" });
    assert.deepEqual([created.status, created.body?.error?.code], [412, "precondition_failed"], `${file}: ${JSON.stringify(created.body)}`);
    for (const [method, body] of [["PUT", { text: ASK }], ["POST", undefined]]) {
      const edited = await api(method, `${files}/${file}${body ? "" : "/retire"}`, body, { "if-match": etag });
      assert.deepEqual([edited.status, edited.body?.error?.code], [412, "precondition_failed"], `${method} ${file}: ${JSON.stringify(edited.body)}`);
      assert.ok(!/if-none-match/i.test(edited.body.error.message), `${method} ${file}: no hint to create it: ${edited.body.error.message}`);
    }
    assert.equal(tree(file), before, `${file} untouched`);
  }
  assert.equal(git(repo, ["rev-parse", "main"]), main, "nothing committed");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "the checked-out files are main's");
});

test("a run's learning shows the grader's item for each new note: a drop of two notes names the one that failed, with its question and why", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl } = await serve(t, { learning: "on", faux: LEARN });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const ONE_CASE = note("One case", "The answer for this one input was 42");
  await made(api, learner("judged", { instructions: "Answer the question.\nGrade: drop one-case.md.", plan: [["check-units.md", UNITS], ["one-case.md", ONE_CASE]] }));
  const run = await ended(api, await started(api, "judged"));
  settled(run.view, run.rows, "dropped", "grader");
  const learned = (await api("GET", `/runs/${run.view.run_id}/learning`)).body;
  assert.deepEqual(schemaProblems(doc, doc.paths["/runs/{run_id}/learning"].get.responses["200"].content["application/json"].schema, learned), []);
  const { items, ...verdict } = learned.verdict;
  assert.deepEqual(verdict, { merge: false, reason: "A note is about the one case it came from." });
  assert.deepEqual([...items].sort((a, b) => a.file.localeCompare(b.file)), [
    { file: "check-units.md", keep: true, why: "It holds as a general rule." },
    { file: "one-case.md", keep: false, question: "General", why: "It is about one case." },
  ]);
});
