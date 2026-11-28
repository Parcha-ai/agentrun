// Run.pending's question variant may carry `expires_at` (RFC 3339 UTC): when the question expires unanswered, as the
// browser and computer variants say theirs. A backend that sets the question a deadline fills it; this server sets none,
// so its question reads without it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { follow, serve, startRun } from "./support.mjs";

const QUESTION = { kind: "question", question: "Which region?", asked_at: "2026-11-28T02:00:00Z" };
const SCHEMAS = ["Run", "RunSummary"];
const pendingOf = (schema) => ({ $ref: `#/components/schemas/${schema}/properties/pending` });

test("a waiting run's question may say when it expires: expires_at, an optional date-time, in a run's read and in a list's", { timeout: 60_000 }, async (t) => {
  const { baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  for (const schema of SCHEMAS) {
    assert.deepEqual(schemaProblems(doc, pendingOf(schema), { ...QUESTION, expires_at: "2026-11-28T03:00:00Z" }), [], schema);
    const question = doc.components.schemas[schema].properties.pending.oneOf.find((one) => one.properties.kind.const === "question");
    assert.deepEqual([question.properties.expires_at?.type, question.properties.expires_at?.format, question.required.includes("expires_at")], ["string", "date-time", false], `${schema}: optional, a date-time`);
  }
});

test("demo: a question without expires_at still meets the document, and this server's own waiting run reads its question without one", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  for (const schema of SCHEMAS) assert.deepEqual(schemaProblems(doc, pendingOf(schema), QUESTION), [], schema);

  const asks = await startRun(api, "asks", "Pick a region.", { tools: ["ask_person"] });
  await follow(api, asks.run_id, ["input_required"]);
  const { body: run } = await api("GET", `/runs/${asks.run_id}`);
  assert.equal(run.pending?.kind, "question", JSON.stringify(run.pending));
  assert.equal("expires_at" in run.pending, false, "this server sets its question no deadline");
  assert.deepEqual(schemaProblems(doc, pendingOf("Run"), run.pending), [], "and it meets the document");
});
