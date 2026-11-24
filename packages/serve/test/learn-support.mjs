// What the learning tests share: an agent that learns, a run followed until its learning ended (its end-of-run step on
// the runner: its owner's correction appended, its compile turn checked and saved), and the agent's learning rows read
// and written in the test's own hands (Store.learning).
import assert from "node:assert/strict";
import { join } from "node:path";
import { learningOf, readOf, writeLearning } from "../dist/learn/rows.js";
import { openSqliteStore } from "../dist/store/index.js";
import { agent, follow } from "./support.mjs";

/** The faux model and faux harness learning's tests run on (fixtures/faux-learn.mjs). */
export const LEARN = new URL("./fixtures/faux-learn.mjs", import.meta.url).pathname;
/** What every run whose owner corrected it is told first under `# Learned` (learning.ts laidLearned). */
export const CORRECTIONS_INTRO = "Your owner's standing corrections from earlier runs, one per line. Follow each one that applies.";
/** What `# Learned` says when the owner corrected nothing yet. */
export const NOTHING_YET = "Nothing learned yet.";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An agent with learning on (`learning`, true unless given) and no tool. */
export const learner = (id, { instructions = "Answer the question.", learning = true, ...extra } = {}) => agent(id, { learning, instructions, ...extra });

export async function made(api, definition) {
  const res = await api("POST", "/agents", definition);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

export async function started(api, id, content = "Go.", extra = {}) {
  const run = await api("POST", `/agents/${id}/runs`, { input: { content }, ...extra });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

/** A run's learning while it is under way: seeded, then its end-of-run step (reflecting) until it merged or dropped. */
const UNDER_WAY = ["seeded", "reflecting"];
/** The run followed until it ended (`until`), then until its learning ended: merged or dropped. Its view and its rows,
 *  the run's learning row among them. */
export async function ended(api, runId, until = ["completed"]) {
  await follow(api, runId, until, { deadlineMs: 90_000 });
  for (let i = 0; UNDER_WAY.includes((await api("GET", `/runs/${runId}`)).body.learning?.state); i++) {
    assert.ok(i < 1800, "the run's learning ends");
    await sleep(50);
  }
  return { view: (await api("GET", `/runs/${runId}`)).body, rows: (await follow(api, runId, until)).rows };
}

/** A run of agent `id` that its owner corrected: its first round ends, then a grade with words (`label`) opens its
 *  feedback round, whose end appends the words to corrections.md as one line, followed until its learning ended (as
 *  `ended` reads it). */
export async function fedBack(api, id, { content = "Go.", label = "Keep the summary to three lines." } = {}) {
  const runId = await started(api, id, content);
  await ended(api, runId);
  const graded = await api("PUT", `/runs/${runId}/grade`, { correct: true, label });
  assert.deepEqual([graded.status, graded.body.feedback], [200, "correction"], JSON.stringify(graded.body));
  return ended(api, runId);
}

/** `read` over a store: `target` itself when it is one, a test server's own handle on it (`server.store`), else one
 *  opened on the data directory (`target`, or `target.data`) for the read. */
export async function overStore(target, read) {
  if (target?.learning) return read(target);
  if (target?.store) return read(target.store);
  const store = await openSqliteStore({ dataDir: typeof target === "string" ? target : target.data, role: "runner" });
  try {
    return await read(store);
  } finally {
    await store.close();
  }
}

/** Run `runId`'s journal entries of `kinds`, from the one store (store-reads/journal.ts runEntries), each its kind and its
 *  data, in order: what a run's own run.sqlite held on main. */
export async function entriesOf(server, runId, kinds) {
  const { runEntries } = await import("../dist/store-reads/journal.js");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const all = await overStore(server, (store) => runEntries(store, runId, BACKGROUND_CONTEXT));
  return all.filter((entry) => kinds.includes(entry.kind)).map((entry) => ({ kind: entry.kind, ...entry.data }));
}


/** Why a CLI harness's learned_workflow case waits (claude-agent, codex, opencode): on the switch a CLI harness's host
 *  tools, learned_workflow among them, land with tl-untangle's cli-tools-builder (b697d0e9bc). pi's cases, the tool's
 *  description and the gate's run. LEARN_WORKFLOWS_PROBE runs them. */

/** Run `runId`'s kept learning (its learning_proposals row: the turn and the proposal), from the server's store. */
export const keptProposal = (server, runId) => overStore(server, (store) => store.learning.proposal(runId));

/** What run `runId` was pinned to learn from, as its launch records it on the switch (run-launch.ts learningStartOf: the
 *  seed's commit, the notes given whole and the # Learned section), in the shape the server's pin (`learning.json`) had:
 *  `seed`, with `section` when it has one and `given` when it was given notes. Undefined for a run that does not learn. */
export async function pinOf(server, runId) {
  const learning = await overStore(server, async (store) => (await store.runs.launch(runId).catch(() => undefined))?.body?.learning);
  if (!learning) return undefined;
  return { seed: learning.seed, ...(learning.section ? { section: learning.section } : {}), ...(learning.given?.length ? { given: learning.given } : {}) };
}

/** Run `runId`'s learning, graded and merged by the runner's learning run (runner/learning-loop.ts, which the test
 *  server's in-process runner runs on the faux grader), once it has ended, as GET /runs/{id}/learning reads it: `verdict`
 *  with `result` (the merge: its commit on main) when it merged, `verdict` alone when the grader kept nothing,
 *  `problems` when the checks or main refused it, `failed` when the grade failed. */
export async function learnedOnMain(server, agentId, runId) {
  assert.ok(server.api, "the server's api");
  for (let i = 0; ; i++) {
    const learning = (await server.api("GET", `/runs/${runId}/learning`)).body;
    if (learning?.state === "merged") return { verdict: learning.verdict, result: { ok: true, main: learning.merged, commit: learning.merged } };
    if (learning?.state === "dropped") {
      if (learning.reason === "grade_failed") return { failed: new Error(learning.detail ?? "the grade failed") };
      if (learning.verdict) return { verdict: learning.verdict };
      return { problems: learning.problems ?? [] };
    }
    assert.ok(i < 1200, `run ${runId} of ${agentId}: its learning run ends: ${JSON.stringify(learning)}`);
    await sleep(50);
  }
}

/** Run `runId`'s learning once it has ended (merged or dropped), as the one store reads it (store-reads/learning.ts
 *  runLearningEnd: its kept learning and its learning run's journal): `{ learning }`, the shape a run's serve.json held
 *  on main. */
export async function savedOf(data, runId) {
  const { runLearningEnd } = await import("../dist/store-reads/learning.js");
  for (let i = 0; ; i++) {
    const learning = await overStore({ data }, (store) => runLearningEnd(store, runId));
    if (["merged", "dropped"].includes(learning?.state)) return { learning };
    assert.ok(i < 1200, `the run's learning ends: ${JSON.stringify(learning)}`);
    await sleep(50);
  }
}

/** Agent `agentId`'s learning at its newest save, as every reader reads it (learn/rows.ts readOf): `view` (undefined
 *  before its first save) and `text(path)`. */
export const learningAt = (target, agentId) => overStore(target, async (store) => readOf(await store.learning.newest(agentId)));

/** Agent `agentId`'s learning made unreadable in the SQLite store under `data` (a test server's): one workflow saved, its
 *  row's body then not JSON, as a damaged row reads. Its seed read fails, so a run of the agent starts with nothing
 *  learned (seed_failed). */
export async function unreadable(data, agentId) {
  await putLearning(data, agentId, { "workflows/answer/workflow.json": "{}", "workflows/answer/README.md": "---\nname: answer\ndescription: Answers\n---\n" });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(data, "store.sqlite"));
  try {
    assert.equal(db.prepare("UPDATE learning_items SET body = 'not json' WHERE agent_id = ? AND kind = 'workflow'").run(agentId).changes, 1);
  } finally {
    db.close();
  }
}

/** Writes `files` (path to text: corrections.md, `workflows/<name>/<file>`; null deletes) on agent `agentId`'s learning
 *  in one save, as a run's merge writes it (run `runId`, `reason` its log line) or, with `person` (a PersonKind), as a
 *  person's change of `file`. Answers the save's version id. What a test lays down by hand. */
export async function putLearning(target, agentId, files, { runId = "run-hand", reason = "learned by hand", person, file } = {}) {
  const entries = Object.entries(files);
  const by = person ? { person, file: file ?? entries[0][0] } : { run: runId, reason };
  return overStore(target, async (store) => {
    const { saved } = await writeLearning(learningOf(store, agentId), async () => ({
      result: undefined,
      change: { by, writes: entries.filter(([, text]) => text !== null).map(([path, text]) => ({ path, text })), deletes: entries.filter(([, text]) => text === null).map(([path]) => path) },
    }));
    assert.ok(saved, "the write saved");
    return saved.id;
  });
}

/** Agent `agentId`'s saves its log shows, newest first (Store.learning.saves). */
export const savesOf = (target, agentId) => overStore(target, async (store) => (await store.learning.saves(agentId, { limit: 10_000 })).saves);

/** The saves of agent `agentId`'s learning that run `runId` merged (its log's run saves), newest first. */
export const mergesOf = async (target, agentId, runId) => (await savesOf(target, agentId)).filter((save) => save.by.run === runId);

/** Every text agent `agentId`'s learning rows hold, read whole through the store: each save (its log line and paths),
 *  each version of each item it ever had (its body), each save's diff and every record (grades, promotions, audits).
 *  What a scan for a value must search. */
export async function learningText(target, agentId) {
  return overStore(target, async (store) => {
    const parts = [];
    const at = await store.learning.newest(agentId);
    const all = await store.learning.saves(agentId, { limit: 100_000 });
    for (const save of all.saves) {
      parts.push(JSON.stringify(save));
      parts.push(JSON.stringify(await store.learning.diff(agentId, save.id)));
    }
    const names = new Set((at?.history ?? []).map((one) => `${one.kind}\u0000${one.name}`));
    for (const key of names) {
      const [kind, name] = key.split("\u0000");
      parts.push(JSON.stringify(await store.learning.versions(agentId, kind, name)));
    }
    for (const kind of ["promotion", "grade", "audit"]) parts.push(JSON.stringify(await store.learning.records(agentId, kind)));
    return parts.join("\n");
  });
}

/** The end-of-run turn's own rows, and the run's learning rows. */
export const reflectRows = (rows) => rows.filter((row) => row.agent_label === "learning" && row.kind !== "learning");
export const learningRows = (rows) => rows.filter((row) => row.kind === "learning");

/** The machine's words, which nothing a person reads of a run's learning says (learning-words.ts). */
export const UNSAID = /\bmain\b|merged into|end-of-run|grader|verdict|\bpropos/i;

/** The run's learning ended as `state` (and `reason`): its view says so in a person's words, and its one learning row
 *  holds it and says the same. */
export function settled(view, rows, state, reason = null) {
  assert.deepEqual([view.learning?.state, view.learning?.reason], [state, reason], JSON.stringify(view.learning));
  assert.equal(typeof view.learning.detail, "string");
  assert.doesNotMatch(view.learning.detail, UNSAID, "said in a person's words");
  const [row, ...more] = learningRows(rows);
  assert.equal(more.length, 0, "one learning row");
  assert.deepEqual([row?.agent_label, row?.learning, row?.summary], ["learning", { state, reason, detail: view.learning.detail }, view.learning.detail]);
}
