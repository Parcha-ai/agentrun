// A run's learning reads cut what it learned of its agent's own browser sign-in pointers, as the agent's learning routes
// do (learning-routes-sign-in-cut.test.mjs): GET /runs/{id}/learning shows none of a live or forgotten pointer a merged
// note holds, and GET /runs/{id}/learning/diff withholds that note's patch ("secret"). When a pointer of the agent's does
// not open here (a sign-in sealed under another key), both answer 403, in words, never served over a shorter list.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { saveSignIn, signInsOverStore } from "../dist/sign-ins-store.js";
import { WITHHELD_LEARNING } from "../dist/handed-values.js";
import { note } from "./fixtures/faux-learn.mjs";
import { LEARN, learner, made, sleep, started } from "./learn-support.mjs";
import { follow, serve, withEnv } from "./support.mjs";

/** Test pointers, never real ones: a Browserbase context the agent signs in with now, and a Kernel profile it forgot. */
const LIVE = `ctx/${randomBytes(16).toString("hex")}`;
const FORGOTTEN = `agentrun-${randomBytes(10).toString("hex")}`;
const SIGN_IN = note("Where to sign in", `The context is ${LIVE}`, `Open ${LIVE}, or the old ${FORGOTTEN}.\n`);

/** An answer's body as text. */
const textOf = (got) => (typeof got.body === "string" ? got.body : JSON.stringify(got.body));
const holds = (text) => [LIVE, FORGOTTEN].filter((pointer) => text.includes(pointer));

/** Run `runId`, completed, once its learning has ended (merged or dropped): its learning as GET /runs/{id}/learning reads it. */
async function learningEnd(api, runId) {
  await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  for (let i = 0; ; i++) {
    const learning = (await api("GET", `/runs/${runId}/learning`)).body;
    if (["merged", "dropped"].includes(learning?.state)) return learning;
    assert.ok(i < 1200, `the run's learning ends: ${JSON.stringify(learning)}`);
    await sleep(50);
  }
}

test("a run's learning and its learning diff show none of its agent's sign-in pointers a merged note holds, and are withheld (403) when one does not open here", { timeout: 240_000 }, async (t) => {
  const seal = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: seal.toString("base64") }, ["AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "TYPESAFE_API_KEY", "AGENTRUN_TEST_FAUX_GRADE_HOLD"]);
  const { api, store } = await serve(t, { learning: "on", faux: LEARN });

  // The run merges a note quoting both pointers, written before the agent holds either as a sign-in.
  await made(api, learner("signer", { plan: [["sign-in.md", SIGN_IN]], once: true }));
  const run = await started(api, "signer");
  const learned = await learningEnd(api, run);
  assert.equal(learned.state, "merged", JSON.stringify(learned));
  const before = await api("GET", `/runs/${run}/learning/diff`);
  assert.equal(before.status, 200, textOf(before));
  assert.ok(before.body.files.some((f) => f.path === "sign-in.md" && f.patch?.includes(LIVE)), textOf(before));

  // The agent's sign-ins under this server's key: a Kernel one forgotten, a Browserbase one live.
  await saveSignIn(store, seal, { agentId: "signer", provider: "kernel", pointer: FORGOTTEN });
  await signInsOverStore(store, seal, { remove: async () => {} }).forget("signer", (await store.signIns.list("signer"))[0].name);
  await saveSignIn(store, seal, { agentId: "signer", provider: "browserbase", pointer: LIVE });

  const view = await api("GET", `/runs/${run}/learning`);
  assert.equal(view.status, 200, textOf(view));
  assert.equal(view.body.state, "merged", textOf(view));
  assert.deepEqual(holds(textOf(view)), [], `the run's learning shows a pointer: ${textOf(view).slice(0, 400)}`);
  const diff = await api("GET", `/runs/${run}/learning/diff`);
  assert.equal(diff.status, 200, textOf(diff));
  assert.deepEqual(diff.body.files.find((f) => f.path === "sign-in.md"), { path: "sign-in.md", status: "added", withheld: "secret" }, textOf(diff));
  assert.deepEqual(holds(textOf(diff)), [], `the run's diff shows a pointer: ${textOf(diff).slice(0, 400)}`);

  // A Kernel sign-in sealed under another key: it does not open here, so both reads are withheld, in words.
  await saveSignIn(store, randomBytes(32), { agentId: "signer", provider: "kernel", pointer: `agentrun-${randomBytes(10).toString("hex")}` });
  for (const path of [`/runs/${run}/learning`, `/runs/${run}/learning/diff`]) {
    const got = await api("GET", path);
    assert.equal(got.status, 403, `${path}: ${textOf(got)}`);
    assert.ok(textOf(got).includes(WITHHELD_LEARNING), textOf(got));
    assert.deepEqual(holds(textOf(got)), [], textOf(got));
  }
});
