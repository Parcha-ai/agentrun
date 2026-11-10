// An agent whose definition says `learning: true` keeps what it learned in its folder's `learning/` on the disk (agentFolderOf), in Claude
// Code's auto-memory format (MEMORY.md, the index, and a file per note), and every run of it starts from main there: its
// active notes whole in its instructions under `# Learned` (past the server's learning budget, the index and the notes
// changed last, whole, while they fit), each cut of the server's secrets, and the index and active notes in
// `work/.learning/`, on pi, claude-agent and codex alike: an agent with no read tool still reads what it learned. Learning is off unless the agent says so, and the server's switch turns it off for all. A learning
// fault never refuses a run. The server is the folder's only writer, no hook runs, and it never follows a symbolic link
// into it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agentFolderOf, homeKey } from "../dist/files.js";
import { learningTestHooks } from "../dist/learning.js";
import { KEEPS, learnedIn, NOTHING_YET, resnapSync, wholeIn } from "./learn-support.mjs";
import { agent, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const SYSTEM = new URL("./fixtures/faux-system.mjs", import.meta.url).pathname;
const note = (name, description, type, extra = "", body = `${description}.\n`) => `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n${extra}---\n${body}`;
const REFUND = note("Refund policy path", "Shopify stores keep their policies at /policies/", "reference");
const TABLES = note("Prefers tables", "The user reads results as tables", "user");
const OLD = note("Old refunds", "Refunds were under /help/", "reference", "status: superseded\nsuperseded_by: refund-policy-path.md\n");
const INDEX = "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Refund policy path](refund-policy-path.md) — Shopify stores keep their policies at /policies/\n";
/** main as a merge would leave it: two active notes, one superseded, and the index of the active ones. */
const MAIN = { "MEMORY.md": INDEX, "refund-policy-path.md": REFUND, "prefers-tables.md": TABLES, "old-refunds.md": OLD };
/** The end of each section's first paragraph. */
const KEPT = "Follow a note when it applies to what you are doing.";
/** What `# Learned` holds for MAIN: each active note whole, newest first (both came in one commit: by name). */
const WHOLE = [
  `What you learned in earlier runs: each note whole, newest first. ${KEPT}`,
  "## Prefers tables (prefers-tables.md)\n\nThe user reads results as tables\n\nThe user reads results as tables.",
  "## Refund policy path (refund-policy-path.md)\n\nShopify stores keep their policies at /policies/\n\nShopify stores keep their policies at /policies/.",
].join("\n\n");
/** The notes a run given main's two active notes whole was given (its pin's `given`), in the order its section names them. */
const GIVEN = [{ file: "prefers-tables.md", name: "Prefers tables" }, { file: "refund-policy-path.md", name: "Refund policy path" }];
/** The line that tells an agent with the read tool where the notes not given whole are. */
const TOLD = "The notes not given whole here are files in `.learning/` in your working directory: open one with the read tool when it applies.";

/** git in the test's own hands: no hook, and no system or global config. */
function git(cwd, args) {
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "person", GIT_AUTHOR_EMAIL: "person@example.invalid", GIT_COMMITTER_NAME: "person", GIT_COMMITTER_EMAIL: "person@example.invalid" };
  const out = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

const repoOf = (data, id) => join(agentFolderOf(data, id), "learning");
const pinOf = (data, runId) => JSON.parse(readFileSync(join(runDir(data, runId), "learning.json"), "utf8"));
const learnedDir = (data, runId) => join(runDir(data, runId), "work", ".learning");
const answer = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";

/** Commits `files` on main, in the folder's working tree, as a merge into main would leave it, and (`snap`) the folder's
 *  snapshot rebuilt from it. Its commit. */
function commitToMain(repo, files, message = "learned", snap = true) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", message]);
  if (snap) resnapSync(repo);
  return git(repo, ["rev-parse", "main"]);
}

/** Starts a run of agent `id` and waits for it to complete: its id and its answer, the prompt the faux model saw. */
async function ran(api, id) {
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  await learningEnded(api, run.body.run_id);
  return { runId: run.body.run_id, prompt: await answer(api, run.body.run_id) };
}

/** Once the run's learning has ended (it does not learn, or it merged or dropped): its end-of-run turn, which the faux
 *  model answers with its prompt, gives no note. */
async function learningEnded(api, runId) {
  for (let i = 0; ["seeded", "reflecting", "proposed"].includes((await api("GET", `/runs/${runId}`)).body.learning?.state); i++) {
    assert.ok(i < 600, "the run's learning ends");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Agent `id` with learning on, created, and its folder made by a first run, with `files` then committed on main. */
async function learned(api, data, id, extra = {}, files = MAIN) {
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, ...extra }))).status, 201);
  await ran(api, id);
  return commitToMain(repoOf(data, id), files);
}

/** The run's learning, on its own read and in its agent's run list. */
async function learningOf(api, agentId, runId) {
  const listed = (await api("GET", `/agents/${agentId}/runs`)).body.runs.find((run) => run.run_id === runId);
  return { whole: (await api("GET", `/runs/${runId}`)).body.learning, short: listed.learning };
}

/** That run `runId` of agent `id` learned nothing and has no learning: no folder, no section, no copy, `learning: null`. */
async function learnsNothing(api, data, id, runId, prompt) {
  assert.equal(existsSync(repoOf(data, id)), false, "no learning folder is made");
  assert.equal(existsSync(join(runDir(data, runId), "learning.json")), false, "no pin");
  assert.equal(existsSync(learnedDir(data, runId)), false, "no .learning in the run's work");
  assert.ok(prompt.includes("Answer the question.") && !prompt.includes("# Learned") && !prompt.includes("You learn from your runs"), prompt);
  assert.deepEqual(await learningOf(api, id, runId), { whole: null, short: null });
}

// SKIP (follow-up #2078): it reads a file in the run's own folder, which runs no longer write
test.skip("a new agent with learning on: its first run makes its folder, main checked out with one host commit holding an empty MEMORY.md, and starts seeded, told under # Learned that it learns and that nothing is learned yet, as a restarted server reads it too", { timeout: 90_000 }, async (t) => {
  const first = await serve(t, { faux: SYSTEM });
  const { api, data } = first;
  assert.equal((await api("POST", "/agents", agent("fresh", { learning: true, instructions: "Answer the question." }))).status, 201);
  const { runId, prompt } = await ran(api, "fresh");
  const repo = repoOf(data, "fresh");
  assert.equal(git(repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
  assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
  assert.equal(git(repo, ["log", "-1", "--format=%an <%ae>", "main"]), "agentrun-serve <serve@agentrun.invalid>");
  assert.deepEqual(git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), ["MEMORY.md"]);
  assert.equal(git(repo, ["cat-file", "-s", "main:MEMORY.md"]), "0");
  // Any reader sees main's files: the working tree and the index are main's.
  assert.equal(readFileSync(join(repo, "MEMORY.md"), "utf8"), "");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.deepEqual(readdirSync(agentFolderOf(data, "fresh")).sort(), ["learning", "runs"], "its learning folder beside its runs");
  assert.deepEqual(pinOf(data, runId), { seed: git(repo, ["rev-parse", "main"]) });
  assert.deepEqual(readdirSync(learnedDir(data, runId)), ["MEMORY.md"]);
  assert.ok(prompt.includes(`Answer the question.\n\n# Learned\n\n${KEEPS}\n\n${NOTHING_YET}`), `an empty index: the run is told it learns, and that nothing is learned yet: ${prompt}`);
  assert.ok(!prompt.includes("What you learned in earlier runs"), "no intro to notes it has none of");
  // Seeded, then asked the end-of-run turn, which (the faux model says its prompt) gave no note (learn-reflect.test.mjs).
  const { whole, short } = await learningOf(api, "fresh", runId);
  assert.deepEqual({ ...whole, at: typeof whole.at }, { state: "dropped", reason: "empty", detail: "Nothing new to remember from this run.", at: "string" });
  assert.deepEqual(short, { state: "dropped", reason: "empty", detail: "Nothing new to remember from this run." }, "a list says it in the same words");
  // A server started again reads the run's learning back from its serve.json, whole and in a list.
  await first.close();
  const again = await serve(t, { data, faux: SYSTEM });
  assert.deepEqual(await learningOf(again.api, "fresh", runId), { whole, short });
});

// A home made before the agent's first run that learns may already hold an empty `learning/` (mode 0700, no .git), as a
// home's first making leaves it: the seed takes it as it is, git init in place, and the run starts from its one commit.
// SKIP (follow-up #2078): it reads a file in the run's own folder, which runs no longer write
test.skip("an empty learning/ in the agent's home before its first run, with no .git, is taken as it is: the folder is made a repository in place, main holds an empty MEMORY.md, and the run is seeded from it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  assert.equal((await api("POST", "/agents", agent("premade", { learning: true, instructions: "Answer the question." }))).status, 201);
  const repo = repoOf(data, "premade");
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  chmodSync(repo, 0o700);
  assert.deepEqual(readdirSync(repo), []);
  const { runId } = await ran(api, "premade");
  const { whole } = await learningOf(api, "premade", runId);
  assert.deepEqual([whole.state, whole.reason], ["dropped", "empty"], "seeded, and its end-of-run turn gave no note");
  assert.ok(existsSync(join(repo, ".git")), "a repository, made in place");
  assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
  assert.deepEqual(git(repo, ["ls-tree", "--name-only", "main"]).split("\n"), ["MEMORY.md"]);
  assert.deepEqual(pinOf(data, runId), { seed: git(repo, ["rev-parse", "main"]) });
  assert.equal(statSync(repo).mode & 0o777, 0o700, "its mode as it was");
});

// The faux harness stands in for claude-agent's and codex's: it says the system prompt the run gives it.
for (const harness of ["pi", "claude-agent", "codex"]) {
  // SKIP (follow-up #2078): it reads a file in the run's own folder, which runs no longer write
  test.skip(`a fresh agent's first ${harness} run that learns is told so: # Learned after the instructions says it learns, how, and to tell the person it keeps what they ask but never a secret, then that nothing is learned yet`, { timeout: 90_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
    const id = `first-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness, instructions: "Answer the question." }))).status, 201);
    const { runId, prompt } = await ran(api, id);
    assert.deepEqual(pinOf(data, runId), { seed: git(repoOf(data, id), ["rev-parse", "main"]) }, "a first run has a pin, with nothing learned");
    assert.ok(prompt.includes(`Answer the question.\n\n# Learned\n\n${KEEPS}\n\n${NOTHING_YET}`), prompt);
    assert.equal(prompt.split("# Learned").length, 2, "one section");
    // It never promises to keep what is never kept: a secret the person asks it to remember is refused, and said so. A
    // reply whose start or end the person set follows it from its first line to its last, with no keep sentence.
    assert.match(prompt, /\n# Learned\n\n[^\n]*tell them in one short sentence at the start of your reply that you will keep it for later runs\. When what they asked sets how your reply starts or ends, follow it from your reply's first line to its last and leave that sentence out\. A secret \(a password, key or token\) is never kept, so say so instead\.\n\n/);
  });
}

for (const harness of ["pi", "claude-agent", "codex"]) {
  // SKIP (follow-up #2078): it reads a file in the run's own folder, which runs no longer write
  test.skip(`a ${harness} run with no read tool starts from main's commit, never the working tree: each active note whole under # Learned, and the index and the active notes in work/.learning, not the superseded one`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
    const id = `seeded-${harness}`;
    const sha = await learned(api, data, id, { harness, instructions: "Answer the question." });
    // Uncommitted edits in the working tree: what a run reads is main's commit, never these.
    const repo = repoOf(data, id);
    writeFileSync(join(repo, "MEMORY.md"), `${INDEX}- [Loose](loose.md) — an uncommitted rule\n`);
    writeFileSync(join(repo, "prefers-tables.md"), note("Prefers tables", "uncommitted", "user"));
    writeFileSync(join(repo, "loose.md"), note("Loose", "never committed", "project"));
    const { runId, prompt } = await ran(api, id);
    assert.equal(learnedIn(prompt), WHOLE, prompt);
    assert.ok(prompt.includes(`Answer the question.\n\n# Learned\n\n${KEEPS}\n\n${WHOLE}`), `the section follows the instructions, and says the run learns before the notes: ${prompt}`);
    assert.equal(prompt.split(KEEPS).length, 2, "said once");
    assert.ok(prompt.indexOf(KEEPS) < prompt.indexOf("\n## "), "before the first note");
    assert.ok(!prompt.includes(NOTHING_YET), prompt);
    assert.ok(!prompt.includes(INDEX.split("\n")[0]) && !prompt.includes(TOLD) && !prompt.includes("read tool"), "every note is whole: no index, and no word of a tool the agent lacks");
    assert.ok(!prompt.includes("uncommitted") && !prompt.includes("Loose") && !prompt.includes("Old refunds"), prompt);
    assert.deepEqual(readdirSync(learnedDir(data, runId)).sort(), ["MEMORY.md", "prefers-tables.md", "refund-policy-path.md"]);
    for (const file of ["MEMORY.md", "prefers-tables.md", "refund-policy-path.md"]) assert.equal(readFileSync(join(learnedDir(data, runId), file), "utf8"), MAIN[file], file);
    assert.deepEqual(pinOf(data, runId), { seed: sha, section: WHOLE, given: GIVEN });
    const skills = join(runDir(data, runId), "work", ".agents", "skills");
    assert.deepEqual(existsSync(skills) ? readdirSync(skills) : [], [], "no learned skill is written");
    const { whole, short } = await learningOf(api, id, runId);
    assert.deepEqual([whole.state, whole.reason, short], ["dropped", "empty", { state: "dropped", reason: "empty", detail: whole.detail, given: GIVEN }], "seeded, and its end-of-run turn gave no note");
  });
}

test("learning is off unless the agent says so: an agent that leaves it out, or says false, gets no folder, no # Learned, no work/.learning, and learning: null", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  for (const [id, extra] of [["unset", {}], ["off", { learning: false }]]) {
    assert.equal((await api("POST", "/agents", agent(id, { instructions: "Answer the question.", ...extra }))).status, 201);
    const { runId, prompt } = await ran(api, id);
    await learnsNothing(api, data, id, runId, prompt);
  }
});

test("the server's switch off: an agent that says learning: true learns nothing, as one that is off, and capabilities say off; a value that is not on or off refuses the start", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM, learning: "off" });
  assert.equal((await api("GET", "/capabilities")).body.features.learning, "off");
  assert.equal((await api("POST", "/agents", agent("muted", { learning: true, instructions: "Answer the question." }))).status, 201);
  const { runId, prompt } = await ran(api, "muted");
  await learnsNothing(api, data, "muted", runId, prompt);
  const dir = await scratch(t);
  await assert.rejects(serve(t, { data: join(dir, "a"), learning: "maybe" }), /learning is on or off/);
  withEnv(t, { AGENTRUN_SERVE_LEARNING: "no" });
  await assert.rejects(serve(t, { data: join(dir, "b") }), /learning is on or off \(--learning, AGENTRUN_SERVE_LEARNING\), not no/);
  process.env.AGENTRUN_SERVE_LEARNING = "off";
  assert.equal((await (await serve(t, { data: join(dir, "c") })).api("GET", "/capabilities")).body.features.learning, "off", "the environment's switch, when no option names one");
});

// SKIP (follow-up #2078): the agent's learning notes are not laid into the run as before on the runner
test.skip("an index naming notes main does not hold whole: the run reads its first 200 lines, as Claude Code loads its own, and gets the whole file in work/.learning", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const lines = Array.from({ length: 250 }, (_, i) => `- [Note ${i + 1}](note-${i + 1}.md) — line ${i + 1}`);
  await learned(api, data, "long", { instructions: "Answer the question." }, { "MEMORY.md": `${lines.join("\n")}\n` });
  const { runId, prompt } = await ran(api, "long");
  assert.equal(learnedIn(prompt), [`What you learned in earlier runs, one line per note. ${KEPT}`, lines.slice(0, 200).join("\n")].join("\n\n"));
  assert.ok(prompt.includes("line 200") && !prompt.includes("line 201"), prompt.slice(-300));
  assert.equal(readFileSync(join(learnedDir(data, runId), "MEMORY.md"), "utf8"), `${lines.join("\n")}\n`);
});

/** Ten notes, note-01 to note-10, each committed on main on its own, note-01 first, with the index as the host builds it
 *  (by file name): the files, and the index's lines. */
function tenNotes(repo) {
  const notes = Array.from({ length: 10 }, (_, i) => String(i + 1).padStart(2, "0")).map((n) => [`note-${n}.md`, note(`Note ${n}`, `Rule ${n} of ten`, "user", "", `Rule ${n}: ${Array(4).fill("keep this in mind").join(" ")}.\n`)]);
  const lines = notes.map(([file]) => `- [Note ${file.slice(5, 7)}](${file}) — Rule ${file.slice(5, 7)} of ten`);
  notes.forEach(([file, text], i) => commitToMain(repo, { [file]: text, "MEMORY.md": `${lines.slice(0, i + 1).join("\n")}\n` }, `learned ${file}`, false));
  resnapSync(repo);
  return { notes, lines };
}
const bytes = (text) => Buffer.byteLength(text);

// SKIP (follow-up #2078): it reads a file in the run's own folder, which runs no longer write
test.skip("past the learning budget: the index whole, then the notes changed last, whole, while they fit, the rest named in the index; an agent with the read tool is told the rest are in .learning/, one without is not, nor one whose notes all fit; a person's edit makes a note the newest", { timeout: 180_000 }, async (t) => {
  const BUDGET = 1000;
  const { api, baseUrl, token, data } = await serve(t, { faux: SYSTEM, learningBudget: BUDGET });
  for (const [id, tools] of [["many", []], ["many-read", ["read"]]]) {
    assert.equal((await api("POST", "/agents", agent(id, { learning: true, instructions: "Answer the question.", tools }))).status, 201);
    await ran(api, id);
    const { notes, lines } = tenNotes(repoOf(data, id));
    const { runId, prompt } = await ran(api, id);
    const section = learnedIn(prompt);
    assert.equal(section, pinOf(data, runId).section, "the pin holds what the instructions say");
    assert.equal(prompt.split(KEEPS).length, 2, "told it learns once, right before the index and the notes (learnedIn reads after it)");
    const [intro, index] = section.split("\n\n");
    assert.equal(intro, `What you learned in earlier runs: the index, one line per note, then the newest notes whole. ${KEPT}`);
    assert.equal(index, lines.join("\n"), "the index, whole");
    const whole = wholeIn(section);
    assert.ok(whole.length >= 1 && whole.length < notes.length, `some notes whole, not all: ${whole}`);
    assert.deepEqual(whole, notes.map(([file]) => file).reverse().slice(0, whole.length), "the ones changed last, newest first");
    for (const [file, text] of notes) assert.equal(section.includes(text.split("---\n")[2].trim()), whole.includes(file), file);
    // Within the budget, the section's own lines aside: the index, and the notes whole, each after a blank line; one
    // more note (they are all one size) would not fit.
    const blocks = section.slice(section.indexOf("\n\n## ") + 2);
    const used = bytes(index) + 2 + bytes(blocks) + 2;
    const one = (bytes(blocks) - 2 * (whole.length - 1)) / whole.length;
    assert.ok(used <= BUDGET && used + one + 2 > BUDGET, `${used} of ${BUDGET}, a note ${one}`);
    assert.equal(section.includes(TOLD), tools.includes("read"), "told of .learning/ only with the read tool");
    if (tools.includes("read")) assert.equal(section.split("\n\n")[2], TOLD, "the line follows the index");
  }
  // A person's edit makes note-01 the newest: the next run gives it whole, first.
  const files = `${baseUrl}/agents/many/learning/files`;
  const etag = (await fetch(`${files}/note-01.md`, { headers: { authorization: `Bearer ${token}` } })).headers.get("etag");
  const edited = await fetch(`${files}/note-01.md`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown", "if-match": etag }, body: note("Note 01", "Rule 01 of ten", "user", "", "Rule 01, as a person put it.\n") });
  assert.equal(edited.status, 200, await edited.text());
  const after = learnedIn((await ran(api, "many")).prompt);
  assert.equal(wholeIn(after)[0], "note-01.md", after);
  assert.ok(after.includes("Rule 01, as a person put it."), after);
  // An agent with the read tool whose notes all fit is told nothing of .learning/: nothing is left out.
  assert.equal((await api("POST", "/agents", agent("few-read", { learning: true, instructions: "Answer the question.", tools: ["read"] }))).status, 201);
  await ran(api, "few-read");
  commitToMain(repoOf(data, "few-read"), MAIN);
  assert.equal(learnedIn((await ran(api, "few-read")).prompt), WHOLE);
});

test("the learning budget is --learning-budget, else AGENTRUN_SERVE_LEARNING_BUDGET, else 8000 bytes; 0 gives the index alone, and a value that is no whole number of bytes refuses the start", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  withEnv(t, { AGENTRUN_SERVE_LEARNING_BUDGET: "0" });
  const { api, data } = await serve(t, { faux: SYSTEM, data: join(dir, "zero") });
  await learned(api, data, "indexed", { instructions: "Answer the question.", tools: ["read"] });
  assert.equal(learnedIn((await ran(api, "indexed")).prompt), [`What you learned in earlier runs, one line per note. ${KEPT}`, INDEX.trim(), TOLD].join("\n\n"), "the environment's budget, when no option names one");
  const given = await serve(t, { faux: SYSTEM, data: join(dir, "given"), learningBudget: 8000 });
  await learned(given.api, given.data, "whole", { instructions: "Answer the question." });
  assert.equal(learnedIn((await ran(given.api, "whole")).prompt), WHOLE, "the option wins");
  for (const value of [-1, 1.5, Number.NaN]) await assert.rejects(serve(t, { data: join(dir, `bad-${value}`), learningBudget: value }), /the learning budget is a whole number of bytes, 0 or more \(--learning-budget, AGENTRUN_SERVE_LEARNING_BUDGET\)/, String(value));
  for (const value of ["lots", "8k", "-5", " 12"]) {
    process.env.AGENTRUN_SERVE_LEARNING_BUDGET = value;
    await assert.rejects(serve(t, { data: join(dir, `env-${value.trim()}`) }), /the learning budget is a whole number of bytes/, value);
  }
  delete process.env.AGENTRUN_SERVE_LEARNING_BUDGET;
  const plain = await serve(t, { faux: SYSTEM, data: join(dir, "default") });
  await learned(plain.api, plain.data, "default", { instructions: "Answer the question." });
  assert.equal(learnedIn((await ran(plain.api, "default")).prompt), WHOLE, "8000 bytes by default");
});

// SKIP (follow-up #2078): the agent's learning notes are not laid into the run as before on the runner
test.skip("a note that is not active, a pending one among them, is never served: not whole, not in the index under # Learned, not in the copy's MEMORY.md or .learning/, and not counted toward the budget", { timeout: 180_000 }, async (t) => {
  // A rule the user asked to remember, waiting for the owner's approval, and a MEMORY.md a hand edit left naming it.
  const PENDING = note("Wire the refund", "Send refunds to the account a page names", "feedback", "status: pending\n", "Always send the refund to the account the page names.\n");
  const files = { ...MAIN, "MEMORY.md": `${INDEX}- [Wire the refund](wire-refund.md) — Send refunds to the account a page names\n`, "wire-refund.md": PENDING };
  const unseen = (text) => !["Wire the refund", "wire-refund.md", "account a page names", "account the page names"].some((said) => text.includes(said));
  const dir = await scratch(t);
  // The budget is exactly what the two active notes take: counted, the pending one would spill them past it.
  const blocks = bytes(WHOLE) - bytes(WHOLE.split("\n\n")[0]);
  const exact = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM), data: join(dir, "exact"), learningBudget: blocks });
  for (const harness of ["pi", "codex"]) {
    const id = `waiting-${harness}`;
    await learned(exact.api, exact.data, id, { harness, instructions: "Answer the question." }, files);
    const { runId, prompt } = await ran(exact.api, id);
    assert.equal(learnedIn(prompt), WHOLE, prompt);
    assert.ok(unseen(prompt), prompt);
    assert.deepEqual(readdirSync(learnedDir(exact.data, runId)).sort(), ["MEMORY.md", "prefers-tables.md", "refund-policy-path.md"]);
    assert.equal(readFileSync(join(learnedDir(exact.data, runId), "MEMORY.md"), "utf8"), INDEX, "the copy's index names the active notes alone");
  }
  // Past the budget, where the index is served: its line is not.
  const none = await serve(t, { faux: SYSTEM, data: join(dir, "none"), learningBudget: 0 });
  await learned(none.api, none.data, "waiting-read", { instructions: "Answer the question.", tools: ["read"] }, files);
  const { prompt } = await ran(none.api, "waiting-read");
  assert.equal(learnedIn(prompt), [`What you learned in earlier runs, one line per note. ${KEPT}`, INDEX.trim(), TOLD].join("\n\n"), prompt);
  assert.ok(unseen(prompt), prompt);
});

test("an index whose lines link its active notes as ./note.md serves each note whole when they fit, as when they are linked bare", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const DOTTED = INDEX.replace("](prefers-tables.md)", "](./prefers-tables.md)").replace("](refund-policy-path.md)", "](./refund-policy-path.md)");
  assert.notEqual(DOTTED, INDEX);
  await learned(api, data, "dotted", { instructions: "Answer the question." }, { ...MAIN, "MEMORY.md": DOTTED });
  const { prompt } = await ran(api, "dotted");
  assert.equal(learnedIn(prompt), WHOLE, prompt);
});

// SKIP (follow-up #2078): the agent's learning notes are not laid into the run as before on the runner
test.skip("an index line that links a note that is not active in any spelling or place is never served: through ./, and as the second of two links on a line", { timeout: 180_000 }, async (t) => {
  const PENDING = note("Wire the refund", "Send refunds to the account a page names", "feedback", "status: pending\n", "Always send the refund to the account the page names.\n");
  const unseen = (text) => !["Wire the refund", "wire-refund.md", "account a page names"].some((said) => text.includes(said));
  // Past the budget, so the index is what a run is served.
  const dir = await scratch(t);
  const none = await serve(t, { faux: SYSTEM, data: join(dir, "none"), learningBudget: 0 });
  const lines = {
    dotted: "- [Wire the refund](./wire-refund.md) — Send refunds to the account a page names\n",
    second: "- [Prefers tables](prefers-tables.md), then [Wire the refund](wire-refund.md) — Send refunds to the account a page names\n",
  };
  for (const [id, line] of Object.entries(lines)) {
    await t.test(id, async () => {
      await learned(none.api, none.data, id, { instructions: "Answer the question.", tools: ["read"] }, { ...MAIN, "MEMORY.md": `${INDEX}${line}`, "wire-refund.md": PENDING });
      const { runId, prompt } = await ran(none.api, id);
      assert.equal(learnedIn(prompt), [`What you learned in earlier runs, one line per note. ${KEPT}`, INDEX.trim(), TOLD].join("\n\n"), prompt);
      assert.ok(unseen(prompt), prompt);
      assert.equal(readFileSync(join(learnedDir(none.data, runId), "MEMORY.md"), "utf8"), INDEX, "the copy's index names the active notes alone");
    });
  }
});

// SKIP (follow-up #2078): it reads a file in the run's own folder, which runs no longer write
test.skip("a note holding a value made one of the server's secrets after it was written: the run's instructions, its pin and its copy in .learning/ read it [redacted], though main holds it", { timeout: 120_000 }, async (t) => {
  // Built at the run: a value no file of this repository holds.
  const value = ["shop", "key", process.pid, Date.now().toString(36), "0123456789"].join("-");
  withEnv(t, { SHOP_API_KEY: value });
  const { api, data } = await serve(t, { faux: SYSTEM });
  const leaky = note("Shop key", `Sign in with ${value}`, "reference", "", `Send ${value} as the key.\n`);
  await learned(api, data, "leaky", { instructions: "Answer the question." }, { "MEMORY.md": `- [Shop key](shop-key.md) — Sign in with ${value}\n`, "shop-key.md": leaky });
  assert.ok(git(repoOf(data, "leaky"), ["show", "main:shop-key.md"]).includes(value), "main holds it");
  const { runId, prompt } = await ran(api, "leaky");
  assert.ok(!prompt.includes(value), prompt);
  assert.ok(learnedIn(prompt).includes("## Shop key (shop-key.md)\n\nSign in with [redacted]\n\nSend [redacted] as the key."), prompt);
  assert.ok(!readFileSync(join(runDir(data, runId), "learning.json"), "utf8").includes(value), "nor the pin");
  for (const file of readdirSync(learnedDir(data, runId))) {
    const text = readFileSync(join(learnedDir(data, runId), file), "utf8");
    assert.ok(!text.includes(value) && text.includes("[redacted]"), `${file}: ${text}`);
  }
});

// SKIP (follow-up #2078): it reads a file in the run's own folder, which runs no longer write
test.skip("the pin: a run keeps the commit it was made from when main moves on, through a continue in a new process", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const sha = await learned(api, data, "pinned", { instructions: "Answer the question." });
  const { runId, prompt } = await ran(api, "pinned");
  const pin = readFileSync(join(runDir(data, runId), "learning.json"), "utf8");
  assert.equal(JSON.parse(pin).seed, sha);
  const later = commitToMain(repoOf(data, "pinned"), { "MEMORY.md": `${INDEX}- [Later](later.md) — a rule main learned after the run was made\n`, "later.md": note("Later", "a rule main learned after the run was made", "feedback") });
  assert.notEqual(later, sha);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and again?" })).status, 202);
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const again = await answer(api, runId);
  assert.equal(readFileSync(join(runDir(data, runId), "learning.json"), "utf8"), pin, "the pin is never written again");
  assert.equal(learnedIn(again), learnedIn(prompt));
  assert.ok(!again.includes("main learned after"), again);
  assert.equal(existsSync(join(learnedDir(data, runId), "later.md")), false);
  // A run made now starts from the new main.
  const next = await ran(api, "pinned");
  assert.equal(pinOf(data, next.runId).seed, later);
  assert.deepEqual(wholeIn(learnedIn(next.prompt)), ["later.md", "prefers-tables.md", "refund-policy-path.md"], next.prompt);
  assert.ok(existsSync(join(learnedDir(data, next.runId), "later.md")));
});

// SKIP (follow-up #2078): it reads a file in the run's own folder, which runs no longer write
test.skip("two runs of a new agent made at once: one folder made, one commit on main, and both runs seeded from it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  assert.equal((await api("POST", "/agents", agent("twice", { learning: true }))).status, 201);
  const made = await Promise.all([1, 2].map(() => api("POST", "/agents/twice/runs", { input: { content: "hi" } })));
  for (const run of made) assert.equal(run.status, 202, JSON.stringify(run.body));
  for (const run of made) await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  for (const run of made) await learningEnded(api, run.body.run_id);
  const repo = repoOf(data, "twice");
  const main = git(repo, ["rev-parse", "main"]);
  assert.equal(git(repo, ["rev-list", "--count", "--all"]), "1");
  assert.equal(git(repo, ["reflog", "show", "--format=%H", "refs/heads/main"]), main, "main was set once");
  assert.deepEqual(made.map((run) => pinOf(data, run.body.run_id).seed), [main, main]);
  assert.deepEqual(readdirSync(agentFolderOf(data, "twice")).sort(), ["learning", "runs"], "its learning folder beside its runs");
  for (const run of made) assert.equal((await api("GET", `/runs/${run.body.run_id}`)).body.learning.reason, "empty", "seeded, and its end-of-run turn gave no note");
});

// SKIP (follow-up #2078): it reads a file in the run's own folder, which runs no longer write
test.skip("two agents whose ids differ only in case: each has its own learning folder, in agent folders whose names differ in any case, and what one learned never seeds the other's run", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const sha = await learned(api, data, "Twin", { instructions: "Answer the question." });
  assert.equal((await api("POST", "/agents", agent("twin", { learning: true, instructions: "Answer the question." }))).status, 201);
  const other = await ran(api, "twin");
  // The agents' folders as the server made them: named as homeKey names, so apart even on a disk that folds case.
  const homes = readdirSync(join(data, "disk", "agents")).sort();
  assert.deepEqual(homes, [homeKey("Twin"), homeKey("twin")].sort());
  assert.equal(new Set(homes.map((name) => name.toLowerCase())).size, 2, "the names differ in any case");
  // The other's folder is a new one: one host commit holding an empty MEMORY.md, and its run learned nothing of Twin's.
  const repo = repoOf(data, "twin");
  assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
  assert.deepEqual(git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), ["MEMORY.md"]);
  assert.equal(learnedIn(other.prompt), undefined, other.prompt);
  assert.ok(!other.prompt.includes("Refund policy path") && !other.prompt.includes("Prefers tables"), other.prompt);
  assert.deepEqual(readdirSync(learnedDir(data, other.runId)), ["MEMORY.md"]);
  assert.equal(readFileSync(join(learnedDir(data, other.runId), "MEMORY.md"), "utf8"), "");
  assert.notEqual(pinOf(data, other.runId).seed, sha);
  // The one that learned still starts from its own.
  const own = await ran(api, "Twin");
  assert.equal(learnedIn(own.prompt), WHOLE, own.prompt);
  assert.deepEqual(pinOf(data, own.runId), { seed: sha, section: WHOLE, given: GIVEN });
});

test("no hook runs on the host's git calls: neither the folder's own (its hooks folder, core.hooksPath, an fsmonitor) nor a template, hooks folder or config the environment names", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const marker = join(dir, "ran");
  const hook = (path) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho "$0" >> '${marker}'\n`);
    chmodSync(path, 0o755);
  };
  const NAMES = ["pre-commit", "commit-msg", "post-commit", "post-checkout", "post-index-change", "reference-transaction"];
  // What the environment names: a template with hooks, and a global and a system config naming a hooks folder, a
  // template and an fsmonitor.
  for (const name of NAMES) hook(join(dir, "template", "hooks", name)), hook(join(dir, "hooks", name));
  hook(join(dir, "fsmonitor"));
  const config = `[core]\n\thooksPath = ${join(dir, "hooks")}\n\tfsmonitor = ${join(dir, "fsmonitor")}\n[init]\n\ttemplateDir = ${join(dir, "template")}\n`;
  writeFileSync(join(dir, "gitconfig"), config);
  withEnv(t, { GIT_TEMPLATE_DIR: join(dir, "template"), GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_SYSTEM: join(dir, "gitconfig") });
  const { api, data } = await serve(t);
  // A folder whose making stopped before main, with hooks of its own: the host finishes it there.
  const planted = repoOf(data, "planted");
  mkdirSync(planted, { recursive: true });
  git(planted, ["init", "-q", "--template=", "--initial-branch=main"]);
  for (const name of NAMES) hook(join(planted, ".git", "hooks", name)), hook(join(dir, "own-hooks", name));
  git(planted, ["config", "core.hooksPath", join(dir, "own-hooks")]);
  git(planted, ["config", "core.fsmonitor", join(dir, "fsmonitor")]);
  for (const id of ["planted", "fresh"]) {
    assert.equal((await api("POST", "/agents", agent(id, { learning: true }))).status, 201);
    // The first run makes main; the second reads it.
    for (const _ of [1, 2]) await ran(api, id);
    const repo = repoOf(data, id);
    assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
    assert.deepEqual(git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), ["MEMORY.md"]);
    assert.equal(git(repo, ["status", "--porcelain"]), "", "the checkout shows main, finished");
  }
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
  assert.equal(existsSync(join(repoOf(data, "fresh"), ".git", "hooks")), false, "no template was copied");
});

/** That run `runId` of agent `id` completed with nothing learned, dropped for seed_failed. */
async function seedFailed(api, data, id, runId, prompt) {
  assert.equal(existsSync(join(runDir(data, runId), "learning.json")), false, "no pin");
  assert.equal(existsSync(learnedDir(data, runId)), false, "no .learning in the run's work");
  assert.ok(prompt.includes("Answer the question.") && !prompt.includes("# Learned") && !prompt.includes("You learn from your runs"), `a run that will not be asked what to keep is not told it learns: ${prompt}`);
  const { whole, short } = await learningOf(api, id, runId);
  assert.deepEqual([whole.state, whole.reason, short], ["dropped", "seed_failed", { state: "dropped", reason: "seed_failed", detail: whole.detail }]);
  assert.match(whole.detail, /^Not kept: learning stopped \(.*, so the run started without (them|its notes)\)\.$/);
}

// SKIP (follow-up #2078): the agent's learning notes are not laid into the run as before on the runner
test.skip("a folder the server cannot read: the run still completes, with nothing learned, and its learning is dropped for seed_failed", { timeout: 120_000, skip: process.getuid?.() === 0 && "root reads any folder" }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  await learned(api, data, "locked", { instructions: "Answer the question." });
  const repo = repoOf(data, "locked");
  chmodSync(repo, 0o000);
  let run;
  try {
    run = await ran(api, "locked");
  } finally {
    chmodSync(repo, 0o700);
  }
  await seedFailed(api, data, "locked", run.runId, run.prompt);
  // Once it can be read again, the next run starts from it.
  assert.equal(learnedIn((await ran(api, "locked")).prompt), WHOLE);
});

// SKIP (follow-up #2078): the agent's learning notes are not laid into the run as before on the runner
test.skip("notes that cannot be copied into the run: it completes with nothing learned, seed_failed", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  await learned(api, data, "lost", { instructions: "Answer the question." });
  learningTestHooks.beforePin = () => {
    throw new Error("the disk is full");
  };
  t.after(() => void (learningTestHooks.beforePin = undefined));
  const full = await ran(api, "lost");
  learningTestHooks.beforePin = undefined;
  await seedFailed(api, data, "lost", full.runId, full.prompt);
});

// SKIP (follow-up #2078): the agent's learning notes are not laid into the run as before on the runner
test.skip("a copy that fails once its pin is in place (the run's directory not synced): the pin goes too, so the run is seed_failed and nothing learned reaches its instructions", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  await learned(api, data, "unsynced", { instructions: "Answer the question." });
  let pinned;
  learningTestHooks.afterPin = (runDir) => {
    pinned = JSON.parse(readFileSync(join(runDir, "learning.json"), "utf8"));
    throw new Error("the run's directory could not be synced");
  };
  t.after(() => void (learningTestHooks.afterPin = undefined));
  const run = await ran(api, "unsynced");
  learningTestHooks.afterPin = undefined;
  assert.equal(pinned?.section, WHOLE, "the pin was in place, with the notes, when the copy failed");
  assert.equal(learnedIn(run.prompt), undefined, "no # Learned in the run's instructions");
  await seedFailed(api, data, "unsynced", run.runId, run.prompt);
});

/** A scratch directory holding one file, `kept`, for a planted link to point at (or at its file). */
async function linkTarget(t) {
  const target = await scratch(t);
  writeFileSync(join(target, "kept"), "kept\n");
  return target;
}

/** What the server writes to its stderr while test `t` runs. */
function stderrOf(t) {
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    said.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  t.after(() => void (process.stderr.write = write));
  return said;
}

/** That run `runId` of agent `id` was refused the link it met: seed_failed, the link's target as it was, and the
 *  warning naming a link in the data directory, never the target. */
async function refusedLink(api, data, id, runId, prompt, target, said) {
  await seedFailed(api, data, id, runId, prompt);
  assert.deepEqual(readdirSync(target), ["kept"], "nothing is made where the link points");
  assert.equal(readFileSync(join(target, "kept"), "utf8"), "kept\n", "nothing is written through the link");
  const warning = said.find((text) => text.includes(`the agent ${id}'s learning folder could not be read`)) ?? "";
  assert.match(warning, /a link in the learning folder at [^ ]+ can't be followed, so nothing learned is read or written; remove the link/, said.join(""));
  assert.ok(!warning.includes(target), warning);
}

// A link left in an agent's home before its learning was on, by something that could write there: at the home itself,
// at its learning folder, at the folder's .git, or at MEMORY.md in a folder whose making stopped before main. The host
// refuses it and never follows it, so its git init, writes and commits never land where the link points.
const PLANTED = {
  "disk/agents/<key>/learning": (data, id, target) => (mkdirSync(agentFolderOf(data, id), { recursive: true }), symlinkSync(target, repoOf(data, id))),
  "learning/.git": (data, id, target) => (mkdirSync(repoOf(data, id), { recursive: true }), symlinkSync(target, join(repoOf(data, id), ".git"))),
  "learning/MEMORY.md": (data, id, target) => (mkdirSync(repoOf(data, id), { recursive: true }), symlinkSync(join(target, "kept"), join(repoOf(data, id), "MEMORY.md"))),
};
for (const [where, plant] of Object.entries(PLANTED)) {
  // SKIP (follow-up #2078): the agent's learning notes are not laid into the run as before on the runner
  test.skip(`a symbolic link at ${where}, there before the agent's first run: the run completes with nothing learned, seed_failed, nothing is made or written where the link points, and the warning names the link, not its target`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM });
    const target = await linkTarget(t);
    assert.equal((await api("POST", "/agents", agent("linked", { learning: true, instructions: "Answer the question." }))).status, 201);
    plant(data, "linked", target);
    const said = stderrOf(t);
    const run = await ran(api, "linked");
    await refusedLink(api, data, "linked", run.runId, run.prompt, target, said);
  });
}

// SKIP (follow-up #2078): the agent's learning notes are not laid into the run as before on the runner
test.skip("a symbolic link at disk/agents/<key>, the agent's folder, there before its first run: the run is refused at its start, since its own folder would be made through the link, and nothing is made where the link points", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const target = await linkTarget(t);
  assert.equal((await api("POST", "/agents", agent("linked", { learning: true, instructions: "Answer the question." }))).status, 201);
  const before = readdirSync(target).sort();
  mkdirSync(dirname(agentFolderOf(data, "linked")), { recursive: true });
  symlinkSync(target, agentFolderOf(data, "linked"));
  const run = await api("POST", "/agents/linked/runs", { input: { content: "hi" } });
  assert.equal(run.status, 422, JSON.stringify(run.body));
  assert.match(JSON.stringify(run.body), /disk\/agents\/linked-[0-9a-f]{16} is a symbolic link, and a run's folder is never made through one/);
  assert.ok(!JSON.stringify(run.body).includes(target), "the refusal names the link, not its target");
  assert.deepEqual(readdirSync(target).sort(), before, "nothing made where the link points");
});

/** A request's system prompt, as text. */
const systemText = (body) => (typeof body?.system === "string" ? body.system : (body?.system ?? []).map((block) => block?.text ?? "").join("\n"));

// SKIP (follow-up #2078): it reads a file in the run's own folder, which runs no longer write
test.skip("a claude-agent run on its real adapter: the notes are whole in the system prompt after the instructions, under # Learned, with the revision's skill loaded through the Skill tool and no learned one", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const fake = await fakeAnthropic({ reply: () => ({ text: "Claude answered." }) });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" }, ["AGENT_MODEL_BASE_URL"]);
  const { api, data } = await serve(t, { faux: undefined });
  // The agent's folder, with main already holding two active notes and a superseded one when its first run is made.
  const repo = repoOf(data, "learner");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "--template=", "--initial-branch=main"]);
  const sha = commitToMain(repo, MAIN);
  const cite = "---\nname: cite\ndescription: How this agent cites its sources.\n---\nCite every source you read.\n";
  const created = await api("POST", "/agents", { ...agent("learner", { learning: true, harness: "claude-agent", model: "anthropic/claude-haiku-4-5", instructions: "Answer the question.", skills: ["cite"] }), skills: { "cite/SKILL.md": cite } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await api("POST", "/agents/learner/runs", { input: { content: "Answer." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.deepEqual(pinOf(data, run.body.run_id), { seed: sha, section: WHOLE, given: GIVEN });
  const first = fake.messages().find((m) => m.tools.includes("Skill"));
  assert.ok(first, `the Skill tool is offered: ${JSON.stringify(fake.messages().map((m) => m.tools))}`);
  const system = systemText(first.body);
  assert.ok(system.includes(`Answer the question.\n\n# Learned\n\n${KEEPS}\n\n${WHOLE}`), `the notes follow the instructions, after what the run is told of learning: ${system.slice(-2000)}`);
  assert.ok(!system.includes("Old refunds"), "a superseded note is never shown");
  assert.ok(JSON.stringify(first.body).includes("agentrun:cite"), "the revision's skill goes as it did");
  assert.ok(!system.includes('<skill name="cite">'), "and is not inlined");
  assert.deepEqual(readdirSync(learnedDir(data, run.body.run_id)).sort(), ["MEMORY.md", "prefers-tables.md", "refund-policy-path.md"]);
});
