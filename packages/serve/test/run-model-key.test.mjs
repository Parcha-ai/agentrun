// A run's own model key, unit by unit (run-model-key.ts, runner/claim-secrets.ts, store/seal.ts): where it applies, the
// model env that carries it and nothing else, the claim that opens it bound to the gateway's origin, and the words for
// spend it does not pay for. End to end: run-model-key-custody.test.mjs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { gatewayKeyNames, gatewayOnThisMachine, modelKeyMisfit, modelKeyRequired, noServerKeyFor, serverKeyMissing, withRunModelKey } from "../dist/run-model-key.js";
import { claimModelEnv, claimModelKey, claimSpendOff } from "../dist/runner/claim-secrets.js";
import { providerFor } from "../dist/provider.js";
import { openRunLaunch, openRunMcpAuth, sealRunLaunch, sealRunMcpAuth } from "../dist/store/index.js";

const GW = "https://gateway.example";
const RUN_KEY = `not-a-secret-${"run-key"}-1a2b3c`;
const SERVER_KEY = `not-a-secret-${"server-key"}-4d5e6f`;
const gateway = { AGENT_MODEL_BASE_URL: `${GW}/v1` };
const pi = { kind: "agentic", model: { provider: "agent-model", modelId: "claude-sonnet-5-5" } };
const claude = { kind: "agentic", model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } };

test("where a run's key applies: a gateway route (pi, codex, a workflow, Anthropic's wire on the gateway's origin), never a native run or a route elsewhere; a server with no key for that route has none to spend", () => {
  assert.equal(modelKeyMisfit(gateway, pi), undefined);
  assert.equal(modelKeyMisfit(gateway, { kind: "workflow" }), undefined);
  assert.equal(modelKeyMisfit({ ...gateway, ANTHROPIC_BASE_URL: GW }, claude), undefined, "Anthropic's endpoint on the gateway's origin");
  assert.match(modelKeyMisfit({ ...gateway, ANTHROPIC_BASE_URL: "https://elsewhere.example" }, claude), /not sent through the gateway/);
  assert.match(modelKeyMisfit({}, pi), /AGENT_MODEL_BASE_URL is not set/);
  assert.match(modelKeyMisfit(gateway, { ...pi, native: true }), /native run/);
  assert.deepEqual([gatewayKeyNames(gateway, pi), gatewayKeyNames({ ...gateway, ANTHROPIC_BASE_URL: GW }, claude), gatewayKeyNames(gateway, claude)], [["AGENT_MODEL_API_KEY"], ["ANTHROPIC_API_KEY"], undefined]);
  assert.equal(serverKeyMissing(gateway, pi), true, "a gateway with no key of the server's");
  assert.equal(serverKeyMissing({ ...gateway, AGENT_MODEL_API_KEY: SERVER_KEY }, pi), false);
  assert.equal(serverKeyMissing({}, pi), false, "no gateway: the route's own checks decide, as before");
  assert.equal(serverKeyMissing(gateway, { ...pi, native: true }), false);
  assert.match(noServerKeyFor(gateway, "A replay"), /^A replay is skipped: .*AGENT_MODEL_API_KEY/);
  assert.equal(noServerKeyFor({ ...gateway, AGENT_MODEL_API_KEY: SERVER_KEY }, "A replay"), undefined);
});

test("the model env of a run with its own key: that key in the gateway's variable (and Anthropic's on the gateway's origin), read at each request, never enumerable; no key of the server's and no other provider's", () => {
  let now = RUN_KEY;
  const base = { ...gateway, ANTHROPIC_BASE_URL: GW, AGENT_MODEL_API_KEY: SERVER_KEY, OPENAI_API_KEY: SERVER_KEY, PATH: "/bin" };
  const env = withRunModelKey(base, { origin: GW, key: () => now });
  assert.deepEqual([env.AGENT_MODEL_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.PATH], [RUN_KEY, RUN_KEY, undefined, "/bin"]);
  assert.equal(JSON.stringify(env).includes(RUN_KEY), false, "not serialized");
  assert.equal(JSON.stringify({ ...env }).includes(RUN_KEY), false, "not spread");
  assert.equal(Object.keys(env).includes("AGENT_MODEL_API_KEY"), false, "not enumerable");
  assert.equal(JSON.stringify(env).includes(SERVER_KEY), false, "the server's keys are gone");
  now = `${RUN_KEY}-next`;
  assert.equal(env.AGENT_MODEL_API_KEY, now, "a message's new key is read at the next request");
  const offOrigin = withRunModelKey({ ...base, ANTHROPIC_BASE_URL: "https://elsewhere.example" }, { origin: GW, key: () => RUN_KEY });
  assert.equal(offOrigin.ANTHROPIC_API_KEY, undefined, "Anthropic's endpoint off the gateway's origin never gets it");
  assert.equal(claimModelEnv(base, [], undefined).AGENT_MODEL_API_KEY, SERVER_KEY, "a run with no key of its own reads the server's, as before");
});

test("a claim opens the run's key from its sealed launch, bound to the gateway's origin: another origin is refused, a message's key replaces it at fresh(), and a launch that holds none falls back to the server's path", async () => {
  const sealKey = randomBytes(32);
  let sealed = sealRunLaunch(sealKey, "run-1", { mcp: { gw: { headers: { authorization: "Bearer x-mcp-123" }, origin: "https://mcp.example" } }, model: { key: RUN_KEY, origin: GW } });
  const store = { runs: { launch: async () => ({ sealed }) } };
  const held = await claimModelKey({ store, sealKey, env: gateway }, "run-1");
  assert.deepEqual([held.origin, held.key()], [GW, RUN_KEY]);
  const watched = [];
  held.watch((key) => watched.push(key));
  sealed = sealRunLaunch(sealKey, "run-1", { model: { key: `${RUN_KEY}-2`, origin: GW } });
  await held.fresh();
  assert.deepEqual([held.key(), watched], [`${RUN_KEY}-2`, [RUN_KEY, `${RUN_KEY}-2`]], "the new key, and the run's redactors hold both");
  sealed = null;
  await held.fresh();
  assert.equal(held.key(), undefined, "a launch erased at the turn's end: no key, never the server's");
  sealed = sealRunLaunch(sealKey, "run-1", { model: { key: RUN_KEY, origin: GW } });
  await assert.rejects(claimModelKey({ store, sealKey, env: { AGENT_MODEL_BASE_URL: "https://moved.example" } }, "run-1"), /handed for the gateway at https:\/\/gateway\.example.*never sent anywhere else/);
  await assert.rejects(claimModelKey({ store, sealKey: randomBytes(32), env: gateway }, "run-1"), /do not open/);
  // A run that starts with MCP credentials alone, on a gateway server: a holder with no key yet, whose first key a
  // message brings (its routes read the server's until then: withRunModelKeyLater).
  sealed = sealRunMcpAuth(sealKey, "run-1", { gw: { headers: { authorization: "Bearer x-mcp-123" }, origin: "https://mcp.example" } });
  const later = await claimModelKey({ store, sealKey, env: gateway }, "run-1");
  assert.deepEqual([later.key(), later.everHeld()], [undefined, false], "no key yet");
  const env = claimModelEnv(gateway, [{ AGENT_MODEL_API_KEY: SERVER_KEY }], later);
  assert.equal(env.AGENT_MODEL_API_KEY, SERVER_KEY, "the server's key until the run has one");
  sealed = sealRunLaunch(sealKey, "run-1", { model: { key: RUN_KEY, origin: GW } });
  await later.fresh();
  assert.deepEqual([env.AGENT_MODEL_API_KEY, later.everHeld(), JSON.stringify({ ...env }).includes(RUN_KEY)], [RUN_KEY, true, false], "a message's first key, at the next request, never enumerable");
  assert.equal(await claimModelKey({ store, sealKey, env: {} }, "run-1").catch((error) => error.message).then((value) => typeof value === "string" && /never sent anywhere else/.test(value)), true, "no gateway now: the key handed for one is never sent");
  sealed = null;
  assert.equal(await claimModelKey({ store, sealKey, env: {} }, "run-1"), undefined, "no gateway and no key: the server's path alone");
});

test("a run's launch seal holds its MCP credentials and its model key apart: either opens alone, the MCP-only seal a replay copies carries no model key, and a seal of nothing is none", () => {
  const sealKey = randomBytes(32);
  const mcp = { gw: { headers: { authorization: "Bearer x-mcp-123" }, origin: "https://mcp.example" } };
  const both = sealRunLaunch(sealKey, "run-1", { mcp, model: { key: RUN_KEY, origin: GW } });
  assert.deepEqual(openRunLaunch(sealKey, "run-1", both), { mcp, model: { key: RUN_KEY, origin: GW } });
  assert.deepEqual(openRunMcpAuth(sealKey, "run-1", both), mcp, "the MCP reader reads its part");
  assert.equal(openRunLaunch(sealKey, "run-2", both), undefined, "bound to its run");
  const copied = sealRunMcpAuth(sealKey, "replay-1", openRunMcpAuth(sealKey, "run-1", both));
  assert.equal(openRunLaunch(sealKey, "replay-1", copied).model, undefined, "a replay's copy never carries the model key");
  assert.equal(sealRunLaunch(sealKey, "run-1", {}), null);
});

test("claude-agent on Anthropic's wire with ANTHROPIC_BASE_URL on the gateway's origin needs no standing key: its route reads the run's key (red before: HarnessUnavailable 'needs ANTHROPIC_API_KEY')", () => {
  const env = { ...gateway, ANTHROPIC_BASE_URL: GW };
  const route = providerFor("anthropic-messages", env, { provider: "anthropic", modelId: "claude-sonnet-5-5" }, "claude-agent");
  assert.equal(route.origin, GW);
  const keyed = withRunModelKey(env, { origin: GW, key: () => RUN_KEY });
  assert.equal(providerFor("anthropic-messages", keyed, { provider: "anthropic", modelId: "claude-sonnet-5-5" }, "claude-agent").credential(), RUN_KEY);
  assert.throws(() => providerFor("anthropic-messages", { ...gateway, ANTHROPIC_BASE_URL: "https://elsewhere.example" }, { provider: "anthropic", modelId: "claude-sonnet-5-5" }, "claude-agent"), /needs ANTHROPIC_API_KEY/, "an endpoint elsewhere still needs its own key");
});

test("spend beside a claimed run (a shadow audit, a replay check, its learning grade) is skipped for a run that brought its own key, and on a server with no gateway key; it runs on a server's key for a run that brought none", async () => {
  const sealedKeys = { get: async () => undefined, put: async () => {}, replaceIf: async () => true, removeIf: async () => true, clock: async () => Date.now() };
  const deps = (env) => ({ store: { sealedKeys }, sealKey: randomBytes(32), env });
  const keyed = await claimSpendOff(deps({ ...gateway, AGENT_MODEL_API_KEY: SERVER_KEY }), { origin: GW, key: () => RUN_KEY, everHeld: () => true });
  assert.match(keyed("A shadow audit"), /^A shadow audit is skipped: this run spent on its own model key/);
  const keyless = await claimSpendOff(deps(gateway), undefined);
  const later = await claimSpendOff(deps({ ...gateway, AGENT_MODEL_API_KEY: SERVER_KEY }), { origin: GW, key: () => undefined, everHeld: () => true });
  assert.match(later("A shadow audit"), /spent on its own model key/, "a key a message handed mid-run counts: the server's key never pays after it");
  assert.match(keyless("A shadow audit"), /holds none of its own/);
  const served = await claimSpendOff(deps({ ...gateway, AGENT_MODEL_API_KEY: SERVER_KEY }), undefined);
  assert.equal(served("A shadow audit"), undefined);
});

// A service that reached Ollama as a gateway with AGENT_MODEL_API_KEY=none gets model_key_required once that key is gone:
// with the gateway on this machine, the words name the move off it; one elsewhere is told only to bring a key.
test("model_key_required: a gateway on this machine is told to remove AGENT_MODEL_BASE_URL, since AgentRun lists Ollama itself", () => {
  const MOVE = "remove AGENT_MODEL_BASE_URL; AgentRun lists Ollama itself";
  for (const base of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://[::1]:11434/v1"]) {
    assert.equal(gatewayOnThisMachine({ AGENT_MODEL_BASE_URL: base }), true, base);
    for (const message of [false, true]) {
      const refused = modelKeyRequired(message, { AGENT_MODEL_BASE_URL: base });
      assert.equal(refused.code, "model_key_required");
      assert.ok(refused.message.includes(MOVE), refused.message);
      assert.ok(!refused.message.includes(base), "the address is never in the words");
    }
  }
  for (const env of [{ AGENT_MODEL_BASE_URL: "https://gateway.example.com/v1" }, {}]) {
    assert.equal(gatewayOnThisMachine(env), false);
    assert.ok(!modelKeyRequired(false, env).message.includes(MOVE));
  }
  assert.ok(!modelKeyRequired(false).message.includes(MOVE), "no env: the words as before");
});
