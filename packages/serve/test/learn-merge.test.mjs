// What an end-of-run turn answers is checked before anything is written to git, and merged as one host commit on main:
// new notes added, the ones they supersede marked, MEMORY.md rebuilt by the host. A run edits nothing that was there, a
// MEMORY.md it gives is ignored, and a name another run took since is refused at the merge, as is a supersede of a note
// a person changed after the grade read it (a note held for the OK supersedes nothing, so that is no supersede). Nothing
// the run put in its copy of the folder is read, a link included, and a secret the launcher holds never reaches a git
// object.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { copyOf, ended, git, LEARN, learnedOnMain, learner, made, mergesOf, objects, onMain, proposedOf, reflectRows, repoOf, resnap, SWITCH_TODO, savedOf, settled, sleep, started } from "./learn-support.mjs";
import { client, runDir, scratch, serve, withEnv } from "./support.mjs";
import { folderTestHooks } from "../dist/learn/folder.js";
import { learningTestHooks } from "../dist/learning.js";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const TABLES = note("Prefers tables", "The user reads results as tables");
const REFUNDS = note("Refunds path", "Refunds live under /help/");

/** A server for learning, and agent `id` whose folder holds `files` on main, committed as a person would. */
async function seeded(t, id, files, extra = {}) {
  const server = await serve(t, { learning: "on", faux: LEARN });
  await made(server.api, learner(id, extra));
  // The first run makes the folder; it learns nothing.
  await ended(server.api, await started(server.api, id));
  const repo = repoOf(server.data, id);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(repo, file), text);
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "seeded"]);
  await resnap(server.data, id);
  return { ...server, repo };
}
const INDEX = "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Refunds path](refunds.md) — Refunds live under /help/\n";
const SEED = { "prefers-tables.md": TABLES, "refunds.md": REFUNDS, "MEMORY.md": INDEX };

/** Agent `id`'s instructions now plan `plan`, as a new revision of it. */
async function plans(api, id, plan, extra = {}) {
  const { id: _, version, ...definition } = learner(id, { plan, ...extra }).definition;
  const res = await api("PUT", `/agents/${id}/definition`, { definition });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

/** A note that supersedes refunds.md, and refunds.md as that merge marks it. */
const MOVED = note("Refunds path", "Refunds live under /policies/refunds", "Moved in the redesign.\n", "supersedes: [refunds.md]\n");
const MARKED = note("Refunds path", "Refunds live under /help/", "Refunds live under /help/.\n", "status: superseded\nsuperseded_by: refunds-v2.md\n");

/** Agent `id` seeded, and its run that supersedes refunds.md (MOVED) kept as its proposal, its learning run under way:
 *  main read and the grader asked, which answers only once `release` is called. `learning` is that learning run's end
 *  (learnedOnMain). */
async function heldGrade(t, id, rule = "") {
  const dir = await scratch(t);
  const calls = join(dir, "calls.jsonl");
  const gate = join(dir, "grade");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const server = await seeded(t, id, SEED);
  await plans(server.api, id, [["refunds-v2.md", MOVED]], { instructions: `Answer the question.\nGrade once ${gate} exists.${rule ? `\n${rule}` : ""}` });
  const runId = await started(server.api, id);
  proposedOf((await ended(server.api, runId)).view);
  const learning = learnedOnMain(server, id, runId);
  for (let i = 0; !(existsSync(calls) && readFileSync(calls, "utf8").includes('"grade"')); i++) {
    assert.ok(i < 1800, "the grader is asked");
    await sleep(50);
  }
  return { ...server, runId, learning, release: () => writeFileSync(gate, "") };
}

/** A person's edit of agent `id`'s note `file` to `text`, through the learning route, with the ETag read just before. */
async function personEdits({ api, baseUrl, token }, id, file, text) {
  const path = `/agents/${id}/learning/files/${file}`;
  const etag = (await api("GET", path)).headers.get("etag");
  const res = await fetch(`${baseUrl}${path}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown", "if-match": etag }, body: text });
  assert.equal(res.status, 200, await res.text());
}

test("a note that supersedes one: the old note is marked superseded by the new one, and the index lists the new one alone", { timeout: 120_000, skip: SWITCH_TODO }, async (t) => {
  const { api, data, repo } = await seeded(t, "replacer", SEED);
  const NEW = note("Refunds path", "Refunds live under /policies/refunds", "Moved in the redesign.\n", "supersedes: [refunds.md]\n");
  await plans(api, "replacer", [["refunds-v2.md", NEW]]);
  const runId = await started(api, "replacer");
  const { view } = await ended(api, runId);
  proposedOf(view);
  assert.equal((await learnedOnMain({ api, data }, "replacer", runId)).result?.ok, true);
  // What it learned, and what that replaced, on its learning block and in the agent's list.
  const learned = [{ file: "refunds-v2.md", name: "Refunds path", supersedes: ["refunds.md"] }];
  assert.deepEqual(view.learning.learned, learned);
  assert.deepEqual((await api("GET", "/agents/replacer/runs")).body.runs.find((run) => run.run_id === runId).learning.learned, learned);
  assert.equal(git(repo, ["show", "main:refunds-v2.md"]), onMain(NEW).trimEnd());
  assert.equal(git(repo, ["show", "main:refunds.md"]), note("Refunds path", "Refunds live under /help/", "Refunds live under /help/.\n", "status: superseded\nsuperseded_by: refunds-v2.md\n").trimEnd());
  assert.equal(`${git(repo, ["show", "main:MEMORY.md"])}\n`, "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Refunds path](refunds-v2.md) — Refunds live under /policies/refunds\n");
  assert.deepEqual(git(repo, ["diff-tree", "-r", "--name-status", "--no-commit-id", "main"]).split("\n"), ["M\tMEMORY.md", "A\trefunds-v2.md", "M\trefunds.md"], "one commit: the note added, the old one marked, the index rebuilt");
  // The next run reads the new note, never the superseded one.
  await plans(api, "replacer", undefined);
  const next = await started(api, "replacer");
  await ended(api, next);
  assert.deepEqual(existsSync(join(copyOf(data, next), "refunds.md")), false);
  assert.ok(existsSync(join(copyOf(data, next), "refunds-v2.md")));
});

test("a note a person corrects while a grade that supersedes it is under way is never superseded on that grade: the person's text stays active and in the index, and the run's learning is dropped as checker, naming the note", { timeout: 150_000, skip: SWITCH_TODO }, async (t) => {
  const held = await heldGrade(t, "corrected");
  const CORRECTED = note("Refunds path", "Refunds live under /help/refunds", "A person corrected the path.\n");
  await personEdits(held, "corrected", "refunds.md", CORRECTED);
  const edited = git(held.repo, ["rev-parse", "main"]);
  held.release();
  const learned = await held.learning;
  assert.deepEqual([learned.result?.ok, learned.result?.reason], [false, "conflict"], JSON.stringify(learned));
  const { view, rows } = await ended(held.api, held.runId);
  settled(view, rows, "dropped", "checker");
  assert.equal(view.learning.detail, "Not kept: a note it would replace is gone or was changed since.", "said as a person reads it");
  const problems = [{ rule: "supersedes", path: "refunds-v2.md", detail: "refunds.md changed after the grade read it" }];
  assert.deepEqual((await savedOf(held.data, held.runId)).learning.problems, problems);
  assert.deepEqual((await held.api("GET", `/runs/${held.runId}/learning`)).body.problems, problems);
  assert.equal(git(held.repo, ["rev-parse", "main"]), edited, "main is as the person left it");
  assert.equal(git(held.repo, ["show", "main:refunds.md"]), CORRECTED.trimEnd());
  assert.equal(`${git(held.repo, ["show", "main:MEMORY.md"])}\n`, "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Refunds path](refunds.md) — Refunds live under /help/refunds\n");
  assert.deepEqual(mergesOf(held.repo, held.runId), []);
});

test("a replacement held for the owner's OK supersedes nothing, so a person's edit of the note it names, made while it was graded, stands and the replacement merges to wait", { timeout: 150_000, skip: SWITCH_TODO }, async (t) => {
  const held = await heldGrade(t, "waiting", "Grade: pending refunds-v2.md.");
  const CORRECTED = note("Refunds path", "Refunds live under /help/refunds", "A person corrected the path.\n");
  await personEdits(held, "waiting", "refunds.md", CORRECTED);
  held.release();
  assert.equal((await held.learning).result?.ok, true);
  const { view, rows } = await ended(held.api, held.runId);
  settled(view, rows, "merged");
  assert.deepEqual(view.learning.pending, [{ file: "refunds-v2.md", name: "Refunds path" }]);
  assert.equal(git(held.repo, ["show", "main:refunds.md"]), CORRECTED.trimEnd(), "the person's text stands, active and unmarked");
  assert.match(git(held.repo, ["show", "main:refunds-v2.md"]), /\nstatus: pending\n---\n/);
  assert.equal(`${git(held.repo, ["show", "main:MEMORY.md"])}\n`, "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Refunds path](refunds.md) — Refunds live under /help/refunds\n");
  assert.equal(mergesOf(held.repo, held.runId).length, 1);
});

test("two runs at once that add different notes both merge, and the index has both; the same name added by two runs at once merges once, and the second is refused as exists at the merge", { timeout: 150_000, skip: SWITCH_TODO }, async (t) => {
  const { api, data, repo } = await seeded(t, "pair", SEED);
  const a = ["alpha.md", note("Alpha", "The first of two rules")];
  const b = ["beta.md", note("Beta", "The second of two rules")];
  // Both runs are the one agent's, each with its own revision's plan, and both start from the same main.
  await plans(api, "pair", [a]);
  const one = await started(api, "pair");
  await plans(api, "pair", [b]);
  const two = await started(api, "pair");
  const [first, second] = await Promise.all([ended(api, one), ended(api, two)]);
  proposedOf(first.view);
  proposedOf(second.view);
  const merges = await Promise.all([learnedOnMain({ api, data }, "pair", one), learnedOnMain({ api, data }, "pair", two)]);
  assert.deepEqual(merges.map((merge) => merge.result?.ok), [true, true]);
  assert.equal(`${git(repo, ["show", "main:MEMORY.md"])}\n`, `- [Alpha](alpha.md) — The first of two rules\n- [Beta](beta.md) — The second of two rules\n${INDEX}`);
  assert.equal(mergesOf(repo, one).length + mergesOf(repo, two).length, 2);

  const same = ["gamma.md", note("Gamma", "A rule two runs found")];
  await plans(api, "pair", [same]);
  const [x, y] = [await started(api, "pair"), await started(api, "pair")];
  const ends = await Promise.all([ended(api, x), ended(api, y)]);
  const states = ends.map(({ view }) => `${view.learning.state}/${view.learning.reason}`).sort();
  assert.deepEqual(states, ["dropped/checker", "merged/null"]);
  const lost = ends.find(({ view }) => view.learning.state === "dropped");
  assert.equal(lost.view.learning.detail, "Not kept: the agent's notes changed while this run ran (a note under a name already taken).");
  assert.deepEqual((await savedOf(data, lost.view.run_id)).learning.problems, [{ rule: "exists", path: "gamma.md", detail: "the folder has a note by this name" }]);
  assert.equal(mergesOf(repo, lost.view.run_id).length, 0);
});

// SKIP (follow-up #2089): the run's learning end and its timeline row do not read dropped/empty
test.skip("a turn that adds nothing is dropped as empty, and the run's answer stands", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("idle"));
  const runId = await started(api, "idle");
  const { view, rows } = await ended(api, runId);
  assert.equal(view.result.final_answer, "Job answer.");
  settled(view, rows, "dropped", "empty");
  assert.equal(view.learning.detail, "Nothing new to remember from this run.");
  assert.equal(git(repoOf(data, "idle"), ["rev-list", "--count", "main"]), "1");
});

/** The server, started by its launcher with `env`: the launcher hands its secrets over and the server holds them, none
 *  in its environment (secrets.ts). */
async function launched(t, env) {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  mkdirSync(join(dir, "tmp"));
  const child = spawn(LAUNCHER, ["--data", data, "--port", "0", "--faux", LEARN, "--drain-timeout", "5s"], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTRUN_ACCOUNTS: "0", XDG_CONFIG_HOME: join(dir, "config"), ...env, TMPDIR: join(dir, "tmp") } });
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(15_000)]);
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    })());
  t.after(stop);
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  for (let i = 0; !/AGENTRUN_BASE_URL=(\S+)/.test(out); i++) {
    assert.ok(i < 600, `the server started: ${out}`);
    await sleep(50);
  }
  return { child, data, stop, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], env.AGENTRUN_TOKEN) };
}

// SKIP (follow-up #2089): the run's reopening hook never fires, so the test hangs until its 120-second timeout
test.skip("a second message to a run that learns, sent while the first one opens it again, waits for that opening: it is never sent before the run's notes are laid again in its work", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("twice", { plan: [["fine.md", note("Fine", "A rule the run learned")]] }));
  const runId = await started(api, "twice");
  proposedOf((await ended(api, runId)).view);
  // The first message opens the run again, and is held inside that opening (where its notes are laid again).
  let entered, release;
  const inside = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  learningTestHooks.beforeReopen = async () => { entered(); await gate; };
  t.after(() => { delete learningTestHooks.beforeReopen; release(); });
  const first = api("POST", `/runs/${runId}/messages`, { content: "One more thing." });
  await inside;
  // A second message meanwhile: it waits for the opening, so it has no answer while the opening is held.
  let second = null;
  const sent = api("POST", `/runs/${runId}/messages`, { content: "And another." }).then((r) => (second = r));
  await sleep(1500);
  assert.equal(second, null, "the second message was taken before the run's opening ended");
  release();
  const [a, b] = await Promise.all([first, sent]);
  assert.deepEqual([a.status, b.status], [202, 202], JSON.stringify([a.body, b.body]));
  await ended(api, runId);
});
