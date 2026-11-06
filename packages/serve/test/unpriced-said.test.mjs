// A model serve has no price for is said so everywhere: a gateway id no AGENT_MODEL_PRICE names and pi-ai's catalog does
// not list in any form. A run on it on another harness (codex, opencode: their proxy prices each request) books each
// request at an unknown cost, never a known $0, so its cost reads unknown and /usage counts it as unpriced; capabilities
// say the default model has no price (`models.priced`); and a run with a spend cap on it is refused before it starts,
// in the cap's words. A model the catalog prices keeps a known cost. Every request goes to a loopback gateway on a port
// below the ephemeral range, with dummy keys.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const KEY = "not-a-secret-gateway";
/** An id no catalog lists in any form, and the one the catalog lists flipped (gpt-5.4-mini: $0.75 in, $4.50 out). */
const NO_PRICE = "house-model-x";
const PRICED = "gpt-5-4-mini";
const USAGE = { input: 1000, output: 100 };
const PRICED_EACH = (USAGE.input * 0.75 + USAGE.output * 4.5) / 1e6;
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_CODEX_STANDIN", "AGENTRUN_SERVE_CODEX_STANDIN", "AGENTRUN_OPENCODE_STANDIN", "AGENTRUN_SERVE_OPENCODE_STANDIN"];
const CODEX_STAND_IN_FILE = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));
const CODEX_STAND_IN = { AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [CODEX_STAND_IN_FILE], env: { FAKE_CODEX_MODEL: "remote" } }) };
const OPENCODE_STAND_IN_FILE = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));

/** A port free on 127.0.0.1 now, below the kernel's ephemeral range (no listen(0) or outbound connection is handed it). */
async function freePort() {
  let low = 32768;
  try {
    low = Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 32768;
  } catch {}
  const to = Math.min(low, 32768);
  const from = Math.max(1024, Math.min(20000, to - 1000));
  for (let tries = 0; tries < 200; tries++) {
    const port = from + Math.floor(Math.random() * (to - from));
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port in ${from}-${to - 1}`);
}

async function gateway(t) {
  const gw = await startFauxGateway({ usage: USAGE, port: await freePort() });
  t.after(() => gw.close());
  return gw;
}

/** serve on the gateway with `model` as the host's, and `harness`'s stand-in: an uncapped run of it to its end. */
async function uncapped(t, harness, model) {
  const gw = await gateway(t);
  const standIn = harness === "opencode" ? join(await scratch(t), "opencode-stand-in.mjs") : undefined;
  if (standIn) await copyFile(OPENCODE_STAND_IN_FILE, standIn);
  const stand = harness === "codex" ? CODEX_STAND_IN : { AGENTRUN_OPENCODE_STANDIN: "1", AGENTRUN_SERVE_OPENCODE_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn] }) };
  withEnv(t, { AGENT_MODEL_BASE_URL: harness === "codex" ? `${gw.url}/v1` : gw.url, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: model, ...stand }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent(`${harness}-run`, { harness }))).status, 201);
  const started = await api("POST", `/agents/${harness}-run/runs`, { input: { content: "Say hi." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 80_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const usage = (await api("GET", "/usage")).body;
  return { run, usage, posts: gw.requests.filter((r) => r.method === "POST").length };
}

for (const harness of ["codex", "opencode"]) {
  test(`${harness}: an uncapped run on a gateway model with no price books its requests at an unknown cost, never $0: its cost reads unknown, and /usage counts it as unpriced`, { timeout: 120_000 }, async (t) => {
    const { run, usage, posts } = await uncapped(t, harness, NO_PRICE);
    assert.ok(posts >= 1, "the gateway was asked");
    assert.deepEqual([run.status, run.cost.usd, usage.unpriced_runs], ["completed", null, 1], JSON.stringify({ cost: run.cost, usage }));
  });
}

test("codex: an uncapped run on a gateway model the catalog prices (gpt-5-4-mini) keeps a known cost, at the catalog's price", { timeout: 120_000 }, async (t) => {
  const { run, usage, posts } = await uncapped(t, "codex", PRICED);
  assert.deepEqual([run.status, run.cost.usd, usage.unpriced_runs], ["completed", Math.round(posts * PRICED_EACH * 1e6) / 1e6, 0], JSON.stringify({ cost: run.cost, usage }));
});

test("capabilities say a gateway default with no price has none (models.priced false, ready true), and a capped run on it is refused before it starts, in the cap's words; an uncapped one starts; a priced default reads priced", { timeout: 60_000 }, async (t) => {
  const gw = await gateway(t);
  withEnv(t, { AGENT_MODEL_BASE_URL: `${gw.url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: NO_PRICE }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  const { models } = (await api("GET", "/capabilities")).body;
  assert.deepEqual([models.default, models.ready, models.priced], [`agent-model/${NO_PRICE}`, true, false], JSON.stringify(models));
  assert.equal((await api("POST", "/agents", agent("no-price"))).status, 201);
  const capped = await api("POST", "/agents/no-price/runs", { input: { content: "Say hi." }, max_cost_usd: 0.25 });
  assert.equal(capped.status, 409, JSON.stringify(capped.body));
  assert.match(JSON.stringify(capped.body), new RegExp(`The model ${NO_PRICE} has no price here, so a run's spend cap cannot be kept on it`));
  assert.equal(gw.requests.length, 0, "nothing reached the gateway");
  assert.equal((await api("POST", "/agents/no-price/runs", { input: { content: "Say hi." } })).status, 202, "without a cap it starts");
});

// The 409 says where the refusal is and how to fix it, as the save's warning and a 422 do: its `fields` entry names the
// field (definition.model), the reason, the message and the fix (AGENT_MODEL_PRICE), never the message alone (#1822 review).
test("a capped run refused before it starts on a gateway model with no price names the field and its fix in the 409's fields, as a 422 names each", { timeout: 60_000 }, async (t) => {
  const gw = await gateway(t);
  withEnv(t, { AGENT_MODEL_BASE_URL: `${gw.url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: NO_PRICE }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("no-price-fields"))).status, 201);
  const capped = await api("POST", "/agents/no-price-fields/runs", { input: { content: "Say hi." }, max_cost_usd: 0.25 });
  assert.deepEqual([capped.status, capped.body.error?.code], [409, "agent_not_runnable"], JSON.stringify(capped.body));
  const [issue] = capped.body.error.fields ?? [];
  assert.deepEqual([issue?.field, issue?.reason, issue?.message], ["definition.model", "not_set_up_here", `The model ${NO_PRICE} has no price here, so a run's spend cap cannot be kept on it.`]);
  assert.match(issue.fix, /^Set AGENT_MODEL_PRICE /);
  assert.equal(gw.requests.length, 0, "nothing reached the gateway");
});

test("capabilities read a gateway default the catalog prices (gpt-5-4-mini, flipped) as priced", { timeout: 60_000 }, async (t) => {
  const gw = await gateway(t);
  withEnv(t, { AGENT_MODEL_BASE_URL: `${gw.url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: PRICED }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  const { models } = (await api("GET", "/capabilities")).body;
  assert.deepEqual([models.ready, models.priced], [true, true], JSON.stringify(models));
});

// Saved under a default cap (definition max_cost_usd), a model with no price is a setting this host can fix, not a choice
// the definition got wrong: the save keeps the agent, with a warning that names the fix, and an update saves too; only a
// run under the cap is refused (#1822 review).
test("an agent with a default cap on a gateway model with no price saves with a warning naming AGENT_MODEL_PRICE, and its update saves; its capped run is refused before it starts", { timeout: 60_000 }, async (t) => {
  const gw = await gateway(t);
  withEnv(t, { AGENT_MODEL_BASE_URL: `${gw.url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: NO_PRICE }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  const definition = agent("capped-no-price", { max_cost_usd: 0.5 }).definition;
  const created = await api("POST", "/agents", { definition });
  const warning = created.body?.warnings?.find((w) => w.field === "definition.model");
  assert.deepEqual([created.status, warning?.message, warning?.fix], [201, `The model ${NO_PRICE} has no price here, so a run's spend cap cannot be kept on it.`, "Set AGENT_MODEL_PRICE (USD per million input,output,cacheRead tokens) where AgentRun starts, or run without a spend cap."], JSON.stringify(created.body));
  // As every edit does: the definition as the agent serves it, without the version the server numbers.
  const { version: _, ...current } = (await api("GET", "/agents/capped-no-price")).body.definition;
  const updated = await api("PUT", "/agents/capped-no-price/definition", { definition: { ...current, instructions: "Answer, updated." } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const started = await api("POST", "/agents/capped-no-price/runs", { input: { content: "Say hi." } });
  assert.equal(started.status, 409, JSON.stringify(started.body));
  assert.equal(gw.requests.length, 0, "nothing reached the gateway");
});
