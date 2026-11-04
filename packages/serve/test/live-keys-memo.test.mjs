// A streaming block's live view is redacted at every delta (key-refusal.ts redactedLive over the held values), and the
// held values include the keys saved on the server, which are opened from tool-keys.json. Opened once and kept until a
// key is saved or deleted: a stream of hundreds of deltas reads the file once, not once per delta and saved key. A key
// saved while the run goes is held from then on: what the run streams after it shows no part of it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import * as toolKeys from "../dist/tool-keys.js";

const KEY = ["not-a-secret", "mid-run-key", randomBytes(6).toString("hex")].join("-");
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};
const reads = () => toolKeys.keyReads?.count;
const FAUX_STREAMED = new URL("./fixtures/faux-streamed.mjs", import.meta.url).pathname;

test("a run that streams hundreds of deltas opens the saved keys once, and a key saved while it runs is held from its next delta on", { timeout: 90_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY"]);
  const dir = await scratch(t);
  const [gate, file] = [join(dir, "go"), join(dir, "key.txt")];
  await writeFile(file, KEY);
  await writeFile(join(dir, "other.txt"), "nothing to quote");
  const { api } = await serve(t, { faux: FAUX_STREAMED });
  // A saved key already, so every read opens one; the run's key replaces it mid-run.
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: ["not-a-secret", "first", randomBytes(4).toString("hex")].join("-") } })).status, 204);
  assert.equal((await api("POST", "/agents", agent("streams", { tools: ["read"] }))).status, 201);
  assert.equal(typeof reads(), "number", "tool-keys.ts counts its reads of the file");
  // What a run's start and a first turn of one short delta read: the baseline the long stream is measured against.
  const brief = await firstTurn(api, `Stream briefly, then once ${gate} exists quote the key in ${join(dir, "other.txt")}`);
  const long = await firstTurn(api, `Stream at length, then once ${gate} exists quote the key in ${file}`);
  const streamed = long.reads - brief.reads;
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: KEY } })).status, 204);
  await writeFile(gate, "");
  for (const runId of [brief.runId, long.runId]) await follow(api, runId, ["completed", "failed"]);
  const rows = (await api("GET", `/runs/${long.runId}/timeline`)).body.rows;
  assert.ok(rows.some((row) => row.kind === "final_answer"), JSON.stringify(rows.map((row) => row.kind)));
  // About 10 KB of text, streamed in hundreds of deltas, against one: the same reads but for a few.
  assert.ok(streamed <= 10, `the long stream read the saved keys ${streamed} times more than one delta did (${long.reads} against ${brief.reads})`);
  assert.ok(!holdsRun(JSON.stringify(rows), KEY), `the Timeline holds part of the key saved mid-run: ${JSON.stringify(rows.map((row) => [row.kind, row.summary, row.text]))}`);
});

/** Starts a run of `content` on the agent "streams" and waits for its first turn's read call: what tool-keys read meanwhile. */
async function firstTurn(api, content) {
  const before = reads();
  const started = await api("POST", "/agents/streams/runs", { input: { content } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  for (const end = Date.now() + 60_000; ; ) {
    const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows;
    if (rows.some((row) => row.kind === "tool_use")) break;
    assert.ok(Date.now() < end, `no read call yet: ${JSON.stringify(rows.map((row) => row.kind))}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { runId, reads: reads() - before };
}
