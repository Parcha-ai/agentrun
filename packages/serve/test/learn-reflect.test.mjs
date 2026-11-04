// The end-of-run turn: once a run that learns answers or fails, the server asks the same session one more turn through
// the run's door, under a fixed request id, at most once; the answer stays the job's. A skip or a drop says why, in the
// run's learning and in one timeline row of kind `learning`, a seed that failed included.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { ANSWER_TOKENS_LEAST } from "../dist/cap.js";
import { homeOf } from "../dist/files.js";
import { startServe } from "../dist/index.js";
import { learningTestHooks } from "../dist/learning.js";
import { note } from "./fixtures/faux-learn.mjs";
import { copyOf, ended, git, LEARN, learner, learningRows, made, reflectRows, repoOf, settled, sleep, started, turnCopyOf } from "./learn-support.mjs";
import { agent, client, follow, scratch, serve, storeRun } from "./support.mjs";

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
    assert.ok(i < 400 && child.exitCode === null, `the server did not start: ${out}`);
    await sleep(50);
  }
  return { child, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], (await readFile(join(data, ".token"), "utf8")).trim()) };
}

test("a server that goes while a run reflects: the next one asks the turn again under the same request id, the run's process takes it once, and what it wrote merges", { timeout: 150_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const go = join(await scratch(t), "go");
  const first = await serverProcess(data);
  t.after(() => first.child.kill("SIGKILL"));
  await made(first.api, learner("crash", { instructions: `Say your prompt. Reflect once ${go} exists.`, plan: PLAN }));
  const runId = await started(first.api, "crash");
  for (let i = 0; !reflectRows((await first.api("GET", `/runs/${runId}/timeline`)).body.rows ?? []).some((row) => row.kind === "user_message"); i++) {
    assert.ok(i < 600, "the turn is taken");
    await sleep(50);
  }
  assert.equal((await first.api("GET", `/runs/${runId}`)).body.learning.state, "reflecting");
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const pid = JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8")).holder.pid;
  assert.ok(processAlive(pid), "the run's process outlived its server, mid-turn");
  t.after(() => processAlive(pid) && process.kill(pid, "SIGKILL"));
  const next = await startServe({ data, port: 0, faux: LEARN, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  writeFileSync(go, "");
  const { view, rows } = await ended(api, runId);
  assert.ok(view.result.final_answer.includes("Say your prompt.") && !view.result.final_answer.includes("Reflected."), view.result.final_answer);
  settled(view, rows, "merged");
  assert.equal(reflectRows(rows).filter((row) => row.kind === "user_message").length, 1, "asked once, though asked by two servers");
  assert.equal(reflectRows(rows).filter((row) => row.text === "Reflected.").length, 1, "one turn");
  assert.equal(processAlive(pid), false, "the run's process was let go");
  assert.equal(storeRun(data, runId).state, "completed");
});

test("a turn that does not end in time is aborted: the run completes with its answer, and its learning is dropped as reflect_timeout", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { learning: "on", faux: LEARN, reflectTimeoutMs: 1_500 });
  await made(api, learner("slow", { instructions: "Reflect slowly.", plan: PLAN }));
  const { view, rows } = await ended(api, await started(api, "slow"));
  assert.equal(view.result.final_answer, "Job answer.");
  settled(view, rows, "dropped", "reflect_timeout");
  assert.equal(reflectRows(rows).filter((row) => row.kind === "user_message").length, 1, "the turn was asked");
});

test("no_budget: a turn whose request the run's cap refuses, and a run whose cap stopped its job (no turn sent); no_write_tool: an agent without write is asked nothing", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: OUTPUT_PRICED });
  // What the job's one request costs, from a run that does not learn.
  await made(api, agent("probe", { tools: ["write"], learning: false }));
  const probe = await ended(api, await started(api, "probe", "hi"));
  const spent = probe.view.cost.usd;
  assert.ok(spent > 0);
  // Room for one request's least and half of what the job costs: the job's request is sent (limited), and once the job
  // has spent, what is left is short of the turn's least, so its request is refused.
  await made(api, learner("tight"));
  const tight = await ended(api, await started(api, "tight", "hi", { max_cost_usd: LEAST + spent / 2 }));
  assert.deepEqual([tight.view.status, tight.view.error], ["completed", null]);
  settled(tight.view, tight.rows, "dropped", "no_budget");
  assert.equal(tight.view.cost.usd, spent, "only the job was paid for");
  assert.match(reflectRows(tight.rows).find((row) => row.kind === "error")?.text ?? "", /^spend_cap_reached \(out of budget\): Not sent: the run has spent \$[\d.]+ of its \$[\d.]+ cap, and its next faux-1 request needs at least \$[\d.]+\. Raise the cap to at least \$[\d.]+ to run it\.$/);
  await made(api, learner("broke"));
  // Half a request's least: the job's first request is refused, so no turn is sent.
  const broke = await ended(api, await started(api, "broke", "hi", { max_cost_usd: LEAST / 2 }), ["failed"]);
  assert.equal(broke.view.error.code, "spend_cap_reached");
  settled(broke.view, broke.rows, "dropped", "no_budget");
  assert.equal(reflectRows(broke.rows).length, 0, "no turn");
  await made(api, agent("mute", { learning: true }));
  const mute = await ended(api, await started(api, "mute", "hi"));
  settled(mute.view, mute.rows, "dropped", "no_write_tool");
  assert.equal(reflectRows(mute.rows).length, 0, "no turn");
  // The copy the run started with is as it was laid: no turn touched it.
  assert.equal(readFileSync(join(copyOf(data, mute.view.run_id), "MEMORY.md"), "utf8"), "");
});

test("a seed that failed is a learning row from the run's start, and a run that does not learn has none", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("blocked", { plan: PLAN }));
  await made(api, agent("plain", { tools: ["write"] }));
  await mkdir(homeOf(data, "blocked"), { recursive: true });
  await writeFile(join(homeOf(data, "blocked"), "learning"), "not a folder");
  const runId = await started(api, "blocked");
  const early = learningRows((await api("GET", `/runs/${runId}/timeline`)).body.rows);
  assert.deepEqual(early.map((row) => [row.learning.state, row.learning.reason]), [["dropped", "seed_failed"]], "shown as the run starts");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "seed_failed");
  assert.equal(reflectRows(rows).length, 0, "no turn: nothing was seeded");
  const plainId = await started(api, "plain");
  const plain = await follow(api, plainId, ["completed"]);
  assert.deepEqual([learningRows(plain.rows).length, reflectRows(plain.rows).length], [0, 0]);
  assert.equal((await api("GET", `/runs/${plainId}`)).body.learning, null);
});

test("a follow-up sent as the run settles changes nothing that is checked: the turn's .learning/ was set aside before the run read completed, the proposal holds exactly the turn's note, and the follow-up finds .learning/ laid again from the seed", { timeout: 150_000 }, async (t) => {
  // What the turn wrote is checked only once the test lets it: the follow-up runs first, as fast as a person could.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  learningTestHooks.beforePropose = () => held;
  t.after(() => {
    learningTestHooks.beforePropose = undefined;
    release();
  });
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("follower", { plan: PLAN }));
  const runId = await started(api, "follower");
  await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.learning.state, "reflecting", "its check waits");
  // As it read completed, the turn's copy was already out of its work, in the run's directory.
  assert.deepEqual(readdirSync(turnCopyOf(data, runId)).sort(), ["MEMORY.md", "check-units.md"]);
  assert.equal(readFileSync(join(turnCopyOf(data, runId), "check-units.md"), "utf8"), PLAN[0][1]);
  assert.equal(existsSync(copyOf(data, runId)), false);

  // The follow-up edits the note the turn wrote and adds another, in .learning/, with the agent's own write tool.
  const EDITED = note("Check units", "Convert nothing", "Units never matter.\n");
  const EXTRA = note("Extra", "A note the follow-up wrote");
  const sent = await api("POST", `/runs/${runId}/messages`, { content: `Write: ${JSON.stringify([["check-units.md", EDITED], ["extra.md", EXTRA]])}` });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const after = await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  assert.ok(after.rows.some((row) => row.kind === "final_answer" && row.text === "Written."), "the follow-up answered");
  // It found its copy laid again from the seed (an empty MEMORY.md), and its writes landed there.
  assert.deepEqual(readdirSync(copyOf(data, runId)).sort(), ["MEMORY.md", "check-units.md", "extra.md"]);
  assert.equal(readFileSync(join(copyOf(data, runId), "MEMORY.md"), "utf8"), "");
  assert.equal(readFileSync(join(copyOf(data, runId), "check-units.md"), "utf8"), EDITED);

  release();
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "merged");
  assert.deepEqual(JSON.parse(readFileSync(join(data, "runs", runId, "learning-proposal.json"), "utf8")).notes, [{ file: "check-units.md", text: PLAN[0][1] }], "exactly the turn's note");
  const repo = repoOf(data, "follower");
  assert.equal(`${git(repo, ["show", "main:check-units.md"])}\n`, PLAN[0][1]);
  assert.deepEqual(git(repo, ["ls-tree", "--name-only", "main"]).split("\n"), ["MEMORY.md", "check-units.md"], "nothing of the follow-up's");
});
