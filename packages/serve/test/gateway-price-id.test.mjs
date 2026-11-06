// A gateway model's price from pi-ai's catalog, by the catalog's real id: a host may name a model with its version's
// separators written the other way (the broker's `gpt-5-4-mini` for the catalog's `gpt-5.4-mini`, `claude-haiku-4.5`
// for `claude-haiku-4-5`). The id sent to the gateway never changes; only the price lookup reads the other form, and
// only when it is unambiguous: flipped forms that list different prices leave the model unpriced (a refusal beats a
// wrong cap). The exact id always wins, and a price the host gives (AGENT_MODEL_PRICE) wins over the catalog.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import * as modelModule from "../dist/model.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const { MODEL_PROVIDER, runModels } = modelModule;
/** pi-ai's catalog price of gpt-5.4-mini, every provider that lists it alike: USD per million tokens. */
const CATALOG_PRICE = { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 };
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
/** Every answer's usage: 1000 tokens in, 100 out, none cached. */
const USAGE = { input: 1000, output: 100 };

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

test("a gateway model named with its version's separators flipped (gpt-5-4-mini) is priced as the catalog's gpt-5.4-mini, and keeps its own id", async () => {
  const { models, unpriced } = await runModels({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL: "gpt-5-4-mini" }, undefined);
  const model = models.getModel(MODEL_PROVIDER, "gpt-5-4-mini");
  assert.deepEqual([unpriced.has("gpt-5-4-mini"), model?.id, model?.cost], [false, "gpt-5-4-mini", CATALOG_PRICE]);
});

test("a price the host gives (AGENT_MODEL_PRICE) wins over the catalog's for a flipped id", async () => {
  const { models, unpriced } = await runModels({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL: "gpt-5-4-mini", AGENT_MODEL_PRICE: "1,2,0.5" }, undefined);
  assert.deepEqual([unpriced.size, models.getModel(MODEL_PROVIDER, "gpt-5-4-mini")?.cost], [0, { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }]);
});

// A stub catalog (catalogPrices' shape: id to every provider's entry), so the rule is pinned whatever pi-ai lists.
const cost = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0 });
const STUB = new Map([
  ["gpt-5.4-mini", [{ provider: "openai", cost: cost(0.75, 4.5) }, { provider: "azure", cost: cost(0.75, 4.5) }]],
  // Two providers list the flipped form at different prices.
  ["mixed-1.5", [{ provider: "one", cost: cost(1, 2) }, { provider: "two", cost: cost(3, 4) }]],
  // Each direction of the flip lists a different price: x-2-5.1 reads x-2.5.1 one way, x-2-5-1 the other.
  ["x-2.5.1", [{ provider: "one", cost: cost(1, 2) }]],
  ["x-2-5-1", [{ provider: "one", cost: cost(5, 6) }]],
  // Multi-digit: the catalog's llama-3.1-8b, which llama-3-1-8b names; never llama-3.1.8b.
  ["llama-3.1-8b", [{ provider: "groq", cost: cost(0.05, 0.08) }]],
  ["llama-3.1.8b", [{ provider: "decoy", cost: cost(9, 9) }]],
  // The exact id wins over its flipped form.
  ["z-1-5", [{ provider: "one", cost: cost(1, 1) }]],
  ["z-1.5", [{ provider: "one", cost: cost(7, 7) }]],
]);
const priced = (id) => modelModule.catalogPrice?.(STUB, id, undefined);

test("a flipped form prices only when it is unambiguous: one price across its providers prices; different prices across providers, or across the two flips, stay unpriced", () => {
  assert.deepEqual([priced("gpt-5-4-mini"), priced("mixed-1-5"), priced("x-2-5.1")], [cost(0.75, 4.5), undefined, undefined]);
});

test("a multi-digit version flips pair by pair as the catalog lists it (llama-3-1-8b is llama-3.1-8b), and the exact id wins over its flipped form", () => {
  assert.deepEqual([priced("llama-3-1-8b"), priced("z-1-5"), priced("vendor/gpt-5-4-mini")], [cost(0.05, 0.08), cost(1, 1), cost(0.75, 4.5)]);
});

test("a capped pi run on the gateway's gpt-5-4-mini completes, priced at the catalog's gpt-5.4-mini, with gpt-5-4-mini on the wire", { timeout: 90_000 }, async (t) => {
  const gw = await startFauxGateway({ usage: USAGE, port: await freePort() });
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: `${gw.url}/v1`, AGENT_MODEL_API_KEY: "not-a-secret-gateway", AGENT_MODEL: "gpt-5-4-mini" }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("priced-flip"))).status, 201);
  const started = await api("POST", "/agents/priced-flip/runs", { input: { content: "Say hi." }, max_cost_usd: 0.25 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run.error ?? run.pending));
  const posts = gw.requests.filter((r) => r.method === "POST");
  assert.deepEqual([...new Set(posts.map((r) => r.body?.model))], ["gpt-5-4-mini"], "the id on the wire is the host's");
  const each = (USAGE.input * CATALOG_PRICE.input + USAGE.output * CATALOG_PRICE.output) / 1e6;
  assert.deepEqual(rows.findLast((r) => r.kind === "usage")?.usage, { usd: Math.round(posts.length * each * 1e6) / 1e6, requests: posts.length });
});

// A date-suffixed id. Flipped pair by pair, its version flips and its date never does: claude-sonnet-4-5-20991231's one
// flipped form is claude-sonnet-4.5-20991231 (the "5" of 4-5 is taken, so 5-2 of the date is not a pair). So a dated id
// is priced as itself, or as that same dated model, or not at all: never as its undated sibling (claude-sonnet-4-5).
test("a date-suffixed id: the exact entry wins when listed; unlisted, it is priced only as its own dated form flipped (claude-sonnet-4.5-20991231), never as the undated sibling, and stays unpriced when that form is not listed", async () => {
  const catalog = await modelModule.catalogPrices();
  const listed = catalog.get("claude-sonnet-4-5-20250929")?.find((entry) => entry.provider === "anthropic")?.cost;
  assert.ok(listed && modelModule.catalogPrice(catalog, "claude-sonnet-4-5", undefined), "the catalog lists the dated model and its undated sibling");
  assert.deepEqual([modelModule.catalogPrice(catalog, "claude-sonnet-4-5-20250929", undefined), modelModule.catalogPrice(catalog, "claude-sonnet-4-5-20991231", undefined)], [listed, undefined]);
  // On a stub: the dated form flipped is the one looked up (never a date flipped too, never the undated sibling).
  const dated = cost(2, 10);
  const stub = new Map([
    ["claude-sonnet-4.5-20991231", [{ provider: "one", cost: dated }]],
    ["claude-sonnet-4.5.20991231", [{ provider: "decoy", cost: cost(9, 9) }]],
    ["claude-sonnet-4.5", [{ provider: "one", cost: cost(3, 15) }]],
    ["claude-sonnet-4-5", [{ provider: "one", cost: cost(3, 15) }]],
  ]);
  const undatedOnly = new Map([...stub].filter(([id]) => !id.includes("2099")));
  assert.deepEqual([modelModule.catalogPrice(stub, "claude-sonnet-4-5-20991231", undefined), modelModule.catalogPrice(undatedOnly, "claude-sonnet-4-5-20991231", undefined)], [dated, undefined]);
});
