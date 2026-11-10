// What the learning reads serve is cut of everything the host never shows (tl-browser's four from the custody reads):
// 1. a run's learning words, merged: the whole line cut again, as a dropped one's (notKept) is, so a problem's path the
//    checks left out names no secret;
// 2. an agent's learning routes cut its own sign-in pointers, live and forgotten, beside the server's secrets (the agent
//    view, a note read), and a note shown cut so is never saved over;
// 3. a run's learning body cuts its `reason`, each problem's `rule` and each verdict item's `origin` (a kept row read
//    back is untrusted);
// 4. a served learning text holds no loopback address (as a run's words, shownOf); what a run is laid keeps it (its
//    `.learning/` files and its `# Learned` section), and a note shown without it is never saved over;
// 5. a run's learning problems hold none either, as every other text of its learning.
import assert from "node:assert/strict";
import { test } from "node:test";
import { learningCommit } from "../dist/learn/commit.js";
import { secretsShown } from "../dist/learning.js";
import { wordsOf } from "../dist/learning-words.js";
import { runLearningBody } from "../dist/learning-routes.js";
import { redactSecrets } from "../dist/learn/secrets.js";
import { learningWorkspace } from "../dist/workspace/index.js";
import { seedOf } from "../dist/learning.js";
import { readLaunchBody } from "../dist/run-launch.js";
import { forgotten, holdsNone, pointerOf, saved, server } from "./custody-support.mjs";
import { started } from "./learn-support.mjs";
import { agent, serve } from "./support.mjs";

/** A test value the host holds secret, never a real one. */
const SECRET = `planted${"q8".repeat(12)}`;
const cut = (text) => redactSecrets(text, [SECRET]);
const note = (name, body) => `---\nname: ${name}\ndescription: ${name}\ntype: reference\n---\n${body}\n`;

test("1. a merged run's words are cut again whole: a problem's path the checks left out names no secret", () => {
  const learning = { state: "merged", learned: [{ name: "Retry slowly", supersedes: [] }], pending: [], skills: [], workflows: [], verdict: null, problems: [{ rule: "secret_value", path: `${SECRET}.md` }] };
  const words = wordsOf(learning, cut);
  assert.match(words, /Learned: Retry slowly/);
  assert.equal(words.includes(SECRET), false, words);
});

test("3. a run's learning body cuts its reason, each problem's rule and each verdict item's origin", () => {
  const learning = {
    state: "dropped", reason: SECRET, detail: null, at: "2026-11-10T00:00:00.000Z",
    verdict: { merge: false, reason: "Not useful.", items: [{ file: "a.md", keep: false, origin: SECRET, why: "Not useful." }] },
    problems: [{ rule: SECRET, path: "a.md", detail: "d" }],
  };
  const body = runLearningBody({ id: "run-1", learning, seed: null, settled: true }, secretsShown([SECRET]), [SECRET]);
  assert.equal(JSON.stringify(body).includes(SECRET), false, JSON.stringify(body));
  assert.equal(body.verdict.items[0].keep, false, "the rest of the verdict is there");
});

test("4. a served learning text holds no loopback address; what a run is laid keeps it", () => {
  const text = "Call the proxy at http://127.0.0.1:43123/v1/responses, or localhost:8080 when it is down.";
  const served = secretsShown([]).text(text);
  assert.equal(/127\.0\.0\.1|localhost/.test(served), false, served);
  assert.match(served, /a local address/);
  assert.equal(secretsShown([], { local: true }).text(text), text, "a run's own .learning/ keeps it");
});

test("4. a run's # Learned section keeps a note's local address, as its .learning/ files do", { timeout: 60_000 }, async (t) => {
  const { api, data, store } = await serve(t, { runner: false, learning: "on" });
  assert.equal((await api("POST", "/agents", agent("local", { learning: true }))).status, 201);
  await seedOf(data, "local");
  const folder = learningWorkspace({ mode: "local", data, agentId: "local" });
  try {
    const made = await learningCommit(folder.workspace, { kind: "person", action: "created", file: "local-proxy.md", text: note("Local proxy", "Call http://localhost:8080 for the proxy."), ifMatch: null });
    assert.equal(made.ok, true, JSON.stringify(made));
  } finally {
    await folder.end();
  }
  const runId = await started(api, "local");
  const section = readLaunchBody((await store.runs.launch(runId)).body).learning?.section ?? "";
  assert.match(section, /Call http:\/\/localhost:8080 for the proxy\./, section);
  assert.equal(section.includes("a local address"), false, section);
});

test("5. a run's learning problems hold no loopback address", () => {
  const learning = {
    state: "dropped", reason: "checks", detail: null, at: "2026-11-10T00:00:00.000Z",
    problems: [{ rule: "note", path: "http://localhost:8080.md", detail: "It calls http://127.0.0.1:43123/v1 first, or localhost:9000 when it is down." }],
  };
  const body = runLearningBody({ id: "run-1", learning, seed: null, settled: true }, secretsShown([]), []);
  const problems = JSON.stringify(body.problems);
  assert.equal(/127\.0\.0\.1|localhost/.test(problems), false, problems);
  assert.match(problems, /a local address/);
  assert.equal(body.problems[0].rule, "note", "the rule is kept");
});

test("2 and 4. an agent's learning routes cut its own sign-in pointers, live and forgotten, and a local address; a note shown cut is never saved over", { timeout: 120_000 }, async (t) => {
  const s = await server(t);
  const gone = pointerOf("GONE");
  const live = pointerOf("LIVE");
  await saved(s, gone);
  await forgotten(s);
  await saved(s, live);
  // Notes that wrote them, landed as a run's merge lands them (no check: a pointer saved after the note was written).
  const folder = learningWorkspace({ mode: "local", data: s.data, agentId: "alpha" });
  try {
    for (const [file, text] of [["live.md", note("Live session", `Open ${live} first.`)], ["gone.md", note("Old session", `It was ${gone}.`)]]) {
      const made = await learningCommit(folder.workspace, { kind: "person", action: "created", file, text, ifMatch: null });
      assert.equal(made.ok, true, JSON.stringify(made));
    }
  } finally {
    await folder.end();
  }
  const local = await s.api("PUT", "/agents/alpha/learning/files/local.md", { text: note("Local proxy", "The proxy is at http://127.0.0.1:43123/v1.") }, { "if-none-match": "*" });
  assert.equal(local.status, 201, JSON.stringify(local.body));

  const view = (await s.api("GET", "/agents/alpha/learning")).body;
  assert.deepEqual(view.notes.items.map((item) => item.file).sort(), ["gone.md", "live.md", "local.md"], JSON.stringify(view.notes));
  const reads = {};
  for (const file of ["live.md", "gone.md", "local.md"]) reads[file] = await s.api("GET", `/agents/alpha/learning/files/${file}`);
  holdsNone({ view, reads: Object.fromEntries(Object.entries(reads).map(([file, read]) => [file, read.body ?? read.text])) }, live, gone, "127.0.0.1:43123");
  assert.match(JSON.stringify(view), /Open \[redacted\] first/);
  assert.match(JSON.stringify(view), /a local address/);

  // Each was shown cut: an edit of what was shown would write the cut over the hidden text, so it is refused.
  for (const [file, text] of [["live.md", note("Live session", "Open it first.")], ["local.md", note("Local proxy", "The proxy is local.")]]) {
    const etag = reads[file].headers.get("etag");
    assert.ok(etag, `${file} has an ETag`);
    const edited = await s.api("PUT", `/agents/alpha/learning/files/${file}`, { text }, { "if-match": etag });
    assert.equal(edited.status, 400, `${file}: ${JSON.stringify(edited.body)}`);
    holdsNone({ edited: edited.body }, live, gone);
  }
});
