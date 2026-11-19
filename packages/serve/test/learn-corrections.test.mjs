// An agent's standing corrections: one file, corrections.md, in its learning folder, its owner's words.
//   - A grade with words appends one line to it on main (no model turn), and every later run of the agent is served it
//     whole under its # Learned heading.
//   - GET /v2/agents/{id}/learning/corrections reads it whole with its ETag; PUT replaces it whole under If-Match. A text
//     past CORRECTIONS_CAP (2 KB) is refused with the cap's words, as is one holding a character a reader does not see;
//     a stale If-Match is a conflict. Nothing it refuses reaches main.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEARN, ended, git, made, repoOf, started } from "./learn-support.mjs";
import { agent, serve, withEnv } from "./support.mjs";

const HIDDEN = String.fromCodePoint(0x200b);

async function keeper(t) {
  withEnv(t, {}, ["AGENT_MODEL_STRONG"]);
  const server = await serve(t, { learning: "on", faux: LEARN });
  await made(server.api, agent("keeper", { learning: true, instructions: "Say your prompt." }));
  return server;
}

const read = (api) => api("GET", "/agents/keeper/learning/corrections");
const put = (api, text, etag) => api("PUT", "/agents/keeper/learning/corrections", { text }, etag === undefined ? {} : { "if-match": etag });

test("a grade with words appends one line to corrections.md, with no model turn; the next run is served the file whole", { timeout: 120_000 }, async (t) => {
  const { api, data } = await keeper(t);
  const runId = await started(api, "keeper");
  await ended(api, runId);
  const graded = await api("PUT", `/runs/${runId}/grade`, { correct: false, label: "Answer in tables from now on." });
  assert.equal(graded.status, 200, JSON.stringify(graded.body));
  assert.equal(graded.body.feedback, "correction", JSON.stringify(graded.body));
  const { view } = await ended(api, runId);
  assert.equal(view.learning?.state, "merged", JSON.stringify(view.learning));
  // git() gives its output trimmed: the file is this one line.
  assert.equal(git(repoOf(data, "keeper"), ["show", "main:corrections.md"]), "- Answer in tables from now on.");
  const got = await read(api);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.deepEqual([got.body.text, got.body.cap_bytes], ["- Answer in tables from now on.\n", 2048]);
  assert.ok(got.headers.get("etag"), "an ETag");
  // The next run's system prompt (the faux model says it back) holds the file whole.
  const next = await started(api, "keeper");
  const { rows } = await ended(api, next);
  const answer = rows.findLast((row) => row.kind === "final_answer")?.text ?? "";
  assert.match(answer, /# Learned/, answer.slice(0, 400));
  assert.match(answer, /- Answer in tables from now on\./, answer.slice(0, 400));
});

test("GET and PUT corrections over v2: replaced whole under If-Match; over the cap, a hidden character or a stale ETag refused; nothing refused reaches main", { timeout: 120_000 }, async (t) => {
  const { api, data } = await keeper(t);
  const first = await read(api);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.text, "", "no corrections yet");
  const etag = first.headers.get("etag");
  assert.equal((await put(api, "- Be brief.\n")).status, 428, "If-Match is required");
  const saved = await put(api, "- Be brief.\n", etag);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.text, "- Be brief.\n");
  const now = saved.headers.get("etag");
  assert.notEqual(now, etag);
  assert.equal((await put(api, "- Be terse.\n", etag)).status, 412, "a stale ETag is a conflict");
  const big = await put(api, "x".repeat(2049), now);
  assert.equal(big.status, 422, JSON.stringify(big.body));
  assert.match(JSON.stringify(big.body), /2049 bytes.*2048/, JSON.stringify(big.body));
  const hidden = await put(api, `- Be${HIDDEN} brief.\n`, now);
  assert.equal(hidden.status, 422, JSON.stringify(hidden.body));
  assert.match(JSON.stringify(hidden.body), /a character a reader does not see/);
  assert.equal(git(repoOf(data, "keeper"), ["show", "main:corrections.md"]), "- Be brief.", "only the one write landed (git() trims its output)");
  assert.equal((await read(api)).body.text, "- Be brief.\n");
});
