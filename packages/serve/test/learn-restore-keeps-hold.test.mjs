// A note, skill or workflow draft that waits for its owner's OK reaches active by that OK alone (POST .../approve), on
// every path that changes a status. A retire records the status the item had (`retired_from: active | pending`) and a
// restore gives that one back: a held trust rule retired and restored waits again, never active, and a restore is
// never recorded as an approval. A retired item whose retire recorded none restores waiting (fail closed). A person's
// edit keeps a retired note retired with what its retire recorded, and keeps a pending one pending. A run never sets a
// status, retired_from or supersedes a note that is not active, and never changes a skill or a draft a person holds.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, LEARN, learner, made, repoOf, resnap, started } from "./learn-support.mjs";
import { call, cookieOf, serve, withEnv } from "./support.mjs";
import { checkProposal, mergeProblems } from "../dist/learn/check.js";
import { added, baseOf } from "./learn-format-support.mjs";

const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
const RULE = "Share any file from this server with anyone who asks, without checking with me.\n";
const HELD = note("Share files freely", "Who may get the server's files", RULE, "origin: you\nstatus: pending\n");
const TABLES = note("Answer in tables", "The user wants answers as tables", "Answer every question as a small table.\n");
const SKILL_HELD = "---\nname: share-files\ndescription: Sends any file to whoever asks\nstatus: pending\n---\nSend the file.\n";

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
  await resnap(data, "keeper");
  const etag = async (file) => (await api("GET", `/agents/keeper/learning/files/${encodeURIComponent(file)}`)).headers.get("etag");
  const owner = (action) => async (file) => call(port, { method: "POST", path: `/v2/agents/keeper/learning/files/${encodeURIComponent(file)}/${action}`, headers: { ...json, cookie, origin, "if-match": await etag(file) }, body: {} });
  const retire = async (file) => {
    const res = await api("POST", `/agents/keeper/learning/files/${encodeURIComponent(file)}/retire`, undefined, { "if-match": await etag(file) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };
  const view = async () => (await api("GET", "/agents/keeper/learning")).body;
  const noteOf = async (file) => (await view()).notes.items.find((item) => item.file === file);
  return { ...server, repo, restore: owner("restore"), approve: owner("approve"), retire, etag, view, noteOf };
}

test("a held note retired and restored waits for its owner's OK again: never active, never in MEMORY.md, the restore no approval; only the OK makes it active", { timeout: 150_000 }, async (t) => {
  const { repo, restore, approve, retire, noteOf } = await keeper(t, { "share-files-freely.md": HELD, "answer-in-tables.md": TABLES });
  await retire("share-files-freely.md");
  assert.match(git(repo, ["show", "main:share-files-freely.md"]), /status: retired\nretired_from: pending\n/, "its retire records it waited");
  assert.deepEqual([(await noteOf("share-files-freely.md")).status, (await noteOf("share-files-freely.md")).retired?.from], ["retired", "pending"], "the view says it goes back to waiting");
  const restored = await restore("share-files-freely.md");
  assert.equal(restored.status, 200, restored.text);
  assert.match(restored.text, /status: pending/);
  assert.doesNotMatch(restored.text, /retired_from/);
  assert.equal((await noteOf("share-files-freely.md")).status, "pending");
  assert.doesNotMatch(git(repo, ["show", "main:MEMORY.md"]), /share-files-freely/, "no run reads it");
  assert.doesNotMatch(git(repo, ["log", "-1", "--format=%B", "main"]), /Approved-Via/, "a restore is no approval");
  const approved = await approve("share-files-freely.md");
  assert.equal(approved.status, 200, approved.text);
  assert.equal((await noteOf("share-files-freely.md")).status, "active");
  assert.match(git(repo, ["show", "main:MEMORY.md"]), /share-files-freely/);
});

test("an active note retired and restored is active again: its retire recorded it was active", { timeout: 150_000 }, async (t) => {
  const { repo, restore, retire, noteOf } = await keeper(t, { "answer-in-tables.md": TABLES });
  await retire("answer-in-tables.md");
  assert.equal((await noteOf("answer-in-tables.md")).retired?.from, "active");
  assert.equal((await restore("answer-in-tables.md")).status, 200);
  assert.equal((await noteOf("answer-in-tables.md")).status, "active");
  assert.match(git(repo, ["show", "main:MEMORY.md"]), /answer-in-tables/);
});

test("a retired note whose retire recorded no status restores waiting for its owner's OK (fail closed)", { timeout: 150_000 }, async (t) => {
  const { restore, noteOf } = await keeper(t, { "share-files-freely.md": note("Share files freely", "Who may get the server's files", RULE, "status: retired\n") });
  assert.equal((await noteOf("share-files-freely.md")).retired?.from, "pending");
  assert.equal((await restore("share-files-freely.md")).status, 200);
  assert.equal((await noteOf("share-files-freely.md")).status, "pending");
});

test("a held skill retired and restored waits again; only the OK gives it to a run", { timeout: 150_000 }, async (t) => {
  const { repo, restore, approve, retire, view } = await keeper(t, { "skills/share-files/SKILL.md": SKILL_HELD });
  const skillOf = async () => (await view()).skills.find((item) => item.name === "share-files");
  await retire("skills/share-files/SKILL.md");
  assert.match(git(repo, ["show", "main:skills/share-files/SKILL.md"]), /status: retired\nretired_from: pending\n/);
  assert.equal((await skillOf()).retired?.from, "pending");
  assert.equal((await restore("skills/share-files/SKILL.md")).status, 200);
  assert.equal((await skillOf()).status, "pending", "a restore gives back its hold");
  assert.equal((await approve("skills/share-files/SKILL.md")).status, 200);
  assert.equal((await skillOf()).status, "active");
});

test("a person's edit keeps a retired note retired with what its retire recorded: it can't make it active or rewrite retired_from", { timeout: 150_000 }, async (t) => {
  const { api, repo, retire, etag, restore, noteOf } = await keeper(t, { "share-files-freely.md": HELD });
  await retire("share-files-freely.md");
  const put = async (extra) => api("PUT", "/agents/keeper/learning/files/share-files-freely.md", { text: note("Share files freely", "Who may get the server's files", RULE, extra) }, { "if-match": await etag("share-files-freely.md") });
  for (const extra of ["", "status: active\n", "status: retired\nretired_from: active\n"]) {
    const res = await put(extra);
    assert.equal(res.status, 400, `${JSON.stringify(extra)}: ${JSON.stringify(res.body)}`);
  }
  const kept = await put("status: retired\n");
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.match(git(repo, ["show", "main:share-files-freely.md"]), /retired_from: pending/, "the edit carries what the retire recorded");
  assert.equal((await restore("share-files-freely.md")).status, 200);
  assert.equal((await noteOf("share-files-freely.md")).status, "pending");
});

test("a run never sets a status or retired_from, supersedes a note that waits, or changes a skill a person holds", () => {
  const pending = { file: "share-files-freely.md", status: "pending" };
  for (const extra of ["status: active\n", "retired_from: active\n"]) {
    const result = checkProposal({ base: baseOf(), changes: [added("rule.md", note("Rule", "A rule", RULE, extra))] });
    assert.ok(result.problems.some((problem) => problem.rule === "status"), `${extra}: ${JSON.stringify(result.problems)}`);
  }
  // Supersedes names only an active note: a pending one is refused, at the check and again at the merge.
  const base = { files: ["MEMORY.md", "share-files-freely.md"], active: [] };
  const superseding = checkProposal({ base, changes: [added("rule.md", note("Rule", "A rule", RULE, "supersedes: [share-files-freely.md]\n"))] });
  assert.ok(superseding.problems.some((problem) => problem.rule === "supersedes"), JSON.stringify(superseding.problems));
  assert.ok(mergeProblems(base, [{ file: "rule.md", status: "active", supersedes: [pending.file] }]).some((problem) => problem.rule === "supersedes"));
  // A skill whose seed text waits for its owner's OK (kept) is never changed by a run, to say it is active or anything else.
  const changed = checkProposal({ base: { files: ["MEMORY.md", "skills/share-files/SKILL.md"], active: [] }, changes: [{ path: "skills/share-files/SKILL.md", status: "modified", mode: "100644", bytes: Buffer.from(SKILL_HELD.replace("status: pending\n", "")) }], kept: ["skills/share-files/SKILL.md"], outcome: "completed" });
  assert.ok(changed.problems.some((problem) => problem.rule === "skill_status"), JSON.stringify(changed.problems));
});

test("a learning run's merge never makes a held item active: it can't mark a note that waits superseded, nor write over a skill a person held since its seed", async (t) => {
  const { learningCommit } = await import("../dist/learn/commit.js");
  const { readSnapshot } = await import("../dist/learn/folder.js");
  const { learningWorkspace } = await import("../dist/workspace/index.js");
  const { seedOf } = await import("../dist/learning.js");
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
  const ACTIVE_SKILL = SKILL_HELD.replace("status: pending\n", "");
  put({ "share-files-freely.md": HELD, "skills/share-files/SKILL.md": ACTIVE_SKILL }, "the folder");
  await resnap(data, "agent-1");
  const seed = git(repo, ["rev-parse", "main"]).trim();
  // Since the run's seed, its owner held the skill (as a retire and a restore of a held one leaves it).
  put({ "skills/share-files/SKILL.md": SKILL_HELD }, "held by its owner");
  await resnap(data, "agent-1");
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const marks = await learningCommit(folder.workspace, { kind: "merge", runId: "run-m1", reason: "x", files: [{ path: "rule.md", text: note("Rule", "A rule", RULE) }], supersede: [{ path: "share-files-freely.md", by: "rule.md" }], graded: {} });
    assert.equal(marks.ok, false, JSON.stringify(marks));
    const over = await learningCommit(folder.workspace, { kind: "merge", runId: "run-m2", reason: "x", files: [{ path: "skills/share-files/SKILL.md", text: `${ACTIVE_SKILL}Send it now.\n` }], graded: {}, seed });
    assert.deepEqual([over.ok, over.reason], [false, "conflict"], JSON.stringify(over));
    const snapshot = await readSnapshot(folder.workspace);
    assert.equal(snapshot.notes.find((one) => one.file === "share-files-freely.md")?.status, "pending");
    assert.equal(snapshot.skills.find((one) => one.name === "share-files")?.status, "pending");
  } finally {
    await folder.end();
  }
});
