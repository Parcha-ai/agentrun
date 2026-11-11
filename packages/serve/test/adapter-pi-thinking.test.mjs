// A pi run thinks at its effort: the session spec's `thinking` (the launch's effort, adapter-run-spec.ts) is the pi
// agent's thinking level, so a model that reasons is asked to think at it. With none, pi's own default holds.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, hostTools, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { capRun, quiet, SONNET } from "./adapter-pi-cap-support.mjs";
import { specFor } from "./runner-spec-support.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
after(closeOpenSessions);

const provider = { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"pi-thinking"}` };

/** One pi run on a model that reasons, its session at `thinking` (or none): every request body pi sent. */
async function bodiesAt(t, thinking) {
  const requests = [];
  const fetch = scriptedOrigin([{ say: "done" }], requests);
  const specOf = () => (_claim, run) => ({
    adapter: piAdapter({ run, model: MODEL, like: { reasoning: true, maxTokens: 64_000 }, provider, fetch, price: () => 0 }),
    session: { key: "root", label: "root", system: ["Answer."], tools: hostTools({}), context: "fresh", ...(thinking ? { thinking } : {}) },
    input: "Answer.",
    hooks: quiet,
    gate: () => "allow",
  });
  const { row } = await capRun(t, { script: [{ say: "done" }], specOf, runCap: { capUsd: () => undefined, modelOf: () => SONNET } });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  return requests;
}

test("a pi session's thinking is its agent's thinking level: a reasoning model is asked to think at it", async (t) => {
  const low = await bodiesAt(t, "low");
  const high = await bodiesAt(t, "high");
  assert.ok(low.length >= 1 && high.length >= 1, "pi asked the model");
  // Anthropic's wire: thinking on, its budget pi-ai's for the level (low 2,048 tokens, high 16,384).
  assert.deepEqual([low[0].thinking?.type, low[0].thinking?.budget_tokens], ["enabled", 2048], `low: ${JSON.stringify(low[0].thinking)}`);
  assert.deepEqual([high[0].thinking?.type, high[0].thinking?.budget_tokens], ["enabled", 16384], `high: ${JSON.stringify(high[0].thinking)}`);
  const none = await bodiesAt(t, undefined);
  assert.notDeepEqual(none[0].thinking, high[0].thinking, `none leaves pi's default: ${JSON.stringify(none[0].thinking)}`);
});

test("a pi run's spec carries the launch's effort as its session's thinking, and none without one", async (t) => {
  const { spec } = await specFor(t, { body: { instructions: "Do it." }, launch: { effort: "high" } });
  assert.equal(spec.session.thinking, "high");
  const { spec: none } = await specFor(t, { body: { instructions: "Do it." } });
  assert.equal(none.session.thinking, undefined);
});
