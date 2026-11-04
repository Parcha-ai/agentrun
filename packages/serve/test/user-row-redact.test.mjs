// A person's own message can hold a held key (pasted by mistake). The Timeline's row for it and the run's title, which
// the run list shows, hold none of it; the model still gets the message exactly as it was typed.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

/** A held key, made at runtime: distinct per run, and no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "pasted-key", randomBytes(6).toString("hex")].join("-");
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};

test("a message that holds a held key: its Timeline row and the run's title (its view and the run list) hold none of it, and the model got it as typed", { timeout: 60_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: KEY });
  const dir = await scratch(t);
  const file = join(dir, "got.txt");
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("pasted"))).status, 201);
  const content = `My key is ${KEY}, keep it safe. Record what you got in ${file} now.`;
  const started = await api("POST", "/agents/pasted/runs", { input: { content } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed"]);
  assert.equal(await readFile(file, "utf8"), content, "the model got the message exactly as typed");
  const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows;
  const own = rows.filter((row) => row.kind === "user_message");
  assert.equal(own.length, 1, JSON.stringify(rows.map((row) => row.kind)));
  assert.ok(!holdsRun(JSON.stringify(own), KEY), `the message's row: ${JSON.stringify(own.map((row) => [row.summary, row.text]))}`);
  assert.match(own[0].text, /^My key is \[redacted\], keep it safe\. Record/, own[0].text);
  const view = (await api("GET", `/runs/${runId}`)).body;
  const listed = (await api("GET", "/runs?agent=pasted")).body.runs.find((run) => run.run_id === runId);
  for (const [where, title] of [["the run's view", view.title], ["the run list", listed.title]]) assert.ok(!holdsRun(title, KEY), `${where}'s title: ${title}`);
  assert.ok(!holdsRun(JSON.stringify(rows), KEY), "nowhere on the Timeline");
});
