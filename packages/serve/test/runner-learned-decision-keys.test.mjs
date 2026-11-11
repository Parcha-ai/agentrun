// A learned workflow may carry decision nodes (judge, pick, sift, ask), so the claim hands an agentic run the decision keys
// of the providers its learned workflows name (claim-secrets.ts learnedDecisionKeys), read once the claim's seed lay chose
// them: needsOf reads a revision's own nodes alone, so an agentic run got none and a learned judge found no provider. The
// keys are scoped as the revision's own: only the named providers', none the run's gate denies, none for a run with no
// learned workflow, and a fresh object per claim, so no run's keys reach another's. On pi's spec and a CLI harness's, the
// keys reach the tools' environment and the run's one redactor, never another provider's.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { specFor } from "./runner-spec-support.mjs";
import { linkHarnesses } from "./support.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { claimSecrets, learnedDecisionKeys } = await import("../dist/runner/claim-secrets.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { putSealedKey } = await import("../dist/server-keys.js");

// Dummy key values, built so the source scan reads no literal credential.
const JEV_DUMMY = `not-a-secret-${"typesafe-key"}`;
const PARALLEL_DUMMY = `not-a-secret-${"parallel-key"}`;
const OPENROUTER_DUMMY = `not-a-secret-${"openrouter-key"}`;
const MONID_DUMMY = `not-a-secret-${"monid-key"}`;
const ALL_KEYS = { TYPESAFE_API_KEY: JEV_DUMMY, PARALLEL_API_KEY: PARALLEL_DUMMY, OPENROUTER_API_KEY: OPENROUTER_DUMMY, MONID_API_KEY: MONID_DUMMY };
const KEY = randomBytes(32);

/** A workflow of one typed question per provider in `providers` (undefined: a node that names none, which Jev answers). */
const judgeFlow = (name, providers) => ({
  v: 2, name,
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Coi", path: `coi_${providers.length - 1}` },
  root: { node: "chain", steps: providers.map((provider, at) => ({ node: "judge", label: `coi ${at}`, state: { doc: "{question}" }, out: "Coi", as: `coi_${at}`, ...(provider ? { provider } : {}) })) },
});
/** The learned workflow as the claim's seed lay hands it on: its document as text. */
const learned = (name, providers) => ({ name, description: `Checks a document (${name})`, workflow: JSON.stringify(judgeFlow(name, providers)) });
const NAMES_JEV = learned("on-jev", [undefined]);
const NAMES_PARALLEL = learned("on-parallel", ["parallel"]);
const NAMES_BOTH = learned("on-both", [undefined, "parallel"]);
const ALLOW_ALL = () => true;

async function storeWith(t, keys) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learned-decision-keys-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  for (const [name, value] of Object.entries(keys)) await putSealedKey(store, KEY, name, value);
  return store;
}

test("a learned workflow naming jev gets Jev's key from the store, and no other provider's or tool's", async (t) => {
  const store = await storeWith(t, ALL_KEYS);
  assert.deepEqual(await learnedDecisionKeys({ store, sealKey: KEY, env: {} }, [NAMES_JEV], ALLOW_ALL), { TYPESAFE_API_KEY: JEV_DUMMY });
});

test("a provider the run's gate denies gets no key; the one it allows still does", async (t) => {
  const store = await storeWith(t, ALL_KEYS);
  const asked = [];
  const deniesJev = (provider) => (asked.push(provider), provider !== "jev");
  assert.deepEqual(await learnedDecisionKeys({ store, sealKey: KEY, env: {} }, [NAMES_BOTH], deniesJev), { PARALLEL_API_KEY: PARALLEL_DUMMY });
  assert.deepEqual(asked.sort(), ["jev", "parallel"], "the gate is asked of each provider the workflow names");
  assert.deepEqual(await learnedDecisionKeys({ store, sealKey: KEY, env: {} }, [NAMES_JEV], () => false), {}, "every provider denied: no key");
});

test("a run with no learned workflow gets no decision key, from neither read", async (t) => {
  const store = await storeWith(t, ALL_KEYS);
  assert.deepEqual(await learnedDecisionKeys({ store, sealKey: KEY, env: {} }, [], ALLOW_ALL), {});
  const env = await claimSecrets({ store, sealKey: KEY, env: {} }, { kind: "agentic", body: { tools: ["read"] } }, {});
  for (const name of ["TYPESAFE_API_KEY", "PARALLEL_API_KEY"]) assert.equal(env[name], undefined, `an agentic run's own claim holds no ${name}`);
});

test("a learned workflow that does not parse or inspect names no provider and opens no key", async (t) => {
  const store = await storeWith(t, ALL_KEYS);
  const broken = [{ name: "torn", description: "Torn", workflow: "{\"v\": 2," }, { name: "shapeless", description: "No shape", workflow: JSON.stringify({ v: 2, root: { node: "judge" } }) }];
  assert.deepEqual(await learnedDecisionKeys({ store, sealKey: KEY, env: {} }, broken, ALLOW_ALL), {});
});

test("two runs on one runner get the keys of their own learned workflows' providers and never each other's", async (t) => {
  const store = await storeWith(t, ALL_KEYS);
  const a = await learnedDecisionKeys({ store, sealKey: KEY, env: {} }, [NAMES_JEV], ALLOW_ALL);
  const b = await learnedDecisionKeys({ store, sealKey: KEY, env: {} }, [NAMES_PARALLEL], ALLOW_ALL);
  assert.deepEqual(a, { TYPESAFE_API_KEY: JEV_DUMMY });
  assert.deepEqual(b, { PARALLEL_API_KEY: PARALLEL_DUMMY });
  assert.notEqual(a, b, "each claim reads into an object of its own");
  a.PARALLEL_API_KEY = `not-a-secret-${"written-by-run-a"}`;
  assert.deepEqual(await learnedDecisionKeys({ store, sealKey: KEY, env: {} }, [NAMES_JEV], ALLOW_ALL), { TYPESAFE_API_KEY: JEV_DUMMY }, "a run's write reaches no later claim");
});

test("the runner's own environment value wins over the store's, as claimSecrets reads it", async (t) => {
  const store = await storeWith(t, ALL_KEYS);
  const own = `not-a-secret-${"typesafe-env"}`;
  assert.deepEqual(await learnedDecisionKeys({ store, sealKey: KEY, env: { TYPESAFE_API_KEY: own } }, [NAMES_JEV], ALLOW_ALL), { TYPESAFE_API_KEY: own });
});

/** A redactor as the runner's loop hands it (run.redact), recording every value the claim holds by it. */
function redactSpy() {
  const held = new Set();
  const cut = Object.assign((text) => text, { hold: (values) => { for (const value of values) held.add(value); } });
  return { cut, held };
}

/** The runner's environment for the spec tests: the decision keys set where the runner starts (never saved in the store,
 *  whose every value the spec holds anyway), so a key held by the run's redactor is one the claim opened for the run. */
const RUNNER_KEYS = { TYPESAFE_API_KEY: JEV_DUMMY, PARALLEL_API_KEY: PARALLEL_DUMMY };
const ledger = { models: async () => ({ getModel: () => undefined, getModels: () => [], completeSimple: async () => ({}), streamSimple: () => ({}) }) };

/** pi's spec for a learning run whose agent learned `flows` (none: no learning start), its redactor `cut`. */
async function piHeld(t, flows) {
  const { cut, held } = redactSpy();
  const launch = {};
  await specFor(t, {
    body: { learning: true, tools: ["read"] },
    env: RUNNER_KEYS,
    launch,
    ledger,
    redact: cut,
    before: async (_server, _key, dir) => {
      if (flows.length) launch.learning = startAt(await landWorkflows(dir, "agent-1", flows));
    },
  });
  return held;
}

test("pi: a run whose learned workflow names jev holds Jev's key and not Parallel's; a run with none holds neither", async (t) => {
  const named = await piHeld(t, [{ name: "on-jev", description: "Checks a document", workflow: judgeFlow("on-jev", [undefined]) }]);
  assert.equal(named.has(JEV_DUMMY), true, "the claim opened Jev's key for the learned workflow");
  assert.equal(named.has(PARALLEL_DUMMY), false, "no provider the workflow does not name");
  const none = await piHeld(t, []);
  assert.equal(none.has(JEV_DUMMY), false, "no learned workflow, no Jev key");
  assert.equal(none.has(PARALLEL_DUMMY), false);
});

/** codex's spec for the same run, built for its claim as the dispatch builds it (no session opened). */
async function codexHeld(t, flows) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learned-decision-keys-cli-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let built;
  let harnessRun;
  t.after(async () => {
    await built?.release?.().catch(() => {});
    await harnessRun?.close(ctx).catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const sha = flows.length ? await landWorkflows(dir, "agent-1", flows) : undefined;
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness: "codex", tools: ["read"], learning: true } });
  const launch = { input: { content: "Check it." }, title: "t", place: { mode: "runner" }, harness: "codex", model: { provider: "openai", modelId: "gpt-5" }, ...(sha !== undefined ? { learning: startAt(sha) } : {}) };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  await linkHarnesses(dir);
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  let models = createModels();
  harnessRun = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const { cut, held } = redactSpy();
  const env = { ...RUNNER_KEYS, AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url).pathname] }) };
  const deps = { env, data: dir, journal: (c) => store.journal(c), store, sealKey: KEY, routeOf: async () => assert.fail("no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  built = await cliRunSpecFromLaunch(launch, { harness: harnessRun, registry, setModels: (given) => (models = given), ledger, redact: cut }, deps, claim);
  return held;
}

test("codex: a run whose learned workflow names parallel holds Parallel's key and not Jev's; a run with none holds neither", async (t) => {
  const named = await codexHeld(t, [{ name: "on-parallel", description: "Checks a document", workflow: judgeFlow("on-parallel", ["parallel"]) }]);
  assert.equal(named.has(PARALLEL_DUMMY), true, "the claim opened Parallel's key for the learned workflow");
  assert.equal(named.has(JEV_DUMMY), false, "no provider the workflow does not name");
  const none = await codexHeld(t, []);
  assert.equal(none.has(PARALLEL_DUMMY), false, "no learned workflow, no Parallel key");
  assert.equal(none.has(JEV_DUMMY), false);
});
