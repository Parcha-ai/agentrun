// What an agent learned is cut of every sign-in pointer it ever held, however many it has forgotten since: a forget keeps
// every forgotten pointer (never only the newest few), so a note on main that quotes the agent's first pointer still
// shows none of it after 33 more forgets, on every learning read (the agent's view, its notes, the note itself, the run's
// learning and its diff), and a person's note quoting it is still refused as secret.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { forgetSignIn, saveSignIn } from "../dist/sign-ins-store.js";
import { note } from "./fixtures/faux-learn.mjs";
import { LEARN, learner, made, sleep, started } from "./learn-support.mjs";
import { follow, serve, withEnv } from "./support.mjs";

/** Test pointers, never real ones: the agent's first Kernel profile, forgotten before 33 more are. */
const OLDEST = `agentrun-${randomBytes(10).toString("hex")}`;
const SIGN_IN = note("Where to sign in", "The first Kernel profile", `Open ${OLDEST} first.\n`);

/** An answer's body as text. */
const textOf = (got) => (typeof got.body === "string" ? got.body : JSON.stringify(got.body));

/** Run `runId`, completed, once its learning has ended (merged or dropped): its learning as GET /runs/{id}/learning reads it. */
async function learningEnd(api, runId) {
  await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  for (let i = 0; ; i++) {
    const learning = (await api("GET", `/runs/${runId}`)).body.learning;
    if (["merged", "dropped"].includes(learning?.state)) return learning;
    assert.ok(i < 1200, `the run's learning ends: ${JSON.stringify(learning)}`);
    await sleep(50);
  }
}

test("a pointer forgotten 33 forgets ago is still cut from every learning read, and a note quoting it is still refused", { timeout: 240_000 }, async (t) => {
  const seal = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: seal.toString("base64") }, ["AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "TYPESAFE_API_KEY", "AGENTRUN_TEST_FAUX_GRADE_HOLD"]);
  const { api, store } = await serve(t, { learning: "on", faux: LEARN });

  // The run merges a note quoting the pointer, written before the agent holds it as a sign-in.
  await made(api, learner("signer", { plan: [["sign-in.md", SIGN_IN]], once: true }));
  const run = await started(api, "signer");
  assert.equal((await learningEnd(api, run)).state, "merged");

  // The agent signs in with it and forgets it, then signs in and forgets 33 more times.
  await saveSignIn(store, seal, { agentId: "signer", provider: "kernel", pointer: OLDEST });
  await forgetSignIn(store, seal, { remove: async () => undefined }, "signer", "kernel");
  for (let i = 0; i < 33; i++) {
    await saveSignIn(store, seal, { agentId: "signer", provider: "kernel", pointer: `agentrun-${randomBytes(10).toString("hex")}` });
    await forgetSignIn(store, seal, { remove: async () => undefined }, "signer", "kernel");
  }

  for (const path of ["/agents/signer/learning", "/agents/signer/learning/notes", "/agents/signer/learning/files/sign-in.md", `/runs/${run}/learning`, `/runs/${run}/learning/diff`]) {
    const got = await api("GET", path);
    assert.equal(got.status, 200, `${path}: ${textOf(got)}`);
    assert.equal(textOf(got).includes(OLDEST), false, `${path} shows the pointer: ${textOf(got).slice(0, 400)}`);
  }
  assert.match(textOf(await api("GET", "/agents/signer/learning/files/sign-in.md")), /Open \[redacted\] first\./);
  const diff = (await api("GET", `/runs/${run}/learning/diff`)).body;
  assert.deepEqual(diff.files.find((f) => f.path === "sign-in.md"), { path: "sign-in.md", status: "added", withheld: "secret" }, JSON.stringify(diff));

  const put = await api("PUT", "/agents/signer/learning/files/again.md", { text: note("Again", "The first profile", `Open ${OLDEST}.\n`) }, { "if-none-match": "*" });
  assert.deepEqual([put.status, put.body?.error?.problems?.map((p) => p.rule)], [400, ["secret_value"]], textOf(put));
  assert.equal(textOf(put).includes(OLDEST), false, textOf(put));
  assert.equal((await api("GET", "/agents/signer/learning/files/again.md")).status, 404);
  assert.equal((await store.signIns.tombstones("signer", "kernel")).length, 34, "every forgotten pointer is kept");
});
