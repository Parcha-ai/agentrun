// No key on the Timeline anywhere: a model that quotes a held key in its thinking, in its text (base64), in a tool call's
// arguments and in its answer shows no 8 characters of it on any row. The faux model reads the key from a file the test
// names, so the person's own message never holds it; the key is held as the server's PARALLEL_API_KEY.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

/** A held key, made at runtime: distinct per run, and no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "quoted-model-key", randomBytes(6).toString("hex")].join("-");
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};

test("a model that quotes a held key in its thinking, its text, a tool call's arguments and its answer: no 8 characters of it on the Timeline", { timeout: 60_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: KEY });
  const dir = await scratch(t);
  const file = join(dir, "key.txt");
  await writeFile(file, KEY);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("quotes", { tools: ["read"] }))).status, 201);
  const started = await api("POST", "/agents/quotes/runs", { input: { content: `Quote the key in ${file}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"]);
  const rows = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows;
  for (const kind of ["thinking", "tool_use", "final_answer"]) assert.ok(rows.some((r) => r.kind === kind), `a ${kind} row: ${JSON.stringify(rows.map((r) => r.kind))}`);
  const all = JSON.stringify(rows);
  for (const form of [KEY, Buffer.from(KEY).toString("base64")]) assert.ok(!holdsRun(all, form), `the Timeline holds part of ${form.slice(0, 12)}…: ${JSON.stringify(rows.map((r) => [r.kind, r.summary, r.tool_input_preview, r.text]))}`);
});
