// A workflow run's decision rows on the Timeline (decision-rows.ts) hold no held key: a provider's error or a source's
// title that quotes one is redacted with the run's redactor before the row is cut, and an error stored cut (at 2000, or
// marked error_truncated) has its tail held back, where a key the stored cut split would sit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionRows } from "../dist/decision-rows.js";
import { flowAgent, follow, serve, withEnv } from "./support.mjs";

/** A held key, made at runtime: no credential-shaped literal for the source export. */
// No 8 characters of it may appear in a row's own words ("decision", its kind and id).
const KEY = ["not-a-secret", "zqx-row-key", "0123456789ab"].join("-");
const holdsRun = (text) => {
  for (let i = 0; i + 8 <= KEY.length; i++) if (text.includes(KEY.slice(i, i + 8))) return true;
  return false;
};
const redact = (text) => text.split(KEY).join("[redacted]");
const shown = { redact, hold: 6 * KEY.length + 16 };
const receipt = (over = {}) => ({ id: "d1", at: "2026-11-05T00:00:00.000Z", node: "check", kind: "judge", request: { index: 0, count: 1 }, status: "failed", ...over });
const rowOf = (over) => decisionRows([receipt(over)], shown)[0];

test("a decision's error quoting a held key: its row's summary and text hold no part of it", () => {
  const row = rowOf({ error: `500 {"message":"Key ${KEY} is not valid"}` });
  assert.ok(!holdsRun(JSON.stringify(row)), JSON.stringify([row.summary, row.text]));
  assert.match(row.text, /\[redacted\]/);
});

test("a decision's error longer than the row, with the held key across the row's cut at 2000: no part of it", () => {
  const row = rowOf({ error: `refused ${"x".repeat(1980)}${KEY} and more after it` });
  assert.ok(!holdsRun(JSON.stringify(row)), JSON.stringify(row.text.slice(-60)));
});

test("an error stored cut at 2000 (a receipt from before) or marked error_truncated, the key's head at its end: no part of it", () => {
  const head = `failed: ${"x".repeat(2000 - 8 - 20)}${KEY}`.slice(0, 2000);
  for (const over of [{ error: head }, { error: `${head}${"y".repeat(100)}`, error_truncated: true }]) {
    const row = rowOf(over);
    assert.ok(!holdsRun(JSON.stringify(row)), JSON.stringify(row.text.slice(-60)));
  }
});

test("a source's title, a refused question and an answer that quote the held key: no part of it in the row", () => {
  const row = rowOf({ status: "answered", provider: "parallel", answers: { pick: { type: "choice", choice: `use ${KEY}`, confidence: 0.8 } }, refused: [`q-${KEY}`], evidence: [{ url: `https://registry.example.test/a?k=${KEY}`, title: `Filed under ${KEY}` }] });
  assert.ok(!holdsRun(JSON.stringify(row)), JSON.stringify([row.summary, row.text]));
});

/** The decision providers whose Parallel source title echoes the key it was sent. */
const FAUX_ECHO = new URL("./fixtures/faux-decisions-echo.mjs", import.meta.url).pathname;

test("a run whose Parallel judge cites a source titled with the key it was sent: its decision row on the Timeline holds no part of it", { timeout: 60_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: KEY }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api } = await serve(t, { fauxJev: FAUX_ECHO, fauxParallel: FAUX_ECHO });
  const flow = {
    v: 2, name: "echoed",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Coi: { type: "object", required: ["coi"], properties: { coi: { type: "boolean", description: "Is this a certificate of incorporation?" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Coi", path: "coi" },
    root: { node: "chain", steps: [{ node: "judge", label: "coi", state: { doc: "{question}" }, out: "Coi", as: "coi", provider: "parallel" }] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("echoed", flow))).status, 201);
  const started = await api("POST", "/agents/echoed/runs", { input: { question: "Acme's filing" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 50_000 });
  const rows = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows;
  const decision = rows.find((row) => row.kind === "decision");
  assert.ok(decision, JSON.stringify(rows.map((row) => row.kind)));
  assert.match(decision.text ?? "", /Acme, filed under/, decision.text);
  assert.ok(!holdsRun(JSON.stringify(rows)), JSON.stringify([decision.summary, decision.text]));
});
