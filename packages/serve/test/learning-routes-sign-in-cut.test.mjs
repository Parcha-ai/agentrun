// An agent's learning routes cut what it learned of its own browser sign-in pointers, as a run's reads cut what the run
// was handed: the agent's view, its corrections.md and its log each show none of its live or forgotten pointers, and a
// person's write of corrections.md holding one is refused as one holding a server secret is. When a pointer of the
// agent's does not open here (another seal key), what it learned is withheld: 403, in words, never served over a shorter
// list.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { saveSignIn, signInsOverStore } from "../dist/sign-ins-store.js";
import { WITHHELD_LEARNING } from "../dist/handed-values.js";
import { learningCommit } from "../dist/learn/commit.js";
import { learningOf } from "../dist/learn/rows.js";
import { agent, serve, withEnv } from "./support.mjs";

/** Test pointers, never real ones: a Browserbase context the agent signs in with now, and a Kernel profile it forgot. */
const LIVE = `ctx/${randomBytes(16).toString("hex")}`;
const FORGOTTEN = `agentrun-${randomBytes(10).toString("hex")}`;

/** A server whose agent `alpha` learns, its sign-ins saved under `seal` (the server's own unless given), its Kernel one
 *  forgotten, and a correction saved on its learning that quotes both pointers. */
async function world(t, { other } = {}) {
  const seal = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: seal.toString("base64") }, ["AGENTRUN_SEAL_KEY"]);
  const server = await serve(t, { runner: false });
  assert.equal((await server.api("POST", "/agents", agent("alpha", { learning: true }))).status, 201);
  const key = other ?? seal;
  await saveSignIn(server.store, key, { agentId: "alpha", provider: "kernel", pointer: FORGOTTEN });
  await signInsOverStore(server.store, key, { remove: async () => {} }).forget("alpha", (await server.store.signIns.list("alpha"))[0].name);
  await saveSignIn(server.store, key, { agentId: "alpha", provider: "browserbase", pointer: LIVE });
  await server.store.learning.seed("alpha");
  const made = await learningCommit(learningOf(server.store, "alpha"), { runId: "run_signin", reason: "feedback", files: [], correction: `Open ${LIVE}, or the old ${FORGOTTEN}.` });
  assert.equal(made.ok, true, JSON.stringify(made));
  return server;
}

/** An answer's body as text: a file as served, or JSON. */
const textOf = (got) => (typeof got.body === "string" ? got.body : JSON.stringify(got.body));
const holds = (text) => [LIVE, FORGOTTEN].filter((pointer) => text.includes(pointer));

test("an agent's learning routes show none of its own sign-in pointers, live or forgotten", async (t) => {
  const { api } = await world(t);
  for (const path of ["/agents/alpha/learning", "/agents/alpha/learning/corrections", "/agents/alpha/learning/log"]) {
    const got = await api("GET", path);
    assert.equal(got.status, 200, `${path}: ${textOf(got)}`);
    assert.deepEqual(holds(textOf(got)), [], `${path} shows a pointer: ${textOf(got).slice(0, 400)}`);
  }
  const { text } = (await api("GET", "/agents/alpha/learning/corrections")).body;
  assert.match(text, /Open \[redacted\], or the old \[redacted\]\./, text);
});

test("a person's corrections.md holding one of the agent's sign-in pointers is refused, and nothing of it is kept", async (t) => {
  const { api } = await world(t);
  const read = await api("GET", "/agents/alpha/learning/corrections");
  const put = await api("PUT", "/agents/alpha/learning/corrections", { text: `${read.body.text}- Sign in on ${FORGOTTEN}.\n` }, { "if-match": read.headers.get("etag") });
  assert.deepEqual([put.status, put.body?.error?.fields?.map((field) => field.reason)], [422, ["secret_value"]], textOf(put));
  assert.deepEqual(holds(textOf(put)), [], textOf(put));
  assert.equal((await api("GET", "/agents/alpha/learning/corrections")).body.text, read.body.text);
});

test("an agent whose sign-in does not open here (another seal key) has its learning withheld, in words", async (t) => {
  const { api } = await world(t, { other: randomBytes(32) });
  for (const path of ["/agents/alpha/learning", "/agents/alpha/learning/corrections", "/agents/alpha/learning/log"]) {
    const got = await api("GET", path);
    assert.equal(got.status, 403, `${path}: ${textOf(got)}`);
    assert.ok(textOf(got).includes(WITHHELD_LEARNING), textOf(got));
    assert.deepEqual(holds(textOf(got)), [], textOf(got));
  }
});
