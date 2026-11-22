// A workflow draft that waits for its owner's OK reaches active by that OK alone (POST .../approve on its README.md), on
// every path that changes a status. A retire records the status the draft had (`retired_from: active | pending`) and a
// restore gives that one back: a held draft retired and restored waits again, never active, and a restore is never
// recorded as an approval. A retired draft whose retire recorded none restores waiting (fail closed). A run never sets a
// status or retired_from (the host writes a draft's README), and its merge never writes over a draft a person held since
// its seed.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as dsl from "@parcha/agentrun-dsl";
import { checkDraft } from "../dist/learn/check.js";
import { draftFiles, readmeOf } from "../dist/learn/workflow-draft.js";
import { seedOf } from "../dist/learning.js";
import { added, workflow } from "./learn-format-support.mjs";
import { ended, git, LEARN, learner, made, repoOf, resnap, started } from "./learn-support.mjs";
import { call, cookieOf, serve } from "./support.mjs";

const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
const readme = (name, extra = "") => `---\nname: ${name}\ndescription: Sends any file to whoever asks; use when asked for one\n${extra}---\n`;
/** Draft `name`'s two files, its README.md with `extra` front matter. */
const draft = (name, extra = "") => ({ [`workflows/${name}/README.md`]: readme(name, extra), [`workflows/${name}/workflow.json`]: workflow({ name }) });
const README = (name) => `workflows/${name}/README.md`;

/** A server with accounts and the owner's session, agent `keeper` with a folder; `files` committed on main. */
async function keeper(t, files) {
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
  await resnap(data, "keeper");
  const etag = async (file) => (await api("GET", `/agents/keeper/learning/files/${encodeURIComponent(file)}`)).headers.get("etag");
  const owner = (action) => async (file) => call(port, { method: "POST", path: `/v2/agents/keeper/learning/files/${encodeURIComponent(file)}/${action}`, headers: { ...json, cookie, origin, "if-match": await etag(file) }, body: {} });
  const retire = async (file) => {
    const res = await api("POST", `/agents/keeper/learning/files/${encodeURIComponent(file)}/retire`, undefined, { "if-match": await etag(file) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };
  const flowOf = async (name) => (await api("GET", "/agents/keeper/learning")).body.workflows.find((item) => item.name === name);
  const laid = async () => (await seedOf(data, "keeper")).workflows.map(({ name }) => name);
  return { ...server, repo, restore: owner("restore"), approve: owner("approve"), retire, etag, flowOf, laid };
}

test("a held draft retired and restored waits for its owner's OK again: never active, never given to a run, the restore no approval; only the OK makes it active", { timeout: 150_000 }, async (t) => {
  const { repo, restore, approve, retire, flowOf, laid } = await keeper(t, { ...draft("share-files", "status: pending\n"), ...draft("answer-in-tables") });
  await retire(README("share-files"));
  assert.match(git(repo, ["show", `main:${README("share-files")}`]), /status: retired\nretired_from: pending\n/, "its retire records it waited");
  assert.deepEqual([(await flowOf("share-files")).status, (await flowOf("share-files")).retired?.from], ["retired", "pending"], "the view says it goes back to waiting");
  const restored = await restore(README("share-files"));
  assert.equal(restored.status, 200, restored.text);
  assert.match(restored.text, /status: pending/);
  assert.doesNotMatch(restored.text, /retired_from/);
  assert.equal((await flowOf("share-files")).status, "pending");
  assert.deepEqual(await laid(), ["answer-in-tables"], "no run is given it");
  assert.doesNotMatch(git(repo, ["log", "-1", "--format=%B", "main"]), /Approved-Via/, "a restore is no approval");
  const approved = await approve(README("share-files"));
  assert.equal(approved.status, 200, approved.text);
  assert.equal((await flowOf("share-files")).status, "checking", "given to runs, not serving until its check promotes it");
  assert.deepEqual((await laid()).sort(), ["answer-in-tables", "share-files"]);
});

test("an active draft retired and restored is active again: its retire recorded it was active", { timeout: 150_000 }, async (t) => {
  const { restore, retire, flowOf, laid } = await keeper(t, draft("answer-in-tables"));
  await retire(README("answer-in-tables"));
  assert.equal((await flowOf("answer-in-tables")).retired?.from, "active");
  assert.deepEqual(await laid(), []);
  assert.equal((await restore(README("answer-in-tables"))).status, 200);
  assert.equal((await flowOf("answer-in-tables")).status, "checking");
  assert.deepEqual(await laid(), ["answer-in-tables"]);
});

test("a retired draft whose retire recorded no status restores waiting for its owner's OK (fail closed)", { timeout: 150_000 }, async (t) => {
  const { restore, flowOf } = await keeper(t, draft("share-files", "status: retired\n"));
  assert.equal((await flowOf("share-files")).retired?.from, "pending");
  assert.equal((await restore(README("share-files"))).status, 200);
  assert.equal((await flowOf("share-files")).status, "pending");
});

test("a run never sets a status or retired_from in a draft's README: the host writes it from the block's name and description alone, and a README that records a retire is refused", () => {
  for (const extra of ["status: active\n", "status: pending\n", "retired_from: active\n", "status: retired\nretired_from: active\n"]) {
    const { readme: written } = draftFiles("share-files", `---\ndescription: Sends any file to whoever asks\n${extra}---\n${workflow({ name: "share-files" })}`);
    assert.equal(written, readmeOf("share-files", "Sends any file to whoever asks"), extra);
  }
  const problems = checkDraft({ changes: [added(README("share-files"), readme("share-files", "retired_from: active\n")), added("workflows/share-files/workflow.json", workflow({ name: "share-files" }))], dsl, tools: [] });
  assert.ok(problems.some((problem) => problem.rule === "front_matter" && /retired_from/.test(problem.detail)), JSON.stringify(problems));
});

test("a run's merge never writes over a draft a person held since its seed: a conflict, nothing written", async (t) => {
  const { learningCommit } = await import("../dist/learn/commit.js");
  const { readSnapshot } = await import("../dist/learn/folder.js");
  const { learningWorkspace } = await import("../dist/workspace/index.js");
  const { agentFolderOf } = await import("../dist/files.js");
  const { scratch } = await import("./support.mjs");
  const data = await scratch(t);
  await seedOf(data, "agent-1");
  const repo = join(agentFolderOf(data, "agent-1"), "learning");
  const put = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git(repo, ["add", "--", ...Object.keys(files)]);
    git(repo, ["commit", "-q", "-m", message]);
  };
  put(draft("share-files"), "the folder");
  await resnap(data, "agent-1");
  const seed = git(repo, ["rev-parse", "main"]).trim();
  // Since the run's seed, its owner held the draft (as a retire and a restore of a held one leaves it).
  put({ [README("share-files")]: readme("share-files", "status: pending\n") }, "held by its owner");
  await resnap(data, "agent-1");
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const over = await learningCommit(folder.workspace, { runId: "run-m2", reason: "x", files: [{ path: README("share-files"), text: readme("share-files") }, { path: "workflows/share-files/workflow.json", text: workflow({ name: "share-files", node: "extract" }) }], seed });
    assert.deepEqual([over.ok, over.reason], [false, "conflict"], JSON.stringify(over));
    const snapshot = await readSnapshot(folder.workspace);
    assert.equal(snapshot.workflows.find((one) => one.name === "share-files")?.status, "pending");
  } finally {
    await folder.end();
  }
});

// A draft's retired_from is read by the one front-matter reader (frontMatter, #2255): its quoting decoded one way, and
// only on one plain line, as its status is. Only `active` read that way restores active; anything else is held again
// (fail closed), and one the writer could not take out whole is refused, never half-edited.
test("a draft's retired_from is read by the one front-matter reader: only a plain or quoted active restores active; an unclear one restores held, one on two lines is refused", async () => {
  const { learnedStatus, restorable, restoredLearned, retiredFrom, retiredLearned } = await import("../dist/learn/workflow-draft.js");
  const retired = (extra) => `---\nname: tables\ndescription: Answer comparisons with a table\nstatus: retired\n${extra}---\n`;
  const back = (text) => learnedStatus(restoredLearned(text));
  assert.equal(back(retired("retired_from: active\n")), "active", "recorded active: back active");
  assert.equal(back(retired('retired_from: "active"\n')), "active", "quoted, as the reader decodes it");
  assert.equal(back(retired("retired_from: pending\n")), "pending", "recorded pending: held again");
  assert.equal(back(retired("")), "pending", "none recorded: held (fail closed)");
  for (const unclear of ["retired_from: activ\n", "retired_from: Active\n", 'retired_from: ""\n', "retired_from: active pending\n"]) {
    assert.equal(retiredFrom(retired(unclear)), "pending", unclear);
    assert.equal(back(retired(unclear)), "pending", `${unclear}: never active`);
  }
  // On more than one line no writer takes it out whole: refused, never restored at all.
  for (const split of ["retired_from: >\n  active\n", "retired_from:\n  active\n", 'retired_from: "act\n  ive"\n']) {
    assert.equal(retiredFrom(retired(split)), "pending", split);
    assert.equal(restorable(retired(split)), false, split);
    assert.throws(() => restoredLearned(retired(split)), /not one plain line/, split);
  }
  // A retire records what it was, read one way: active only when it read active; held, or already retired, records pending.
  const active = "---\nname: tables\ndescription: Answer comparisons with a table\n---\n";
  assert.equal(retiredFrom(retiredLearned(active)), "active");
  assert.equal(retiredFrom(retiredLearned(active.replace("\n---\n", "\nstatus: pending\n---\n"))), "pending");
  assert.equal(retiredFrom(retiredLearned(retired("retired_from: active\n"))), "pending", "a retire of what reads retired never records active");
  assert.equal(learnedStatus(retiredLearned(active)), "retired");
});
