// The agent's answer on the Timeline shows its URLs whole, as the answer itself does: a console link keeps its
// #/runs/<id>?x=1, and a held key in a URL's query reads [redacted] (run 01a1a961-3257-7131-a652-c6fb78880244).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

/** A held key, made at runtime: distinct per run, and no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "answer-url-key", randomBytes(6).toString("hex")].join("-");
const LINK = "http://127.0.0.1:7340/#/runs/01a1a961-3257-7131-a652-c6fb78880244?x=1"; // key-gate: loopback-rule a console link an agent's answer gives, as text

test("an answer with a console link and a held key in a URL's query: its Timeline row keeps the link whole and shows the key as [redacted]", { timeout: 60_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: KEY });
  const file = join(await scratch(t), "key.txt");
  await writeFile(file, KEY);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("linker"))).status, 201);
  const started = await api("POST", "/agents/linker/runs", { input: { content: `Answer with the console link and the key in ${file}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  const rows = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows;
  const answer = rows.find((row) => row.kind === "final_answer");
  assert.ok(answer, JSON.stringify(rows.map((row) => row.kind)));
  const shown = `Open ${LINK} and see https://api.example/v1?k=[redacted]&y=2 for it.`;
  assert.equal(answer.summary, shown);
  assert.equal(answer.text, shown);
  assert.ok(!JSON.stringify(rows).includes(KEY.slice(-12)), "no part of the key on the Timeline");
});
