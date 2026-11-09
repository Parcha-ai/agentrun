// What the learning tests share: an agent that learns, a run followed until the server's part of its learning is done,
// the runner's learning run's grade and merge on its proposal, waited for (learnedOnMain), and git in the test's own hands to read
// the agent's folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergedNote } from "../dist/learn/notes.js";
import { agentFolderOf } from "../dist/files.js";
import { learningRepair } from "../dist/learn/folder.js";
import { gradedItems, gradePrompt, parseVerdict, UNREADABLE_REASON } from "../dist/learn/index.js";
import { learningFolderOf } from "../dist/learning.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { openSqliteStore } from "../dist/store/index.js";
import { agent, follow, runDir } from "./support.mjs";

/** A run's new note as main keeps it once merged: with the host's `origin: you` line when it keeps the user's own words
 *  (the run's, the default, adds none). */
export const onMain = (text, origin = "run") => mergedNote(text, { origin });

/** The faux model and faux harness that plan an end-of-run turn's notes (fixtures/faux-learn.mjs). */
export const LEARN = new URL("./fixtures/faux-learn.mjs", import.meta.url).pathname;
/** What every run that learns is told first under `# Learned`, notes or none: that it learns, and how. */
export const KEEPS = "You learn from your runs. When this run ends you are asked what to keep for later runs, anything the person asked you to remember included, and only your answer then is kept: a file you write is not. So when the person asks you to remember something, don't put it in a file or say you can't: tell them in one short sentence at the start of your reply that you will keep it for later runs. When what they asked sets how your reply starts or ends, follow it from your reply's first line to its last and leave that sentence out. A secret (a password, key or token) is never kept, so say so instead.";
/** What `# Learned` says after KEEPS when the run starts with no note. */
export const NOTHING_YET = "Nothing learned yet.";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An agent with learning on and no tool: its end-of-run turn answers with the notes `plan` ([file, text] pairs) holds,
 *  planned after its instructions. */
export const learner = (id, { plan, once = false, instructions = "Answer the question.", ...extra } = {}) =>
  agent(id, { learning: true, instructions: [instructions, ...(plan ? [`Learn${once ? " once" : ""}: ${JSON.stringify(plan)}`] : [])].join("\n"), ...extra });

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

/** The server's part of a run's learning: seeded, its end-of-run turn asked, then what the turn wrote checked and kept as
 *  its proposal (proposed) or dropped. The grade and the merge are the runner's learning run (learnedOnMain). */
const UNDER_WAY = ["seeded", "reflecting"];
/** The run followed until it ended (`until`), then until the server's part of its learning is done: proposed, or
 *  dropped. Its view and its rows. */
export async function ended(api, runId, until = ["completed"]) {
  await follow(api, runId, until, { deadlineMs: 90_000 });
  for (let i = 0; UNDER_WAY.includes((await api("GET", `/runs/${runId}`)).body.learning?.state); i++) {
    assert.ok(i < 1200, "the run's learning ends");
    await sleep(50);
  }
  return { view: (await api("GET", `/runs/${runId}`)).body, rows: (await follow(api, runId, until)).rows };
}

/** Why a case on a run's own learning end (merged or dropped, its words, the verdict, what it learned or holds, the
 *  ledger's, usage's and stats' lines) waits: the server's grade wrote that end, and its reader of the runner's learning
 *  run is to come. The case is skipped with this reason (a failing todo is a `not ok` line, which a push refuses), and
 *  turns back on when it lands. With LEARN_RUN_END_PROBE set, every such case runs (skip false), to see which pass against
 *  the server as it stands while the switch lands; the marker goes from each case once it passes. */
export const RUN_END_TODO = process.env.LEARN_RUN_END_PROBE ? false : "E2s's reader: a run's learning end from learning_proposals and the learning run's journal";
export const SWITCH_TODO = process.env.LEARN_SWITCH_PROBE ? false : "the switch: the server answers from the store-backed run view (viewOverStore), which reads a run's learning end; these drive the file-backed server and turn back on when it is wired onto the store";

/** The server's part of the run's learning done: what its end-of-run turn wrote is kept as its proposal. */
export function proposedOf(view) {
  assert.equal(view.learning?.state, "proposed", JSON.stringify(view.learning));
}

/** A grade as the runner's learning run makes it (runner/learning-loop.ts), on a faux grader `reply` (a faux module's
 *  default export, called in this process as the faux model is): the prompt (gradePrompt) over `input`, the answer read
 *  (parseVerdict), and asked once more when it can't be read. The verdict, or `failed` when the grader fails. */
export async function gradeOnFaux(reply, input) {
  const prompt = gradePrompt({ run: input.runId, instructions: input.instructions, active: input.active, superseded: input.superseded, proposed: input.proposed, ...(input.files?.length ? { files: input.files } : {}), ...(input.asked ? { asked: input.asked } : {}), ...(input.triggered ? { triggered: input.triggered } : {}) });
  const items = gradedItems(input.proposed, input.files ?? []);
  const faux = { model: "faux", message: (text, extra = {}) => ({ text, ...extra }) };
  let verdict;
  for (let ask = 0; ask < 2; ask++) {
    const answer = await reply({ messages: [{ role: "user", content: prompt }] }, faux);
    if (answer.stopReason === "error") return { failed: new Error(answer.errorMessage ?? "the faux grader failed") };
    verdict = parseVerdict(answer.text, items);
    if (verdict.reason !== UNREADABLE_REASON || verdict.items.length) break;
  }
  return { verdict };
}

/** `read` over the server's store: the test's own handle on it (server.store), else one opened on the server's data
 *  for the read. */
async function overStore(server, read) {
  if (server.store) return read(server.store);
  const store = await openSqliteStore({ dataDir: server.data, role: "runner" });
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

/** Why a case waits on the runner's learned workflows (the lead's untangle/cutover-learning-workflows): the runner
 *  offers learned_workflow whenever the seed names workflows, as main's app.ts did (no grant needed), on pi and the CLI
 *  harnesses. Each such case is ported onto that behaviour and turns on when it merges; LEARN_WORKFLOWS_PROBE runs them. */
export const WORKFLOWS_TODO = process.env.LEARN_WORKFLOWS_PROBE ? false : "untangle/cutover-learning-workflows (the lead): the runner offers learned_workflow whenever the seed names workflows";
/** Why a case waits on read_skill_file's gate on the runner (tl-places' places/learning-seed-lay, 7434c0e830: the run's
 *  gate holds read_skill_file to read's key): a run that reads its learned skill is not parked on it. */
export const SKILL_GATE_TODO = process.env.LEARN_WORKFLOWS_PROBE ? false : "places/learning-seed-lay (tl-places): the run's gate holds read_skill_file to read's key";
/** Why a case waits on the runner's seed lay copying the index as main's pinSeed did (tl-places): the copy's MEMORY.md
 *  names the active notes alone. */
export const LAY_INDEX_TODO = process.env.LEARN_WORKFLOWS_PROBE ? false : "the runner's seed lay (tl-places): the copy's MEMORY.md names the active notes alone, as main's pinSeed did";

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

/** The learning ledger's lines, in order. */
export const ledgerOf = (data) => {
  const file = join(data, "learning-usage.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};

/** git in the test's own hands: no hook, and no system or global config. */
export function git(cwd, args) {
  const out = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "person", GIT_AUTHOR_EMAIL: "person@example.invalid", GIT_COMMITTER_NAME: "person", GIT_COMMITTER_EMAIL: "person@example.invalid" }, encoding: "utf8" });
  assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}
/** After a commit by the test's own hand (git, outside the learning script): the folder's snapshot rebuilt from main,
 *  as the server rebuilds it when a write finds main moved under its snapshot (learn/folder.ts learningRepair). Every
 *  read is the snapshot, so a hand commit is seen only once it is. */
export async function resnap(data, agentId) {
  const { workspace, end } = learningFolderOf(data, agentId);
  try {
    await learningRepair(workspace);
  } finally {
    await end();
  }
}
/** resnap for a folder by its path, at once: in a child process, for a helper that commits synchronously. */
export function resnapSync(repo) {
  const code = `const { learningRepair } = await import(${JSON.stringify(new URL("../dist/learn/folder.js", import.meta.url).href)}); const { localWorkspace } = await import(${JSON.stringify(new URL("../dist/workspace/index.js", import.meta.url).href)}); await learningRepair(localWorkspace(process.argv[1]));`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", code, repo], { encoding: "utf8" });
  assert.equal(out.status, 0, `the snapshot rebuilt: ${out.stderr}`);
}
/** A folderTestHooks.workspace (learn/folder.ts learningWorkspace's stand-in) that gives each agent's local learning
 *  folder with every call recorded in `calls`: [method, path] (exec: [method, its argv joined]), and each open and end
 *  counted in `calls.opened` and `calls.ended`. */
export const spiedWorkspace = (calls) => {
  calls.opened = 0;
  calls.ended = 0;
  return ({ agentId, data }) => {
    const root = repoOf(data, agentId);
    mkdirSync(root, { recursive: true });
    const ws = localWorkspace(root);
    const record = (method) => (first, ...rest) => {
      calls.push([method, Array.isArray(first) ? first.join(" ") : first]);
      return ws[method](first, ...rest);
    };
    calls.opened++;
    return {
      workspace: { read: record("read"), write: record("write"), append: record("append"), stat: record("stat"), list: record("list"), mkdir: record("mkdir"), grep: record("grep"), remove: record("remove"), exec: record("exec"), process: ws.process, mountSpec: () => ws.mountSpec(), attach: (...args) => ws.attach(...args) },
      end: async () => void calls.ended++,
    };
  };
};
/** Every object of the repository, read whole: what a scan for a value must search. */
export const objects = (repo) => spawnSync("git", ["cat-file", "--batch-all-objects", "--batch"], { cwd: repo, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, maxBuffer: 1 << 26 }).stdout.toString("latin1");

/** The agent's learning folder: `learning/` in its folder on the disk, as files.ts agentFolderOf names it. */
export const repoOf = (data, agentId) => join(agentFolderOf(data, agentId), "learning");
export const copyOf = (data, runId) => join(runDir(data, runId), "work", ".learning");
/** What the run's end-of-run turn answered, and what the user said, as its directory kept them when the run settled. */
export const turnOf = (data, runId) => JSON.parse(readFileSync(join(runDir(data, runId), "learning-turn.json"), "utf8"));
/** The commits on main that name run `runId` in a Run-Id trailer. */
export const mergesOf = (repo, runId) => git(repo, ["log", "--format=%H %(trailers:key=Run-Id,valueonly)", "main"]).split("\n").filter((entry) => entry.split(" ")[1] === runId);

/** What a prompt holds under `# Learned` after KEEPS, to the end of the run's instructions (pi's system prompt closes
 *  them with `</instructions>`): as the run's pin keeps it (`section`). Undefined when there is no `# Learned` that
 *  opens with KEEPS, or it says nothing is learned yet. */
export const learnedIn = (prompt) => {
  const head = `\n# Learned\n\n${KEEPS}\n\n`;
  const at = prompt.indexOf(head);
  if (at < 0) return undefined;
  const section = /^([\s\S]*?)(?:\n<\/instructions>|$)/.exec(prompt.slice(at + head.length))[1];
  return section === NOTHING_YET ? undefined : section;
};
/** The notes a section under `# Learned` gives whole, in order, by their headings, `## <name> (<file>)`. */
export const wholeIn = (section) => [...(section ?? "").matchAll(/^## .* \(([A-Za-z0-9][A-Za-z0-9._-]*\.md)\)$/gm)].map((match) => match[1]);

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
