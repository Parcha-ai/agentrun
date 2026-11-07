// A run's context summarized (a compaction) or reset shows on its Timeline as a phase row whose text is the summary or
// the new context: words from the run, which can quote a held key. That row holds none of it, as every other row a run's
// words reach (the host's redact before any cut).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { agent, follow, serve, withEnv } from "./support.mjs";

const QUOTE = new URL("./fixtures/faux-compact-quote.mjs", import.meta.url).pathname;
/** A held key, made at runtime: no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "phase-row", randomBytes(6).toString("hex")].join("-");
const holds = (text) => {
  for (let i = 0; i + 8 <= KEY.length; i++) if (text.includes(KEY.slice(i, i + 8))) return true;
  return false;
};

test("a run that compacts, its summary quoting a held key: the summarized-context phase row shows no part of it", { timeout: 120_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: KEY });
  const { api } = await serve(t, { faux: QUOTE });
  assert.equal((await api("POST", "/agents", agent("long"))).status, 201);
  // Six messages at the size limit, the first quoting the key: past the window's threshold, with older turns to summarize.
  const long = (n) => `Message ${n}${n === 1 ? ` with ${KEY}` : ""}. ${"word ".repeat(3_990)}`;
  const { body: run } = await api("POST", "/agents/long/runs", { input: { content: long(1) } });
  await follow(api, run.run_id, ["completed"]);
  for (let n = 2; n <= 6; n++) {
    assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: long(n) })).status, 202);
    await follow(api, run.run_id, ["completed"]);
  }
  const rows = (await api("GET", `/runs/${run.run_id}/timeline`)).body.rows;
  const summarized = rows.filter((row) => row.kind === "phase" && row.summary === "Summarized older context");
  assert.ok(summarized.length >= 1, `the run compacted: ${JSON.stringify(rows.map((row) => [row.kind, row.summary]))}`);
  for (const row of summarized) assert.ok(!holds(`${row.summary} ${row.text ?? ""}`), `the summarized-context row holds the key: ${row.text}`);
  assert.ok(!holds(JSON.stringify(rows)), "no row holds it");
});
