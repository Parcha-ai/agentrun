// A person sees and controls what an agent has learned, through the API: the agent's workflow drafts, corrections, log
// and counts; a run's learning whole and its diff; a draft read file by file and retired by its README.md (If-Match),
// one host commit by a person, and the next run starting from the result. A write that names no version is 428, a stale
// one 412; a draft's workflow.json is never a write's target.
import assert from "node:assert/strict";
import { chmodSync, lstatSync, readdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { seedOf } from "../dist/learning.js";
import { ended, git, LEARN, learner, made, objects, repoOf, savedOf, settled, started } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, call, follow, runsFolders, scratch, serve } from "./support.mjs";

const FLOW = "workflows/answer/workflow.json";
const README = "workflows/answer/README.md";
const DESCRIPTION = "Answers a question; use when asked";
const enc = encodeURIComponent;
/** A new file's patch as git writes it, hunks only. */
const added = (text) => {
  const lines = text.split("\n").slice(0, -1);
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((one) => `+${one}\n`).join("")}`;
};

test("a person sees what the agent learned and controls it: the view, the log by run and by person, a run's diff and its drop, a draft's files, a retire through preconditions, and the next run starting from the result", { timeout: 300_000 }, async (t) => {
  const { api, baseUrl, data, token } = await serve(t, { learning: "on", faux: LEARN });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const answer = (path, method = "get", status = "200") => doc.paths[path][method].responses[status].content["application/json"].schema;
  const meets = (path, value, method, status) => assert.deepEqual(schemaProblems(doc, answer(path, method, status), value), [], `${path}: ${JSON.stringify(value)}`);
  const retire = async (file, headers = {}) => {
    const res = await fetch(`${baseUrl}/agents/keeper/learning/files/${enc(file)}/retire`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers } });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, text, body: json };
  };
  const id = "keeper";
  const repo = repoOf(data, id);
  const files = `/agents/${id}/learning/files`;
  const blob = (file) => `"${git(repo, ["rev-parse", `main:${file}`])}"`;

  // An agent whose learning was never on has no folder: an empty view; its run has no learning and no diff.
  await made(api, agent("plain"));
  const plain = (await api("GET", "/agents/plain/learning")).body;
  assert.deepEqual(plain, { agent: "plain", main: null, corrections: "", workflows: [], log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 }, impact: null,
    learning_model: { location: "server", ready: true, model: "faux/faux-1", needs: null, reason: null } });
  meets("/agents/{agent_id}/learning", plain);
  const plainRun = await started(api, "plain");
  await follow(api, plainRun, ["completed"]);
  const none = await fetch(`${baseUrl}/runs/${plainRun}/learning`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual([none.status, await none.json()], [200, null]);
  assert.equal((await api("GET", `/runs/${plainRun}/learning/diff`)).status, 404);
  assert.equal((await api("GET", "/agents/nobody/learning")).status, 404);

  // Run 1 compiles the job into a workflow draft; run 2, the draft kept, has nothing new to keep.
  await made(api, learner(id, { learning: { compile_after: 1 } }));
  const one = await started(api, id);
  const first = await ended(api, one);
  settled(first.view, first.rows, "merged");
  const main1 = git(repo, ["rev-parse", "main"]);
  const two = await started(api, id);
  const second = await ended(api, two);
  settled(second.view, second.rows, "dropped", "empty");
  assert.equal(git(repo, ["rev-parse", "main"]), main1, "the drop moved nothing");

  // The agent's view: main, its draft, the log entry by run 1, and the runs' counts.
  const view = (await api("GET", `/agents/${id}/learning`)).body;
  meets("/agents/{agent_id}/learning", view);
  assert.equal(view.main, main1);
  assert.equal(view.corrections, "");
  const size = (path) => Number(git(repo, ["cat-file", "-s", `main:${path}`]));
  assert.deepEqual(view.workflows, [{ name: "answer", file: FLOW, readme: README, description: DESCRIPTION, status: "checking", run: one, bytes: size(FLOW), etag: blob(README), last_change: { kind: "learned", by: "run", at: view.workflows[0]?.last_change?.at } }]);
  assert.ok(!Number.isNaN(Date.parse(view.workflows[0].last_change.at)));
  assert.deepEqual(view.log.items.map((item) => [item.by, item.commit, item.files]), [[{ run: one }, main1, [README, FLOW]]]);
  assert.equal(view.log.total, 1);
  assert.deepEqual(view.counts, { merged: 1, dropped: { empty: 1 }, in_progress: 0 });

  // Run 1's diff: its merge against its parent, as git writes it, hunks only.
  const diff1 = (await api("GET", `/runs/${one}/learning/diff`)).body;
  meets("/runs/{run_id}/learning/diff", diff1);
  assert.deepEqual([diff1.base, diff1.head], [git(repo, ["rev-parse", `${main1}^`]), main1]);
  assert.deepEqual(diff1.files.map((f) => [f.path, f.status]), [[README, "added"], [FLOW, "added"]]);
  assert.equal(diff1.files[0].patch, added(`${git(repo, ["show", `main:${README}`])}\n`));
  // Run 2: its learning whole shows the drop, and its diff no file, against its seed.
  const learned2 = (await api("GET", `/runs/${two}/learning`)).body;
  meets("/runs/{run_id}/learning", learned2);
  assert.deepEqual([learned2.run, learned2.state, learned2.reason, learned2.seed], [two, "dropped", "empty", main1]);
  assert.deepEqual((await api("GET", `/runs/${two}/learning/diff`)).body, { base: main1, head: null, files: [] });
  const learned1 = (await api("GET", `/runs/${one}/learning`)).body;
  assert.deepEqual([learned1.state, learned1.merged, learned1.workflows], ["merged", main1, [{ file: FLOW, name: "answer" }]]);

  // A draft's files as text, each with its ETag (its blob id on main): its README.md markdown, its workflow.json JSON.
  for (const [file, type] of [[README, "text/markdown; charset=utf-8"], [FLOW, "application/json; charset=utf-8"]]) {
    const read = await api("GET", `${files}/${enc(file)}`);
    const text = typeof read.body === "string" ? read.body : JSON.stringify(read.body);
    assert.deepEqual([read.status, read.headers.get("etag"), read.headers.get("content-type"), read.headers.get("x-content-type-options")], [200, blob(file), type, "nosniff"], file);
    assert.equal(typeof read.body === "string" ? text : JSON.stringify(JSON.parse(text)), typeof read.body === "string" ? readFileSync(join(repo, file), "utf8") : JSON.stringify(JSON.parse(readFileSync(join(repo, file), "utf8"))), file);
  }
  assert.equal((await api("GET", `${files}/${enc("workflows/missing/README.md")}`)).status, 404);
  for (const bad of ["corrections.md", "MEMORY.md", "workflows/answer/other.json", "workflows/Answer/README.md", "notes.md"]) assert.equal((await api("GET", `${files}/${enc(bad)}`)).status, 400, bad);

  // A person retires the draft by its README.md, with the ETag it read: one commit by a person; the next run starts
  // without it. A draft's workflow.json is no write's target.
  const etag1 = blob(README);
  assert.equal((await retire(README)).status, 428, "no precondition");
  const star = await retire(README, { "if-match": "*" });
  assert.deepEqual([star.status, star.body?.error.code], [428, "precondition_required"], "If-Match: * names no version");
  const byJson = await retire(FLOW, { "if-match": blob(FLOW) });
  assert.equal(byJson.status, 400, byJson.text);
  const retired = await retire(README, { "if-match": etag1 });
  assert.equal(retired.status, 200, retired.text);
  assert.equal(retired.text, `---\nname: answer\ndescription: ${DESCRIPTION}\nstatus: retired\nretired_from: active\n---\n`);
  assert.ok(retired.headers.get("etag") !== etag1 && retired.headers.get("etag") === blob(README), "a new ETag, the new blob's");
  assert.deepEqual(git(repo, ["log", "-1", "--format=%an%n%s%n%b", "main"]).split("\n").filter(Boolean), ["agentrun-serve", `learning: retired by a person: ${README}`, "Changed-By: user"]);
  assert.deepEqual(git(repo, ["show", "--name-only", "--format=", "main"]).split("\n").filter(Boolean), [README], "one file changed");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  const stale = await retire(README, { "if-match": etag1 });
  assert.deepEqual([stale.status, stale.body?.error.code], [412, "precondition_failed"], "a stale ETag");
  // Retiring it again answers it as it is, and commits nothing.
  const main2 = git(repo, ["rev-parse", "main"]);
  assert.equal((await retire(README, { "if-match": retired.headers.get("etag") })).status, 200);
  assert.equal(git(repo, ["rev-parse", "main"]), main2);
  assert.deepEqual((await seedOf(data, id)).workflows, [], "no later run is given it");

  // The log: every change on main, newest first, by run or by person.
  const view2 = (await api("GET", `/agents/${id}/learning`)).body;
  meets("/agents/{agent_id}/learning", view2);
  assert.deepEqual(view2.log.items.map((c) => [c.by, c.reason, c.files]), [
    [{ user: true }, `retired by a person: ${README}`, [README]],
    [{ run: one }, view.log.items[0].reason, [README, FLOW]],
  ]);
  assert.deepEqual(view2.workflows.map((w) => [w.file, w.status, w.retired?.by]), [[FLOW, "retired", "person"]]);
  // Pages: opaque cursors.
  const log1 = (await api("GET", `/agents/${id}/learning/log?limit=1`)).body;
  meets("/agents/{agent_id}/learning/log", log1);
  const log2 = (await api("GET", `/agents/${id}/learning/log?limit=1&cursor=${log1.next_cursor}`)).body;
  assert.deepEqual([log1.total, log1.items.map((c) => c.by), log2.items.map((c) => c.by), log2.next_cursor], [2, [{ user: true }], [{ run: one }], null]);
  for (const query of ["limit=0", "limit=201", "limit=x", "cursor=bm9wZQ"]) assert.equal((await api("GET", `/agents/${id}/learning/log?${query}`)).status, 400, query);

  // The counts leave archived runs out, as GET /stats does: an archived drop is no longer counted, and the two agree.
  const counted = async () => [(await api("GET", `/agents/${id}/learning`)).body.counts, (({ runs: _, ...rest }) => rest)((await api("GET", `/stats?agent=${id}`)).body.learning)];
  assert.deepEqual(await counted(), [{ merged: 1, dropped: { empty: 1 }, in_progress: 0 }, { merged: 1, dropped: { empty: 1 }, in_progress: 0 }]);
  assert.equal((await api("POST", `/runs/${two}/archive`)).status, 200);
  assert.deepEqual(await counted(), [{ merged: 1, dropped: {}, in_progress: 0 }, { merged: 1, dropped: {}, in_progress: 0 }]);
  // An archived agent's learning reads, counted as GET /stats counts it.
  assert.equal((await api("POST", `/agents/${id}/archive`)).status, 200);
  const [mine, stats] = await counted();
  assert.deepEqual(mine, stats);
});

test("a link planted at the agent's learning folder makes a person's retire an error, and its reads too: the host never follows it, writes nothing where it points and answers none of it", { timeout: 120_000 }, async (t) => {
  const { api, data, port, token } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("linked", { learning: { compile_after: 1 } }));
  const run = await ended(api, await started(api, "linked"));
  assert.equal(run.view.learning?.state, "merged", JSON.stringify(run.view.learning));
  const repo = repoOf(data, "linked");
  const files = "/v2/agents/linked/learning/files";
  const headers = (more) => ({ authorization: `Bearer ${token}`, ...more });
  const etag = `"${git(repo, ["rev-parse", `main:${README}`])}"`;

  // The folder moved out of the data directory with a link to it left in its place.
  const outside = join(await scratch(t), "learning");
  renameSync(repo, outside);
  symlinkSync(outside, repo);
  const state = () => ({
    main: git(outside, ["rev-parse", "main"]),
    objects: objects(outside),
    files: readFileSync(join(outside, README), "utf8"),
    git: readdirSync(join(outside, ".git")).sort(),
    host: [readdirSync(join(outside, ".agentrun")).sort(), readFileSync(join(outside, ".agentrun", "snapshot.json"), "utf8")],
  });
  const before = state();
  const LINKED = /^a link in the learning folder at disk\/agents\/linked-[0-9a-f]{16}\/learning can't be followed, .*; remove the link$/;

  const res = await call(port, { method: "POST", path: `${files}/${enc(README)}/retire`, headers: headers({ "if-match": etag }) });
  assert.deepEqual([res.status, res.json?.error?.code], [500, "internal"], "a retire");
  assert.match(res.json.error.message, LINKED);
  assert.ok(!res.text.includes(outside), "the answer never names where the link points");
  // The reads check the same levels, making nothing: the view, its log, the corrections and a file answer the same error,
  // holding none of what the folder the link points at holds.
  for (const path of ["/v2/agents/linked/learning", "/v2/agents/linked/learning/log", "/v2/agents/linked/learning/corrections", `${files}/${enc(README)}`]) {
    const read = await call(port, { path, headers: headers() });
    assert.deepEqual([read.status, read.json?.error?.code], [500, "internal"], path);
    assert.match(read.json.error.message, LINKED, path);
    for (const held of [outside, before.main, DESCRIPTION]) assert.ok(!read.text.includes(held), `${path}: the answer holds ${held}`);
  }
  assert.ok(lstatSync(repo).isSymbolicLink(), "the link is left where it was");
  assert.deepEqual(state(), before, "nothing written where the link points: main, its objects, its files and its .git as they were");
});

test("a restarted server counts an agent's runs that tried to learn from the store, as GET /stats does: its view's counts read with runs/ unreadable", { timeout: 180_000 }, async (t) => {
  const first = await serve(t, { learning: "on", faux: LEARN });
  const { data } = first;
  await made(first.api, learner("counted", { learning: { compile_after: 1 } }));
  const merged = await ended(first.api, await started(first.api, "counted"));
  settled(merged.view, merged.rows, "merged");
  // The second run, its draft kept, has nothing new to keep: its learning is dropped as empty.
  const empty = await ended(first.api, await started(first.api, "counted"));
  settled(empty.view, empty.rows, "dropped", "empty");
  for (const { view } of [merged, empty]) await savedOf(data, view.run_id);
  const want = { merged: 1, dropped: { empty: 1 }, in_progress: 0 };
  assert.deepEqual((await first.api("GET", "/agents/counted/learning")).body.counts, want);
  await first.close();
  // The restarted server holds neither run: both are counted from the ledger, and no run's files are opened.
  const again = await serve(t, { learning: "on", faux: LEARN, data });
  const runs = runsFolders(data);
  for (const folder of runs) chmodSync(folder, 0o000);
  try {
    assert.deepEqual((await again.api("GET", "/agents/counted/learning")).body.counts, want, "read back from the ledger");
    assert.deepEqual((await again.api("GET", "/stats?agent=counted")).body.learning, { runs: 2, ...want });
  } finally {
    for (const folder of runs) chmodSync(folder, 0o700);
  }
});

test("each draft in the view carries its README.md's ETag, the one that file's GET answers: a retire by it changes exactly the version shown, and a card shown before a change is 412", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("carded", { learning: { compile_after: 1 } }));
  await ended(api, await started(api, "carded"));
  const repo = repoOf(data, "carded");
  const path = `/agents/carded/learning/files/${enc(README)}`;
  const card = async () => (await api("GET", "/agents/carded/learning")).body.workflows.find((item) => item.name === "answer");
  const shown = await card();
  assert.match(shown.etag, /^"[0-9a-f]{40,64}"$/);
  assert.equal(shown.etag, (await api("GET", path)).headers.get("etag"), "the view's card");
  // A retire by the card's ETag lands, and the card the view now shows carries the new one.
  const retired = await api("POST", `${path}/retire`, undefined, { "if-match": shown.etag });
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  const after = await card();
  assert.deepEqual([after.status, after.etag], ["retired", retired.headers.get("etag")]);
  // The card shown before the retire is stale: a retire by it is 412, and nothing changes.
  const main = git(repo, ["rev-parse", "main"]);
  assert.equal((await api("POST", `${path}/retire`, undefined, { "if-match": shown.etag })).status, 412);
  assert.equal(git(repo, ["rev-parse", "main"]), main);
});
