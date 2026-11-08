// pi's gateway base, AGENT_MODEL_BASE_URL, refused by the one base rule (provider.ts gatewayBase) where a key may not go
// to it: capabilities say the model is not ready, a save warns, and a run is refused at once, in gatewayBase's words,
// before any run's process starts, so the gateway key is never handed to one. As codex and opencode already are (their
// table entries' refusal), and as ANTHROPIC_BASE_URL is for an Anthropic model (pi-anthropic-gateway.test.mjs).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agent, serve, withEnv } from "./support.mjs";

/** A dummy key: no real one. */
const KEY = `not-a-secret-${"gateway"}`;
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const REFUSAL = "AGENT_MODEL_BASE_URL must be an https URL of a gateway";

for (const [why, base] of [["plain http to another host", "http://gateway.example/v1"], ["a user in it", "https://user@gateway.example"], ["a dot segment", "https://gateway.example/a/../b"]]) {
  test(`pi on an AGENT_MODEL_BASE_URL with ${why}: capabilities say its model is not ready, a save warns and a run is refused before any process starts, in gatewayBase's words`, { timeout: 60_000 }, async (t) => {
    withEnv(t, { AGENT_MODEL_BASE_URL: base, AGENT_MODEL: "team/model", AGENT_MODEL_API_KEY: KEY, AGENT_MODEL_PRICE: "1,1" }, NAMES);
    const { api, data } = await serve(t, { faux: undefined });
    const { models } = (await api("GET", "/capabilities")).body;
    // As an Anthropic model under a refused ANTHROPIC_BASE_URL reads (pi-anthropic-gateway.test.mjs): not ready, and what
    // would make it so a setting of this host (capabilities carry no words; the save and the run below give them).
    assert.deepEqual([models.ready, models.needs], [false, "key"], `the model is not ready: ${JSON.stringify(models)}`);
    const made = await api("POST", "/agents", agent("pi-gateway-refused"));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.ok(JSON.stringify(made.body.warnings ?? []).includes(REFUSAL), `the save warns, in gatewayBase's words: ${JSON.stringify(made.body)}`);
    const started = await api("POST", "/agents/pi-gateway-refused/runs", { input: { content: "Say hi." } });
    assert.notEqual(started.status, 202, `the run is refused: ${JSON.stringify(started.body)}`);
    assert.ok(JSON.stringify(started.body).includes(REFUSAL), `in gatewayBase's words: ${JSON.stringify(started.body)}`);
    assert.equal(existsSync(join(data, "runs")) && (await import("node:fs")).readdirSync(join(data, "runs")).length > 0, false, "no run's process started: no run directory was made");
  });
}
