// The secrets a claimed run's tools get come from the one store (store.sealedKeys opened with the runner's seal key),
// scoped to the run's revision (the keys its tools unlock), never from this process's environment. Two runs on one runner
// get their own keys and never each other's: a run that names no monid never gets the monid key.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Dummy key values, built so the source scan reads no literal credential.
const MONID_DUMMY = `not-a-secret-${"monid-secret"}`;
const PARALLEL_DUMMY = `not-a-secret-${"parallel-secret"}`;
const STORE_DUMMY = `not-a-secret-${"from-store"}`;
const PARALLEL_STORE_DUMMY = `not-a-secret-${"parallel-store"}`;
const ENV_DUMMY = `not-a-secret-${"from-env"}`;

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { claimSecrets } = await import("../dist/runner/claim-secrets.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { MODEL_KEY_NAMES } = await import("../dist/runner/claim-secrets.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { SECRET_NAMES } = await import("../dist/secrets.js");

const KEY = randomBytes(32);
const rev = (tools) => ({ kind: "agentic", body: { tools } });
// A launch whose plane resolves the web tools to Parallel, so its Parallel key is one the run needs (decisionKeysFor).
const WEB_ON_PARALLEL = { plane: { web_search: "parallel", web_fetch: "parallel" } };

async function storeWith(t, keys) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claim-secrets-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  for (const [name, value] of Object.entries(keys)) await putSealedKey(store, KEY, name, value);
  return store;
}

test("a run gets the keys its tools unlock, read from the store", async (t) => {
  const store = await storeWith(t, { MONID_API_KEY: MONID_DUMMY, PARALLEL_API_KEY: PARALLEL_DUMMY });
  const env = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["monid:faux/person/enrich", "web_search"]), WEB_ON_PARALLEL);
  assert.equal(env.MONID_API_KEY, MONID_DUMMY, "a monid run gets the monid key");
  assert.equal(env.PARALLEL_API_KEY, PARALLEL_DUMMY, "a web run whose plane resolves to Parallel gets the Parallel key");
});

test("two runs on one runner get their own keys and never each other's", async (t) => {
  const store = await storeWith(t, { MONID_API_KEY: MONID_DUMMY, PARALLEL_API_KEY: PARALLEL_DUMMY });
  const a = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["monid:faux/person/enrich"]), {});
  const b = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["web_search"]), WEB_ON_PARALLEL);
  assert.equal(a.MONID_API_KEY, MONID_DUMMY, "run A (monid) has the monid key");
  assert.equal(b.MONID_API_KEY, undefined, "run B (no monid) never sees the monid key");
  assert.equal(b.PARALLEL_API_KEY, PARALLEL_DUMMY, "run B (web) has the Parallel key");
  assert.equal(a.PARALLEL_API_KEY, undefined, "run A (no web) never sees the Parallel key");
});

test("the server process's env value wins over the store's by the same name; a store-only key is used; an unneeded key is in neither (rule 4)", async (t) => {
  const store = await storeWith(t, { MONID_API_KEY: STORE_DUMMY, PARALLEL_API_KEY: PARALLEL_STORE_DUMMY });
  const env = await claimSecrets({ store, sealKey: KEY, env: { MONID_API_KEY: ENV_DUMMY } }, rev(["monid:faux/person/enrich", "web_search"]), WEB_ON_PARALLEL);
  assert.equal(env.MONID_API_KEY, ENV_DUMMY, "a key set in both env and the store is the env's value");
  assert.equal(env.PARALLEL_API_KEY, PARALLEL_STORE_DUMMY, "a key only in the store is the store's value");
  assert.equal(env.TYPESAFE_API_KEY, undefined, "a key the run does not need is in neither");
});

test("a claim gets the server's ChatGPT sign-in only when its run can reach a plan model: its chosen model, a host default on the plan, or a tier it names", async (t) => {
  const { planOf } = await import("../dist/chatgpt-plan.js");
  const KEY_DUMMY = `not-a-secret-${"openai-key"}`;
  const store = await storeWith(t, { OPENAI_API_KEY: KEY_DUMMY });
  const credential = { type: "oauth", access: `fake-access-${"a".repeat(16)}`, refresh: `fake-refresh-${"r".repeat(16)}`, expires: Date.now() + 3_600_000, clientId: "fake-client" };
  await putSealedKey(store, KEY, "chatgpt:plan", JSON.stringify({ v: 1, state: "signed_in", credential, models: ["gpt-6.1-sol"] }));
  const claim = (body, launch = {}) => claimSecrets({ store, sealKey: KEY, env: {} }, { kind: "agentic", body: { tools: [], ...body } }, launch);
  const keyPinned = await claim({ model: "openai/gpt-6.1-sol" }, { model: { provider: "openai", modelId: "gpt-6.1-sol" } });
  assert.equal(planOf(keyPinned), undefined, "a run pinned to a key's model gets no plan reader");
  assert.equal(keyPinned.OPENAI_API_KEY, KEY_DUMMY, "it gets its key");
  const claudePinned = await claim({ harness: "claude-agent", model: "anthropic/claude-sonnet-5-5" }, { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } });
  assert.equal(planOf(claudePinned), undefined, "nor a Claude Agent run on Anthropic");
  const onPlan = await claim({}, { model: { provider: "chatgpt", modelId: "gpt-6.1-sol" } });
  assert.equal(planOf(onPlan)?.state, "signed_in", "a run whose start chose a plan model gets it");
  const unpinned = await claim({});
  assert.equal(planOf(unpinned)?.state, "signed_in", "a run that names no model, where the plan is pi's default, gets it");
  const tierOnPlan = await claim({ model: "openai/gpt-6.1-sol", modelTiers: { fast: "chatgpt/gpt-6.1-sol" } }, { model: { provider: "openai", modelId: "gpt-6.1-sol" } });
  assert.equal(planOf(tierOnPlan)?.state, "signed_in", "a run whose tier names a plan model gets it");
});

// A workflow of one model node on the default tier, then one call of a monid tool (on monid's key).
const MODEL_THEN_MONID = {
  v: 2, name: "checked",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
    Person: { type: "object" },
  },
  input: { schemaId: "In" }, output: { schemaId: "Person", path: "person" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" },
    { node: "call", label: "enrich", via: "tool", tool: "monid:faux/person/enrich", args: { name: "{answer}" }, out: "Person", as: "person", deadline_s: 60 },
  ] },
};
const OPENAI_DUMMY = `not-a-secret-${"openai-saved"}`;
const MONID_SAVED = `not-a-secret-${"monid-saved"}`;
/** The secret names a claim's environment holds, read by name as a route reads them (model keys are never enumerable). */
const heldIn = (env) => SECRET_NAMES.filter((name) => typeof env[name] === "string" && env[name] !== "").sort();

test("a workflow run on a --faux runner is laid no model key, though its host model is a provider's whose key is saved; it is laid its tool's key", async (t) => {
  const store = await storeWith(t, { OPENAI_API_KEY: OPENAI_DUMMY, MONID_API_KEY: MONID_SAVED });
  const workflow = { kind: "workflow", body: { workflow: MODEL_THEN_MONID } };
  // As workflow-spec.ts claims a workflow run: its plane alone, no pinned model. Its host model is AGENT_MODEL's, or else
  // the default the saved OpenAI key gives.
  for (const [how, env] of [["AGENT_MODEL", { AGENT_MODEL: "openai/gpt-6-luna" }], ["a saved key's default", {}]]) {
    assert.deepEqual(heldIn(await claimSecrets({ store, sealKey: KEY, env }, workflow, {})), ["MONID_API_KEY", "OPENAI_API_KEY"], `${how}, not faux: its model's key and its tool's`);
    const faux = heldIn(await claimSecrets({ store, sealKey: KEY, env: { ...env, [FAUX_ENV]: "1" } }, workflow, {}));
    assert.deepEqual(faux.filter((name) => MODEL_KEY_NAMES.includes(name)), [], `${how}: a workflow run on a --faux runner holds a model key, which the faux model never sends`);
    assert.deepEqual(faux, ["MONID_API_KEY"], `${how}: a workflow run on a --faux runner holds its tool's key alone`);
  }
});

// A workflow whose Jev judge answers before its model node runs: the judge's key is a decision key (decisionKeysFor),
// laid apart from any model key, whatever the run's model sends.
const JUDGE_THEN_MODEL = {
  v: 2, name: "coi-then-answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "judge", label: "coi", state: { doc: "{question}" }, out: "Coi", as: "coi" },
    { node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" },
  ] },
};
const TYPESAFE_DUMMY = `not-a-secret-${"typesafe-saved"}`;
const GATEWAY_DUMMY = `not-a-secret-${"gateway-key"}`;
/** Each run that sends no model key (claim-secrets.ts sendsNoModelKey), as the runner's env and the launch's own fields. */
const SENDS_NO_MODEL_KEY = [
  ["held, its model kept from running", {}, { hold: { minutes: 5, refused: { message: "No key here for openai/gpt-6-luna.", fields: [], details: { unbound: [], missing: {} } } } }],
  ["on a --faux runner", { [FAUX_ENV]: "1" }, {}],
  ["faux-pinned on a runner off faux", {}, { model: { provider: "faux", modelId: "faux-1" } }],
];

test("a run that sends no model key (held, on a --faux runner, faux-pinned) is still laid its decision keys: its Jev judge's, on TypeSafe's key or on an OpenRouter gateway's, and Parallel's for a web tool on Parallel; never a model key", async (t) => {
  const workflow = { kind: "workflow", body: { workflow: JUDGE_THEN_MODEL } };
  // Jev on TypeSafe's saved key, the workflow's model node on AGENT_MODEL's OpenAI key.
  const typesafe = { store: await storeWith(t, { TYPESAFE_API_KEY: TYPESAFE_DUMMY, OPENAI_API_KEY: OPENAI_DUMMY }), env: { AGENT_MODEL: "openai/gpt-6-luna" } };
  // Jev on an OpenRouter gateway alone: its key is the gateway's, which the judge is laid as OpenRouter's.
  const gateway = { store: await storeWith(t, {}), env: { AGENT_MODEL_BASE_URL: "https://openrouter.ai/api/v1", AGENT_MODEL_API_KEY: GATEWAY_DUMMY } };
  // An agentic run whose web tools resolve to Parallel.
  const web = { store: await storeWith(t, { PARALLEL_API_KEY: PARALLEL_STORE_DUMMY }), env: {} };
  const laid = async (on, revision, env, own) => {
    const claimed = await claimSecrets({ store: on.store, sealKey: KEY, env: { ...on.env, ...env } }, revision, own);
    return { names: heldIn(claimed), judge: claimed.TYPESAFE_API_KEY ?? claimed.OPENROUTER_API_KEY, decisionLaid: ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY"].filter((name) => Object.getOwnPropertyDescriptor(claimed, name)?.enumerable) };
  };
  // Off faux, unpinned and not held: the judge's key and the model node's.
  assert.deepEqual(await laid(typesafe, workflow, {}, {}), { names: ["OPENAI_API_KEY", "TYPESAFE_API_KEY"], judge: TYPESAFE_DUMMY, decisionLaid: ["TYPESAFE_API_KEY"] }, "off faux: Jev's TypeSafe key as a decision key, and the model node's OpenAI key");
  assert.deepEqual((await laid(gateway, workflow, {}, {})).judge, GATEWAY_DUMMY, "off faux: Jev on the OpenRouter gateway's key");
  const got = {};
  for (const [where, env, own] of SENDS_NO_MODEL_KEY) {
    got[where] = {
      typesafe: await laid(typesafe, workflow, env, own),
      gateway: await laid(gateway, workflow, env, own),
      web: await laid(web, rev(["web_search"]), env, { ...WEB_ON_PARALLEL, ...own }),
    };
  }
  const want = {
    typesafe: { names: ["TYPESAFE_API_KEY"], judge: TYPESAFE_DUMMY, decisionLaid: ["TYPESAFE_API_KEY"] },
    gateway: { names: ["OPENROUTER_API_KEY"], judge: GATEWAY_DUMMY, decisionLaid: ["OPENROUTER_API_KEY"] },
    web: { names: ["PARALLEL_API_KEY"], judge: undefined, decisionLaid: ["PARALLEL_API_KEY"] },
  };
  assert.deepEqual(got, Object.fromEntries(SENDS_NO_MODEL_KEY.map(([where]) => [where, want])), "a run that sends no model key is laid its decision keys alone: its judge's and Parallel's, as plain values, and no model key");
});

const { planeFor } = await import("../dist/tool-plane.js");
const OPENROUTER_DUMMY = `not-a-secret-${"openrouter-saved"}`;

test("a run that sends no model key (held, on a --faux runner, faux-pinned) granted web_search, on a server holding only OpenRouter's key or only an OpenRouter gateway's, resolves it to keyless Firecrawl (auto) or to no native search (native) and is laid neither of those keys nor Parallel's; with Parallel's key added, auto resolves to Parallel and is laid Parallel's alone", async (t) => {
  // The server's keys, as the runner's store and env hold them, and as the plane resolves on them at launch (runs-over-store.ts planeFor, run: true).
  const servers = {
    openrouter: { saved: { OPENROUTER_API_KEY: OPENROUTER_DUMMY }, env: {} },
    gateway: { saved: {}, env: { AGENT_MODEL_BASE_URL: "https://openrouter.ai/api/v1", AGENT_MODEL_API_KEY: GATEWAY_DUMMY } },
  };
  const claim = async (server, parallel, pick, env, own) => {
    const saved = parallel ? { ...server.saved, PARALLEL_API_KEY: PARALLEL_STORE_DUMMY } : server.saved;
    const store = await storeWith(t, saved);
    const tooling = { tools: ["web_search"], ...(own.model ? { model: `${own.model.provider}/${own.model.modelId}` } : {}) };
    const plane = planeFor({ ...server.env, ...saved }, tooling, pick === "auto" ? {} : { web_search: { provider: pick } }, { run: true });
    const claimed = await claimSecrets({ store, sealKey: KEY, env: { ...server.env, ...env } }, rev(["web_search"]), { plane, ...own });
    return { web_search: plane.web_search, laid: heldIn(claimed) };
  };
  // Off faux, unpinned and not held, the same run is laid the server's model key: the laid set sees these keys when a run sends one.
  assert.deepEqual(await claim(servers.openrouter, false, "auto", {}, {}), { web_search: "firecrawl-keyless", laid: ["OPENROUTER_API_KEY"] }, "off faux: OpenRouter's key, its model's");
  assert.deepEqual(await claim(servers.gateway, false, "auto", {}, {}), { web_search: "firecrawl-keyless", laid: ["AGENT_MODEL_API_KEY"] }, "off faux: the gateway's key, its model's");
  const got = {};
  const want = {};
  for (const [where, env, own] of SENDS_NO_MODEL_KEY) {
    for (const [name, server] of Object.entries(servers)) {
      for (const parallel of [false, true]) {
        for (const pick of ["auto", "native"]) {
          const row = `${where}, ${name}${parallel ? " + Parallel" : ""}, ${pick}`;
          got[row] = await claim(server, parallel, pick, env, own);
          // native: pi has no own search; a faux model has no hosted one, nor does a run behind a gateway, nor OpenRouter's default model.
          const noNative = name === "gateway" ? "unavailable: no native search for pi behind a gateway" : own.model ? "unavailable: no native search for faux/faux-1" : "unavailable: no native search for openrouter/openai/gpt-6.1-sol";
          want[row] = pick === "native" ? { web_search: noNative, laid: [] } : parallel ? { web_search: "parallel", laid: ["PARALLEL_API_KEY"] } : { web_search: "firecrawl-keyless", laid: [] };
        }
      }
    }
  }
  assert.deepEqual(got, want, "no web route of a run that sends no model key spends OpenRouter's key or the gateway's: auto is keyless Firecrawl, or Parallel on Parallel's key alone; native is unavailable");
});

const { claimModelKey, serverKeyless } = await import("../dist/runner/claim-secrets.js");

/** `store` as a claim reads it, each saved key's row it asks for (store.sealedKeys.get, the one read a saved key is
 *  opened from) put on `reads` by name. */
function counted(store, reads) {
  const sealedKeys = Object.create(store.sealedKeys);
  sealedKeys.get = (name) => (reads.push(name), store.sealedKeys.get(name));
  return { sealedKeys, runs: store.runs };
}

test("serverKeyless reads the gateway's key alone: a store holding several saved model keys has only AGENT_MODEL_API_KEY's row read, whether it holds that one or not; a gateway key in the runner's environment, or no gateway, reads none", async (t) => {
  const others = { OPENAI_API_KEY: OPENAI_DUMMY, ANTHROPIC_API_KEY: `not-a-secret-${"anthropic-saved"}`, OPENROUTER_API_KEY: OPENROUTER_DUMMY };
  const gateway = { AGENT_MODEL_BASE_URL: "https://gateway.example/v1" };
  const ask = async (saved, env) => {
    const reads = [];
    const keyless = await serverKeyless({ store: counted(await storeWith(t, saved), reads), sealKey: KEY, env });
    return { keyless, reads };
  };
  assert.deepEqual({
    saved: await ask({ ...others, AGENT_MODEL_API_KEY: GATEWAY_DUMMY }, gateway),
    unsaved: await ask(others, gateway),
    "in the runner's environment": await ask({ ...others, AGENT_MODEL_API_KEY: GATEWAY_DUMMY }, { ...gateway, AGENT_MODEL_API_KEY: ENV_DUMMY }),
    "no gateway": await ask({ ...others, AGENT_MODEL_API_KEY: GATEWAY_DUMMY }, {}),
  }, {
    saved: { keyless: false, reads: ["AGENT_MODEL_API_KEY"] },
    unsaved: { keyless: true, reads: ["AGENT_MODEL_API_KEY"] },
    "in the runner's environment": { keyless: false, reads: [] },
    "no gateway": { keyless: false, reads: [] },
  }, "serverKeyless opens the gateway's saved key and no other saved model key");
});

test("a run that sends no model key (held, on a --faux runner, faux-pinned) with a Jev judge reads the saved gateway key only where its decisions run on it: on an OpenRouter gateway alone it is read and laid as the judge's OpenRouter key; a gateway off OpenRouter, or Jev on a saved TypeSafe key, reads none", async (t) => {
  const workflow = { kind: "workflow", body: { workflow: JUDGE_THEN_MODEL } };
  const servers = {
    "a gateway off OpenRouter": { saved: { AGENT_MODEL_API_KEY: GATEWAY_DUMMY }, env: { AGENT_MODEL_BASE_URL: "https://gateway.example/v1" } },
    "an OpenRouter gateway": { saved: { AGENT_MODEL_API_KEY: GATEWAY_DUMMY }, env: { AGENT_MODEL_BASE_URL: "https://openrouter.ai/api/v1" } },
    "an OpenRouter gateway and TypeSafe's key": { saved: { AGENT_MODEL_API_KEY: GATEWAY_DUMMY, TYPESAFE_API_KEY: TYPESAFE_DUMMY }, env: { AGENT_MODEL_BASE_URL: "https://openrouter.ai/api/v1" } },
  };
  const claim = async (server, env, own) => {
    const reads = [];
    const claimed = await claimSecrets({ store: counted(await storeWith(t, server.saved), reads), sealKey: KEY, env: { ...server.env, ...env } }, workflow, own);
    return { read: reads.filter((name) => MODEL_KEY_NAMES.includes(name)).sort(), laid: heldIn(claimed), judge: claimed.TYPESAFE_API_KEY ?? claimed.OPENROUTER_API_KEY };
  };
  // Off faux, unpinned and not held, the same run on a gateway off OpenRouter reads the gateway's saved key and is laid it
  // as its model's: the reads below see that key when a run sends it.
  const off = await claim(servers["a gateway off OpenRouter"], {}, {});
  assert.deepEqual([off.read.includes("AGENT_MODEL_API_KEY"), off.laid], [true, ["AGENT_MODEL_API_KEY"]], `off faux: the gateway's key is read and laid as the model's: ${JSON.stringify(off)}`);
  const got = {};
  const want = {};
  for (const [where, env, own] of SENDS_NO_MODEL_KEY) {
    for (const [name, server] of Object.entries(servers)) {
      got[`${where}, ${name}`] = await claim(server, env, own);
      want[`${where}, ${name}`] = {
        "a gateway off OpenRouter": { read: ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"], laid: [], judge: undefined },
        "an OpenRouter gateway": { read: ["AGENT_MODEL_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY"], laid: ["OPENROUTER_API_KEY"], judge: GATEWAY_DUMMY },
        "an OpenRouter gateway and TypeSafe's key": { read: ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"], laid: ["TYPESAFE_API_KEY"], judge: TYPESAFE_DUMMY },
      }[name];
    }
  }
  assert.deepEqual(got, want, "a run that sends no model key opens the gateway's saved key only where its judge runs on it (decisions.ts openRouterKeyEnv)");
});

const { anthropicPolicy } = await import("@parcha/agentrun-harness-claude");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");
const { launchBody } = await import("../dist/run-launch.js");
const { sealRunLaunch } = await import("../dist/store/index.js");
const { heldRedactor, keepText } = await import("../dist/runner/redact.js");

/** A run's own model key (model_key), a test's: never a real one. */
const RUN_KEY = `not-a-secret-${"run-model-key"}`;
const GATEWAY_BASE = "https://gateway.example/v1";
/** A one-model-node workflow. */
const ANSWER = {
  v: 2, name: "answer",
  schemas: { In: { type: "object", additionalProperties: true }, Out: { type: "object" } },
  input: { schemaId: "In" }, output: { schemaId: "Out", path: "answer" },
  root: { node: "extract", label: "answer", instructions: "Answer the question.", out: "Out", as: "answer" },
};

/** A workflow run of ANSWER whose launch is `own` (launch.ts fields) and holds its own model key for GATEWAY_BASE, on a
 *  store holding the gateway's key and OpenAI's saved, claimed through workflowSpecOf by a runner of `env` on that
 *  gateway. What the claim read: the saved model keys' rows it opened (store.sealedKeys.get), and whether the run's own
 *  key reached the runner's redactor, which holds each key the claim opens (holdRunKey). The server's other sealed
 *  secrets are held apart (holdStored); none is kept here, so the redactor sees only what the claim opened. */
async function workflowClaim(t, own, env) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claim-secrets-wf-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  await putSealedKey(store, KEY, "AGENT_MODEL_API_KEY", GATEWAY_DUMMY);
  await putSealedKey(store, KEY, "OPENAI_API_KEY", OPENAI_DUMMY);
  await store.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: ANSWER } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, {
    body: launchBody({ input: { question: "Six times seven?" }, title: "t", place: { mode: "runner" }, ...own }),
    sealed: sealRunLaunch(KEY, "run-1", { model: { key: RUN_KEY, origin: new URL(GATEWAY_BASE).origin } }),
  });
  const reads = [];
  const held = [];
  const redact = heldRedactor(keepText);
  const hold = redact.hold;
  redact.hold = (values) => { held.push(...values); hold(values); };
  const runner = { ...counted(store, reads), agents: store.agents, settings: store.settings, sealedSecrets: { all: async () => [] }, flush: async () => store.flush?.() };
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"o"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: () => 0, capModel: { id: "faux-priced", api: "anthropic-messages", price: null, outputCeiling: null },
  });
  const spec = await workflowSpecOf({ store: runner, sealKey: KEY, env: { AGENT_MODEL_BASE_URL: GATEWAY_BASE, ...env }, providerOf })({ runId: "run-1" }, { redact });
  await spec.release();
  return { read: reads.filter((name) => MODEL_KEY_NAMES.includes(name)).sort(), runKeyHeld: held.includes(RUN_KEY) };
}

test("a workflow run that sends no model key (held, on a --faux runner, faux-pinned), with saved model keys and its own model_key, opens neither at its claim; the same run off faux, unpinned and not held opens both", async (t) => {
  const off = await workflowClaim(t, {}, {});
  assert.deepEqual([off.read.includes("AGENT_MODEL_API_KEY"), off.runKeyHeld], [true, true], `off faux: the gateway's saved key and the run's own key are opened: ${JSON.stringify(off)}`);
  const got = {};
  for (const [where, env, own] of SENDS_NO_MODEL_KEY) got[where] = await workflowClaim(t, own, env);
  assert.deepEqual(got, Object.fromEntries(SENDS_NO_MODEL_KEY.map(([where]) => [where, { read: [], runKeyHeld: false }])), "a workflow run that sends no model key opens no saved model key and not its own");
});

test("claimModelKey for a run that sends no model key (held, on a --faux runner, faux-pinned) holds no key of its own, even one handed for another gateway; the same run off faux, unpinned and not held holds its key", async (t) => {
  const store = await storeWith(t, {});
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: [] } });
  const runOf = async (id, own, origin) => store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, {
    body: launchBody({ input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, ...own }),
    sealed: sealRunLaunch(KEY, id, { model: { key: RUN_KEY, origin } }),
  });
  const gateway = new URL(GATEWAY_BASE).origin;
  await runOf("run-off", {}, gateway);
  const off = await claimModelKey({ store, sealKey: KEY, env: { AGENT_MODEL_BASE_URL: GATEWAY_BASE } }, "run-off");
  assert.equal(off?.key(), RUN_KEY, "off faux, unpinned and not held: the run's own key is held");
  const got = {};
  for (const [i, [where, env, own]] of SENDS_NO_MODEL_KEY.entries()) {
    await runOf(`run-${i}`, own, gateway);
    await runOf(`run-${i}-moved`, own, "https://moved.example");
    const held = await claimModelKey({ store, sealKey: KEY, env: { AGENT_MODEL_BASE_URL: GATEWAY_BASE, ...env } }, `run-${i}`);
    const moved = await claimModelKey({ store, sealKey: KEY, env: { AGENT_MODEL_BASE_URL: GATEWAY_BASE, ...env } }, `run-${i}-moved`).then((key) => key?.key() ?? "none", (error) => `threw: ${error.message}`);
    got[where] = { key: held?.key() ?? "none", everHeld: held?.everHeld() ?? false, moved };
  }
  assert.deepEqual(got, Object.fromEntries(SENDS_NO_MODEL_KEY.map(([where]) => [where, { key: "none", everHeld: false, moved: "none" }])), "a run that sends no model key never opens its own: none is held, and one handed for another gateway is never read to be refused");
});
