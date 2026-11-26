// An agent whose definition says `learning: true` keeps what it learned in the store's learning rows: its owner's
// corrections (corrections.md) and its compiled workflows (workflows/<name>/). Every run of it starts from its newest
// save: its corrections whole in its instructions under `# Learned`, cut of the server's secrets, on pi, claude-agent and
// codex alike. Learning is off unless the agent says so, and the server's switch turns it off for all.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentFolderOf, homeKey } from "../dist/files.js";
import { said } from "../dist/learning-words.js";
import { CORRECTIONS_INTRO, learningAt, NOTHING_YET, overStore, pinOf, putLearning, savesOf } from "./learn-support.mjs";
import { agent, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const SYSTEM = new URL("./fixtures/faux-system.mjs", import.meta.url).pathname;
const CORRECTIONS = "- Answer in tables.\n- Quote the page each figure came from.\n";
/** The learning as a run's merge would leave it: two of the owner's corrections. */
const MAIN = { "corrections.md": CORRECTIONS };
/** What `# Learned` holds for MAIN. */
const SECTION = `${CORRECTIONS_INTRO}\n\n- Answer in tables.\n- Quote the page each figure came from.`;

const answer = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";
/** What a prompt holds under `# Learned`, to the end of the run's instructions (pi's closes them with
 *  `</instructions>`); undefined with no `# Learned`. */
const learnedIn = (prompt) => {
  const head = "\n# Learned\n\n";
  const at = prompt.indexOf(head);
  return at < 0 ? undefined : /^([\s\S]*?)(?:\n<\/instructions>|$)/.exec(prompt.slice(at + head.length))[1];
};

/** Agent `id`'s newest save: its id (null with none), its version, who saved it, and the items it holds. */
const newestOf = (data, id) => overStore(data, async (store) => {
  const at = await store.learning.newest(id);
  return at ? { id: at.save.id, version: at.save.version, by: at.save.by, items: at.items.map(({ kind, name }) => `${kind}:${name}`) } : { id: null };
});
let saves = 0;
/** Saves `files` on agent `id`'s learning as a run's merge would leave it. Its save id. */
const saveOn = (data, id, files) => putLearning(data, id, files, { runId: `run-hand-${++saves}` });

/** Starts a run of agent `id` and waits for it to complete: its id and its answer, the prompt the faux model saw. */
async function ran(api, id) {
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  await learningEnded(api, run.body.run_id);
  return { runId: run.body.run_id, prompt: await answer(api, run.body.run_id) };
}

/** Once the run's learning has ended (it does not learn, or it merged or dropped). */
async function learningEnded(api, runId) {
  for (let i = 0; ["seeded", "reflecting"].includes((await api("GET", `/runs/${runId}`)).body.learning?.state); i++) {
    assert.ok(i < 600, "the run's learning ends");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Agent `id` with learning on, created, its first save made by a first run, with `files` then saved on it. */
async function learned(api, data, id, extra = {}, files = MAIN) {
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, ...extra }))).status, 201);
  await ran(api, id);
  return saveOn(data, id, files);
}

/** The run's learning, on its own read and in its agent's run list. */
async function learningOf(api, agentId, runId) {
  const listed = (await api("GET", `/agents/${agentId}/runs`)).body.runs.find((run) => run.run_id === runId);
  return { whole: (await api("GET", `/runs/${runId}`)).body.learning, short: listed.learning };
}

/** That run `runId` of agent `id` learned nothing and has no learning: no save, no section, no pin, `learning: null`. */
async function learnsNothing(api, data, id, runId, prompt) {
  assert.deepEqual(await newestOf(data, id), { id: null }, "no learning is saved");
  assert.equal(await pinOf({ data }, runId), undefined, "no pin");
  assert.ok(prompt.includes("Answer the question.") && !prompt.includes("# Learned"), prompt);
  assert.deepEqual(await learningOf(api, id, runId), { whole: null, short: null });
}

test("a new agent with learning on: its first run makes its first save, the host's, holding nothing yet, and starts seeded, told under # Learned that nothing is learned yet, as a restarted server reads it too", { timeout: 90_000 }, async (t) => {
  const first = await serve(t, { faux: SYSTEM });
  const { api, data } = first;
  assert.equal((await api("POST", "/agents", agent("fresh", { learning: true, instructions: "Answer the question." }))).status, 201);
  const { runId, prompt } = await ran(api, "fresh");
  const init = await newestOf(data, "fresh");
  assert.deepEqual([init.version, init.by, init.items], [1, { host: "init" }, []], "one save, the host's, nothing learned yet");
  assert.deepEqual(await savesOf(data, "fresh"), [], "the log shows none of the host's");
  assert.deepEqual(readdirSync(agentFolderOf(data, "fresh")).sort(), ["runs"], "no learning folder beside its runs");
  assert.deepEqual(await pinOf({ data }, runId), { seed: init.id });
  assert.ok(prompt.includes(`Answer the question.\n\n# Learned\n\n${NOTHING_YET}`), prompt);
  assert.ok(!prompt.includes(CORRECTIONS_INTRO), "no intro to corrections it has none of");
  // Seeded; nothing to keep from it.
  const { whole, short } = await learningOf(api, "fresh", runId);
  assert.deepEqual({ ...whole, at: typeof whole.at }, { state: "dropped", reason: "empty", detail: said.empty, at: "string" });
  assert.deepEqual(short, { state: "dropped", reason: "empty", detail: said.empty }, "a list says it in the same words");
  // A server started again reads the run's learning back, whole and in a list.
  await first.close();
  const again = await serve(t, { data, faux: SYSTEM });
  assert.deepEqual(await learningOf(again.api, "fresh", runId), { whole, short });
});

// The faux harness stands in for claude-agent's and codex's: it says the system prompt the run gives it.
for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`a fresh agent's first ${harness} run that learns is told nothing is learned yet, under one # Learned after its instructions`, { timeout: 90_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
    const id = `first-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness, instructions: "Answer the question." }))).status, 201);
    const { runId, prompt } = await ran(api, id);
    assert.deepEqual(await pinOf({ data }, runId), { seed: (await newestOf(data, id)).id }, "a first run has a pin, with nothing learned");
    assert.ok(prompt.includes(`Answer the question.\n\n# Learned\n\n${NOTHING_YET}`), prompt);
    assert.equal(prompt.split("# Learned").length, 2, "one section");
  });
}

for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`a ${harness} run starts from the newest save: its owner's corrections whole under # Learned`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
    const id = `seeded-${harness}`;
    const sha = await learned(api, data, id, { harness, instructions: "Answer the question." });
    const { runId, prompt } = await ran(api, id);
    assert.equal(learnedIn(prompt), SECTION, `${prompt}\n${JSON.stringify((await learningOf(api, id, runId)).whole)}`);
    assert.ok(prompt.includes(`Answer the question.\n\n# Learned\n\n${SECTION}`), `the section follows the instructions: ${prompt}`);
    assert.equal(prompt.split(CORRECTIONS_INTRO).length, 2, "said once");
    assert.ok(!prompt.includes(NOTHING_YET), prompt);
    assert.deepEqual(await pinOf({ data }, runId), { seed: sha, section: SECTION.slice(CORRECTIONS_INTRO.length + 2) });
    const { whole } = await learningOf(api, id, runId);
    assert.deepEqual([whole.state, whole.reason], ["dropped", "empty"], "seeded, and nothing to keep");
  });
}

test("learning is off unless the agent says so: an agent that leaves it out, or says false, gets no save, no # Learned, and learning: null", { timeout: 120_000 }, async (t) => {
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

test("a correction holding a value made one of the server's secrets after it was written: the run's instructions and its pin read it [redacted], though the save holds it", { timeout: 120_000 }, async (t) => {
  // Built at the run: a value no file of this repository holds.
  const value = ["shop", "key", process.pid, Date.now().toString(36), "0123456789"].join("-");
  withEnv(t, { SHOP_API_KEY: value });
  const { api, data } = await serve(t, { faux: SYSTEM });
  await learned(api, data, "leaky", { instructions: "Answer the question." }, { "corrections.md": `- Sign in with ${value}.\n` });
  assert.ok((await learningAt(data, "leaky")).text("corrections.md").includes(value), "the save holds it");
  const { runId, prompt } = await ran(api, "leaky");
  assert.ok(!prompt.includes(value), prompt);
  assert.equal(learnedIn(prompt), `${CORRECTIONS_INTRO}\n\n- Sign in with [redacted].`, prompt);
  assert.ok(!JSON.stringify(await pinOf({ data }, runId)).includes(value), "nor the pin");
});

// Waits on the switch (tl-untangle): a message to a run that ended on the runner answers 409, so the run is never
// continued here.
const CONTINUE_TODO = "the switch (tl-untangle): a run that ended on the runner is continued by a message";
test("the pin: a run keeps the save it was made from when the learning moves on, through a continue in a new process", { timeout: 120_000, skip: CONTINUE_TODO }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const sha = await learned(api, data, "pinned", { instructions: "Answer the question." });
  const { runId, prompt } = await ran(api, "pinned");
  const pin = JSON.stringify(await pinOf({ data }, runId));
  assert.equal(JSON.parse(pin).seed, sha);
  const later = await saveOn(data, "pinned", { "corrections.md": `${CORRECTIONS}- A rule main learned after the run was made.\n` });
  assert.notEqual(later, sha);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and again?" })).status, 202);
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const again = await answer(api, runId);
  assert.equal(JSON.stringify(await pinOf({ data }, runId)), pin, "the pin is never written again");
  assert.equal(learnedIn(again), learnedIn(prompt));
  assert.ok(!again.includes("main learned after"), again);
  // A run made now starts from the new save.
  const next = await ran(api, "pinned");
  assert.equal((await pinOf({ data }, next.runId)).seed, later);
  assert.match(learnedIn(next.prompt), /A rule main learned after the run was made\./, next.prompt);
});

test("two runs of a new agent made at once: one save made, the host's, and both runs seeded from it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  assert.equal((await api("POST", "/agents", agent("twice", { learning: true }))).status, 201);
  const made = await Promise.all([1, 2].map(() => api("POST", "/agents/twice/runs", { input: { content: "hi" } })));
  for (const run of made) assert.equal(run.status, 202, JSON.stringify(run.body));
  for (const run of made) await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  for (const run of made) await learningEnded(api, run.body.run_id);
  const { id: main, version, by } = await newestOf(data, "twice");
  assert.deepEqual([version, by], [1, { host: "init" }], "one save, made once");
  assert.deepEqual(await savesOf(data, "twice"), []);
  assert.deepEqual(await Promise.all(made.map(async (run) => (await pinOf({ data }, run.body.run_id)).seed)), [main, main]);
  for (const run of made) assert.equal((await api("GET", `/runs/${run.body.run_id}`)).body.learning.reason, "empty", "seeded, and nothing to keep");
});

test("two agents whose ids differ only in case: each has its own learning, in agent folders whose names differ in any case, and what one learned never seeds the other's run", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const sha = await learned(api, data, "Twin", { instructions: "Answer the question." });
  assert.equal((await api("POST", "/agents", agent("twin", { learning: true, instructions: "Answer the question." }))).status, 201);
  const other = await ran(api, "twin");
  // The agents' folders as the server made them: named as homeKey names, so apart even on a disk that folds case.
  const homes = readdirSync(join(data, "disk", "agents")).sort();
  assert.deepEqual(homes, [homeKey("Twin"), homeKey("twin")].sort());
  assert.equal(new Set(homes.map((name) => name.toLowerCase())).size, 2, "the names differ in any case");
  // The other's learning is new: one host save holding nothing, and its run learned nothing of Twin's.
  const fresh = await newestOf(data, "twin");
  assert.deepEqual([fresh.version, fresh.by, fresh.items], [1, { host: "init" }, []]);
  assert.equal(learnedIn(other.prompt), NOTHING_YET, other.prompt);
  assert.ok(!other.prompt.includes("Answer in tables"), other.prompt);
  assert.notEqual((await pinOf({ data }, other.runId)).seed, sha);
  // The one that learned still starts from its own.
  const own = await ran(api, "Twin");
  assert.equal(learnedIn(own.prompt), SECTION, own.prompt);
  assert.equal((await pinOf({ data }, own.runId)).seed, sha);
});

/** A scratch directory holding one file, `kept`, for a planted link to point at (or at its file). */
async function linkTarget(t) {
  const target = await scratch(t);
  writeFileSync(join(target, "kept"), "kept\n");
  return target;
}

// Waits on the switch's start (tl-untangle): a run is queued before any folder is made, so its start refuses nothing for
// its agent's folder; the runner's claim makes the run's folder.
const RUN_FOLDER_LINK_TODO = "the switch's start (tl-untangle): a run whose agent's folder is a link is refused at its start";
test("a symbolic link at disk/agents/<key>, the agent's folder, there before its first run: the run is refused at its start, since its own folder would be made through the link, and nothing is made where the link points", { timeout: 120_000, skip: RUN_FOLDER_LINK_TODO }, async (t) => {
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
