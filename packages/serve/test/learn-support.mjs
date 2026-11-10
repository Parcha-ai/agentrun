// What the learning tests share: an agent that learns, a run followed until the server's part of its learning is done,
// the runner's learning run's grade and merge on its proposal (learnedOnMain), and git in the test's own hands to read
// the agent's folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergedNote } from "../dist/learn/notes.js";
import { agentFolderOf } from "../dist/files.js";
import { learningRepair } from "../dist/learn/folder.js";
import { learningCommit, readMain } from "../dist/learn/commit.js";
import { learningFolderOf, PROPOSAL } from "../dist/learning.js";
import { judgeProposal } from "../dist/grade.js";
import { keptOf, mergeChangeOf } from "../dist/runner/learning-loop.js";
import { localWorkspace } from "../dist/workspace/index.js";
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

/** Run `runId`'s kept proposal graded and merged as the runner's learning run does it (runner/learning-loop.ts), on the
 *  agent's folder in the server's data: main read for the grade (readMain), the grader asked on the faux model by the
 *  agent's instructions (judgeProposal: gradePrompt and parseVerdict), then what the verdict keeps merged by the
 *  learning run's own rule (keptOf, mergeChangeOf) through the folder's one write (learningCommit). What it came to:
 *  `problems` (main refused it before the grade), `failed` (no verdict), `verdict` with `result` (learningCommit's) when
 *  the verdict merges, or `verdict` alone when it keeps nothing. */
export async function learnedOnMain(server, agentId, runId) {
  assert.ok(server.data && server.api, "the server's data and api");
  const proposal = JSON.parse(readFileSync(join(runDir(server.data, runId), PROPOSAL), "utf8"));
  // The instructions of the revision the run ran, whose faux grading rules ("Grade: ...") the grader reads.
  const { agent_version: version } = (await server.api("GET", `/runs/${runId}`)).body;
  const revisions = (await server.api("GET", `/agents/${agentId}/revisions?limit=100`)).body.revisions;
  const instructions = revisions.find((revision) => revision.version === version)?.definition?.instructions;
  assert.equal(typeof instructions, "string", `run ${runId}'s revision (version ${version}) has instructions`);
  // As the learning run does it: no queue held across the grade (a person's write meanwhile goes through), the merge
  // safe by learningCommit's own compare and swap and its check of the blobs the grade read.
  const { workspace, end } = learningFolderOf(server.data, agentId);
  try {
    const main = await readMain(workspace, proposal);
    if ("problems" in main) return { problems: main.problems };
    const judged = await judgeProposal({
      runId, agent: { instructions }, main, proposed: proposal.notes, ...(proposal.files ? { files: proposal.files } : {}),
      ...(proposal.asked ? { asked: proposal.asked } : {}), ...(proposal.triggered ? { triggered: proposal.triggered } : {}),
      env: { PATH: process.env.PATH, AGENTRUN_SERVE_FAUX: LEARN }, signal: new AbortController().signal,
    });
    if (!("verdict" in judged)) return { failed: judged.error };
    if (!judged.verdict.merge) return { verdict: judged.verdict };
    const merging = keptOf(proposal, judged.verdict);
    return { verdict: judged.verdict, result: await learningCommit(workspace, mergeChangeOf(runId, merging, judged.verdict, main.graded)) };
  } finally {
    await end();
  }
}

/** The run's serve.json once it holds where its learning ended, and that end's line in the learning ledger: the view
 *  shows the end first, the file follows, and the line after it. */
export async function savedOf(data, runId) {
  for (let i = 0; ; i++) {
    const meta = JSON.parse(readFileSync(join(runDir(data, runId), "serve.json"), "utf8"));
    if (["merged", "dropped"].includes(meta.learning?.state) && ledgerOf(data).some((line) => line.run === runId)) return meta;
    assert.ok(i < 200, `the run's learning end is saved: ${JSON.stringify(meta.learning)}`);
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
