// An escalated workflow run's review reason is its escalate node's summary, interpolated from the run's input, so it can
// quote a held key. It is served with none: on the run's page and in the runs list, from a run the server holds and
// from the store's row after a restart, and a key saved after the run ended is redacted from the next read.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { answerFlow, client, FAUX, flowAgent, follow, serve, withEnv } from "./support.mjs";

/** A held key and a value saved as one only after the run, made at runtime; no 8 characters of either are in the other. */
const KEY = ["not-a-secret", "review-key", "0123456789ab"].join("-");
const LATER = ["later", "saved", "qponmlkjih"].join("-");
const holds = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};

test("an escalated run whose review quotes a held key and a value saved after it ended: neither on its page or in the list, before or after a restart", { timeout: 90_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: KEY, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["MONID_API_KEY"]);
  const { api, data, close } = await serve(t);
  const gated = answerFlow();
  gated.schemas.In.properties.amount = { type: "number" };
  gated.schemas.In.properties.note = { type: "string" };
  gated.root.steps.unshift({ node: "escalate", label: "too big", when: { predicate: "gte", path: "amount", n: 500 }, kind: "review", stage: "gate", summary: "needs a person: {note}" });
  assert.equal((await api("POST", "/agents", flowAgent("gated", gated))).status, 201);
  const started = await api("POST", "/agents/gated/runs", { input: { question: "What is six times seven?", amount: 600, note: `${KEY} and ${LATER}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed"]);
  const reasons = async (read) => [(await read("GET", `/runs/${runId}`)).body.review?.reason, (await read("GET", "/runs")).body.runs.find((r) => r.run_id === runId)?.review?.reason];
  for (const reason of await reasons(api)) {
    assert.ok(typeof reason === "string" && !holds(reason, KEY), `the held key: ${reason}`);
    assert.ok(reason.includes(LATER), `not held yet, so shown: ${reason}`);
  }
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: LATER } })).status, 204);
  for (const reason of await reasons(api)) assert.ok(!holds(reason, KEY) && !holds(reason, LATER), `saved after the run: ${reason}`);
  await close();
  // A server that never held the run reads its review from the store's row and serve.json.
  const again = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => again.close());
  for (const reason of await reasons(client(again.baseUrl, again.token))) assert.ok(typeof reason === "string" && !holds(reason, KEY) && !holds(reason, LATER), `after a restart: ${reason}`);
});
