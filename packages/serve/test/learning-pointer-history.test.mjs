// What an agent learned is cut of every sign-in pointer it ever held, however many it has forgotten since: a forget keeps
// every forgotten pointer (never only the newest few), so a correction on main that quotes the agent's first pointer
// still shows none of it after 33 more forgets, on every learning read (the agent's view, its corrections, the run's
// learning and its diff), and a person's corrections quoting it are still refused as secret.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { forgetSignIn, saveSignIn } from "../dist/sign-ins-store.js";
import { fedBack, LEARN, learner, made } from "./learn-support.mjs";
import { serve, withEnv } from "./support.mjs";

/** Test pointers, never real ones: the agent's first Kernel profile, forgotten before 33 more are. */
const OLDEST = `agentrun-${randomBytes(10).toString("hex")}`;

/** An answer's body as text. */
const textOf = (got) => (typeof got.body === "string" ? got.body : JSON.stringify(got.body));

test("a pointer forgotten 33 forgets ago is still cut from every learning read, and corrections quoting it are still refused", { timeout: 240_000 }, async (t) => {
  const seal = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: seal.toString("base64") }, ["AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "TYPESAFE_API_KEY"]);
  const { api, store } = await serve(t, { learning: "on", faux: LEARN });

  // The owner's correction quotes the pointer, written before the agent holds it as a sign-in.
  await made(api, learner("signer"));
  const { view } = await fedBack(api, "signer", { label: `Open ${OLDEST} first.` });
  assert.equal(view.learning?.state, "merged", JSON.stringify(view.learning));
  const run = view.run_id;

  // The agent signs in with it and forgets it, then signs in and forgets 33 more times.
  await saveSignIn(store, seal, { agentId: "signer", provider: "kernel", pointer: OLDEST });
  await forgetSignIn(store, seal, { remove: async () => undefined }, "signer", "kernel");
  for (let i = 0; i < 33; i++) {
    await saveSignIn(store, seal, { agentId: "signer", provider: "kernel", pointer: `agentrun-${randomBytes(10).toString("hex")}` });
    await forgetSignIn(store, seal, { remove: async () => undefined }, "signer", "kernel");
  }

  for (const path of ["/agents/signer/learning", "/agents/signer/learning/corrections", `/runs/${run}/learning`, `/runs/${run}/learning/diff`]) {
    const got = await api("GET", path);
    assert.equal(got.status, 200, `${path}: ${textOf(got)}`);
    assert.equal(textOf(got).includes(OLDEST), false, `${path} shows the pointer: ${textOf(got).slice(0, 400)}`);
  }
  const corrections = await api("GET", "/agents/signer/learning/corrections");
  assert.match(corrections.body.text, /Open \[redacted\] first\./);
  const diff = (await api("GET", `/runs/${run}/learning/diff`)).body;
  assert.deepEqual(diff.files.find((f) => f.path === "corrections.md"), { path: "corrections.md", status: "added", withheld: "secret" }, JSON.stringify(diff));

  const put = await api("PUT", "/agents/signer/learning/corrections", { text: `- Open ${OLDEST}.\n` }, { "if-match": corrections.headers.get("etag") });
  assert.deepEqual([put.status, put.body?.error?.fields?.map((field) => field.reason)], [422, ["secret_value"]], textOf(put));
  assert.equal(textOf(put).includes(OLDEST), false, textOf(put));
  assert.match((await api("GET", "/agents/signer/learning/corrections")).body.text, /Open \[redacted\] first\./, "nothing refused reaches main");
  assert.equal((await store.signIns.tombstones("signer", "kernel")).length, 34, "every forgotten pointer is kept");
});
