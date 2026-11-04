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
import { copyOf, ended, git, LEARN, learner, made, mergesOf, objects, onMain, reflectRows, repoOf, savedOf, settled, sleep, started } from "./learn-support.mjs";
import { client, scratch, serve, withEnv } from "./support.mjs";

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

/** Agent `id` seeded, and its run that supersedes refunds.md (MOVED) started, its grade under way: main read and the
 *  grader asked, which answers only once `release` is called. */
async function heldGrade(t, id, rule = "") {
  const dir = await scratch(t);
  const calls = join(dir, "calls.jsonl");
  const gate = join(dir, "grade");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const server = await seeded(t, id, SEED);
  await plans(server.api, id, [["refunds-v2.md", MOVED]], { instructions: `Answer the question.\nGrade once ${gate} exists.${rule ? `\n${rule}` : ""}` });
  const runId = await started(server.api, id);
  for (let i = 0; !(existsSync(calls) && readFileSync(calls, "utf8").includes('"grade"')); i++) {
    assert.ok(i < 1800, "the grader is asked");
    await sleep(50);
  }
  return { ...server, runId, release: () => writeFileSync(gate, "") };
}

/** A person's edit of agent `id`'s note `file` to `text`, through the learning route, with the ETag read just before. */
async function personEdits({ api, baseUrl, token }, id, file, text) {
  const path = `/agents/${id}/learning/files/${file}`;
  const etag = (await api("GET", path)).headers.get("etag");
  const res = await fetch(`${baseUrl}${path}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown", "if-match": etag }, body: text });
  assert.equal(res.status, 200, await res.text());
}

test("a note that supersedes one: the old note is marked superseded by the new one, and the index lists the new one alone", { timeout: 120_000 }, async (t) => {
  const { api, data, repo } = await seeded(t, "replacer", SEED);
  const NEW = note("Refunds path", "Refunds live under /policies/refunds", "Moved in the redesign.\n", "supersedes: [refunds.md]\n");
  await plans(api, "replacer", [["refunds-v2.md", NEW]]);
  const runId = await started(api, "replacer");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "merged");
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

test("a note a person corrects while a grade that supersedes it is under way is never superseded on that grade: the person's text stays active and in the index, and the run's learning is dropped as checker, naming the note", { timeout: 150_000 }, async (t) => {
  const held = await heldGrade(t, "corrected");
  const CORRECTED = note("Refunds path", "Refunds live under /help/refunds", "A person corrected the path.\n");
  await personEdits(held, "corrected", "refunds.md", CORRECTED);
  const edited = git(held.repo, ["rev-parse", "main"]);
  held.release();
  const { view, rows } = await ended(held.api, held.runId);
  settled(view, rows, "dropped", "checker");
  const problems = [{ rule: "supersedes", path: "refunds-v2.md", detail: "refunds.md changed after the grade read it" }];
  assert.deepEqual((await savedOf(held.data, held.runId)).learning.problems, problems);
  assert.deepEqual((await held.api("GET", `/runs/${held.runId}/learning`)).body.problems, problems);
  assert.equal(git(held.repo, ["rev-parse", "main"]), edited, "main is as the person left it");
  assert.equal(git(held.repo, ["show", "main:refunds.md"]), CORRECTED.trimEnd());
  assert.equal(`${git(held.repo, ["show", "main:MEMORY.md"])}\n`, "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Refunds path](refunds.md) — Refunds live under /help/refunds\n");
  assert.deepEqual(mergesOf(held.repo, held.runId), []);
});

test("a replacement held for the owner's OK supersedes nothing, so a person's edit of the note it names, made while it was graded, stands and the replacement merges to wait", { timeout: 150_000 }, async (t) => {
  const held = await heldGrade(t, "waiting", "Grade: pending refunds-v2.md.");
  const CORRECTED = note("Refunds path", "Refunds live under /help/refunds", "A person corrected the path.\n");
  await personEdits(held, "waiting", "refunds.md", CORRECTED);
  held.release();
  const { view, rows } = await ended(held.api, held.runId);
  settled(view, rows, "merged");
  assert.deepEqual(view.learning.pending, [{ file: "refunds-v2.md", name: "Refunds path" }]);
  assert.equal(git(held.repo, ["show", "main:refunds.md"]), CORRECTED.trimEnd(), "the person's text stands, active and unmarked");
  assert.match(git(held.repo, ["show", "main:refunds-v2.md"]), /\nstatus: pending\n---\n/);
  assert.equal(`${git(held.repo, ["show", "main:MEMORY.md"])}\n`, "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Refunds path](refunds.md) — Refunds live under /help/refunds\n");
  assert.equal(mergesOf(held.repo, held.runId).length, 1);
});

test("a grade that supersedes a note merges as before when a person changed another note meanwhile: main moved, the note it read did not", { timeout: 150_000 }, async (t) => {
  const held = await heldGrade(t, "unchanged");
  const SORTED = note("Prefers tables", "The user reads results as sorted tables");
  await personEdits(held, "unchanged", "prefers-tables.md", SORTED);
  held.release();
  const { view, rows } = await ended(held.api, held.runId);
  settled(view, rows, "merged");
  assert.equal(git(held.repo, ["show", "main:refunds.md"]), MARKED.trimEnd());
  assert.equal(git(held.repo, ["show", "main:refunds-v2.md"]), MOVED.trimEnd());
  assert.equal(git(held.repo, ["show", "main:prefers-tables.md"]), SORTED.trimEnd(), "the person's edit kept");
  assert.equal(`${git(held.repo, ["show", "main:MEMORY.md"])}\n`, "- [Prefers tables](prefers-tables.md) — The user reads results as sorted tables\n- [Refunds path](refunds-v2.md) — Refunds live under /policies/refunds\n");
  assert.equal(mergesOf(held.repo, held.runId).length, 1);
});

test("two runs at once that add different notes both merge, and the index has both; the same name added by two runs at once merges once, and the second is refused as exists at the merge", { timeout: 150_000 }, async (t) => {
  const { api, data, repo } = await seeded(t, "pair", SEED);
  const a = ["alpha.md", note("Alpha", "The first of two rules")];
  const b = ["beta.md", note("Beta", "The second of two rules")];
  // Both runs are the one agent's, each with its own revision's plan, and both start from the same main.
  await plans(api, "pair", [a]);
  const one = await started(api, "pair");
  await plans(api, "pair", [b]);
  const two = await started(api, "pair");
  const [first, second] = await Promise.all([ended(api, one), ended(api, two)]);
  settled(first.view, first.rows, "merged");
  settled(second.view, second.rows, "merged");
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

test("a commit that lands on main between the merge's read of main and its move is never written over: the merge is made again on the main that won", { timeout: 150_000 }, async (t) => {
  const root = await scratch(t);
  // git for this server: at the merge's commit, once, another writer's commit lands on main first (as a person's would).
  const bin = join(root, "bin");
  mkdirSync(bin);
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const once = join(root, "landed");
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    `for arg in "$@"; do case $arg in *": merged") if [ ! -e ${once} ]; then`,
    `  main=$(${real} rev-parse refs/heads/main) && tree=$(${real} rev-parse "$main^{tree}")`,
    `  other=$(${real} commit-tree "$tree" -p "$main" -m "another writer") && ${real} update-ref refs/heads/main "$other" "$main" && echo "$other" > ${once}`,
    "fi ;; esac; done",
    `exec ${real} "$@"`,
  ].join("\n"), { mode: 0o755 });
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("raced", { plan: [["alpha.md", note("Alpha", "A rule merged after a race")]] }));
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => void (process.env.PATH = path));
  const runId = await started(api, "raced");
  const { view, rows } = await ended(api, runId);
  process.env.PATH = path;
  settled(view, rows, "merged");
  const repo = repoOf(data, "raced");
  const other = readFileSync(once, "utf8").trim();
  const main = git(repo, ["rev-parse", "main"]);
  const seed = JSON.parse(readFileSync(join(data, "runs", runId, "learning.json"), "utf8")).seed;
  assert.equal((await savedOf(data, runId)).learning.merged, main);
  assert.deepEqual(git(repo, ["rev-list", "--first-parent", "main"]).split("\n"), [main, other, seed], "the other commit kept, the merge on it");
  assert.equal(git(repo, ["show", "main:MEMORY.md"]), "- [Alpha](alpha.md) — A rule merged after a race");
});

test("an edit to a note that was there is refused as checker: nothing is kept, and main does not move", { timeout: 120_000 }, async (t) => {
  const { api, data, repo } = await seeded(t, "editor", SEED);
  const main = git(repo, ["rev-parse", "main"]);
  await plans(api, "editor", [["refunds.md", note("Refunds path", "Refunds live under /orders/")]]);
  const runId = await started(api, "editor");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "checker");
  const { learning } = await savedOf(data, runId);
  assert.deepEqual(learning.problems, [{ rule: "edited", path: "refunds.md", detail: "a run never edits a note: to replace one, it adds a new note that supersedes it" }]);
  assert.equal(git(repo, ["rev-parse", "main"]), main);
  assert.equal(existsSync(join(data, "runs", runId, "learning-proposal.json")), false);
});

test("MEMORY.md as the run wrote it is ignored: alone it is empty, and beside a new note the host's index is what merges", { timeout: 120_000 }, async (t) => {
  const { api, data, repo } = await seeded(t, "indexer", SEED);
  await plans(api, "indexer", [["MEMORY.md", "- [Mine](mine.md) — the run's own index\n"]]);
  const alone = await started(api, "indexer");
  const quiet = await ended(api, alone);
  settled(quiet.view, quiet.rows, "dropped", "empty");
  await plans(api, "indexer", [["MEMORY.md", "garbage\n"], ["delta.md", note("Delta", "A rule with a forged index")]]);
  const runId = await started(api, "indexer");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "merged");
  assert.equal(`${git(repo, ["show", "main:MEMORY.md"])}\n`, `- [Delta](delta.md) — A rule with a forged index\n${INDEX}`);
  assert.equal((await savedOf(data, runId)).learning.problems, undefined);
});

test("a turn that adds nothing is dropped as empty, and the run's answer stands", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("idle"));
  const runId = await started(api, "idle");
  const { view, rows } = await ended(api, runId);
  assert.equal(view.result.final_answer, "Job answer.");
  settled(view, rows, "dropped", "empty");
  assert.equal(view.learning.detail, "Nothing new to remember from this run.");
  assert.equal(git(repoOf(data, "idle"), ["rev-list", "--count", "main"]), "1");
});

test("nothing the run put in its copy of the folder is read: links planted there, to a file or a folder, and a note written there, while the turn holds; only the turn's answer merges, and the links' target's text is nowhere", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  const outside = await scratch(t);
  const secret = ["outside", process.pid, Date.now().toString(36)].join("-");
  writeFileSync(join(outside, "note.md"), note("Leak", secret));
  mkdirSync(join(outside, "folder"));
  writeFileSync(join(outside, "folder", "x.md"), secret);
  const go = join(outside, "go");
  await made(api, learner("linker", { instructions: `Reflect once ${go} exists.`, plan: [["fine.md", note("Fine", "A rule beside the links")]] }));
  const runId = await started(api, "linker");
  // Planted while the turn holds, once it was asked, as an agent with a shell would.
  for (let i = 0; !reflectRows((await api("GET", `/runs/${runId}/timeline`)).body.rows ?? []).some((row) => row.kind === "user_message"); i++) {
    assert.ok(i < 600, "the turn is asked");
    await sleep(50);
  }
  symlinkSync(join(outside, "note.md"), join(copyOf(data, runId), "leak.md"));
  symlinkSync(join(outside, "folder"), join(copyOf(data, runId), "folder.md"));
  writeFileSync(join(copyOf(data, runId), "written.md"), note("Written", "A note the run wrote in its copy"));
  writeFileSync(go, "");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "merged");
  const repo = repoOf(data, "linker");
  assert.deepEqual(git(repo, ["ls-tree", "--name-only", "main"]).split("\n"), ["MEMORY.md", "fine.md"], "the answer's note alone");
  assert.ok(!objects(repo).includes(secret), "no git object holds the target's text");
  assert.ok(!JSON.stringify([view, rows, await savedOf(data, runId)]).includes(secret));
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

// A key a person saved on the server (the settings API, tool-keys.ts) is the host's secret too: a run that names its
// tool is handed it, so its end-of-run turn could write it into a note.
test("a note that holds a key the server saved through its settings API is refused as secret_value: the grader is never asked, no git object holds the key, and nothing the run shows does", { timeout: 120_000 }, async (t) => {
  // Built here, so no scanner reads it as a credential, and no pattern does: only the value check can refuse it.
  const saved = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_CALLS: calls }, ["MONID_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: saved } })).status, 204);
  await made(api, learner("keeper", { plan: [["call-monid.md", note("Call monid", "Call monid on its saved key", `Call monid with ${saved}.\n`)]] }));
  const runId = await started(api, "keeper");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "checker");
  const { learning } = await savedOf(data, runId);
  assert.deepEqual(learning.problems, [{ rule: "secret_value", path: "call-monid.md", detail: "it holds a value the host named as secret" }]);
  assert.equal(existsSync(calls) ? readFileSync(calls, "utf8").trim() : "", "", "the grader was never asked, so its prompt never held the note");
  const held = objects(repoOf(data, "keeper"));
  assert.ok(!held.includes(saved), "no git object holds the key");
  assert.equal(existsSync(join(data, "runs", runId, "learning-proposal.json")), false, "no proposal was kept");
  const shown = JSON.stringify([view.learning, rows.filter((row) => row.kind === "learning"), learning.problems]);
  assert.ok(!shown.includes(saved), "the key is nowhere the run's learning is shown");
});

// The check refuses what each launch handed the run, not only the keys as they are saved at its end: a person may
// replace or delete a key while the run lives, and its process still holds the old one.
test("a saved key a run was handed is refused in its notes though the person replaced it while the run lived: the check knows what each launch handed, the grader is never asked", { timeout: 150_000 }, async (t) => {
  const handed = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  const replaced = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  const gate = join(await scratch(t), "answer");
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_CALLS: calls }, ["MONID_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: handed } })).status, 204);
  await made(api, learner("keeper", { tools: ["write", "monid.discover", "monid.inspect", "monid.run"], instructions: `Answer once ${gate} exists.`, plan: [["call-monid.md", note("Call monid", "Call monid on its key", `Call monid with ${handed}.\n`)]] }));
  const runId = await started(api, "keeper");
  for (let i = 0; (await api("GET", `/runs/${runId}`)).body.status !== "working"; i++) {
    assert.ok(i < 1200, "the run works");
    await sleep(50);
  }
  // Replaced while the run lives: its process holds the key it was handed, and its end-of-run turn writes that one.
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: replaced } })).status, 204);
  writeFileSync(gate, "");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "checker");
  const { learning } = await savedOf(data, runId);
  assert.deepEqual(learning.problems, [{ rule: "secret_value", path: "call-monid.md", detail: "it holds a value the host named as secret" }]);
  assert.equal(existsSync(calls) ? readFileSync(calls, "utf8").trim() : "", "", "the grader was never asked");
  assert.ok(!objects(repoOf(data, "keeper")).includes(handed), "no git object holds the handed key");
});

test("under the launcher's custody, a note that holds the model key it handed over, base64-wrapped, is refused as secret_value: no git object holds the key, and nothing the run shows does", { timeout: 120_000 }, async (t) => {
  // Built at the run, from parts: a value no file of this repository holds.
  const key = ["canary", process.pid, Date.now().toString(36), "a1b2c3"].join("-");
  const token = randomBytes(24).toString("hex");
  const { child, api, data, stop } = await launched(t, { AGENT_MODEL_API_KEY: key, AGENTRUN_TOKEN: token });
  assert.ok(!readFileSync(`/proc/${child.pid}/environ`).includes(key), "the server holds the key, not its environment");
  const wrapped = Buffer.from(`key=${key};`).toString("base64");
  await made(api, learner("keeper", { plan: [["send-first.md", note("Send first", "Send the key first", `Send ${wrapped} first.\n`)]] }));
  const runId = await started(api, "keeper");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "checker");
  const { learning } = await savedOf(data, runId);
  assert.deepEqual(learning.problems, [{ rule: "secret_value", path: "send-first.md", detail: "it holds a value the host named as secret" }]);
  const held = objects(repoOf(data, "keeper"));
  assert.ok(!held.includes(key) && !held.includes(wrapped), "no git object holds the key");
  assert.equal(existsSync(join(data, "runs", runId, "learning-proposal.json")), false, "no proposal was kept");
  const shown = JSON.stringify([view, rows, (await api("GET", "/runs")).body, learning]);
  assert.ok(!shown.includes(key), "the key is nowhere the run is shown");
  await stop();
});
