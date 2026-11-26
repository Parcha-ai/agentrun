// What the learning reads serve is cut of everything the host never shows (tl-browser's four from the custody reads):
// 1. a run's learning words, merged: the whole line cut again, as a dropped one's (notKept) is, so a problem's path the
//    checks left out names no secret;
// 2. an agent's learning routes cut its own sign-in pointers, live and forgotten, beside the server's secrets (the agent
//    view, its corrections), and corrections shown cut and sent back never put the hidden text back;
// 3. a run's learning body cuts its `reason`, each problem's `rule` and its compile's errors (a kept row read back is
//    untrusted);
// 4. a served learning text holds no loopback address (as a run's words, shownOf); what a run is laid keeps it (its
//    `# Learned` section), and corrections shown without it and sent back never put it back;
// 5. a run's learning problems hold none either, as every other text of its learning.
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendCorrection } from "../dist/learn/commit.js";
import { secretsShown } from "../dist/learning.js";
import { wordsOf } from "../dist/learning-words.js";
import { runLearningBody } from "../dist/learning-routes.js";
import { redactSecrets } from "../dist/learn/secrets.js";
import { learningOf } from "../dist/learn/rows.js";
import { readLaunchBody } from "../dist/run-launch.js";
import { forgotten, holdsNone, pointerOf, saved, server } from "./custody-support.mjs";
import { learningAt, started } from "./learn-support.mjs";
import { agent, serve } from "./support.mjs";

/** A test value the host holds secret, never a real one. */
const SECRET = `planted${"q8".repeat(12)}`;
const cut = (text) => redactSecrets(text, [SECRET]);

/** Agent `agentId`'s owner's corrections `lines` appended on its learning, as a run's merge appends them (no check: a
 *  pointer saved after the correction was written). */
async function corrected(store, agentId, lines) {
  for (const [i, text] of lines.entries()) {
    const made = await appendCorrection(learningOf(store, agentId), { runId: `run-${i + 1}`, text });
    assert.equal(made.ok, true, JSON.stringify(made));
  }
}

test("1. a merged run's words are cut again whole: a problem's path the checks left out names no secret", () => {
  const learning = { state: "merged", workflows: [{ file: "workflows/retry-slowly/workflow.json", name: "retry-slowly" }], corrections: 0, problems: [{ rule: "secret_value", path: `${SECRET}.md` }] };
  const words = wordsOf(learning, cut);
  assert.match(words, /Learned the workflow retry-slowly/);
  assert.equal(words.includes(SECRET), false, words);
});

test("3. a run's learning body cuts its reason, each problem's rule and its compile's errors", () => {
  const learning = {
    state: "dropped", reason: SECRET, detail: null, at: "2026-11-10T00:00:00.000Z",
    problems: [{ rule: SECRET, path: "a.md", detail: "d" }],
    compiled: { workflow: "answer", attempts: [{ ok: false, errors: [`workflows/answer/workflow.json: it quotes ${SECRET}`] }] },
    draft_errors: [`workflows/answer/workflow.json: it quotes ${SECRET}`],
  };
  const body = runLearningBody({ id: "run-1", learning, seed: null, settled: true }, secretsShown([SECRET]), [SECRET]);
  assert.equal(JSON.stringify(body).includes(SECRET), false, JSON.stringify(body));
  assert.equal(body.compiled.attempts[0].ok, false, "the rest of the record is there");
  assert.match(body.draft_errors[0], /^workflows\/answer\/workflow\.json: it quotes /);
});

test("4. a served learning text holds no loopback address; what a run is laid keeps it", () => {
  const text = "Call the proxy at http://127.0.0.1:43123/v1/responses, or localhost:8080 when it is down.";
  const served = secretsShown([]).text(text);
  assert.equal(/127\.0\.0\.1|localhost/.test(served), false, served);
  assert.match(served, /a local address/);
  assert.equal(secretsShown([], { local: true }).text(text), text, "what a run is laid keeps it");
});

// #2250's P2: a learning text loses its loopback address and nothing else. A run error's `url:` tail (withoutLoopback) is
// no rule of a correction's, a patch's or a workflow.json's: their label, last newline and JSON stay.
test("4. a served learning text loses only the address: a correction's url: label and last newline, a patch's last line and a workflow's JSON stay", () => {
  const shown = secretsShown([]);
  assert.equal(shown.text("The proxy:\nurl: http://localhost:8080\n"), "The proxy:\nurl: a local address\n");
  assert.equal(shown.text("@@ -0,0 +1,2 @@\n+The proxy:\n+url: http://localhost:8080\n"), "@@ -0,0 +1,2 @@\n+The proxy:\n+url: a local address\n");
  const flow = JSON.stringify({ name: "proxy", steps: [{ note: "url: http://localhost:8080" }, { note: 'Call "http://127.0.0.1:9000/v1" first, or localhost:9000.' }, { note: "[::1]:9000/v1/responses." }] });
  const served = shown.text(flow);
  assert.equal(/127\.0\.0\.1|localhost|::1/.test(served), false, served);
  assert.deepEqual(JSON.parse(served).steps.map((step) => step.note), ["url: a local address", 'Call "a local address" first, or a local address.', "a local address."], served);
});

test("4. a run's # Learned section keeps a correction's local address", { timeout: 60_000 }, async (t) => {
  const { api, store } = await serve(t, { runner: false, learning: "on" });
  assert.equal((await api("POST", "/agents", agent("local", { learning: true }))).status, 201);
  await store.learning.seed("local");
  await corrected(store, "local", ["Call http://localhost:8080 for the proxy."]);
  const runId = await started(api, "local");
  const section = readLaunchBody((await store.runs.launch(runId)).body).learning?.section ?? "";
  assert.match(section, /Call http:\/\/localhost:8080 for the proxy\./, section);
  assert.equal(section.includes("a local address"), false, section);
});

test("5. a run's learning problems hold no loopback address", () => {
  const learning = {
    state: "dropped", reason: "checker", detail: null, at: "2026-11-10T00:00:00.000Z",
    problems: [{ rule: "workflow", path: "http://localhost:8080.md", detail: "It calls http://127.0.0.1:43123/v1 first, or localhost:9000 when it is down." }],
  };
  const body = runLearningBody({ id: "run-1", learning, seed: null, settled: true }, secretsShown([]), []);
  const problems = JSON.stringify(body.problems);
  assert.equal(/127\.0\.0\.1|localhost/.test(problems), false, problems);
  assert.match(problems, /a local address/);
  assert.equal(body.problems[0].rule, "workflow", "the rule is kept");
});

test("2 and 4. an agent's learning routes cut its own sign-in pointers, live and forgotten, and a local address; corrections shown cut and sent back never put them back", { timeout: 120_000 }, async (t) => {
  const s = await server(t);
  const gone = pointerOf("GONE");
  const live = pointerOf("LIVE");
  await saved(s, gone);
  await forgotten(s);
  await saved(s, live);
  await corrected(s.store, "alpha", [`Open ${live} first.`, `It was ${gone}.`, "The proxy is at http://127.0.0.1:43123/v1."]);

  const view = (await s.api("GET", "/agents/alpha/learning")).body;
  const read = await s.api("GET", "/agents/alpha/learning/corrections");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  holdsNone({ view, read: read.body }, live, gone, "127.0.0.1:43123");
  for (const shown of [view.corrections, read.body.text]) {
    assert.match(shown, /Open \[redacted\] first/);
    assert.match(shown, /a local address/);
  }

  // What was shown, sent back as it reads: the cut is what is written, never the hidden text.
  const edited = await s.api("PUT", "/agents/alpha/learning/corrections", { text: read.body.text }, { "if-match": read.headers.get("etag") });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const written = (await learningAt(s.store, "alpha")).text("corrections.md");
  holdsNone({ written }, live, gone, "127.0.0.1:43123");
});
