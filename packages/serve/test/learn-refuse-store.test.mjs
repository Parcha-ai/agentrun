// What a run's learning must never keep, on the runner path (runner/learning-end.ts, reflect-hook.ts, the checks in
// propose.ts): a key the run holds, asked to be kept in the person's own words; a key handed over by the launcher,
// base64-wrapped; an edit or a note left out unread that hides a secret's shape, which refuses the whole answer; and
// anything the run put in its copy of the folder, links among it, which is never read. Each is learn-merge's custody
// case, ported from the server's own check to the runner's: no git object holds the value, the run's kept learning
// (learning_proposals) and its view hold none of it, and nothing merges.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { copyOf, ended, git, keptProposal, LEARN, learnedOnMain, learner, made, objects, reflectRows, repoOf, resnap, savedOf, settled, sleep, started } from "./learn-support.mjs";
import { client, scratch, serve, withEnv } from "./support.mjs";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const TABLES = note("Prefers tables", "The user reads results as tables");
const REFUNDS = note("Refunds path", "Refunds live under /help/");
const INDEX = "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Refunds path](refunds.md) — Refunds live under /help/\n";
const SEED = { "prefers-tables.md": TABLES, "refunds.md": REFUNDS, "MEMORY.md": INDEX };

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

/** Agent `id`'s instructions now plan `plan`, as a new revision of it. */
async function plans(api, id, plan, extra = {}) {
  const { id: _, version, ...definition } = learner(id, { plan, ...extra }).definition;
  const res = await api("PUT", `/agents/${id}/definition`, { definition });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

test("a note that holds a key the run holds, asked to be kept in the person's words, is refused as secret_value: no git object, no kept learning and nothing the run shows holds it", { timeout: 120_000 }, async (t) => {
  // A key the runner holds (a key-named value in its environment): the runner's run has no door token of its own.
  const key = `not-a-secret-${"door"}-${randomBytes(12).toString("hex")}`;
  withEnv(t, { LEARN_PROBE_API_KEY: key });
  const server = await serve(t, { learning: "on", faux: LEARN });
  const { api, data } = server;
  await made(api, learner("doorman"));
  const runId = await started(api, "doorman", `Remember for next time: The door takes ${key}`);
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "checker");
  const { learning } = await savedOf(data, runId);
  assert.ok(learning.problems.some((problem) => problem.rule === "secret_value" && problem.path === "remembered.md"), JSON.stringify(learning.problems));
  assert.ok(!objects(repoOf(data, "doorman")).includes(key), "no git object holds the key");
  assert.ok(!JSON.stringify(learning).includes(key), "the run's learning view does not hold it");
  assert.ok(!JSON.stringify(await keptProposal(server, runId)).includes(key), "nor its kept learning");
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
  const learned = await learnedOnMain({ api, data }, "linker", runId);
  assert.equal(learned.result?.ok, true, JSON.stringify(learned));
  const repo = repoOf(data, "linker");
  assert.deepEqual(git(repo, ["ls-tree", "--name-only", "main"]).split("\n"), ["MEMORY.md", "fine.md"], "the answer's note alone");
  assert.ok(!objects(repo).includes(secret), "no git object holds the target's text");
  assert.ok(!JSON.stringify([view, rows, learned, await keptProposal({ api, data }, runId)]).includes(secret));
});

/** The server, started by its launcher with `env`: the launcher hands its secrets over and the server and its runner
 *  hold them, none in their environment (secrets.ts). */
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

test("under the launcher's custody, a note that holds the model key it handed over, base64-wrapped, is refused as secret_value: no git object holds the key, and nothing the run shows or keeps does", { timeout: 120_000 }, async (t) => {
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
  const kept = await keptProposal({ data }, runId);
  assert.ok(!kept.learningRunId, "no learning run queued");
  const shown = JSON.stringify([view, rows, (await api("GET", "/runs")).body, learning, kept]);
  assert.ok(!shown.includes(key) && !shown.includes(wrapped), "the key is nowhere the run is shown or kept");
  await stop();
});

test("an edit to a note that was there, holding a secret's shape or an unseen character, refuses the whole answer: the good new note beside it is not kept either", { timeout: 150_000 }, async (t) => {
  const shaped = ["s", "k-", "Zx9".repeat(10)].join("");
  for (const [id, body, rule] of [["edit-secret", `Refunds live under /orders/. Sign in with ${shaped}.\n`, "secret_shape"], ["edit-hidden", "Refunds live under /orders/‮.\n", "invisible_unicode"]]) {
    const { api, data, repo } = await seeded(t, id, SEED);
    const main = git(repo, ["rev-parse", "main"]);
    await plans(api, id, [["refunds.md", note("Refunds path", "Refunds live under /orders/", body)], ["check-units.md", note("Check units", "Convert every amount to one unit before comparing")]]);
    const runId = await started(api, id);
    const { view, rows } = await ended(api, runId);
    settled(view, rows, "dropped", "checker");
    const { learning } = await savedOf(data, runId);
    assert.ok(learning.problems.some((problem) => problem.rule === rule && problem.path === "refunds.md"), JSON.stringify(learning.problems));
    assert.ok(!JSON.stringify(learning).includes(shaped), "the secret is never printed");
    assert.equal(git(repo, ["rev-parse", "main"]), main, "nothing merged");
    const kept = await keptProposal({ api, data }, runId);
    assert.ok(!kept.learningRunId && !JSON.stringify(kept).includes(shaped), "nothing proposed, and the shape is cut from what is kept");
  }
});

test("a note left out unread (over its cap, or misnamed) that hides a secret's shape refuses the whole answer: the good new note beside it is not kept", { timeout: 150_000 }, async (t) => {
  const shaped = ["s", "k-", "Zx9".repeat(10)].join("");
  const good = ["check-units.md", note("Check units", "Convert every amount to one unit before comparing")];
  for (const [id, file, body] of [["over-cap", "big-note.md", `Sign in with ${shaped}.\n${"x".repeat(5000)}\n`], ["misnamed", "Bad_Name.md", `Sign in with ${shaped}.\n`]]) {
    const { api, data, repo } = await seeded(t, id, SEED);
    const main = git(repo, ["rev-parse", "main"]);
    await plans(api, id, [[file, note("Hidden", "A note the checks refuse unread", body)], good]);
    const runId = await started(api, id);
    const { view, rows } = await ended(api, runId);
    settled(view, rows, "dropped", "checker");
    const { learning } = await savedOf(data, runId);
    assert.ok(learning.problems.some((problem) => problem.rule === "secret_shape"), JSON.stringify(learning.problems));
    assert.equal(git(repo, ["rev-parse", "main"]), main, `${id}: nothing merged`);
    assert.ok(!JSON.stringify(await keptProposal({ api, data }, runId)).includes(shaped), `${id}: the shape is cut from what is kept`);
  }
});
