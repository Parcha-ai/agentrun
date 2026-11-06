// What the learning tests share: an agent that learns, a run followed until its learning ends, and git in the test's own
// hands to read the agent's folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergedNote } from "../dist/learn/notes.js";
import { agentFolderOf } from "../dist/files.js";
import { agent, follow, runDir } from "./support.mjs";

/** A run's new note as main keeps it once merged: with the host's `origin: you` line when it keeps the user's own words
 *  (the run's, the default, adds none). */
export const onMain = (text, origin = "run") => mergedNote(text, { origin });

/** The faux model and faux harness that plan an end-of-run turn's notes (fixtures/faux-learn.mjs). */
export const LEARN = new URL("./fixtures/faux-learn.mjs", import.meta.url).pathname;
/** What every run that learns is told first under `# Learned`, notes or none: that it learns, and how. */
export const KEEPS = "You learn from your runs. When this run ends you are asked what to keep for later runs, anything the person asked you to remember included, and only your answer then is kept: a file you write is not. So when the person asks you to remember something, don't put it in a file or say you can't: tell them you will keep it for later runs, in one short sentence at the start of your reply, never after a closing line or sign-off they asked you to end with. A secret (a password, key or token) is never kept, so say so instead.";
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

const UNDER_WAY = ["seeded", "reflecting", "proposed"];
/** The run followed until it ended (`until`), then until its learning is merged or dropped: its view and its rows. */
export async function ended(api, runId, until = ["completed"]) {
  await follow(api, runId, until, { deadlineMs: 90_000 });
  for (let i = 0; UNDER_WAY.includes((await api("GET", `/runs/${runId}`)).body.learning?.state); i++) {
    assert.ok(i < 1200, "the run's learning ends");
    await sleep(50);
  }
  return { view: (await api("GET", `/runs/${runId}`)).body, rows: (await follow(api, runId, until)).rows };
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
