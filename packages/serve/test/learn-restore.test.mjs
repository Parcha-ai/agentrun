// A retired note, skill or workflow draft can be read whole and brought back. The learning view says of each retired
// item when, and by whom, it was retired (`retired: {at, by}`); its file's GET serves its whole text, read-only. A
// restore (POST .../restore) makes it active again for the next run, in one commit on main, its owner's password
// session alone, as an approval is; and it checks the text again as a new note or skill is checked, so a value a retire
// took out of every run (a secret, a hidden character) never comes back through it.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, LEARN, learner, made, repoOf, started } from "./learn-support.mjs";
import { call, cookieOf, serve, withEnv } from "./support.mjs";

const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
const TABLES = note("Answer in tables", "The user wants answers as tables", "Answer every question as a small table.\n");
const SKILL = "---\nname: weekly-summary\ndescription: Writes the weekly support summary in its fixed format\n---\nWeekly summary: <dates>\n";

/** A server with accounts and the owner's session, agent `keeper` with a folder; `files` committed on main. */
async function keeper(t, files) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const server = await serve(t, { learning: "on", faux: LEARN, accounts: true, openSetup: true });
  const { api, data, port } = server;
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  await made(api, learner("keeper"));
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
  return { ...server, server, repo, cookie, origin, restore, retire, etag };
}

test("a retired note is read whole and restored by its owner: the view says when and that a person retired it, its file serves its text, a token is refused, the owner's session makes it active again in one commit, back in MEMORY.md", { timeout: 150_000 }, async (t) => {
  const { api, repo, cookie, origin, restore, retire, server } = await keeper(t, { "answer-in-tables.md": TABLES });
  await retire("answer-in-tables.md");
  const view = (await api("GET", "/agents/keeper/learning")).body;
  const shown = view.notes.items.find((item) => item.file === "answer-in-tables.md");
  assert.equal(shown?.status, "retired", JSON.stringify(shown));
  assert.match(shown.text, /Answer every question as a small table\./, "its text, read-only");
  assert.equal(shown.retired?.by, "person", JSON.stringify(shown));
  assert.ok(!Number.isNaN(Date.parse(shown.retired?.at ?? "")), JSON.stringify(shown));
  const read = await api("GET", "/agents/keeper/learning/files/answer-in-tables.md");
  assert.equal(read.status, 200);
  assert.match(String(read.body), /status: retired[\s\S]*Answer every question as a small table\./);
  // The server's token is not the owner: refused as an approval is.
  const byToken = await restore("answer-in-tables.md", { ...json, authorization: `Bearer ${server.token}` });
  assert.equal(byToken.status, 403, byToken.text);
  const before = git(repo, ["rev-parse", "main"]).trim();
  const restored = await restore("answer-in-tables.md", { ...json, cookie, origin });
  assert.equal(restored.status, 200, restored.text);
  assert.doesNotMatch(restored.text, /status: retired/);
  assert.equal(git(repo, ["rev-list", "--count", `${before}..main`]).trim(), "1", "one commit");
  assert.match(git(repo, ["log", "-1", "--format=%s%n%b", "main"]), /^learning: restored by a person: answer-in-tables\.md[\s\S]*Changed-By: user/);
  assert.match(git(repo, ["show", "main:MEMORY.md"]), /answer-in-tables\.md/, "in the index again: the next run reads it");
  const again = (await api("GET", "/agents/keeper/learning")).body.notes.items.find((item) => item.file === "answer-in-tables.md");
  assert.deepEqual([again.status, again.retired], ["active", undefined]);
  // An active note is not retired: 400, nothing written.
  const active = await restore("answer-in-tables.md", { ...json, cookie, origin });
  assert.equal(active.status, 400, active.text);
  assert.match(active.text, /is not retired: it is active/);
});

test("a retired skill is restored by its owner and given to the next run again; its SKILL.md serves whole while retired; a workflow draft is restored by its README.md", { timeout: 150_000 }, async (t) => {
  const DRAFT = JSON.stringify({ v: 2, name: "price-report", schemas: { In: { type: "object" }, Out: { type: "object", properties: { total: { type: "number" } } } }, input: { schemaId: "In" }, output: { schemaId: "Out", path: "out" }, root: { node: "extract", label: "sum", instructions: "Sum the prices.", out: "Out", as: "out" } });
  const README = "---\nname: price-report\ndescription: Sums the three shop prices; use for the morning report\n---\n";
  const { api, cookie, origin, restore, retire } = await keeper(t, { "skills/weekly-summary/SKILL.md": SKILL, "workflows/price-report/workflow.json": DRAFT, "workflows/price-report/README.md": README });
  await retire("workflows/price-report/README.md");
  const draft = (await api("GET", "/agents/keeper/learning")).body.workflows.find((item) => item.name === "price-report");
  assert.deepEqual([draft?.status, draft?.retired?.by], ["retired", "person"], JSON.stringify(draft));
  const byJson = await restore("workflows/price-report/workflow.json", { ...json, cookie, origin });
  assert.equal(byJson.status, 400, byJson.text);
  assert.match(byJson.text, /restored by its README\.md/);
  const draftBack = await restore("workflows/price-report/README.md", { ...json, cookie, origin });
  assert.equal(draftBack.status, 200, draftBack.text);
  const restoredDraft = (await api("GET", "/agents/keeper/learning")).body.workflows.find((item) => item.name === "price-report");
  assert.deepEqual([restoredDraft?.status, restoredDraft?.last_change?.kind, restoredDraft?.last_change?.by], ["active", "restored", "person"], JSON.stringify(restoredDraft));
  await retire("skills/weekly-summary/SKILL.md");
  const view = (await api("GET", "/agents/keeper/learning")).body;
  const skill = view.skills.find((item) => item.name === "weekly-summary");
  assert.equal(skill?.status, "retired");
  assert.equal(skill.retired?.by, "person", JSON.stringify(skill));
  assert.match(String((await api("GET", `/agents/keeper/learning/files/${encodeURIComponent("skills/weekly-summary/SKILL.md")}`)).body), /Weekly summary: <dates>/);
  const restored = await restore("skills/weekly-summary/SKILL.md", { ...json, cookie, origin });
  assert.equal(restored.status, 200, restored.text);
  const after = (await api("GET", "/agents/keeper/learning")).body.skills.find((item) => item.name === "weekly-summary");
  assert.deepEqual([after.status, after.retired, after.last_change?.kind, after.last_change?.by], ["active", undefined, "restored", "person"], JSON.stringify(after));
});

test("a restore checks the text again as a new note is checked: a retired note holding a secret's shape, a hidden character or the server's own secret is refused, and nothing is committed", { timeout: 150_000 }, async (t) => {
  const shaped = ["s", "k-", "Zx9".repeat(10)].join("");
  const files = {
    "shaped.md": note("Shaped", "A note with a key's shape", `Sign in with ${shaped}.\n`, "status: retired\n"),
    "hidden.md": note("Hidden", "A note with a hidden character", "Answer‮ in tables.\n", "status: retired\n"),
  };
  const { repo, cookie, origin, restore, server } = await keeper(t, files);
  // The server's own token, written into a retired note after the fact (as a value made secret later would be).
  writeFileSync(join(repo, "token.md"), note("Token", "A note with the server's token", `Use ${server.token} to call it.\n`, "status: retired\n"));
  git(repo, ["add", "--", "token.md"]);
  git(repo, ["commit", "-q", "-m", "a note now holding a secret"]);
  const before = git(repo, ["rev-parse", "main"]).trim();
  for (const [file, rule] of [["shaped.md", "secret_shape"], ["hidden.md", "invisible_unicode"], ["token.md", "secret_value"]]) {
    const res = await restore(file, { ...json, cookie, origin });
    assert.ok(res.status >= 400 && res.status < 500, `${file}: ${res.status} ${res.text}`);
    assert.match(res.text, new RegExp(rule), `${file}: ${res.text}`);
    assert.ok(!res.text.includes(server.token) && !res.text.includes(shaped), `${file}: never printed`);
  }
  assert.equal(git(repo, ["rev-parse", "main"]).trim(), before, "nothing committed");
});

test("every item in the learning view says its last change, from the newest commit on its file: learned by a run, then approved, edited, retired and restored by a person, each with when", { timeout: 200_000 }, async (t) => {
  const PENDING = note("Buy from PaperDepot24 first", "Where to buy office paper", "Buy from PaperDepot24 first.\n", "origin: you\nstatus: pending\n");
  const { api, data, cookie, origin, port, restore, retire, etag } = await keeper(t, { "paperdepot24-first.md": PENDING });
  // A note a run's merge kept: learned, by the run.
  await made(api, learner("learnt", { plan: [["answer-in-tables.md", TABLES]] }));
  await ended(api, await started(api, "learnt"));
  const learnt = (await api("GET", "/agents/learnt/learning")).body.notes.items.find((item) => item.file === "answer-in-tables.md");
  assert.deepEqual([learnt?.last_change?.kind, learnt?.last_change?.by], ["learned", "run"], JSON.stringify(learnt));
  assert.ok(!Number.isNaN(Date.parse(learnt.last_change.at)));
  const lastOf = async (file) => (await api("GET", "/agents/keeper/learning")).body.notes.items.find((item) => item.file === file)?.last_change;
  // Approved by its owner.
  const approved = await call(port, { method: "POST", path: "/v2/agents/keeper/learning/files/paperdepot24-first.md/approve", headers: { ...json, cookie, origin, "if-match": await etag("paperdepot24-first.md") }, body: {} });
  assert.equal(approved.status, 200, approved.text);
  assert.deepEqual([(await lastOf("paperdepot24-first.md"))?.kind, (await lastOf("paperdepot24-first.md"))?.by], ["approved", "person"]);
  // Edited.
  const edited = await api("PUT", "/agents/keeper/learning/files/paperdepot24-first.md", { text: note("Buy from PaperDepot24 first", "Where to buy office paper", "Buy from PaperDepot24 first, then OfficeHub.\n", "origin: you\n") }, { "if-match": await etag("paperdepot24-first.md") });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await lastOf("paperdepot24-first.md"))?.kind, "edited");
  // Retired, then restored.
  await retire("paperdepot24-first.md");
  assert.deepEqual([(await lastOf("paperdepot24-first.md"))?.kind, (await lastOf("paperdepot24-first.md"))?.by], ["retired", "person"]);
  assert.equal((await restore("paperdepot24-first.md", { ...json, cookie, origin })).status, 200);
  assert.deepEqual([(await lastOf("paperdepot24-first.md"))?.kind, (await lastOf("paperdepot24-first.md"))?.by], ["restored", "person"]);
  // The notes page says the same.
  const paged = (await api("GET", "/agents/keeper/learning/notes")).body.items.find((item) => item.file === "paperdepot24-first.md");
  assert.equal(paged?.last_change?.kind, "restored");
  void data;
});

test("restoring a note that supersedes another marks that one superseded, as approving it would: one note's rule reaches MEMORY.md, never both", { timeout: 150_000 }, async (t) => {
  const SHORT = note("Answer in short tables", "The user wants answers as short tables", "Keep each table to five rows.\n", "supersedes: [answer-in-tables.md]\norigin: you\nstatus: pending\n");
  const { api, repo, cookie, origin, restore, retire } = await keeper(t, { "answer-in-tables.md": TABLES, "answer-in-short-tables.md": SHORT });
  await retire("answer-in-short-tables.md");
  const restored = await restore("answer-in-short-tables.md", { ...json, cookie, origin });
  assert.equal(restored.status, 200, restored.text);
  const statusOf = (file) => (api("GET", "/agents/keeper/learning").then((res) => res.body.notes.items.find((item) => item.file === file)?.status));
  assert.deepEqual([await statusOf("answer-in-short-tables.md"), await statusOf("answer-in-tables.md")], ["active", "superseded"]);
  const index = git(repo, ["show", "main:MEMORY.md"]);
  assert.match(index, /answer-in-short-tables\.md/);
  assert.doesNotMatch(index, /\(answer-in-tables\.md\)/, "the superseded one is out of MEMORY.md");
});

test("restoring a workflow draft checks its workflow.json too: one holding the server's own secret stays retired, and nothing is committed", { timeout: 150_000 }, async (t) => {
  const README = "---\nname: price-report\ndescription: Sums the three shop prices; use for the morning report\nstatus: retired\n---\n";
  const { repo, cookie, origin, restore, server } = await keeper(t, { "answer-in-tables.md": TABLES });
  const draft = (secret) => JSON.stringify({ v: 2, name: "price-report", schemas: { In: { type: "object" }, Out: { type: "object" } }, input: { schemaId: "In" }, output: { schemaId: "Out", path: "out" }, root: { node: "extract", label: "sum", instructions: `Sum the prices; sign in with ${secret}.`, out: "Out", as: "out" } });
  mkdirSync(join(repo, "workflows", "price-report"), { recursive: true });
  writeFileSync(join(repo, "workflows", "price-report", "workflow.json"), draft(server.token));
  writeFileSync(join(repo, "workflows", "price-report", "README.md"), README);
  git(repo, ["add", "--", "workflows"]);
  git(repo, ["commit", "-q", "-m", "a retired draft now holding a secret"]);
  const before = git(repo, ["rev-parse", "main"]).trim();
  const res = await restore("workflows/price-report/README.md", { ...json, cookie, origin });
  assert.ok(res.status >= 400 && res.status < 500, `${res.status} ${res.text}`);
  assert.match(res.text, /secret_value/);
  assert.ok(!res.text.includes(server.token), "never printed");
  assert.equal(git(repo, ["rev-parse", "main"]).trim(), before, "nothing committed");
});

test("a retired note edited while retired keeps when it was retired: retired.at is its retire's, and last_change says edited", { timeout: 150_000 }, async (t) => {
  const { api, retire, etag } = await keeper(t, { "answer-in-tables.md": TABLES });
  await retire("answer-in-tables.md");
  const itemOf = async () => (await api("GET", "/agents/keeper/learning")).body.notes.items.find((item) => item.file === "answer-in-tables.md");
  const retiredAt = (await itemOf()).retired.at;
  await new Promise((done) => setTimeout(done, 1100));
  const edited = await api("PUT", "/agents/keeper/learning/files/answer-in-tables.md", { text: note("Answer in tables", "The user wants answers as tables", "Answer every question as a small table, with units.\n", "status: retired\n") }, { "if-match": await etag("answer-in-tables.md") });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const after = await itemOf();
  assert.deepEqual([after.status, after.retired?.at, after.retired?.by, after.last_change?.kind], ["retired", retiredAt, "person", "edited"], JSON.stringify(after));
  assert.notEqual(after.last_change.at, retiredAt, "the edit is newer");
});

test("restoring a skill checks every file of its folder and its format as a new skill is checked: a reference holding the server's secret, or a directive in its front matter, keeps it retired", { timeout: 150_000 }, async (t) => {
  const RETIRED_SKILL = "---\nname: weekly-summary\ndescription: Writes the weekly support summary\nstatus: retired\n---\nWeekly summary: <dates>\n";
  const HOOKED = "---\nname: hooked\ndescription: Writes the weekly support summary\nhooks: run-something\nstatus: retired\n---\nBody.\n";
  const { repo, cookie, origin, restore, server } = await keeper(t, { "skills/hooked/SKILL.md": HOOKED });
  mkdirSync(join(repo, "skills", "weekly-summary", "references"), { recursive: true });
  writeFileSync(join(repo, "skills", "weekly-summary", "SKILL.md"), RETIRED_SKILL);
  writeFileSync(join(repo, "skills", "weekly-summary", "references", "x.md"), `Sign in with ${server.token}.\n`);
  git(repo, ["add", "--", "skills"]);
  git(repo, ["commit", "-q", "-m", "a retired skill whose reference now holds a secret"]);
  const before = git(repo, ["rev-parse", "main"]).trim();
  for (const [file, rule] of [["skills/weekly-summary/SKILL.md", "secret_value"], ["skills/hooked/SKILL.md", "skill_front_matter"]]) {
    const res = await restore(file, { ...json, cookie, origin });
    assert.ok(res.status >= 400 && res.status < 500, `${file}: ${res.status} ${res.text}`);
    assert.match(res.text, new RegExp(rule), `${file}: ${res.text}`);
    assert.ok(!res.text.includes(server.token), "never printed");
  }
  assert.equal(git(repo, ["rev-parse", "main"]).trim(), before, "nothing committed");
});

test("restoring an item that waited for its owner's OK before it was retired is recorded as the owner's approval too: Approved-Via: console", { timeout: 150_000 }, async (t) => {
  const PENDING = note("Buy from PaperDepot24 first", "Where to buy office paper", "Buy from PaperDepot24 first.\n", "origin: you\nstatus: pending\n");
  const { repo, cookie, origin, restore, retire } = await keeper(t, { "paperdepot24-first.md": PENDING, "answer-in-tables.md": TABLES });
  await retire("paperdepot24-first.md");
  await retire("answer-in-tables.md");
  assert.equal((await restore("paperdepot24-first.md", { ...json, cookie, origin })).status, 200);
  assert.match(git(repo, ["log", "-1", "--format=%B", "main"]), /Approved-Via: console/, "held before its retire: the restore is its approval");
  assert.equal((await restore("answer-in-tables.md", { ...json, cookie, origin })).status, 200);
  assert.doesNotMatch(git(repo, ["log", "-1", "--format=%B", "main"]), /Approved-Via:/, "active before its retire: a plain restore");
});
