// The end-of-run turn: once a run that learns answers or fails, the server asks the same session one more turn through
// the run's door, under a fixed request id, at most once; the answer stays the job's. The turn answers with its notes,
// which the server reads from its answer, whatever tools the agent has: nothing the run wrote in `.learning/` counts,
// and what the user asked it to remember during the task is in the answer. A skip or a drop says why, in the run's
// learning and in one timeline row of kind `learning`, a seed that failed included.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ANSWER_TOKENS_LEAST } from "../dist/cap.js";
import { agentFolderOf } from "../dist/files.js";
import { learningTestHooks } from "../dist/learning.js";
import { answerWith, note } from "./fixtures/faux-learn.mjs";
import { copyOf, ended, git, keptProposal, LEARN, learnedOnMain, learner, learningRows, made, onMain, proposedOf, reflectRows, repoOf, savedOf, settled, sleep, started } from "./learn-support.mjs";
import { agent, client, follow, serve, withEnv } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
/** A request's least under OUTPUT_PRICED: its answer's 1,024 tokens (the faux model does not think), at $100 per million.
 *  A cap sends any request it can buy this much of, limited to what it can buy, and refuses one it cannot. */
const LEAST = (ANSWER_TOKENS_LEAST * 100) / 1e6;
const PLAN = [["check-units.md", note("Check units", "Convert every amount to one unit before comparing")]];

/** The bin on `data`, as an operator starts it. */
async function serverProcess(data) {
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", LEARN], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTRUN_ACCOUNTS: "0" } });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  for (let i = 0; !/AGENTRUN_BASE_URL=/.test(out); i++) {
    // 90 s: a loaded machine can take well over 20 s to start a server process (the test's own timeout is 150 s).
    assert.ok(i < 1800 && child.exitCode === null, `the server did not start: ${out}`);
    await sleep(50);
  }
  return { child, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], (await readFile(join(data, ".token"), "utf8")).trim()) };
}

/** Holds every run's seed copy once its pin is in place, until released: the run's directory, as each is held. */
function holdSeeds(t) {
  const held = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  learningTestHooks.afterPin = async (dir) => {
    held.push(dir);
    await gate;
  };
  t.after(() => void (learningTestHooks.afterPin = undefined));
  return { held, release: () => { learningTestHooks.afterPin = undefined; release(); } };
}
const heldRun = async (held) => {
  for (let i = 0; !held.length; i++) {
    assert.ok(i < 1200, "the seed is copied");
    await sleep(25);
  }
  return held[0].split("/").at(-1);
};

test("a seed that failed is a learning row, seed_failed, and a run that does not learn has none", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("blocked", { plan: PLAN }));
  await made(api, agent("plain", { tools: ["write"] }));
  await mkdir(agentFolderOf(data, "blocked"), { recursive: true });
  await writeFile(join(agentFolderOf(data, "blocked"), "learning"), "not a folder");
  // (On the switch a run's learning reads from its kept learning, written at its end: none is shown while it runs.)
  const runId = await started(api, "blocked");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "seed_failed");
  assert.equal(reflectRows(rows).length, 0, "no turn: nothing was seeded");
  const plainId = await started(api, "plain");
  const plain = await follow(api, plainId, ["completed"]);
  assert.deepEqual([learningRows(plain.rows).length, reflectRows(plain.rows).length], [0, 0]);
  assert.equal((await api("GET", `/runs/${plainId}`)).body.learning, null);
});

test("the end-of-run turn's write under .learning/ is refused, in words that keep its notes to its answer; the note in its answer still merges, and no file it tried to write is kept", { timeout: 150_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("writer", { plan: PLAN, tools: ["write"], instructions: "Answer the question.\nReflect by writing first." }));
  const runId = await started(api, "writer");
  const { view, rows } = await ended(api, runId);
  proposedOf(view);
  assert.equal((await learnedOnMain({ api, data }, "writer", runId)).result?.ok, true);
  const refused = rows.find((row) => row.kind === "tool_result" && row.tool_name === "write");
  assert.equal(refused?.tool_result_preview, "A note is kept only from your answer: write it in a ```note block, not to a file.", "the write is refused in those words");
  assert.ok(!existsSync(join(copyOf(data, runId), "written.md")), "and nothing is written");
  const repo = repoOf(data, "writer");
  assert.equal(`${git(repo, ["show", "main:check-units.md"])}\n`, onMain(PLAN[0][1]), "the answer's note merged");
});

test("what the user asks the agent to remember during the task survives: the job writes it to .learning/notes.txt and says it saved it, and the end-of-run turn, which reads the whole conversation, answers it as a note that merges; a file the job scribbled in .learning/ is never read", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("keeper", { tools: ["write"], instructions: `Answer the question.\nScribble: ${JSON.stringify([["draft.md", note("Draft", "A note the job wrote mid-task")]])}` }));
  const runId = await started(api, "keeper", "Find the refund page. Remember for next time: I only care about US policies.");
  const { view, rows } = await ended(api, runId);
  assert.ok(rows.some((row) => row.kind === "tool_result" && row.tool_name === "write" && row.agent_label !== "learning"), "the job wrote in .learning/ during the task");
  assert.equal(view.result.final_answer, "Got it: I saved that in .learning/notes.txt.");
  proposedOf(view);
  assert.equal((await learnedOnMain({ api, data }, "keeper", runId)).result?.ok, true);
  const repo = repoOf(data, "keeper");
  assert.deepEqual(git(repo, ["ls-tree", "--name-only", "main"]).split("\n"), ["MEMORY.md", "remembered.md"], "the answer's note, and nothing the job wrote");
  assert.match(git(repo, ["show", "main:remembered.md"]), /I only care about US policies\./);
  assert.deepEqual((await keptProposal({ api, data }, runId)).turn.asked, ["Find the refund page. Remember for next time: I only care about US policies."]);
});

test("an answer that gives its notes out of format is dropped as unparsed, and one whose note holds a host key as checker, the answer kept with the run's learning and the key in no proposal", { timeout: 120_000 }, async (t) => {
  // A key the runner holds (a key-named value in its environment), which its learning end refuses.
  const token = `not-a-secret-${"probe"}-${randomBytes(12).toString("hex")}`;
  withEnv(t, { LEARN_PROBE_API_KEY: token });
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("loose", { instructions: `Answer: ${JSON.stringify(`I would keep this:\n\n${PLAN[0][1]}`)}` }));
  const loose = await ended(api, await started(api, "loose"));
  settled(loose.view, loose.rows, "dropped", "unparsed");
  const kept = await keptProposal({ api, data }, loose.view.run_id);
  assert.equal(kept.learningRunId, undefined, "no learning run");
  assert.match(kept.turn.answer, /^I would keep this:/, "the answer is kept for the log");
  await made(api, learner("leaky", { instructions: `Answer: ${JSON.stringify(answerWith([["leak.md", note("Leak", "A host key", `It is ${token}.\n`)]]))}` }));
  const leaky = await ended(api, await started(api, "leaky"));
  settled(leaky.view, leaky.rows, "dropped", "checker");
  const { learning } = await savedOf(data, leaky.view.run_id);
  assert.deepEqual(learning.problems.map((p) => [p.rule, p.path]), [["secret_value", "leak.md"]]);
  const refused = await keptProposal({ api, data }, leaky.view.run_id);
  assert.ok(!refused.learningRunId && !JSON.stringify(refused).includes(token), "nothing is kept that the checks refuse, and the key is cut from what is");
  assert.equal(git(repoOf(data, "leaky"), ["rev-list", "--count", "main"]), "1");
});
