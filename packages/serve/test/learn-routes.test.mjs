// A person sees and controls what an agent has learned, through the API: the agent's workflow drafts, corrections, log
// and counts; a run's learning whole and its diff; a draft read file by file and retired by its README.md (If-Match),
// one save by a person, and the next run starting from the result. A write that names no version is 428, a stale
// one 412; a draft's workflow.json is never a write's target.
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { test } from "node:test";
import { blobOid } from "../dist/learn/rows.js";
import { seedOf } from "../dist/learning.js";
import { ended, LEARN, learner, learningAt, made, overStore, savedOf, savesOf, settled, started } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, follow, runsFolders, serve } from "./support.mjs";

const FLOW = "workflows/answer/workflow.json";
const README = "workflows/answer/README.md";
const DESCRIPTION = "Answers a question; use when asked";
const enc = encodeURIComponent;
/** A new file's patch, hunks only. */
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
  const files = `/agents/${id}/learning/files`;
  const mainOf = async () => (await learningAt(data, id)).view?.main;
  const textOf = async (file) => (await learningAt(data, id)).text(file);
  const blob = async (file) => `"${blobOid(await textOf(file))}"`;

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
  const main1 = await mainOf();
  const two = await started(api, id);
  const second = await ended(api, two);
  settled(second.view, second.rows, "dropped", "empty");
  assert.equal(await mainOf(), main1, "the drop moved nothing");

  // The agent's view: main, its draft, the log entry by run 1, and the runs' counts.
  const view = (await api("GET", `/agents/${id}/learning`)).body;
  meets("/agents/{agent_id}/learning", view);
  assert.equal(view.main, main1);
  assert.equal(view.corrections, "");
  const size = async (path) => Buffer.byteLength(await textOf(path), "utf8");
  assert.deepEqual(view.workflows, [{ name: "answer", file: FLOW, readme: README, description: DESCRIPTION, status: "checking", run: one, bytes: await size(FLOW), etag: await blob(README), last_change: { kind: "learned", by: "run", at: view.workflows[0]?.last_change?.at } }]);
  assert.ok(!Number.isNaN(Date.parse(view.workflows[0].last_change.at)));
  assert.deepEqual(view.log.items.map((item) => [item.by, item.commit, item.files]), [[{ run: one }, main1, [README, FLOW]]]);
  assert.equal(view.log.total, 1);
  assert.deepEqual(view.counts, { merged: 1, dropped: { empty: 1 }, in_progress: 0 });

  // Run 1's diff: its merge against its parent (the agent's first save), hunks only.
  const diff1 = (await api("GET", `/runs/${one}/learning/diff`)).body;
  meets("/runs/{run_id}/learning/diff", diff1);
  assert.deepEqual([diff1.base, diff1.head], [await overStore(data, async (store) => (await store.learning.diff(id, main1)).parent.id), main1]);
  assert.deepEqual(diff1.files.map((f) => [f.path, f.status]), [[README, "added"], [FLOW, "added"]]);
  assert.equal(diff1.files[0].patch, added(await textOf(README)));
  // Run 2: its learning whole shows the drop, and its diff no file, against its seed.
  const learned2 = (await api("GET", `/runs/${two}/learning`)).body;
  meets("/runs/{run_id}/learning", learned2);
  assert.deepEqual([learned2.run, learned2.state, learned2.reason, learned2.seed], [two, "dropped", "empty", main1]);
  assert.deepEqual((await api("GET", `/runs/${two}/learning/diff`)).body, { base: main1, head: null, files: [] });
  const learned1 = (await api("GET", `/runs/${one}/learning`)).body;
  assert.deepEqual([learned1.state, learned1.merged, learned1.workflows], ["merged", main1, [{ file: FLOW, name: "answer" }]]);

  // A draft's files as text, each with its ETag (its text's blob id at the newest save): its README.md markdown, its workflow.json JSON.
  for (const [file, type] of [[README, "text/markdown; charset=utf-8"], [FLOW, "application/json; charset=utf-8"]]) {
    const read = await api("GET", `${files}/${enc(file)}`);
    const text = typeof read.body === "string" ? read.body : JSON.stringify(read.body);
    assert.deepEqual([read.status, read.headers.get("etag"), read.headers.get("content-type"), read.headers.get("x-content-type-options")], [200, await blob(file), type, "nosniff"], file);
    const saved = await textOf(file);
    assert.equal(typeof read.body === "string" ? text : JSON.stringify(JSON.parse(text)), typeof read.body === "string" ? saved : JSON.stringify(JSON.parse(saved)), file);
  }
  assert.equal((await api("GET", `${files}/${enc("workflows/missing/README.md")}`)).status, 404);
  for (const bad of ["corrections.md", "MEMORY.md", "workflows/answer/other.json", "workflows/Answer/README.md", "notes.md"]) assert.equal((await api("GET", `${files}/${enc(bad)}`)).status, 400, bad);

  // A person retires the draft by its README.md, with the ETag it read: one save by a person; the next run starts
  // without it. A draft's workflow.json is no write's target.
  const etag1 = await blob(README);
  assert.equal((await retire(README)).status, 428, "no precondition");
  const star = await retire(README, { "if-match": "*" });
  assert.deepEqual([star.status, star.body?.error.code], [428, "precondition_required"], "If-Match: * names no version");
  const byJson = await retire(FLOW, { "if-match": await blob(FLOW) });
  assert.equal(byJson.status, 400, byJson.text);
  const retired = await retire(README, { "if-match": etag1 });
  assert.equal(retired.status, 200, retired.text);
  assert.equal(retired.text, `---\nname: answer\ndescription: ${DESCRIPTION}\nstatus: retired\nretired_from: active\n---\n`);
  assert.ok(retired.headers.get("etag") !== etag1 && retired.headers.get("etag") === await blob(README), "a new ETag, the new text's");
  const [top, ...older] = await savesOf(data, id);
  assert.deepEqual([top.by, top.reason, top.files], [{ person: "retired", file: README }, `retired by a person: ${README}`, [README]], "one save by a person, one file changed");
  assert.equal(top.id, await mainOf());
  assert.equal(older.length, 1, "run 1's merge before it");
  const stale = await retire(README, { "if-match": etag1 });
  assert.deepEqual([stale.status, stale.body?.error.code], [412, "precondition_failed"], "a stale ETag");
  // Retiring it again answers it as it is, and saves nothing.
  const main2 = await mainOf();
  assert.equal((await retire(README, { "if-match": retired.headers.get("etag") })).status, 200);
  assert.equal(await mainOf(), main2);
  assert.deepEqual((await overStore(data, (store) => seedOf(data, store, id))).workflows, [], "no later run is given it");

  // The log: every save, newest first, by run or by person.
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
  const mainOf = async () => (await learningAt(data, "carded")).view?.main;
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
  const main = await mainOf();
  assert.equal((await api("POST", `${path}/retire`, undefined, { "if-match": shown.etag })).status, 412);
  assert.equal(await mainOf(), main);
});
