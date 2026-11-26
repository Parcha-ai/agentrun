// What a run's learning must never keep, on the runner path (runner/learning-end.ts correctionRefused, reflect-hook.ts):
// an owner's correction (a grade's words) holding the server's API token; one holding a key handed over by the launcher,
// base64-wrapped; and one holding a secret's shape or a character a reader does not see. Each is refused by the checks:
// no learning row holds the value, the run's kept learning (learning_proposals) and its view hold none of it, and its
// agent's learning gets no save.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { ended, keptProposal, LEARN, learner, learningText, made, savedOf, savesOf, settled, sleep, started } from "./learn-support.mjs";
import { client, scratch, serve } from "./support.mjs";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;

/** Agent `id`'s run, ended, then graded with `words`: its correction round, ended. */
async function corrected(api, id, words) {
  const runId = await started(api, id);
  await ended(api, runId);
  const graded = await api("PUT", `/runs/${runId}/grade`, { correct: false, label: words });
  assert.deepEqual([graded.status, graded.body.feedback], [200, "correction"], JSON.stringify(graded.body));
  return { runId, ...(await ended(api, runId)) };
}

test("a correction that holds the server's API token is refused as secret_value: no learning row, no kept learning and nothing the run shows holds it", { timeout: 120_000 }, async (t) => {
  // The server's own API token: the runner never holds it, and its learning end refuses it among the store's secrets.
  const server = await serve(t, { learning: "on", faux: LEARN });
  const { api, data, token: key } = server;
  await made(api, learner("doorman"));
  const { runId, view, rows } = await corrected(api, "doorman", `The door takes ${key}`);
  settled(view, rows, "dropped", "checker");
  const { learning } = await savedOf(data, runId);
  assert.ok(learning.problems.some((problem) => problem.rule === "secret_value" && problem.path === "corrections.md"), JSON.stringify(learning.problems));
  assert.ok(!(await learningText(server, "doorman")).includes(key), "no learning row holds the key");
  assert.ok(!JSON.stringify(learning).includes(key), "the run's learning view does not hold it");
  assert.ok(!JSON.stringify(await keptProposal(server, runId)).includes(key), "nor its kept learning");
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

test("under the launcher's custody, a correction that holds the model key it handed over, base64-wrapped, is refused as secret_value: no learning row holds the key, and nothing the run shows or keeps does", { timeout: 120_000 }, async (t) => {
  // Built at the run, from parts: a value no file of this repository holds.
  const key = ["canary", process.pid, Date.now().toString(36), "a1b2c3"].join("-");
  const token = randomBytes(24).toString("hex");
  const { child, api, data, stop } = await launched(t, { AGENT_MODEL_API_KEY: key, AGENTRUN_TOKEN: token });
  assert.ok(!readFileSync(`/proc/${child.pid}/environ`).includes(key), "the server holds the key, not its environment");
  const wrapped = Buffer.from(`key=${key};`).toString("base64");
  await made(api, learner("keeper"));
  const { runId, view, rows } = await corrected(api, "keeper", `Send ${wrapped} first.`);
  settled(view, rows, "dropped", "checker");
  const { learning } = await savedOf(data, runId);
  assert.ok(learning.problems.some((problem) => problem.rule === "secret_value" && problem.path === "corrections.md"), JSON.stringify(learning.problems));
  const held = await learningText({ data }, "keeper");
  assert.ok(!held.includes(key) && !held.includes(wrapped), "no learning row holds the key");
  const kept = await keptProposal({ data }, runId);
  const shown = JSON.stringify([view, rows, (await api("GET", "/runs")).body, learning, kept]);
  assert.ok(!shown.includes(key) && !shown.includes(wrapped), "the key is nowhere the run is shown or kept");
  await stop();
});

test("a correction holding a secret's shape or an unseen character is refused: no save is made, and the shape is cut from what is kept", { timeout: 150_000 }, async (t) => {
  const shaped = ["s", "k-", "Zx9".repeat(10)].join("");
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  for (const [id, words, rule] of [["edit-secret", `Sign in with ${shaped}.`, "secret_shape"], ["edit-hidden", `Refunds live under /orders/${String.fromCodePoint(0x202e)}.`, "invisible_unicode"]]) {
    await made(api, learner(id));
    // The first run makes the first save; its correction is refused.
    const { runId, view, rows } = await corrected(api, id, words);
    settled(view, rows, "dropped", "checker");
    const { learning } = await savedOf(data, runId);
    assert.ok(learning.problems.some((problem) => problem.rule === rule && problem.path === "corrections.md"), `${id}: ${JSON.stringify(learning.problems)}`);
    assert.ok(!JSON.stringify(learning).includes(shaped), "the secret is never printed");
    assert.deepEqual(await savesOf({ data }, id), [], `${id}: nothing saved past its first, empty save`);
    assert.ok(!(await learningText({ data }, id)).includes(shaped), `${id}: no learning row holds the shape`);
    assert.ok(!JSON.stringify(await keptProposal({ api, data }, runId)).includes(shaped), `${id}: the shape is cut from what is kept`);
  }
});
